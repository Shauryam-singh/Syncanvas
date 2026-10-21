import { describe, expect, it } from 'vitest';
import { createHlc, receiveHlc, tickHlc } from './hlc.js';
import { compareHlc, hlcAfter } from './operations.js';

describe('hybrid logical clock', () => {
  it('starts at the given wall time', () => {
    const clock = createHlc('a', 1_000);
    expect(clock).toEqual({ wall: 1_000, counter: 0, actorId: 'a' });
  });

  it('advances the counter inside one millisecond', () => {
    const first = tickHlc(createHlc('a', 1_000), 'a', 1_000);
    const second = tickHlc(first, 'a', 1_000);
    expect(first.counter).toBe(1);
    expect(second.counter).toBe(2);
    expect(second.wall).toBe(1_000);
  });

  it('resets the counter when the wall clock moves', () => {
    const first = tickHlc(createHlc('a', 1_000), 'a', 1_000);
    const second = tickHlc(first, 'a', 1_005);
    expect(second.wall).toBe(1_005);
    expect(second.counter).toBe(0);
  });

  it('never moves backwards when the system clock does', () => {
    const clock = tickHlc(createHlc('a', 5_000), 'a', 5_000);
    const later = tickHlc(clock, 'a', 1_000);
    expect(later.wall).toBe(5_000);
    expect(later.counter).toBe(clock.counter + 1);
  });

  it('orders two events of the same replica', () => {
    const first = tickHlc(createHlc('a', 1_000), 'a', 1_000);
    const second = tickHlc(first, 'a', 1_000);
    expect(hlcAfter(second, first)).toBe(true);
    expect(compareHlc(first, second)).toBe(-1);
  });

  it('jumps to the wall time of a remote event', () => {
    const local = createHlc('a', 1_000);
    const remote = { wall: 2_000, counter: 4, actorId: 'b' };
    const merged = receiveHlc(local, remote, 1_000);
    expect(merged.wall).toBe(2_000);
    expect(merged.counter).toBe(5);
    expect(merged.actorId).toBe('a');
  });

  it('is strictly after both the local and the remote clock', () => {
    const local = { wall: 2_000, counter: 7, actorId: 'a' };
    const remote = { wall: 2_000, counter: 3, actorId: 'b' };
    const merged = receiveHlc(local, remote, 2_000);
    expect(hlcAfter(merged, local)).toBe(true);
    expect(hlcAfter(merged, remote)).toBe(true);
  });

  it('keeps the counter of the busiest clock when both are equal', () => {
    const local = { wall: 2_000, counter: 9, actorId: 'a' };
    const remote = { wall: 2_000, counter: 3, actorId: 'b' };
    expect(receiveHlc(local, remote, 2_000).counter).toBe(10);
  });

  it('breaks a tie between replicas deterministically', () => {
    const a = tickHlc(createHlc('a', 1_000), 'a', 1_000);
    const b = tickHlc(createHlc('b', 1_000), 'b', 1_000);
    // Same wall time, same counter: the actor id decides, on every replica.
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
  });
});
