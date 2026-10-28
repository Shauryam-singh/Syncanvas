import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseClientMessage,
  type ClientMessage,
  type OpEnvelope,
  type RoomRole,
  type ServerMessage,
} from '@syncanvas/shared';
import { verifyAccessToken, verifyInviteToken } from './auth/jwt.js';
import type { BusMessage, OpsMessage, RoomBus } from './bus.js';
import type { ServerConfig } from './config.js';
import { loadRoom, type RoomPersistence } from './persistence.js';
import { RoomRegistry, type RoomMember } from './rooms.js';
import type { DocumentRecord, Store, User } from './store/index.js';

/** Colours handed out to peers, in the order they join a room. */
const PEER_COLORS = [
  '#6366f1',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#a855f7',
  '#ec4899',
  '#84cc16',
];

/** How long a socket may stay unauthenticated. */
const AUTH_TIMEOUT_MS = 15_000;

/** Maximum coordinate magnitude accepted from a cursor update. */
const MAX_CURSOR_COORDINATE = 100_000;

/** Minimum gap between forwarded presence frames (≈66 Hz server guard). */
const PRESENCE_MIN_INTERVAL_MS = 15;

interface Client {
  /** Per-connection session id — the presence key. */
  id: string;
  socket: WebSocket;
  userId: string | null;
  displayName: string;
  color: string;
  rooms: Set<string>;
  authenticated: boolean;
  lastPresenceAt: number;
  authTimer: NodeJS.Timeout;
}

export interface GatewayOptions {
  /** Path the WebSocket upgrade is accepted on. */
  path?: string;
  registry?: RoomRegistry;
  store: Store;
  config: Pick<
    ServerConfig,
    'jwtSecret' | 'publicDemoRoom' | 'maxOpsPerBatch' | 'presenceTtlMs' | 'presenceSweepMs'
  >;
  persistence?: RoomPersistence;
  /** Redis (or in-memory test) fan-out. Omit for a standalone gateway. */
  bus?: RoomBus;
  logger?: Pick<Console, 'error' | 'warn'>;
}

/**
 * The WebSocket gateway.
 *
 * It owns the transport: identities, access control, presence and fan-out.
 * Every accepted batch is merged into the room's CRDT document and broadcast
 * to the room — the author included — so every replica merges the same set of
 * envelopes. The sequence number is a broadcast watermark, not a merge rule:
 * the winner of a conflict is decided by `(HLC, opId)` on every replica.
 *
 * Roles are enforced here, not in the client: a viewer's `ops` frame is
 * rejected before it reaches the document, and a join without a membership or
 * a signed invite is refused.
 */
