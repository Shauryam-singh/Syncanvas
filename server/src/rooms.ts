import {
  applyOps,
  createInitialScene,
  createSceneState,
  serializeScene,
  type OpEnvelope,
  type PeerPresence,
  type SceneObject,
  type SceneState,
} from '@syncanvas/shared';

/** A client that has joined a room. */
export interface RoomMember {
  clientId: string;
  displayName: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  joinedAt: number;
}

export interface Room {
  id: string;
  /** The materialised scene — the single source of truth for the room. */
  scene: SceneState;
  /** Sequence number of the last accepted batch. */
  seq: number;
  members: Map<string, RoomMember>;
  /**
   * Ids of every operation that was applied to this room.
   *
   * This is the replay guard: a client that reconnects and re-sends its
   * outbox must not apply those operations twice. Stage 4 moves the set into
   * Postgres (`UNIQUE (room_id, op_key)`); here it lives in memory.
   */
  seenOpIds: Set<string>;
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
 * Deliberately free of any WebSocket code so the merge semantics can be
 * unit tested on their own.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  /** Returns the room, creating it (seeded with the demo scene) if needed. */
  ensureRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const room: Room = {
      id: roomId,
      scene: createSceneState(createInitialScene()),
      seq: 0,
      members: new Map(),
      seenOpIds: new Set(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  room(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Adds a member to a room. Re-joining replaces the previous membership. */
  join(roomId: string, member: RoomMember): Room {
    const room = this.ensureRoom(roomId);
    room.members.set(member.clientId, member);
    return room;
  }

  /** Removes a member. The room itself is kept so its state survives. */
  leave(roomId: string, clientId: string): void {
    this.rooms.get(roomId)?.members.delete(clientId);
  }

  /** Removes a client from every room it joined (used on disconnect). */
  leaveAll(clientId: string): string[] {
    const left: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.delete(clientId)) left.push(room.id);
    }
    return left;
  }

  /**
   * Merges a batch of operations into the room.
   *
   * This is the *naive* last-writer-wins merge: the operations are applied in
   * the order the gateway received them, and the last write to a property
   * wins. There is no timestamp comparison and no intent preservation —
   * exactly the behaviour stage 3 replaces with a real CRDT.
   */
  applyOps(roomId: string, envelopes: readonly OpEnvelope[]): ApplyResult {
    const room = this.ensureRoom(roomId);
    const accepted: OpEnvelope[] = [];
    const duplicates: string[] = [];

    for (const envelope of envelopes) {
      if (room.seenOpIds.has(envelope.id)) {
        duplicates.push(envelope.id);
        continue;
      }
      room.seenOpIds.add(envelope.id);
      accepted.push(envelope);
    }

    if (accepted.length > 0) {
      room.scene = applyOps(
        room.scene,
        accepted.map((envelope) => envelope.op),
      );
      room.seq += 1;
    }

    return { seq: room.seq, accepted, duplicates };
  }

  /** The room state a joining client needs: the objects and the watermark. */
  snapshot(roomId: string): RoomSnapshot {
    const room = this.ensureRoom(roomId);
    return {
      snapshotSeq: room.seq,
      objects: serializeScene(room.scene),
    };
  }

  /** The members of a room, as presence records. */
  peers(roomId: string): PeerPresence[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const now = Date.now();
    return [...room.members.values()].map((member) => ({
      userId: member.clientId,
      displayName: member.displayName,
      color: member.color,
      cursor: member.cursor,
      selection: member.selection,
      lastSeen: now,
    }));
  }
}
