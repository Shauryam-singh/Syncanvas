import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Op, OpEnvelope } from '@syncanvas/shared';
import { SyncClient, type ConnectionState, type JoinedInfo, type OpsMeta } from './syncClient';

/** A WebSocket stand-in that records what the client sent. */
class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  /** The messages the client sent, parsed. */
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const SET_X: Op = { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 42 };

describe('the sync client', () => {
  let sockets: FakeSocket[];
  let states: ConnectionState[];
  let applied: Array<{ envelopes: OpEnvelope[]; meta: OpsMeta }>;
  let joined: JoinedInfo[];
  let errors: string[];
  let unauthorized: string[];
  let denied: string[];
  let client: SyncClient;

  beforeEach(() => {
    sockets = [];
    states = [];
    applied = [];
    joined = [];
    errors = [];
    unauthorized = [];
    denied = [];
    client = new SyncClient({
      url: 'ws://localhost:8080/ws',
      roomId: 'demo',
      token: 'token_ada',
      invite: 'invite_1',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onConnection: (state) => states.push(state),
      onOps: (envelopes, meta) => applied.push({ envelopes, meta }),
      onJoined: (info) => joined.push(info),
      onError: (message) => errors.push(message),
      onUnauthorized: (message) => unauthorized.push(message),
      onAccessDenied: (message) => denied.push(message),
    });
  });

  afterEach(() => {
    client.close();
  });

  /** Brings the client all the way to "joined". */
  function goLive(role: 'owner' | 'editor' | 'viewer' = 'editor'): void {
    client.connect();
    sockets[0]?.open();
    sockets[0]?.receive({
      t: 'welcome',
      userId: 'user_1',
      sessionId: 'sess_1',
      displayName: 'Ada',
      color: '#fff',
    });
    sockets[0]?.receive({
      t: 'joined',
      roomId: 'demo',
      name: 'Demo canvas',
      role,
      snapshotSeq: 0,
      peers: [],
    });
    sockets[0]?.receive({
      t: 'state',
      roomId: 'demo',
      snapshotSeq: 0,
      objects: [],
      ops: [],
    });
  }

  it('authenticates with the access token and joins with the invite', () => {
    client.connect();
    sockets[0]?.open();
    expect(sockets[0]?.messages[0]?.t).toBe('auth');
    expect(sockets[0]?.messages[0]?.token).toBe('token_ada');

    sockets[0]?.receive({
      t: 'welcome',
      userId: 'user_1',
      sessionId: 'sess_1',
      displayName: 'Ada',
      color: '#fff',
    });
    expect(sockets[0]?.messages[1]?.t).toBe('join');
    expect(sockets[0]?.messages[1]?.roomId).toBe('demo');
    expect(sockets[0]?.messages[1]?.invite).toBe('invite_1');
  });

  it('reports the connection state and the role the server assigned', () => {
    goLive('owner');
    expect(states).toEqual(['connecting', 'live']);
    expect(joined).toEqual([{ role: 'owner', roomName: 'Demo canvas', sessionId: 'sess_1' }]);
  });

  it('sends local operations as envelopes stamped with the assigned identity', () => {
    goLive();
    client.sendOps([SET_X], { undoable: true });

    const message = sockets[0]?.messages.find((entry) => entry.t === 'ops');
    expect(message).toBeDefined();
    const ops = message?.ops as Array<Record<string, unknown>>;
    expect(ops).toHaveLength(1);
    expect(ops[0]?.actorId).toBe('user_1');
    expect(ops[0]?.id).toMatch(/^op_/);
    expect(ops[0]?.op).toEqual(SET_X);
  });

  it('drops edits from a viewer without sending them', () => {
    goLive('viewer');
    client.sendOps([SET_X], { undoable: true });

    expect((sockets[0]?.messages.filter((entry) => entry.t === 'ops') ?? []).length).toBe(0);
    expect(errors).toContain('Viewers cannot edit this room.');
  });

  it('does not send the same operation twice', () => {
    goLive();
    client.sendOps([SET_X], { undoable: true });
    client.sendOps([{ ...SET_X, value: 43 }], { undoable: true });

    const messages = sockets[0]?.messages.filter((entry) => entry.t === 'ops') ?? [];
    expect(messages).toHaveLength(2);
    expect((messages[0]?.ops as unknown[]).length).toBe(1);
    expect((messages[1]?.ops as unknown[]).length).toBe(1);
  });

  it('applies remote operations without claiming them', () => {
    goLive();
    sockets[0]?.receive({
      t: 'ops',
      roomId: 'demo',
      seq: 1,
      ops: [
        {
          id: 'op_remote',
          actorId: 'user_2',
          hlc: { wall: 1, counter: 0, actorId: 'user_2' },
          op: SET_X,
        },
      ],
    });

    expect(applied).toHaveLength(1);
    expect(applied[0]?.meta.mine).toBe(false);
    expect(applied[0]?.envelopes.map((envelope) => envelope.op)).toEqual([SET_X]);
  });

  it('recognises its own operations when they come back', () => {
    goLive();
    client.sendOps([SET_X], { undoable: true });
    const envelope = (
      sockets[0]?.messages.find((entry) => entry.t === 'ops')?.ops as Array<Record<string, unknown>>
    )[0];

    sockets[0]?.receive({ t: 'ops', roomId: 'demo', seq: 1, ops: [envelope] });

    expect(applied).toHaveLength(1);
    expect(applied[0]?.meta.mine).toBe(true);
    expect(applied[0]?.meta.undoable).toBe(true);
  });

  it('applies operations in the order the gateway numbered them', () => {
    goLive();
    const envelope = (id: string, value: number) => ({
      id,
      actorId: 'user_2',
      hlc: { wall: 1, counter: 0, actorId: 'user_2' },
      op: { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value } satisfies Op,
    });

    sockets[0]?.receive({ t: 'ops', roomId: 'demo', seq: 2, ops: [envelope('op_2', 2)] });
    expect(applied).toHaveLength(0);

    sockets[0]?.receive({ t: 'ops', roomId: 'demo', seq: 1, ops: [envelope('op_1', 1)] });
    expect(applied).toHaveLength(2);
    expect(applied[0]?.envelopes[0]?.op).toEqual({
      kind: 'setProp',
      objectId: 'demo-rect',
      prop: 'x',
      value: 1,
    });
    expect(applied[1]?.envelopes[0]?.op).toEqual({
      kind: 'setProp',
      objectId: 'demo-rect',
      prop: 'x',
      value: 2,
    });
  });

  it('drops the operations that are older than the state it received', () => {
    goLive();
    sockets[0]?.receive({
      t: 'state',
      roomId: 'demo',
      snapshotSeq: 5,
      objects: [],
      ops: [],
    });
    sockets[0]?.receive({
      t: 'ops',
      roomId: 'demo',
      seq: 3,
      ops: [
        {
          id: 'op_old',
          actorId: 'user_2',
          hlc: { wall: 1, counter: 0, actorId: 'user_2' },
          op: SET_X,
        },
      ],
    });
    expect(applied).toHaveLength(0);
  });

  it('throttles presence to at most one frame per interval and sends the last position', () => {
    vi.useFakeTimers();
    try {
      goLive();
      client.sendPresence({ x: 0, y: 0 }, []);
      for (let x = 1; x <= 20; x += 1) {
        client.sendPresence({ x, y: x }, []);
      }

      let frames = sockets[0]?.messages.filter((entry) => entry.t === 'presence') ?? [];
      expect(frames).toHaveLength(1);
      expect(frames[0]?.cursor).toEqual({ x: 0, y: 0 });

      vi.advanceTimersByTime(39);
      frames = sockets[0]?.messages.filter((entry) => entry.t === 'presence') ?? [];
      expect(frames).toHaveLength(1);

      vi.advanceTimersByTime(1);
      frames = sockets[0]?.messages.filter((entry) => entry.t === 'presence') ?? [];
      expect(frames).toHaveLength(2);
      expect(frames[1]?.cursor).toEqual({ x: 20, y: 20 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resend an identical presence frame', () => {
    vi.useFakeTimers();
    try {
      goLive();
      client.sendPresence({ x: 5, y: 6 }, ['demo-rect']);
      client.sendPresence({ x: 5, y: 6 }, ['demo-rect']);
      vi.advanceTimersByTime(80);
      const frames = sockets[0]?.messages.filter((entry) => entry.t === 'presence') ?? [];
      expect(frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last cursor when only the selection changes', () => {
    vi.useFakeTimers();
    try {
      goLive();
      client.sendPresence({ x: 12, y: 34 }, []);
      vi.advanceTimersByTime(40);
      client.sendPresence(undefined, ['demo-rect']);
      vi.advanceTimersByTime(40);
      const frames = sockets[0]?.messages.filter((entry) => entry.t === 'presence') ?? [];
      expect(frames[0]?.cursor).toEqual({ x: 12, y: 34 });
      expect(frames[1]?.cursor).toEqual({ x: 12, y: 34 });
      expect(frames[1]?.selection).toEqual(['demo-rect']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a heartbeat while joined', () => {
    vi.useFakeTimers();
    try {
      goLive();
      expect((sockets[0]?.messages.filter((entry) => entry.t === 'ping') ?? []).length).toBe(0);
      vi.advanceTimersByTime(20_000);
      expect((sockets[0]?.messages.filter((entry) => entry.t === 'ping') ?? []).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after an unauthorized error', () => {
    vi.useFakeTimers();
    try {
      client.connect();
      sockets[0]?.open();
      sockets[0]?.receive({
        t: 'error',
        code: 'unauthorized',
        message: 'That session is invalid or has expired.',
      });
      expect(unauthorized).toEqual(['That session is invalid or has expired.']);
      expect(states).toContain('offline');

      vi.advanceTimersByTime(30_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after a denied join', () => {
    vi.useFakeTimers();
    try {
      client.connect();
      sockets[0]?.open();
      sockets[0]?.receive({
        t: 'welcome',
        userId: 'user_1',
        sessionId: 'sess_1',
        displayName: 'Ada',
        color: '#fff',
      });
      sockets[0]?.receive({
        t: 'error',
        code: 'forbidden',
        message: 'You need a share link or an invitation to join this room.',
        roomId: 'demo',
      });
      expect(denied).toHaveLength(1);
      vi.advanceTimersByTime(30_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a rejected operations batch from the outbox', () => {
    goLive('viewer');
    // A viewer's batch never leaves the client, so simulate an editor whose
    // server-side role changed (or a stale client) by forcing one through.
    const internal = client as unknown as {
      outbox: Map<string, unknown>;
      undoableIds: Set<string>;
    };
    internal.outbox.set('op_rejected', { envelope: {}, undoable: true, sent: true });
    internal.undoableIds.add('op_rejected');
    sockets[0]?.receive({
      t: 'error',
      code: 'forbidden',
      message: 'Viewers cannot edit this room.',
      opIds: ['op_rejected'],
    });
    expect(internal.outbox.has('op_rejected')).toBe(false);
    expect(internal.undoableIds.has('op_rejected')).toBe(false);
  });

  it('reconnects after the connection drops', () => {
    vi.useFakeTimers();
    try {
      goLive();
      socket_closed();
      expect(states).toContain('offline');

      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  function socket_closed(): void {
    sockets[0]?.close();
  }

  it('asks for the missing state when the connection was lost', () => {
    vi.useFakeTimers();
    try {
      goLive();
      client.sendOps([SET_X], { undoable: true });
      sockets[0]?.close();

      vi.advanceTimersByTime(1_000);
      const next = sockets[1];
      next?.open();
      next?.receive({
        t: 'welcome',
        userId: 'user_1',
        sessionId: 'sess_1',
        displayName: 'Ada',
        color: '#fff',
      });
      next?.receive({
        t: 'joined',
        roomId: 'demo',
        name: 'Demo canvas',
        role: 'editor',
        snapshotSeq: 0,
        peers: [],
      });
      next?.receive({ t: 'state', roomId: 'demo', snapshotSeq: 0, objects: [], ops: [] });

      const sync = next?.messages.find((entry) => entry.t === 'sync');
      expect(sync).toBeDefined();
      expect((sync?.opIds as string[]).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-sends the operations the gateway never received', () => {
    vi.useFakeTimers();
    try {
      goLive();
      client.sendOps([SET_X], { undoable: true });
      sockets[0]?.close();

      vi.advanceTimersByTime(1_000);
      const next = sockets[1];
      next?.open();
      next?.receive({
        t: 'welcome',
        userId: 'user_1',
        sessionId: 'sess_1',
        displayName: 'Ada',
        color: '#fff',
      });
      next?.receive({
        t: 'joined',
        roomId: 'demo',
        name: 'Demo canvas',
        role: 'editor',
        snapshotSeq: 0,
        peers: [],
      });
      next?.receive({ t: 'state', roomId: 'demo', snapshotSeq: 0, objects: [], ops: [] });
      next?.receive({ t: 'ack', roomId: 'demo', opIds: [], seq: 0 });

      const resent = next?.messages.filter((entry) => entry.t === 'ops') ?? [];
      expect(resent).toHaveLength(1);
      expect((resent[0]?.ops as unknown[]).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
