# Syncanvas

Real-time collaborative scene editor — a "Figma-lite" multiplayer canvas where
several people place, move, transform and style objects at once, with live
cursors, selection highlights and access-controlled rooms. The merge logic
(LWW-map CRDT + RGA + hybrid logical clocks) is implemented from scratch, not
wrapped around Yjs.

**Status: Stage 5 — durable, horizontally scaled collaboration.** Guests sign
in without a password, create rooms, and share editor or viewer links. The
gateway authenticates every socket, enforces roles, fans out ephemeral presence,
and persists accepted operations to Postgres. Rooms load from the newest
full-CRDT snapshot plus the operations after it, and covered log rows are
compacted. Two or more gateways share rooms through Redis pub/sub: Redis assigns
the room-wide sequence and publishes each accepted batch, every gateway applies
that order, and Nginx balances browsers across instances. A client can lose its
gateway and reconnect to another without losing the scene; restarting every
gateway restores the room from Postgres.

## Progress

| Stage | Scope                                            | Status |
| ----- | ------------------------------------------------ | ------ |
| 0     | Monorepo, compose, CI, design doc                | ✅     |
| 1     | Canvas, transform maths, op pipeline             | ✅     |
| 2     | WebSocket gateway, naive LWW sync                | ✅     |
| 3     | CRDT core (LWW-map, RGA, tombstones), fuzz       | ✅     |
| 4     | Presence, rooms, guest auth, roles, Postgres     | ✅     |
| 5     | Redis fan-out, snapshot compaction, 2+ gateways  | ✅     |
| 6     | Offline outbox, optimistic apply, text RGA, load | ⬜     |

## Stage 4 checklist

- [x] Live cursors and selection highlights as ephemeral messages
- [x] Cursor updates throttled to ~25 Hz on the client; peer cursors interpolated
- [x] Guest JWT auth, room creation and share links
- [x] Server-enforced `owner` / `editor` / `viewer` roles
- [x] Postgres schema for users, documents, memberships, operations, snapshots
- [x] Viewer edits rejected server-side; the UI is read-only too
- [x] Expired and tampered tokens refused
- [x] A cursor disappears as soon as its socket closes
- [x] No access to a real room without membership or a signed link
- [x] Guests can choose or change their display name, and signing out leaves the room
- [x] Durable rooms: the latest snapshot plus later operations survive a restart

## Stage 5 checklist

- [x] Accepted operations append to the Postgres log on every gateway
- [x] Periodic full-CRDT snapshots, tagged with the room-wide `seq`
- [x] Operation-log compaction below the newest snapshot
- [x] Rooms load from the newest snapshot and replay only later operations
- [x] Redis assigns a room-wide sequence and publishes batches atomically
- [x] Every gateway applies bus messages in the same global order, including
      its own echo
- [x] Cross-instance presence, not just document edits
- [x] Lazy room loading on first join or first bus activity
- [x] Two gateways behind Nginx, with client reconnect after one is killed
- [x] Restarting both gateways restores the same scene from Postgres

Stage 1–3 remain complete: the canvas has rect/ellipse/line/text, drag, resize,
rotate and z-order; every edit is an operation; the gateway and every client
merge through the same CRDT; 10,000 randomized delivery schedules converge.

## How it works

```
pointer event ──► canvas ──► store ──► outbox ──► gateway ──► Redis seq + publish
                                                         │
                          every gateway merges the echo ─┘
                          and broadcasts to its clients
```

- **Every edit is an operation.** A gesture becomes a `createObject`,
  `deleteObject` or one or more `setProp` operations.
- **Conflicts resolve by version, not arrival order.** Each envelope carries an
  HLC and an operation id; the LWW register picks the maximum
  `(wall, counter, actorId, opId)`. The z-order is an RGA.
- **Redis is the ordering point for the wire, not the merge.** A Lua script
  allocates the next room-wide `seq` and publishes the batch in one atomic
  operation. Every gateway, including the author's, applies the same bus order;
  the CRDT still decides conflicting values. This removes the race where two
  instances allocate sequence numbers separately.
