import type { StoreMode } from './store/index.js';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function storeMode(): StoreMode {
  const value = process.env.STORE ?? 'auto';
  if (value === 'auto' || value === 'memory' || value === 'postgres') return value;
  throw new Error(`STORE must be auto, memory or postgres (got "${value}")`);
}

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  /** Path the WebSocket upgrade is accepted on. */
  wsPath: string;
  /** Where users, rooms, operations and snapshots live. */
  storeMode: StoreMode;
  databaseUrl: string;
  /** Cross-instance room bus. Empty keeps the gateway standalone. */
  redisUrl: string;
  /** Name for this process on the room bus; generated when omitted. */
  instanceId: string;
  /** Operations between snapshots. */
  snapshotEvery: number;
  /** Maximum age of a snapshot on an active room. */
  snapshotIntervalMs: number;
  /** HS256 secret shared by access tokens and share links. */
  jwtSecret: string;
  /** Lifetime of an access token (a guest session). */
  jwtTtlSeconds: number;
  /** Lifetime of a share link. */
  inviteTtlSeconds: number;
  /** The public, no-invite sandbox room. Empty disables it. */
  publicDemoRoom: string;
  /** Allowed CORS origin for the HTTP API (`*` in development). */
  corsOrigin: string;
  /** Presence without a heartbeat is dropped after this long. */
  presenceTtlMs: number;
  /** How often stale sessions are swept. */
  presenceSweepMs: number;
  /** Upper bound on a single operations batch. */
  maxOpsPerBatch: number;
}

export const config: ServerConfig = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  wsPath: process.env.WS_PATH ?? '/ws',
  storeMode: storeMode(),
  databaseUrl: required('DATABASE_URL', 'postgres://syncanvas:syncanvas@localhost:5432/syncanvas'),
  redisUrl: process.env.REDIS_URL?.trim() ?? '',
  instanceId: process.env.INSTANCE_ID?.trim() ?? '',
  snapshotEvery: Number(process.env.SNAPSHOT_EVERY ?? 100),
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000),
  jwtSecret: required('JWT_SECRET', 'dev-only-secret'),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 7 * 24 * 60 * 60),
  inviteTtlSeconds: Number(process.env.INVITE_TTL_SECONDS ?? 7 * 24 * 60 * 60),
  publicDemoRoom: process.env.PUBLIC_DEMO_ROOM ?? 'demo',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  presenceTtlMs: Number(process.env.PRESENCE_TTL_MS ?? 60_000),
  presenceSweepMs: Number(process.env.PRESENCE_SWEEP_MS ?? 5_000),
  maxOpsPerBatch: Number(process.env.MAX_OPS_PER_BATCH ?? 1_000),
};
