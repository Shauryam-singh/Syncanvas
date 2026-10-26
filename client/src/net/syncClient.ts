import {
  createHlc,
  parseServerMessage,
  receiveHlc,
  tickHlc,
  type ClientMessage,
  type HlcTimestamp,
  type Op,
  type OpEnvelope,
  type PeerPresence,
  type Point,
  type RoomRole,
  type SceneObject,
} from '@syncanvas/shared';

/**
 * How the editor is currently connected to the gateway.
 *
 * `local` means there is no gateway at all — the editor works exactly like
 * stage 1, with every operation applied locally and never sent anywhere.
 */
export type ConnectionState = 'local' | 'connecting' | 'live' | 'offline';

export interface OpsMeta {
  /** True when the operations were authored by this client. */
  mine: boolean;
  /** True when the operations belong to a user gesture (and undoable). */
  undoable: boolean;
}

export interface JoinedInfo {
  role: RoomRole;
  roomName: string;
  sessionId: string;
}

export interface SyncClientOptions {
  url: string;
  roomId: string;
  /** Signed access token from the HTTP API. */
  token: string;
  /** Signed share link, when the user does not have a membership yet. */
  invite?: string;
  /** Injected in tests; defaults to the browser's WebSocket. */
  createSocket?: (url: string) => WebSocket;
  onConnection?: (state: ConnectionState) => void;
  onState?: (payload: { objects: SceneObject[]; snapshotSeq: number }) => void;
  /** Broadcast operations, with the stamps the CRDT merge needs. */
  onOps?: (envelopes: OpEnvelope[], meta: OpsMeta) => void;
  onPeers?: (peers: PeerPresence[]) => void;
  /** The gateway accepted the join and told us our role. */
  onJoined?: (info: JoinedInfo) => void;
  onError?: (message: string) => void;
  /** The session is invalid/expired; the socket is not retried. */
  onUnauthorized?: (message: string) => void;
  /** The join was refused (no membership, or a bad share link). */
  onAccessDenied?: (message: string) => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** At most 25 cursor updates per second, trailing edge. */
const PRESENCE_INTERVAL_MS = 40;

/** Keeps presence alive when the user is idle. */
const HEARTBEAT_INTERVAL_MS = 20_000;

interface OutboxEntry {
  envelope: OpEnvelope;
  undoable: boolean;
  /** True once the operation has been handed to the gateway. */
  sent: boolean;
}

interface PresenceState {
  cursor: Point | null;
  selection: string[];
}

/**
 * The client half of the sync protocol.
 *
 * The gateway relays and sequences batches; the merge itself is the CRDT that
 * every replica runs (see `shared/src/crdt/`). This client still does **not**
 * apply its own operations optimistically — it waits for the server to echo
 * the envelopes back, so that its scene is always a prefix of the replicated
 * document and the undo stack has a single source of truth.
 *
 * Cursor updates are ephemeral: they are coalesced to ~25 Hz here, and the
 * server only ever gossips them to the room. They never enter the operation
 * log and never touch the document.
 */
export class SyncClient {
  private readonly options: SyncClientOptions;
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private clock: HlcTimestamp;
  private userId: string | null = null;
  private sessionId: string | null = null;
  private role: RoomRole | null = null;
  /** The last sequence number this client has applied. */
  private lastSeq = -1;
  /** Operations received out of order, keyed by sequence number. */
  private pending = new Map<number, OpEnvelope[]>();
  /** Operations this client sent that the gateway has not confirmed yet. */
  private outbox = new Map<string, OutboxEntry>();
  /** Ids of this client's operations that belong to an undoable gesture. */
  private undoableIds = new Set<string>();
  /** Set when the connection dropped and the state must be re-fetched. */
  private needsResync = false;
  private awaitingResync = false;
  private joined = false;
  private lastCursor: Point | null = null;
  private pendingPresence: PresenceState | null = null;
  private lastPresenceKey = '';
  private lastPresenceAt = 0;

  constructor(options: SyncClientOptions) {
    this.options = options;
    this.clock = createHlc('local');
  }

