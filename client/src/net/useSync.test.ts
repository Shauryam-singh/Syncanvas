import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '../store/sceneStore';
import { saveSession } from './session';
import { readSyncConfig, useSync, type SyncConfig } from './useSync';

const SERVER = 'http://localhost:8099';
const SESSION_KEY = 'syncanvas.session.v1';

/** A WebSocket stand-in that records what the client sent. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function sessionBody(token = 'tok', displayName = 'Ada') {
  return {
    token,
    user: { id: 'u1', displayName },
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    url: `ws://localhost:8099/ws`,
    roomId: 'room_1',
    displayName: 'Ada',
    invite: 'invite_1',
    explicitName: false,
    ...overrides,
  };
}

function resetStore(): void {
  useSceneStore.setState({
    access: 'local',
    role: null,
    session: null,
    roomId: 'demo',
    roomName: 'Demo canvas',
    selfSessionId: null,
    accessMessage: null,
    lastError: null,
    connection: 'local',
    peers: [],
    opSender: null,
    presenceSender: null,
  });
}

describe('readSyncConfig', () => {
  it('falls back to the default gateway and room', () => {
    const parsed = readSyncConfig('');
    expect(parsed.roomId).toBe('demo');
    expect(parsed.url).toBe('ws://localhost:8080/ws');
    expect(parsed.displayName).toMatch(/^Guest /);
    expect(parsed.invite).toBeUndefined();
    expect(parsed.explicitName).toBe(false);
    expect(parsed.signedOut).toBe(false);
  });

  it('reads the room, the gateway, the invite and the name from the query string', () => {
    const parsed = readSyncConfig(
      '?room=design-review&ws=wss://sync.example.com/ws&name=Ada&invite=signed',
    );
    expect(parsed.roomId).toBe('design-review');
    expect(parsed.url).toBe('wss://sync.example.com/ws');
    expect(parsed.displayName).toBe('Ada');
    expect(parsed.invite).toBe('signed');
    expect(parsed.explicitName).toBe(true);
  });

  it('recognises the signed-out gate', () => {
    expect(readSyncConfig('?signedout=1').signedOut).toBe(true);
    expect(readSyncConfig('?signedout=0').signedOut).toBe(false);
  });

  it('generates a different guest name every time', () => {
    const first = readSyncConfig('').displayName;
    const second = readSyncConfig('').displayName;
    expect(first).not.toBe(second);
  });
});

describe('useSync', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeSocket.instances = [];
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeSocket);
    localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    resetStore();
  });

  it('signs in a guest, joins with the token and the invite, and installs the handlers', async () => {
    fetchMock.mockResolvedValue(reply(sessionBody()));

    const { unmount } = renderHook(() => useSync(config()));

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVER}/api/auth/guest`);
    expect(init.method).toBe('POST');

    const socket = FakeSocket.instances[0]!;
    act(() => socket.open());
    expect(socket.messages[0]).toMatchObject({ t: 'auth', token: 'tok' });

    act(() =>
      socket.receive({
        t: 'welcome',
        userId: 'u1',
        sessionId: 'sess_1',
        displayName: 'Ada',
        color: '#6366f1',
      }),
    );
    expect(socket.messages[1]).toMatchObject({
      t: 'join',
      roomId: 'room_1',
      invite: 'invite_1',
    });

    act(() => {
      socket.receive({
        t: 'joined',
        roomId: 'room_1',
        name: 'Design review',
        role: 'editor',
        snapshotSeq: 0,
        peers: [],
      });
      socket.receive({
        t: 'state',
        roomId: 'room_1',
        snapshotSeq: 0,
        objects: [],
        ops: [],
      });
    });

    const state = useSceneStore.getState();
    expect(state.access).toBe('granted');
    expect(state.role).toBe('editor');
    expect(state.roomId).toBe('room_1');
    expect(state.roomName).toBe('Design review');
    expect(state.selfSessionId).toBe('sess_1');
    expect(state.session).toEqual({ userId: 'u1', displayName: 'Ada' });
    expect(state.connection).toBe('live');
    expect(state.opSender).not.toBeNull();
    expect(state.presenceSender).not.toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();

    // The joined handler announces this client's initial presence.
    expect(socket.messages.some((message) => message.t === 'presence')).toBe(true);

    act(() => unmount());
    expect(useSceneStore.getState().opSender).toBeNull();
    expect(useSceneStore.getState().presenceSender).toBeNull();
  });

  it('stays at the signed-out gate instead of minting another guest', async () => {
    const { unmount } = renderHook(() => useSync(config({ signedOut: true })));

    await waitFor(() => expect(useSceneStore.getState().access).toBe('signedout'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(useSceneStore.getState().session).toBeNull();

    act(() => unmount());
  });

  it('falls back to the local editor when the HTTP API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const { unmount } = renderHook(() => useSync(config()));

    await waitFor(() => expect(useSceneStore.getState().access).toBe('local'));
    expect(useSceneStore.getState().connection).toBe('local');
    expect(useSceneStore.getState().session).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();

    act(() => unmount());
  });

  it('reuses a cached session without signing in again', async () => {
    saveSession({
      ...sessionBody('cached_token', 'Ada'),
      server: SERVER,
    });

    renderHook(() => useSync(config()));

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(fetchMock).not.toHaveBeenCalled();

    const socket = FakeSocket.instances[0]!;
    act(() => socket.open());
    expect(socket.messages[0]).toMatchObject({ t: 'auth', token: 'cached_token' });
  });

  it('closes the gate when access is denied', async () => {
    fetchMock.mockResolvedValue(reply(sessionBody()));

    renderHook(() => useSync(config()));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));

    const socket = FakeSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({
        t: 'welcome',
        userId: 'u1',
        sessionId: 'sess_1',
        displayName: 'Ada',
        color: '#6366f1',
      });
      socket.receive({
        t: 'error',
        code: 'forbidden',
        message: 'You need a share link or an invitation to join this room.',
        roomId: 'room_1',
      });
    });

    await waitFor(() => expect(useSceneStore.getState().access).toBe('denied'));
    expect(useSceneStore.getState().accessMessage).toBe(
      'You need a share link or an invitation to join this room.',
    );
    expect(useSceneStore.getState().role).toBeNull();
    expect(socket.readyState).toBe(3);
  });

  it('clears the cached session when the token is rejected', async () => {
    saveSession({
      ...sessionBody('expired_token', 'Ada'),
      server: SERVER,
    });
    fetchMock.mockResolvedValue(reply(sessionBody()));

    renderHook(() => useSync(config()));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));

    const socket = FakeSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({
        t: 'error',
        code: 'unauthorized',
        message: 'That session is invalid or has expired.',
      });
    });

    await waitFor(() => expect(useSceneStore.getState().access).toBe('denied'));
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(useSceneStore.getState().accessMessage).toBe('That session is invalid or has expired.');
  });
});
