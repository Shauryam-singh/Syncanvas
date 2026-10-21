# Syncanvas

Real-time collaborative scene editor — a "Figma-lite" multiplayer canvas where
several people place, move, transform and style objects at once, with live
cursors, offline editing and version history. The merge logic (LWW-map CRDT +
RGA + hybrid logical clocks) is implemented from scratch, not wrapped around
Yjs.

**Status: Stage 0 — setup and design.** See [docs/DESIGN.md](docs/DESIGN.md)
for the full technical design (data model, wire protocol, CRDT approach,
scaling plan).

## Stage 0 checklist

- [x] Monorepo with `client/`, `server/` and `shared/` (shared TypeScript types)
- [x] Docker Compose with Postgres and Redis
- [x] GitHub Actions: lint + format + typecheck + test + build on every push
- [x] Design doc: data model, message protocol, CRDT choice
- [x] Object model: `id, type, x, y, w, h, rotation, fill, zIndex`

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
| `npm run check`        | Everything CI runs                                 |
| `docker compose up -d` | Local Postgres + Redis                             |

## Layout

```
shared/   object model, op types, protocol types, CRDT core (source of truth)
server/   Node.js gateway: auth, merge, persistence, pub/sub fan-out
client/   React + Vite editor: canvas, presence, offline outbox
docs/     DESIGN.md — data model, protocol, CRDT, scaling, tradeoffs
```

## Roadmap

- **Stage 1:** canvas interaction, WebSocket gateway, naive LWW sync
- **Stage 2:** full CRDT (RGA, tombstones), presence/cursors, convergence fuzz tests
- **Stage 3:** Redis pub/sub sharding, Postgres op log + snapshots, JWT rooms
- **Stage 4:** offline outbox, undo/redo, version restore, k6 load tests
- **Stage 5:** Docker, AWS deploy, CD, architecture README + demo GIF
