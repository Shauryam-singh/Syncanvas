import type {
  ApiErrorBody,
  CreateInviteResponse,
  CreateRoomResponse,
  RoomInfo,
  RoomListResponse,
  RoomRole,
  SessionResponse,
} from '@syncanvas/shared';

/** An error returned by the HTTP API, with the server's error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Derives the HTTP origin from the WebSocket URL.
 *
 * The gateway serves both the API and the socket, so `ws://host:8080/ws`
 * becomes `http://host:8080`. Deployments behind a proxy can override the
 * socket URL with `?ws=`; the API follows it automatically.
 */
export function httpBaseFor(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return url.origin;
  } catch {
    return 'http://localhost:8080';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network', 'Could not reach the Syncanvas server.');
  }

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // The server may not have sent JSON (a proxy error page, for example).
    }
    throw new ApiError(
      response.status,
      body?.error.code ?? 'internal',
      body?.error.message ?? `Request failed with status ${response.status}.`,
    );
  }

  return (await response.json()) as T;
}

/** Creates a guest identity. There are no passwords yet (see DESIGN.md). */
export function signInGuest(
  base: string,
  displayName: string,
  signal?: AbortSignal,
): Promise<SessionResponse> {
  return request<SessionResponse>(base, '/api/auth/guest', {
    method: 'POST',
    body: { displayName },
    signal,
  });
}

export function createRoom(
  base: string,
  token: string,
  name?: string,
  signal?: AbortSignal,
): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>(base, '/api/rooms', {
    method: 'POST',
    token,
    body: { name },
    signal,
  });
}

export function listRooms(
  base: string,
  token: string,
  signal?: AbortSignal,
): Promise<RoomListResponse> {
  return request<RoomListResponse>(base, '/api/rooms', { token, signal });
}

export function getRoom(
  base: string,
  token: string,
  roomId: string,
  signal?: AbortSignal,
): Promise<{ room: RoomInfo }> {
  return request<{ room: RoomInfo }>(base, `/api/rooms/${encodeURIComponent(roomId)}`, {
    token,
    signal,
  });
}

export function createInvite(
  base: string,
  token: string,
  roomId: string,
  role: Exclude<RoomRole, 'owner'>,
  signal?: AbortSignal,
): Promise<CreateInviteResponse> {
  return request<CreateInviteResponse>(base, `/api/rooms/${encodeURIComponent(roomId)}/invites`, {
    method: 'POST',
    token,
    body: { role },
    signal,
  });
}
