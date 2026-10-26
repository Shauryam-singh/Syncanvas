import {
  isMutableProp,
  type MutableProp,
  type SceneObject,
  type SceneObjectType,
} from '../object.js';
import type { ObjectRecord, SceneDoc } from './doc.js';
import { type OrderEntry, type OrderOrigin } from './rga.js';
import type { Register, Stamp } from './register.js';

/**
 * A durable, JSON-safe representation of the whole CRDT document.
 *
 * Persisting only the projected scene would lose tombstone, register and RGA
 * metadata. A stale operation replayed after a restart could then overwrite a
 * newer value or resurrect a deleted object. This snapshot keeps every part of
 * the merge state (including the seen set) so a reload is indistinguishable
 * from a replica that never stopped.
 */
export const SERIALIZED_DOC_VERSION = 1;

export interface SerializedStamp {
  wall: number;
  counter: number;
  actorId: string;
  opId: string;
}

export interface SerializedRegister<T = unknown> extends SerializedStamp {
  value: T;
}

export interface SerializedObjectRecord {
  id: string;
  birth: SerializedRegister<SceneObjectType> | null;
  death: SerializedStamp | null;
  props: Array<[MutableProp, SerializedRegister]>;
}

export interface SerializedOrderEntry extends SerializedStamp {
  objectId: string;
  origin: OrderOrigin;
}

export interface SerializedDoc {
  version: typeof SERIALIZED_DOC_VERSION;
  objects: SerializedObjectRecord[];
  order: SerializedOrderEntry[];
  /** Every accepted operation id, so a reloaded replica can still ack resends. */
  seen: string[];
}

function toStamp(stamp: Stamp): SerializedStamp {
  return {
    wall: stamp.hlc.wall,
    counter: stamp.hlc.counter,
    actorId: stamp.hlc.actorId,
    opId: stamp.opId,
  };
}

function fromStamp(stamp: SerializedStamp): Stamp {
  return {
    hlc: { wall: stamp.wall, counter: stamp.counter, actorId: stamp.actorId },
    opId: stamp.opId,
  };
}

function toRegister<T>(register: Register<T>): SerializedRegister<T> {
  return { ...toStamp(register), value: register.value };
}

function cloneOrigin(origin: OrderOrigin): OrderOrigin {
  return origin.kind === 'after'
    ? { kind: 'after', objectId: origin.objectId }
    : { kind: origin.kind };
}

/** Converts a document into a deterministic, JSON-safe value. */
export function serializeDoc(doc: SceneDoc): SerializedDoc {
  const objects = [...doc.objects.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map<SerializedObjectRecord>((record) => ({
      id: record.id,
      birth: record.birth ? toRegister(record.birth) : null,
      death: record.death ? toStamp(record.death) : null,
      props: [...record.props.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([prop, register]): [MutableProp, SerializedRegister] => [prop, toRegister(register)]),
    }));

  const order = [...doc.order.values()]
    .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0))
    .map<SerializedOrderEntry>((entry) => ({
      ...toStamp(entry),
      objectId: entry.objectId,
      origin: cloneOrigin(entry.origin),
    }));

  return {
    version: SERIALIZED_DOC_VERSION,
    objects,
    order,
    seen: [...doc.seen].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStamp(value: unknown): SerializedStamp | null {
  if (!isRecord(value)) return null;
  const { wall, counter, actorId, opId } = value;
  if (typeof wall !== 'number' || !Number.isFinite(wall)) return null;
  if (typeof counter !== 'number' || !Number.isFinite(counter)) return null;
  if (typeof actorId !== 'string' || typeof opId !== 'string') return null;
  return { wall, counter, actorId, opId };
}

function readRegister<T>(
  value: unknown,
  validValue: (candidate: unknown) => boolean,
): Register<T> | null {
  const stamp = readStamp(value);
  if (!stamp || !isRecord(value) || !validValue(value.value)) return null;
  return { ...fromStamp(stamp), value: value.value as T };
}

function isObjectType(value: unknown): value is SceneObjectType {
  return value === 'rect' || value === 'ellipse' || value === 'line' || value === 'text';
}

function isPropValue(prop: MutableProp, value: unknown): boolean {
  return prop === 'fill' || prop === 'text'
    ? typeof value === 'string'
    : typeof value === 'number' && Number.isFinite(value);
}

function readOrigin(value: unknown): OrderOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'top' || value.kind === 'bottom') return { kind: value.kind };
  if (value.kind === 'after' && typeof value.objectId === 'string') {
    return { kind: 'after', objectId: value.objectId };
  }
  return null;
}

/**
 * Rebuilds a document from a persisted snapshot.
 *
 * Throws on malformed input instead of silently dropping CRDT metadata; a
 * gateway that cannot read its own snapshot should fall back to the operation
 * log (the caller catches this at the room level).
 */
export function deserializeDoc(value: unknown): SceneDoc {
  if (!isRecord(value) || value.version !== SERIALIZED_DOC_VERSION) {
    throw new Error('Unsupported snapshot document version');
  }
  if (!Array.isArray(value.objects) || !Array.isArray(value.order) || !Array.isArray(value.seen)) {
    throw new Error('Malformed snapshot document');
  }

  const objects = new Map<string, ObjectRecord>();
  for (const raw of value.objects) {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      throw new Error('Malformed object record in snapshot');
    }
    const birth =
      raw.birth === null ? null : readRegister<SceneObjectType>(raw.birth, isObjectType);
    if (raw.birth !== null && !birth) {
      throw new Error('Malformed object birth in snapshot');
    }
    if (!Array.isArray(raw.props)) throw new Error('Malformed object properties in snapshot');
    const props = new Map<MutableProp, Register<SceneObject[MutableProp]>>();
    for (const entry of raw.props) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error('Malformed property entry in snapshot');
      }
      const [prop, registerValue] = entry;
      if (typeof prop !== 'string' || !isMutableProp(prop)) {
        throw new Error('Malformed property name in snapshot');
      }
      const register = readRegister<SceneObject[MutableProp]>(registerValue, (candidate) =>
        isPropValue(prop, candidate),
      );
      if (!register) throw new Error('Malformed property register in snapshot');
      props.set(prop, register);
    }
    const deathStamp = raw.death === null ? null : readStamp(raw.death);
    if (raw.death !== null && !deathStamp) {
      throw new Error('Malformed object death in snapshot');
    }
    const death = deathStamp ? fromStamp(deathStamp) : null;
    objects.set(raw.id, { id: raw.id, birth, death, props });
  }

  const order = new Map<string, OrderEntry>();
  for (const raw of value.order) {
    if (!isRecord(raw) || typeof raw.objectId !== 'string') {
      throw new Error('Malformed order entry in snapshot');
    }
    const stamp = readStamp(raw);
    const origin = readOrigin(raw.origin);
    if (!stamp || !origin) throw new Error('Malformed order entry in snapshot');
    order.set(raw.objectId, { ...fromStamp(stamp), objectId: raw.objectId, origin });
  }

  if (!value.seen.every((id): id is string => typeof id === 'string')) {
    throw new Error('Malformed seen set in snapshot');
  }

  return { objects, order, seen: new Set(value.seen) };
}

/** True when a value looks like a snapshot this version can load. */
export function isSerializedDoc(value: unknown): value is SerializedDoc {
  if (!isRecord(value) || value.version !== SERIALIZED_DOC_VERSION) return false;
  return Array.isArray(value.objects) && Array.isArray(value.order) && Array.isArray(value.seen);
}
