import { useEffect, useState } from 'react';
import { useSceneStore } from '../store/sceneStore';
import type { ConnectionState } from '../net/syncClient';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  local: 'Local only',
  connecting: 'Connecting',
  live: 'Live',
  offline: 'Offline',
};

/** Measures the current frame rate over one-second windows. */
function useFps(): number {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let frame = 0;

    const loop = (now: number) => {
      frames += 1;
      const elapsed = now - last;
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        last = now;
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  return fps;
}

export function StatusBar() {
  const objectCount = useSceneStore((state) => state.scene.objects.size);
  const selectionCount = useSceneStore((state) => state.selection.length);
  const undoDepth = useSceneStore((state) => state.undoStack.length);
  const interaction = useSceneStore((state) => state.interaction);
  const connection = useSceneStore((state) => state.connection);
  const peers = useSceneStore((state) => state.peers);
  const fps = useFps();

  const activity =
    interaction?.kind === 'move'
      ? 'Moving'
      : interaction?.kind === 'resize'
        ? 'Resizing'
        : interaction?.kind === 'rotate'
          ? 'Rotating'
          : 'Idle';

  return (
    <footer className="status-bar">
      <span
        className={`status-bar__connection status-bar__connection--${connection}`}
        title={
          connection === 'live'
            ? 'Connected to the gateway — operations are ordered by the server'
            : connection === 'local'
              ? 'No gateway — editing locally, changes are not shared'
              : connection
        }
      >
        <span className="status-bar__dot" />
        {CONNECTION_LABEL[connection]}
      </span>
      <span>
        <strong>{objectCount}</strong> objects
      </span>
      <span>
        <strong>{selectionCount}</strong> selected
      </span>
      <span>
        <strong>{undoDepth}</strong> undo steps
      </span>
      <span>
        <strong>{fps}</strong> fps
      </span>
      {peers.length > 0 ? (
        <span className="status-bar__peers" title={peers.map((p) => p.displayName).join(', ')}>
          {peers.map((peer) => (
            <span
              key={peer.userId}
              className="status-bar__peer"
              style={{ background: peer.color }}
              aria-label={peer.displayName}
            />
          ))}
          <strong>{peers.length}</strong> in room
        </span>
      ) : null}
      <span className="status-bar__spacer" />
      <span className="muted">
        {activity} · scroll to zoom · space-drag to pan · shift-click to multi-select
      </span>
    </footer>
  );
}
