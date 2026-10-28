# Syncanvas — Technical Design

Real-time collaborative scene editor ("Figma-lite") with a hand-rolled CRDT.
This document is the source of truth for the data model, wire protocol and CRDT
semantics; it is intended to evolve into the public README as the project ships.

Stage 5 is implemented: guest JWT sessions, rooms and signed invites, enforced
owner/editor/viewer roles, presence, and a Postgres operation log with snapshots
and compaction. Two or more gateways share rooms through Redis pub/sub; Redis
assigns each accepted batch one room-wide sequence and every gateway applies
that same order. Nginx (or the failover proxies in the scale smoke) can send a
browser to any instance; if an instance dies, the client reconnects and resyncs
from Postgres. Stage 6 contains the remaining client-local work (IndexedDB
outbox, optimistic apply, text RGA, named restore) and load testing.

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
                │              Nginx / LB                     │
                │      least connections, no room affinity    │
                └────────┬──────────────────────┬─────────────┘
                         │                      │
                 ┌───────▼────────┐     ┌───────▼────────┐
                 │ Gateway  A     │     │ Gateway  B     │   Node.js + ws
                 │ - auth (JWT)   │     │ - auth (JWT)   │
                 │ - CRDT replica │     │ - CRDT replica │
                 │ - presence     │     │ - presence     │
                 │ - Postgres log │     │ - Postgres log │
                 └───┬────────┬───┘     └───┬────────┬───┘
                     │        │             │        │
        publish/sub ─┘        └───┬─────────┘        └─── publish/sub
                     ┌────────────▼────────────┐
                     │   Redis                 │
                     │ - pub/sub room:{id}     │
                     │ - per-room sequence key │
                     └────────────┬────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │   PostgreSQL            │
                     │ - rooms, members        │
                     │ - compacted op log      │
                     │ - full-CRDT snapshots   │
                     └─────────────────────────┘

   Client (React + Vite): CRDT merge → project → render (optimistic apply is Stage 6)
```

Redis is the **wire ordering point**, not the source of truth. Every gateway
subscribes to the wildcard room channel and can serve any room; no sticky
routing or room-ownership lock is needed. The bus is optional: without a
reachable `REDIS_URL`, a single gateway remains a complete standalone service.

**Request flow for an edit (Stage 5 — what is implemented today)**

0. The browser signs in through `POST /api/auth/guest`, connects the WebSocket
   and sends `auth {token}`. The gateway verifies the HS256 access token, loads
   the user and replies with a `welcome` that includes a per-connection
   `sessionId`.
1. User drags a rect. The client renders a transient _draft_ while the pointer
   moves and turns the finished gesture into one or two operations.
2. The client stamps the operations with its HLC, puts the envelopes in its
   outbox and sends an `ops` batch over the WebSocket. It does **not** apply
   them locally yet — the author waits for the echo.
3. The gateway checks membership/invite and role. A viewer's batch is rejected
   with `forbidden` and the rejected ids. An editor/owner batch is normalized
   with the socket's actor identity and published on the room bus.
4. Redis runs one Lua script that raises the room counter to the gateway's
   current `floor` when it is missing or lower, increments it, substitutes that
   sequence into the message, publishes it, and returns the sequence. The
   allocation and publish therefore cannot be reordered by another gateway.
5. Every gateway receives the message, including the origin. Messages are
   queued per room; each gateway lazily loads the room from Postgres if needed,
   then merges the batch in bus order. The origin broadcasts the accepted
   envelopes to its clients **before** sending `ack`, so the author can identify
   the echo as its own for undo. Every gateway appends the accepted operations
   with the bus sequence; the `(document_id, op_id)` key makes duplicate writes
   from other replicas idempotent.
6. A duplicate-only publish still consumes a sequence. To keep client
   watermarks contiguous, the gateway broadcasts an empty `ops` frame at that
   sequence, then acknowledges the ids.
7. Every client merges the same envelopes into its own document and projects
   the result. Because the merge is commutative, delivery order does not
   matter; bus order gives all replicas the same `seq` watermark.
8. A client that reconnects sends `sync {snapshotSeq, opIds}` and re-sends only
   what the gateway is missing. The reconnect may land on another instance,
   which loads the same room from Postgres.

**The gap between Stage 2 and Stage 5 is the point of the project.** Stage 2
ordered operations centrally in one process, which converged but paid a round
trip and could not merge two offline histories. Stage 3 replaced the _merge_
ordering point with an order-independent CRDT: conflicts resolve by version, not
arrival order. Stage 5 adds the _wire_ ordering point back only where it helps —
Redis gives all gateways one sequence for acknowledgement and client watermarks
— while the CRDT remains the authority for values. Optimistic local apply,
IndexedDB and per-character text remain Stage 6. §13 measures what Stage 2 cost.

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
| `text`     | `string?`                                 | Only for `type: 'text'`; LWW now, per-char RGA in Stage 6 |

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
are character keys, deletions are tombstones); that lands in Stage 6.

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

| `t`              | Payload                          | Purpose                                           |
| ---------------- | -------------------------------- | ------------------------------------------------- |
| `auth`           | `{token, displayName?}`          | JWT handshake; required within 15 s of connecting |
| `join`           | `{roomId, invite?}`              | Subscribe + receive `state`; membership or invite |
| `ops`            | `{roomId, ops: OpEnvelope[]}`    | Batched edits (idempotent by `op.id`)             |
| `presence`       | `{roomId, cursor, selection}`    | Ephemeral, throttled to 25 Hz by the client       |
| `sync`           | `{roomId, snapshotSeq, opIds[]}` | Reconnect catch-up                                |
| `leave` / `ping` | —                                | Lifecycle / heartbeat                             |

### Server → Client

| `t`        | Payload                                    | Purpose                                 |
| ---------- | ------------------------------------------ | --------------------------------------- |
| `welcome`  | `{userId, sessionId, displayName, color}`  | Post-auth identity (server-assigned id) |
| `joined`   | `{roomId, name, role, snapshotSeq, peers}` | Room admission and assigned role        |
| `state`    | `{roomId, snapshotSeq, objects, ops}`      | Baseline + ops after snapshot           |
| `ops`      | `{roomId, seq, ops[]}`                     | Broadcast of edits — author included    |
| `ack`      | `{roomId, opIds[], seq}`                   | Received (safe to drop from the outbox) |
| `presence` | `{roomId, peers[]}`                        | Cursor/selection fan-out                |
| `error`    | `{code, message, roomId?, opIds?}`         | `unauthorized`/`forbidden`/…            |
| `pong`     | —                                          | Liveness                                |

The `userId` in `welcome` is assigned by the gateway from the verified access
token: a client cannot choose its own identity and cannot forge the `actorId` of
an envelope — the gateway stamps every envelope it accepts with the identity of
the socket that sent it. The `sessionId` is per connection and is the presence
key. An invalid or expired token is answered with `unauthorized` and a close
code of `4001`; the client clears its cached session and shows the access gate
instead of reconnecting forever. A denied room join is `forbidden` and is also
terminal for that socket.

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
Client catch-up currently starts from a **projected scene** rather than the
full CRDT history; §13 lists what that costs. (The persisted server snapshot
is different: it stores the full merge state, so restart recovery is exact.)

---

## 6. Persistence model (Postgres)

The implementation lives in `server/src/store/schema.sql` and is applied
idempotently on startup (or with `npm run migrate -w @syncanvas/server`).
`PostgresStore.initialize()` runs it in a transaction holding a PostgreSQL
advisory lock, so two gateways booting against a fresh database cannot race
`CREATE TABLE IF NOT EXISTS` and crash one of them.

```sql
CREATE TABLE users (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

-- One row per accepted CRDT operation. `seq` is the broadcast watermark of the
-- batch it arrived in, not a merge rule; the envelope carries the HLC and op id
-- that decide conflicts inside the CRDT.
CREATE TABLE operations (
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  op_id       text NOT NULL,
  actor_id    text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seq         bigint NOT NULL,
  hlc_wall    bigint NOT NULL,
  hlc_counter integer NOT NULL,
  envelope    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, op_id)
);

