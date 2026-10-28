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
  /**
   * Highest sequence number this replica has applied.
   *
   * With a room bus this is a gateway-independent watermark assigned by
   * Redis; without one it is the local broadcast counter.
   */
  seq: number;
  /** Members connected to this gateway, keyed by session id. */
  members: Map<string, RoomMember>;
  /** Members connected to other gateways, learned through the bus. */
  remoteMembers: Map<string, RoomMember>;
  /** Number of accepted operations since the last persisted snapshot. */
  opsSinceSnapshot: number;
  /**
   * False when the seed document exists only in memory. A join loads the
   * persisted snapshot and log before accepting edits.
   */
  loaded: boolean;
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
      remoteMembers: new Map(),
      opsSinceSnapshot: 0,
      loaded: false,
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * Replaces (or creates) a room with a document loaded from persistence.
   * Used on startup after replaying the operation log, and lazily when a
   * client joins a room this gateway has not seen yet.
   */
  installRoom(input: { id: string; doc: SceneDoc; seq: number }): Room {
    const existing = this.rooms.get(input.id);
    const room: Room = {
      id: input.id,
      doc: input.doc,
      seq: input.seq,
      members: existing?.members ?? new Map(),
      remoteMembers: existing?.remoteMembers ?? new Map(),
      opsSinceSnapshot: 0,
      loaded: true,
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

  /** Removes a member connected to this gateway. */
  leave(roomId: string, sessionId: string): void {
    this.rooms.get(roomId)?.members.delete(sessionId);
  }

  /** Removes a session from every room it joined locally (used on disconnect). */
  leaveAll(sessionId: string): string[] {
    const left: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.delete(sessionId)) left.push(room.id);
    }
    return left;
  }

  /** Adds or refreshes a member learned from another gateway. */
  upsertRemote(roomId: string, member: RoomMember): Room {
    const room = this.ensureRoom(roomId);
    room.remoteMembers.set(member.sessionId, member);
    return room;
  }

  /** Removes a session that disconnected from another gateway. */
  removeRemote(roomId: string, sessionId: string): boolean {
    return this.rooms.get(roomId)?.remoteMembers.delete(sessionId) ?? false;
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
      // Remote members are refreshed by their owning gateway's heartbeats.
      // If that process disappears without a leave frame, this eventually
      // clears their cursors too.
      for (const [sessionId, member] of room.remoteMembers) {
        if (now - member.lastSeen > ttlMs) {
          room.remoteMembers.delete(sessionId);
          removed = true;
        }
      }
      if (removed) changed.push(room.id);
    }
    return changed;
  }

  /**
   * Returns the operations that are new to this replica without merging them.
   * The bus uses this to avoid allocating a sequence number for a pure resend.
   */
  previewOps(
    roomId: string,
    envelopes: readonly OpEnvelope[],
  ): { accepted: OpEnvelope[]; duplicates: string[] } {
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
    return { accepted, duplicates };
  }

  /**
   * Merges a batch of operations into the room.
   *
   * The merge is the CRDT's: a property keeps the write with the greatest
   * `(HLC, opId)`, the z-order is an RGA, and a delete tombstones its object.
   * Two replicas that have seen the same operations hold the same document,
   * whatever order the gateway received them in.
   *
   * `seq` is supplied when a room bus assigned the room-wide watermark. A
   * standalone gateway omits it and increments its local counter instead.
   */
  applyOps(roomId: string, envelopes: readonly OpEnvelope[], seq?: number): ApplyResult {
    const room = this.ensureRoom(roomId);
    const { accepted, duplicates } = this.previewOps(roomId, envelopes);

    if (accepted.length > 0) {
      room.doc = mergeEnvelopes(room.doc, accepted);
      room.opsSinceSnapshot += accepted.length;
    }
    if (seq === undefined) {
      if (accepted.length > 0) room.seq += 1;
    } else {
      // The bus allocates a sequence for every publication, even a resend that
      // turned out to be fully duplicate. Advancing the local watermark keeps
      // later batches contiguous for this gateway's clients.
      room.seq = Math.max(room.seq, seq);
    }

    return { seq: seq ?? room.seq, accepted, duplicates };
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
    const members = [...room.members.values(), ...room.remoteMembers.values()];
    members.sort((a, b) => a.joinedAt - b.joinedAt || a.sessionId.localeCompare(b.sessionId));
    return members.map((member) => ({
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
