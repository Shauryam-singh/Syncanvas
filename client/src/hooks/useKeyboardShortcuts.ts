import { useEffect } from 'react';
import { useSceneStore } from '../store/sceneStore';
import type { Tool } from '../store/sceneStore';

const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: 'select',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  t: 'text',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Global keyboard shortcuts.
 *
 * Every shortcut turns into an operation — the canvas never keeps a second
 * source of truth that the store does not know about.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      const store = useSceneStore.getState();
      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          store.redo();
        } else {
          store.undo();
        }
        return;
      }

      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        store.redo();
        return;
      }

      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        store.setSelection(store.scene.order.slice());
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        store.deleteSelected();
        return;
      }

      if (event.key === 'Escape') {
        if (store.interaction) {
          store.cancelInteraction();
        } else {
          store.clearSelection();
        }
        return;
      }

      const nudge = { x: 0, y: 0 };
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft') nudge.x = -step;
      else if (event.key === 'ArrowRight') nudge.x = step;
      else if (event.key === 'ArrowUp') nudge.y = -step;
      else if (event.key === 'ArrowDown') nudge.y = step;

      if (nudge.x !== 0 || nudge.y !== 0) {
        event.preventDefault();
        const ops = store.selection.flatMap((id) => {
          const object = store.scene.objects.get(id);
          if (!object) return [];
          const result = [];
          if (nudge.x !== 0) {
            result.push({
              kind: 'setProp' as const,
              objectId: id,
              prop: 'x' as const,
              value: object.x + nudge.x,
            });
          }
          if (nudge.y !== 0) {
            result.push({
              kind: 'setProp' as const,
              objectId: id,
              prop: 'y' as const,
              value: object.y + nudge.y,
            });
          }
          return result;
        });
        store.dispatch(ops);
        return;
      }

      if (!modifier) {
        const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
        if (tool) {
          store.setTool(tool);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