CREATE INDEX operations_document_seq_idx
  ON operations (document_id, seq, op_id);

-- Full CRDT document at a known watermark (registers, tombstones, RGA order
-- and seen ids). Loading takes the newest snapshot and replays only the
-- operations after it; the projected scene alone would not be replay-safe.
CREATE TABLE snapshots (
  id          bigserial PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX snapshots_document_seq_idx
  ON snapshots (document_id, seq DESC, id DESC);
```

**Store selection:** `STORE=auto` probes `DATABASE_URL` and uses Postgres when
reachable, otherwise the memory store; `postgres` and `memory` force a mode.
`/healthz` reports the active store, whether Redis fan-out is connected, and the
instance name. The memory store deliberately keeps the same `Store` interface,
so the gateway, HTTP API and tests are identical in both modes. Redis is also
optional and is reported separately; a gateway without it is standalone.

**Write path:** accepted batches are appended through a per-room serial queue.
In a cluster every gateway sees the same bus frames, so several instances may
insert the same operations with the same `seq`; `(document_id, op_id)` is the
idempotent guard. Writes are fire-and-forget for the socket path; shutdown
drains bus work and awaits `flush()` so a restart does not lose the last edits.

**Read path:** `doc = deserializeDoc(newest snapshot at seq M) + operations
WHERE seq > M`, merged in any order thanks to the CRDT invariant. The snapshot
carries the full merge state, so a late or replayed operation is rejected by
the same stamps and `seen` set as on the live replica. If the log was compacted,
everything at or below `M` is already represented in the snapshot. With no
snapshot (or an unreadable one) the gateway replays the remaining log over the
deterministic seed scene.

**Invites are not stored.** A share link is an HS256 token carrying
`{room, role, owner, exp}`; redeeming it calls `grant()` and persists a normal
membership. There is therefore no invite table to clean up, and a link can be
revoked only by rotating `JWT_SECRET` or by removing the resulting membership.
That is a deliberate Stage 4 tradeoff; per-link revocation belongs with later
history work.

---

## 7. Snapshots and version history

**Implemented (Stage 5):**

- Trigger: every **100 ops** or **60 s** of activity per room, both configurable
  with `SNAPSHOT_EVERY` and `SNAPSHOT_INTERVAL_MS`.
- A snapshot stores the **whole CRDT document** (`serializeDoc`): every
  register version, tombstone, RGA order entry and the `seen` id set. Storing
  only the projected scene would lose the metadata that makes late replays
  safe — a stale create could resurrect a deleted object and an old write could
  overwrite a newer value after a restart. `deserializeDoc` rebuilds the merge
  state exactly.
- The snapshot is written behind the room's serial write queue, tagged with the
  room's sequence watermark. Writing is fire-and-forget on the socket path;
  shutdown awaits `flush()`.
- **Compaction follows the snapshot in the same queue.** After a snapshot at
  sequence `M` is durable, `DELETE FROM operations WHERE document_id = ? AND
seq <= M` runs. The snapshot carries everything those rows produced, and its
  `seen` set still rejects a late resend, so deleting the rows cannot change a
  later replay. Rows after `M` remain until the next snapshot.
- Loading takes the newest snapshot and replays only operations with a higher
  `seq`. If the snapshot is missing or unreadable, the gateway falls back to the
  seed scene plus the remaining log. The merge is order-independent, so replay
  order is irrelevant.
- A load also prunes untouched records for **retired seed objects** (the old
  `demo-text` prompt). The record must still carry only `seed:*` stamps; an
  object somebody moved or edited is user data and is kept.
- Snapshots are **internal checkpoints**, not user-visible versions.
- **No leader election.** Any instance holding the room may snapshot and
  compact at its watermark. Two instances can write equivalent snapshots and
  issue the same deletion; duplicate work is harmless because snapshot rows are
  append-only and deletion is idempotent.

**Not implemented yet:**

- Named versions, restore and history browsing.
- Retention of older snapshots. They accumulate; a later job can prune all but
  the newest without affecting replay.
- Dedicated background snapshot workers. Today a room is snapshotted by the
  gateway that sees the threshold, plus a final flush on shutdown.

---

## 8. Presence, offline and reconnect

**Presence** is ephemeral and lives in each gateway's room registry. It is
keyed by the per-connection `sessionId`, not `userId`, so two tabs with the
same account do not overwrite each other. With Redis, join/update/leave frames
are also published on the room bus; every other instance stores them as
`remoteMembers` and broadcasts the merged local+remote roster. The origin
ignores its own presence echo because it already updated the local roster.

- The client sends at most one presence message per 40 ms (25 Hz, trailing
  edge) and a heartbeat every 20 s. The server forwards a peer's presence at
  most every 15 ms and clamps cursor coordinates to ±100 000 with selection
  capped at 1 000 ids.
- The client interpolates the last received cursor towards its target on
  `requestAnimationFrame`; the network rate stays low while motion looks smooth.
- The server sweeps local and remote sessions unseen for 60 s every 5 s, and
  removes a local session immediately when its socket closes. A closed tab
  therefore disappears without waiting for the TTL; a crashed gateway's remote
  cursors disappear when their heartbeats stop and the sweep reaches the TTL.
- Presence never touches Postgres and is not replayed after reconnecting.

**Offline / reconnect** in Stage 5:

1. Edits made while the socket is down stay in the client's **in-memory**
   outbox. The store still applies them locally only after the echo, so an
   offline edit is visible in the editor but pending until reconnect.
2. Reconnect sends `sync {snapshotSeq, opIds}`; the gateway replies with the
   current projection and acknowledges ids it already has. Because every
   instance can load the room from Postgres, the browser may reconnect to a
   different gateway after an instance failure.
3. Unacknowledged envelopes are re-sent and deduped by `(documentId, opId)` in
   the CRDT and by the Postgres `(document_id, op_id)` primary key.
4. A page reload discards the outbox. IndexedDB persistence and local-first
   optimistic apply are Stage 6.

Failover is reconnect-based: an in-flight WebSocket is not migrated between
processes. Nginx's passive checks stop sending new connections to a failed
instance, and `SyncClient` retries the same `?ws=` endpoint (through the same
proxy or load balancer) until it reaches a healthy gateway.

---

## 9. Scaling gateways (implemented)

Two gateways plus Redis and Nginx are a supported local deployment. No room is
pinned to a process.

- **Lazy replication.** Startup installs rooms that already exist; after that, a
  gateway loads a room on the first local `join` or the first bus frame for it.
  A browser can therefore land on any instance and still get the room. Rooms
  that no local client and no bus traffic touch stay out of memory.
- **Wildcard subscription.** Each gateway `PSUBSCRIBE`s to
  `syncanvas:room:*`, not just locally hosted rooms. That is what lets a
  gateway that has never seen a room receive a presence frame or operation and
  create its local replica. The cost is one copy of every room's traffic per
  gateway; room-level subscription would be an optimization for a larger fleet.
- **Redis owns the sequence.** The Lua script on `syncanvas:room:{id}:seq`
  raises a missing or stale counter to `floor`, `INCR`s it, substitutes the
  sequence into the payload, and `PUBLISH`es atomically. Two instances can
  never allocate the same number or publish out of allocation order, and a
  Redis restored from an older snapshot cannot reissue a sequence that is
  already in Postgres. Redis is transport, so losing it does not lose
  operations; it only stops the clustered path, and `/healthz` reports
  `bus: null`.
- **Every instance persists.** All gateways apply the same frames and append
  accepted operations to Postgres. There is no designated writer. Duplicate
  inserts are idempotent and every instance can serve a reconnect.
- **Failed applies are fail-fast.** Redis pub/sub cannot replay a frame that a
  replica failed to load or merge. Instead of continuing with a gap, that
  instance invalidates its local replica and closes its clients in the room;
  they reconnect, reload the room from Postgres and resend unacknowledged
  outbox entries.
- **No snapshot lock.** Each instance may snapshot after its own threshold. The
  snapshot is tagged with the room watermark and compaction deletes only rows
  at or below that watermark, so concurrent snapshots are safe.
- **Presence on the bus.** Roster changes are published per room and merged by
  receiving instances; presence remains memory-only and expires if an owner
  process crashes without saying goodbye.
- **Nginx.** The Compose `web` image serves the built client and proxies
  `/api/`, `/healthz` and `/ws` to both gateways with least-connections and
  passive failure detection. There is no sticky-session requirement. A failed
  socket is retried by the client and resynced against another instance.
- **Registration and local verification.** `npm run scale:up` builds the gateway
  and web images and starts Postgres, Redis, `gateway-a`, `gateway-b` and Nginx.
  `scripts/scale-smoke.mjs` runs the same topology on the host using TCP
  proxies: two browsers edit across instances, one gateway is killed, the
  client reconnects, both gateways restart, and the scene is checked again.
- **Not included yet.** Prometheus metrics, per-socket backpressure and the k6
  load test remain later work. The existing reconnect path is the backpressure
  boundary for a slow or dead instance.

---

## 10. Design decisions and tradeoffs

| Decision                                        | Why                                                                            | Cost                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Hand-rolled LWW-map + RGA + HLC instead of Yjs  | Proves CRDT knowledge; ~300 LOC core; fully fuzz-testable; no black box        | No free sub-transaction text merging; we own the tombstone/compaction edge cases         |
| Per-property LWW registers                      | Concurrent edits to different properties never conflict                        | Same-property concurrent edits lose one value (accepted for canvas props)                |
| LWW over OT/transform functions                 | Order-independent merge is trivially correct and testable                      | "Latest wins" can silently discard intent for the _same_ property                        |
| HLC over pure Lamport                           | Close to wall time → intuitive conflicts; no trusted clock needed              | Absorbs a peer's future wall clock on receipt (no clamping — §4.1)                       |
| Undo = new inverse ops                          | Reuses the merge path; works offline and across users                          | Undo is itself an edit (LWW, not isolation-preserving)                                   |
| JSON wire format first                          | Debuggable, types shared directly                                              | ~1.5× bytes vs MessagePack; revisit after load tests                                     |
| Op log + snapshots in Postgres                  | One transactional store; replay over the snapshot is order-independent         | Compaction discards old operation history; named versions need separate retention        |
| Redis pub/sub (not Streams)                     | Ops are replayable from Postgres — Redis is transport, not source of truth     | One broker is required for cross-instance fan-out; pub/sub messages are not durable      |
| Redis assigns the room-wide sequence            | All instances see one order; no duplicate watermarks and no sticky routing     | Every edit crosses Redis before ack; Redis becomes a latency dependency                  |
| Every gateway persists its own copy             | Any instance can serve a reconnect; no writer election                         | Duplicate `INSERT` work on every replica (idempotent, but not free)                      |
| Empty `ops` frame for a duplicate-only publish  | Clients keep a contiguous `seq` watermark                                      | An unusual empty batch on the wire                                                       |
| Guest-only auth (no passwords)                  | No email/verification scope, instant onboarding, no credential database        | Identity is device-scoped; clearing storage loses memberships without a link             |
| Dependency-free HS256 JWT                       | Tiny, auditable, one shared secret for access tokens and invites               | Secret rotation invalidates every session and link; no key ids/OIDC                      |
| Invite as a signed bearer capability            | No invite table, no cleanup, links work after an ephemeral-store restart       | Cannot revoke one link; only rotating the secret or removing the membership              |
| Roles enforced in the gateway, mirrored in UI   | A viewer cannot edit even with a modified client; UX still explains read-only  | Two places to keep in sync; the server remains the source of truth                       |
| Presence in memory keyed by connection          | Multi-tab safe, zero DB writes, disappears immediately on close                | Replicated over Redis but memory-only; a crashed instance leaves ghost cursors until TTL |
| Presence throttled 25 Hz + client interpolation | Cuts traffic ~40× versus pointer-move rate while looking smooth                | A receiver sees a slightly delayed final position                                        |
| Snapshot every 100 ops / 60 s + compaction      | Bounds replay and log growth without snapshotting every batch                  | Up to 100 operations replay; concurrent instances may duplicate snapshot work            |
| `STORE=auto` fallback to memory                 | Clone-and-run works without Docker/Postgres                                    | A misconfigured production gateway can silently start ephemeral; `/healthz` reports it   |
| In-memory outbox (Stage 5)                      | Reconnect replays unacked edits across a socket drop or gateway failure        | A page reload loses them; IndexedDB is Stage 6                                           |
| Delete-wins existence rule                      | No late `setProp` can resurrect a deleted object; ties are deterministic       | A create tied exactly with a delete loses; undo must be strictly later                   |
| Operation id as the final tie-break             | Even identical HLCs resolve the same way on every replica                      | Version compare is a 4-tuple, not just an HLC compare                                    |
| Explicit top/bottom origins for z-order         | Creation appends, "send to back" prepends — both have a meaning                | One extra field in every order entry                                                     |
| Gateway merges but does not choose values       | Server and clients run the same code path, so they cannot disagree             | The gateway must hold a replica of every room it serves                                  |
| No optimistic apply (Stage 5)                   | The scene is always a prefix of the replicated document — easy to reason about | Every edit waits for Redis and the echo; feels laggy on a bad link (Stage 6)             |
| Broadcast to the author before `ack`            | The author merges the same envelopes and still recognizes its undo entries     | Every edit pays one bus round trip before the client sees confirmation                   |

---

## 11. Repository layout

```
syncanvas/
├── client/                  # React + Vite + TS editor
│   ├── src/
│   │   ├── App.tsx          # Editor shell
│   │   ├── canvas/          # SVG canvas, selection overlay, peer layer, viewport maths
│   │   ├── components/      # Toolbar, properties panel, status bar, RoomPanel, AccessGate
│   │   ├── hooks/           # Keyboard shortcuts
│   │   ├── net/             # SyncClient, useSync, HTTP API, cached session
│   │   ├── store/           # Zustand store (doc, projection, undo, role gates)
│   │   └── main.tsx
│   ├── vite.config.ts
│   └── tsconfig*.json
├── server/                  # Node.js HTTP API + WebSocket gateway
│   ├── src/
│   │   ├── index.ts         # HTTP + WebSocket upgrade + graceful flush
│   │   ├── http.ts          # Guest auth, rooms, invites, CORS, /healthz
│   │   ├── gateway.ts       # Socket auth, access control, presence, bus echo, ack
│   │   ├── bus.ts           # Redis room bus, Lua sequence+publish, memory test bus
│   │   ├── auth/jwt.ts      # Dependency-free HS256 access + invite tokens
│   │   ├── rooms.ts         # Room registry, roles, presence TTL, CRDT replica
│   │   ├── persistence.ts   # Lazy load, append, snapshot, compaction, flush
│   │   ├── scaling.test.ts  # Two gateways on one shared memory bus
│   │   ├── store/           # Store interface, memory + Postgres, schema.sql
│   │   └── config.ts
│   └── tsconfig.json
├── shared/                  # Single source of truth for types + CRDT
│   ├── src/
│   │   ├── index.ts
│   │   ├── api.ts           # HTTP request/response types
│   │   ├── object.ts        # Object model
│   │   ├── operations.ts    # Op types
│   │   ├── protocol.ts      # WS messages + runtime validators
│   │   ├── geometry.ts      # Transform maths
│   │   ├── scene.ts         # Scene state + projection
│   │   ├── hlc.ts           # Hybrid logical clock
│   │   ├── initialScene.ts  # Room seed scene
│   │   └── crdt/            # LWW-map, RGA, merge + fuzz tests
│   └── tsconfig.json
├── scripts/
│   ├── browser.mjs          # Chromium resolution shared by the smoke tests
│   ├── smoke.mjs            # Single-user Playwright smoke test
│   ├── sync-smoke.mjs       # Multi-user auth/presence/role/restart smoke test
│   └── scale-smoke.mjs      # Two gateways, failover, full restart
├── deploy/
│   └── nginx.conf           # Static client + /api and /ws proxy to both gateways
├── docs/
│   └── DESIGN.md            # This document
├── Dockerfile               # Multi-stage gateway image + Nginx web image
├── docker-compose.yml       # Postgres + Redis; `scale` profile adds gateways + web
├── eslint.config.mjs
├── tsconfig.base.json
└── .github/workflows/ci.yml # lint/format/typecheck/test/build + Postgres + smoke + sync + scale
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
  through `setProp('text', …)` until the per-character RGA lands in Stage 6.
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
- The rooms lived in memory at stage 2. The document's `seen` set is the replay
  guard that stage 4 made durable as the `(document_id, op_id)` primary key in
  Postgres.

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
  of the replicated document. Local-first apply is Stage 6.
- On reconnect the client sends `sync {snapshotSeq, opIds}`; the gateway
  acknowledges the operations it already has and sends the current state, and
  the client re-sends only what is missing.
- The hybrid logical clock (`shared/src/hlc.ts`) stamps every envelope.

### 13.3 What naive LWW cost (and what stage 3 fixed)

The stage-2 merge was `applyOps` in arrival order — the last write to a
property won. That was convergent (every replica ended with the same scene) but
not conflict-free:

| Situation                                     | Stage 2 behaviour                                        | Stage 3                                                                                  |
| --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Two users drag the same rect at the same time | One drag is lost; the winner depends on arrival order    | Later version wins on every replica                                                      |
| Two users set different properties            | No conflict — the properties are independent             | Unchanged                                                                                |
| Two users create an object at the same time   | Both survive, but their z-order depends on arrival order | RGA orders them deterministically                                                        |
| A client is offline for a minute              | Its edits are lost: they never reach the gateway         | Replayed from the in-memory outbox on reconnect (Stage 5); reload-safe outbox in Stage 6 |

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
  receives afterwards, but tombstone-aware client bootstrap is a later
  refinement (the server-side persisted snapshot and compaction exist in Stage 5).
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
| `scripts/sync-smoke.mjs`              | Real browsers converge, undo travels, roles work, presence is ephemeral, and the durable scene survives a restart                                 |

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

## 15. Stage 4 — rooms, auth, presence and durability

Stage 4 turns the CRDT demo into a product: an authenticated room with a role
model, live people in it, and a scene that survives a restart.

### 15.1 Authentication

`POST /api/auth/guest` creates a user row and returns:

```json
{
  "token": "header.payload.signature",
  "user": { "id": "usr_…", "displayName": "Ada" },
  "expiresAt": 1760000000000
}
```

The token is HS256, implemented in `server/src/auth/jwt.ts` without a JWT
dependency. It has a constant header, a mandatory `exp`, a constant-time
signature comparison, and an injected clock for tests. The WebSocket sends
`auth {token}`; the gateway verifies the signature, loads the user row and
replies `welcome {userId, sessionId, displayName, color}`. A socket that has not
authenticated within 15 s is closed. Invalid/expired tokens get `unauthorized`
and close code `4001`; the client treats that as terminal and shows the access
gate rather than reconnecting in a loop. The same secret signs invite tokens,
but their `typ` claim (`access` vs `invite`) keeps them from being confused.

`POST /api/auth/profile` renames the signed-in guest and returns a fresh
`SessionResponse`; the server updates the user row and signs a new access token
with the same `sub` and a new `name`. The client persists that session and
reloads once, which reconnects the socket so peers see the new presence name.

The browser caches `{token, user, expiresAt, server}` in `localStorage`. The
token is held outside Zustand and only attached on demand. The cache is scoped
to the gateway that issued it (tokens do not travel), and an expired cache is
replaced by a fresh guest. Signing out clears the cache and navigates to a
deliberate name gate (`?signedout=1`) instead of immediately minting another
guest and re-entering the room. There is deliberately no password flow; see the
tradeoff table.

### 15.2 Rooms, membership and invites

- `POST /api/rooms` creates a `documents` row and an `owner` membership.
- `POST /api/rooms/:id/invites` mints a signed invite for `editor` or `viewer`.
  Any owner or editor may mint; a viewer gets `403`.
- `GET /api/rooms` lists the caller's memberships; `GET /api/rooms/:id` returns
  a room the caller can read.
- `authorizeJoin` checks membership first. If there is none, a valid signed
  invite for that exact room is redeemed and persisted as a membership, so a
  refresh does not need the invite again.
- A valid invite for a missing room may recreate the document. This is what
  keeps share links working after a memory-store restart. The invite's owner is
  reused if that user still exists, otherwise the joining user owns the new
  room.
- The `demo` room is intentionally public to any signed-in user, and can be
  disabled with `PUBLIC_DEMO_ROOM=`. It is the zero-friction sandbox; all other
  rooms require membership or an invite.
- The client also gates the UI (`viewer` and `checking` cannot edit) and the
  store refuses edit actions, but the server is authoritative: a viewer `ops`
  batch is rejected with `forbidden` plus the rejected `opIds`, and the batch is
  never merged or persisted.

### 15.3 Presence

The per-connection `sessionId` from `welcome` is the presence key. The registry
holds `{sessionId, userId, displayName, color, cursor, selection, joinedAt,
lastSeen}` per room. A `presence` message updates it, is clamped and rate
limited per socket, and fans out the full peer list to the room. A heartbeat
refreshes `lastSeen` without a cursor update; a 5 s sweeper removes sessions
unseen for 60 s; a socket close removes its session immediately. Presence is
never written to Postgres.

The client throttles pointer updates to 25 Hz, sends a heartbeat every 20 s, and
interpolates remote cursors on `requestAnimationFrame`. Selection highlights are
drawn from the same ephemeral message as the cursor, so they cannot outlive the
peer.

### 15.4 Persistence and restart

- `Store` abstracts `MemoryStore` and `PostgresStore`. `STORE=auto` probes
  `DATABASE_URL` and falls back to memory; `postgres` and `memory` force it.
- `RoomPersistence` loads a room from the newest snapshot (full CRDT state,
  including tombstones and register versions) plus later operations, installs it
  in the registry, appends every accepted batch through a per-room serial queue,
  and snapshots every 100 ops / 60 s. A late resend that predates the snapshot
  is rejected by the persisted `seen` set, so it cannot overwrite newer state or
  resurrect a deleted object.
- `index.ts` flushes on `SIGINT`/`SIGTERM` before exiting.
- The memory store is intentionally ephemeral. After a restart, old access
  tokens are rejected because their user row is gone — the product fails closed
  instead of admitting a stale session into a fresh store. Postgres preserves
  users, memberships, operations and snapshots, so both the scene and the owner
  role survive.
- Invites are not rows; they are bearer capabilities. Revoking one link
  individually would need an invite table or token denylist, which is a later
  addition.

### 15.5 Client flow

`useSync` bootstraps in this order:

1. Read `?ws=` / `VITE_WS_URL` and derive the HTTP base.
2. Load the cached session for that server; if missing/expired, call
   `POST /api/auth/guest`.
3. If HTTP is unreachable, fall back to local editing (the single-user product
   still works without a gateway).
4. Connect the socket, send `auth`, then `join {roomId, invite?}`.
5. On `joined`, mirror the role/room identity in the store, report presence, and
   start the heartbeat.
6. On `unauthorized` or a `forbidden` join, stop reconnecting and render the
   access gate. A dropped connection retries with backoff and resends the
   in-memory outbox after `sync`.

| Failure                    | Client behavior                                     |
| -------------------------- | --------------------------------------------------- |
| Gateway absent / HTTP down | Local fallback; status bar says local/offline       |
| Expired cached session     | Silently obtain a fresh guest                       |
| Server rejects the token   | Clear cache, show access gate, do not loop          |
| Join denied                | Access gate with the reason, no editor toolbar      |
| Viewer tries to edit       | UI disabled; store refuses; server would reject too |
| Socket drops               | Retry, resync, replay unacked outbox (same tab)     |

### 15.6 How Stage 4 is tested

| Test                                   | What it proves                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `shared/src/crdt/serialize.test.ts`    | Full CRDT snapshot round-trip, tombstones, register versions, seen ids, reject corruption |
| `server/src/auth/jwt.test.ts`          | Round-trip, tampering, expiry, wrong `typ`, constant header, injected clock               |
| `server/src/http.test.ts`              | Guest auth, room create/list/get, invite roles, 401/403/404, CORS, body limits            |
| `server/src/gateway.test.ts`           | Auth gate, membership/invite access, viewer rejection + `opIds`, presence, close          |
| `server/src/persistence.test.ts`       | Full-CRDT snapshot + later ops reload, stale resend rejection, flush on shutdown          |
| `server/src/store/postgres.test.ts`    | Real Postgres schema, users/rooms/memberships/ops/snapshots round-trip                    |
| `client/src/net/syncClient.test.ts`    | Auth/invite handshake, outbox replay, 25 Hz throttle, heartbeat, fatal errors             |
| `client/src/net/useSync.test.ts`       | Guest bootstrap, cached session, local fallback, denial/expiry                            |
| `client/src/canvas/PeerLayer.test.tsx` | Cursor interpolation, selection outlines, removal, zoom                                   |
| `client/src/store/sceneStore.test.ts`  | Viewer/checking edit guards, cursor reporting, role state                                 |
| `scripts/sync-smoke.mjs`               | Four browsers: owner/editor/viewer, Mallory denied, presence, read-only, restart          |

The Postgres integration suite runs when `TEST_DATABASE_URL` is set (CI always
sets it). The smoke test starts its own gateway on `:8099`; with Postgres it
also restarts it and checks the persisted scene and owner. With the memory store
it asserts that stale sessions fail closed and skips the durability phase.

The Stage 4 checklist:

- [x] Live cursors and selection highlights as ephemeral messages
- [x] Cursor updates throttled to 25 Hz and interpolated on the client
- [x] Guest JWT auth, room creation and share links
- [x] Server-enforced owner/editor/viewer roles
- [x] Postgres schema for users, documents, memberships, operations, snapshots
- [x] Viewer edits rejected server-side and gated in the UI
- [x] Expired and tampered tokens refused
- [x] A cursor disappears when its socket closes
- [x] No room access without a membership or signed invite
- [x] Full-CRDT snapshot + op-log replay survives a restart
- [x] A stale resend after a restart cannot overwrite or resurrect
- [x] Multi-user browser smoke test passes

---

## 16. Stage 5 — durable room log and multi-gateway fan-out

Stage 5 makes durability and scale part of the normal path rather than optional
bookkeeping. The persistence files are `server/src/bus.ts`,
`server/src/persistence.ts`, `server/src/rooms.ts`,
`server/src/gateway.ts` and the two stores.

### 16.1 Room-wide sequence and write path

A standalone gateway increments `room.seq` when it accepts a batch. A clustered
gateway sends the batch to `RedisRoomBus.publishOps(publication, floor)`:

```lua
local floor = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', KEYS[1]))
if not current or current < floor then
  redis.call('SET', KEYS[1], tostring(floor))
end
local seq = redis.call('INCR', KEYS[1])
local payload = string.gsub(ARGV[2], ARGV[3], tostring(seq), 1)
redis.call('PUBLISH', KEYS[2], payload)
return seq
```

`floor` is the origin replica's current watermark. A missing key is seeded and
a stale counter is raised, so a gateway that restarted with a newer snapshot
cannot move the allocator backwards; `INCR` remains the allocator afterwards.
`ARGV[3]` is a per-call marker that occupies the `seq` slot, so user-controlled
ids cannot be mistaken for it. The same script publishes the payload, so no
other gateway can allocate or publish between the increment and the message.

The origin does not merge before publishing. It filters ids already present in
its replica only to avoid publishing a pure resend. When the Redis echo arrives,
the room is loaded if necessary and `registry.applyOps(roomId, ops, seq)`
merges only the new envelopes and advances `room.seq` to at least the bus
sequence. `persistence.append()` receives that same `seq`. Every other gateway
does the same, so the Postgres rows for a batch agree on `seq` regardless of
which process wrote them. `(document_id, op_id)` makes those writes idempotent.

The origin broadcasts the accepted envelopes before `ack`; `SyncClient` uses
the still-pending outbox ids to label the echo `mine`, which drives undo
bookkeeping. If a replica cannot apply a bus frame (for example the store is
unavailable), it marks the local room stale and closes its clients there with
code `1011`. They reconnect, reload the room and resend unacknowledged outbox
entries instead of continuing from a replica that missed a sequence.

### 16.2 Snapshot-plus-replay and compaction

`readRoomState()` takes `latestSnapshot(documentId)`, deserializes the full CRDT
document, then calls `loadOperations(documentId, snapshot.seq)`. The watermark
is `max(latestSeq, snapshot.seq)` so an empty compacted log still reports the
correct sequence. `loadRooms()` installs every persisted document at startup;
`loadRoom()` does the same lazily through a per-registry single-flight map, so
concurrent joins share a load and existing members survive the install. If a
snapshot and compaction land on another instance while a load is between its
snapshot and log reads, `readRoomState()` notices the newer snapshot and
repeats from it rather than accepting a hole in the log.

The snapshot and its compaction run in the **same per-room write queue**:

1. `snapshot()` captures `room.seq`, serializes `room.doc`, and enqueues the
   snapshot write.
2. After the snapshot is durable, `compactOperations(roomId, seq)` deletes only
   rows with `seq <= captured`.
3. Operations appended after the capture are queued after the snapshot and stay
   in the log for the next one.

Because the snapshot contains the registers, tombstones, RGA order and `seen`
ids, replaying it is equivalent to replaying the full log. A late resend after
compaction is rejected by the snapshot's `seen` set. The Postgres and memory
stores implement the same contract; tests assert that snapshot+replay equals
full-log replay before and after compaction.

### 16.3 Multi-gateway lifecycle

- **Bus connection precedes replay.** `index.ts` connects Redis before
  `loadRooms()`. Frames that arrive before the WebSocket handler subscribes are
  buffered by the bus (bounded at 1 000), then applied in order. Replaying one
  twice is harmless.
- **Lazy installs.** A remote gateway creates a placeholder room only for
  presence or a bus frame; `loadRoom()` replaces it with the persisted document
  while preserving local and remote members.
- **Presence fan-out.** Join, heartbeat and leave publish `presence` frames.
  The origin ignores its own echo and updates local state directly; receivers
  add/remove `remoteMembers` and rebroadcast the merged roster with normalized
  `lastSeen`. Remote ghosts expire through the normal sweep.
- **Duplicate-only publications.** If every envelope is already present by the
  time the echo reaches a gateway, it broadcasts `ops: []` at that sequence.
  Clients advance their watermark and emit no CRDT change, so a consumed
  global sequence cannot stall the next batch. As a backstop for a client that
  joins after such a sequence was consumed but not persisted, the client waits
  one second for a missing frame and then requests full state instead of
  buffering forever.
- **Shutdown.** Close sockets and the HTTP server, drain queued bus work, stop
  the Redis subscriber, drain once more, flush every room's operation log and
  snapshot/compaction queue, then close the store.
- **Standalone mode.** Without a reachable Redis, `createRoomBus()` logs and
  returns `null`; the gateway uses the local sequence path and `/healthz` shows
  `bus: null`. This keeps one-command development and single-instance
  deployments complete, but it is not a cluster.

### 16.4 Deployment and scale test

`Dockerfile` has a shared build stage and two runtimes: a Node gateway with the
server and shared builds, and an Nginx image serving `client/dist`. The
`deploy/nginx.conf` upstream uses least-connections, passive `max_fails`, and a
long-lived WebSocket upgrade path. Compose runs `gateway-a` and `gateway-b`
against the same Postgres and Redis, exposes them on `8101`/`8102` for health
inspection, and serves the application through Nginx on `8080`. No sticky
sessions are configured.

`server/src/scaling.test.ts` gives two real gateway endpoints different
instance ids on one `MemoryRoomBusHub`. It proves cross-instance edits,
presence, one globally agreed sequence, and snapshot+replay equality after
compaction. `scripts/scale-smoke.mjs` is the browser-level test: two gateways,
two TCP proxies with health-based failover, two browser contexts, an edit each
way, kill/gateway reconnect, full restart from Postgres, and a final cross-
instance edit. CI runs it with Postgres and Redis services.

### 16.5 Stage 5 checklist

- [x] Accepted operations append to Postgres on every gateway
- [x] Room-wide sequence allocated and published atomically in Redis
- [x] Every gateway applies the echo in bus order, including the origin
- [x] Snapshot plus later-operation replay loads a room
- [x] Snapshot writes compact covered operation rows
- [x] Snapshot+replay equals full-log replay after compaction
- [x] Presence crosses instances
- [x] Killing a gateway lets its client reconnect to the survivor
- [x] Restarting all gateways restores the document
- [x] Two gateways run behind Nginx in Compose

---

## 17. Roadmap

| Stage    | Milestone                                                     | Exit criterion                            |
| -------- | ------------------------------------------------------------- | ----------------------------------------- |
| 0        | Monorepo, compose, CI, design doc, shared types               | CI green; compose healthy                 |
| 1        | Canvas, transform maths, operation pipeline, undo/redo        | 500 objects at 60 fps; ops only           |
| 2        | WS gateway, naive LWW sync                                    | Two browsers move a rect live             |
| 3 (done) | HLC, LWW-map, RGA z-order, tombstones, convergence fuzz tests | 10 000 randomized schedules converge      |
| 4 (done) | Presence, rooms, JWT auth, roles, Postgres log + snapshots    | 4-browser smoke; restart-safe             |
| 5 (done) | Redis fan-out, compaction, Nginx, failover smoke              | 2 gateways; kill/restart-safe             |
| 6        | IndexedDB outbox, optimistic apply, text RGA, version restore | Reload-safe offline edits; text converges |
| 7        | k6 load tests, metrics, AWS deploy, CD, public demo           | p95 < 80 ms @ 200; live URL               |
