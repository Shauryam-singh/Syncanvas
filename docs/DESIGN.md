# Syncanvas — Technical Design

Real-time collaborative scene editor ("Figma-lite") with a hand-rolled CRDT.
This document is the source of truth for the data model, wire protocol and CRDT
semantics; it is intended to evolve into the public README as the project ships.

---

## 1. Goals and non-goals

**Goals**

- Many users editing one scene concurrently, with live cursors and presence.
- Deterministic convergence: every replica applies the same ops in any order
  and ends with identical state (verified by fuzz/property tests).
- Offline editing: a client can keep working with no connection and merge
  cleanly (no lost writes) on reconnect.
- Horizontally scalable WebSocket gateways synced through Redis pub/sub.
- Durable history: operation log in Postgres, periodic snapshots, compaction,
  version restore.
- Role-based rooms (owner/editor/viewer) via share links and JWT.

**Non-goals (for now)**

- Not a pixel-perfect Figma clone: rectangles, ellipses, lines and text are
  enough to exercise every hard problem (transform, z-order, text merge).
- No binary wire protocol yet — JSON first, MessagePack/protobuf is a later
  optimization with the envelope already versioned.

---

## 2. Architecture

```
                ┌─────────────────────────────────────────────┐
                │              Load balancer                 │
                │        (WS sticky by roomId hash)          │
                └────────┬──────────────────────┬─────────────┘
                         │                      │
                 ┌───────▼────────┐     ┌───────▼────────┐
                 │ Gateway  A     │     │ Gateway  B     │   Node.js + ws
                 │ - auth (JWT)   │     │ - auth (JWT)   │
                 │ - CRDT merge   │     │ - CRDT merge   │
                 │ - presence     │     │ - presence     │
                 └───┬────────┬───┘     └───┬────────┬───┘
                     │        │             │        │
        publish/sub ─┘        └───┬─────────┘        └─── publish/sub
                     ┌────────────▼────────────┐
                     │   Redis                 │
                     │ - pub/sub  room:{id}    │
                     │ - presence TTL keys     │
                     │ - room ownership locks  │
                     └────────────┬────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │   PostgreSQL            │
                     │ - rooms, members        │
                     │ - op log                │
                     │ - snapshots / versions  │
                     └─────────────────────────┘

   Client (React + Vite): CRDT merge → project → render (optimistic apply is stage 5)
```

**Request flow for an edit (stage 3 — what is implemented today)**

1. User drags a rect. The client renders a transient _draft_ while the pointer
   moves and turns the finished gesture into one or two operations.
2. The client stamps the operations with its HLC, puts the envelopes in its
   outbox and sends an `ops` batch over the WebSocket. It does **not** apply
   them locally yet — the author waits for the echo.
3. The gateway stamps the envelopes with its own identity for the actor,
   merges the batch into the room's CRDT document (order-independent),
   assigns the batch the next sequence number as a broadcast watermark, and
   broadcasts it to the room — the author included.
4. Every client merges the same envelopes into its own document and projects
   the result. Because the merge is commutative, delivery order does not
   matter; all replicas reach the same scene.
5. The gateway acknowledges the batch; the client drops the envelopes from
   its outbox. A client that reconnects sends `sync {snapshotSeq, opIds}` and
   re-sends only what the gateway is missing.

**Request flow for an edit (stage 5 — the target architecture)**

1. User drags a rect. Client mutates its local CRDT state and renders
   immediately (optimistic, never blocked on network).
2. Client stamps the op with its local HLC, appends it to the offline outbox
   (IndexedDB), and sends an `ops` batch over WebSocket.
3. Gateway validates role (`editor`+), merges the op into the authoritative
   state (order-independent merge, so arrival order does not matter), appends
   to the Postgres op log, acks the author, and publishes to `room:{id}`.
4. Other gateways subscribed to `room:{id}` receive the publish and fan the op
   out to their local sockets.
5. A snapshot worker folds the op log into a snapshot every N ops / T seconds
   and compacts the log.

> **The gap between the two flows is the point of the project.** Stage 2 ordered
> operations centrally, which converged but paid a round trip on every edit and
> could not merge two offline histories. Stage 3 replaced the ordering point
> with an order-independent merge: conflicts now resolve by version, not by
> arrival order, and the gateway is a relay rather than an arbiter. What
> remains for stage 5 is applying locally _before_ the echo, keeping the outbox
> in IndexedDB, and persisting the log. §13 measures what stage 2 cost.

---

## 3. Object model

Defined in `shared/src/object.ts`, consumed by client, server and tests.

