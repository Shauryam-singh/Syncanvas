import {
  DEFAULT_SCENE_OBJECT,
  MUTABLE_PROPS,
  type MutableProp,
  type SceneObject,
  type SceneObjectType,
} from '../object.js';
import type { HlcTimestamp, OpEnvelope } from '../operations.js';
import type { SceneState } from '../scene.js';
import { latestStamp, mergeRegisters, type Register, type Stamp } from './register.js';
import { mergeOrderEntry, orderOf, type OrderEntry } from './rga.js';

/**
 * One object in the document.
 *
 * A record is created by *any* operation that mentions the object, not just by
 * its create — that is what makes a `setProp` or a `deleteObject` that arrives
 * before its `createObject` survive the merge instead of being dropped. Until
 * the create arrives the record has no `birth` and is invisible.
 */
export interface ObjectRecord {
  readonly id: string;
  /** The create that introduced the object; its value is the object's type. */
  readonly birth: Register<SceneObjectType> | null;
  /** The most recent delete. */
  readonly death: Stamp | null;
  /** Per-property last-writer-wins registers. */
  readonly props: ReadonlyMap<MutableProp, Register<SceneObject[MutableProp]>>;
}

/**
 * The replicated scene document.
 *
 * It is an ordinary value: every merge returns a new document, nothing is
 * mutated in place, and the result of merging a set of operations depends only
 * on the set — never on the order they arrived in, and never on a server.
 */
export interface SceneDoc {
  readonly objects: ReadonlyMap<string, ObjectRecord>;
  /** Every object's current placement in the z-order RGA. */
  readonly order: ReadonlyMap<string, OrderEntry>;
  /** Ids of every operation merged so far — the idempotence guard. */
  readonly seen: ReadonlySet<string>;
}

const NO_PROPS: ReadonlyMap<MutableProp, Register<SceneObject[MutableProp]>> = new Map();

export function emptyDoc(): SceneDoc {
  return { objects: new Map(), order: new Map(), seen: new Set() };
}

/**
 * Builds a document from a plain scene (the seed scene, or a snapshot).
 *
 * The seed stamps use `wall: 0`, so every real operation wins against them,
 * and the order is fixed by the array position — two replicas that seed from
 * the same array build the same document.
 */
export function createDoc(initial: readonly SceneObject[] = [], actorId = 'seed'): SceneDoc {
  let doc = emptyDoc();
  initial.forEach((object, index) => {
    const stamp: Stamp = {
      hlc: { wall: 0, counter: index, actorId },
      opId: `seed:${object.id}`,
    };
    doc = mergeCreate(doc, object, stamp);
  });
  return doc;
}

/**
 * The existence rule.
 *
 * **Delete-wins.** An object is alive when it has been created and not
 * deleted, or when its create is *strictly* later than its delete. The strict
 * comparison is the whole policy:
 *
 * - a delete that happens after a create wins (the normal case);
 * - a delete and a create with exactly the same logical time tie, and the
 *   tombstone wins;
 * - undoing a delete emits a new create — stamped later, because the undo is
 *   produced after the delete was observed — and that resurrects the object.
 */
export function isAlive(record: ObjectRecord | undefined): boolean {
  if (!record || record.birth === null) return false;
  if (record.death === null) return true;
  return happenedBefore(record.death.hlc, record.birth.hlc);
}

/** True when `a` is strictly before `b` in logical time (actor id ignored). */
function happenedBefore(a: HlcTimestamp, b: HlcTimestamp): boolean {
  if (a.wall !== b.wall) return a.wall < b.wall;
  return a.counter < b.counter;
}

/**
 * Merges one operation into the document.
 *
 * This is the whole CRDT. It is:
 *
 * - **idempotent** — an operation id already in `seen` is a no-op;
 * - **commutative** — every field is an LWW register or a set of RGA nodes, and
 *   both are insensitive to arrival order;
 * - **associative** — merging in batches gives the same document as merging
 *   one at a time.
 */
export function mergeEnvelope(doc: SceneDoc, envelope: OpEnvelope): SceneDoc {
  if (doc.seen.has(envelope.id)) return doc;

  const stamp: Stamp = { hlc: envelope.hlc, opId: envelope.id };
  let next = doc;

  switch (envelope.op.kind) {
    case 'createObject':
      next = mergeCreate(next, envelope.op.object, stamp);
      break;
    case 'deleteObject':
      next = mergeDelete(next, envelope.op.objectId, stamp);
      break;
    case 'setProp':
      next = mergeSetProp(next, envelope.op.objectId, envelope.op.prop, envelope.op.value, stamp);
      break;
    case 'insertZOrder':
      next = {
        ...next,
        order: mergeOrderEntry(next.order, {
          objectId: envelope.op.objectId,
          origin:
            envelope.op.afterId === null
              ? { kind: 'bottom' }
              : { kind: 'after', objectId: envelope.op.afterId },
          ...stamp,
        }),
      };
      break;
    case 'editText':
      // Reserved: text is a per-character RGA in the next iteration. The op is
      // acknowledged and remembered, but it does not change the document yet.
      break;
  }

  const seen = new Set(next.seen);
  seen.add(envelope.id);
  return { ...next, seen };
}

