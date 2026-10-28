import { createServer } from 'node:http';
import { createRoomBus } from './bus.js';
import { config } from './config.js';
import { createGateway } from './gateway.js';
import { createApiHandler } from './http.js';
import { ensureDemoRoom, loadRooms, RoomPersistence } from './persistence.js';
import { RoomRegistry } from './rooms.js';
import { createStore } from './store/index.js';

const store = await createStore({
  mode: config.storeMode,
  databaseUrl: config.databaseUrl,
});
const registry = new RoomRegistry();

// Connect the room bus before replaying rooms. Any batch another gateway
// publishes during the replay is buffered and applied once the websocket
// server attaches its handler; replaying it twice is harmless because
// operations are idempotent.
const bus = await createRoomBus({
  url: config.redisUrl,
  instanceId: config.instanceId,
  logger: console,
});

// The demo room is the public sandbox; real rooms are created through the API
// and always have an owner membership.
await ensureDemoRoom(store, registry, config.publicDemoRoom);
await loadRooms(store, registry);

const persistence = new RoomPersistence(store, registry, {
  snapshotEvery: config.snapshotEvery,
  snapshotIntervalMs: config.snapshotIntervalMs,
});
const server = createServer(
  createApiHandler({
    store,
    registry,
    config,
    busKind: bus?.kind ?? null,
    instanceId: bus?.instanceId ?? config.instanceId,
  }),
);
const gateway = createGateway(server, {
  path: config.wsPath,
  store,
  registry,
  config,
  persistence,
  bus: bus ?? undefined,
});

server.listen(config.port, () => {
  console.log(
    `syncanvas gateway listening on http://localhost:${config.port} (ws: ${config.wsPath}, store: ${store.kind}, bus: ${bus?.kind ?? 'standalone'}, instance: ${bus?.instanceId ?? 'solo'})`,
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down`);

  for (const socket of gateway.wss.clients) socket.close(1001, 'server shutting down');
  gateway.wss.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

  // Let bus frames already in flight finish applying, stop the subscriber,
  // then give the last operations a chance to reach Postgres.
  await gateway.drain().catch((error: unknown) => {
    console.error('Could not drain room-bus work:', error);
  });
  await bus?.close().catch((error: unknown) => {
    console.error('Could not close the room bus:', error);
  });
  await gateway.drain().catch((error: unknown) => {
    console.error('Could not drain room-bus work:', error);
  });
  await persistence.flush().catch((error: unknown) => {
    console.error('Could not flush persistence on shutdown:', error);
  });
  await store.close().catch((error: unknown) => {
    console.error('Could not close the store:', error);
  });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
