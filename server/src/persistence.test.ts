import { describe, expect, it } from 'vitest';
import {
  createDoc,
  createInitialScene,
  createSceneObject,
  deserializeDoc,
  mergeEnvelopes,
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

  it('writes accepted operations, then snapshots and compacts them on flush', async () => {
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

    // The snapshot subsumes the only operation, so compaction removes it.
    const operations = await store.loadOperations('room_flush', 0);
    expect(operations).toEqual([]);
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

  it('compacts only the log entries a snapshot covers, without changing state', async () => {
    const store = new MemoryStore();
    const user = await store.createUser('Ada');
    await store.createDocument({ id: 'room_compact', name: 'Compact', ownerId: user.id });

    const writes = [11, 22, 33, 44].map((value, index) =>
      envelope(`op_${index + 1}`, user.id, index + 1, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value,
      }),
    );
    const fullDoc = mergeEnvelopes(createDoc(createInitialScene()), writes);

    // A snapshot after the first two writes. The remaining two must stay in
    // the log so replay can reach the full document.
    const prefixDoc = mergeEnvelopes(createDoc(createInitialScene()), writes.slice(0, 2));
    await store.saveSnapshot('room_compact', 2, serializeDoc(prefixDoc));
    // appendOperations is async; let the four writes land before compacting.
    await Promise.all([
      store.appendOperations('room_compact', 1, [writes[0] as OpEnvelope]),
      store.appendOperations('room_compact', 2, [writes[1] as OpEnvelope]),
      store.appendOperations('room_compact', 3, [writes[2] as OpEnvelope]),
      store.appendOperations('room_compact', 4, [writes[3] as OpEnvelope]),
    ]);

    const removed = await store.compactOperations('room_compact', 2);
    expect(removed).toBe(2);
    const remaining = await store.loadOperations('room_compact', 0);
    expect(remaining.map((operation) => operation.id)).toEqual(['op_3', 'op_4']);

    const replayed = new RoomRegistry();
    await loadRooms(store, replayed);
    expect(serializeDoc(replayed.room('room_compact')!.doc)).toEqual(serializeDoc(fullDoc));
  });

  it('retries when another gateway compacts between the snapshot and log reads', async () => {
    // Simulate the first read racing a compaction on another instance: it
    // sees no snapshot, and by the time it queries the log, the rows it needs
    // have been deleted. The newer snapshot only becomes visible afterwards.
    class RacingStore extends MemoryStore {
      private raced = false;

      override async latestSnapshot(documentId: string) {
        if (!this.raced) return null;
        return super.latestSnapshot(documentId);
      }

      override async loadOperations(documentId: string, afterSeq: number) {
        if (!this.raced) {
          this.raced = true;
          return [];
        }
        return super.loadOperations(documentId, afterSeq);
      }
    }

    const store = new RacingStore();
    const user = await store.createUser('Ada');
    await store.createDocument({ id: 'room_race', name: 'Race', ownerId: user.id });
    const doc = mergeEnvelopes(createDoc(createInitialScene()), [
      envelope('op_race', user.id, 10, {
        kind: 'setProp',
        objectId: 'demo-rect',
        prop: 'x',
        value: 777,
      }),
    ]);
    await store.saveSnapshot('room_race', 1, serializeDoc(doc));

    const registry = new RoomRegistry();
    await loadRooms(store, registry);
    expect(
      registry.snapshot('room_race').objects.find((object) => object.id === 'demo-rect')?.x,
    ).toBe(777);
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
