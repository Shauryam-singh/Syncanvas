import { isMutableProp, type SceneObject } from './object.js';
import type { Op, OpEnvelope } from './operations.js';

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
  | { t: 'auth'; token: string; displayName?: string }
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
  | { t: 'welcome'; userId: string; displayName: string; color: string }
  | {
      t: 'joined';
      roomId: string;
      role: RoomRole;
      snapshotSeq: number;
      peers: PeerPresence[];
    }
  /** Full or partial state: baseline snapshot plus ops after `snapshotSeq`. */
  | { t: 'state'; roomId: string; snapshotSeq: number; objects: SceneObject[]; ops: OpEnvelope[] }
  /** Remote edits, broadcast to the whole room — the author included. */
  | { t: 'ops'; roomId: string; seq: number; ops: OpEnvelope[] }
  | { t: 'ack'; roomId: string; opIds: string[]; seq: number }
  | { t: 'presence'; roomId: string; peers: PeerPresence[] }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'invalid_message' | 'internal';

// ---------------------------------------------------------------------------
// Runtime validation
//
// Everything below the wire is untrusted: a malformed frame must not be able
// to crash the gateway or poison a room. The parsers are intentionally
// strict — a message that does not match exactly is rejected, not coerced.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (!isRecord(value)) return false;
  return asNumber(value.x) !== undefined && asNumber(value.y) !== undefined;
}

function isOp(value: unknown): value is Op {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'setProp':
      return (
        typeof value.objectId === 'string' &&
        typeof value.prop === 'string' &&
        isMutableProp(value.prop) &&
        (typeof value.value === 'string' || typeof value.value === 'number')
      );
    case 'createObject':
      return isSceneObject(value.object);
    case 'deleteObject':
      return typeof value.objectId === 'string';
    case 'insertZOrder':
      return (
        typeof value.objectId === 'string' &&
        (value.afterId === null || typeof value.afterId === 'string')
      );
    case 'editText':
      return (
        typeof value.objectId === 'string' &&
        (value.afterCharId === null || typeof value.afterCharId === 'string') &&
        (value.insert === undefined || typeof value.insert === 'string') &&
        (value.deleteCount === undefined || asNumber(value.deleteCount) !== undefined)
      );
    default:
      return false;
  }
}

function isSceneObject(value: unknown): value is SceneObject {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.type === 'rect' ||
      value.type === 'ellipse' ||
      value.type === 'line' ||
      value.type === 'text') &&
    asNumber(value.x) !== undefined &&
    asNumber(value.y) !== undefined &&
    asNumber(value.w) !== undefined &&
    asNumber(value.h) !== undefined &&
    asNumber(value.rotation) !== undefined &&
    typeof value.fill === 'string' &&
    asNumber(value.zIndex) !== undefined &&
    (value.text === undefined || typeof value.text === 'string')
  );
}

function isOpEnvelope(value: unknown): value is OpEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.actorId !== 'string') return false;
  const hlc = value.hlc;
  if (!isRecord(hlc)) return false;
  if (
    asNumber(hlc.wall) === undefined ||
    asNumber(hlc.counter) === undefined ||
    typeof hlc.actorId !== 'string'
  ) {
    return false;
  }
  return isOp(value.op);
}

function isPeerPresence(value: unknown): value is PeerPresence {
  if (!isRecord(value)) return false;
  if (typeof value.userId !== 'string' || typeof value.displayName !== 'string') return false;
  if (typeof value.color !== 'string') return false;
  if (value.cursor !== null && !isPoint(value.cursor)) return false;
  const selection = asArray(value.selection);
  if (!selection || !selection.every((id) => typeof id === 'string')) return false;
  return asNumber(value.lastSeen) !== undefined;
}

/** Type guard for a message sent by a client. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case 'auth':
      return (
        typeof value.token === 'string' &&
        (value.displayName === undefined || typeof value.displayName === 'string')
      );
    case 'join':
    case 'leave':
      return typeof value.roomId === 'string';
    case 'ops': {
      if (typeof value.roomId !== 'string') return false;
      const ops = asArray(value.ops);
      return ops !== undefined && ops.every(isOpEnvelope);
    }
    case 'presence': {
      if (typeof value.roomId !== 'string') return false;
      if (value.cursor !== null && !isPoint(value.cursor)) return false;
      const selection = asArray(value.selection);
      return selection !== undefined && selection.every((id) => typeof id === 'string');
    }
    case 'sync': {
      if (typeof value.roomId !== 'string') return false;
      if (asNumber(value.snapshotSeq) === undefined) return false;
      const opIds = asArray(value.opIds);
      return opIds !== undefined && opIds.every((id) => typeof id === 'string');
    }
    case 'ping':
      return true;
    default:
      return false;
  }
}

/** Type guard for a message sent by the gateway. */
export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case 'welcome':
      return (
        typeof value.userId === 'string' &&
        typeof value.displayName === 'string' &&
        typeof value.color === 'string'
      );
    case 'joined': {
      if (typeof value.roomId !== 'string') return false;
      if (value.role !== 'owner' && value.role !== 'editor' && value.role !== 'viewer') {
        return false;
      }
      if (asNumber(value.snapshotSeq) === undefined) return false;
      const peers = asArray(value.peers);
      return peers !== undefined && peers.every(isPeerPresence);
    }
    case 'state': {
      if (typeof value.roomId !== 'string') return false;
      if (asNumber(value.snapshotSeq) === undefined) return false;
      const objects = asArray(value.objects);
      if (!objects || !objects.every(isSceneObject)) return false;
      const ops = asArray(value.ops);
      return ops !== undefined && ops.every(isOpEnvelope);
    }
    case 'ops': {
      if (typeof value.roomId !== 'string') return false;
      if (asNumber(value.seq) === undefined) return false;
      const ops = asArray(value.ops);
      return ops !== undefined && ops.every(isOpEnvelope);
    }
    case 'ack': {
      if (typeof value.roomId !== 'string') return false;
      if (asNumber(value.seq) === undefined) return false;
      const opIds = asArray(value.opIds);
      return opIds !== undefined && opIds.every((id) => typeof id === 'string');
    }
    case 'presence': {
      if (typeof value.roomId !== 'string') return false;
      const peers = asArray(value.peers);
      return peers !== undefined && peers.every(isPeerPresence);
    }
    case 'error':
      return typeof value.code === 'string' && typeof value.message === 'string';
    case 'pong':
      return true;
    default:
      return false;
  }
}

/** Parses a raw frame from a client. Returns `null` for anything invalid. */
export function parseClientMessage(raw: string): ClientMessage | null {
  return parseJson(raw, isClientMessage);
}

/** Parses a raw frame from the gateway. Returns `null` for anything invalid. */
export function parseServerMessage(raw: string): ServerMessage | null {
  return parseJson(raw, isServerMessage);
}

function parseJson<T>(raw: string, guard: (value: unknown) => value is T): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return guard(parsed) ? parsed : null;
}
