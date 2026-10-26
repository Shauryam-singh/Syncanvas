import { describe, expect, it } from 'vitest';
import { demoRoomUrl } from './urls';

describe('demoRoomUrl', () => {
  it('leaves an old room and invite behind but keeps the gateway override', () => {
    const target = new URL(
      demoRoomUrl(
        'http://localhost:5173/?room=secret&invite=signed&ws=ws://gateway:8080/ws&signedout=1',
        '  Ada   Lovelace ',
      ),
    );

    expect(target.searchParams.get('room')).toBe('demo');
    expect(target.searchParams.get('name')).toBe('Ada Lovelace');
    expect(target.searchParams.get('ws')).toBe('ws://gateway:8080/ws');
    expect(target.searchParams.has('invite')).toBe(false);
    expect(target.searchParams.has('signedout')).toBe(false);
  });

  it('uses a random guest name when no name is entered', () => {
    const target = new URL(demoRoomUrl('http://localhost:5173/?signedout=1', '   '));
    expect(target.searchParams.has('name')).toBe(false);
  });
});