  /** Opens the connection. Safe to call more than once. */
  connect(): void {
    if (this.closed) return;
    if (this.socket && this.socket.readyState <= 1) return;

    this.setConnection('connecting');
    const factory = this.options.createSocket ?? ((url: string) => new WebSocket(url));
    let socket: WebSocket;
    try {
      socket = factory(this.options.url);
    } catch {
      this.setConnection('offline');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.send({ t: 'auth', token: this.options.token });
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleRaw(typeof event.data === 'string' ? event.data : String(event.data));
    };

    socket.onclose = () => {
      this.socket = null;
      this.joined = false;
      // Sequence numbers are per connection: anything buffered from the old
      // socket must never be spliced into the new connection's stream.
      this.pending.clear();
      this.stopHeartbeat();
      if (this.closed) return;
      this.needsResync = true;
      this.setConnection('offline');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows; the reconnect is scheduled there.
    };
  }

  /** Closes the connection for good. */
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.joined = false;
    this.setConnection('local');
  }

  /**
   * Sends local operations to the gateway.
   *
   * The operations are *not* applied locally — they come back in the
   * gateway's order and are applied then. If the connection is down the
   * operations stay in the outbox and are re-sent on reconnect.
   */
  sendOps(ops: readonly Op[], meta: { undoable: boolean }): void {
    if (ops.length === 0) return;
    if (this.role === 'viewer') {
      this.options.onError?.('Viewers cannot edit this room.');
      return;
    }
    const actorId = this.userId ?? 'local';
    const envelopes = ops.map((op) => this.createEnvelope(op, actorId));
    for (const envelope of envelopes) {
      this.outbox.set(envelope.id, { envelope, undoable: meta.undoable, sent: false });
      if (meta.undoable) this.undoableIds.add(envelope.id);
    }
    this.flushOutbox();
  }

  /**
   * Sends the ephemeral cursor/selection state. Never persisted.
   *
   * `cursor: undefined` keeps the last cursor — selection-only updates do not
   * make the pointer jump back to the last position it was drawn at.
   */
  sendPresence(cursor: Point | null | undefined, selection: readonly string[]): void {
    if (cursor !== undefined) this.lastCursor = cursor;
    this.pendingPresence = { cursor: this.lastCursor, selection: [...selection] };
    this.schedulePresence();
  }

  // -------------------------------------------------------------------------

