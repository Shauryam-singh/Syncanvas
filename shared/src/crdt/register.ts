import { compareHlc, type HlcTimestamp } from '../operations.js';

/**
 * The version of a single write: the hybrid logical clock that stamped it and
 * the operation id.
 *
 * The HLC alone is *almost* a total order — it only ties when two replicas
 * produce the same `(wall, counter)` and the actor ids are equal, which cannot
 * happen for two distinct writes. The operation id is kept anyway so that the
 * order is total even for a malformed or duplicated clock, and so two replicas
 * never disagree about the winner.
 */
export interface Stamp {
  readonly hlc: HlcTimestamp;
  readonly opId: string;
}

/** A value together with the version that wrote it — one LWW register. */
export interface Register<T> extends Stamp {
  readonly value: T;
}

/** Orders two writes. Total: `compareStamps(a, b) === 0` iff they are the same write. */
export function compareStamps(a: Stamp, b: Stamp): -1 | 0 | 1 {
  const byClock = compareHlc(a.hlc, b.hlc);
  if (byClock !== 0) return byClock;
  if (a.opId === b.opId) return 0;
  return a.opId < b.opId ? -1 : 1;
}

/** Returns the later of two writes (the LWW rule). */
export function latestStamp<T extends Stamp>(a: T | null, b: T): T {
  if (a === null) return b;
  return compareStamps(a, b) >= 0 ? a : b;
}

/** Merges two registers: the one with the later version wins, the value follows. */
export function mergeRegisters<T>(a: Register<T>, b: Register<T>): Register<T> {
  return compareStamps(a, b) >= 0 ? a : b;
}
