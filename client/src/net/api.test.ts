import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createInvite, createRoom, httpBaseFor, listRooms, signInGuest } from './api';

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('the HTTP API client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives the HTTP origin from the WebSocket URL', () => {
    expect(httpBaseFor('ws://localhost:8080/ws')).toBe('http://localhost:8080');
    expect(httpBaseFor('wss://sync.example.com/ws')).toBe('https://sync.example.com');
    expect(httpBaseFor('not a url')).toBe('http://localhost:8080');
  });

  it('creates a guest session', async () => {
    fetchMock.mockResolvedValue(
      reply({
        token: 'tok',
        user: { id: 'u1', displayName: 'Ada' },
        expiresAt: 123,
      }),
    );

    const session = await signInGuest('http://localhost:8080', 'Ada');
    expect(session.user.id).toBe('u1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/api/auth/guest');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ displayName: 'Ada' }));
  });

  it('sends the bearer token and the requested role when minting an invite', async () => {
    fetchMock.mockResolvedValue(reply({ token: 'invite', role: 'viewer', expiresAt: 456 }));

    const invite = await createInvite('http://localhost:8080', 'tok', 'room_1', 'viewer');
    expect(invite.role).toBe('viewer');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/api/rooms/room_1/invites');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init.body).toBe(JSON.stringify({ role: 'viewer' }));
  });

  it('creates a room and lists rooms', async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply({
          room: {
            id: 'room_1',
            name: 'Design review',
            ownerId: 'u1',
            role: 'owner',
            createdAt: new Date(0).toISOString(),
          },
          invites: { editor: 'e', viewer: 'v' },
        }),
      )
      .mockResolvedValueOnce(reply({ rooms: [] }));

    const created = await createRoom('http://localhost:8080', 'tok', 'Design review');
    expect(created.room.id).toBe('room_1');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ name: 'Design review' }),
    );

    const listed = await listRooms('http://localhost:8080', 'tok');
    expect(listed.rooms).toEqual([]);
  });

  it('turns an API error body into an ApiError', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: { code: 'forbidden', message: 'You do not have access to that room.' } }, 403),
    );

    await expect(listRooms('http://localhost:8080', 'tok')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
      message: 'You do not have access to that room.',
    });
  });

  it('reports an unreachable server as a network ApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const failure = await signInGuest('http://localhost:8080', 'Ada').catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 0, code: 'network' });
  });
});
