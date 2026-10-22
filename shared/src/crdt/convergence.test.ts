import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createHlc, receiveHlc, tickHlc } from '../hlc.js';
import { createInitialScene } from '../initialScene.js';
import {
  createSceneObject,
  MUTABLE_PROPS,
  type MutableProp,
  type SceneObjectType,
} from '../object.js';
import type { HlcTimestamp, Op, OpEnvelope } from '../operations.js';
import { serializeScene } from '../scene.js';
import { createDoc, docFingerprint, emptyDoc, mergeEnvelopes, toSceneState } from './doc.js';
import { compareStamps } from './register.js';

const BASE = 1_700_000_000_000;
const SKEW_MS = 10 * 60 * 1000;
const IDS = ['o1', 'o2', 'o3', 'o4'] as const;

const objectIdArb = fc.constantFrom(...IDS);
const propArb = fc.constantFrom<MutableProp>(...MUTABLE_PROPS);

const createArb: fc.Arbitrary<Op> = fc
  .record({
    id: objectIdArb,
    type: fc.constantFrom<SceneObjectType>('rect', 'ellipse', 'line', 'text'),
    x: fc.integer({ min: -100, max: 300 }),
    y: fc.integer({ min: -100, max: 300 }),
    w: fc.integer({ min: 10, max: 400 }),
    h: fc.integer({ min: 10, max: 400 }),
    rotation: fc.integer({ min: -180, max: 180 }),
    fill: fc.constantFrom('#111111', '#222222', '#333333'),
  })
  .map((input): Op => ({ kind: 'createObject', object: createSceneObject(input) }));

const setPropArb: fc.Arbitrary<Op> = fc
  .tuple(objectIdArb, propArb, fc.integer({ min: -50, max: 250 }))
  .map(([objectId, prop, number]): Op => {
    const value =
      prop === 'fill'
        ? `#${(number & 0xffffff).toString(16).padStart(6, '0')}`
        : prop === 'text'
          ? `text-${number}`
          : number;
    return { kind: 'setProp', objectId, prop, value };
  });

const deleteArb: fc.Arbitrary<Op> = objectIdArb.map((objectId): Op => ({
  kind: 'deleteObject',
  objectId,
}));

const zOrderArb: fc.Arbitrary<Op> = fc
  .tuple(objectIdArb, fc.option(objectIdArb, { nil: null }))
  .map(([objectId, afterId]): Op => ({ kind: 'insertZOrder', objectId, afterId }));

const editTextArb: fc.Arbitrary<Op> = fc
  .tuple(objectIdArb, fc.string({ minLength: 1, maxLength: 4 }))
  .map(([objectId, insert]): Op => ({
    kind: 'editText',
    objectId,
    afterCharId: null,
    insert,
  }));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: createArb },
  { weight: 4, arbitrary: setPropArb },
  { weight: 2, arbitrary: deleteArb },
  { weight: 2, arbitrary: zOrderArb },
  { weight: 1, arbitrary: editTextArb },
);

/**
 * Turns a flat list of operations into envelopes, round-robin between
 * `clientCount` replicas. Every replica stamps with its own HLC, and a client
 * can be given a clock offset to model skew.
 */
function makeEnvelopes(
  ops: readonly Op[],
  clientCount: number,
  skews: readonly number[] = [],
): OpEnvelope[] {
  const actors = Array.from({ length: clientCount }, (_, index) => `c${index}`);
  const clocks = actors.map((actor, index) => createHlc(actor, BASE + (skews[index] ?? 0)));

  return ops.map((op, index) => {
    const slot = index % clientCount;
    const actor = actors[slot] as string;
    const now = BASE + index + (skews[slot] ?? 0);
    const hlc = tickHlc(clocks[slot] as ReturnType<typeof createHlc>, actor, now);
    clocks[slot] = hlc;
    return { id: `op-${index}`, actorId: actor, hlc, op };
  });
}

