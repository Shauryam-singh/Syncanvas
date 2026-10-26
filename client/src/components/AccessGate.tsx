import { useState, type ReactNode } from 'react';
import { clearSession } from '../net/session';
import { demoRoomUrl } from '../net/urls';
import { useSceneStore } from '../store/sceneStore';

/**
 * The access gate.
 *
 * A denied join is terminal for this page load: retrying the same token (or
 * the same missing membership) would just fail again. The gate explains why
 * and offers the two useful exits — sign in as a fresh guest, or open the
 * public demo room.
 *
 * Signing out is not a denial: it deliberately parks here so a guest can pick
 * a display name before entering the public demo room. Without this stop the
 * app would immediately mint another guest and silently rejoin the old room.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const access = useSceneStore((state) => state.access);
  const message = useSceneStore((state) => state.accessMessage);
  const roomId = useSceneStore((state) => state.roomId);
  const roomName = useSceneStore((state) => state.roomName);
  const [displayName, setDisplayName] = useState('');

  if (access === 'signedout') {
    return (
      <main className="gate">
        <div className="gate__card">
          <span className="badge">Signed out</span>
          <h1>You have left the room</h1>
          <p>Choose the name other people will see. No account or password is needed.</p>
          <form
            className="gate__form"
            onSubmit={(event) => {
              event.preventDefault();
              window.location.assign(demoRoomUrl(window.location.href, displayName));
            }}
          >
            <label className="gate__field">
              <span>Display name</span>
              <input
                autoFocus
                value={displayName}
                maxLength={40}
                placeholder="Leave blank for a random guest name"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <div className="gate__actions">
              <button type="submit" className="tool-button">
                Enter the demo room
              </button>
            </div>
          </form>
          <p className="gate__hint muted">
            You can change your name later from the room header while you are a guest.
          </p>
        </div>
      </main>
    );
  }

  if (access !== 'denied') return <>{children}</>;

  const demo = demoRoomUrl(window.location.href);

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
