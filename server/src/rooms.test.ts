import { describe, expect, it } from 'vitest';
import type { Op, OpEnvelope } from '@syncanvas/shared';
import { RoomRegistry, type RoomMember } from './rooms.js';

function envelope(id: string, op: Op, actorId = 'user_1', wall = 1): OpEnvelope {
  return { id, actorId, hlc: { wall, counter: 0, actorId }, op };
}

function member(clientId: string): RoomMember {
  return {
    clientId,
    displayName: clientId,
    color: '#6366f1',
    cursor: null,
    selection: [],
    joinedAt: 0,
  };
}

describe('the room registry', () => {
  it('seeds a new room with the demo scene', () => {
    const registry = new RoomRegistry();
    const snapshot = registry.snapshot('demo');
    expect(snapshot.objects.length).toBe(4);
    expect(snapshot.objects.map((object) => object.id)).toContain('demo-rect');
    expect(snapshot.snapshotSeq).toBe(0);
  });

  it('keeps the state of a room when everyone leaves', () => {
    const registry = new RoomRegistry();
    registry.join('demo', member('user_1'));
    registry.applyOps('demo', [
      envelope('op_1', { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 500 }),
    ]);
    registry.leave('demo', 'user_1');
    const snapshot = registry.snapshot('demo');
    expect(snapshot.objects.find((object) => object.id === 'demo-rect')?.x).toBe(500);
  });

  it('applies the last write of a batch, not the first', () => {
    const registry = new RoomRegistry();
    registry.applyOps('demo', [
      envelope('op_1', { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 100 }),
      envelope('op_2', { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 300 }),
    ]);
    const snapshot = registry.snapshot('demo');
    expect(snapshot.objects.find((object) => object.id === 'demo-rect')?.x).toBe(300);
  });

  it('keeps the newest write by clock even when it arrives first', () => {
    const registry = new RoomRegistry();
    registry.applyOps('demo', [
      envelope(
        'newer',
        { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 200 },
        'user_1',
        20,
      ),
    ]);
    registry.applyOps('demo', [
      envelope(
        'older',
        { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 100 },
        'user_2',
        10,
      ),
    ]);
    const snapshot = registry.snapshot('demo');
    expect(snapshot.objects.find((object) => object.id === 'demo-rect')?.x).toBe(200);
  });

  it('tombstones a deleted object so a late edit cannot resurrect it', () => {
    const registry = new RoomRegistry();
    registry.applyOps('demo', [
      envelope('delete', { kind: 'deleteObject', objectId: 'demo-rect' }, 'user_1', 10),
    ]);
    registry.applyOps('demo', [
      envelope(
        'late',
        { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 999 },
        'user_2',
        20,
      ),
    ]);
    const snapshot = registry.snapshot('demo');
    expect(snapshot.objects.map((object) => object.id)).not.toContain('demo-rect');
  });

  it('ignores an operation it has already seen', () => {
    const registry = new RoomRegistry();
    const op = envelope('op_1', {
      kind: 'setProp',
      objectId: 'demo-rect',
      prop: 'x',
      value: 100,
    });
    const first = registry.applyOps('demo', [op]);
    const second = registry.applyOps('demo', [op]);
    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicates).toEqual(['op_1']);
    // A duplicate does not produce a new revision of the room.
    expect(second.seq).toBe(first.seq);
  });

  it('advances the sequence once per accepted batch', () => {
    const registry = new RoomRegistry();
    expect(registry.applyOps('demo', []).seq).toBe(0);
    expect(
      registry.applyOps('demo', [
        envelope('op_1', { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 1 }),
      ]).seq,
    ).toBe(1);
    expect(
      registry.applyOps('demo', [
        envelope('op_2', { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 2 }),
      ]).seq,
    ).toBe(2);
  });

  it('reports the peers of a room', () => {
    const registry = new RoomRegistry();
    registry.join('demo', member('user_1'));
    registry.join('demo', member('user_2'));
    const peers = registry.peers('demo');
    expect(peers.map((peer) => peer.userId)).toEqual(['user_1', 'user_2']);
    expect(registry.peers('other')).toEqual([]);
  });

  it('removes a client from every room it joined', () => {
    const registry = new RoomRegistry();
    registry.join('a', member('user_1'));
    registry.join('b', member('user_1'));
    expect(registry.leaveAll('user_1')).toEqual(['a', 'b']);
    expect(registry.peers('a')).toEqual([]);
    expect(registry.peers('b')).toEqual([]);
  });

  it('creates an object on top of the stack', () => {
    const registry = new RoomRegistry();
    registry.applyOps('demo', [
      envelope('op_1', {
        kind: 'createObject',
        object: {
          id: 'obj_new',
          type: 'rect',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          rotation: 0,
          fill: '#000',
          zIndex: 0,
        },
      }),
    ]);
    const snapshot = registry.snapshot('demo');
    expect(snapshot.objects).toHaveLength(5);
    expect(snapshot.objects[snapshot.objects.length - 1]?.id).toBe('obj_new');
  });
});
