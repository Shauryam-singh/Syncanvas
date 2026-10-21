import { useEffect, useState } from 'react';
import { useSceneStore } from '../store/sceneStore';

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
      <span className="status-bar__spacer" />
      <span className="muted">
        {activity} · scroll to zoom · space-drag to pan · shift-click to multi-select
      </span>
    </footer>
  );
}
