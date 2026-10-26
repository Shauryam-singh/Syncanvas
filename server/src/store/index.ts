import type { Store } from './types.js';
import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';

export type StoreMode = 'auto' | 'memory' | 'postgres';

export interface CreateStoreOptions {
  mode?: StoreMode;
  databaseUrl?: string;
  logger?: Pick<Console, 'warn' | 'error'>;
}

/**
 * Picks a store.
 *
 * `auto` is the friendly default: use Postgres when a URL is configured and
 * reachable, otherwise fall back to memory so the editor (and the browser
 * smoke test) still runs. `postgres` never falls back — production should use
 * it so a missing database is a startup failure, not silent data loss.
 */
export async function createStore(options: CreateStoreOptions = {}): Promise<Store> {
  const logger = options.logger ?? console;
  const mode = options.mode ?? 'auto';

  if (mode === 'memory') return new MemoryStore();
  if (!options.databaseUrl) {
    if (mode === 'postgres') {
      throw new Error('STORE=postgres requires DATABASE_URL');
    }
    return new MemoryStore();
  }

  const postgres = new PostgresStore(options.databaseUrl);
  try {
    await postgres.initialize();
    return postgres;
  } catch (error) {
    await postgres.close().catch(() => undefined);
    if (mode === 'postgres') throw error;
    logger.warn(
      `Could not reach Postgres (${(error as Error).message}); using the in-memory store.`,
    );
    return new MemoryStore();
  }
}

export * from './types.js';
export { MemoryStore } from './memory.js';
export { PostgresStore } from './postgres.js';
