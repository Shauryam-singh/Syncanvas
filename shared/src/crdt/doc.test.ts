import { describe, expect, it } from 'vitest';
import { createInitialScene } from '../initialScene.js';
import { createSceneObject } from '../object.js';
import type { Op, OpEnvelope } from '../operations.js';
import { createSceneState } from '../scene.js';
import {
  createDoc,
  docFingerprint,
  emptyDoc,
  isAlive,
  mergeEnvelope,
  mergeEnvelopes,
  toSceneState,
  type SceneDoc,
} from './doc.js';

interface EnvOptions {
  id: string;
  wall?: number;
  counter?: number;
  actor?: string;
}

function env(op: Op, options: EnvOptions): OpEnvelope {
  const actor = options.actor ?? 'a';
  return {
    id: options.id,
    actorId: actor,
    hlc: { wall: options.wall ?? 1, counter: options.counter ?? 0, actorId: actor },
    op,
  };
}

const object = createSceneObject({ id: 'o1', type: 'rect', x: 10, y: 20, fill: '#111111' });

function apply(envelopes: OpEnvelope[]): SceneDoc {
  return mergeEnvelopes(emptyDoc(), envelopes);
}

describe('CRDT document', () => {
  it('projects a created object with its z-index and defaults', () => {
    const state = toSceneState(apply([env({ kind: 'createObject', object }, { id: 'create' })]));
    expect(state.order).toEqual(['o1']);
    expect(state.tombstones.size).toBe(0);
    expect(state.objects.get('o1')).toMatchObject({
      id: 'o1',
      type: 'rect',
      x: 10,
      y: 20,
      zIndex: 0,
    });
  });

  it('keeps the later write of a property, whatever the arrival order', () => {
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });
    const older = env(
      { kind: 'setProp', objectId: 'o1', prop: 'x', value: 1 },
      { id: 'x-a', wall: 10, actor: 'a' },
    );
    const newer = env(
      { kind: 'setProp', objectId: 'o1', prop: 'x', value: 2 },
      { id: 'x-b', wall: 20, actor: 'b' },
    );

    const forward = apply([create, older, newer]);
    const backward = apply([create, newer, older]);
    expect(toSceneState(forward).objects.get('o1')?.x).toBe(2);
    expect(docFingerprint(forward)).toBe(docFingerprint(backward));
  });

  it('breaks an exact clock tie with the operation id', () => {
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });
    const first = env(
      { kind: 'setProp', objectId: 'o1', prop: 'fill', value: '#aaaaaa' },
      { id: 'op-a', wall: 5 },
    );
    const second = env(
      { kind: 'setProp', objectId: 'o1', prop: 'fill', value: '#bbbbbb' },
      { id: 'op-b', wall: 5 },
    );

    expect(toSceneState(apply([create, first, second])).objects.get('o1')?.fill).toBe('#bbbbbb');
    expect(toSceneState(apply([create, second, first])).objects.get('o1')?.fill).toBe('#bbbbbb');
  });

  it('lets a delete win an exact logical-time tie', () => {
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 5 });
    const remove = env(
      { kind: 'deleteObject', objectId: 'o1' },
      { id: 'delete', wall: 5, actor: 'b' },
    );
    const state = toSceneState(apply([create, remove]));
    expect(state.objects.has('o1')).toBe(false);
    expect(state.order).toEqual([]);
    expect(state.tombstones.has('o1')).toBe(true);
  });

  it('resurrects a deleted object when a later create arrives (undo)', () => {
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });
    const remove = env({ kind: 'deleteObject', objectId: 'o1' }, { id: 'delete', wall: 2 });
    const undo = env(
      { kind: 'createObject', object: { ...object, x: 99 } },
      { id: 'undo', wall: 3 },
    );
    const state = toSceneState(apply([create, remove, undo]));
    expect(state.objects.get('o1')?.x).toBe(99);
    expect(state.tombstones.size).toBe(0);
  });

  it('does not lose a property written before the create arrives', () => {
    const late = env(
      { kind: 'setProp', objectId: 'o1', prop: 'x', value: 42 },
      { id: 'early-x', wall: 10 },
    );
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });

    const setFirst = apply([late, create]);
    const createFirst = apply([create, late]);
    expect(toSceneState(setFirst).objects.get('o1')?.x).toBe(42);
    expect(docFingerprint(setFirst)).toBe(docFingerprint(createFirst));
  });

  it('does not lose a delete that arrives before the create', () => {
    const remove = env({ kind: 'deleteObject', objectId: 'o1' }, { id: 'delete', wall: 10 });
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });

    const deleteFirst = apply([remove, create]);
    const createFirst = apply([create, remove]);
    expect(toSceneState(deleteFirst).objects.has('o1')).toBe(false);
    expect(docFingerprint(deleteFirst)).toBe(docFingerprint(createFirst));
  });

  it('does not lose a placement that arrives before the create', () => {
    const one = createSceneObject({ id: 'o1', type: 'rect' });
    const two = createSceneObject({ id: 'o2', type: 'rect' });
    const three = createSceneObject({ id: 'o3', type: 'rect' });

    const creates = [
      env({ kind: 'createObject', object: one }, { id: 'c1', wall: 1 }),
      env({ kind: 'createObject', object: two }, { id: 'c2', wall: 2 }),
      env({ kind: 'createObject', object: three }, { id: 'c3', wall: 3 }),
    ];
    const move = env(
      { kind: 'insertZOrder', objectId: 'o3', afterId: 'o1' },
      { id: 'move', wall: 4 },
    );

    expect(toSceneState(apply([...creates, move])).order).toEqual(['o1', 'o3', 'o2']);
    expect(toSceneState(apply([move, ...creates])).order).toEqual(['o1', 'o3', 'o2']);
  });

  it('maps a null afterId to the bottom of the stack', () => {
    const one = createSceneObject({ id: 'o1', type: 'rect' });
    const two = createSceneObject({ id: 'o2', type: 'rect' });
    const three = createSceneObject({ id: 'o3', type: 'rect' });
    const creates = [
      env({ kind: 'createObject', object: one }, { id: 'c1', wall: 1 }),
      env({ kind: 'createObject', object: two }, { id: 'c2', wall: 2 }),
      env({ kind: 'createObject', object: three }, { id: 'c3', wall: 3 }),
    ];
    const toBack = env(
      { kind: 'insertZOrder', objectId: 'o3', afterId: null },
      { id: 'back', wall: 4 },
    );

    expect(toSceneState(apply([...creates, toBack])).order).toEqual(['o3', 'o1', 'o2']);
    expect(toSceneState(apply([toBack, ...creates])).order).toEqual(['o3', 'o1', 'o2']);
  });

  it('is idempotent for a repeated envelope', () => {
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });
    const move = env(
      { kind: 'setProp', objectId: 'o1', prop: 'x', value: 50 },
      { id: 'move', wall: 2 },
    );
    const once = apply([create, move]);
    const twice = apply([create, move, move, create]);
    expect(docFingerprint(twice)).toBe(docFingerprint(once));
    expect(twice.seen.size).toBe(2);
  });

  it('records editText without changing the document yet', () => {
    const create = env({ kind: 'createObject', object }, { id: 'create', wall: 1 });
    const edit = env(
      { kind: 'editText', objectId: 'o1', afterCharId: null, insert: 'hi' },
      { id: 'edit', wall: 2 },
    );
    const before = apply([create]);
    const after = apply([create, edit]);
    expect(docFingerprint(after)).toBe(docFingerprint(before));
    expect(after.seen.has('edit')).toBe(true);
  });

  it('keeps a delete-only record as a tombstone until its create arrives', () => {
    const doc = apply([env({ kind: 'deleteObject', objectId: 'ghost' }, { id: 'delete' })]);
    const state = toSceneState(doc);
    expect(state.order).toEqual([]);
    expect(state.tombstones.has('ghost')).toBe(true);
  });

  it('seeds a document that projects exactly like a plain scene', () => {
    const initial = createInitialScene();
    const seeded = toSceneState(createDoc(initial));
    const plain = createSceneState(initial);
    expect(seeded.order).toEqual(plain.order);
    for (const id of plain.order) {
      expect(seeded.objects.get(id)).toEqual(plain.objects.get(id));
    }
  });

  it('lets a real operation beat the seed stamps', () => {
    const doc = createDoc(createInitialScene());
    const edit = env(
      { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 5 },
      { id: 'edit', wall: 1 },
    );
    expect(toSceneState(mergeEnvelope(doc, edit)).objects.get('demo-rect')?.x).toBe(5);
  });

  it('reports liveness from birth and death alone', () => {
    const created = apply([env({ kind: 'createObject', object }, { id: 'create', wall: 1 })]);
    expect(isAlive(created.objects.get('o1'))).toBe(true);
    const deleted = apply([
      env({ kind: 'createObject', object }, { id: 'create', wall: 1 }),
      env({ kind: 'deleteObject', objectId: 'o1' }, { id: 'delete', wall: 2 }),
    ]);
    expect(isAlive(deleted.objects.get('o1'))).toBe(false);
    expect(isAlive(deleted.objects.get('missing'))).toBe(false);
  });
});