- **Every gateway is a replica and a writer.** A gateway appends every accepted
  batch it sees to Postgres. The `(document_id, op_id)` key makes the duplicate
  writes from multiple instances idempotent.
- **No optimistic apply.** In live mode the author waits for the echo, so the
  rendered scene is always a prefix of the replicated document. Local-first
  apply remains Stage 6 work.
- **Reconnects are catch-up, not replay of history.** A client sends
  `sync {snapshotSeq, opIds}`; the gateway acknowledges what it already has and
  sends the current projection plus later operations. Unacknowledged outbox
  entries are re-sent (deduped by operation id). A reconnect can land on any
  instance because every instance can load the room from Postgres.

See [docs/DESIGN.md](docs/DESIGN.md) for the CRDT semantics, protocol, schema,
presence model and tradeoffs.

## Rooms, auth and roles

There are no passwords. `POST /api/auth/guest` mints a short-lived identity and
an access token in one step; the browser caches it for the gateway that issued
it. An access token is required before the WebSocket accepts `join`. Guests can
set their display name while signing in or change it later by clicking their
name in the room header (`POST /api/auth/profile`). Signing out clears the
session and leaves the room; it returns to a name gate instead of silently
creating another guest in the same room.

| Role     | Read | Edit | Mint share links |
| -------- | :--: | :--: | :--------------: |
| `owner`  |  ✅  |  ✅  |        ✅        |
| `editor` |  ✅  |  ✅  |        ✅        |
| `viewer` |  ✅  |  ❌  |        ❌        |

- **Real rooms** require a membership row or a valid signed invite for that
  room. The gateway is authoritative; a viewer's operation batch is rejected
  with `forbidden` and the rejected `opIds`, and the client drops them.
- **Invites** are bearer capabilities (`editor` or `viewer`) with their own
  expiry. Redeeming one persists a membership so reconnects and refreshes keep
  working. A valid invite can bootstrap a missing room; this keeps share links
  useful after an ephemeral-store restart.
- **`demo`** is deliberately public: any signed-in guest can read and edit it.
  Set `PUBLIC_DEMO_ROOM=` to disable it.
- A guest identity is device-scoped. Clearing browser storage creates a new
  guest; memberships are lost, but a share link still gets you back in. Durable
  identity (email/OAuth) is not part of the current product.

### HTTP API

| Method | Path                     | Purpose                             |
| ------ | ------------------------ | ----------------------------------- |
| `POST` | `/api/auth/guest`        | Create a guest session              |
| `POST` | `/api/auth/profile`      | Rename the signed-in guest          |
| `POST` | `/api/rooms`             | Create a room and its owner         |
| `GET`  | `/api/rooms`             | List the caller's rooms             |
| `GET`  | `/api/rooms/:id`         | Fetch a room if the caller can read |
| `POST` | `/api/rooms/:id/invites` | Mint an editor/viewer link          |
| `GET`  | `/healthz`               | Store, bus kind and instance id     |

The API uses Bearer auth and CORS, rejects bodies over 64 KiB, and returns JSON
errors with stable codes.

## Presence

Presence is ephemeral and keyed by the **per-connection session id**, so two
tabs with the same user do not collide. The client throttles updates to 25 Hz
(40 ms trailing edge), sends a 20 s heartbeat, and interpolates peer cursors on
`requestAnimationFrame`. The server forwards presence at most every 15 ms,
clamps cursor coordinates to ±100 000, caps selections at 1 000 ids, and drops
stale sessions after 60 s (swept every 5 s). Disconnects remove the session
immediately. With Redis, the same presence frames are published on the room bus,
so a gateway merges local members with members owned by other instances and
sends one roster to each client. Presence still never touches Postgres.

## Persistence

The gateway chooses a store at startup: `STORE=auto` uses Postgres when
`DATABASE_URL` is reachable and falls back to the in-memory store; `STORE=memory`
and `STORE=postgres` force one. The health endpoint reports the active store,
whether Redis fan-out is connected, and this instance's bus name.

