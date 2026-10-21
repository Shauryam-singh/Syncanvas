import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parseServerMessage, type Op, type ServerMessage } from '@syncanvas/shared';
import { createGateway } from './gateway.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A test client that records every message the gateway sends. */
class TestClient {
  readonly socket: WebSocket;
  private received: ServerMessage[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (data) => {
      const message = parseServerMessage(data.toString());
      if (message) this.received.push(message);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Waits for the next message of the given type that has not been read. */
  async waitFor<T extends ServerMessage['t']>(
    type: T,
    timeout = 2_000,
    predicate?: (message: Extract<ServerMessage, { t: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = this.received.findIndex(
        (message) => message.t === type && (predicate?.(message as never) ?? true),
      );
      if (index >= 0) {
        const [message] = this.received.splice(index, 1);
        return message as Extract<ServerMessage, { t: T }>;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a "${type}" message`);
      }
      await delay(5);
    }
  }

  /** Waits until no message of the given type is left. */
  async expectNo(type: ServerMessage['t'], wait = 150): Promise<void> {
    await delay(wait);
    expect(this.received.filter((message) => message.t === type)).toHaveLength(0);
  }

  close(): void {
    this.socket.close();
  }
}

function setProp(objectId: string, prop: 'x' | 'y', value: number): Op {
  return { kind: 'setProp', objectId, prop, value };
}

describe('the gateway', () => {
  let server: Server;
  let url: string;
  const clients: TestClient[] = [];

  async function connect(): Promise<TestClient> {
    const client = new TestClient(url);
    clients.push(client);
    await client.open();
    return client;
  }

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    createGateway(server, { path: '/ws' });
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('assigns a client id and greets the client', async () => {
    const client = await connect();
    client.send({ t: 'auth', token: 'dev', displayName: 'Ada' });
    const welcome = await client.waitFor('welcome');
    expect(welcome.userId).toMatch(/^user_/);
    expect(welcome.displayName).toBe('Ada');
  });

  it('sends the room state when a client joins', async () => {
    const client = await connect();
    client.send({ t: 'auth', token: 'dev' });
    await client.waitFor('welcome');
    client.send({ t: 'join', roomId: 'demo' });

    const joined = await client.waitFor('joined');
    expect(joined.roomId).toBe('demo');
    expect(joined.role).toBe('editor');

    const state = await client.waitFor('state');
    expect(state.objects.length).toBe(4);
    expect(state.objects.some((object) => object.id === 'demo-rect')).toBe(true);
  });

  it('broadcasts an operation to everybody in the room', async () => {
    const alice = await connect();
    const bob = await connect();
    for (const client of [alice, bob]) {
      client.send({ t: 'auth', token: 'dev' });
      await client.waitFor('welcome');
      client.send({ t: 'join', roomId: 'demo' });
      await client.waitFor('state');
    }

    alice.send({
      t: 'ops',
      roomId: 'demo',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_forged',
          hlc: { wall: 1, counter: 0, actorId: 'user_forged' },
          op: setProp('demo-rect', 'x', 321),
        },
      ],
    });

    const forBob = await bob.waitFor('ops');
    expect(forBob.seq).toBe(1);
    expect(forBob.ops[0]?.op).toEqual(setProp('demo-rect', 'x', 321));

    // The author receives the broadcast too, so every replica folds the same
    // history — including the one that produced the operation.
    const forAlice = await alice.waitFor('ops');
    expect(forAlice.ops[0]?.op).toEqual(setProp('demo-rect', 'x', 321));

    const ack = await alice.waitFor('ack');
    expect(ack.opIds).toEqual(['op_1']);
  });

  it('stamps the actor id with the server-assigned identity', async () => {
    const alice = await connect();
    alice.send({ t: 'auth', token: 'dev' });
    const welcome = await alice.waitFor('welcome');
    alice.send({ t: 'join', roomId: 'demo' });
    await alice.waitFor('state');

    alice.send({
      t: 'ops',
      roomId: 'demo',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_forged',
          hlc: { wall: 1, counter: 0, actorId: 'user_forged' },
          op: setProp('demo-rect', 'x', 1),
        },
      ],
    });

    const broadcast = await alice.waitFor('ops');
    expect(broadcast.ops[0]?.actorId).toBe(welcome.userId);
    expect(broadcast.ops[0]?.hlc.actorId).toBe(welcome.userId);
  });

  it('does not deliver an operation to a client in another room', async () => {
    const alice = await connect();
    const bob = await connect();
    for (const [client, room] of [
      [alice, 'room-a'],
      [bob, 'room-b'],
    ] as const) {
      client.send({ t: 'auth', token: 'dev' });
      await client.waitFor('welcome');
      client.send({ t: 'join', roomId: room });
      await client.waitFor('state');
    }

    alice.send({
      t: 'ops',
      roomId: 'room-a',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_1',
          hlc: { wall: 1, counter: 0, actorId: 'user_1' },
          op: setProp('demo-rect', 'x', 1),
        },
      ],
    });

    await alice.waitFor('ops');
    await bob.expectNo('ops');
  });

  it('drops a repeated operation', async () => {
    const alice = await connect();
    alice.send({ t: 'auth', token: 'dev' });
    await alice.waitFor('welcome');
    alice.send({ t: 'join', roomId: 'demo' });
    await alice.waitFor('state');

    const batch = {
      t: 'ops',
      roomId: 'demo',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_1',
          hlc: { wall: 1, counter: 0, actorId: 'user_1' },
          op: setProp('demo-rect', 'x', 1),
        },
      ],
    };
    alice.send(batch);
    const first = await alice.waitFor('ops');
    expect(first.seq).toBe(1);

    alice.send(batch);
    // No second broadcast — the operation is already part of the room.
    await alice.expectNo('ops');

    // The client is told to catch up, because it may have missed the
    // broadcast the first time.
    const state = await alice.waitFor('state');
    expect(state.snapshotSeq).toBe(1);
  });

  it('tells the room who is in it', async () => {
    const alice = await connect();
    alice.send({ t: 'auth', token: 'dev' });
    await alice.waitFor('welcome');
    alice.send({ t: 'join', roomId: 'demo' });
    await alice.waitFor('state');

    const bob = await connect();
    bob.send({ t: 'auth', token: 'dev' });
    await bob.waitFor('welcome');
    bob.send({ t: 'join', roomId: 'demo' });
    await bob.waitFor('state');

    const presence = await alice.waitFor(
      'presence',
      2_000,
      (message) => message.peers.length === 2,
    );
    expect(presence.peers).toHaveLength(2);
    expect(presence.peers.every((peer) => peer.userId.startsWith('user_'))).toBe(true);
    expect(new Set(presence.peers.map((peer) => peer.userId)).size).toBe(2);
  });

  it('answers a ping', async () => {
    const client = await connect();
    client.send({ t: 'ping' });
    await client.waitFor('pong');
  });

  it('rejects a message it cannot read', async () => {
    const client = await connect();
    client.socket.send('this is not a protocol frame');
    const error = await client.waitFor('error');
    expect(error.code).toBe('invalid_message');
  });
});
