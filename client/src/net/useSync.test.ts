import { describe, expect, it } from 'vitest';
import { readSyncConfig } from './useSync';

describe('readSyncConfig', () => {
  it('falls back to the default gateway and room', () => {
    const config = readSyncConfig('');
    expect(config.roomId).toBe('demo');
    expect(config.url).toBe('ws://localhost:8080/ws');
    expect(config.displayName).toMatch(/^Guest /);
  });

  it('reads the room, the gateway and the name from the query string', () => {
    const config = readSyncConfig('?room=design-review&ws=wss://sync.example.com/ws&name=Ada');
    expect(config.roomId).toBe('design-review');
    expect(config.url).toBe('wss://sync.example.com/ws');
    expect(config.displayName).toBe('Ada');
  });

  it('generates a different guest name every time', () => {
    const first = readSyncConfig('').displayName;
    const second = readSyncConfig('').displayName;
    expect(first).not.toBe(second);
  });
});
