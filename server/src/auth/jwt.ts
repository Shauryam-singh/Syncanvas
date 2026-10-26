import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RoomRole } from '@syncanvas/shared';

/**
 * A deliberately small HS256 JWT implementation.
 *
 * The project already hand-rolls the merge semantics; keeping tokens
 * dependency-free means the whole auth path is auditable in one file. The
 * rules are the important part:
 *
 * - only HS256 is accepted (no `alg: none`, no algorithm substitution);
 * - the signature is compared in constant time;
 * - `exp` is mandatory and checked against the clock supplied by the caller;
 * - claim shapes are validated after the signature, never before.
 */

interface BaseClaims {
  iat: number;
  exp: number;
}

export interface AccessClaims extends BaseClaims {
  typ: 'access';
  /** User id. */
  sub: string;
  /** Display name at the time the token was issued. */
  name: string;
}

export interface InviteClaims extends BaseClaims {
  typ: 'invite';
  /** The room this share link grants access to. */
  room: string;
  role: Exclude<RoomRole, 'owner'>;
  /** The user who minted the link (used to restore an ephemeral room). */
  owner: string;
}

export type Claims = AccessClaims | InviteClaims;

/** The header is constant: the server never signs or accepts anything else. */
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/** Leeway tolerated for timestamps that are slightly ahead of the server. */
const CLOCK_SKEW_SECONDS = 30;

function sign(secret: string, signingInput: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignatureValid(signature: string, expected: string): boolean {
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Signs an arbitrary claim set. Exposed for tests and the token helpers. */
export function signToken(claims: Claims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${sign(secret, signingInput)}`;
}

/**
 * Verifies the signature, algorithm and expiry of a token.
 *
 * Returns `null` for anything malformed, tampered with, signed with another
 * secret, or expired. The caller still has to check the claim it needs.
 */
export function verifyToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Claims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;

  // Pin the header (and therefore the algorithm) instead of trusting it.
  if (header !== HEADER) return null;
  if (!isSignatureValid(signature, sign(secret, `${header}.${payload}`))) return null;

  const body = decodeSegment(payload);
  if (!isRecord(body)) return null;

  const now = Math.floor(nowMs / 1000);
  if (typeof body.exp !== 'number' || !Number.isFinite(body.exp)) return null;
  if (body.exp <= now) return null;
  if (typeof body.iat !== 'number' || !Number.isFinite(body.iat)) return null;
  if (body.iat > now + CLOCK_SKEW_SECONDS) return null;

  if (body.typ !== 'access' && body.typ !== 'invite') return null;
  return body as unknown as Claims;
}

export interface TokenResult {
  token: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

export function signAccessToken(
  user: { id: string; displayName: string },
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): TokenResult {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.max(1, Math.floor(ttlSeconds));
  return {
    token: signToken({ typ: 'access', sub: user.id, name: user.displayName, iat, exp }, secret),
    expiresAt: exp * 1000,
  };
}

export function verifyAccessToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): AccessClaims | null {
  const claims = verifyToken(token, secret, nowMs);
  if (!claims || claims.typ !== 'access') return null;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
  if (typeof claims.name !== 'string') return null;
  return claims;
}

export function signInviteToken(
  invite: { roomId: string; role: Exclude<RoomRole, 'owner'>; ownerId: string },
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): TokenResult {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.max(1, Math.floor(ttlSeconds));
  return {
    token: signToken(
      {
        typ: 'invite',
        room: invite.roomId,
        role: invite.role,
        owner: invite.ownerId,
        iat,
        exp,
      },
      secret,
    ),
    expiresAt: exp * 1000,
  };
}

export function verifyInviteToken(
  token: string,
  secret: string,
  roomId: string,
  nowMs: number = Date.now(),
): InviteClaims | null {
  const claims = verifyToken(token, secret, nowMs);
  if (!claims || claims.typ !== 'invite') return null;
  if (claims.room !== roomId) return null;
  if (typeof claims.owner !== 'string' || claims.owner.length === 0) return null;
  if (claims.role !== 'editor' && claims.role !== 'viewer') return null;
  return claims;
}
