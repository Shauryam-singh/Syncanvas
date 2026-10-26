import type { RoomRole } from './protocol.js';

/**
 * Types shared by the HTTP API and the editor.
 *
 * The WebSocket carries the scene, the cursors and the operations; the HTTP
 * API only deals with identity and access (who is this, which rooms may they
 * open, what does a share link look like). Keeping the shapes here means the
 * client and the server cannot drift apart.
 */

export interface PublicUser {
  id: string;
  displayName: string;
}

export interface SessionResponse {
  token: string;
  user: PublicUser;
  /** Unix milliseconds at which the access token stops being valid. */
  expiresAt: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  ownerId: string;
  role: RoomRole;
  createdAt: string;
}

export interface InviteLinks {
  /** Share-link token that grants the `editor` role. */
  editor: string;
  /** Share-link token that grants the `viewer` role. */
  viewer: string;
}

export interface CreateRoomResponse {
  room: RoomInfo;
  invites: InviteLinks;
}

export interface CreateInviteResponse {
  token: string;
  role: 'editor' | 'viewer';
  expiresAt: number;
}

export interface RoomListResponse {
  rooms: RoomInfo[];
}

export interface ApiErrorBody {
  error: {
    code:
      'unauthorized' | 'forbidden' | 'not_found' | 'invalid_request' | 'rate_limited' | 'internal';
    message: string;
  };
}