```sql
users(id, display_name, created_at)
documents(id, name, owner_id, created_at)
memberships(document_id, user_id, role, created_at)
operations(document_id, op_id, actor_id, seq, hlc_wall, hlc_counter, envelope, created_at)
snapshots(id, document_id, seq, state, created_at)
```

- Accepted operation envelopes are appended with a per-room serial write queue.
  In a clustered deployment every gateway receives the same bus frames, so
  several instances may append the same row; the primary key makes it a no-op.
- A snapshot is written every **100 operations** or **60 s** of activity (both
  configurable). It stores the **full CRDT document** — registers, tombstones,
  RGA order and seen operation ids — not just the visible scene.
- After a snapshot is durably written, operations with `seq <= snapshot.seq` are
  deleted. The snapshot carries the state those rows produced, so compaction
  cannot change a later replay. Rows after the watermark remain until the next
  snapshot.
- Loading a room takes the newest snapshot and replays only the operations after
  its `seq`; if there is no snapshot, it replays the log over the seed scene.
  The CRDT merge makes replay order-independent, and the persisted `seen` set
  makes a late resend a no-op instead of an overwrite.
- Rooms load lazily on first join or first bus activity on an instance, so a
  gateway does not need a full copy of every room up front. Startup still
  installs the rooms that already exist, which keeps single-instance boot
  behavior unchanged.
- Shutdown drains bus work, stops the bus subscriber, flushes pending operations
  and snapshots, then releases the store pool.
- `npm run migrate -w @syncanvas/server` applies the idempotent schema; the
  gateway also applies it on startup.
- The memory store is for development and tests. It is intentionally ephemeral:
  a restart loses users, rooms and operations, and old access tokens are
  rejected rather than admitted into a fresh store.

## Where things live

- `shared/src/crdt/` — LWW register, RGA z-order, delete-wins document merge.
- `shared/src/geometry.ts` — rotation, resize-around-anchor, hit-testing.
- `shared/src/protocol.ts` — wire types and strict runtime validation.
- `shared/src/api.ts` — HTTP request/response types.
- `client/src/store/sceneStore.ts` — CRDT document, projection, undo/redo,
  access/role gates and cursor reporting.
- `client/src/net/syncClient.ts` — auth handshake, outbox, presence throttle,
  heartbeat, reconnect and resync.
- `client/src/net/useSync.ts` — guest bootstrap, room join, invite redemption,
  local fallback and fatal-access handling.
- `client/src/canvas/PeerLayer.tsx` — interpolated peer cursors and selection
  outlines.
- `client/src/components/RoomPanel.tsx` — room/role UI, share links, sign out.
- `server/src/auth/jwt.ts` — dependency-free HS256 access and invite tokens.
- `server/src/http.ts` — guest auth, rooms, invites, CORS, health.
- `server/src/bus.ts` — Redis room bus: atomic sequence+publish, presence
  fan-out, in-process bus used by tests.
- `server/src/gateway.ts` — socket auth, access control, presence, operation
  admission, viewer rejection, bus echo application and ack ordering.
- `server/src/store/` — `Store` interface, memory and Postgres implementations.
- `server/src/persistence.ts` — lazy room loading, snapshots, compaction, write
  queues, flush.
- `scripts/scale-smoke.mjs` — two gateways behind failover proxies.
- `deploy/nginx.conf`, `Dockerfile`, `docker-compose.yml` — local scaled
  deployment (two gateways plus Nginx).

## Getting started

Prerequisites: Node.js ≥ 22, npm ≥ 10, Docker with Compose.

```bash
npm install
docker compose up -d        # Postgres :5432 and Redis :6379
cp .env.example .env
npm run dev                 # shared (tsc watch) + server :8080 + client :5173
```

