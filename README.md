# Syncanvas

Real-time collaborative scene editor — a "Figma-lite" multiplayer canvas where
several people place, move, transform and style objects at once, with live
cursors, offline editing and version history. The merge logic (LWW-map CRDT +
RGA + hybrid logical clocks) is implemented from scratch, not wrapped around
Yjs.

**Status: Stage 3 — the hand-rolled CRDT.** The editor renders rectangles,
ellipses, lines and text; supports select, drag, resize, rotate and z-order;
expresses every edit as an operation; and syncs those operations through a
Node.js WebSocket gateway. Every operation is stamped with a hybrid logical
clock and merged through the same dependency-free CRDT in `shared/src/crdt/`:
an LWW register per object property, delete-wins tombstones and an RGA for
z-order. The gateway still relays and numbers batches, but it no longer decides
the winner — two replicas that have seen the same operations converge to the
same scene whatever order they arrived in. See
[docs/DESIGN.md](docs/DESIGN.md) for the full technical design (data model,
wire protocol, CRDT semantics, scaling plan).

## Progress

| Stage | Scope                                      | Status |
| ----- | ------------------------------------------ | ------ |
| 0     | Monorepo, compose, CI, design doc          | ✅     |
| 1     | Canvas, transform maths, op pipeline       | ✅     |
| 2     | WebSocket gateway, naive LWW sync          | ✅     |
| 3     | CRDT core (LWW-map, RGA, tombstones), fuzz | ✅     |
| 4     | Redis pub/sub, Postgres log, JWT rooms     | ⬜     |
| 5     | Offline outbox, text RGA, version restore  | ⬜     |
| 6     | Load tests, Docker, AWS deploy, README     | ⬜     |

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

## Stage 3 checklist

- [x] Hybrid logical clock (`wall`, `counter`, `actorId`) with a total order
- [x] LWW register per object property, keyed by `(value, HLC, opId)`
- [x] Deterministic tie-break: the HLC first, then the operation id
- [x] Delete-wins tombstones; a strictly later create resurrects the object (undo)
- [x] RGA for the z-order, with explicit top/bottom origins, dead-node hinges
      and deterministic cycle breaking
- [x] Idempotent, commutative and associative `mergeEnvelope`
- [x] Pure, dependency-free module in `shared/src/crdt/` (no Yjs)
- [x] Unit tests for the register, the RGA and the document
- [x] Property tests (fast-check): 10,000 randomized schedules, shuffled and
      duplicated delivery, all replicas converging
- [x] Clock-skew test: a replica 10 minutes ahead converges and does not win forever
- [x] The gateway and the editor both merge through the CRDT

### How it works

```
pointer event ──► canvas ──► store ──► mergeEnvelope() ──► CRDT document
                                                              │
                                          scene projection ◄──┘──► render
```

A drag still produces a transient _draft_ while the pointer moves, and a single
`setProp` operation when the gesture ends. The rule that shapes the whole
codebase: **nothing mutates an object directly**. That is what makes undo,
replay, offline merging and CRDT convergence possible.

With the gateway connected, the store does not apply its own operations
optimistically. It stamps them and sends them; the gateway merges them into the
room's document and echoes the same envelopes back:

```
pointer event ──► store ──► outbox ──► gateway ──► room.mergeEnvelopes()
                      ▲                                │
                      └────── echo (same envelopes) ◄──┘
```

The gateway still assigns a sequence number to every accepted batch, but that
number is a **broadcast watermark** (used for acknowledgements and catch-up),
not a merge rule. The winner of a conflict is `(HLC, opId)` on every replica.

Three decisions in stage 3 are worth calling out:

- **Delete-wins, with resurrection.** A tombstone beats a concurrent create
  when their logical times tie; a create that is strictly later — the undo of a
  delete — brings the object back. Nothing is ever silently re-created by a
  late `setProp`.
- **The z-order is an RGA, not a number.** `zIndex` is derived from the
  sequence, and moving an object replaces its placement with a new node.
  Concurrent moves after the same origin are ordered by version, so both
  replicas agree.
- **No optimistic apply (still).** The author waits for the echo, which costs a
  round trip but guarantees the rendered scene is always a prefix of the
  replicated document. Local-first apply is stage 5.

## Where things live

- `shared/src/crdt/register.ts` — the LWW register and the `(HLC, opId)` total order.
- `shared/src/crdt/rga.ts` — the z-order sequence: origins, sibling order, dead
  hinges and deterministic cycle breaking.
- `shared/src/crdt/doc.ts` — the replicated document, `mergeEnvelope`, the
  delete-wins existence rule and the projection back to a `SceneState`.
- `shared/src/geometry.ts` — rotation, resize-around-the-anchor, hit-testing
  and handle placement. Pure functions, no dependencies.
- `shared/src/scene.ts` — the scene view model and the stage-1 `applyOp` path
  used for inverse operations and snapshots.
- `shared/src/protocol.ts` — the wire protocol and its runtime validators; a
  malformed frame is rejected, never coerced.
- `shared/src/hlc.ts` — the hybrid logical clock that stamps every operation.
- `client/src/store/sceneStore.ts` — the Zustand store. Holds the CRDT
  document, projects it into the scene, and keeps the undo/redo stacks.
- `client/src/net/` — the sync client (outbox, reconnect) and the hook that
  wires it into the editor.
- `client/src/canvas/` — the SVG canvas, the selection overlay and the
  viewport maths.
- `server/src/gateway.ts` — the WebSocket gateway: identities, broadcast,
  acknowledgement.
- `server/src/rooms.ts` — the room registry; merges every accepted envelope
  into the room's CRDT document.

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

### What stage 3 does not do yet

- **No persistence.** The rooms live in the gateway's memory, so a restart
  brings the room back from the seed scene. The operation log and CRDT
  snapshots land in Postgres in stage 4.
- **No offline editing.** A client that loses the connection keeps editing
  locally, but those edits are _not_ queued: they are lost when the client
  reconnects and re-syncs to the room. A durable offline outbox is stage 5.
- **No text RGA yet.** `editText` is defined and acknowledged, and the generic
  RGA is in place, but the editor still edits whole strings through
  `setProp('text', …)`, so concurrent typing inside one text object is
  last-writer-wins. A per-character RGA is stage 5.
- **No authentication.** The `auth` handshake is a placeholder; JWT rooms
  arrive in stage 4.
- **Tombstones are not compacted.** The delete markers are kept forever (they
  are what makes delete-wins safe). Snapshot compaction arrives with the
  persistent log.
- **A joining client receives the projected scene, not the CRDT history.** That
  is enough to converge on the operations it receives afterwards, but a full
  state sync (tombstones and exact register versions) waits for the persisted
  snapshot in stage 4.

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
shared/   object model, geometry, op types, scene state, protocol, HLC, CRDT (source of truth)
server/   Node.js gateway: rooms, CRDT merge, WebSocket fan-out
client/   React + Vite editor: canvas, selection overlay, store, sync client
scripts/  browser smoke tests (single user and two users)
docs/     DESIGN.md — data model, protocol, CRDT, scaling, tradeoffs
```

## Roadmap

- **Stage 3 (done):** hand-rolled CRDT — HLC, LWW-map, RGA z-order, delete-wins
  tombstones — plus 10,000-schedule convergence fuzzing and a clock-skew test
- **Stage 4:** Redis pub/sub sharding, Postgres op log + CRDT snapshots, JWT rooms
- **Stage 5:** offline outbox, optimistic local apply, per-character text RGA,
  version restore
- **Stage 6:** Docker, AWS deploy, CD, architecture README + demo GIF