/** Merges a batch. Order within the batch is irrelevant. */
export function mergeEnvelopes(doc: SceneDoc, envelopes: readonly OpEnvelope[]): SceneDoc {
  let result = doc;
  for (const envelope of envelopes) {
    result = mergeEnvelope(result, envelope);
  }
  return result;
}

function mergeCreate(doc: SceneDoc, object: SceneObject, stamp: Stamp): SceneDoc {
  const existing = doc.objects.get(object.id);
  let props = existing?.props ?? NO_PROPS;

  for (const prop of MUTABLE_PROPS) {
    const value = object[prop];
    if (value === undefined) continue;
    const candidate: Register<SceneObject[MutableProp]> = { value, ...stamp };
    const current = props.get(prop);
    const winner = current ? mergeRegisters(current, candidate) : candidate;
    if (winner === current) continue;
    const copy = new Map(props);
    copy.set(prop, winner);
    props = copy;
  }

  const record: ObjectRecord = {
    id: object.id,
    birth: mergeBirth(existing?.birth ?? null, { value: object.type, ...stamp }),
    death: existing?.death ?? null,
    props,
  };

  const objects = new Map(doc.objects);
  objects.set(object.id, record);
  const order = mergeOrderEntry(doc.order, {
    objectId: object.id,
    origin: { kind: 'top' },
    ...stamp,
  });
  return { ...doc, objects, order };
}

function mergeBirth(
  current: Register<SceneObjectType> | null,
  candidate: Register<SceneObjectType>,
): Register<SceneObjectType> {
  return current ? mergeRegisters(current, candidate) : candidate;
}

function mergeDelete(doc: SceneDoc, objectId: string, stamp: Stamp): SceneDoc {
  const existing = doc.objects.get(objectId);
  const death = latestStamp(existing?.death ?? null, stamp);
  if (existing && death === existing.death) return doc;

  const record: ObjectRecord = existing
    ? { ...existing, death }
    : { id: objectId, birth: null, death, props: NO_PROPS };
  const objects = new Map(doc.objects);
  objects.set(objectId, record);
  return { ...doc, objects };
}

function mergeSetProp(
  doc: SceneDoc,
  objectId: string,
  prop: MutableProp,
  value: SceneObject[MutableProp],
  stamp: Stamp,
): SceneDoc {
  const existing = doc.objects.get(objectId);
  const candidate: Register<SceneObject[MutableProp]> = { value, ...stamp };
  const current = existing?.props.get(prop);
  if (current && mergeRegisters(current, candidate) === current) return doc;

  const props = new Map(existing?.props ?? NO_PROPS);
  props.set(prop, candidate);
  const record: ObjectRecord = existing
    ? { ...existing, props }
    : { id: objectId, birth: null, death: null, props };

  const objects = new Map(doc.objects);
  objects.set(objectId, record);
  return { ...doc, objects };
}

/**
 * Projects the document onto the editor's view model.
 *
 * The projection is a pure function of the document, so two replicas that
 * merged the same operations render exactly the same scene — including the
 * z-order (the RGA walk) and the tombstones.
 */
export function toSceneState(doc: SceneDoc): SceneState {
  const alive = (objectId: string): boolean => isAlive(doc.objects.get(objectId));
  const order = orderOf(doc.order, alive);
  const objects = new Map<string, SceneObject>();
  order.forEach((objectId, index) => {
    const record = doc.objects.get(objectId);
    if (record) objects.set(objectId, toSceneObject(record, index));
  });

  const tombstones = new Set<string>();
  for (const [objectId, record] of doc.objects) {
    if (record.death !== null && !isAlive(record)) tombstones.add(objectId);
  }

  return { objects, order, tombstones };
}

function toSceneObject(record: ObjectRecord, zIndex: number): SceneObject {
  const read = <T extends string | number>(prop: MutableProp, fallback: T): T => {
    const register = record.props.get(prop);
    return register && register.value !== undefined ? (register.value as T) : fallback;
  };

  const object: SceneObject = {
    id: record.id,
    type: (record.birth as Register<SceneObjectType>).value,
    x: read('x', DEFAULT_SCENE_OBJECT.x),
    y: read('y', DEFAULT_SCENE_OBJECT.y),
    w: read('w', DEFAULT_SCENE_OBJECT.w),
    h: read('h', DEFAULT_SCENE_OBJECT.h),
    rotation: read('rotation', DEFAULT_SCENE_OBJECT.rotation),
    fill: read('fill', DEFAULT_SCENE_OBJECT.fill),
    zIndex,
  };
  if (object.type === 'text') object.text = read('text', '');
  return object;
}

/**
 * A canonical string for the *whole* document — not just the projected scene.
 *
 * Two replicas have converged when their fingerprints are equal. Tests use it
 * to compare documents, and it is stable across key insertion order.
 */
export function docFingerprint(doc: SceneDoc): string {
  const objects = [...doc.objects.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((record) => ({
      id: record.id,
      birth: stampParts(record.birth),
      death: stampParts(record.death),
      props: [...record.props.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([prop, register]) => [prop, register.value ?? null, stampParts(register)]),
    }));
  const order = [...doc.order.values()]
    .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0))
    .map((entry) => [entry.objectId, entry.origin, stampParts(entry)]);
  return JSON.stringify({ objects, order });
}

function stampParts(stamp: Stamp | null): unknown {
  if (!stamp) return null;
  return [stamp.hlc.wall, stamp.hlc.counter, stamp.hlc.actorId, stamp.opId];
}