`JWT_SECRET` must be changed before exposing the gateway. If Postgres is not
running, the gateway logs the fallback and uses the memory store. Redis is
optional: without `REDIS_URL` one gateway still runs as a complete standalone
deployment. `/healthz` reports `bus: "redis"` and the `instance` name when the
cluster bus is active.

Verify:

```bash
npm run check               # lint + format + typecheck + all tests
npm run smoke               # single-user browser checks (client server running)
npm run smoke:sync          # four-browser multi-user checks (starts the gateway)
npm run smoke:scale         # two gateways, Redis, failover and full restart
curl http://localhost:8080/healthz
```

`smoke:sync` starts its own gateway on `:8099` but expects the client on
`:5173`. It prints the store it found. With Postgres it also checks that the
scene and owner survive a gateway restart; with the memory store it verifies
that the old sessions fail closed and skips the durability phase.

`smoke:scale` expects Postgres and Redis on their default ports, a built
workspace, and the client preview on `:4173`. It starts two gateways itself and
puts a health-checking TCP proxy in front of each, which is enough to exercise
the same failover behavior as Nginx. It kills one gateway mid-session, checks
that the client reconnects to the survivor with the scene intact, then restarts
both gateways and checks the room again.

### Run two gateways behind Nginx

The `scale` Compose profile builds one gateway image and one web image, starts
two gateways against the same Postgres and Redis, and puts Nginx on `:8080`:

```bash
JWT_SECRET=replace-me npm run scale:up
# then open http://localhost:8080/?room=demo&name=Ada
```

- Nginx serves the built client and proxies `/api/`, `/healthz` and `/ws` to
  `gateway-a:8080` / `gateway-b:8080` (least-connections, passive failover).
- The gateways are also exposed directly on `:8101` and `:8102` for debugging.
  Their health payloads include the instance name and bus kind:

  ```bash
  curl http://localhost:8101/healthz
  # {"status":"ok", ..., "store":"postgres", "bus":"redis", "instance":"gateway-a"}
  ```

- Stop one gateway while editing to see failover:

  ```bash
  docker compose --profile scale stop gateway-a
  ```

  Its browser sockets close, clients reconnect through Nginx to `gateway-b`,
  and the room state comes from Postgres. Restart it with
  `docker compose --profile scale start gateway-a`.

- `npm run scale:down` stops the profile services; add `-v` if you also want to
  delete the Postgres/Redis volumes.

The default `JWT_SECRET` in Compose is development-only. Set a real one before
exposing the deployment, and terminate TLS in front of Nginx for `wss://`.

The Postgres integration tests are enabled by:

```bash
TEST_DATABASE_URL=postgres://syncanvas:syncanvas@localhost:5432/syncanvas_test \
  npm run test -w @syncanvas/server
```

### Trying it with two people

The public sandbox needs no link:

```
http://localhost:5173/?room=demo&name=Ada
http://localhost:5173/?room=demo&name=Bob
```

For a real room, create one in the room panel ("New room"), then copy the
**editor** or **viewer** link. Opening the link signs the new guest in and
redeems the invite:

```
http://localhost:5173/?room=room_…&ws=ws://localhost:8080/ws&name=Ada&invite=…
```

| Parameter | Meaning                                                      | Default                  |
| --------- | ------------------------------------------------------------ | ------------------------ |
| `room`    | The room to join                                             | `demo`                   |
| `ws`      | Where the gateway lives                                      | `ws://localhost:8080/ws` |
| `name`    | Initial display name (editable in the room header)           | a random guest name      |
| `invite`  | Signed editor/viewer capability, normally supplied by a link | —                        |

`VITE_WS_URL` sets the default gateway for a deployment. If the HTTP API is
unreachable, the editor falls back to a local canvas so the single-user product
still works; the status bar shows the local/offline state.

## What Stage 5 does not do yet

- **Durable offline editing.** A dropped socket keeps the in-memory outbox and
  replays it on reconnect, but a page reload loses unacknowledged edits. An
  IndexedDB outbox and local-first optimistic apply remain Stage 6 work.
- **No optimistic apply.** The author still waits for the echo; local-first
  apply is Stage 6.
