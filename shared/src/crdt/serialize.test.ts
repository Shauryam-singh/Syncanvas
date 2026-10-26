import { describe, expect, it } from 'vitest';
import { createSceneObject } from '../object.js';
import type { Op, OpEnvelope } from '../operations.js';
import {
  createDoc,
  docFingerprint,
  isAlive,
  mergeEnvelope,
  mergeEnvelopes,
  toSceneState,
  type SceneDoc,
} from './doc.js';
import { deserializeDoc, isSerializedDoc, serializeDoc } from './serialize.js';

function env(op: Op, id: string, wall: number, actor = 'a'): OpEnvelope {
  return { id, actorId: actor, hlc: { wall, counter: 0, actorId: actor }, op };
}

function sampleDoc(): SceneDoc {
  const first = createSceneObject({ id: 'o1', type: 'rect', x: 10, y: 20, fill: '#111111' });
  const second = createSceneObject({ id: 'o2', type: 'ellipse', x: 50, y: 60 });
  return mergeEnvelopes(createDoc([]), [
    env({ kind: 'createObject', object: first }, 'create-o1', 10),
    env({ kind: 'createObject', object: second }, 'create-o2', 11),
    env({ kind: 'setProp', objectId: 'o1', prop: 'x', value: 42 }, 'set-x', 20),
    env({ kind: 'setProp', objectId: 'o1', prop: 'text', value: 'hello' }, 'set-text', 21),
    env({ kind: 'insertZOrder', objectId: 'o2', afterId: 'o1' }, 'z-order', 22),
    env({ kind: 'deleteObject', objectId: 'o2' }, 'delete-o2', 30),
    env({ kind: 'editText', objectId: 'o1', afterCharId: null, insert: 'x' }, 'text-op', 31),
  ]);
}

describe('CRDT document snapshots', () => {
  it('round-trips the complete merge state through JSON', () => {
    const doc = sampleDoc();
    const json = JSON.stringify(serializeDoc(doc));
    const restored = deserializeDoc(JSON.parse(json));

    expect(docFingerprint(restored)).toBe(docFingerprint(doc));
    expect([...restored.seen].sort()).toEqual([...doc.seen].sort());
    expect(toSceneState(restored)).toEqual(toSceneState(doc));
    expect(isSerializedDoc(JSON.parse(json))).toBe(true);
  });

  it('keeps tombstones so a stale create cannot resurrect an object', () => {
    const restored = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(sampleDoc()))));
    const stale = env(
      {
        kind: 'createObject',
        object: createSceneObject({ id: 'o2', type: 'ellipse', x: 1, y: 2 }),
      },
      'stale-create',
      15,
    );
    const after = mergeEnvelope(restored, stale);

    expect(isAlive(after.objects.get('o2'))).toBe(false);
    expect(toSceneState(after).order).not.toContain('o2');
  });

  it('keeps register versions so an older replay cannot overwrite a newer value', () => {
    const restored = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(sampleDoc()))));
    const oldWrite = env({ kind: 'setProp', objectId: 'o1', prop: 'x', value: 1 }, 'old-x', 15);
    const after = mergeEnvelope(restored, oldWrite);
    expect(toSceneState(after).objects.get('o1')?.x).toBe(42);
  });

  it('keeps seen ids so a resend after a restart is a no-op', () => {
    const doc = sampleDoc();
    const restored = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))));
    expect(restored.seen.has('set-x')).toBe(true);
    const replay = mergeEnvelope(
      restored,
      env({ kind: 'setProp', objectId: 'o1', prop: 'x', value: 1 }, 'set-x', 20),
    );
    expect(toSceneState(replay).objects.get('o1')?.x).toBe(42);
    expect(docFingerprint(replay)).toBe(docFingerprint(restored));
  });

  it('rejects unknown or malformed snapshots', () => {
    expect(() => deserializeDoc({ version: 99, objects: [], order: [], seen: [] })).toThrow(
      /version/i,
    );
    expect(() => deserializeDoc(null)).toThrow(/version/i);
    expect(() =>
      deserializeDoc({
        version: 1,
        objects: [{ id: 'o1', birth: null, death: null, props: [['nope', { wall: 1 }]] }],
        order: [],
        seen: [],
      }),
    ).toThrow(/property/i);
    expect(isSerializedDoc({ version: 1, objects: [], order: [] })).toBe(false);
  });
});
