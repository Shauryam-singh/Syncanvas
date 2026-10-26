import type { ReactNode } from 'react';
import { clearSession } from '../net/session';
import { useSceneStore } from '../store/sceneStore';

/**
 * The access gate.
 *
 * A denied join is terminal for this page load: retrying the same token (or
 * the same missing membership) would just fail again. The gate explains why
 * and offers the two useful exits — sign in as a fresh guest, or open the
 * public demo room.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const access = useSceneStore((state) => state.access);
  const message = useSceneStore((state) => state.accessMessage);
  const roomId = useSceneStore((state) => state.roomId);
  const roomName = useSceneStore((state) => state.roomName);

  if (access !== 'denied') return <>{children}</>;

  const demo = new URL(window.location.href);
  demo.hash = '';
  demo.search = '';
  demo.searchParams.set('room', 'demo');

  return (
    <main className="gate">
      <div className="gate__card">
        <span className="badge">Access denied</span>
        <h1>This room is not open to you</h1>
        <p>{message ?? 'You need a share link from somebody in the room.'}</p>
        <p className="muted">
          Room <strong>{roomName || roomId}</strong>
        </p>
        <div className="gate__actions">
          <button
            type="button"
            className="tool-button"
            onClick={() => {
              clearSession();
              window.location.reload();
            }}
          >
            Sign in again
          </button>
          <a className="gate__link" href={demo.toString()}>
            Open the demo room
          </a>
        </div>
        <p className="gate__hint muted">
          Share links are signed and expire. Ask an editor for a fresh one if yours no longer works.
        </p>
      </div>
    </main>
  );
}