| Field      | Type                                      | Notes                                                     |
| ---------- | ----------------------------------------- | --------------------------------------------------------- |
| `id`       | `string`                                  | Client-generated UUID, stable for object lifetime         |
| `type`     | `'rect' \| 'ellipse' \| 'line' \| 'text'` | Discriminated union for rendering                         |
| `x`, `y`   | `number`                                  | Top-left in scene coordinates                             |
| `w`, `h`   | `number`                                  | Size (rotation-independent)                               |
| `rotation` | `number`                                  | Degrees, around center                                    |
| `fill`     | `string`                                  | CSS color                                                 |
| `zIndex`   | `number`                                  | Derived from the RGA z-order sequence                     |
| `text`     | `string?`                                 | Only for `type: 'text'`; LWW now, per-char RGA in stage 5 |

The mutable property set (`MUTABLE_PROPS`) is an explicit allowlist: the CRDT
never accepts a `setProp` for `id` or `type`, so identity is immutable and
convergence bugs from "type races" are impossible by construction.

---

## 4. CRDT design

Implemented in `shared/src/crdt/` (stage 3) with no dependencies. Three small
pieces compose into the whole editor: a versioned register, a sequence, and a
document that ties them to the operation log.

### 4.1 Versions: HLC plus operation id

Every operation travels as an envelope
`{id, actorId, hlc: {wall, counter, actorId}, op}`. Writes are compared by a
**version**:

```
version(op) = (hlc.wall, hlc.counter, hlc.actorId, op.id)
```

`compareStamps` (`register.ts`) implements that order once and every merge path
uses it. The HLC supplies causality and a human-meaningful "latest edit wins";
the operation id is a final tie-break that is unique per operation, so even two
edits stamped at exactly the same logical instant resolve identically on every
replica.

`tickHlc` moves the wall clock forward (or keeps it) and bumps the counter
inside a millisecond. `receiveHlc` moves the local clock strictly past every
remote timestamp it observes, so a client that has seen A's edit always stamps
its next edit after A. There is deliberately **no clamping**: clamping would
break "receive is strictly after send" and with it causality. The price is that
a client whose wall clock is 10 minutes fast drags the room's logical clock
forward when the others receive its operations — but only until they have
observed them, after which their own edits overtake it (§4.5, §14.1).

### 4.2 LWW-map for object properties

The document stores one `ObjectRecord` per object id. Each mutable property has
an independent register `{value, hlc, opId}`; a write replaces the register only
when its version is greater.

- **Per-property registers**, not per-object: two users dragging different
  properties of the same rect (`x` vs `fill`) never conflict at all.
- **Any op creates the record.** A `setProp` or `deleteObject` whose
  `createObject` has not arrived yet creates a record with `birth: null`. The
  record is invisible until the create lands, but the write is already stored,
  so it survives the wait. This is what makes delivery order irrelevant.
- **Create is a register too.** `birth` holds the object's `type`, versioned
  by the create's stamp. The create's mutable properties are registers at the
  same version, so a later `setProp` wins and an older, late create cannot
  clobber newer properties.
- **Existence is delete-wins.** An object is alive when it has a birth and
  either no death, or a birth strictly later than the death in
  `(wall, counter)` — the actor id is ignored for existence, so an exact
  logical-time tie goes to the tombstone. A delete followed by a new create
  (what undo emits) has a strictly later birth and **resurrects** the object;
  a late `setProp` can never resurrect it.
- **Conflict policy**: LWW is "unfair" — the later writer wins even if it
  overrode a newer semantic intent. For a canvas whose properties are small,
  continuous and user-driven, this is the right tradeoff; see §10.

Registers and records are immutable values, so a merge returns a new document
and reuses every record it did not touch.

### 4.3 RGA for z-order

Layer order is an RGA (Replicated Growable Array) of object ids. Each object has
at most **one** placement entry (`OrderEntry`), so moving it replaces its
previous placement instead of leaving a duplicate in the sequence.

A placement's **origin** is one of three things:

| Origin                          | Meaning                 | Emitted by                     |
| ------------------------------- | ----------------------- | ------------------------------ |
| `{kind: 'top'}`                 | the top of the stack    | `createObject` (implicitly)    |
| `{kind: 'bottom'}`              | the bottom of the stack | `insertZOrder(objectId, null)` |
| `{kind: 'after', objectId: id}` | immediately above `id`  | `insertZOrder(objectId, id)`   |

The two stack ends cannot share the `null` origin: a new object is appended on
**top**, while `insertZOrder(objectId, null)` has always meant "send to
**back**". Keeping both as explicit origins preserves the stage-1 contract
without making creation land at the bottom.

The sequence is a depth-first walk of the origin tree. Sibling order is a pure
function of the entries' versions:

