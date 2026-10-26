import { useEffect, useMemo } from 'react';
import { useSceneStore } from '../store/sceneStore';
import { signInGuest } from './api';
import { clearSession, loadSession, saveSession, setActiveSession } from './session';
import { SyncClient } from './syncClient';

/** Where the gateway lives. Overridable for deployments behind a proxy. */
const DEFAULT_WS_URL = 'ws://localhost:8080/ws';

/** Fail fast when there is no gateway; the editor falls back to local mode. */
const SIGN_IN_TIMEOUT_MS = 2_500;

export interface SyncConfig {
  url: string;
  roomId: string;
  displayName: string;
  /** Signed share link from `?invite=`. */
  invite?: string;
  /** True when `?name=` was supplied, so the cached guest is not reused. */
  explicitName?: boolean;
  /** True after signing out: show the name gate instead of creating a guest. */
  signedOut?: boolean;
}

/**
 * Reads the sync configuration from the URL.
 *
 * `?room=design-review` picks the room, `?invite=…` redeems a share link,
 * `?ws=wss://…` points at another gateway, `?name=Ada` sets the display name.
 */
export function readSyncConfig(search: string = window.location.search): SyncConfig {
  const params = new URLSearchParams(search);
  const name = params.get('name');
  return {
    url: params.get('ws') ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL,
    roomId: params.get('room') ?? 'demo',
    displayName: name ?? `Guest ${Math.random().toString(36).slice(2, 6)}`,
    invite: params.get('invite') ?? undefined,
    explicitName: name !== null,
    signedOut: params.get('signedout') === '1',
  };
}

/**
 * Connects the editor to the gateway.
 *
 * The hook owns the whole conversation: it signs in (or reuses a cached guest
 * session), authenticates the socket, joins the room, and then wires the sync
 * client to the store. If the HTTP API is not reachable it falls back to the
 * local editor from stage 1, which is what `npm run smoke` relies on.
 */
export function useSync(config?: SyncConfig): void {
  // The configuration is read once per mount. It has to be: the display name
  // is generated randomly, so reading it on every render would reconnect the
  // client on every render.
  const fallback = useMemo(() => readSyncConfig(), []);
  const url = config?.url ?? fallback.url;
  const roomId = config?.roomId ?? fallback.roomId;
  const displayName = config?.displayName ?? fallback.displayName;
  const invite = config?.invite ?? fallback.invite;
  const explicitName = config?.explicitName ?? fallback.explicitName ?? false;
  const signedOut = config?.signedOut ?? fallback.signedOut ?? false;

  useEffect(() => {
    let disposed = false;
    let client: SyncClient | null = null;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const store = useSceneStore.getState();
    store.setAccess('checking');
    store.setOpSender(null);
    store.setPresenceSender(null);
    store.setPeers([]);
    store.setError(null);

    // Signing out is a deliberate stop: do not immediately mint a new guest
    // and re-enter the room. The access gate asks for a display name first.
    if (signedOut) {
      store.setAccess('signedout');
      store.setConnection('local');
      store.setSession(null);
      return () => {
        disposed = true;
        if (timeout) clearTimeout(timeout);
        unsubscribe();
        client?.close();
        client = null;
      };
    }

    const server = (() => {
      try {
        const parsed = new URL(url);
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
        return parsed.origin;
      } catch {
        return 'http://localhost:8080';
      }
    })();

    const boot = async () => {
      const cached = loadSession(server, explicitName ? displayName : undefined);
      let session = cached;

      if (!session) {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS);
        try {
          const fresh = await signInGuest(server, displayName, controller.signal);
          if (disposed) return;
          session = { ...fresh, server };
          saveSession(session);
        } catch {
          if (disposed) return;
          // No gateway (or no API): keep the stage-1 local editor alive.
          useSceneStore.getState().setAccess('local');
          useSceneStore.getState().setConnection('local');
          useSceneStore.getState().setSession(null);
          return;
        } finally {
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
        }
      }

      if (disposed || !session) return;

      setActiveSession(session);
      const current = useSceneStore.getState();
      current.setRoomId(roomId);
      current.setSession({
        userId: session.user.id,
        displayName: session.user.displayName,
      });

      client = new SyncClient({
        url,
        roomId,
        token: session.token,
        invite,
        onConnection: (connection) => {
          useSceneStore.getState().setConnection(connection);
        },
        onState: ({ objects }) => {
          useSceneStore.getState().loadScene(objects);
        },
        onOps: (envelopes, meta) => {
          useSceneStore.getState().applyServerOps(envelopes, meta);
        },
        onPeers: (peers) => {
          useSceneStore.getState().setPeers(peers);
        },
        onJoined: ({ role, roomName, sessionId }) => {
          const state = useSceneStore.getState();
          state.setJoined({ role, roomName, sessionId });
          state.setPresenceSender((cursor, selection) => {
            client?.sendPresence(cursor, selection);
          });
          // Announce where this client is looking, not just where it moves.
          client?.sendPresence(null, state.selection);
        },
        onUnauthorized: (message) => {
          clearSession();
          const state = useSceneStore.getState();
          state.setAccess('denied', message);
          state.setError(message);
          state.setOpSender(null);
          state.setPresenceSender(null);
        },
        onAccessDenied: (message) => {
          const state = useSceneStore.getState();
          state.setAccess('denied', message);
          state.setError(message);
          state.setOpSender(null);
          state.setPresenceSender(null);
        },
        onError: (message) => {
          useSceneStore.getState().setError(message);
        },
      });

      // Once a client exists, local edits are queued in its outbox even while
      // the socket is reconnecting — they are re-sent on the next join.
      useSceneStore.getState().setOpSender((ops, meta) => client?.sendOps(ops, meta));

      unsubscribe = useSceneStore.subscribe((state, previous) => {
        if (state.selection === previous.selection) return;
        // `undefined` keeps the last cursor: changing the selection alone must
        // not teleport this client's pointer back to where it last moved.
        client?.sendPresence(undefined, state.selection);
      });

      client.connect();
    };

    void boot();

    return () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      client?.close();
      client = null;
      const state = useSceneStore.getState();
      state.setOpSender(null);
      state.setPresenceSender(null);
    };
  }, [url, roomId, displayName, invite, explicitName, signedOut]);
}
