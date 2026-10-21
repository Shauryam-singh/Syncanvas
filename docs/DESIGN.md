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

   Client (React + Vite): local CRDT apply → optimistic render → send ops
```

**Request flow for an edit**

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

---

## 3. Object model

Defined in `shared/src/object.ts`, consumed by client, server and tests.

| Field      | Type                                      | Notes                                             |
| ---------- | ----------------------------------------- | ------------------------------------------------- |
| `id`       | `string`                                  | Client-generated UUID, stable for object lifetime |
| `type`     | `'rect' \| 'ellipse' \| 'line' \| 'text'` | Discriminated union for rendering                 |
| `x`, `y`   | `number`                                  | Top-left in scene coordinates                     |
| `w`, `h`   | `number`                                  | Size (rotation-independent)                       |
| `rotation` | `number`                                  | Degrees, around center                            |
| `fill`     | `string`                                  | CSS color                                         |
| `zIndex`   | `number`                                  | Derived from the RGA z-order sequence             |
| `text`     | `string?`                                 | Only for `type: 'text'`; merged via RGA per char  |

The mutable property set (`MUTABLE_PROPS`) is an explicit allowlist: the CRDT
never accepts a `setProp` for `id` or `type`, so identity is immutable and
convergence bugs from "type races" are impossible by construction.

---

## 4. CRDT design

Implemented in `shared/src/crdt/` (stage 1–2). Three small CRDTs cover the
whole editor:

### 4.1 Hybrid logical clocks (HLC)

Every op carries `{wall, counter, actorId}`.

- `wall`: local clock ms, clamped to `maxClockDriftMs` (default 5 s) — a badly
  skewed client cannot time-travel writes into the far future.
- `counter`: increments when two events land in the same millisecond.
- `actorId`: deterministic tie-break.

Ordering is the lexicographic total order `(wall, counter, actorId)`,
implemented once as `compareHlc` and used by every merge path. HLC gives us
causality ("B sees A's effect ⇒ A < B") while staying close to wall time, so
LWW resolves in the order a human would expect ("latest edit wins").

### 4.2 LWW-map for object properties

Scene state is `Map<objectId, ObjectState>` where each mutable property is an
independent last-writer-wins register:

```
setProp(objectId, prop, value, hlc):
  if objectId not in state: drop (op lost the create race) or buffer
  if hlc > register[prop].hlc:  register[prop] = {value, hlc}