- **top roots, ascending** — the newest object is emitted last, so it is drawn
  on top;
- **bottom roots, descending** — the most recent "send to back" is the
  bottom-most;
- **children of an `after` origin, descending** — the most recent move lands
  immediately above its origin.

Two robustness rules make the walk total:

- **Dead nodes stay as hinges.** A deleted object is skipped in the output but
  still walked, so the objects placed above it keep their relative position.
- **Cycles are broken deterministically.** Moving A after B and B after A
  creates a cycle with no natural root. After the root walk, the entries it
  never reached are emitted one component at a time, smallest version first, so
  every replica breaks the cycle the same way.

`zIndex` is materialised from the walk's index on every projection. It is
derived state, never a register: users move the sequence, not the number.

### 4.4 RGA for text

`editText` carries `{afterCharId, insert?, deleteCount?}` and is reserved for a
per-character RGA: concurrent typing at the same cursor interleaves
deterministically instead of one user's whole string clobbering another's.

In stage 3 the operation is validated and remembered — so its id stays
idempotent, and the wire format does not change later — but the projection
ignores it. Text is still an LWW register over the whole string. The generic
RGA in `rga.ts` is the structure the per-character version will reuse (origins
are character keys, deletions are tombstones); that lands in stage 5.

**Why not Yjs?** Rolling our own is a deliberate scope choice: the LWW-map +
RGA + HLC core is a few hundred lines, is fully testable with property-based
tests, and is the artifact that proves we understand _why_ Yjs works
(order-independent merge, tombstones, deterministic tie-breaks). See §10 for the
tradeoff.

### 4.5 How the merge is verified

The stage-3 tests are the most important in the project:

| File                  | What it proves                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register.test.ts`    | Total order, operation-id tie-break, idempotence, null handling                                                                                   |
| `rga.test.ts`         | Top/bottom origins, moves, dead hinges, cycles, deterministic sibling order, placement LWW                                                        |
| `doc.test.ts`         | Out-of-order set/delete/placement, tie-breaks, delete-wins, undo resurrection, projection, seed parity                                            |
| `convergence.test.ts` | 10,000 randomized schedules: 2–5 clients, shuffled delivery with duplicates, identical `docFingerprint` and projected scene on every replica      |
| `convergence.test.ts` | An independent **oracle**: every register equals the maximum-version write, computed outside the merge                                            |
| `convergence.test.ts` | Clock skew: a client 10 minutes ahead wins its first edit, then loses to every client that observed it; delivery order does not change the result |

The oracle matters because a convergence test alone would happily accept a
consistently _wrong_ merge rule — all replicas would agree on the wrong value.
The oracle and the skew test pin the semantics, while the 10,000-schedule test
pins agreement. fast-check shrinks any failing schedule to a minimal
counterexample. The full property suite runs in about one second, so CI runs it
on every build instead of sampling it.

### 4.6 Undo/redo (per user)

Per-user inverse operations, not global state history:

- Client keeps a local stack of applied op envelopes and their inverses.
- Undo sends the inverse as a **new op with a fresh HLC** — it converges
  through the normal merge path (an undo is just another edit).
- Tradeoff: concurrent undo between two users resolves by LWW like any other
  edit (last undo wins), rather than "each undoes only their own change in
  isolation". Documented, tested, accepted.

### 4.7 Version history and restore

Snapshots (§7) double as named versions. **Restore** is emitted as a diff: the
server computes `current → snapshot` and materialises `setProp` /
`deleteObject` ops, then broadcasts them. History stays append-only and the
restore itself is undoable.

---

## 5. Message protocol

JSON envelopes over a single WebSocket per room, discriminated by `t`
(`shared/src/protocol.ts`). Every message type is a shared type — no
hand-written interfaces on either side.

### Client → Server

| `t`              | Payload                          | Purpose                                         |
| ---------------- | -------------------------------- | ----------------------------------------------- |
| `auth`           | `{token, displayName?}`          | JWT handshake before `join` (stage 4: real JWT) |
| `join`           | `{roomId}`                       | Subscribe + receive `state`                     |
| `ops`            | `{roomId, ops: OpEnvelope[]}`    | Batched edits (idempotent by `op.id`)           |
| `presence`       | `{roomId, cursor, selection}`    | Ephemeral, throttled ~30 Hz                     |
| `sync`           | `{roomId, snapshotSeq, opIds[]}` | Reconnect catch-up                              |
| `leave` / `ping` | —                                | Lifecycle / RTT                                 |

### Server → Client

| `t`        | Payload                               | Purpose                                 |
| ---------- | ------------------------------------- | --------------------------------------- |
| `welcome`  | `{userId, displayName, color}`        | Post-auth identity (server-assigned id) |
| `joined`   | `{roomId, role, snapshotSeq, peers}`  | Room admission                          |
| `state`    | `{roomId, snapshotSeq, objects, ops}` | Baseline + ops after snapshot           |
| `ops`      | `{roomId, seq, ops[]}`                | Broadcast of edits — author included    |
| `ack`      | `{roomId, opIds[], seq}`              | Received (safe to drop from the outbox) |
| `presence` | `{roomId, peers[]}`                   | Cursor/selection fan-out                |
| `error`    | `{code, message}`                     | `unauthorized`/`forbidden`/…            |
| `pong`     | —                                     | Liveness                                |

The `userId` in `welcome` is assigned by the gateway: a client cannot choose
its own identity and cannot forge the `actorId` of an envelope — the gateway
stamps every envelope it accepts with the identity of the socket that sent it.

### Op envelope

```jsonc
{
  "id": "op_9f3c…", // client-generated, idempotency key
  "actorId": "user_42",
  "hlc": { "wall": 1761000000123, "counter": 7, "actorId": "user_42" },
  "op": { "kind": "setProp", "objectId": "obj_1", "prop": "x", "value": 240 },
}
```

**The stage-3 invariant is order independence, not a central order.** The
gateway still assigns every accepted batch the next sequence number, but that
number is a **broadcast watermark**: it is used to acknowledge the author and to
replay what a reconnecting client missed. It is not a merge rule. The gateway
merges the batch into the room's CRDT document, and every client merges the
same envelopes into its own document; the winner of a conflict is
`(HLC, opId)` on every replica, regardless of arrival order (§4.1–4.2).

- two users drag the same rectangle at the same time → the later write wins on
  every replica, and both clients see the same outcome;
- a client that reconnects can merge its history with the room's, because the
  merge no longer depends on a single delivery order.

Replayed batches after a reconnect are deduped by `op.id` (the document keeps a
`seen` set), so a client that re-sends its outbox cannot apply anything twice.
Catch-up currently starts from a **projected snapshot** rather than the full
CRDT history; §13 lists what that costs.

---

## 6. Persistence model (Postgres)

```sql
CREATE TABLE rooms (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  owner_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_members (
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE invite_links (
  token       text PRIMARY KEY,           -- share-link secret
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('editor','viewer')),
  created_by  text NOT NULL,
  expires_at  timestamptz
);

CREATE TABLE ops (                          -- the operation log
  id          bigserial PRIMARY KEY,        -- room-local seq, assigned on append
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  op_key      text NOT NULL,                -- Envelope.id, idempotency
  actor_id    text NOT NULL,
  hlc_wall    bigint NOT NULL,
  hlc_counter int  NOT NULL,
  payload     jsonb NOT NULL,               -- OpEnvelope.op
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, op_key)                  -- replay-safe duplicate drops
);

