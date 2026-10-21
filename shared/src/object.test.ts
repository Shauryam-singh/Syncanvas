import { describe, expect, it } from 'vitest';
import { compareHlc, hlcAfter, type HlcTimestamp } from './operations.js';
import { createSceneObject, isMutableProp, MUTABLE_PROPS } from './object.js';

describe('createSceneObject', () => {
  it('applies defaults for omitted properties', () => {
    const obj = createSceneObject({ id: 'a1', type: 'rect' });
    expect(obj).toEqual({
      id: 'a1',
      type: 'rect',
      x: 0,
      y: 0,
      w: 120,
      h: 80,
      rotation: 0,
      fill: '#6366f1',
      zIndex: 0,
      text: undefined,
    });
  });

  it('forces an empty string for text objects without explicit text', () => {
    expect(createSceneObject({ id: 't1', type: 'text' }).text).toBe('');
    expect(createSceneObject({ id: 't1', type: 'rect' }).text).toBeUndefined();
  });
});

describe('isMutableProp', () => {
  it('accepts mutatable props and rejects identity fields', () => {
    for (const prop of MUTABLE_PROPS) {
      expect(isMutableProp(prop)).toBe(true);
    }
    expect(isMutableProp('id')).toBe(false);
    expect(isMutableProp('type')).toBe(false);
    expect(isMutableProp('nope')).toBe(false);
  });
});

describe('HLC ordering', () => {
  const ts = (wall: number, counter: number, actorId: string): HlcTimestamp => ({
    wall,
    counter,
    actorId,
  });

  it('orders by wall, then counter, then actorId', () => {
    expect(compareHlc(ts(1, 0, 'a'), ts(2, 0, 'a'))).toBe(-1);
    expect(compareHlc(ts(2, 1, 'a'), ts(2, 0, 'a'))).toBe(1);
    expect(compareHlc(ts(2, 0, 'a'), ts(2, 0, 'b'))).toBe(-1);
    expect(compareHlc(ts(2, 0, 'a'), ts(2, 0, 'a'))).toBe(0);
  });

  it('is a total order (antisymmetry + reflexivity)', () => {
    const samples = [ts(10, 0, 'a'), ts(10, 1, 'a'), ts(10, 1, 'b'), ts(11, 0, 'a'), ts(9, 9, 'z')];
    for (const a of samples) {
      for (const b of samples) {
        const cmp = compareHlc(a, b);
        expect(cmp + compareHlc(b, a)).toBe(0);
        if (cmp === 0) expect(a).toEqual(b);
      }
    }
  });

  it('hlcAfter is consistent with compareHlc', () => {
    expect(hlcAfter(ts(2, 0, 'a'), ts(1, 5, 'z'))).toBe(true);
    expect(hlcAfter(ts(1, 1, 'a'), ts(1, 1, 'a'))).toBe(false);
    expect(hlcAfter(ts(1, 1, 'b'), ts(1, 1, 'a'))).toBe(true);
  });
});