```

- **Per-property registers**, not per-object: two users dragging different
  properties of the same rect (e.g. `x` vs `fill`) never conflict at all.
- **Create/delete** is itself an LWW register over a tombstone bit. A
  `deleteObject` with a greater HLC tombstones the object; later `setProp`
  ops with smaller HLCs are dropped against the tombstone, so a slow client
  cannot resurrect a deleted object. Delete is not compactable until the op
  log is snapshotted past all in-flight replicas.
- **Conflict policy**: LWW is "unfair" (the late writer's value wins even if
  it overwrote a newer semantic intent). For a canvas where properties are
  small, continuous and user-driven this is the right tradeoff — see §10.

### 4.3 RGA for z-order

Layer order is an RGA (Replicated Growable Array) of object ids:

- `insertZOrder(objectId, afterId)` inserts after `afterId` (beginning of the
  sequence when null).
- Concurrent inserts after the same origin are ordered by the HLC total order,
  so every replica produces the identical sequence.
- `zIndex` on each object is materialised from the sequence index (it is
  derived state, not a register — users do not edit it directly).

**Stage 1 note.** The RGA itself lands in stage 3. Stage 1 keeps the same
_shape_ — an explicit order array that owns the layering — but fills it with a
naive rule: a new object is appended on top, and `insertZOrder` moves an
object relative to a neighbour. The consequence is documented and tested:
property writes are order independent, but **structural operations are not**
(two concurrent creates stack differently depending on arrival order). That
gap is exactly what the RGA plus HLC tie-break closes in stage 3, and it is the
"why CRDT" story the project is built around.

### 4.4 RGA for text

Each text object owns a per-character RGA. `editText` carries
`{afterCharId, insert?, deleteCount?}`:

- Concurrent typing at the same cursor interleaves deterministically instead
  of one user's whole string clobbering another's (which is what a naive
  `setProp('text', ...)` would do).
- Characters are keyed by `{actorId}-{counter}` so keys are unique and
  globally ordered; deletions become tombstones trimmed at compaction.

**Why not Yjs?** Rolling our own is a deliberate scope choice: the LWW-map +
RGA + HLC core is ~300 lines, is fully testable with fuzz tests, and is the
artifact that proves we understand _why_ Yjs works (order-independent merge,
tombstones, deterministic tie-breaks). See §10 for the tradeoff.

### 4.5 Undo/redo (per user)

Per-user inverse operations, not global state history:

- Client keeps a local stack of applied op envelopes and their inverses.
- Undo sends the inverse as a **new op with a fresh HLC** — it converges
  through the normal merge path (an undo is just another edit).
- Tradeoff: concurrent undo between two users resolves by LWW like any other
  edit (last undo wins), rather than "each undoes only their own change in
  isolation". Documented, tested, accepted.

### 4.6 Version history and restore

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

| `t`              | Payload                          | Purpose                               |
| ---------------- | -------------------------------- | ------------------------------------- |
| `auth`           | `{token}`                        | JWT handshake before `join`           |
| `join`           | `{roomId}`                       | Subscribe + receive `state`           |
| `ops`            | `{roomId, ops: OpEnvelope[]}`    | Batched edits (idempotent by `op.id`) |
| `presence`       | `{roomId, cursor, selection}`    | Ephemeral, throttled ~30 Hz           |
| `sync`           | `{roomId, snapshotSeq, opIds[]}` | Reconnect catch-up                    |
| `leave` / `ping` | —                                | Lifecycle / RTT                       |

### Server → Client

| `t`        | Payload                         | Purpose                         |
| ---------- | ------------------------------- | ------------------------------- |
| `welcome`  | `{userId, displayName}`         | Post-auth identity              |
| `joined`   | `{role, snapshotSeq, peers[]}`  | Room admission                  |
| `state`    | `{snapshotSeq, objects, ops[]}` | Baseline + ops after snapshot   |
| `ops`      | `{seq, ops[]}`                  | Broadcast remote edits          |
| `ack`      | `{opIds[], seq}`                | Persisted (safe to drop outbox) |
| `presence` | `{peers[]}`                     | Cursor/selection fan-out        |
| `error`    | `{code, message}`               | `unauthorized`/`forbidden`/…    |

### Op envelope

```jsonc
{
  "id": "op_9f3c…", // client-generated, idempotency key
  "actorId": "user_42",
  "hlc": { "wall": 1761000000123, "counter": 7, "actorId": "user_42" },
  "op": { "kind": "setProp", "objectId": "obj_1", "prop": "x", "value": 240 },
}
```

**Order-independence is a protocol invariant**: a gateway merges an incoming
batch into state in _whatever order it arrives_ and the result must equal any
other order. Replayed batches after reconnect are deduped by `op.id`.

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
- Writer folds `snapshot + ops` through the same pure `applyOp` used by clients
  — the snapshot cannot drift from live state because there is one merge
  implementation.
- Named versions = snapshots with `created_by` set; restore per §4.6.

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

| Decision                                       | Why                                                                        | Cost                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Hand-rolled LWW-map + RGA + HLC instead of Yjs | Proves CRDT knowledge; ~300 LOC core; fully fuzz-testable; no black box    | No free sub-transaction text merging; we own the tombstone/compaction edge cases |
| Per-property LWW registers                     | Concurrent edits to different properties never conflict                    | Same-property concurrent edits lose one value (accepted for canvas props)        |
| LWW over OT/transform functions                | Order-independent merge is trivially correct and testable                  | "Latest wins" can silently discard intent for the _same_ property                |
| HLC over pure Lamport                          | Close to wall time → intuitive conflicts; bounded drift                    | Slightly more logic (wall clamping)                                              |
| Undo = new inverse ops                         | Reuses the merge path; works offline and across users                      | Undo is itself an edit (LWW, not isolation-preserving)                           |
| JSON wire format first                         | Debuggable, types shared directly                                          | ~1.5× bytes vs MessagePack; revisit after load tests                             |
| Op log + snapshots in Postgres                 | One transactional store; version restore falls out naturally               | Log growth requires disciplined compaction                                       |
| Redis pub/sub (not Streams)                    | Ops are replayable from Postgres — Redis is transport, not source of truth | No Redis-side durability needed (and none claimed)                               |

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
│   │   ├── store/           # Zustand store (operations, undo/redo, draft)
│   │   └── main.tsx
│   ├── vite.config.ts
│   └── tsconfig*.json
├── server/                  # Node.js gateway
│   ├── src/
│   │   ├── index.ts         # HTTP + health (WS gateway in stage 2)
│   │   └── config.ts
│   └── tsconfig.json
├── shared/                  # Single source of truth for types + CRDT
│   ├── src/
│   │   ├── index.ts
│   │   ├── object.ts        # Object model (stage 0) ✅
│   │   ├── operations.ts    # Op types + HLC (stage 0) ✅
│   │   ├── protocol.ts      # WS message types (stage 0) ✅
│   │   ├── geometry.ts      # Transform maths (stage 1) ✅
│   │   ├── scene.ts         # Scene state + applyOp (stage 1) ✅
│   │   └── crdt/            # LWW-map, RGA, merge (stage 3)
│   └── tsconfig.json
├── scripts/
│   └── smoke.mjs            # Playwright smoke test
├── docs/
│   └── DESIGN.md            # This document
├── docker-compose.yml       # Postgres 16 + Redis 7
├── eslint.config.mjs
├── tsconfig.base.json
└── .github/workflows/ci.yml # lint + format + typecheck + test + build + smoke
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

This is a local, single-user undo. Stage 5 replaces it with the per-user,
cross-user semantics described in §4.5.

### 12.4 What is _not_ in stage 1

- `editText` is accepted but ignored: text is edited as a whole string
  through `setProp('text', …)` until the per-character RGA lands in stage 3.
- No WebSocket, no presence, no persistence — stage 2 onwards.
- Concurrent creates are order sensitive (§4.3).

## 13. Roadmap

| Stage    | Milestone                                                             | Exit criterion                         |
| -------- | --------------------------------------------------------------------- | -------------------------------------- |
| 0        | Monorepo, compose, CI, design doc, shared types                       | CI green; compose healthy              |
| 1 (this) | Canvas, transform maths, operation pipeline, undo/redo                | 500 objects at 60 fps; ops only        |
| 2        | WS gateway, naive LWW sync                                            | Two browsers move a rect live          |
| 3        | Full CRDT (RGA, tombstones), presence/cursors, convergence fuzz tests | 10 000 randomized schedules converge   |
| 4        | Redis pub/sub sharding, Postgres op log + snapshots, JWT rooms        | 2 gateways in sync; restart-safe       |
| 5        | Offline outbox, per-user undo/redo, version restore, k6 load tests    | p95 < 80 ms @ 200 users; 0 lost writes |
| 6        | Dockerfiles, AWS deploy, GitHub Actions CD, README + demo GIF         | Live URL + demo video                  |
