import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  getActiveSession,
  loadSession,
  saveSession,
  setActiveSession,
  type StoredSession,
} from './session';

const NOW = Date.now();

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    token: 'tok',
    user: { id: 'u1', displayName: 'Ada' },
    expiresAt: NOW + 60 * 60 * 1000,
    server: 'http://localhost:8080',
    ...overrides,
  };
}

describe('the cached session', () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveSession(null);
  });

  afterEach(() => {
    localStorage.clear();
    setActiveSession(null);
  });

  it('round-trips a session for the same server', () => {
    saveSession(session());
    expect(loadSession('http://localhost:8080')).toMatchObject({
      token: 'tok',
      server: 'http://localhost:8080',
      user: { id: 'u1', displayName: 'Ada' },
    });
  });

  it('does not reuse a token issued by another server', () => {
    saveSession(session());
    expect(loadSession('http://localhost:9999')).toBeNull();
  });

  it('drops a session that is about to expire', () => {
    saveSession(session({ expiresAt: NOW + 10_000 }));
    expect(loadSession('http://localhost:8080')).toBeNull();
  });

  it('drops the cached identity when a different name was requested', () => {
    saveSession(session());
    expect(loadSession('http://localhost:8080', 'Bob')).toBeNull();
    expect(loadSession('http://localhost:8080', 'Ada')).not.toBeNull();
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('syncanvas.session.v1', '{nope');
    expect(loadSession('http://localhost:8080')).toBeNull();
  });

  it('tracks the in-memory session used by API calls', () => {
    const cached = session();
    saveSession(cached);
    setActiveSession(cached);
    expect(getActiveSession()).toBe(cached);

    clearSession();
    expect(getActiveSession()).toBeNull();
    expect(localStorage.getItem('syncanvas.session.v1')).toBeNull();
  });
});
