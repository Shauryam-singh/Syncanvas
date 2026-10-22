import { useEffect, useMemo } from 'react';
import { useSceneStore } from '../store/sceneStore';
import { SyncClient } from './syncClient';

/** Where the gateway lives. Overridable for deployments behind a proxy. */
const DEFAULT_WS_URL = 'ws://localhost:8080/ws';

export interface SyncConfig {
  url: string;
  roomId: string;
  displayName: string;
}

/**
 * Reads the sync configuration from the URL.
 *
 * `?room=design-review` picks the room, `?ws=wss://…` points at another
 * gateway, `?name=Ada` sets the display name.
 */
export function readSyncConfig(search: string = window.location.search): SyncConfig {
  const params = new URLSearchParams(search);
  return {
    url: params.get('ws') ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL,
    roomId: params.get('room') ?? 'demo',
    displayName: params.get('name') ?? `Guest ${Math.random().toString(36).slice(2, 6)}`,
  };
}

/**
 * Connects the editor to the gateway.
 *
 * The hook owns the whole conversation: it hands local operations to the
 * sync client, feeds confirmed operations back into the store, and keeps
 * the connection state and the peer list up to date.
 */
export function useSync(config?: SyncConfig): void {
  // The configuration is read once per mount. It has to be: the display name
  // is generated randomly, so reading it on every render would reconnect the
  // client on every render.
  const fallback = useMemo(() => readSyncConfig(), []);
  const url = config?.url ?? fallback.url;
  const roomId = config?.roomId ?? fallback.roomId;
  const displayName = config?.displayName ?? fallback.displayName;

  useEffect(() => {
    const store = useSceneStore.getState();

    const client = new SyncClient({
      url,
      roomId,
      displayName,
      onConnection: (connection) => {
        useSceneStore.getState().setConnection(connection);
        // The store only sends operations to the gateway once it is live;
        // until then it behaves like the single-user editor of stage 1.
        useSceneStore
          .getState()
          .setOpSender(connection === 'live' ? (ops, meta) => client.sendOps(ops, meta) : null);
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
    });

    store.setOpSender(null);
    client.connect();

    // The selection is ephemeral presence data: the gateway gossips it to
    // the room, it is never persisted.
    const unsubscribe = useSceneStore.subscribe((state, previous) => {
      if (state.selection === previous.selection) return;
      client.sendPresence(null, state.selection);
    });

    return () => {
      unsubscribe();
      client.close();
      useSceneStore.getState().setOpSender(null);
    };
  }, [url, roomId, displayName]);
}
