# Syncanvas

Real-time collaborative scene editor — a "Figma-lite" multiplayer canvas where
several people place, move, transform and style objects at once, with live
cursors, offline editing and version history. The merge logic (LWW-map CRDT +
RGA + hybrid logical clocks) is implemented from scratch, not wrapped around
Yjs.

**Status: Stage 2 — the gateway and the naive LWW sync.** The editor renders
rectangles, ellipses, lines and text; supports select, drag, resize, rotate and
z-order; expresses every edit as an operation; and now talks to a Node.js
WebSocket gateway, so two people can edit the same canvas at the same time.
The merge is deliberately naive — operations are ordered by the server and the
last write wins — which is exactly the limitation stage 3's CRDT removes.
See [docs/DESIGN.md](docs/DESIGN.md) for the full technical design (data model,
wire protocol, CRDT approach, scaling plan).

## Progress

| Stage | Scope                                   | Status |
| ----- | --------------------------------------- | ------ |
| 0     | Monorepo, compose, CI, design doc       | ✅     |
| 1     | Canvas, transform maths, op pipeline    | ✅     |
| 2     | WebSocket gateway, naive LWW sync       | ✅     |
| 3     | CRDT core (RGA, tombstones), fuzz tests | ⬜     |
| 4     | Redis pub/sub, Postgres log, JWT rooms  | ⬜     |
| 5     | Offline outbox, undo/redo, version log  | ⬜     |
| 6     | Load tests, Docker, AWS deploy, README  | ⬜     |

## Stage 1 checklist

- [x] Render rectangles, ellipses, lines and text (SVG canvas)
- [x] Select, drag, resize, rotate and change z-order
- [x] Local state store (Zustand)
- [x] Every edit expressed as an operation (`setProp`, `createObject`, …)
- [x] Unit tests for the transform maths (rotate/resize around the centre, hit-testing)
- [x] Applying the same operation sequence twice yields identical state
- [x] 500 objects stay at 60 fps (verified by the browser smoke test)

## Stage 2 checklist

- [x] WebSocket gateway (`ws`) with room join/leave
- [x] Operations broadcast to the room and acknowledged to the author
- [x] Server-assigned client ids — a client cannot forge an identity
- [x] Reconnect with a re-sync: nothing is lost, nothing is applied twice
- [x] Naive server-arrival-order LWW sync, convergent by construction
- [x] Two browsers on one canvas (verified by the two-browser smoke test)

### How it works

```
pointer event ──► canvas ──► store ──► applyOp() ──► scene state ──► render
                      │         │
                      │         └──► undo/redo (inverse operations)
                      └──► transient draft, never persisted
```

With the gateway connected the store stops applying operations itself and
sends them instead:

```
pointer event ──► canvas ──► store ──► outbox ──► gateway ──► room (merge, seq)
                      │                                  │
                      │         undo/redo ◄─────────────┘
                      │              (the echo comes back in gateway order)
                      └──► transient draft, never persisted
```

The rule that shapes the whole codebase: **nothing mutates an object
directly**. A drag produces a transient _draft_ while the pointer moves, and a
single `setProp` operation when the gesture ends. That is what makes undo,
replay, offline merging and — in stage 3 — CRDT convergence possible.

Two decisions in stage 2 are worth calling out, because they are the ones
stage 3 throws away:

- **The gateway is the single ordering point.** Every batch of operations is
  applied in the order the server receives it and gets the next sequence
  number. Every client folds the operations in that sequence, so all replicas
  converge — but the winner of two conflicting writes depends on arrival
  order, not on the merge. That is the naive LWW behaviour stage 2 asks for.
- **No optimistic apply.** The client waits for the gateway to echo its own
  operations back instead of applying them immediately. That costs a round
  trip on every edit and buys a scene that is always a prefix of the
  server's history — two replicas cannot drift apart.

- `shared/src/geometry.ts` — rotation, resize-around-the-anchor, hit-testing
  and handle placement. Pure functions, no dependencies.
- `shared/src/scene.ts` — the scene state and `applyOp`, the single place
  where the scene changes.
