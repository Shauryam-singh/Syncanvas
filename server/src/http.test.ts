import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  CreateInviteResponse,
  CreateRoomResponse,
  RoomListResponse,
  SessionResponse,
} from '@syncanvas/shared';
import { signAccessToken, verifyAccessToken, verifyInviteToken } from './auth/jwt.js';
import { config } from './config.js';
import { createApiHandler } from './http.js';
import { ensureDemoRoom } from './persistence.js';
import { RoomRegistry } from './rooms.js';
import { MemoryStore } from './store/memory.js';

const SECRET = 'http-test-secret';

function testConfig() {
  return {
    ...config,
    jwtSecret: SECRET,
    publicDemoRoom: 'demo',
    corsOrigin: '*',
    jwtTtlSeconds: 3600,
    inviteTtlSeconds: 3600,
  };
}

describe('the HTTP API', () => {
  let server: Server;
  let base: string;
  let store: MemoryStore;
  let registry: RoomRegistry;

  beforeEach(async () => {
    store = new MemoryStore();
    registry = new RoomRegistry();
    await ensureDemoRoom(store, registry, 'demo');
    server = createServer(createApiHandler({ store, registry, config: testConfig() }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function get(path: string, token?: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  async function guest(displayName = 'Ada'): Promise<SessionResponse> {
    const response = await post('/api/auth/guest', { displayName });
    expect(response.status).toBe(200);
    return (await response.json()) as SessionResponse;
  }

  async function createRoom(token: string, name = 'Sprint review'): Promise<CreateRoomResponse> {
    const response = await post('/api/rooms', { name }, token);
    expect(response.status).toBe(201);
    return (await response.json()) as CreateRoomResponse;
  }

  it('issues a guest session with a verifiable token', async () => {
    const session = await guest('Ada');
    expect(session.user.displayName).toBe('Ada');
    expect(session.user.id).toMatch(/^user_/);
    expect(session.expiresAt).toBeGreaterThan(Date.now());

    const claims = verifyAccessToken(session.token, SECRET);
    expect(claims?.sub).toBe(session.user.id);
    expect(claims?.name).toBe('Ada');
  });

  it('lets a guest rename themselves and reissues the token', async () => {
    const session = await guest('Ada');

    const response = await post(
      '/api/auth/profile',
      { displayName: '  Ada   Lovelace  ' },
      session.token,
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as SessionResponse;
    expect(updated.user.id).toBe(session.user.id);
    expect(updated.user.displayName).toBe('Ada Lovelace');
    expect((await store.user(session.user.id))?.displayName).toBe('Ada Lovelace');

    const claims = verifyAccessToken(updated.token, SECRET);
    expect(claims?.sub).toBe(session.user.id);
    expect(claims?.name).toBe('Ada Lovelace');
  });

  it('rejects an empty display name', async () => {
    const session = await guest('Ada');
    const response = await post('/api/auth/profile', { displayName: '   ' }, session.token);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('invalid_request');
  });

  it('requires a bearer token to rename a guest', async () => {
    const response = await post('/api/auth/profile', { displayName: 'Mallory' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('unauthorized');
  });

  it('rejects malformed guest requests', async () => {
    const response = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('invalid_request');
  });

  it('requires a bearer token to create a room', async () => {
    const response = await post('/api/rooms', { name: 'Nope' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('unauthorized');
  });

  it('rejects an expired access token', async () => {
    const session = await guest('Ada');
    const user = await store.user(session.user.id);
    expect(user).not.toBeNull();
    const expired = signAccessToken(user!, SECRET, 60, Date.now() - 120_000).token;
    const response = await post('/api/rooms', { name: 'Nope' }, expired);
    expect(response.status).toBe(401);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('unauthorized');
  });

  it('creates a room owned by the caller and mints both share links', async () => {
    const session = await guest('Ada');
    const created = await createRoom(session.token, 'Sprint review');

    expect(created.room.name).toBe('Sprint review');
    expect(created.room.role).toBe('owner');
    expect(created.room.id).toMatch(/^room_/);
    expect(await store.membership(created.room.id, session.user.id)).toBe('owner');

    const editor = verifyInviteToken(created.invites.editor, SECRET, created.room.id);
    const viewer = verifyInviteToken(created.invites.viewer, SECRET, created.room.id);
    expect(editor?.role).toBe('editor');
    expect(viewer?.role).toBe('viewer');
    expect(editor?.owner).toBe(session.user.id);
  });

  it('lists the rooms a user belongs to', async () => {
    const session = await guest('Ada');
    const created = await createRoom(session.token);

    const response = await get('/api/rooms', session.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RoomListResponse;
    expect(body.rooms.map((room) => room.id)).toEqual([created.room.id]);
    expect(body.rooms[0]?.role).toBe('owner');
  });

  it('returns a room to a member and hides it from a stranger', async () => {
    const owner = await guest('Owner');
    const stranger = await guest('Stranger');
    const created = await createRoom(owner.token);

    const asOwner = await get(`/api/rooms/${created.room.id}`, owner.token);
    expect(asOwner.status).toBe(200);

    const asStranger = await get(`/api/rooms/${created.room.id}`, stranger.token);
    expect(asStranger.status).toBe(403);
    expect(((await asStranger.json()) as ApiErrorBody).error.code).toBe('forbidden');

    const missing = await get('/api/rooms/room_missing', owner.token);
    expect(missing.status).toBe(404);
  });

  it('lets the owner mint an invite for a chosen role', async () => {
    const owner = await guest('Owner');
    const created = await createRoom(owner.token);

    const response = await post(
      `/api/rooms/${created.room.id}/invites`,
      { role: 'viewer' },
      owner.token,
    );
    expect(response.status).toBe(201);
    const invite = (await response.json()) as CreateInviteResponse;
    expect(invite.role).toBe('viewer');
    expect(verifyInviteToken(invite.token, SECRET, created.room.id)?.role).toBe('viewer');
  });

  it('does not let a viewer mint invites', async () => {
    const owner = await guest('Owner');
    const viewer = await guest('Viewer');
    const created = await createRoom(owner.token);
    await store.grant(created.room.id, viewer.user.id, 'viewer');

    const response = await post(
      `/api/rooms/${created.room.id}/invites`,
      { role: 'editor' },
      viewer.token,
    );
    expect(response.status).toBe(403);
  });

  it('opens the public demo room to any signed-in user', async () => {
    const session = await guest('Ada');
    const response = await get('/api/rooms/demo', session.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { room: { role: string; name: string } };
    expect(body.room.role).toBe('editor');
    expect(body.room.name).toBe('Demo canvas');

    const invite = await post('/api/rooms/demo/invites', { role: 'editor' }, session.token);
    expect(invite.status).toBe(201);
  });

  it('answers CORS preflight for the editor origin', async () => {
    const response = await fetch(`${base}/api/rooms`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });
});
