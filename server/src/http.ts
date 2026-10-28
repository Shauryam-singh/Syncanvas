import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApiErrorBody,
  CreateInviteResponse,
  CreateRoomResponse,
  RoomInfo,
  RoomRole,
  SessionResponse,
} from '@syncanvas/shared';
import type { ServerConfig } from './config.js';
import { signAccessToken, signInviteToken, verifyAccessToken } from './auth/jwt.js';
import type { RoomRegistry } from './rooms.js';
import { newId, type DocumentRecord, type Store, type User } from './store/index.js';

type ApiErrorCode = ApiErrorBody['error']['code'];

export interface ApiOptions {
  store: Store;
  registry: RoomRegistry;
  config: Pick<
    ServerConfig,
    'jwtSecret' | 'jwtTtlSeconds' | 'inviteTtlSeconds' | 'publicDemoRoom' | 'corsOrigin'
  >;
  /** Reported by `/healthz` so a scaled deployment is observable. */
  busKind?: 'redis' | 'memory' | null;
  instanceId?: string;
  logger?: Pick<Console, 'error'>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const BODY_LIMIT_BYTES = 64 * 1024;

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, origin: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new HttpError(413, 'invalid_request', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_request', 'Expected a JSON object.');
  }
}

function roomName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = value.trim().slice(0, 80);
  return name.length > 0 ? name : fallback;
}

function roomInfo(document: DocumentRecord, role: RoomRole): RoomInfo {
  return {
    id: document.id,
    name: document.name,
    ownerId: document.ownerId,
    role,
    createdAt: document.createdAt.toISOString(),
  };
}

/**
 * HTTP surface: identity and access only.
 *
 * The editor talks to this API to sign in, create rooms and mint share links;
 * the scene itself never travels over HTTP. Every room route is authenticated
 * and every share link is a signed token bound to one room and one role.
 */
