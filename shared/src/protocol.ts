import type { OpEnvelope } from './operations.js';

export type RoomRole = 'owner' | 'editor' | 'viewer';

export interface PeerPresence {
  userId: string;
  displayName: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  lastSeen: number;
}

export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'join'; roomId: string }
  | { t: 'leave'; roomId: string }
  /** Batch of local edits. Server acks with the same op ids once persisted. */
  | { t: 'ops'; roomId: string; ops: OpEnvelope[] }
  /** Cursor/selection updates — ephemeral, never persisted. */
  | { t: 'presence'; roomId: string; cursor: { x: number; y: number } | null; selection: string[] }
  /** Reconnect catch-up: state the client already has. */
  | { t: 'sync'; roomId: string; snapshotSeq: number; opIds: string[] }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; userId: string; displayName: string }
  | {
      t: 'joined';
      roomId: string;
      role: RoomRole;
      snapshotSeq: number;
      peers: PeerPresence[];
    }
  /** Full or partial state: baseline snapshot plus ops after `snapshotSeq`. */
  | { t: 'state'; roomId: string; snapshotSeq: number; objects: unknown[]; ops: OpEnvelope[] }
  /** Remote edits broadcast to everyone except the author. */
  | { t: 'ops'; roomId: string; seq: number; ops: OpEnvelope[] }
  | { t: 'ack'; roomId: string; opIds: string[]; seq: number }
  | { t: 'presence'; roomId: string; peers: PeerPresence[] }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'invalid_message' | 'internal';
