# Syncanvas

Real-time collaborative scene editor — a "Figma-lite" multiplayer canvas where
several people place, move, transform and style objects at once, with live
cursors, selection highlights and access-controlled rooms. The merge logic
(LWW-map CRDT + RGA + hybrid logical clocks) is implemented from scratch, not
wrapped around Yjs.

**Status: Stage 4 — a usable multi-user product.** Guests sign in without a
password, create rooms, and share editor or viewer links. The gateway
authenticates every socket, enforces roles, fans out ephemeral presence, and
persists accepted operations to Postgres. A room survives a gateway restart;
a viewer cannot edit on the server even if the client UI is bypassed.

## Progress

| Stage | Scope                                             | Status |
| ----- | ------------------------------------------------- | ------ |
| 0     | Monorepo, compose, CI, design doc                 | ✅     |
| 1     | Canvas, transform maths, op pipeline              | ✅     |
| 2     | WebSocket gateway, naive LWW sync                 | ✅     |
| 3     | CRDT core (LWW-map, RGA, tombstones), fuzz        | ✅     |
| 4     | Presence, rooms, guest auth, roles, Postgres      | ✅     |
| 5     | Durable offline outbox, text RGA, version restore | ⬜     |
| 6     | Redis fan-out, Docker deploy, load tests          | ⬜     |

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
- [x] Durable rooms: the latest snapshot plus later operations survive a restart

Stage 1–3 remain complete: the canvas has rect/ellipse/line/text, drag, resize,
rotate and z-order; every edit is an operation; the gateway and every client
merge through the same CRDT; 10,000 randomized delivery schedules converge.

## How it works

```
pointer event ──► canvas ──► store ──► outbox ──► gateway ──► room.mergeEnvelopes()
                       ▲                                │
                       └────── echo (same envelopes) ◄──┘
```

- **Every edit is an operation.** A gesture becomes a `createObject`,
  `deleteObject` or one or more `setProp` operations.
- **Conflicts resolve by version, not arrival order.** Each envelope carries an
  HLC and an operation id; the LWW register picks the maximum
  `(wall, counter, actorId, opId)`. The z-order is an RGA.
- **The gateway is a relay and a replica.** It merges the same code path as the
  browser, assigns a broadcast watermark (`seq`) and fans the batch out to the
  author as well.
- **No optimistic apply.** In live mode the author waits for the echo, so the
  rendered scene is always a prefix of the replicated document. Local-first
  apply is Stage 5.
- **Reconnects are catch-up, not replay of history.** A client sends
  `sync {snapshotSeq, opIds}`; the gateway acknowledges what it already has and
  sends the current projection plus later operations. Unacknowledged outbox
  entries are re-sent (deduped by operation id).

See [docs/DESIGN.md](docs/DESIGN.md) for the CRDT semantics, protocol, schema,
presence model and tradeoffs.

## Rooms, auth and roles

There are no passwords. `POST /api/auth/guest` mints a short-lived identity and
an access token in one step; the browser caches it for the gateway that issued
it. An access token is required before the WebSocket accepts `join`.

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
  identity (email/OAuth) is not part of Stage 4.

### HTTP API

| Method | Path                     | Purpose                             |
| ------ | ------------------------ | ----------------------------------- |
| `POST` | `/api/auth/guest`        | Create a guest session              |
| `POST` | `/api/rooms`             | Create a room and its owner         |
| `GET`  | `/api/rooms`             | List the caller's rooms             |
| `GET`  | `/api/rooms/:id`         | Fetch a room if the caller can read |
| `POST` | `/api/rooms/:id/invites` | Mint an editor/viewer link          |
| `GET`  | `/healthz`               | Health and the active store kind    |

The API uses Bearer auth and CORS, rejects bodies over 64 KiB, and returns JSON
errors with stable codes.

## Presence

Presence is ephemeral and keyed by the **per-connection session id**, so two
tabs with the same user do not collide. The client throttles updates to 25 Hz
(40 ms trailing edge), sends a 20 s heartbeat, and interpolates peer cursors on
`requestAnimationFrame`. The server forwards presence at most every 15 ms,
clamps cursor coordinates to ±100 000, caps selections at 1 000 ids, and drops
stale sessions after 60 s (swept every 5 s). Disconnects remove the session
immediately. Nothing in this path touches Postgres.

## Persistence

