import { config } from '../config.js';
import { PostgresStore } from './postgres.js';

/**
 * Applies the schema explicitly: `npm run migrate -w @syncanvas/server`.
 *
 * The gateway also initializes the schema on boot when a database is
 * configured, so this command is mainly for provisioning and CI.
 */
const store = new PostgresStore(config.databaseUrl);
try {
  await store.initialize();
  console.log(`Schema ready at ${config.databaseUrl.replace(/:\/\/[^@]*@/, '://***@')}`);
} finally {
  await store.close();
}
