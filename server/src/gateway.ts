import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseClientMessage,
  type ClientMessage,
  type OpEnvelope,
  type ServerMessage,
} from '@syncanvas/shared';
import { RoomRegistry, type RoomMember } from './rooms.js';

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

interface Client {
  /** Server-assigned identity — the client cannot choose it. */
  id: string;
  socket: WebSocket;
  displayName: string;
  color: string;
  rooms: Set<string>;
  authenticated: boolean;
}

export interface GatewayOptions {
  /** Path the WebSocket upgrade is accepted on. */
  path?: string;
  registry?: RoomRegistry;
}

/**
 * The WebSocket gateway.
 *
 * It owns the transport: identities, room membership, sequence numbers and
 * fan-out. Every batch is merged into the room's CRDT document and broadcast
 * to the room — the author included — so every replica merges the same set of
 * envelopes. The sequence number is a broadcast watermark, not a merge rule:
 * the winner of a conflict is decided by `(HLC, opId)` on every replica.
 */
export function createGateway(
  server: HttpServer,
  options: GatewayOptions = {},
): { wss: WebSocketServer; registry: RoomRegistry } {
  const registry = options.registry ?? new RoomRegistry();
  const wss = new WebSocketServer({ server, path: options.path ?? '/ws' });
  const clients = new Map<string, Client>();
  let colorCursor = 0;

  function send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.socket.send(JSON.stringify(message));
  }

  function broadcast(roomId: string, message: ServerMessage, except?: Client): void {
    const room = registry.room(roomId);
    if (!room) return;
    const payload = JSON.stringify(message);
    for (const member of room.members.values()) {
      const target = clients.get(member.clientId);
      if (!target || target === except) continue;
      if (target.socket.readyState === target.socket.OPEN) target.socket.send(payload);
    }
  }

  function broadcastPeers(roomId: string): void {
    broadcast(roomId, { t: 'presence', roomId, peers: registry.peers(roomId) });
  }

  function memberOf(client: Client): RoomMember {
    return {
      clientId: client.id,
      displayName: client.displayName,
      color: client.color,
      cursor: null,
      selection: [],
      joinedAt: Date.now(),
    };
  }

  function handleOps(client: Client, roomId: string, envelopes: readonly OpEnvelope[]): void {
    if (envelopes.length === 0) return;

    // The actor id is the server's, not the client's: a client cannot
    // impersonate another peer by forging an envelope.
    const stamped = envelopes.map((envelope) => ({
      ...envelope,
      actorId: client.id,
      hlc: { ...envelope.hlc, actorId: client.id },
    }));

    const result = registry.applyOps(roomId, stamped);

    if (result.accepted.length > 0) {
      // The author receives the broadcast too. Every replica — including the
      // author — merges the same envelopes through the same CRDT, which is
      // what keeps them identical; the sequence number only orders the wire.
      broadcast(roomId, { t: 'ops', roomId, seq: result.seq, ops: result.accepted });
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
      const snapshot = registry.snapshot(roomId);
      send(client, {
        t: 'state',
        roomId,
        snapshotSeq: snapshot.snapshotSeq,
        objects: snapshot.objects,
        ops: [],
      });
    }
  }

  function handleSync(client: Client, roomId: string, opIds: readonly string[]): void {
    const room = registry.ensureRoom(roomId);
    const known = opIds.filter((id) => room.doc.seen.has(id));
    send(client, { t: 'ack', roomId, opIds: known, seq: room.seq });
    const snapshot = registry.snapshot(roomId);
    send(client, {
      t: 'state',
      roomId,
      snapshotSeq: snapshot.snapshotSeq,
      objects: snapshot.objects,
      ops: [],
    });
  }

  function handleMessage(client: Client, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) {
      send(client, {
        t: 'error',
        code: 'invalid_message',
        message: 'The gateway could not understand that message.',
      });
      return;
    }
    dispatch(client, message);
  }

  function dispatch(client: Client, message: ClientMessage): void {
    switch (message.t) {
      case 'auth': {
        client.authenticated = true;
        if (message.displayName) client.displayName = message.displayName;
        send(client, {
          t: 'welcome',
          userId: client.id,
          displayName: client.displayName,
          color: client.color,
        });
        return;
      }

      case 'join': {
        const room = registry.ensureRoom(message.roomId);
        registry.join(message.roomId, memberOf(client));
        client.rooms.add(message.roomId);
        send(client, {
          t: 'joined',
          roomId: message.roomId,
          role: 'editor',
          snapshotSeq: room.seq,
          peers: registry.peers(message.roomId),
        });
        const snapshot = registry.snapshot(message.roomId);
        send(client, {
          t: 'state',
          roomId: message.roomId,
          snapshotSeq: snapshot.snapshotSeq,
          objects: snapshot.objects,
          ops: [],
        });
        broadcastPeers(message.roomId);
        return;
      }

      case 'leave': {
        registry.leave(message.roomId, client.id);
        client.rooms.delete(message.roomId);
        broadcastPeers(message.roomId);
        return;
      }

      case 'ops': {
        handleOps(client, message.roomId, message.ops);
        return;
      }

      case 'presence': {
        const room = registry.room(message.roomId);
        const member = room?.members.get(client.id);
        if (member) {
          member.cursor = message.cursor;
          member.selection = message.selection;
        }
        broadcastPeers(message.roomId);
        return;
      }

      case 'sync': {
        handleSync(client, message.roomId, message.opIds);
        return;
      }

      case 'ping': {
        send(client, { t: 'pong' });
        return;
      }
    }
  }

  wss.on('connection', (socket) => {
    const id = `user_${randomUUID().slice(0, 8)}`;
    const color = PEER_COLORS[colorCursor % PEER_COLORS.length] as string;
    colorCursor += 1;

    const client: Client = {
      id,
      socket,
      displayName: 'Guest',
      color,
      rooms: new Set(),
      authenticated: false,
    };
    clients.set(id, client);

    socket.on('message', (data) => {
      handleMessage(client, data.toString());
    });

    socket.on('close', () => {
      const rooms = registry.leaveAll(client.id);
      clients.delete(client.id);
      for (const roomId of rooms) broadcastPeers(roomId);
    });

    socket.on('error', () => {
      // The socket is going away; `close` does the cleanup.
    });
  });

  return { wss, registry };
}