/** Small deterministic PRNG, so a shuffle is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = rng(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
}

/** Re-delivers a random third of the operations, as a flaky network would. */
function duplicateSome<T>(items: readonly T[], seed: number): T[] {
  const random = rng(seed);
  const result: T[] = [];
  for (const item of items) {
    result.push(item);
    if (random() < 0.3) {
      result.splice(Math.floor(random() * (result.length + 1)), 0, item);
    }
  }
  return result;
}

function assertConverged(docs: ReturnType<typeof emptyDoc>[]): void {
  const expected = docFingerprint(docs[0] as ReturnType<typeof emptyDoc>);
  const expectedScene = JSON.stringify(
    serializeScene(toSceneState(docs[0] as ReturnType<typeof emptyDoc>)),
  );
  for (const doc of docs.slice(1)) {
    expect(docFingerprint(doc)).toBe(expected);
    expect(JSON.stringify(serializeScene(toSceneState(doc)))).toBe(expectedScene);
  }
}

describe('CRDT convergence', () => {
  it('converges when clients edit concurrently and delivery is shuffled with duplicates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.array(opArb, { minLength: 1, maxLength: 24 }),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        (clientCount, ops, seedA, seedB, seedC, skewed) => {
          const skews = skewed
            ? Array.from({ length: clientCount }, (_, index) => (index === 0 ? SKEW_MS : 0))
            : [];
          const envelopes = makeEnvelopes(ops, clientCount, skews);
          const replicas = [seedA, seedB, seedC].map((seed) =>
            mergeEnvelopes(emptyDoc(), duplicateSome(shuffle(envelopes, seed), seed + 1)),
          );
          assertConverged(replicas);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('is associative across arbitrary batch boundaries', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        fc.nat(),
        fc.nat(),
        (ops, splitSeed, deliverySeed) => {
          const envelopes = shuffle(makeEnvelopes(ops, 3), deliverySeed);
          const split = splitSeed % (envelopes.length + 1);
          const head = envelopes.slice(0, split);
          const tail = envelopes.slice(split);

          const leftThenRight = mergeEnvelopes(mergeEnvelopes(emptyDoc(), head), tail);
          const rightThenLeft = mergeEnvelopes(mergeEnvelopes(emptyDoc(), tail), head);
          const allAtOnce = mergeEnvelopes(emptyDoc(), envelopes);

          assertConverged([leftThenRight, rightThenLeft, allAtOnce]);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('is idempotent when the same batch is merged twice', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), fc.nat(), (ops, seed) => {
        const envelopes = shuffle(makeEnvelopes(ops, 3), seed);
        const once = mergeEnvelopes(emptyDoc(), envelopes);
        const twice = mergeEnvelopes(once, envelopes);
        const thrice = mergeEnvelopes(twice, shuffle(envelopes, seed + 1));
        assertConverged([once, twice, thrice]);
      }),
      { numRuns: 2_000 },
    );
  });

  it('converges from a seeded demo scene', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), fc.nat(), (ops, seed) => {
        const seedObjects = createInitialScene();
        const envelopes = shuffle(makeEnvelopes(ops, 3), seed);
        const documents = [seed, seed + 1, seed + 2].map((s) =>
          mergeEnvelopes(createDoc(seedObjects), shuffle(envelopes, s)),
        );
        assertConverged(documents);
      }),
      { numRuns: 2_000 },
    );
  });

  it('keeps the value of the newest write for every property (oracle)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), fc.nat(), (ops, seed) => {
        const envelopes = shuffle(makeEnvelopes(ops, 4), seed);
        const doc = mergeEnvelopes(createDoc(createInitialScene()), envelopes);

        // The reference rule: the register for (object, prop) must hold the
        // write with the greatest (HLC, opId) — no matter when it arrived.
        interface Winner {
          hlc: HlcTimestamp;
          opId: string;
          value: unknown;
        }
        const winners = new Map<string, Winner>();
        const consider = (
          objectId: string,
          prop: string,
          value: unknown,
          envelope: OpEnvelope,
        ): void => {
          if (value === undefined) return;
          const key = `${objectId}:${prop}`;
          const current = winners.get(key);
          const candidate: Winner = { hlc: envelope.hlc, opId: envelope.id, value };
          if (!current || compareStamps(current, candidate) < 0) winners.set(key, candidate);
        };

        for (const envelope of envelopes) {
          if (envelope.op.kind === 'setProp') {
            consider(envelope.op.objectId, envelope.op.prop, envelope.op.value, envelope);
          } else if (envelope.op.kind === 'createObject') {
            for (const prop of MUTABLE_PROPS) {
              consider(envelope.op.object.id, prop, envelope.op.object[prop], envelope);
            }
          }
        }

        for (const [key, winner] of winners) {
          const [objectId, prop] = key.split(':') as [string, MutableProp];
          const register = doc.objects.get(objectId)?.props.get(prop);
          expect(register?.value).toEqual(winner.value);
          expect(register?.hlc).toEqual(winner.hlc);
          expect(register?.opId).toBe(winner.opId);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('clock skew', () => {
  it('does not let a clock that is 10 minutes ahead win every conflict', () => {
    const create = createSceneObject({ id: 'o1', type: 'rect', x: 0 });
    const seed = createDoc([create]);

    // A starts 10 minutes in the future; B is correct.
    const aStart = tickHlc(createHlc('a', BASE + SKEW_MS), 'a', BASE + SKEW_MS);
    const bStart = createHlc('b', BASE);

    // 1. A's edit, stamped in the future, wins at first.
    const aFirst: OpEnvelope = {
      id: 'a-1',
      actorId: 'a',
      hlc: aStart,
      op: { kind: 'setProp', objectId: 'o1', prop: 'x', value: 1 },
    };

    // 2. B receives A's operation; its clock jumps past A's, so B's next edit wins.
    const bAfterA = tickHlc(receiveHlc(bStart, aFirst.hlc, BASE), 'b', BASE);
    const bFirst: OpEnvelope = {
      id: 'b-1',
      actorId: 'b',
      hlc: bAfterA,
      op: { kind: 'setProp', objectId: 'o1', prop: 'x', value: 2 },
    };

    // 3. A receives B's operation and overtakes it again.
    const aAfterB = tickHlc(
      receiveHlc(aFirst.hlc, bFirst.hlc, BASE + SKEW_MS),
      'a',
      BASE + SKEW_MS,
    );
    const aSecond: OpEnvelope = {
      id: 'a-2',
      actorId: 'a',
      hlc: aAfterB,
      op: { kind: 'setProp', objectId: 'o1', prop: 'x', value: 3 },
    };

    // Each later edit wins, even though the wall clocks disagree by 10 minutes.
    expect(toSceneState(mergeEnvelopes(seed, [aFirst])).objects.get('o1')?.x).toBe(1);
    expect(toSceneState(mergeEnvelopes(seed, [aFirst, bFirst])).objects.get('o1')?.x).toBe(2);
    expect(toSceneState(mergeEnvelopes(seed, [aFirst, bFirst, aSecond])).objects.get('o1')?.x).toBe(
      3,
    );

    // Delivery order is irrelevant to the final answer.
    assertConverged([
      mergeEnvelopes(seed, [aFirst, bFirst, aSecond]),
      mergeEnvelopes(seed, [aSecond, bFirst, aFirst]),
      mergeEnvelopes(seed, [bFirst, aSecond, aFirst, bFirst, aFirst]),
    ]);
  });

  it('converges under skew in a simulated handoff between two clients', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 24 }), fc.nat(), (ops, seed) => {
        const envelopes = shuffle(makeEnvelopes(ops, 2, [SKEW_MS, 0]), seed);
        // Each replica now also observes the other's operations, so its clock
        // absorbs the skew before it writes again — the merge must not care.
        const documents = [seed, seed + 1, seed + 2].map((s) =>
          mergeEnvelopes(emptyDoc(), shuffle(envelopes, s)),
        );
        assertConverged(documents);
      }),
      { numRuns: 1_000 },
    );
  });
});
