import type { Point } from '@syncanvas/shared';

/** Pan/zoom state of the canvas viewport. */
export interface ViewTransform {
  /** World coordinate shown at the top-left corner of the canvas. */
  panX: number;
  panY: number;
  /** Screen pixels per world unit. */
  zoom: number;
}

/** The bounding rectangle of the canvas element, in screen pixels. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** Converts a screen (client) coordinate into world coordinates. */
export function screenToWorld(screen: Point, rect: ScreenRect, transform: ViewTransform): Point {
  return {
    x: transform.panX + (screen.x - rect.left) / transform.zoom,
    y: transform.panY + (screen.y - rect.top) / transform.zoom,
  };
}

/** Converts a world coordinate into screen (client) coordinates. */
export function worldToScreen(world: Point, rect: ScreenRect, transform: ViewTransform): Point {
  return {
    x: rect.left + (world.x - transform.panX) * transform.zoom,
    y: rect.top + (world.y - transform.panY) * transform.zoom,
  };
}

/** Clamps the zoom level to the supported range. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Zooms by `factor` while keeping the world point under `screen` anchored in
 * place — the behaviour users expect from a design tool.
 */
export function zoomAtPoint(
  transform: ViewTransform,
  screen: Point,
  rect: ScreenRect,
  factor: number,
): ViewTransform {
  const zoom = clampZoom(transform.zoom * factor);
  if (zoom === transform.zoom) return transform;

  const before = screenToWorld(screen, rect, transform);
  const after = screenToWorld(screen, rect, { ...transform, zoom });
  return {
    zoom,
    panX: transform.panX + (before.x - after.x),
    panY: transform.panY + (before.y - after.y),
  };
}
