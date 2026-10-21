import type { Op } from './operations.js';
import type { SceneObject } from './object.js';

/**
 * The scene is a set of objects plus an explicit z-order sequence.
 *
 * `order` is authoritative for layering (it is the sequence the RGA will
 * replace in stage 3); `zIndex` on each object is *materialised* from the
 * order so that snapshots and the wire format stay flat.
 *
 * Every mutation goes through `applyOp`. Nothing in the editor mutates an
 * object in place — that invariant is what makes undo, replay, offline
 * merging and (later) CRDT convergence possible.
 */
export interface SceneState {
  readonly objects: ReadonlyMap<string, SceneObject>;
  /** Object ids ordered back-to-front (index 0 is the bottom-most layer). */
  readonly order: readonly string[];
  /** Ids of deleted objects, kept so late ops cannot resurrect them. */
  readonly tombstones: ReadonlySet<string>;
}

/**
 * Builds a scene from an ordered list of objects (index 0 = bottom-most).
 */
export function createSceneState(initial: readonly SceneObject[] = []): SceneState {
  const objects = new Map<string, SceneObject>();
  const order: string[] = [];
  for (const object of initial) {
    if (objects.has(object.id)) continue;
    objects.set(object.id, object);
    order.push(object.id);
  }
  return {
    objects: materializeZIndex(objects, order),
    order,
    tombstones: new Set<string>(),
  };
}

/**
 * Applies a single operation and returns the next state.
 *
 * The function is pure and idempotent: applying the same operation twice
 * yields the same state, and applying operations in any order converges to
 * the same result (see the convergence fuzz tests added in stage 3).
 */
export function applyOp(state: SceneState, op: Op): SceneState {
  switch (op.kind) {
    case 'createObject': {
      const { object } = op;
      // A tombstone wins over a late create: the delete happened later.
      if (state.tombstones.has(object.id) || state.objects.has(object.id)) {
        return state;
      }
      const objects = new Map(state.objects);
      objects.set(object.id, object);
      // New objects land on top of the stack.
      const order = [...state.order, object.id];
      return {
        objects: materializeZIndex(objects, order),
        order,
        tombstones: state.tombstones,
      };
    }

    case 'deleteObject': {
      if (!state.objects.has(op.objectId)) {
        if (state.tombstones.has(op.objectId)) return state;
        const tombstones = new Set(state.tombstones);
        tombstones.add(op.objectId);
        return { ...state, tombstones };
      }
      const objects = new Map(state.objects);
      objects.delete(op.objectId);
      const order = state.order.filter((id) => id !== op.objectId);
      const tombstones = new Set(state.tombstones);
      tombstones.add(op.objectId);
      return {
        objects: materializeZIndex(objects, order),
        order,
        tombstones,
      };
    }

    case 'setProp': {
      const object = state.objects.get(op.objectId);
      if (!object) return state;
      if (object[op.prop] === op.value) return state;
      const objects = new Map(state.objects);
      objects.set(op.objectId, { ...object, [op.prop]: op.value });
      return { ...state, objects };
    }

    case 'insertZOrder': {
      if (!state.objects.has(op.objectId)) return state;
      const without = state.order.filter((id) => id !== op.objectId);
      const afterIndex = op.afterId ? without.indexOf(op.afterId) : -1;
      const insertAt = afterIndex >= 0 ? afterIndex + 1 : 0;
      const order = [...without.slice(0, insertAt), op.objectId, ...without.slice(insertAt)];
      const objects = new Map(state.objects);
      return {
        objects: materializeZIndex(objects, order),
        order,
        tombstones: state.tombstones,
      };
    }

    case 'editText':
      // Stage 3 replaces this with a per-character RGA merge. Until then the
      // editor edits whole strings through `setProp('text', …)`.
      return state;
  }
}

/** Applies a batch of operations in order. */
export function applyOps(state: SceneState, ops: readonly Op[]): SceneState {
  return ops.reduce((acc, op) => applyOp(acc, op), state);
}

/** Returns the object with the given id, if it is alive. */
export function getObject(state: SceneState, id: string): SceneObject | undefined {
  return state.objects.get(id);
}

/** Returns the objects ordered back-to-front. */
export function getObjectsInOrder(state: SceneState): SceneObject[] {
  const result: SceneObject[] = [];
  for (const id of state.order) {
    const object = state.objects.get(id);
    if (object) result.push(object);
  }
  return result;
}

/** The scene as a flat, ordered array — the shape used for snapshots. */
export function serializeScene(state: SceneState): SceneObject[] {
  return getObjectsInOrder(state);
}

/**
 * Computes the operation that undoes `op` given the state it was applied to.
 *
 * Returns `null` when the operation had no effect (nothing to undo).
 */
export function invertOp(state: SceneState, op: Op): Op | null {
  switch (op.kind) {
    case 'createObject': {
      if (state.objects.has(op.object.id)) return null;
      return { kind: 'deleteObject', objectId: op.object.id };
    }
    case 'deleteObject': {
      const object = state.objects.get(op.objectId);
      if (!object) return null;
      return { kind: 'createObject', object };
    }
    case 'setProp': {
      const object = state.objects.get(op.objectId);
      if (!object) return null;
      const previous = object[op.prop];
      if (previous === op.value) return null;
      return { kind: 'setProp', objectId: op.objectId, prop: op.prop, value: previous };
    }
    case 'insertZOrder': {
      const index = state.order.indexOf(op.objectId);
      if (index < 0) return null;
      const previous = index === 0 ? null : (state.order[index - 1] ?? null);
      return { kind: 'insertZOrder', objectId: op.objectId, afterId: previous };
    }
    case 'editText':
      return null;
  }
}

/**
 * Rewrites `zIndex` on every object from the authoritative order.
 * Returns a new map; the input is not mutated.
 */
function materializeZIndex(
  objects: ReadonlyMap<string, SceneObject>,
  order: readonly string[],
): Map<string, SceneObject> {
  const result = new Map<string, SceneObject>();
  for (const [id, object] of objects) {
    result.set(id, object);
  }
  order.forEach((id, index) => {
    const object = result.get(id);
    if (object && object.zIndex !== index) {
      result.set(id, { ...object, zIndex: index });
    }
  });
  return result;
}