CREATE INDEX ops_room_id_idx ON ops (room_id, id);

CREATE TABLE snapshots (
  id          bigserial PRIMARY KEY,
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  last_op_id  bigint NOT NULL,              -- ops.id watermark covered
  state       jsonb NOT NULL,               -- materialised scene
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Read path:** `state = latest snapshot (last_op_id = M) + ops WHERE id > M`,
applied in any order thanks to the merge invariant.

**Compaction:** after a snapshot is written, `DELETE FROM ops WHERE room_id = ?
AND id <= last_op_id` (batched, in a transaction with the snapshot insert).
Op rows referenced by _retained history versions_ are preserved by keeping the
watermark of the oldest named version.

---

## 7. Snapshots and version history

- Trigger: every **1 000 ops** or **5 minutes** of activity per room.
- Single-writer: a Redis `SET NX PX` lock (`lock:snapshot:{roomId}`, 10 s TTL)
  ensures only one gateway snapshots a room; others skip.
- Writer folds `snapshot + ops` through the same `mergeEnvelopes` (and the same
  projection) used by the gateway and the clients — the snapshot cannot drift
  from live state because there is one merge implementation.
- Named versions = snapshots with `created_by` set; restore per §4.7.

---

## 8. Presence, offline and reconnect

**Presence** — ephemeral Redis hash per room (`presence:{roomId}`,
field = userId, `HSET`/`EXPIRE 30s`), gossiped over the same pub/sub channel
at ~15 Hz per client (throttled, interpolated client-side). Never touches
Postgres.

**Offline** — the client persists every local op envelope in an IndexedDB
outbox _before_ rendering from it:

1. Reconnect → `sync` with `{snapshotSeq, opIds}` → server replies `state`
   with only the delta, plus `ack`s for outbox entries already persisted.
2. Unacked envelopes are re-sent; server dedupes on `UNIQUE (room_id, op_key)`.
3. Because merges are order-independent and HLC-stamped, offline edits land as
   if they had been made concurrently with everything else.

Success metric: outbox entries eventually acked / total (target: 100 % in fuzz
tests that randomly partition clients).

---

## 9. Scaling gateways

- Rooms are sharded onto gateways by `hash(roomId) % N` (consistent hashing);
  the LB only needs L4/round-robin for connections, room affinity comes from
  routing on the `join` message or from clients reconnecting to the owning
  instance via a 302-style `redirect` message.
- Cross-instance fan-out: every gateway `SUBSCRIBE`s to the rooms hosted locally
  and publishes batched ops to `room:{roomId}` on Redis. One Redis, one channel
  per room.
- Backpressure: per-socket send queues with high-water mark; slow consumers get
  `sync`-style resumable catch-up instead of unbounded buffering.
- Metrics (Prometheus): connections/instance, ops/s, `p50/p95 sync latency`
  (client timestamp → `ack`), queue depth, Redis round-trip.
- Load test (k6, CI stage 4): ramp to 200 virtual users per room, assert
  p95 ack latency < 80 ms and zero convergence mismatches at the end.

---

## 10. Design decisions and tradeoffs

| Decision                                       | Why                                                                            | Cost                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Hand-rolled LWW-map + RGA + HLC instead of Yjs | Proves CRDT knowledge; ~300 LOC core; fully fuzz-testable; no black box        | No free sub-transaction text merging; we own the tombstone/compaction edge cases |
| Per-property LWW registers                     | Concurrent edits to different properties never conflict                        | Same-property concurrent edits lose one value (accepted for canvas props)        |
| LWW over OT/transform functions                | Order-independent merge is trivially correct and testable                      | "Latest wins" can silently discard intent for the _same_ property                |
| HLC over pure Lamport                          | Close to wall time → intuitive conflicts; no trusted clock needed              | Absorbs a peer's future wall clock on receipt (no clamping — §4.1)               |
| Undo = new inverse ops                         | Reuses the merge path; works offline and across users                          | Undo is itself an edit (LWW, not isolation-preserving)                           |
| JSON wire format first                         | Debuggable, types shared directly                                              | ~1.5× bytes vs MessagePack; revisit after load tests                             |
| Op log + snapshots in Postgres                 | One transactional store; version restore falls out naturally                   | Log growth requires disciplined compaction                                       |
| Redis pub/sub (not Streams)                    | Ops are replayable from Postgres — Redis is transport, not source of truth     | No Redis-side durability needed (and none claimed)                               |
| Delete-wins existence rule                     | No late `setProp` can resurrect a deleted object; ties are deterministic       | A create tied exactly with a delete loses; undo must be strictly later           |
| Operation id as the final tie-break            | Even identical HLCs resolve the same way on every replica                      | Version compare is a 4-tuple, not just an HLC compare                            |
| Explicit top/bottom origins for z-order        | Creation appends, "send to back" prepends — both have a meaning                | One extra field in every order entry                                             |
| Gateway merges but no longer orders            | Server and clients run the same code path, so they cannot disagree             | The gateway must hold a replica of every room it serves                          |
| No optimistic apply (stage 3)                  | The scene is always a prefix of the replicated document — easy to reason about | Every keystroke waits for the round trip; feels laggy on a bad link (stage 5)    |
| Broadcast to the author as well                | The author merges the same envelopes as everybody else                         | The author cannot render before the server answers                               |

---

## 11. Repository layout

```
syncanvas/
├── client/                  # React + Vite + TS editor
│   ├── src/
│   │   ├── App.tsx          # Editor shell
│   │   ├── canvas/          # SVG canvas, selection overlay, viewport maths
│   │   ├── components/      # Toolbar, properties panel, status bar
│   │   ├── hooks/           # Keyboard shortcuts
│   │   ├── net/             # SyncClient + the useSync hook (stage 2) ✅
│   │   ├── store/           # Zustand store (operations, undo/redo, draft)
│   │   └── main.tsx
│   ├── vite.config.ts
│   └── tsconfig*.json
├── server/                  # Node.js gateway
│   ├── src/
│   │   ├── index.ts         # HTTP + health + WebSocket upgrade (stage 2) ✅
│   │   ├── gateway.ts       # Protocol handling, broadcast, server ids (stage 2) ✅
│   │   ├── rooms.ts         # Room registry, CRDT merge (stage 3) ✅
│   │   └── config.ts
│   └── tsconfig.json
├── shared/                  # Single source of truth for types + CRDT
│   ├── src/
│   │   ├── index.ts
│   │   ├── object.ts        # Object model (stage 0) ✅
│   │   ├── operations.ts    # Op types + HLC (stage 0) ✅
│   │   ├── protocol.ts      # WS message types + runtime validators (stage 2) ✅
│   │   ├── geometry.ts      # Transform maths (stage 1) ✅
│   │   ├── scene.ts         # Scene state + applyOp (stage 1) ✅
│   │   ├── hlc.ts           # Hybrid logical clock (stage 2) ✅
│   │   ├── initialScene.ts  # Room seed scene (stage 2) ✅
│   │   └── crdt/            # LWW-map, RGA, merge + fuzz tests (stage 3) ✅
│   └── tsconfig.json
├── scripts/
│   ├── browser.mjs          # Chromium resolution shared by the smoke tests
│   ├── smoke.mjs            # Playwright smoke test (stage 1) ✅
│   └── sync-smoke.mjs       # Two-browser sync test (stage 2) ✅
├── docs/
│   └── DESIGN.md            # This document
├── docker-compose.yml       # Postgres 16 + Redis 7
├── eslint.config.mjs
├── tsconfig.base.json
└── .github/workflows/ci.yml # lint + format + typecheck + test + build + smoke + sync
```

**Stage 0 acceptance:** `docker compose up` healthy on a clean machine, CI
green on an empty test, object model + protocol types published from `shared`.

---

## 12. Stage 1 — the single-user canvas

The canvas is deliberately boring in one respect: **there is exactly one way
to change the scene**. Every gesture ends in an operation, and `applyOp` is
the only function that produces a new `SceneState`.

```
pointer event ──► canvas ──► store ──► applyOp() ──► scene state ──► render
                      │         │
                      │         └──► undo/redo (inverse operations)
                      └──► transient draft, never persisted
```

### 12.1 Transform maths (`shared/src/geometry.ts`)

The renderer and the interaction code must agree on where an object is, so
both use the same pure helpers:

- An object is an axis-aligned box `(x, y, w, h)` plus a `rotation` in
  degrees around the **centre of the box**.
- `toLocalPoint` / `toWorldPoint` move between world space and the object's
  local frame; hit-testing and resizing both work in the local frame, so a
  rotated object behaves exactly like an unrotated one.
- `resizeObject(object, handle, pointer, options)` pins the **anchor** (the
  opposite handle) in world space and grows the object along its own local
  axes. Options: `preserveAspectRatio` (shift) and `fromCenter` (alt).
- `hitTest(objects, point)` walks the stack from the top and returns the first
  object under the pointer, so the top-most object wins.

### 12.2 Scene state (`shared/src/scene.ts`)

```ts
interface SceneState {
  objects: ReadonlyMap<string, SceneObject>;
  order: readonly string[]; // object ids, bottom-most → top-most
  tombstones: ReadonlySet<string>; // deleted ids, kept until compaction
}
```

`applyOp(state, op)` is pure, immutable and idempotent. `zIndex` is
_materialised_ from `order` on every structural change, so it is never a
register a user can write to (`MUTABLE_PROPS` excludes it).

### 12.3 Undo/redo

Undo is implemented with inverse operations computed **before** the forward
operations are applied — the only state they can undo. One user gesture is
one undo entry, even when it produced several operations (a drag writes
`x` and `y`). Redo replays the original operations.

This is a local undo stack. Stage 3 keeps the inverse-operation mechanism but
runs the inverse through the CRDT merge, so undo is just another edit and
travels to every replica (§4.6).

### 12.4 What is _not_ in stage 1

- `editText` is accepted but ignored: text is edited as a whole string
  through `setProp('text', …)` until the per-character RGA lands in stage 5.
- No WebSocket, no presence, no persistence — stage 2 onwards.
- Concurrent creates were order sensitive; stage 3 replaced the order array
  with an RGA (§4.3).

---

## 13. Stage 2 (historical) — the gateway and the naive LWW sync

Stage 2 adds the one thing stage 1 could not have: a **second person**. This
section records the design that shipped; §14 describes the merge that replaced
it in stage 3. The transport described here — identities, outbox, sequence
numbers, reconnect — is still what the running gateway does.

```
┌────────────────┐  ops   ┌──────────────────┐  ops   ┌────────────────┐
│ Client A       │ ─────► │ Gateway (ws)     │ ─────► │ Client B       │
│ store ──► outbox│ ◄───── │ room registry    │ ◄───── │ store ◄── outbox│
└────────────────┘  ack   │ naive LWW merge  │  ack   └────────────────┘
                          │ seq per batch    │
                          └──────────────────┘
```

### 13.1 The gateway (`server/src/gateway.ts`, `server/src/rooms.ts`)

The gateway was deliberately small and had exactly one responsibility: **decide
in what order operations are broadcast.**

- A socket connects, sends `auth`, and receives a `welcome` with a
  **server-assigned** `userId` and a colour. A client cannot choose its
  identity, and every envelope the gateway accepts is stamped with the
  identity of the socket that sent it — nobody can forge another peer.
- `join` adds the client to a room and sends it the room state
  (`snapshotSeq` + the objects) plus the roster.
- An `ops` batch is deduped, merged into the room's document (arrival order in
  stage 2, CRDT in stage 3), assigned the next sequence number, and broadcast
  to **everyone in the room, the author included**.
