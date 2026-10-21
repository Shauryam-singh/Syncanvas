import type { MutableProp, SceneObject, SceneObjectType } from './object.js';

/**
 * Hybrid Logical Clock timestamp.
 *
 * Total order: compare `wall`, then `counter`, then `actorId` (tie-break so
 * every replica orders concurrent events identically without coordination).
 */
export interface HlcTimestamp {
  /** Milliseconds since epoch, bounded by the max-drift window. */
  wall: number;
  /** Logical counter for events within the same millisecond. */
  counter: number;
  /** Identifier of the replica that produced the event. */
  actorId: string;
}

/** Returns true when `a` happened after `b` in the HLC total order. */
export function hlcAfter(a: HlcTimestamp, b: HlcTimestamp): boolean {
  if (a.wall !== b.wall) return a.wall > b.wall;
  if (a.counter !== b.counter) return a.counter > b.counter;
  return a.actorId > b.actorId;
}

/** Total-order comparison (-1, 0, 1) used by every merge path. */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actorId !== b.actorId) return a.actorId < b.actorId ? -1 : 1;
  return 0;
}

/**
 * Mutates a single property of a single object. The LWW register for
 * `(objectId, prop)` keeps the value with the greatest HLC.
 */
export interface SetPropOp {
  kind: 'setProp';
  objectId: string;
  prop: MutableProp;
  value: SceneObject[MutableProp];
}

/** Materialises a new object with its initial property values. */
export interface CreateObjectOp {
  kind: 'createObject';
  object: SceneObject;
}

/**
 * Tombstones the object. Tombstones are retained (until snapshot compaction)
 * so that concurrent `setProp` ops arriving late cannot resurrect it.
 */
export interface DeleteObjectOp {
  kind: 'deleteObject';
  objectId: string;
}

/**
 * Inserts `objectId` into the room's z-order sequence (RGA).
 * Emitted together with `createObject`; removal is implied by `deleteObject`.
 */
export interface InsertZOrderOp {
  kind: 'insertZOrder';
  objectId: string;
  /** RGA origin: insert immediately after this id, or at head when null. */
  afterId: string | null;
}

/**
 * Text edit: splice `insert`/`delete` counts at an RGA cursor position inside
 * a text object. Split out from `setProp` so concurrent typing merges
 * character-by-character instead of clobbering whole strings.
 */
export interface EditTextOp {
  kind: 'editText';
  objectId: string;
  /** Insert immediately after this char key (null = start of text). */
  afterCharId: string | null;
  insert?: string;
  deleteCount?: number;
}

export type Op = SetPropOp | CreateObjectOp | DeleteObjectOp | InsertZOrderOp | EditTextOp;

/**
 * An operation as it travels over the wire and lands in the operation log.
 *
 * `id` is client-generated and idempotent: re-sending an op after reconnect
 * (offline queue replay) must be a no-op on the server.
 */
export interface OpEnvelope {
  id: string;
  actorId: string;
  hlc: HlcTimestamp;
  op: Op;
}

export type SceneObjectTypeWire = SceneObjectType;
