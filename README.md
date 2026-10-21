# Syncanvas

Real-time collaborative scene editor — a "Figma-lite" multiplayer canvas where
several people place, move, transform and style objects at once, with live
cursors, offline editing and version history. The merge logic (LWW-map CRDT +
RGA + hybrid logical clocks) is implemented from scratch, not wrapped around
Yjs.

**Status: Stage 1 — single-user canvas.** The editor renders rectangles,
ellipses, lines and text; supports select, drag, resize, rotate and z-order;
and every edit is expressed as an operation that flows through one pipeline.
See [docs/DESIGN.md](docs/DESIGN.md) for the full technical design (data model,
wire protocol, CRDT approach, scaling plan).

## Progress

| Stage | Scope                                   | Status |
| ----- | --------------------------------------- | ------ |
| 0     | Monorepo, compose, CI, design doc       | ✅     |
| 1     | Canvas, transform maths, op pipeline    | ✅     |
| 2     | WebSocket gateway, naive LWW sync       | ⬜     |
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

### How it works

```
pointer event ──► canvas ──► store ──► applyOp() ──► scene state ──► render
                      │         │
                      │         └──► undo/redo (inverse operations)
                      └──► transient draft, never persisted
```

The rule that shapes the whole codebase: **nothing mutates an object
directly**. A drag produces a transient _draft_ while the pointer moves, and a
single `setProp` operation when the gesture ends. That is what makes undo,
replay, offline merging and — in stage 3 — CRDT convergence possible.

- `shared/src/geometry.ts` — rotation, resize-around-the-anchor, hit-testing
  and handle placement. Pure functions, no dependencies.
- `shared/src/scene.ts` — the scene state and `applyOp`, the single place
  where the scene changes.
- `client/src/store/sceneStore.ts` — the Zustand store. Turns gestures into
  operations and keeps the undo/redo stacks.
- `client/src/canvas/` — the SVG canvas, the selection overlay and the
  viewport maths.

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
curl http://localhost:8080/healthz
```

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
shared/   object model, geometry, op types, scene state, protocol (source of truth)
server/   Node.js gateway: auth, merge, persistence, pub/sub fan-out
client/   React + Vite editor: canvas, selection overlay, store
scripts/  browser smoke test
docs/     DESIGN.md — data model, protocol, CRDT, scaling, tradeoffs
```

## Roadmap

- **Stage 2:** WebSocket gateway, naive LWW sync, two browsers on one canvas
- **Stage 3:** full CRDT (RGA, tombstones), presence/cursors, convergence fuzz tests
- **Stage 4:** Redis pub/sub sharding, Postgres op log + snapshots, JWT rooms
- **Stage 5:** offline outbox, undo/redo, version restore, k6 load tests
- **Stage 6:** Docker, AWS deploy, CD, architecture README + demo GIF