- `op.id` is the idempotency key. A batch that contains an operation the room
  has already seen is not applied twice; the author is sent the full state
  instead, because a duplicate means it missed a broadcast.
- The rooms live in memory for now. The document's `seen` set is the replay
  guard that moves into Postgres as `UNIQUE (room_id, op_key)` in stage 4.

### 13.2 The client (`client/src/net/syncClient.ts`)

- The client keeps an **outbox** of envelopes it has sent but the gateway has
  not acknowledged. An acknowledged envelope is dropped.
- It delivers operations **strictly in sequence order**. A batch that arrives
  early is buffered until its predecessor shows up; a gap means something was
  lost, and the client asks for the full state instead of guessing. This
  ordering is now a transport guarantee, not the merge rule: the store would
  converge even if the batches arrived out of order.
- **No optimistic apply.** The client does not apply its own operations when
  it creates them — it waits for the gateway to echo them back. The price is a
  round trip on every edit; the benefit is that the scene is always a prefix
  of the replicated document. Local-first apply is stage 5.
- On reconnect the client sends `sync {snapshotSeq, opIds}`; the gateway
  acknowledges the operations it already has and sends the current state, and
  the client re-sends only what is missing.
- The hybrid logical clock (`shared/src/hlc.ts`) stamps every envelope.

