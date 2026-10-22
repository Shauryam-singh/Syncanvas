import { describe, expect, it } from 'vitest';
import {
  compareStamps,
  latestStamp,
  mergeRegisters,
  type Register,
  type Stamp,
} from './register.js';

function stamp(
  wall: number,
  counter = 0,
  actorId = 'a',
  opId = `op-${wall}-${counter}-${actorId}`,
): Stamp {
  return { hlc: { wall, counter, actorId }, opId };
}

function register<T>(value: T, version: Stamp): Register<T> {
  return { value, ...version };
}

describe('LWW register', () => {
  it('orders by wall, then counter, then actor id', () => {
    expect(compareStamps(stamp(1), stamp(2))).toBe(-1);
    expect(compareStamps(stamp(2, 1), stamp(2, 2))).toBe(-1);
    expect(compareStamps(stamp(2, 0, 'a'), stamp(2, 0, 'b'))).toBe(-1);
    expect(compareStamps(stamp(2), stamp(2))).toBe(0);
  });

  it('uses the operation id as a final tie-break', () => {
    const a = stamp(5, 0, 'a', 'op-a');
    const b = stamp(5, 0, 'a', 'op-b');
    expect(compareStamps(a, b)).toBe(-1);
    expect(compareStamps(b, a)).toBe(1);
  });

  it('keeps the later write regardless of argument order', () => {
    const old = register('old', stamp(1));
    const recent = register('new', stamp(2));
    expect(mergeRegisters(old, recent).value).toBe('new');
    expect(mergeRegisters(recent, old).value).toBe('new');
  });

  it('breaks an exact clock tie with the operation id', () => {
    const a = register('a', stamp(5, 0, 'a', 'op-a'));
    const b = register('b', stamp(5, 0, 'a', 'op-b'));
    expect(mergeRegisters(a, b).value).toBe('b');
    expect(mergeRegisters(b, a).value).toBe('b');
  });

  it('is idempotent', () => {
    const a = register(1, stamp(3));
    expect(mergeRegisters(a, a)).toBe(a);
  });

  it('returns the only stamp when the other side is null', () => {
    const a = stamp(3);
    expect(latestStamp(null, a)).toBe(a);
    expect(latestStamp(a, stamp(2))).toBe(a);
    expect(latestStamp(a, stamp(4))).toEqual(stamp(4));
  });
});
