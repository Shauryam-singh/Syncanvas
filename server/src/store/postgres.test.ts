import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDoc,
  createInitialScene,
  deserializeDoc,
  mergeEnvelopes,
  serializeDoc,
  type Op,
  type OpEnvelope,
} from '@syncanvas/shared';
import { loadRooms } from '../persistence.js';
import { RoomRegistry } from '../rooms.js';
import { PostgresStore } from './postgres.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

function envelope(id: string, actorId: string, wall: number, op: Op): OpEnvelope {
  return { id, actorId, hlc: { wall, counter: 0, actorId }, op };
}

suite('PostgresStore', () => {
  let store: PostgresStore;
  let admin: pg.Pool;

  beforeAll(async () => {
    store = new PostgresStore(DATABASE_URL as string, { max: 2 });
    // Running twice also proves the schema is idempotent.
    await store.initialize();
    await store.initialize();
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await admin.query('TRUNCATE snapshots, operations, memberships, documents, users CASCADE');
  });

  afterAll(async () => {
    await admin.end();
    await store.close();
  });

  it('round-trips users, documents and memberships', async () => {
    const owner = await store.createUser('Owner');
    const viewer = await store.createUser('Viewer');
    const document = await store.createDocument({
      id: 'room_pg',
      name: 'Postgres room',
      ownerId: owner.id,
    });

    expect(document.ownerId).toBe(owner.id);
    expect(await store.membership('room_pg', owner.id)).toBe('owner');
    expect(await store.membership('room_pg', viewer.id)).toBeNull();

    expect(await store.grant('room_pg', viewer.id, 'viewer')).toBe('viewer');
    expect(await store.grant('room_pg', viewer.id, 'editor')).toBe('editor');
    // A viewer invite never downgrades an editor.
    expect(await store.grant('room_pg', viewer.id, 'viewer')).toBe('editor');
    // …and nothing downgrades an owner.
    expect(await store.grant('room_pg', owner.id, 'viewer')).toBe('owner');

    const summaries = await store.documentsFor(viewer.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.document.id).toBe('room_pg');
    expect(summaries[0]?.role).toBe('editor');

    expect(await store.user(owner.id)).toMatchObject({
      id: owner.id,
      displayName: 'Owner',
    });
    expect(await store.renameUser(owner.id, 'Owner Renamed')).toMatchObject({
      id: owner.id,
      displayName: 'Owner Renamed',
    });
    expect(await store.user(owner.id)).toMatchObject({ displayName: 'Owner Renamed' });
    expect(await store.renameUser('user_missing', 'Nobody')).toBeNull();
    expect((await store.allDocuments()).map((doc) => doc.id)).toEqual(['room_pg']);
  });

  it('persists the operation log and snapshots', async () => {
    const user = await store.createUser('Log');
    const document = await store.createDocument({
      id: 'room_log',
      name: 'Log room',
      ownerId: user.id,
    });

    const first = envelope('op_1', user.id, 10, {
      kind: 'setProp',
      objectId: 'demo-rect',
      prop: 'x',
      value: 111,
    });
    const second = envelope('op_2', user.id, 20, {
      kind: 'setProp',
      objectId: 'demo-rect',
      prop: 'x',
      value: 222,
    });

    await store.appendOperations(document.id, 1, [first]);
    await store.appendOperations(document.id, 2, [second]);
    // Re-sending an operation is a no-op, not a duplicate row.
    await store.appendOperations(document.id, 3, [second]);

    expect(await store.latestSeq(document.id)).toBe(2);
    expect((await store.loadOperations(document.id, 0)).map((op) => op.id)).toEqual([
      'op_1',
      'op_2',
    ]);
    expect((await store.loadOperations(document.id, 1)).map((op) => op.id)).toEqual(['op_2']);

    const snapshotDoc = createDoc(createInitialScene());
    await store.saveSnapshot(document.id, 2, serializeDoc(snapshotDoc));
    const snapshot = await store.latestSnapshot(document.id);
    expect(snapshot?.seq).toBe(2);
    expect(deserializeDoc(snapshot?.doc).objects.size).toBe(3);
  });

  it('rebuilds a room from the snapshot plus later operations', async () => {
    const user = await store.createUser('Loader');
    const document = await store.createDocument({
      id: 'room_load',
      name: 'Load room',
      ownerId: user.id,
    });

    // The snapshot says x=10; the operation after it says x=999.
    const snapshotDoc = mergeEnvelopes(createDoc(createInitialScene()), [
      envelope('op_before', user.id, 5, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 10,
      }),
    ]);
    await store.saveSnapshot(document.id, 4, serializeDoc(snapshotDoc));
    await store.appendOperations(document.id, 5, [
      envelope('op_after', user.id, 30, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 999,
      }),
    ]);

    const registry = new RoomRegistry();
    await loadRooms(store, registry);
    const room = registry.room('room_load');
    expect(room?.seq).toBe(5);
    const rect = registry.snapshot('room_load').objects.find((object) => object.id === 'demo-rect');
    expect(rect?.x).toBe(999);
  });

  it('compacts only covered operations and still rebuilds the full document', async () => {
    const user = await store.createUser('Compact');
    const document = await store.createDocument({
      id: 'room_compaction',
      name: 'Compaction room',
      ownerId: user.id,
    });

    const writes = [11, 22, 33, 44].map((value, index) =>
      envelope(`compact_${index + 1}`, user.id, index + 1, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value,
      }),
    );
    const fullDoc = mergeEnvelopes(createDoc(createInitialScene()), writes);
    const prefixDoc = mergeEnvelopes(createDoc(createInitialScene()), writes.slice(0, 2));

    await store.saveSnapshot(document.id, 2, serializeDoc(prefixDoc));
    for (const [index, write] of writes.entries()) {
      await store.appendOperations(document.id, index + 1, [write]);
    }

    expect(await store.compactOperations(document.id, 2)).toBe(2);
    expect((await store.loadOperations(document.id, 0)).map((op) => op.id)).toEqual([
      'compact_3',
      'compact_4',
    ]);

    const registry = new RoomRegistry();
    await loadRooms(store, registry);
    expect(serializeDoc(registry.room(document.id)!.doc)).toEqual(serializeDoc(fullDoc));
    expect(registry.room(document.id)?.seq).toBe(4);
  });
});
