import { describe, expect, it } from 'vitest';
import {
  createDoc,
  createInitialScene,
  createSceneObject,
  deserializeDoc,
  serializeDoc,
  toSceneState,
  type Op,
  type OpEnvelope,
} from '@syncanvas/shared';
import { loadRooms, RoomPersistence } from './persistence.js';
import { RoomRegistry } from './rooms.js';
import { MemoryStore } from './store/memory.js';

function envelope(id: string, actorId: string, wall: number, op: Op): OpEnvelope {
  return { id, actorId, hlc: { wall, counter: 0, actorId }, op };
}

describe('room persistence', () => {
  it('replays operations into a fresh registry after a restart', async () => {
    const store = new MemoryStore();
    const user = await store.createUser('Ada');
    const document = await store.createDocument({
      id: 'room_restart',
      name: 'Restart',
      ownerId: user.id,
    });
    await store.appendOperations(document.id, 1, [
      envelope('op_1', user.id, 10, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 456,
      }),
    ]);

    const registry = new RoomRegistry();
    await loadRooms(store, registry);
    const rect = registry
      .snapshot('room_restart')
      .objects.find((object) => object.id === 'demo-rect');
    expect(rect?.x).toBe(456);
    expect(registry.room('room_restart')?.seq).toBe(1);
  });

  it('prunes an untouched retired seed object from an old snapshot', async () => {
    const store = new MemoryStore();
    const user = await store.createUser('Ada');
    const document = await store.createDocument({
      id: 'room_legacy',
      name: 'Legacy',
      ownerId: user.id,
    });
    const legacyText = createSceneObject({
      id: 'demo-text',
      type: 'text',
      x: 100,
      y: 260,
      w: 320,
      h: 44,
      fill: '#0f172a',
      text: 'Drag, resize, rotate — every edit is an operation',
    });
    const oldDoc = createDoc([...createInitialScene(), legacyText]);
    await store.saveSnapshot(document.id, 0, serializeDoc(oldDoc));

    const registry = new RoomRegistry();
    await loadRooms(store, registry);
    const ids = registry.snapshot('room_legacy').objects.map((object) => object.id);
    expect(ids).not.toContain('demo-text');
    expect(ids).toContain('demo-rect');
  });

  it('writes accepted operations and flushes a snapshot', async () => {
    const store = new MemoryStore();
    const user = await store.createUser('Ada');
    await store.createDocument({ id: 'room_flush', name: 'Flush', ownerId: user.id });
    const registry = new RoomRegistry();
    registry.ensureRoom('room_flush');
    const persistence = new RoomPersistence(store, registry, { snapshotEvery: 2 });

    const result = registry.applyOps('room_flush', [
      envelope('op_1', user.id, 10, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 321,
      }),
    ]);
    persistence.append('room_flush', result.seq, result.accepted);
    await persistence.flush();

    const operations = await store.loadOperations('room_flush', 0);
    expect(operations.map((op) => op.id)).toEqual(['op_1']);
    const snapshot = await store.latestSnapshot('room_flush');
    expect(snapshot?.seq).toBe(1);
    expect(snapshot).not.toBeNull();
    const snapshotDoc = deserializeDoc(snapshot?.doc);
    expect(toSceneState(snapshotDoc).objects.get('demo-rect')?.x).toBe(321);

    // A fresh registry restores the same state from the snapshot.
    const restored = new RoomRegistry();
    await loadRooms(store, restored);
    expect(
      restored.snapshot('room_flush').objects.find((object) => object.id === 'demo-rect')?.x,
    ).toBe(321);
  });

  it('rejects a resend that predates the snapshot after a restart', async () => {
    const store = new MemoryStore();
    const user = await store.createUser('Ada');
    await store.createDocument({ id: 'room_dedupe', name: 'Dedupe', ownerId: user.id });
    const registry = new RoomRegistry();
    registry.ensureRoom('room_dedupe');
    const persistence = new RoomPersistence(store, registry, { snapshotEvery: 10 });

    const first = registry.applyOps('room_dedupe', [
      envelope('op_old', user.id, 10, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 111,
      }),
      envelope('op_new', user.id, 20, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 222,
      }),
    ]);
    persistence.append('room_dedupe', first.seq, first.accepted);
    await persistence.flush();

    const restored = new RoomRegistry();
    await loadRooms(store, restored);
    // The client missed the ack before the restart and resends the old write.
    const replay = restored.applyOps('room_dedupe', [
      envelope('op_old', user.id, 10, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 111,
      }),
    ]);
    expect(replay.duplicates).toEqual(['op_old']);
    expect(replay.accepted).toEqual([]);
    expect(
      restored.snapshot('room_dedupe').objects.find((object) => object.id === 'demo-rect')?.x,
    ).toBe(222);
  });
});