export function createGateway(
  server: HttpServer,
  options: GatewayOptions,
): { wss: WebSocketServer; registry: RoomRegistry; drain: () => Promise<void> } {
  const registry = options.registry ?? new RoomRegistry();
  const { store, config, bus } = options;
  const persistence = options.persistence;
  const logger = options.logger ?? console;
  const wss = new WebSocketServer({
    server,
    path: options.path ?? '/ws',
    maxPayload: 1_000_000,
  });
  const clients = new Map<string, Client>();
  const busQueues = new Map<string, Promise<void>>();
  let colorCursor = 0;

  function send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  }

  function sendError(
    client: Client,
    code: Extract<ServerMessage, { t: 'error' }>['code'],
    message: string,
    extra: { roomId?: string; opIds?: string[] } = {},
  ): void {
    send(client, { t: 'error', code, message, ...extra });
  }

  function closeUnauthorized(client: Client, message: string): void {
    sendError(client, 'unauthorized', message);
    // 4001 is application-defined: "authenticate first / token rejected".
    client.socket.close(4001, 'unauthorized');
    clearTimeout(client.authTimer);
  }

  function broadcast(roomId: string, message: ServerMessage): void {
    const room = registry.room(roomId);
    if (!room) return;
    const payload = JSON.stringify(message);
    for (const member of room.members.values()) {
      const target = clients.get(member.sessionId);
      if (!target || target.socket.readyState !== target.socket.OPEN) continue;
      target.socket.send(payload);
    }
  }

  function broadcastPeers(roomId: string): void {
    if (!registry.room(roomId)) return;
    broadcast(roomId, { t: 'presence', roomId, peers: registry.peers(roomId) });
  }

  function sendState(client: Client, roomId: string): void {
    const snapshot = registry.snapshot(roomId);
    send(client, {
      t: 'state',
      roomId,
      snapshotSeq: snapshot.snapshotSeq,
      objects: snapshot.objects,
      ops: [],
    });
  }

  /** Publishes ephemeral presence to the other gateways, if any. */
  function publishPresence(roomId: string, member: RoomMember): void {
    if (!bus) return;
    void bus.publishPresence(roomId, member.sessionId, member).catch((error: unknown) => {
      logger.warn(`Could not publish presence for room ${roomId}:`, error);
    });
  }

  function publishPresenceLeave(roomId: string, sessionId: string): void {
    if (!bus) return;
    void bus.publishPresence(roomId, sessionId, null).catch((error: unknown) => {
      logger.warn(`Could not publish presence leave for room ${roomId}:`, error);
    });
  }

  /**
   * Serializes bus work per room. Redis publishes in order, but loading a room
   * is async; without this queue two batches could apply out of order while
   * their snapshot load is in flight.
   */
  function enqueueBus(roomId: string, task: () => Promise<void>): void {
    const previous = busQueues.get(roomId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      logger.error(`Room-bus work for ${roomId} failed:`, error);
    });
    busQueues.set(roomId, next);
    void next.finally(() => {
      if (busQueues.get(roomId) === next) busQueues.delete(roomId);
    });
  }

  async function drain(): Promise<void> {
    while (busQueues.size > 0) {
      await Promise.all([...busQueues.values()]);
    }
  }

  /** Builds the presence record for a connection that just joined. */
  function memberOf(client: Client, role: RoomRole): RoomMember {
    const now = Date.now();
    return {
      sessionId: client.id,
      userId: client.userId ?? '',
      role,
      displayName: client.displayName,
      color: client.color,
      cursor: null,
      selection: [],
      joinedAt: now,
      lastSeen: now,
    };
  }

  /**
   * Recreates a room from a valid invite.
   *
   * Rooms live in Postgres in production, so this only matters when the store
   * is ephemeral (memory mode / a wiped database) or a gateway restarts before
   * its first snapshot. A signed invite is already a capability for this room;
   * letting it seed the empty room keeps share links useful instead of
   * silently dead.
   */
  async function recreateRoom(
    roomId: string,
    inviteOwnerId: string,
    joiningUserId: string,
  ): Promise<DocumentRecord> {
    const existing = await store.document(roomId);
    if (existing) return existing;
    const owner = (await store.user(inviteOwnerId)) ? inviteOwnerId : joiningUserId;
    try {
      const document = await store.createDocument({
        id: roomId,
        name: 'Shared room',
        ownerId: owner,
      });
      registry.ensureRoom(roomId);
      return document;
    } catch (error) {
      // Two clients may race to redeem the same link; the loser re-reads.
      const raced = await store.document(roomId);
      if (raced) return raced;
      throw error;
    }
  }

  /**
   * Resolves the role for a join, or `null` when access is denied.
   * Membership wins; an invite is the fallback and is then persisted as a
   * membership so reconnects (and refreshes) keep working.
   */
  async function authorizeJoin(
    user: User,
    roomId: string,
    invite: string | undefined,
  ): Promise<{ role: RoomRole; document: DocumentRecord } | null> {
    const membership = await store.membership(roomId, user.id);
    if (membership) {
      const document = await store.document(roomId);
      if (!document) return null;
      return { role: membership, document };
    }

    if (roomId === config.publicDemoRoom) {
      const document = await store.document(roomId);
      if (!document) return null;
      return { role: 'editor', document };
    }

    if (!invite) return null;
    const claims = verifyInviteToken(invite, config.jwtSecret, roomId);
    if (!claims) return null;

    const document = await recreateRoom(roomId, claims.owner, user.id);
    const role = await store.grant(roomId, user.id, claims.role);
    return { role, document };
  }

  async function authenticate(client: Client, token: string): Promise<void> {
    const claims = verifyAccessToken(token, config.jwtSecret);
    if (!claims) {
      closeUnauthorized(client, 'That session is invalid or has expired.');
      return;
    }
    const user = await store.user(claims.sub);
    if (!user) {
      closeUnauthorized(client, 'That account no longer exists.');
      return;
    }

    client.userId = user.id;
    client.displayName = user.displayName;
    client.authenticated = true;
    clearTimeout(client.authTimer);
    send(client, {
      t: 'welcome',
      userId: user.id,
      sessionId: client.id,
      displayName: user.displayName,
      color: client.color,
    });
  }

  async function join(client: Client, roomId: string, invite: string | undefined): Promise<void> {
    if (!client.authenticated || !client.userId) {
      closeUnauthorized(client, 'Authenticate before joining a room.');
      return;
    }
    const user = await store.user(client.userId);
    if (!user) {
      closeUnauthorized(client, 'That account no longer exists.');
      return;
    }

    let access: { role: RoomRole; document: DocumentRecord } | null;
    try {
      access = await authorizeJoin(user, roomId, invite);
    } catch (error) {
      logger.error(`Could not authorize a join for room ${roomId}:`, error);
      sendError(client, 'internal', 'Could not join that room.', { roomId });
      return;
    }
    if (!access) {
      sendError(
        client,
        'forbidden',
        invite
          ? 'That share link is not valid for this room.'
          : 'You need a share link or an invitation to join this room.',
        { roomId },
      );
      return;
    }

    let room;
    try {
      room = await loadRoom(store, registry, roomId);
    } catch (error) {
      logger.error(`Could not load room ${roomId}:`, error);
      sendError(client, 'internal', 'Could not load that room.', { roomId });
      return;
    }

    const member = memberOf(client, access.role);
    registry.join(roomId, member);
    client.rooms.add(roomId);

    send(client, {
      t: 'joined',
      roomId,
      name: access.document.name,
      role: access.role,
      snapshotSeq: room.seq,
      peers: registry.peers(roomId),
    });
    sendState(client, roomId);
    broadcastPeers(roomId);
    publishPresence(roomId, member);
  }

  async function handleOps(
    client: Client,
    roomId: string,
    envelopes: readonly OpEnvelope[],
  ): Promise<void> {
    if (envelopes.length === 0) return;

    const role = registry.roleOf(roomId, client.id);
    if (!role || !client.userId) {
      sendError(client, 'forbidden', 'Join the room before editing it.', {
        roomId,
        opIds: envelopes.map((envelope) => envelope.id),
      });
      return;
    }
    if (role === 'viewer') {
      sendError(client, 'forbidden', 'Viewers cannot edit this room.', {
        roomId,
        opIds: envelopes.map((envelope) => envelope.id),
      });
      return;
    }
    if (envelopes.length > config.maxOpsPerBatch) {
      sendError(client, 'rate_limited', 'That batch is too large.', {
        roomId,
        opIds: envelopes.map((envelope) => envelope.id),
      });
      return;
    }

    registry.touch(roomId, client.id);

    // The actor id is the server's, not the client's: a client cannot
    // impersonate another peer by forging an envelope.
    const stamped = envelopes.map((envelope) => ({
      ...envelope,
      actorId: client.userId as string,
      hlc: { ...envelope.hlc, actorId: client.userId as string },
    }));

    const room = registry.ensureRoom(roomId);
    const preview = registry.previewOps(roomId, stamped);

    if (preview.accepted.length === 0) {
      // A pure resend: acknowledge every id, then hand the author the current
      // projection in case the original broadcast was lost.
      send(client, {
        t: 'ack',
        roomId,
        opIds: stamped.map((envelope) => envelope.id),
        seq: room.seq,
      });
      sendState(client, roomId);
      return;
    }

    if (bus) {
      // The bus, not this process, applies and broadcasts the batch. That
      // makes every gateway see the same order and the same room watermark.
      try {
        await bus.publishOps(
          {
            roomId,
            sessionId: client.id,
            ackIds: stamped.map((envelope) => envelope.id),
            ops: preview.accepted,
          },
          room.seq,
        );
      } catch (error) {
        logger.error(`Could not publish operations for room ${roomId}:`, error);
        sendError(client, 'internal', 'Could not persist that edit. Retrying.', {
          roomId,
          opIds: stamped.map((envelope) => envelope.id),
        });
        // Drop the socket so the client reconnects and resends its outbox.
        client.socket.close(1011, 'room bus unavailable');
      }
      return;
    }

    const result = registry.applyOps(roomId, stamped);

    if (result.accepted.length > 0) {
      // The author receives the broadcast too. Every replica — including the
      // author — merges the same envelopes through the same CRDT, which is
      // what keeps them identical; the sequence number only orders the wire.
      broadcast(roomId, { t: 'ops', roomId, seq: result.seq, ops: result.accepted });
      persistence?.append(roomId, result.seq, result.accepted);
    }

    send(client, {
      t: 'ack',
      roomId,
      // Every id in the batch is acknowledged — including the ones that were
      // duplicates — so the client can drop them from its outbox.
      opIds: stamped.map((envelope) => envelope.id),
      seq: result.seq,
    });

    if (result.duplicates.length > 0) {
      // The client re-sent something we already have — it missed the
      // broadcast (a dropped connection). Hand it the authoritative state so
      // it can catch up instead of guessing.
      sendState(client, roomId);
    }
  }

  function handleSync(client: Client, roomId: string, opIds: readonly string[]): void {
    if (!registry.roleOf(roomId, client.id)) {
      sendError(client, 'forbidden', 'You are not in that room.', { roomId });
      return;
    }
    registry.touch(roomId, client.id);
    const room = registry.ensureRoom(roomId);
    const known = opIds.filter((id) => room.doc.seen.has(id));
    send(client, { t: 'ack', roomId, opIds: known, seq: room.seq });
    sendState(client, roomId);
  }

  function handlePresence(
    client: Client,
    roomId: string,
    cursor: { x: number; y: number } | null,
    selection: readonly string[],
  ): void {
    if (!registry.roleOf(roomId, client.id)) return;
    const now = Date.now();
    if (now - client.lastPresenceAt < PRESENCE_MIN_INTERVAL_MS) return;
    client.lastPresenceAt = now;

    const safeCursor = cursor
      ? {
          x: Math.max(-MAX_CURSOR_COORDINATE, Math.min(MAX_CURSOR_COORDINATE, cursor.x)),
          y: Math.max(-MAX_CURSOR_COORDINATE, Math.min(MAX_CURSOR_COORDINATE, cursor.y)),
        }
      : null;
    const member = registry.updatePresence(
      roomId,
      client.id,
      safeCursor,
      selection.slice(0, 1_000),
      now,
    );
    broadcastPeers(roomId);
    if (member) publishPresence(roomId, member);
  }

  function handleMessage(client: Client, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) {
      sendError(client, 'invalid_message', 'The gateway could not understand that message.');
      return;
    }
    dispatch(client, message);
  }

  function dispatch(client: Client, message: ClientMessage): void {
    switch (message.t) {
      case 'auth':
        void authenticate(client, message.token).catch((error: unknown) => {
          logger.error('Authentication failed:', error);
          closeUnauthorized(client, 'Could not authenticate that session.');
        });
        return;

      case 'join':
        void join(client, message.roomId, message.invite).catch((error: unknown) => {
          logger.error('Join failed:', error);
          sendError(client, 'internal', 'Could not join that room.', { roomId: message.roomId });
        });
        return;

      case 'leave': {
        registry.leave(message.roomId, client.id);
        client.rooms.delete(message.roomId);
        broadcastPeers(message.roomId);
        publishPresenceLeave(message.roomId, client.id);
        return;
      }

      case 'ops':
        void handleOps(client, message.roomId, message.ops).catch((error: unknown) => {
          logger.error('Operation batch failed:', error);
          sendError(client, 'internal', 'Could not apply that edit.', {
            roomId: message.roomId,
            opIds: message.ops.map((envelope) => envelope.id),
          });
        });
        return;

      case 'presence':
        handlePresence(client, message.roomId, message.cursor, message.selection);
        return;

      case 'sync':
        handleSync(client, message.roomId, message.opIds);
        return;

      case 'ping': {
        for (const roomId of client.rooms) {
          const member = registry.touch(roomId, client.id);
          // Remote gateways use this heartbeat to keep the roster alive.
          if (member) publishPresence(roomId, member);
        }
        send(client, { t: 'pong' });
        return;
      }
    }
  }

  async function applyBusOps(message: OpsMessage): Promise<void> {
    const room = await loadRoom(store, registry, message.roomId);
    const result = registry.applyOps(message.roomId, message.ops, message.seq);

    if (result.accepted.length > 0) {
      broadcast(message.roomId, {
        t: 'ops',
        roomId: message.roomId,
        // `room.seq` and the bus sequence can differ only when this replica
        // replayed the operation from Postgres before the frame arrived.
        seq: message.seq,
        ops: result.accepted,
      });
      persistence?.append(message.roomId, message.seq, result.accepted);
    } else if (registry.room(message.roomId)?.members.size) {
      // A fully-duplicate publication still consumes a global sequence. Send
      // an empty frame so connected clients advance their contiguous
      // watermark instead of waiting forever for this sequence.
      broadcast(message.roomId, { t: 'ops', roomId: message.roomId, seq: message.seq, ops: [] });
    }

    if (message.origin !== bus?.instanceId) return;
    const author = clients.get(message.sessionId);
    if (!author) return;

    // Broadcast before ack: the client's `mine` bookkeeping uses its outbox,
    // so it must see its own echo while the entries are still pending.
    send(author, {
      t: 'ack',
      roomId: message.roomId,
      opIds: message.ackIds,
      seq: message.seq,
    });
    if (result.duplicates.length > 0) sendState(author, message.roomId);

    // Keep the local watermark honest if the room was loaded from a newer
    // snapshot than the one this batch was allocated against.
    if (room.seq < message.seq) room.seq = message.seq;
  }

  function onBusMessage(message: BusMessage): void {
    if (message.t === 'presence') {
      if (message.origin === bus?.instanceId) return;
      if (message.member) {
        registry.upsertRemote(message.roomId, { ...message.member, lastSeen: Date.now() });
      } else {
        registry.removeRemote(message.roomId, message.sessionId);
      }
      broadcastPeers(message.roomId);
      return;
    }

    enqueueBus(message.roomId, async () => {
      try {
        await applyBusOps(message);
      } catch (error) {
        // A failed frame cannot be replayed from Redis. Invalidate this
        // replica and close its clients in the room so they reconnect, load
        // the authoritative room and resend any unacknowledged outbox
        // entries; continuing would leave them behind the bus order.
        const room = registry.room(message.roomId);
        if (room) room.loaded = false;
        for (const client of clients.values()) {
          if (client.rooms.has(message.roomId)) {
            client.socket.close(1011, 'room unavailable');
          }
        }
        throw error;
      }
    });
  }

  if (bus) bus.subscribe(onBusMessage);

  wss.on('connection', (socket) => {
    const id = `sess_${randomUUID().slice(0, 12)}`;
    const color = PEER_COLORS[colorCursor % PEER_COLORS.length] as string;
    colorCursor += 1;

    const client: Client = {
      id,
      socket,
      userId: null,
      displayName: 'Guest',
      color,
      rooms: new Set(),
      authenticated: false,
      lastPresenceAt: 0,
      authTimer: setTimeout(() => {
        if (!client.authenticated)
          closeUnauthorized(client, 'Authenticate before using the gateway.');
      }, AUTH_TIMEOUT_MS),
    };
    client.authTimer.unref();
    clients.set(id, client);

    socket.on('message', (data) => {
      handleMessage(client, data.toString());
    });

    socket.on('close', () => {
      clearTimeout(client.authTimer);
      const rooms = registry.leaveAll(client.id);
      clients.delete(client.id);
      for (const roomId of rooms) {
        publishPresenceLeave(roomId, client.id);
        broadcastPeers(roomId);
      }
    });

    socket.on('error', () => {
      // The socket is going away; `close` does the cleanup.
    });
  });

  // Backstop for half-open sockets that never emit `close`.
  const sweeper = setInterval(() => {
    const changed = registry.sweep(Date.now(), config.presenceTtlMs);
    for (const roomId of changed) broadcastPeers(roomId);
  }, config.presenceSweepMs);
  sweeper.unref();
  wss.on('close', () => clearInterval(sweeper));

  return { wss, registry, drain };
}
