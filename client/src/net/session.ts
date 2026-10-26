import type { SessionResponse } from '@syncanvas/shared';

const STORAGE_KEY = 'syncanvas.session.v1';
/** Refresh a little before the token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * The session this tab is using.
 *
 * The store keeps the identity (so React can render it); the token stays in a
 * module variable and is only read on demand by API calls.
 */
let activeSession: StoredSession | null = null;

export function setActiveSession(session: StoredSession | null): void {
  activeSession = session;
}

export function getActiveSession(): StoredSession | null {
  return activeSession;
}

export interface StoredSession extends SessionResponse {
  /** The gateway that issued the token. Tokens do not travel across servers. */
  server: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private mode / blocked storage: the editor still works, it just does
    // not remember the session across reloads.
    return null;
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  const user = session.user as Record<string, unknown> | undefined;
  return (
    typeof session.token === 'string' &&
    typeof session.expiresAt === 'number' &&
    typeof session.server === 'string' &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.id === 'string' &&
    typeof user.displayName === 'string'
  );
}

/**
 * Loads a session for this gateway.
 *
 * An explicit `?name=` means the user asked for a different display name, so
 * the cached identity is discarded and a fresh guest is created. Otherwise
 * the same guest identity is reused across reloads, which keeps room
 * memberships (and the share links already redeemed) intact.
 */
export function loadSession(server: string, explicitName?: string): StoredSession | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredSession(parsed)) return null;
    if (parsed.server !== server) return null;
    if (parsed.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) return null;
    if (explicitName !== undefined && parsed.user.displayName !== explicitName) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Ignore quota errors: the session still works for this page.
  }
}

export function clearSession(): void {
  activeSession = null;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
