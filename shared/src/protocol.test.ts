import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage } from './protocol.js';

describe('client message parsing', () => {
  it('accepts the lifecycle messages', () => {
    expect(parseClientMessage('{"t":"auth","token":"dev"}')).toEqual({
      t: 'auth',
      token: 'dev',
    });
    expect(parseClientMessage('{"t":"join","roomId":"demo"}')).toEqual({
      t: 'join',
      roomId: 'demo',
    });
    expect(parseClientMessage('{"t":"ping"}')).toEqual({ t: 'ping' });
  });

  it('accepts a batch of operations', () => {
    const raw = JSON.stringify({
      t: 'ops',
      roomId: 'demo',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_1',
          hlc: { wall: 10, counter: 0, actorId: 'user_1' },
          op: { kind: 'setProp', objectId: 'demo-rect', prop: 'x', value: 42 },
        },
      ],
    });
    const message = parseClientMessage(raw);
    expect(message?.t).toBe('ops');
  });

  it('rejects malformed frames instead of throwing', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage('{"t":"nope"}')).toBeNull();
    expect(parseClientMessage('{"t":"join"}')).toBeNull();
    expect(parseClientMessage('{"t":"join","roomId":7}')).toBeNull();
  });

  it('rejects an operation with an unknown kind', () => {
    const raw = JSON.stringify({
      t: 'ops',
      roomId: 'demo',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_1',
          hlc: { wall: 10, counter: 0, actorId: 'user_1' },
          op: { kind: 'dropTheDatabase', objectId: 'demo-rect' },
        },
      ],
    });
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('rejects an operation that writes an immutable property', () => {
    const raw = JSON.stringify({
      t: 'ops',
      roomId: 'demo',
      ops: [
        {
          id: 'op_1',
          actorId: 'user_1',
          hlc: { wall: 10, counter: 0, actorId: 'user_1' },
          op: { kind: 'setProp', objectId: 'demo-rect', prop: 'id', value: 'other' },
        },
      ],
    });
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('rejects a malformed envelope', () => {
    const raw = JSON.stringify({
      t: 'ops',
      roomId: 'demo',
      ops: [{ id: 'op_1', actorId: 'user_1', hlc: { wall: 10 } }],
    });
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe('server message parsing', () => {
  it('accepts a welcome', () => {
    const message = parseServerMessage(
      '{"t":"welcome","userId":"user_1","displayName":"Ada","color":"#6366f1"}',
    );
    expect(message?.t).toBe('welcome');
  });

  it('accepts a state with objects', () => {
    const raw = JSON.stringify({
      t: 'state',
      roomId: 'demo',
      snapshotSeq: 3,
      objects: [
        {
          id: 'demo-rect',
          type: 'rect',
          x: 1,
          y: 2,
          w: 3,
          h: 4,
          rotation: 0,
          fill: '#fff',
          zIndex: 0,
        },
      ],
      ops: [],
    });
    expect(parseServerMessage(raw)?.t).toBe('state');
  });

  it('rejects a state with a broken object', () => {
    const raw = JSON.stringify({
      t: 'state',
      roomId: 'demo',
      snapshotSeq: 3,
      objects: [{ id: 'demo-rect', type: 'triangle' }],
      ops: [],
    });
    expect(parseServerMessage(raw)).toBeNull();
  });

  it('rejects unknown and malformed frames', () => {
    expect(parseServerMessage('{"t":"launch_missiles"}')).toBeNull();
    expect(parseServerMessage('{"t":"pong"')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
  });
});