- **No text RGA.** `editText` is validated and acknowledged, but text is still a
  whole-string LWW register. Per-character merging is Stage 6.
- **Snapshots are internal, not named versions.** Restore and history browsing
  are later work.
- **A joining client receives the projected scene, not full CRDT history.**
  That is sufficient for the operations it receives afterwards; tombstone-aware
  client state transfer is a later refinement.
- **Redis is transport, not durability.** If Redis is unreachable at startup
  the gateway logs it and runs standalone; `/healthz` makes that visible instead
  of pretending it is clustered. Operation data always lives in Postgres.
- **Failover is reconnect-based.** Existing WebSocket connections do not migrate
  between gateways; the browser reconnects and resyncs. Nginx routes the new
  connection to a healthy instance.
- **Snapshots are not leader-elected.** Any gateway that has the room may write
  a full snapshot at its watermark and compact covered rows. Duplicate snapshots
  are harmless but do a little redundant work.
- **Guest identity is not durable across devices.** There are no passwords,
  email verification or OAuth yet.

## Scripts

| Script                                 | What it does                                       |
| -------------------------------------- | -------------------------------------------------- |
| `npm run dev`                          | Build shared, then run all three packages in watch |
| `npm run build`                        | Production build of shared → server → client       |
| `npm run lint`                         | ESLint across the workspace                        |
| `npm run format:check`                 | Prettier check (CI) / `npm run format` to fix      |
| `npm run typecheck`                    | `tsc --noEmit` for server + client                 |
| `npm run test`                         | Vitest across workspaces                           |
| `npm run smoke`                        | Playwright single-user smoke test                  |
| `npm run smoke:sync`                   | Multi-user auth/presence/role/restart test         |
| `npm run smoke:scale`                  | Two gateways, failover and full-restart test       |
| `npm run scale:up`                     | Build/start two gateways + Nginx (Compose profile) |
| `npm run scale:down`                   | Stop the scaled Compose services                   |
| `npm run check`                        | Everything CI runs                                 |
| `npm run migrate -w @syncanvas/server` | Apply the Postgres schema explicitly               |
| `docker compose up -d`                 | Local Postgres + Redis                             |

CI runs the Postgres integration suite, the multi-user smoke and the two-gateway
scale/failover smoke against Postgres and Redis services, so both the durable
and clustered paths are exercised on every push.

## Keyboard shortcuts

| Key                       | Action                                         |
| ------------------------- | ---------------------------------------------- |
| `V` `R` `O` `L` `T`       | Select / rect / ellipse / line / text          |
| Drag                      | Move                                           |
| Corner handles            | Resize (shift = keep ratio, alt = from centre) |
| Handle above the box      | Rotate (shift = 15° steps)                     |
| Shift-click               | Multi-select                                   |
| Arrows                    | Nudge (shift = 10 px)                          |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo                                    |
| `Delete`                  | Delete the selection                           |
| Scroll / space-drag       | Zoom / pan                                     |

## Layout

```
shared/   object model, geometry, ops, scene, protocol, HLC, CRDT, HTTP types
server/   HTTP API, auth, gateway, presence, room registry, store, persistence
client/   React + Vite editor: canvas, store, sync client, room/access UI
scripts/  single-user, multi-user and scale/failover browser smoke tests
deploy/   Nginx config for two gateways behind one origin
docs/     DESIGN.md — architecture, CRDT, schema, presence, tradeoffs
```

## Roadmap

- **Stage 4 (done):** guest JWT auth, rooms and share links, server-enforced
  roles, live cursors/selection, Postgres operation log and snapshots.
- **Stage 5 (done):** snapshot compaction, Redis room bus, cross-instance
  presence, two gateways behind Nginx, failover and full-restart smoke.
- **Stage 6:** durable IndexedDB outbox, optimistic local apply, per-character
  text RGA, named versions and restore.
- **Stage 7:** k6 load tests, metrics, AWS deploy, CD and a public demo.