### 13.3 What naive LWW cost (and what stage 3 fixed)

The stage-2 merge was `applyOps` in arrival order — the last write to a
property won. That was convergent (every replica ended with the same scene) but
not conflict-free:

| Situation                                     | Stage 2 behaviour                                        | Stage 3                              |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| Two users drag the same rect at the same time | One drag is lost; the winner depends on arrival order    | Later version wins on every replica  |
| Two users set different properties            | No conflict — the properties are independent             | Unchanged                            |
| Two users create an object at the same time   | Both survive, but their z-order depends on arrival order | RGA orders them deterministically    |
| A client is offline for a minute              | Its edits are lost: they never reach the gateway         | Still lost — stage 5 adds the outbox |

### 13.4 How stage 2 is tested

| Test                                         | What it proves                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/rooms.test.ts`                   | Room lifecycle, dedupe and one sequence per batch (the CRDT merge assertions were added in stage 3)                                            |
| `server/src/gateway.test.ts`                 | Two real WebSocket clients: join, broadcast, ack, identity stamping, room isolation                                                            |
| `client/src/net/syncClient.test.ts`          | The client against an injected socket: ordering, the outbox, reconnect and re-sync                                                             |
| `client/src/store/sceneStore.test.ts`        | The store in connected mode: it sends instead of applying, and the undo stack follows the gateway                                              |
| `shared/src/hlc.test.ts`, `protocol.test.ts` | The clock never goes backwards; a malformed frame is rejected, not coerced                                                                     |
| `scripts/sync-smoke.mjs`                     | Two real browser pages on one canvas: an edit in one shows up in the other, both converge, undo travels, the clients survive a gateway restart |

The stage 2 checklist:

- [x] WebSocket gateway (`ws`), room join/leave
- [x] Operations broadcast to the room, acknowledged to the author
- [x] Server-assigned client ids — the client cannot forge an identity
- [x] Reconnect with a re-sync (`sync {snapshotSeq, opIds}`), no lost or duplicated operations
- [x] Naive server-arrival-order LWW sync, convergent by construction
- [x] Two browsers on one canvas (verified by the two-browser smoke test)

---

## 14. Stage 3 — the CRDT merge

Stage 3 replaces the arbiter with a merge. The gateway is still the relay:
it assigns sequence numbers, owns the room document and fans envelopes out.
But it no longer _decides_ the winner; it merges. Every browser runs the same
pure `mergeEnvelope` from `shared/src/crdt/`, so the browser and the server
cannot disagree about the merge rule.

```
┌────────────────┐  ops   ┌──────────────────────────┐  ops   ┌────────────────┐
│ Client A       │ ─────► │ Gateway (ws)             │ ─────► │ Client B       │
│ doc.merge()    │ ◄───── │ room.doc.merge()         │ ◄───── │ doc.merge()    │
│ project → SVG  │  echo  │ seq per batch (watermark)│  echo  │ project → SVG  │
└────────────────┘        └──────────────────────────┘        └────────────────┘
```

**What changed**

- `server/src/rooms.ts` holds a `SceneDoc` and calls `mergeEnvelopes` with the
  accepted batch. `snapshot()` projects it with `toSceneState` +
  `serializeScene`. The `seen` set inside the document is the dedupe guard.
- `client/src/store/sceneStore.ts` holds a `SceneDoc`. In local mode it stamps
  operations with a local HLC and merges them; in live mode the echo from the
  gateway carries the same envelopes and is merged the same way. The scene is
  always `toSceneState(doc)`, so the rendering path did not change.
- `client/src/net/syncClient.ts` hands the **envelopes** (not just the bare
  operations) to the store, because the merge needs the HLC and the op id.
- Undo and redo emit inverse operations stamped with a fresh HLC, so they are
  ordinary edits and converge through the same path (§4.6).

**What is still missing**

- **Optimistic local apply.** In live mode the author still waits for the echo.
  The merge would allow applying immediately and reconciling, but the undo
  stack and the outbox need to agree on what "already applied" means first.
- **Full-state sync.** A joining client receives the projected scene, not the
  tombstones and register versions. That is sufficient for the operations it
  receives afterwards, but a full CRDT snapshot belongs with the persisted log
  in stage 4.
- **Tombstone compaction.** Deleted objects are kept forever; safe, but the
  document grows. Compaction needs a watermark past all in-flight replicas.
- **Per-character text.** §4.4.

### 14.1 How stage 3 is tested

| Test                                  | What it proves                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/crdt/register.test.ts`    | Version order, op-id tie-break, idempotence                                                                                                       |
| `shared/src/crdt/rga.test.ts`         | Top/bottom/after origins, moves, dead hinges, cycle breaking, deterministic sibling order                                                         |
| `shared/src/crdt/doc.test.ts`         | Out-of-order writes and deletes, delete-wins, resurrection, projection, seed parity, idempotent replay                                            |
| `shared/src/crdt/convergence.test.ts` | 10,000 randomized schedules (2–5 clients, shuffled + duplicated delivery) end in the same `docFingerprint` and the same projected scene           |
| `shared/src/crdt/convergence.test.ts` | Oracle: every register holds the maximum-version write, computed independently of the merge                                                       |
| `shared/src/crdt/convergence.test.ts` | Clock skew: a client 10 minutes ahead wins its first edit, then loses to clients that observed it; delivery order does not change the final state |
| `server/src/rooms.test.ts`            | The gateway keeps the newest write even when it arrives first, and a late edit cannot resurrect a deleted object                                  |
| `scripts/sync-smoke.mjs`              | Two real browsers still converge, undo still travels, and both survive a gateway restart                                                          |

