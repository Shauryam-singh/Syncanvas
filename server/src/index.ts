import { createServer } from 'node:http';
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

// The demo room is the public sandbox; real rooms are created through the API
// and always have an owner membership.
await ensureDemoRoom(store, registry, config.publicDemoRoom);
await loadRooms(store, registry);

const persistence = new RoomPersistence(store, registry);
const server = createServer(createApiHandler({ store, registry, config }));
const { wss } = createGateway(server, {
  path: config.wsPath,
  store,
  registry,
  config,
  persistence,
});

server.listen(config.port, () => {
  console.log(
    `syncanvas gateway listening on http://localhost:${config.port} (ws: ${config.wsPath}, store: ${store.kind})`,
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: shutting down`);

  for (const socket of wss.clients) socket.close(1001, 'server shutting down');
  wss.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

  // Give the last operations a chance to reach Postgres, then release the pool.
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
