import { describe, expect, it } from 'vitest';
import { mergeOrderEntry, mergeOrderEntries, orderOf, type OrderEntry } from './rga.js';

function top(objectId: string, wall: number, counter = 0, actorId = 'a'): OrderEntry {
  return {
    objectId,
    origin: { kind: 'top' },
    hlc: { wall, counter, actorId },
    opId: `op-${objectId}-${wall}`,
  };
}

function bottom(objectId: string, wall: number, counter = 0, actorId = 'a'): OrderEntry {
  return {
    objectId,
    origin: { kind: 'bottom' },
    hlc: { wall, counter, actorId },
    opId: `op-${objectId}-${wall}`,
  };
}

function after(
  objectId: string,
  parentId: string,
  wall: number,
  counter = 0,
  actorId = 'a',
): OrderEntry {
  return {
    objectId,
    origin: { kind: 'after', objectId: parentId },
    hlc: { wall, counter, actorId },
    opId: `op-${objectId}-${wall}`,
  };
}

function mapOf(...entries: OrderEntry[]): Map<string, OrderEntry> {
  return new Map(entries.map((item) => [item.objectId, item]));
}

const alive = (): boolean => true;

describe('z-order RGA', () => {
  it('keeps creation order with the newest object on top', () => {
    const entries = mapOf(top('a', 1), top('b', 2), top('c', 3));
    expect(orderOf(entries, alive)).toEqual(['a', 'b', 'c']);
  });

  it('places an object immediately after its origin', () => {
    const entries = mapOf(top('a', 1), top('b', 2), after('c', 'a', 4));
    expect(orderOf(entries, alive)).toEqual(['a', 'c', 'b']);
  });

  it('puts the newest placement immediately after its origin', () => {
    const entries = mapOf(top('a', 1), after('b', 'a', 2), after('c', 'a', 3));
    expect(orderOf(entries, alive)).toEqual(['a', 'c', 'b']);
    expect(orderOf(new Map([...entries].reverse()), alive)).toEqual(['a', 'c', 'b']);
  });

  it('moves an object to the bottom of the stack', () => {
    const entries = mapOf(top('a', 1), top('b', 2), top('c', 3), bottom('a', 4));
    expect(orderOf(entries, alive)).toEqual(['a', 'b', 'c']);
  });

  it('makes the most recent send-to-back the bottom-most', () => {
    const entries = mapOf(top('a', 1), top('b', 2), bottom('a', 4), bottom('b', 5));
    expect(orderOf(entries, alive)).toEqual(['b', 'a']);
  });

  it('moves an object to the top of the stack', () => {
    const entries = mapOf(top('a', 1), top('b', 2), top('a', 3));
    expect(orderOf(entries, alive)).toEqual(['b', 'a']);
  });

  it('keeps the children of a deleted object in place', () => {
    const entries = mapOf(top('a', 1), after('b', 'a', 2), after('c', 'b', 3), top('d', 4));
    expect(orderOf(entries, (id) => id !== 'a')).toEqual(['b', 'c', 'd']);
  });

  it('breaks a cycle deterministically and emits every object once', () => {
    const entries = mapOf(after('a', 'b', 2), after('b', 'a', 1), top('c', 3));
    const order = orderOf(entries, alive);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
    expect(orderOf(new Map([...entries].reverse()), alive)).toEqual(order);
  });

  it('attaches an entry with an unknown origin to the top group', () => {
    const entries = mapOf(top('a', 1), after('b', 'missing', 2));
    expect(orderOf(entries, alive)).toEqual(['a', 'b']);
  });

  it('treats a self-origin as the top group', () => {
    const entries = mapOf(after('a', 'a', 1), top('b', 2));
    expect(orderOf(entries, alive)).toEqual(['a', 'b']);
  });

  it('keeps only the latest placement of an object', () => {
    const first = top('a', 1);
    const second = after('a', 'b', 3);
    const merged = mergeOrderEntry(mapOf(first), second);
    expect(merged.get('a')).toBe(second);
    expect(mergeOrderEntry(merged, first).get('a')).toBe(second);
  });

  it('merges whole placement maps without depending on iteration order', () => {
    const left = mapOf(top('a', 1), after('b', 'a', 2));
    const right = mapOf(top('a', 1), after('c', 'a', 3), top('b', 4));
    const forward = mergeOrderEntries(left, right);
    const backward = mergeOrderEntries(right, left);
    expect([...forward.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(forward.get('b')).toEqual(backward.get('b'));
    expect(orderOf(forward, alive)).toEqual(orderOf(backward, alive));
  });
});