- `shared/src/protocol.ts` — the wire protocol and its runtime validators; a
  malformed frame is rejected, never coerced.
- `shared/src/hlc.ts` — the hybrid logical clock that stamps every operation.
- `client/src/store/sceneStore.ts` — the Zustand store. Turns gestures into
  operations and keeps the undo/redo stacks.
- `client/src/net/` — the sync client (outbox, ordering, reconnect) and the
  hook that wires it into the editor.
- `client/src/canvas/` — the SVG canvas, the selection overlay and the
  viewport maths.
- `server/src/gateway.ts` — the WebSocket gateway: identities, broadcast,
  acknowledgement.
- `server/src/rooms.ts` — the room registry and the naive LWW merge.

## Getting started

Prerequisites: Node.js ≥ 22, npm ≥ 10, Docker with Compose.

```bash
npm install
docker compose up -d        # Postgres :5432, Redis :6379
cp .env.example .env
npm run dev                 # shared (tsc watch) + server :8080 + client :5173
```

Verify:

```bash
npm run check               # lint + format:check + typecheck + tests
npm run smoke               # browser smoke test (needs the dev server running)
npm run smoke:sync          # two browsers on one canvas (needs client + gateway)
curl http://localhost:8080/healthz
```

### Trying it with two people

Open the editor in two browsers — or two tabs — and point them at the same
room:

```
http://localhost:5173/?room=demo&name=Ada
http://localhost:5173/?room=demo&name=Bob
```

| Parameter | Meaning                                                | Default                  |
| --------- | ------------------------------------------------------ | ------------------------ |
| `room`    | The room to join — the same room means the same canvas | `demo`                   |
| `ws`      | Where the gateway lives                                | `ws://localhost:8080/ws` |
| `name`    | Your display name in the room                          | a random guest name      |

`VITE_WS_URL` sets the default gateway for a deployment. If the gateway is
not running the editor keeps working on its own — the status bar shows
`Offline` and the edits stay local.

### What stage 2 does not do yet

- **No offline editing.** A client that loses the connection keeps editing
  locally, but those edits are _not_ queued: they are lost when the client
  reconnects and re-syncs to the room. A durable offline outbox is stage 5.
- **No concurrent-edit protection.** The merge is arrival order, so two people
  dragging the same rectangle lose one of the drags. Stage 3 replaces the
  ordering point with a CRDT merge.
- **No persistence.** The rooms live in the gateway's memory, so a restart
  brings the room back from the seed scene. The op log lands in Postgres in
  stage 4.
- **No authentication.** The `auth` handshake is a placeholder; JWT rooms
  arrive in stage 4.

## Scripts

| Script                 | What it does                                       |
| ---------------------- | -------------------------------------------------- |
| `npm run dev`          | Build shared, then run all three packages in watch |
| `npm run build`        | Production build of shared → server → client       |
| `npm run lint`         | ESLint across the workspace                        |
| `npm run format:check` | Prettier check (CI) / `npm run format` to fix      |
| `npm run typecheck`    | `tsc --noEmit` for server + client                 |
| `npm run test`         | Vitest across workspaces                           |
| `npm run smoke`        | Playwright smoke test against the running client   |
| `npm run smoke:sync`   | Two-browser sync test (starts the gateway itself)  |
| `npm run check`        | Everything CI runs                                 |
| `docker compose up -d` | Local Postgres + Redis                             |

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
shared/   object model, geometry, op types, scene state, protocol, HLC (source of truth)
server/   Node.js gateway: rooms, naive LWW merge, WebSocket fan-out
client/   React + Vite editor: canvas, selection overlay, store, sync client
scripts/  browser smoke tests (single user and two users)
docs/     DESIGN.md — data model, protocol, CRDT, scaling, tradeoffs
```

## Roadmap

- **Stage 3:** full CRDT (RGA, tombstones), presence/cursors, convergence fuzz tests
- **Stage 4:** Redis pub/sub sharding, Postgres op log + snapshots, JWT rooms
- **Stage 5:** offline outbox, undo/redo, version restore, k6 load tests
- **Stage 6:** Docker, AWS deploy, CD, architecture README + demo GIF