The gateway chooses a store at startup: `STORE=auto` uses Postgres when
`DATABASE_URL` is reachable and falls back to the in-memory store; `STORE=memory`
and `STORE=postgres` force one. The health endpoint reports which one is active.

```sql
users(id, display_name, created_at)
documents(id, name, owner_id, created_at)
memberships(document_id, user_id, role, created_at)
operations(document_id, op_id, actor_id, seq, hlc_wall, hlc_counter, envelope, created_at)
snapshots(id, document_id, seq, state, created_at)
```

- Accepted operation envelopes are appended with a per-room serial write queue.
- A snapshot is written every 100 operations or 60 s of activity. It stores the
  **full CRDT document** — registers, tombstones, RGA order and seen operation
  ids — not just the visible scene.
- Loading a room takes the newest snapshot and replays only the operations after
  its `seq`; if there is no snapshot, it replays the log over the seed scene.
  The CRDT merge makes replay order-independent, and the persisted `seen` set
  makes a late resend a no-op instead of an overwrite.
- Shutdown flushes pending writes before releasing the pool.
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
- `server/src/gateway.ts` — socket auth, access control, presence, operation
  admission, viewer rejection and auth-failure close.
- `server/src/store/` — `Store` interface, memory and Postgres implementations.
- `server/src/persistence.ts` — room loading, snapshots, write queues, flush.

## Getting started

Prerequisites: Node.js ≥ 22, npm ≥ 10, Docker with Compose.

```bash
npm install
docker compose up -d        # Postgres :5432 (Redis is reserved for Stage 6)
cp .env.example .env
npm run dev                 # shared (tsc watch) + server :8080 + client :5173
```

`JWT_SECRET` must be changed before exposing the gateway. If Postgres is not
running, the gateway logs the fallback and uses the memory store.

Verify:

```bash
npm run check               # lint + format + typecheck + all tests
npm run smoke               # single-user browser checks (client server running)
npm run smoke:sync          # four-browser multi-user checks (starts the gateway)
curl http://localhost:8080/healthz
```

`smoke:sync` starts its own gateway on `:8099` but expects the client on
`:5173`. It prints the store it found. With Postgres it also checks that the
scene and owner survive a gateway restart; with the memory store it verifies
that the old sessions fail closed and skips the durability phase.

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
| `name`    | Display name                                                 | a random guest name      |
| `invite`  | Signed editor/viewer capability, normally supplied by a link | —                        |

`VITE_WS_URL` sets the default gateway for a deployment. If the HTTP API is
unreachable, the editor falls back to a local canvas so the single-user product
still works; the status bar shows the local/offline state.

## What Stage 4 does not do yet

- **One gateway process.** Redis pub/sub is reserved for cross-instance fan-out
  in Stage 6; the current gateway holds each room's replica in memory.
- **Durable offline editing.** A dropped socket keeps the in-memory outbox and
  replays it on reconnect, but a page reload loses unacknowledged edits. An
  IndexedDB outbox is Stage 5.
- **No optimistic apply.** The author still waits for the echo; local-first
  apply is Stage 5.
- **No text RGA.** `editText` is validated and acknowledged, but text is still a
  whole-string LWW register. Per-character merging is Stage 5.
- **Snapshots are internal, not named versions.** Restore/history is Stage 5.
- **A joining client receives the projected scene, not full CRDT history.**
  That is sufficient for the operations it receives afterwards; tombstone-aware
  client state transfer is a later refinement.
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
| `npm run check`                        | Everything CI runs                                 |
| `npm run migrate -w @syncanvas/server` | Apply the Postgres schema explicitly               |
| `docker compose up -d`                 | Local Postgres + Redis                             |

CI runs the Postgres integration suite and the multi-user smoke against a
Postgres service, so the durable path is exercised on every push.

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
scripts/  single-user and multi-user browser smoke tests
docs/     DESIGN.md — architecture, CRDT, schema, presence, tradeoffs
```

## Roadmap

- **Stage 4 (done):** guest JWT auth, rooms and share links, server-enforced
  roles, live cursors/selection, Postgres operation log and snapshots.
- **Stage 5:** durable IndexedDB outbox, optimistic local apply, per-character
  text RGA, named versions and restore.
- **Stage 6:** Redis pub/sub fan-out across gateways, Dockerfiles, AWS deploy,
  CD, load tests and a public demo.
