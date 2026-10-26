import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getObjectsInOrder, type Point, type ResizeHandle } from '@syncanvas/shared';
import { useSceneStore } from '../store/sceneStore';
import { ObjectShape } from './ObjectShape';
import { PeerLayer } from './PeerLayer';
import { SelectionOverlay } from './SelectionOverlay';
import { screenToWorld, zoomAtPoint, type ViewTransform } from './viewport';

const INITIAL_TRANSFORM: ViewTransform = { panX: 0, panY: 0, zoom: 1 };

/**
 * The editing surface.
 *
 * The canvas never mutates the scene directly: every gesture is turned into
 * operations by the store, and the store is the only thing that writes to the
 * scene state. The canvas only produces *points*.
 */
export function SceneCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState<ViewTransform>(INITIAL_TRANSFORM);
  const [size, setSize] = useState({ width: 960, height: 640 });
  const panRef = useRef<{ client: Point; pan: Point } | null>(null);
  const spaceRef = useRef(false);

  const scene = useSceneStore((state) => state.scene);
  const draft = useSceneStore((state) => state.draft);
  const selection = useSceneStore((state) => state.selection);
  const tool = useSceneStore((state) => state.tool);

  const objects = useMemo(() => {
    const ordered = getObjectsInOrder(scene);
    if (draft.length === 0) return ordered;
    const draftById = new Map(draft.map((object) => [object.id, object]));
    return ordered.map((object) => draftById.get(object.id) ?? object);
  }, [scene, draft]);

  const selectedObjects = useMemo(
    () => objects.filter((object) => selection.includes(object.id)),
    [objects, selection],
  );

  // Keep the viewBox in sync with the element size so that screen pixels and
  // world units map onto each other without letterboxing.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom has to be a native listener: React attaches `wheel` passively
  // on the root, which would make `preventDefault` a no-op.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setTransform((current) =>
        zoomAtPoint(current, { x: event.clientX, y: event.clientY }, rect, factor),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const toWorld = useCallback(
    (event: { clientX: number; clientY: number }): Point | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return screenToWorld({ x: event.clientX, y: event.clientY }, rect, transform);
    },
    [transform],
  );

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;

    // Panning: middle mouse button, or space + drag.
    if (event.button === 1 || spaceRef.current) {
      panRef.current = {
        client: { x: event.clientX, y: event.clientY },
        pan: { x: transform.panX, y: transform.panY },
      };
      svg.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    const target = event.target as SVGElement;
    // The pointer lands on the shape itself, so the owning group has to be
    // looked up through the DOM tree.
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') ?? null;
    const objectId = target.closest('[data-object-id]')?.getAttribute('data-object-id') ?? null;
    const world = toWorld(event);
    if (!world) return;

    const store = useSceneStore.getState();

    if (handle && selectedObjects.length === 1) {
      const active = selectedObjects[0];
      if (!active) return;
      if (handle === 'rotate') {
        store.beginRotate(active.id, world);
      } else {
        store.beginResize(active.id, handle as ResizeHandle, world, {
          shift: event.shiftKey,
          alt: event.altKey,
        });
      }
      svg.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    if (objectId) {
      const alreadySelected = store.selection.includes(objectId);
      if (event.shiftKey) {
        store.toggleSelection(objectId);
        if (alreadySelected) return;
        store.beginMove(useSceneStore.getState().selection, world);
      } else {
        if (!alreadySelected) store.setSelection([objectId]);
        store.beginMove([objectId], world);
      }
      svg.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }

    // Empty canvas.
    if (tool !== 'select') {
      store.createObject(tool, world);
      return;
    }
    store.clearSelection();
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (pan) {
      const dx = (event.clientX - pan.client.x) / transform.zoom;
      const dy = (event.clientY - pan.client.y) / transform.zoom;
      setTransform((current) => ({ ...current, panX: pan.pan.x - dx, panY: pan.pan.y - dy }));
      return;
    }

    const store = useSceneStore.getState();
    const world = toWorld(event);
    // Cursor presence is independent of gestures: pointing at the canvas is
    // enough. The sync client throttles it; local mode ignores it.
    if (world) store.reportCursor(world);
    if (!store.interaction || !world) return;
    store.updateInteraction(world, { shift: event.shiftKey, alt: event.altKey });
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    panRef.current = null;
    useSceneStore.getState().endInteraction();
    if (svgRef.current?.hasPointerCapture?.(event.pointerId)) {
      svgRef.current.releasePointerCapture?.(event.pointerId);
    }
  };

  const gridSize = 24 / transform.zoom;
  const visibleWidth = size.width / transform.zoom;
  const visibleHeight = size.height / transform.zoom;
  // The SVG has no viewBox: one user unit is one CSS pixel and the world is
  // mapped onto the canvas by a single transform, which keeps the pointer
  // maths exact at any zoom level.
  const worldTransform = `translate(${-transform.panX * transform.zoom} ${
    -transform.panY * transform.zoom
  }) scale(${transform.zoom})`;

  return (
    <svg
      ref={svgRef}
      className="scene-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={() => useSceneStore.getState().reportCursor(null)}
    >
      <defs>
        <pattern
          id="canvas-grid"
          width={gridSize}
          height={gridSize}
          patternUnits="userSpaceOnUse"
          x={transform.panX % gridSize}
          y={transform.panY % gridSize}
        >
          <circle cx={1} cy={1} r={1 / transform.zoom} fill="#cbd5e1" />
        </pattern>
      </defs>

      <rect x={0} y={0} width="100%" height="100%" fill="#f8fafc" />

      <g transform={worldTransform}>
        <rect
          x={transform.panX - 100}
          y={transform.panY - 100}
          width={visibleWidth + 200}
          height={visibleHeight + 200}
          fill="url(#canvas-grid)"
        />

        <g className="scene-objects">
          {objects.map((object) => (
            <g key={object.id} data-object-id={object.id}>
              <ObjectShape object={object} />
            </g>
          ))}
        </g>

        <SelectionOverlay objects={selectedObjects} zoom={transform.zoom} />
        <PeerLayer zoom={transform.zoom} />
      </g>
    </svg>
  );
}
