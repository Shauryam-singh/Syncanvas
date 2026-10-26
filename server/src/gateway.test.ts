import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parseServerMessage, type Op, type ServerMessage } from '@syncanvas/shared';
import { signAccessToken, signInviteToken } from './auth/jwt.js';
import { config } from './config.js';
import { createGateway } from './gateway.js';
import { ensureDemoRoom } from './persistence.js';
import { RoomRegistry } from './rooms.js';
import { MemoryStore } from './store/memory.js';
import type { User } from './store/types.js';

const SECRET = 'gateway-test-secret';

function testConfig() {
  return {
    ...config,
    jwtSecret: SECRET,
    publicDemoRoom: 'demo',
    maxOpsPerBatch: 1000,
    presenceTtlMs: 60_000,
    presenceSweepMs: 60_000,
    jwtTtlSeconds: 3600,
    inviteTtlSeconds: 3600,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A test client that records every message the gateway sends. */
class TestClient {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  private received: ServerMessage[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.closed = new Promise<number>((resolve) => {
      this.socket.on('close', (code) => resolve(code));
    });
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

function operation(id: string, actorId = 'user_forged', wall = 1) {
  return {
    id,
    actorId,
    hlc: { wall, counter: 0, actorId },
    op: setProp('demo-rect', 'x', 321),
  };
}

describe('the gateway', () => {
  let server: Server;
  let url: string;
  let store: MemoryStore;
  let registry: RoomRegistry;
  const clients: TestClient[] = [];

  async function connect(): Promise<TestClient> {
    const client = new TestClient(url);
    clients.push(client);
    await client.open();
    return client;
  }

  async function connectAs(token: string): Promise<TestClient> {
    const client = await connect();
    client.send({ t: 'auth', token });
    await client.waitFor('welcome');
    return client;
  }

  async function joinRoom(client: TestClient, roomId: string, invite?: string) {
    client.send({ t: 'join', roomId, invite });
    const joined = await client.waitFor('joined');
    await client.waitFor('state');
    return joined;
  }

  async function makeUser(displayName: string): Promise<{ user: User; token: string }> {
    const user = await store.createUser(displayName);
    return {
      user,
      token: signAccessToken(user, SECRET, 3600).token,
    };
  }

  async function createRoom(owner: User, id = 'room_a', name = 'Room A'): Promise<void> {
    await store.createDocument({ id, name, ownerId: owner.id });
    registry.ensureRoom(id);
  }

  function invite(roomId: string, role: 'editor' | 'viewer', ownerId: string): string {
    return signInviteToken({ roomId, role, ownerId }, SECRET, 3600).token;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    registry = new RoomRegistry();
    await ensureDemoRoom(store, registry, 'demo');
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    createGateway(server, {
      path: '/ws',
      store,
      registry,
      config: testConfig(),
    });
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('greets an authenticated client with the server identity', async () => {
    const { user, token } = await makeUser('Ada');
    const client = await connect();
    client.send({ t: 'auth', token });
    const welcome = await client.waitFor('welcome');
    expect(welcome.userId).toBe(user.id);
    expect(welcome.sessionId).toMatch(/^sess_/);
    expect(welcome.displayName).toBe('Ada');
  });

  it('refuses an expired token and closes the connection', async () => {
    const { user } = await makeUser('Ada');
    const expired = signAccessToken(user, SECRET, 60, Date.now() - 120_000).token;
    const client = await connect();
    client.send({ t: 'auth', token: expired });
    const error = await client.waitFor('error');
    expect(error.code).toBe('unauthorized');
    expect(await client.closed).toBe(4001);
  });

  it('refuses a tampered token', async () => {
    const { token } = await makeUser('Ada');
    const [header, payload, signature] = token.split('.');
    const client = await connect();
    client.send({ t: 'auth', token: `${header}.${payload}.${signature}x` });
    const error = await client.waitFor('error');
    expect(error.code).toBe('unauthorized');
    expect(await client.closed).toBe(4001);
  });

  it('requires authentication before joining', async () => {
    const client = await connect();
    client.send({ t: 'join', roomId: 'demo' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('unauthorized');
    expect(await client.closed).toBe(4001);
  });

  it('lets any signed-in user into the public demo room', async () => {
    const { token } = await makeUser('Ada');
    const client = await connectAs(token);
    client.send({ t: 'join', roomId: 'demo' });
    const joined = await client.waitFor('joined');
    expect(joined.role).toBe('editor');
    expect(joined.name).toBe('Demo canvas');

    const state = await client.waitFor('state');
    expect(state.objects.length).toBe(3);
    expect(state.objects.some((object) => object.id === 'demo-rect')).toBe(true);
  });

  it('refuses a room without a membership or a share link', async () => {
    const owner = await makeUser('Owner');
    const stranger = await makeUser('Stranger');
    await createRoom(owner.user);

    const client = await connectAs(stranger.token);
    client.send({ t: 'join', roomId: 'room_a' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
    expect(error.roomId).toBe('room_a');
    await client.expectNo('joined');
    await client.expectNo('state');
  });

  it('refuses a room that does not exist', async () => {
    const { token } = await makeUser('Ada');
    const client = await connectAs(token);
    client.send({ t: 'join', roomId: 'room_missing' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
    await client.expectNo('joined');
  });

  it('redeems a viewer invite and keeps the membership for reconnects', async () => {
    const owner = await makeUser('Owner');
    const viewer = await makeUser('Viewer');
    await createRoom(owner.user);

    const first = await connectAs(viewer.token);
    const joined = await joinRoom(first, 'room_a', invite('room_a', 'viewer', owner.user.id));
    expect(joined.role).toBe('viewer');
    expect(await store.membership('room_a', viewer.user.id)).toBe('viewer');

    // A reconnect without the invite now works through the membership.
    first.close();
    const second = await connectAs(viewer.token);
    const rejoined = await joinRoom(second, 'room_a');
    expect(rejoined.role).toBe('viewer');
  });

  it('refuses an expired share link', async () => {
    const owner = await makeUser('Owner');
    const stranger = await makeUser('Stranger');
    await createRoom(owner.user);

    const expired = signInviteToken(
      { roomId: 'room_a', role: 'editor', ownerId: owner.user.id },
      SECRET,
      60,
      Date.now() - 120_000,
    ).token;
    const client = await connectAs(stranger.token);
    client.send({ t: 'join', roomId: 'room_a', invite: expired });
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
    await client.expectNo('joined');
  });

  it('refuses a share link minted for another room', async () => {
    const owner = await makeUser('Owner');
    const stranger = await makeUser('Stranger');
    await createRoom(owner.user);

    const client = await connectAs(stranger.token);
    client.send({ t: 'join', roomId: 'room_a', invite: invite('room_b', 'editor', owner.user.id) });
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
  });

  it('rejects edits from a viewer without touching the room', async () => {
    const owner = await makeUser('Owner');
    const viewer = await makeUser('Viewer');
    await createRoom(owner.user);

    const ownerClient = await connectAs(owner.token);
    await joinRoom(ownerClient, 'room_a');
    const viewerClient = await connectAs(viewer.token);
    await joinRoom(viewerClient, 'room_a', invite('room_a', 'viewer', owner.user.id));

    const before = registry
      .snapshot('room_a')
      .objects.find((object) => object.id === 'demo-rect')?.x;

    viewerClient.send({
      t: 'ops',
      roomId: 'room_a',
      ops: [operation('op_viewer')],
    });

    const error = await viewerClient.waitFor('error');
    expect(error.code).toBe('forbidden');
    expect(error.opIds).toEqual(['op_viewer']);
    await ownerClient.expectNo('ops');

    const after = registry
      .snapshot('room_a')
      .objects.find((object) => object.id === 'demo-rect')?.x;
    expect(after).toBe(before);
  });

  it('lets an invited editor edit the room', async () => {
    const owner = await makeUser('Owner');
    const editor = await makeUser('Editor');
    await createRoom(owner.user);

    const ownerClient = await connectAs(owner.token);
    await joinRoom(ownerClient, 'room_a');
    const editorClient = await connectAs(editor.token);
    const joined = await joinRoom(
      editorClient,
      'room_a',
      invite('room_a', 'editor', owner.user.id),
    );
    expect(joined.role).toBe('editor');

    editorClient.send({
      t: 'ops',
      roomId: 'room_a',
      ops: [operation('op_editor', 'user_forged', 5)],
    });
    const broadcast = await ownerClient.waitFor('ops');
    expect(broadcast.ops[0]?.op).toEqual(setProp('demo-rect', 'x', 321));
  });

  it('broadcasts an operation to everybody in the room', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    const aliceClient = await connectAs(alice.token);
    const bobClient = await connectAs(bob.token);
    await joinRoom(aliceClient, 'demo');
    await joinRoom(bobClient, 'demo');

    aliceClient.send({
      t: 'ops',
      roomId: 'demo',
      ops: [operation('op_1')],
    });

    const forBob = await bobClient.waitFor('ops');
    expect(forBob.seq).toBe(1);
    expect(forBob.ops[0]?.op).toEqual(setProp('demo-rect', 'x', 321));

    // The author receives the broadcast too, so every replica folds the same
    // history — including the one that produced the operation.
    const forAlice = await aliceClient.waitFor('ops');
    expect(forAlice.ops[0]?.op).toEqual(setProp('demo-rect', 'x', 321));

    const ack = await aliceClient.waitFor('ack');
    expect(ack.opIds).toEqual(['op_1']);
  });

  it('stamps the actor id with the authenticated user', async () => {
    const alice = await makeUser('Alice');
    const client = await connectAs(alice.token);
    await joinRoom(client, 'demo');

    client.send({
      t: 'ops',
      roomId: 'demo',
      ops: [operation('op_1', 'user_forged', 2)],
    });

    const broadcast = await client.waitFor('ops');
    expect(broadcast.ops[0]?.actorId).toBe(alice.user.id);
    expect(broadcast.ops[0]?.hlc.actorId).toBe(alice.user.id);
  });

  it('does not deliver an operation to a client in another room', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    await createRoom(alice.user, 'room-a', 'Room A');
    await createRoom(alice.user, 'room-b', 'Room B');
    await store.grant('room-b', bob.user.id, 'editor');

    const aliceClient = await connectAs(alice.token);
    const bobClient = await connectAs(bob.token);
    await joinRoom(aliceClient, 'room-a');
    await joinRoom(bobClient, 'room-b');

    aliceClient.send({
      t: 'ops',
      roomId: 'room-a',
      ops: [operation('op_1')],
    });

    await aliceClient.waitFor('ops');
    await bobClient.expectNo('ops');
  });

  it('drops a repeated operation', async () => {
    const alice = await makeUser('Alice');
    const client = await connectAs(alice.token);
    await joinRoom(client, 'demo');

    const batch = {
      t: 'ops',
      roomId: 'demo',
      ops: [operation('op_1')],
    };
    client.send(batch);
    const first = await client.waitFor('ops');
    expect(first.seq).toBe(1);

    client.send(batch);
    // No second broadcast — the operation is already part of the room.
    await client.expectNo('ops');

    // The client is told to catch up, because it may have missed the
    // broadcast the first time.
    const state = await client.waitFor('state');
    expect(state.snapshotSeq).toBe(1);
  });

  it('sends a cursor to the room and removes it when the client disconnects', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    const aliceClient = await connectAs(alice.token);
    const bobClient = await connectAs(bob.token);
    await joinRoom(aliceClient, 'demo');
    await joinRoom(bobClient, 'demo');

    // Drain the join roster before looking at the cursor update.
    await aliceClient.waitFor('presence', 2_000, (message) => message.peers.length === 2);

    aliceClient.send({
      t: 'presence',
      roomId: 'demo',
      cursor: { x: 120, y: 80 },
      selection: ['demo-rect'],
    });

    const presence = await bobClient.waitFor('presence', 2_000, (message) =>
      message.peers.some((peer) => peer.cursor !== null),
    );
    const alicePeer = presence.peers.find((peer) => peer.userId === alice.user.id);
    expect(alicePeer?.cursor).toEqual({ x: 120, y: 80 });
    expect(alicePeer?.selection).toEqual(['demo-rect']);
    expect(alicePeer?.sessionId).toMatch(/^sess_/);

    // Disconnecting removes the cursor immediately, not after the TTL.
    aliceClient.close();
    const after = await bobClient.waitFor(
      'presence',
      2_000,
      (message) =>
        message.peers.length === 1 && message.peers.every((peer) => peer.userId !== alice.user.id),
    );
    expect(after.peers).toHaveLength(1);
    expect(after.peers[0]?.userId).toBe(bob.user.id);
    expect(after.peers[0]?.cursor).toBeNull();
  });

  it('tells the room who is in it', async () => {
    const alice = await makeUser('Alice');
    const bob = await makeUser('Bob');
    const aliceClient = await connectAs(alice.token);
    await joinRoom(aliceClient, 'demo');
    const bobClient = await connectAs(bob.token);
    await joinRoom(bobClient, 'demo');

    const presence = await aliceClient.waitFor(
      'presence',
      2_000,
      (message) => message.peers.length === 2,
    );
    expect(presence.peers).toHaveLength(2);
    expect(new Set(presence.peers.map((peer) => peer.sessionId)).size).toBe(2);
  });

  it('answers a ping', async () => {
    const { token } = await makeUser('Ada');
    const client = await connectAs(token);
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