The stage 3 checklist:

- [x] Hybrid logical clock with a total order and skew absorption
- [x] LWW register per object property, keyed by `(value, HLC, opId)`
- [x] Deterministic tie-break, including exact-clock ties
- [x] Delete-wins tombstones, with resurrection by a strictly later create
- [x] RGA for z-order with top/bottom origins, dead hinges and cycle breaking
- [x] Idempotent, commutative, associative `mergeEnvelope`
- [x] Pure, dependency-free module in `shared/src/crdt/`
- [x] 10,000 randomized schedules converge, with an independent oracle
- [x] A 10-minute clock skew converges and does not win forever
- [x] Gateway and editor both merge through the CRDT

---

## 15. Roadmap

| Stage    | Milestone                                                           | Exit criterion                         |
| -------- | ------------------------------------------------------------------- | -------------------------------------- |
| 0        | Monorepo, compose, CI, design doc, shared types                     | CI green; compose healthy              |
| 1        | Canvas, transform maths, operation pipeline, undo/redo              | 500 objects at 60 fps; ops only        |
| 2        | WS gateway, naive LWW sync                                          | Two browsers move a rect live          |
| 3 (done) | HLC, LWW-map, RGA z-order, tombstones, convergence fuzz tests       | 10 000 randomized schedules converge   |
| 4        | Redis pub/sub sharding, Postgres op log + CRDT snapshots, JWT rooms | 2 gateways in sync; restart-safe       |
| 5        | Offline outbox, optimistic apply, text RGA, version restore, k6     | p95 < 80 ms @ 200 users; 0 lost writes |
| 6        | Dockerfiles, AWS deploy, GitHub Actions CD, README + demo GIF       | Live URL + demo video                  |
