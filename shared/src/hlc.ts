import type { HlcTimestamp } from './operations.js';

/**
 * Hybrid logical clock.
 *
 * A timestamp is `(wall, counter, actorId)`: wall time in milliseconds, a
 * logical counter that breaks ties inside one millisecond, and the replica
 * that produced it. The CRDT orders writes by this clock plus the operation
 * id (see `crdt/register.ts`), so the order is consistent with causality and
 * needs no central clock.
 */

/** Creates the first timestamp of a replica. */
export function createHlc(actorId: string, now: number = Date.now()): HlcTimestamp {
  return { wall: now, counter: 0, actorId };
}

/**
 * Stamps a local event.
 *
 * The clock moves to "now" — or stays put if the last event was already in
 * this millisecond — and the counter breaks the tie.
 */
export function tickHlc(
  previous: HlcTimestamp,
  actorId: string,
  now: number = Date.now(),
): HlcTimestamp {
  const wall = Math.max(previous.wall, now);
  const counter = wall === previous.wall ? previous.counter + 1 : 0;
  return { wall, counter, actorId };
}

/**
 * Merges a timestamp received from another replica into the local clock.
 *
 * The result is strictly after both the local clock and the remote one, so a
 * message that was produced before we received it still sorts before our own
 * next event.
 */
export function receiveHlc(
  local: HlcTimestamp,
  remote: HlcTimestamp,
  now: number = Date.now(),
): HlcTimestamp {
  const wall = Math.max(local.wall, remote.wall, now);
  let counter: number;
  if (wall === local.wall && wall === remote.wall) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wall === local.wall) {
    counter = local.counter + 1;
  } else if (wall === remote.wall) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { wall, counter, actorId: local.actorId };
}
