import { describe, expect, it } from 'vitest';
import { createInitialScene } from '../initialScene.js';
import { createSceneObject, type SceneObject } from '../object.js';
import type { OpEnvelope } from '../operations.js';
import { createDoc, docFingerprint, mergeEnvelope } from './doc.js';
import { pruneRetiredSeeds } from './legacy.js';

const legacyText: SceneObject = createSceneObject({
  id: 'demo-text',
  type: 'text',
  x: 100,
  y: 260,
  w: 320,
  h: 44,
  fill: '#0f172a',
  text: 'Drag, resize, rotate — every edit is an operation',
});

function seededLegacyDoc() {
  return createDoc([...createInitialScene(), legacyText]);
}

function edit(objectId: string, prop: 'text' | 'x', value: string | number): OpEnvelope {
  return {
    id: `edit-${prop}`,
    actorId: 'user_1',
    hlc: { wall: 1, counter: 0, actorId: 'user_1' },
    op: { kind: 'setProp', objectId, prop, value },
  };
}

describe('retired seed objects', () => {
  it('drops the untouched legacy text object from an existing room', () => {
    const doc = pruneRetiredSeeds(seededLegacyDoc());
    expect(doc.objects.has('demo-text')).toBe(false);
    expect(doc.order.has('demo-text')).toBe(false);
    expect(doc.objects.has('demo-rect')).toBe(true);
  });

  it('leaves the original document untouched when there is nothing to retire', () => {
    const doc = createDoc(createInitialScene());
    expect(pruneRetiredSeeds(doc)).toBe(doc);
  });

  it('keeps the text object when a user edited it', () => {
    const edited = mergeEnvelope(seededLegacyDoc(), edit('demo-text', 'text', 'Our title'));
    const doc = pruneRetiredSeeds(edited);
    expect(doc.objects.get('demo-text')?.props.get('text')?.value).toBe('Our title');
    expect(doc.order.has('demo-text')).toBe(true);
  });

  it('keeps the text object when a user moved it', () => {
    const moved = mergeEnvelope(seededLegacyDoc(), edit('demo-text', 'x', 900));
    const doc = pruneRetiredSeeds(moved);
    expect(doc.objects.has('demo-text')).toBe(true);
    expect(doc.order.has('demo-text')).toBe(true);
    expect(docFingerprint(doc)).toBe(docFingerprint(moved));
  });

  it('does not confuse a real object with the same id for the seed', () => {
    const real = mergeEnvelope(createDoc([]), {
      id: 'create-real',
      actorId: 'user_1',
      hlc: { wall: 5, counter: 0, actorId: 'user_1' },
      op: { kind: 'createObject', object: { ...legacyText, text: 'Real text' } },
    });
    const doc = pruneRetiredSeeds(real);
    expect(doc.objects.has('demo-text')).toBe(true);
  });
});
