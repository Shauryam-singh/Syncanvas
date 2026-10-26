import { describe, expect, it } from 'vitest';
import {
  signAccessToken,
  signInviteToken,
  signToken,
  verifyAccessToken,
  verifyInviteToken,
  verifyToken,
} from './jwt.js';

const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function user() {
  return { id: 'user_ada', displayName: 'Ada' };
}

describe('JWT tokens', () => {
  it('round-trips an access token', () => {
    const { token, expiresAt } = signAccessToken(user(), SECRET, 3600, NOW);
    expect(expiresAt).toBe(NOW + 3600_000);

    const claims = verifyAccessToken(token, SECRET, NOW + 1000);
    expect(claims?.sub).toBe('user_ada');
    expect(claims?.name).toBe('Ada');
    expect(claims?.typ).toBe('access');
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = signAccessToken(user(), SECRET, 3600, NOW);
    expect(verifyAccessToken(token, 'another-secret', NOW)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const { token } = signAccessToken(user(), SECRET, 3600, NOW);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, sub: 'user_attacker' }),
      'utf8',
    ).toString('base64url');

    expect(verifyAccessToken(`${header}.${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it('rejects a token whose algorithm was changed', () => {
    const payload = Buffer.from(
      JSON.stringify({ typ: 'access', sub: 'user_ada', name: 'Ada', iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    expect(verifyToken(`${noneHeader}.${payload}.`, SECRET, NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { token } = signAccessToken(user(), SECRET, 60, NOW);
    expect(verifyAccessToken(token, SECRET, NOW + 59_000)).not.toBeNull();
    expect(verifyAccessToken(token, SECRET, NOW + 61_000)).toBeNull();
  });

  it('rejects a missing or malformed expiry', () => {
    const withoutExp = signToken(
      { typ: 'access', sub: 'user_ada', name: 'Ada', iat: 1 } as never,
      SECRET,
    );
    expect(verifyAccessToken(withoutExp, SECRET, NOW)).toBeNull();
    expect(verifyAccessToken('not-a-token', SECRET, NOW)).toBeNull();
  });

  it('round-trips an invite and binds it to the room', () => {
    const { token } = signInviteToken(
      { roomId: 'room_1', role: 'viewer', ownerId: 'user_ada' },
      SECRET,
      3600,
      NOW,
    );
    expect(verifyInviteToken(token, SECRET, 'room_1', NOW)?.role).toBe('viewer');
    expect(verifyInviteToken(token, SECRET, 'room_2', NOW)).toBeNull();
  });

  it('does not accept an access token as an invite', () => {
    const { token } = signAccessToken(user(), SECRET, 3600, NOW);
    expect(verifyInviteToken(token, SECRET, 'room_1', NOW)).toBeNull();
  });

  it('rejects an expired invite', () => {
    const { token } = signInviteToken(
      { roomId: 'room_1', role: 'editor', ownerId: 'user_ada' },
      SECRET,
      60,
      NOW,
    );
    expect(verifyInviteToken(token, SECRET, 'room_1', NOW + 61_000)).toBeNull();
  });
});
