import { describe, expect, it } from 'vitest';
import { createSceneObject, type SceneObject } from './object.js';
import type { Op } from './operations.js';
import {
  applyOp,
  applyOps,
  createSceneState,
  getObjectsInOrder,
  invertOp,
  serializeScene,
  type SceneState,
} from './scene.js';

const rect = (id: string, overrides: Partial<SceneObject> = {}): SceneObject =>
  createSceneObject({ id, type: 'rect', x: 0, y: 0, w: 100, h: 50, ...overrides });

describe('scene state', () => {
  it('creates objects on top of the existing stack', () => {
    let state = createSceneState([rect('a')]);
    state = applyOp(state, { kind: 'createObject', object: rect('b') });
    expect(state.order).toEqual(['a', 'b']);
    expect(getObjectsInOrder(state).map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('materialises zIndex from the order', () => {
    let state = createSceneState([rect('a'), rect('b')]);
    state = applyOp(state, {
      kind: 'insertZOrder',
      objectId: 'a',
      afterId: 'b',
    });
    expect(state.order).toEqual(['b', 'a']);
    expect(getObjectsInOrder(state).map((o) => o.zIndex)).toEqual([0, 1]);
    expect(state.objects.get('a')?.zIndex).toBe(1);
  });

  it('ignores a create for an object that already exists', () => {
    const state = createSceneState([rect('a')]);
    const next = applyOp(state, { kind: 'createObject', object: rect('a', { w: 999 }) });
    expect(next).toBe(state);
    expect(next.objects.get('a')?.w).toBe(100);
  });

  it('tombstones deleted objects and refuses late writes', () => {
    let state = createSceneState([rect('a')]);
    state = applyOp(state, { kind: 'deleteObject', objectId: 'a' });
    expect(state.objects.has('a')).toBe(false);
    expect(state.tombstones.has('a')).toBe(true);

    // A late setProp must not resurrect the object.
    const after = applyOp(state, { kind: 'setProp', objectId: 'a', prop: 'x', value: 10 });
    expect(after.objects.has('a')).toBe(false);

    // A late create must not resurrect it either.
    const recreated = applyOp(after, { kind: 'createObject', object: rect('a') });
    expect(recreated.objects.has('a')).toBe(false);
  });

  it('applies property changes to the right object only', () => {
    let state = createSceneState([rect('a'), rect('b')]);
    state = applyOp(state, { kind: 'setProp', objectId: 'a', prop: 'fill', value: '#ff0000' });
    expect(state.objects.get('a')?.fill).toBe('#ff0000');
    expect(state.objects.get('b')?.fill).toBe('#6366f1');
  });
});

describe('determinism', () => {
  const ops: Op[] = [
    { kind: 'createObject', object: rect('a') },
    { kind: 'createObject', object: rect('b', { x: 200 }) },
    { kind: 'setProp', objectId: 'a', prop: 'x', value: 42 },
    { kind: 'setProp', objectId: 'b', prop: 'fill', value: '#00ff00' },
    { kind: 'insertZOrder', objectId: 'b', afterId: 'a' },
    { kind: 'deleteObject', objectId: 'a' },
    { kind: 'setProp', objectId: 'b', prop: 'rotation', value: 45 },
  ];

  it('produces identical state when the same sequence is applied twice', () => {
    const first = applyOps(createSceneState(), ops);
    const second = applyOps(createSceneState(), ops);
    expect(serializeScene(first)).toEqual(serializeScene(second));
    expect(first.order).toEqual(second.order);
  });

  it('is idempotent: applying the same op twice changes nothing', () => {
    const once = applyOps(createSceneState(), ops);
    const twice = applyOps(once, ops);
    expect(serializeScene(twice)).toEqual(serializeScene(once));
    expect(twice.order).toEqual(once.order);
    expect(twice.tombstones).toEqual(once.tombstones);
  });

  it('does not mutate the state it was given', () => {
    const initial = createSceneState([rect('a')]);
    const snapshot = serializeScene(initial);
    applyOp(initial, { kind: 'setProp', objectId: 'a', prop: 'x', value: 999 });
    expect(serializeScene(initial)).toEqual(snapshot);
  });

  it('converges for property operations delivered in any order', () => {
    // Property writes are independent of each other, so any delivery order
    // yields the same scene. Structural operations (create/delete/reorder)
    // are deliberately *order sensitive* in stage 1 — that is exactly the
    // gap the RGA z-order sequence closes in stage 3.
    const setup: Op[] = [
      { kind: 'createObject', object: rect('a') },
      { kind: 'createObject', object: rect('b') },
    ];
    const independent: Op[] = [
      { kind: 'setProp', objectId: 'a', prop: 'x', value: 10 },
      { kind: 'setProp', objectId: 'b', prop: 'x', value: 20 },
      { kind: 'setProp', objectId: 'a', prop: 'fill', value: '#ff0000' },
    ];

    const forward = applyOps(createSceneState(), [...setup, ...independent]);
    const shuffled = applyOps(createSceneState(), [
      ...setup,
      independent[2] as Op,
      independent[0] as Op,
      independent[1] as Op,
    ]);
    expect(serializeScene(forward)).toEqual(serializeScene(shuffled));
  });

  it('documents that concurrent creates are order sensitive before the RGA lands', () => {
    const createA: Op = { kind: 'createObject', object: rect('a') };
    const createB: Op = { kind: 'createObject', object: rect('b') };
    const forward = applyOps(createSceneState(), [createA, createB]);
    const backward = applyOps(createSceneState(), [createB, createA]);
    // New objects land on top, so the *stacking* differs — but the set of
    // objects does not, and stage 3 makes even the stacking deterministic.
    expect(new Set(forward.order)).toEqual(new Set(backward.order));
    expect(forward.order).not.toEqual(backward.order);
  });
});

describe('invertOp', () => {
  it('undoes a create with a delete', () => {
    const state = createSceneState();
    const inverse = invertOp(state, { kind: 'createObject', object: rect('a') });
    expect(inverse).toEqual({ kind: 'deleteObject', objectId: 'a' });
  });

  it('undoes a delete with a create carrying the old payload', () => {
    const state = createSceneState([rect('a', { x: 5 })]);
    const inverse = invertOp(state, { kind: 'deleteObject', objectId: 'a' });
    expect(inverse).toEqual({ kind: 'createObject', object: rect('a', { x: 5 }) });
  });

  it('undoes a property change with the previous value', () => {
    const state = createSceneState([rect('a', { x: 5 })]);
    const inverse = invertOp(state, {
      kind: 'setProp',
      objectId: 'a',
      prop: 'x',
      value: 99,
    });
    expect(inverse).toEqual({ kind: 'setProp', objectId: 'a', prop: 'x', value: 5 });
  });

  it('restores the previous z-order neighbour', () => {
    const state = createSceneState([rect('a'), rect('b'), rect('c')]);
    const inverse = invertOp(state, { kind: 'insertZOrder', objectId: 'c', afterId: 'a' });
    expect(inverse).toEqual({ kind: 'insertZOrder', objectId: 'c', afterId: 'b' });
  });

  it('round-trips a state through an operation and its inverse', () => {
    const state = createSceneState([rect('a'), rect('b')]);
    const op: Op = { kind: 'setProp', objectId: 'a', prop: 'fill', value: '#123456' };
    const inverse = invertOp(state, op);
    expect(inverse).not.toBeNull();
    const next = applyOp(state, op);
    const restored = applyOp(next, inverse as Op);
    expect(serializeScene(restored)).toEqual(serializeScene(state));
  });
});

describe('scene helpers', () => {
  it('drops objects from the order when they are deleted', () => {
    let state: SceneState = createSceneState([rect('a'), rect('b')]);
    state = applyOp(state, { kind: 'deleteObject', objectId: 'a' });
    expect(state.order).toEqual(['b']);
    expect(getObjectsInOrder(state).map((o) => o.id)).toEqual(['b']);
  });
});
