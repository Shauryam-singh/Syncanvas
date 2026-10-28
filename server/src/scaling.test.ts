import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  parseServerMessage,
  serializeScene,
  toSceneState,
  type Op,
  type ServerMessage,
} from '@syncanvas/shared';
import { signAccessToken } from './auth/jwt.js';
import { MemoryRoomBus, MemoryRoomBusHub, type RoomBus } from './bus.js';
import { config } from './config.js';
import { createGateway } from './gateway.js';
import { loadRooms, RoomPersistence } from './persistence.js';
import { RoomRegistry } from './rooms.js';
import { MemoryStore } from './store/memory.js';
import type { User } from './store/types.js';

const SECRET = 'gateway-test-secret';
const ROOM = 'room_scale';

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
      if (Date.now() > deadline) throw new Error(`timed out waiting for a "${type}" message`);
      await delay(5);
    }
  }

  close(): void {
    this.socket.close();
  }
}

function operation(id: string, actorId: string, wall: number, value: number) {
  const op: Op = { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value };
  return { id, actorId, hlc: { wall, counter: 0, actorId }, op };
}

interface Instance {
  server: Server;
  gateway: ReturnType<typeof createGateway>;
  persistence: RoomPersistence;
  registry: RoomRegistry;
  bus: RoomBus;
  url: string;
}

describe('multiple gateway instances', () => {
  let store: MemoryStore;
  let hub: MemoryRoomBusHub;
  let instances: Instance[];
  let clients: TestClient[];
  let owner: User;
  let editor: User;

  async function startInstance(id: string, bus: RoomBus): Promise<Instance> {
    const registry = new RoomRegistry();
    const persistence = new RoomPersistence(store, registry);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const gateway = createGateway(server, {
      path: '/ws',
      store,
      registry,
      config: testConfig(),
      persistence,
      bus,
    });
    const { port } = server.address() as AddressInfo;
    return { server, gateway, persistence, registry, bus, url: `ws://127.0.0.1:${port}/ws` };
  }

  async function connect(instance: Instance, user: User): Promise<TestClient> {
    const client = new TestClient(instance.url);
    clients.push(client);
    await client.open();
    const token = signAccessToken(user, SECRET, 3600).token;
    client.send({ t: 'auth', token });
    await client.waitFor('welcome');
    client.send({ t: 'join', roomId: ROOM });
    await client.waitFor('joined');
    await client.waitFor('state');
    return client;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    hub = new MemoryRoomBusHub();
    const gateway1Bus = new MemoryRoomBus('gateway-1', hub);
    const gateway2Bus = new MemoryRoomBus('gateway-2', hub);
    instances = [];
    clients = [];

    const ownerRecord = await store.createUser('Owner');
    const editorRecord = await store.createUser('Editor');
    owner = ownerRecord;
    editor = editorRecord;
    await store.createDocument({ id: ROOM, name: 'Scaled room', ownerId: owner.id });
    await store.grant(ROOM, editor.id, 'editor');

    instances.push(await startInstance('gateway-1', gateway1Bus));
    instances.push(await startInstance('gateway-2', gateway2Bus));
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const instance of instances) {
      await instance.gateway.drain();
      instance.gateway.wss.close();
      await new Promise<void>((resolve) => instance.server.close(() => resolve()));
      await instance.bus.close();
    }
    hub.close();
  });

  it('fans an edit out to a client connected to another gateway', async () => {
    const first = await connect(instances[0] as Instance, owner);
    const second = await connect(instances[1] as Instance, editor);

    // The roster crosses instances, not just rooms.
    const roster = await first.waitFor('presence', 2_000, (message) => message.peers.length === 2);
    expect(new Set(roster.peers.map((peer) => peer.userId))).toEqual(
      new Set([owner.id, editor.id]),
    );

    first.send({
      t: 'ops',
      roomId: ROOM,
      ops: [operation('op_alice', owner.id, 10, 444)],
    });

    const remote = await second.waitFor('ops');
    expect(remote.seq).toBe(1);
    expect(remote.ops[0]?.op).toEqual({
      kind: 'setProp',
      objectId: 'demo-rect',
      prop: 'x',
      value: 444,
    });
    await first.waitFor('ops');
    await first.waitFor('ack');

    second.send({
      t: 'ops',
      roomId: ROOM,
      ops: [operation('op_editor', editor.id, 20, 555)],
    });
    await second.waitFor('ops');
    await second.waitFor('ack');
    await first.waitFor('ops', 2_000, (message) => message.ops[0]?.id === 'op_editor');

    await instances[0]?.gateway.drain();
    await instances[1]?.gateway.drain();
    await delay(20);

    const left = instances[0]?.registry.snapshot(ROOM).objects;
    const right = instances[1]?.registry.snapshot(ROOM).objects;
    expect(left).toEqual(right);
    expect(left?.find((object) => object.id === 'demo-rect')?.x).toBe(555);
    expect(instances[0]?.registry.room(ROOM)?.seq).toBe(2);
    expect(instances[1]?.registry.room(ROOM)?.seq).toBe(2);
  });

  it('keeps snapshot replay equal to the live replica after log compaction', async () => {
    const client = await connect(instances[0] as Instance, owner);

    for (let index = 1; index <= 6; index += 1) {
      client.send({
        t: 'ops',
        roomId: ROOM,
        ops: [operation(`op_${index}`, owner.id, index, index * 10)],
      });
      await client.waitFor('ops');
      await client.waitFor('ack');
    }

    await instances[0]?.gateway.drain();
    await instances[1]?.gateway.drain();
    await instances[0]?.persistence.flush();
    await instances[1]?.persistence.flush();

    const live = instances[0]?.registry.room(ROOM);
    expect(live).toBeDefined();
    const liveScene = serializeScene(toSceneState(live!.doc));

    const restored = new RoomRegistry();
    await loadRooms(store, restored);
    const restoredState = restored.room(ROOM);
    expect(restoredState?.seq).toBe(6);
    expect(serializeScene(toSceneState(restoredState!.doc))).toEqual(liveScene);
  });
});
