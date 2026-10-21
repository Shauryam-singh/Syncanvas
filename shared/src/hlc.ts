import type { HlcTimestamp } from './operations.js';

/**
 * Hybrid logical clock.
 *
 * A timestamp is `(wall, counter, actorId)`: wall time in milliseconds, a
 * logical counter that breaks ties inside one millisecond, and the replica
 * that produced it. Together they form a total order that is consistent with
 * causality and needs no central clock — the property stage 3 relies on when
 * it replaces the naive merge with an LWW-map.
 *
 * Stage 2 only *stamps* operations with this clock; the merge is still
 * "whatever the gateway received last wins". The clock is here so the wire
 * format is already the one the CRDT will use.
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
