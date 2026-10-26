import { useState } from 'react';
import { createInvite, createRoom, updateDisplayName } from '../net/api';
import { clearSession, getActiveSession, saveSession, setActiveSession } from '../net/session';
import { useSceneStore } from '../store/sceneStore';

function shareUrl(roomId: string, invite?: string): string {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  const ws = new URLSearchParams(window.location.search).get('ws');
  if (ws) url.searchParams.set('ws', ws);
  url.searchParams.set('room', roomId);
  if (invite) url.searchParams.set('invite', invite);
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * Room identity, access and share links.
 *
 * The header is deliberately small: the room name and your role, a link
 * copier for editors/viewers, and the two room-level actions (create, leave).
 * The actual access decision is made by the server; this panel only exposes
 * the operations the current role may perform.
 */
export function RoomPanel() {
  const role = useSceneStore((state) => state.role);
  const roomId = useSceneStore((state) => state.roomId);
  const roomName = useSceneStore((state) => state.roomName);
  const access = useSceneStore((state) => state.access);
  const session = useSceneStore((state) => state.session);
  const lastError = useSceneStore((state) => state.lastError);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const canInvite = access === 'granted' && (role === 'owner' || role === 'editor');
  const active = getActiveSession();

  const copyInvite = async (target: 'editor' | 'viewer') => {
    const current = getActiveSession();
    if (!current) return;
    setBusy(true);
    setNotice(null);
    try {
      const invite = await createInvite(current.server, current.token, roomId, target);
      const link = shareUrl(roomId, invite.token);
      try {
        await navigator.clipboard.writeText(link);
        setNotice(`${target === 'editor' ? 'Editor' : 'Viewer'} link copied to the clipboard.`);
      } catch {
        // Clipboard permission is not a reason to hide the link.
        window.prompt('Copy this share link', link);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const createNewRoom = async () => {
    const current = getActiveSession();
    if (!current) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await createRoom(current.server, current.token, newName.trim() || undefined);
      const url = new URL(window.location.href);
      url.searchParams.set('room', created.room.id);
      url.searchParams.delete('invite');
      window.location.assign(url.toString());
    } catch (error) {
      setNotice(errorMessage(error));
      setBusy(false);
    }
  };

  const startRename = () => {
    setNameDraft(session?.displayName ?? '');
    setEditingName(true);
    setNotice(null);
  };

  const saveName = async () => {
    const current = getActiveSession();
    if (!current) return;
    const name = nameDraft.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) {
      setNotice('Enter a display name.');
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const updated = await updateDisplayName(current.server, current.token, name);
      const next = { ...updated, server: current.server };
      setActiveSession(next);
      saveSession(next);
      // A reload reconnects the socket so peers see the new name. Keep an
      // explicit `?name=` in sync so the cached session is still reused.
      const url = new URL(window.location.href);
      if (url.searchParams.has('name')) {
        url.searchParams.set('name', name);
        window.history.replaceState(null, '', url.toString());
      }
      window.location.reload();
    } catch (error) {
      setNotice(errorMessage(error));
      setBusy(false);
    }
  };

  const signOut = () => {
    clearSession();
    const url = new URL(window.location.href);
    const ws = url.searchParams.get('ws');
    url.hash = '';
    url.search = '';
    if (ws) url.searchParams.set('ws', ws);
    url.searchParams.set('signedout', '1');
    window.location.assign(url.toString());
  };

  return (
    <div className="room-panel">
      <div className="room-panel__identity">
        <span className="room-panel__room" title={`Room id: ${roomId}`}>
          {roomName}
        </span>
        {role ? <span className={`role-badge role-badge--${role}`}>{role}</span> : null}
        {session ? (
          editingName ? (
            <form
              className="room-panel__name"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <input
                autoFocus
                value={nameDraft}
                maxLength={40}
                onChange={(event) => setNameDraft(event.target.value)}
                aria-label="Display name"
              />
              <button type="submit" className="tool-button tool-button--small" disabled={busy}>
                Save
              </button>
              <button
                type="button"
                className="tool-button tool-button--small"
                onClick={() => setEditingName(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="room-panel__user room-panel__user--button"
              title={`Signed in as ${session.userId} — click to change your display name`}
              onClick={startRename}
              disabled={busy}
            >
              {session.displayName}
            </button>
          )
        ) : null}
        {access === 'checking' ? <span className="muted">joining…</span> : null}
      </div>

      <div className="room-panel__actions">
        {canInvite ? (
          <>
            <button
              type="button"
              className="tool-button tool-button--small"
              onClick={() => void copyInvite('editor')}
              disabled={busy}
              title="Copy a link that lets someone edit this room"
            >
              Editor link
            </button>
            <button
              type="button"
              className="tool-button tool-button--small"
              onClick={() => void copyInvite('viewer')}
              disabled={busy}
              title="Copy a link that lets someone watch this room"
            >
              Viewer link
            </button>
          </>
        ) : access === 'granted' ? (
          <span className="room-panel__readonly">Read-only</span>
        ) : null}

        <button
          type="button"
          className="tool-button tool-button--small"
          onClick={() => setCreating((value) => !value)}
          disabled={busy || access === 'local'}
          title={access === 'local' ? 'Start the gateway to create rooms' : 'Create a new room'}
        >
          New room
        </button>
        {access === 'local' ? (
          <span
            className="room-panel__readonly"
            title="The HTTP API and WebSocket gateway are not running"
          >
            Local only
          </span>
        ) : null}
        {access !== 'local' && active ? (
          <button type="button" className="tool-button tool-button--small" onClick={signOut}>
            Sign out
          </button>
        ) : (
          <a className="room-panel__link" href={shareUrl('demo')}>
            Demo room
          </a>
        )}
      </div>

      {creating ? (
        <form
          className="room-panel__create"
          onSubmit={(event) => {
            event.preventDefault();
            void createNewRoom();
          }}
        >
          <input
            autoFocus
            value={newName}
            maxLength={80}
            placeholder="Room name"
            onChange={(event) => setNewName(event.target.value)}
            aria-label="New room name"
          />
          <button type="submit" className="tool-button tool-button--small" disabled={busy}>
            Create
          </button>
        </form>
      ) : null}

      {notice ? <span className="room-panel__notice">{notice}</span> : null}
      {lastError ? (
        <span className="room-panel__error" title={lastError}>
          {lastError}
        </span>
      ) : null}
    </div>
  );
}