export function createApiHandler(
  options: ApiOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, registry, config } = options;
  const logger = options.logger ?? console;
  const origin = config.corsOrigin;

  async function requireUser(req: IncomingMessage): Promise<User> {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
    const claims = verifyAccessToken(token, config.jwtSecret);
    if (!claims) throw new HttpError(401, 'unauthorized', 'That session is invalid or expired.');
    const user = await store.user(claims.sub);
    if (!user) throw new HttpError(401, 'unauthorized', 'That account no longer exists.');
    return user;
  }

  /** Membership, with the public demo room open to every signed-in user. */
  async function roleFor(user: User, roomId: string): Promise<RoomRole | null> {
    const membership = await store.membership(roomId, user.id);
    if (membership) return membership;
    if (roomId === config.publicDemoRoom) return 'editor';
    return null;
  }

  function invitesFor(document: DocumentRecord): { editor: string; viewer: string } {
    const editor = signInviteToken(
      { roomId: document.id, role: 'editor', ownerId: document.ownerId },
      config.jwtSecret,
      config.inviteTtlSeconds,
    );
    const viewer = signInviteToken(
      { roomId: document.id, role: 'viewer', ownerId: document.ownerId },
      config.jwtSecret,
      config.inviteTtlSeconds,
    );
    return { editor: editor.token, viewer: viewer.token };
  }

  async function guest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const requested = typeof body.displayName === 'string' ? body.displayName : 'Guest';
    const user = await store.createUser(requested);
    const session = signAccessToken(user, config.jwtSecret, config.jwtTtlSeconds);
    const response: SessionResponse = {
      token: session.token,
      user: { id: user.id, displayName: user.displayName },
      expiresAt: session.expiresAt,
    };
    sendJson(res, 200, response, origin);
  }

  async function updateProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await requireUser(req);
    const body = await readJson(req);
    const requested = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const displayName = requested.replace(/\s+/g, ' ').slice(0, 40);
    if (!displayName) {
      throw new HttpError(400, 'invalid_request', 'Enter a display name.');
    }

    const updated = await store.renameUser(user.id, displayName);
    if (!updated) throw new HttpError(401, 'unauthorized', 'That account no longer exists.');
    const session = signAccessToken(updated, config.jwtSecret, config.jwtTtlSeconds);
    const response: SessionResponse = {
      token: session.token,
      user: { id: updated.id, displayName: updated.displayName },
      expiresAt: session.expiresAt,
    };
    sendJson(res, 200, response, origin);
  }

  async function createRoom(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await requireUser(req);
    const body = await readJson(req);
    const name = roomName(body.name, `${user.displayName}'s room`);

    let id = newId('room');
    for (let attempt = 0; attempt < 5 && (await store.document(id)); attempt += 1) {
      id = newId('room');
    }
    const document = await store.createDocument({ id, name, ownerId: user.id });
    // Make the room joinable immediately, seeded exactly like the demo.
    registry.ensureRoom(document.id);

    const response: CreateRoomResponse = {
      room: roomInfo(document, 'owner'),
      invites: invitesFor(document),
    };
    sendJson(res, 201, response, origin);
  }

  async function listRooms(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await requireUser(req);
    const documents = await store.documentsFor(user.id);
    sendJson(
      res,
      200,
      { rooms: documents.map(({ document, role }) => roomInfo(document, role)) },
      origin,
    );
  }

  async function getRoom(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
    const user = await requireUser(req);
    const document = await store.document(roomId);
    if (!document) throw new HttpError(404, 'not_found', 'That room does not exist.');
    const role = await roleFor(user, roomId);
    if (!role) throw new HttpError(403, 'forbidden', 'You do not have access to that room.');
    sendJson(res, 200, { room: roomInfo(document, role) }, origin);
  }

  async function createInvite(
    req: IncomingMessage,
    res: ServerResponse,
    roomId: string,
  ): Promise<void> {
    const user = await requireUser(req);
    const document = await store.document(roomId);
    if (!document) throw new HttpError(404, 'not_found', 'That room does not exist.');
    const role = await roleFor(user, roomId);
    if (!role || role === 'viewer') {
      throw new HttpError(403, 'forbidden', 'Only editors can invite people to that room.');
    }

    const body = await readJson(req);
    const inviteRole = body.role === 'viewer' ? 'viewer' : 'editor';
    const invite = signInviteToken(
      { roomId, role: inviteRole, ownerId: document.ownerId },
      config.jwtSecret,
      config.inviteTtlSeconds,
    );
    const response: CreateInviteResponse = {
      token: invite.token,
      role: inviteRole,
      expiresAt: invite.expiresAt,
    };
    sendJson(res, 201, response, origin);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(
        res,
        200,
        {
          status: 'ok',
          uptime: process.uptime(),
          store: store.kind,
          bus: options.busKind ?? null,
          instance: options.instanceId ?? null,
        },
        origin,
      );
      return;
    }

    if (segments[0] !== 'api') {
      throw new HttpError(404, 'not_found', 'Not found.');
    }

    if (method === 'POST' && segments[1] === 'auth' && segments[2] === 'guest') {
      await guest(req, res);
      return;
    }

    if (method === 'POST' && segments[1] === 'auth' && segments[2] === 'profile') {
      await updateProfile(req, res);
      return;
    }

    if (segments[1] === 'rooms') {
      if (method === 'POST' && segments.length === 2) {
        await createRoom(req, res);
        return;
      }
      if (method === 'GET' && segments.length === 2) {
        await listRooms(req, res);
        return;
      }
      const roomId = segments[2] ? decodeURIComponent(segments[2]) : '';
      if (roomId.length === 0 || roomId.length > 80) {
        throw new HttpError(404, 'not_found', 'That room does not exist.');
      }
      if (method === 'GET' && segments.length === 3) {
        await getRoom(req, res, roomId);
        return;
      }
      if (method === 'POST' && segments.length === 4 && segments[3] === 'invites') {
        await createInvite(req, res, roomId);
        return;
      }
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }

  return (req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(
          res,
          error.status,
          { error: { code: error.code, message: error.message } },
          origin,
        );
        return;
      }
      logger.error('HTTP request failed:', error);
      sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong.' } }, origin);
    });
  };
}
