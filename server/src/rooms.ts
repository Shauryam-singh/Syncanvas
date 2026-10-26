import {
  createDoc,
  createInitialScene,
  mergeEnvelopes,
  serializeScene,
  toSceneState,
  type OpEnvelope,
  type PeerPresence,
  type RoomRole,
  type SceneDoc,
  type SceneObject,
} from '@syncanvas/shared';

/** A connection that has joined a room. One user may have several sessions. */
export interface RoomMember {
  /** Per-connection id; presence is keyed by this, not by user. */
  sessionId: string;
  /** The signed-in user behind the connection. */
  userId: string;
  role: RoomRole;
  displayName: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  joinedAt: number;
  /** Refreshed by presence, operations, sync and heartbeats. */
  lastSeen: number;
}

export interface Room {
  id: string;
  /**
   * The replicated document — the single source of truth for the room.
   *
   * The gateway no longer decides who wins: every accepted operation is
   * merged with the CRDT, so the state depends only on the set of operations
   * the room has seen, not on the order they arrived in.
   */
  doc: SceneDoc;
  /** Sequence number of the last accepted batch (the broadcast watermark). */
  seq: number;
  /** Members keyed by session id. */
  members: Map<string, RoomMember>;
  /** Number of accepted operations since the last persisted snapshot. */
  opsSinceSnapshot: number;
}

export interface ApplyResult {
  /** The sequence number assigned to this batch. */
  seq: number;
  /** Operations that were new and are now part of the room state. */
  accepted: OpEnvelope[];
  /** Ids of operations that had already been applied. */
  duplicates: string[];
}

export interface RoomSnapshot {
  snapshotSeq: number;
  objects: SceneObject[];
}

/**
 * The in-memory room registry — the gateway's brain.
 *
 * Deliberately free of any WebSocket or database code so merge semantics,
 * roles and presence TTLs can be unit tested on their own.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  /** Returns the room, creating it (seeded with the demo scene) if needed. */
  ensureRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const room: Room = {
      id: roomId,
      doc: createDoc(createInitialScene()),
      seq: 0,
      members: new Map(),
      opsSinceSnapshot: 0,
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * Replaces (or creates) a room with a document loaded from persistence.
   * Used on startup after replaying the operation log.
   */
  installRoom(input: { id: string; doc: SceneDoc; seq: number }): Room {
    const room: Room = {
      id: input.id,
      doc: input.doc,
      seq: input.seq,
      members: this.rooms.get(input.id)?.members ?? new Map(),
      opsSinceSnapshot: 0,
    };
    this.rooms.set(input.id, room);
    return room;
  }

  room(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /** Adds a member to a room. Re-joining replaces the previous session. */
  join(roomId: string, member: RoomMember): Room {
    const room = this.ensureRoom(roomId);
    room.members.set(member.sessionId, member);
    return room;
  }

  /** Removes a member. The room itself is kept so its state survives. */
  leave(roomId: string, sessionId: string): void {
    this.rooms.get(roomId)?.members.delete(sessionId);
  }

  /** Removes a session from every room it joined (used on disconnect). */
  leaveAll(sessionId: string): string[] {
    const left: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.delete(sessionId)) left.push(room.id);
    }
    return left;
  }

  roleOf(roomId: string, sessionId: string): RoomRole | null {
    return this.rooms.get(roomId)?.members.get(sessionId)?.role ?? null;
  }

  /** Marks a session as alive. Returns the member, if still in the room. */
  touch(roomId: string, sessionId: string, now = Date.now()): RoomMember | null {
    const member = this.rooms.get(roomId)?.members.get(sessionId);
    if (member) member.lastSeen = now;
    return member ?? null;
  }

  updatePresence(
    roomId: string,
    sessionId: string,
    cursor: { x: number; y: number } | null,
    selection: readonly string[],
    now = Date.now(),
  ): RoomMember | null {
    const member = this.rooms.get(roomId)?.members.get(sessionId);
    if (!member) return null;
    member.cursor = cursor;
    member.selection = [...selection];
    member.lastSeen = now;
    return member;
  }

  /**
   * Drops sessions that have not been heard from within `ttlMs`.
   *
   * Disconnects remove the cursor immediately; this is the backstop for
   * half-open sockets, crashed tabs and clients that stop sending heartbeats.
   * Returns the rooms whose roster changed.
   */
  sweep(now = Date.now(), ttlMs = 60_000): string[] {
    const changed: string[] = [];
    for (const room of this.rooms.values()) {
      let removed = false;
      for (const [sessionId, member] of room.members) {
        if (now - member.lastSeen > ttlMs) {
          room.members.delete(sessionId);
          removed = true;
        }
      }
      if (removed) changed.push(room.id);
    }
    return changed;
  }

  /**
   * Merges a batch of operations into the room.
   *
   * The merge is the CRDT's: a property keeps the write with the greatest
   * `(HLC, opId)`, the z-order is an RGA, and a delete tombstones its object.
   * Two replicas that have seen the same operations hold the same document,
   * whatever order the gateway received them in.
   *
   * The sequence number is still assigned per accepted batch because the wire
   * protocol uses it for acknowledgement and catch-up — it is a broadcast
   * watermark, not a merge rule.
   */
  applyOps(roomId: string, envelopes: readonly OpEnvelope[]): ApplyResult {
    const room = this.ensureRoom(roomId);
    const accepted: OpEnvelope[] = [];
    const duplicates: string[] = [];
    const inBatch = new Set<string>();

    for (const envelope of envelopes) {
      if (room.doc.seen.has(envelope.id) || inBatch.has(envelope.id)) {
        duplicates.push(envelope.id);
        continue;
      }
      inBatch.add(envelope.id);
      accepted.push(envelope);
    }

    if (accepted.length > 0) {
      room.doc = mergeEnvelopes(room.doc, accepted);
      room.seq += 1;
      room.opsSinceSnapshot += accepted.length;
    }

    return { seq: room.seq, accepted, duplicates };
  }

  /** The room state a joining client needs: the objects and the watermark. */
  snapshot(roomId: string): RoomSnapshot {
    const room = this.ensureRoom(roomId);
    return {
      snapshotSeq: room.seq,
      objects: serializeScene(toSceneState(room.doc)),
    };
  }

  /** The members of a room, as presence records. */
  peers(roomId: string): PeerPresence[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.members.values()].map((member) => ({
      sessionId: member.sessionId,
      userId: member.userId,
      displayName: member.displayName,
      color: member.color,
      cursor: member.cursor,
      selection: [...member.selection],
      lastSeen: member.lastSeen,
    }));
  }
}