  private createEnvelope(op: Op, actorId: string): OpEnvelope {
    this.clock = tickHlc(this.clock, actorId);
    return {
      id: `op_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      actorId,
      hlc: this.clock,
      op,
    };
  }

  private setConnection(state: ConnectionState): void {
    this.options.onConnection?.(state);
  }

  private send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(message));
  }

  private flushOutbox(): void {
    if (!this.joined) return;
    const entries = [...this.outbox.values()].filter((entry) => !entry.sent);
    if (entries.length === 0) return;
    for (const entry of entries) entry.sent = true;
    this.send({
      t: 'ops',
      roomId: this.options.roomId,
      ops: entries.map((entry) => entry.envelope),
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * A rejected session is not retried: retrying with the same token would
   * loop forever. The UI signs in again instead.
   */
  private failBeforeJoin(message: string, reason: 'unauthorized' | 'forbidden'): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.joined = false;
    this.setConnection('offline');
    if (reason === 'unauthorized') {
      this.options.onUnauthorized?.(message);
    } else {
      this.options.onAccessDenied?.(message);
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const timer = setInterval(() => this.send({ t: 'ping' }), HEARTBEAT_INTERVAL_MS);
    // Tests run in Node; unref so an idle client cannot keep the process alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.heartbeat = timer;
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private schedulePresence(): void {
    if (!this.joined || !this.pendingPresence || this.presenceTimer) return;
    const wait = Math.max(0, PRESENCE_INTERVAL_MS - (Date.now() - this.lastPresenceAt));
    if (wait === 0) {
      this.flushPresence();
      return;
    }
    const timer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, wait);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.presenceTimer = timer;
  }

  private flushPresence(): void {
    if (!this.joined || !this.pendingPresence) return;
    const pending = this.pendingPresence;
    this.pendingPresence = null;
    const key = JSON.stringify([pending.cursor, pending.selection]);
    if (key === this.lastPresenceKey) return;
    this.lastPresenceKey = key;
    this.lastPresenceAt = Date.now();
    this.send({
      t: 'presence',
      roomId: this.options.roomId,
      cursor: pending.cursor,
      selection: pending.selection,
    });
  }

  private handleRaw(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) {
      this.options.onError?.('The gateway sent a message the client could not read.');
      return;
    }

    switch (message.t) {
      case 'welcome': {
        this.userId = message.userId;
        this.sessionId = message.sessionId;
        this.clock = createHlc(message.userId);
        this.send({ t: 'join', roomId: this.options.roomId, invite: this.options.invite });
        return;
      }

      case 'joined': {
        this.joined = true;
        this.role = message.role;
        this.lastSeq = message.snapshotSeq;
        this.startHeartbeat();
        this.setConnection('live');
        this.options.onJoined?.({
          role: message.role,
          roomName: message.name,
          sessionId: this.sessionId ?? '',
        });
        this.flushOutbox();
        this.schedulePresence();
        return;
      }

      case 'state': {
        this.lastSeq = message.snapshotSeq;
        this.options.onState?.({
          objects: message.objects,
          snapshotSeq: message.snapshotSeq,
        });
        this.drain();
        if (this.needsResync) {
          this.needsResync = false;
          this.requestResync();
        }
        return;
      }

      case 'ops': {
        for (const envelope of message.ops) {
          this.clock = receiveHlc(this.clock, envelope.hlc);
        }
        const buffered = this.pending.get(message.seq) ?? [];
        this.pending.set(message.seq, [...buffered, ...message.ops]);
        this.drain();
        return;
      }

      case 'ack': {
        for (const id of message.opIds) {
          this.outbox.delete(id);
          this.undoableIds.delete(id);
        }
        if (this.awaitingResync) {
          this.awaitingResync = false;
          // Whatever the gateway did not have is sent again.
          for (const entry of this.outbox.values()) entry.sent = false;
          this.flushOutbox();
        }
        return;
      }

      case 'presence': {
        this.options.onPeers?.(message.peers);
        return;
      }

      case 'error': {
        if (message.code === 'unauthorized') {
          this.failBeforeJoin(message.message, 'unauthorized');
          return;
        }
        if (!this.joined && message.code === 'forbidden') {
          this.failBeforeJoin(message.message, 'forbidden');
          return;
        }
        if (message.code === 'forbidden' && message.opIds) {
          // A rejected batch is not retried; dropping it here also clears the
          // "undoable" flag so a later undo cannot resurrect a stale gesture.
          for (const id of message.opIds) {
            this.outbox.delete(id);
            this.undoableIds.delete(id);
          }
        }
        this.options.onError?.(message.message);
        return;
      }

      case 'pong':
        return;
    }
  }

  /**
   * Applies the operations that are next in server order.
   *
   * A gap means something was lost — the client asks for the full state
   * rather than guessing.
   */
  private drain(): void {
    // Operations that the state already covers are dropped.
    for (const seq of [...this.pending.keys()]) {
      if (seq <= this.lastSeq) this.pending.delete(seq);
    }
    for (;;) {
      const next = this.pending.get(this.lastSeq + 1);
      if (!next) break;
      this.pending.delete(this.lastSeq + 1);
      this.lastSeq += 1;
      this.emitOps(next);
    }
  }

  private emitOps(envelopes: OpEnvelope[]): void {
    if (envelopes.length === 0) return;
    const mine = envelopes.every((envelope) => this.outbox.has(envelope.id));
    const undoable = mine && envelopes.every((envelope) => this.undoableIds.has(envelope.id));
    this.options.onOps?.(envelopes, { mine, undoable });
  }

  private requestResync(): void {
    this.awaitingResync = true;
    this.send({
      t: 'sync',
      roomId: this.options.roomId,
      snapshotSeq: this.lastSeq,
      opIds: [...this.outbox.keys()],
    });
  }
}
