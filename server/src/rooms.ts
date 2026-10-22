import {
  createDoc,
  createInitialScene,
  mergeEnvelopes,
  serializeScene,
  toSceneState,
  type OpEnvelope,
  type PeerPresence,
  type SceneDoc,
  type SceneObject,
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
  members: Map<string, RoomMember>;
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
      doc: createDoc(createInitialScene()),
      seq: 0,
      members: new Map(),
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
