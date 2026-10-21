import type { SceneObject } from './object.js';

/** A point in scene coordinates (or in a local object frame, see `toLocalPoint`). */
export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned rectangle. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The eight resize handles of a bounding box. */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
] as const;

export const MIN_OBJECT_SIZE = 2;

const DEG_TO_RAD = Math.PI / 180;

/** Rotates `point` around `center` by `degrees` (counter-clockwise). */
export function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const rad = degrees * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/** Rotates a free vector (no pivot) by `degrees`. */
export function rotateVector(vector: Point, degrees: number): Point {
  const rad = degrees * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

/** The rotation pivot of an object: the centre of its unrotated box. */
export function getObjectCenter(object: SceneObject): Point {
  return { x: object.x + object.w / 2, y: object.y + object.h / 2 };
}

/**
 * Maps a world point into the object's *local* frame: the unrotated box whose
 * top-left corner sits at (0, 0) and which spans `w` × `h`.
 */
export function toLocalPoint(object: SceneObject, point: Point): Point {
  const center = getObjectCenter(object);
  const unrotated = rotatePoint(point, center, -object.rotation);
  return { x: unrotated.x - object.x, y: unrotated.y - object.y };
}

/** Maps a local-frame point (0-based, relative to the box) back to world space. */
export function toWorldPoint(object: SceneObject, local: Point): Point {
  const center = getObjectCenter(object);
  return rotatePoint({ x: object.x + local.x, y: object.y + local.y }, center, object.rotation);
}

/** The four corners of the object in world space, clockwise from top-left. */
export function getObjectCorners(object: SceneObject): Point[] {
  return [
    toWorldPoint(object, { x: 0, y: 0 }),
    toWorldPoint(object, { x: object.w, y: 0 }),
    toWorldPoint(object, { x: object.w, y: object.h }),
    toWorldPoint(object, { x: 0, y: object.h }),
  ];
}

/** The axis-aligned bounding box that contains the (possibly rotated) object. */
export function getObjectAABB(object: SceneObject): Rect {
  const corners = getObjectCorners(object);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    w: Math.max(...xs) - minX,
    h: Math.max(...ys) - minY,
  };
}

/** Distance from `point` to the segment `a`–`b`. */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Hit-tests a single object.
 *
 * `tolerance` is expressed in scene units and only matters for thin shapes
 * (lines) and for grabbing the very edge of a filled shape.
 */
export function hitTestObject(object: SceneObject, point: Point, tolerance = 0): boolean {
  const local = toLocalPoint(object, point);

  switch (object.type) {
    case 'ellipse': {
      const rx = object.w / 2;
      const ry = object.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const nx = (local.x - rx) / rx;
      const ny = (local.y - ry) / ry;
      return nx * nx + ny * ny <= 1;
    }
    case 'line': {
      const a = { x: 0, y: object.h / 2 };
      const b = { x: object.w, y: object.h / 2 };
      return distanceToSegment(local, a, b) <= Math.max(tolerance, 4);
    }
    case 'rect':
    case 'text':
    default:
      return (
        local.x >= -tolerance &&
        local.y >= -tolerance &&
        local.x <= object.w + tolerance &&
        local.y <= object.h + tolerance
      );
  }
}

/**
 * Returns the top-most object under `point`, or `null`.
 *
 * `objects` must be ordered back-to-front (see `getObjectsInOrder`).
 */
export function hitTest(
  objects: readonly SceneObject[],
  point: Point,
  tolerance = 0,
): SceneObject | null {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i];
    if (object && hitTestObject(object, point, tolerance)) {
      return object;
    }
  }
  return null;
}

/** Local-frame position of each resize handle. */
export function getHandleLocalPositions(object: SceneObject): Record<ResizeHandle, Point> {
  const { w, h } = object;
  return {
    nw: { x: 0, y: 0 },
    n: { x: w / 2, y: 0 },
    ne: { x: w, y: 0 },
    e: { x: w, y: h / 2 },
    se: { x: w, y: h },
    s: { x: w / 2, y: h },
    sw: { x: 0, y: h },
    w: { x: 0, y: h / 2 },
  };
}

/** World-space position of each resize handle. */
export function getHandlePositions(object: SceneObject): Record<ResizeHandle, Point> {
  const locals = getHandleLocalPositions(object);
  const result = {} as Record<ResizeHandle, Point>;
  for (const handle of RESIZE_HANDLES) {
    result[handle] = toWorldPoint(object, locals[handle]);
  }
  return result;
}

/**
 * The point that stays fixed while a handle is dragged: the opposite handle.
 * Expressed in the object's local frame.
 */
export function getResizeAnchor(object: SceneObject, handle: ResizeHandle): Point {
  const { w, h } = object;
  switch (handle) {
    case 'nw':
      return { x: w, y: h };
    case 'n':
      return { x: w / 2, y: h };
    case 'ne':
      return { x: 0, y: h };
    case 'e':
      return { x: 0, y: h / 2 };
    case 'se':
      return { x: 0, y: 0 };
    case 's':
      return { x: w / 2, y: 0 };
    case 'sw':
      return { x: w, y: 0 };
    case 'w':
      return { x: w, y: h / 2 };
  }
}

/** Handles that move two edges at once (corners) versus a single edge. */
const CORNER_HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];

export interface ResizeOptions {
  /** Keep the original aspect ratio (shift). */
  preserveAspectRatio?: boolean;
  /** Resize symmetrically around the centre (alt). */
  fromCenter?: boolean;
  /** Smallest allowed width/height. */
  minSize?: number;
}

/** An axis-aligned rect expressed with its four edges, in the local frame. */
interface LocalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Resizes `object` by dragging `handle` to `pointer` (world coordinates).
 *
 * The object keeps its rotation and the anchor (the opposite handle) stays
 * pinned in world space — resizing a rotated object therefore grows it along
 * its own local axes, exactly like a design tool.
 */
export function resizeObject(
  object: SceneObject,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions = {},
): SceneObject {
  const { preserveAspectRatio = false, fromCenter = false, minSize = MIN_OBJECT_SIZE } = options;

  const center = getObjectCenter(object);
  const localCenter = { x: object.w / 2, y: object.h / 2 };
  const pointerLocal = toLocalPoint(object, pointer);

  let rect = computeLocalRect(object, handle, pointerLocal, fromCenter, minSize);
  if (preserveAspectRatio) {
    rect = applyAspectRatio(object, handle, rect, localCenter, fromCenter);
  }

  const width = Math.max(rect.right - rect.left, minSize);
  const height = Math.max(rect.bottom - rect.top, minSize);

  // Re-derive the world centre so the anchor stays pinned after the rotation.
  const anchor = fromCenter ? localCenter : getResizeAnchor(object, handle);
  const anchorOffset = rotateVector(
    { x: anchor.x - localCenter.x, y: anchor.y - localCenter.y },
    object.rotation,
  );
  const anchorWorld = { x: center.x + anchorOffset.x, y: center.y + anchorOffset.y };

  const newLocalCenter = {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  };
  const centerOffset = rotateVector(
    { x: newLocalCenter.x - anchor.x, y: newLocalCenter.y - anchor.y },
    object.rotation,
  );
  const newCenter = {
    x: anchorWorld.x + centerOffset.x,
    y: anchorWorld.y + centerOffset.y,
  };

  return {
    ...object,
    x: newCenter.x - width / 2,
    y: newCenter.y - height / 2,
    w: width,
    h: height,
  };
}

/** Derives the new local rect (in the object's old local frame) from a drag. */
function computeLocalRect(
  object: SceneObject,
  handle: ResizeHandle,
  pointerLocal: Point,
  fromCenter: boolean,
  minSize: number,
): LocalRect {
  const localCenter = { x: object.w / 2, y: object.h / 2 };

  if (fromCenter) {
    const dx = Math.max(horizontalDelta(handle, pointerLocal.x - localCenter.x), minSize / 2);
    const dy = Math.max(verticalDelta(handle, pointerLocal.y - localCenter.y), minSize / 2);
    return {
      left: localCenter.x - dx,
      right: localCenter.x + dx,
      top: localCenter.y - dy,
      bottom: localCenter.y + dy,
    };
  }

  let left = 0;
  let top = 0;
  let right = object.w;
  let bottom = object.h;

  switch (handle) {
    case 'nw':
      left = Math.min(pointerLocal.x, right - minSize);
      top = Math.min(pointerLocal.y, bottom - minSize);
      break;
    case 'n':
      top = Math.min(pointerLocal.y, bottom - minSize);
      break;
    case 'ne':
      right = Math.max(pointerLocal.x, left + minSize);
      top = Math.min(pointerLocal.y, bottom - minSize);
      break;
    case 'e':
      right = Math.max(pointerLocal.x, left + minSize);
      break;
    case 'se':
      right = Math.max(pointerLocal.x, left + minSize);
      bottom = Math.max(pointerLocal.y, top + minSize);
      break;
    case 's':
      bottom = Math.max(pointerLocal.y, top + minSize);
      break;
    case 'sw':
      left = Math.min(pointerLocal.x, right - minSize);
      bottom = Math.max(pointerLocal.y, top + minSize);
      break;
    case 'w':
      left = Math.min(pointerLocal.x, right - minSize);
      break;
  }

  return { left, top, right, bottom };
}

/**
 * Adjusts a computed rect so it keeps the object's original aspect ratio.
 *
 * Corner handles keep the edge that moved furthest from the pointer; edge
 * handles drive the perpendicular dimension from the dragged one.
 */
function applyAspectRatio(
  object: SceneObject,
  handle: ResizeHandle,
  rect: LocalRect,
  localCenter: Point,
  fromCenter: boolean,
): LocalRect {
  if (object.w <= 0 || object.h <= 0) return rect;
  const aspect = object.w / object.h;

  let width = rect.right - rect.left;
  let height = rect.bottom - rect.top;

  if (CORNER_HANDLES.includes(handle)) {
    const widthRatio = width / object.w;
    const heightRatio = height / object.h;
    if (widthRatio >= heightRatio) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
  } else if (handle === 'e' || handle === 'w') {
    height = width / aspect;
  } else {
    width = height * aspect;
  }

  if (fromCenter) {
    return {
      left: localCenter.x - width / 2,
      right: localCenter.x + width / 2,
      top: localCenter.y - height / 2,
      bottom: localCenter.y + height / 2,
    };
  }

  const anchor = getResizeAnchor(object, handle);
  const anchorOnLeft = anchor.x <= object.w / 2;
  const anchorOnTop = anchor.y <= object.h / 2;

  if (handle === 'e' || handle === 'w') {
    // The vertical extent grows around the centre of the opposite edge.
    return {
      ...rect,
      top: localCenter.y - height / 2,
      bottom: localCenter.y + height / 2,
    };
  }

  if (handle === 'n' || handle === 's') {
    return {
      ...rect,
      left: localCenter.x - width / 2,
      right: localCenter.x + width / 2,
    };
  }

  return {
    left: anchorOnLeft ? anchor.x : anchor.x - width,
    right: anchorOnLeft ? anchor.x + width : anchor.x,
    top: anchorOnTop ? anchor.y : anchor.y - height,
    bottom: anchorOnTop ? anchor.y + height : anchor.y,
  };
}

/** Signed horizontal drag distance contributed by a handle. */
function horizontalDelta(handle: ResizeHandle, delta: number): number {
  switch (handle) {
    case 'w':
    case 'nw':
    case 'sw':
      return -delta;
    case 'e':
    case 'ne':
    case 'se':
      return delta;
    default:
      return 0;
  }
}

/** Signed vertical drag distance contributed by a handle. */
function verticalDelta(handle: ResizeHandle, delta: number): number {
  switch (handle) {
    case 'n':
    case 'nw':
    case 'ne':
      return -delta;
    case 's':
    case 'sw':
    case 'se':
      return delta;
    default:
      return 0;
  }
}

/** The angle (in degrees) of the vector from `center` to `point`. */
export function angleTo(point: Point, center: Point): number {
  return Math.atan2(point.y - center.y, point.x - center.x) / DEG_TO_RAD;
}

/** Normalises an angle into the (-180, 180] range. */
export function normalizeAngle(degrees: number): number {
  // The +540 offset keeps the modulo positive for negative inputs.
  const wrapped = ((degrees + 540) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Rotates `object` so that the vector `center → pointer` keeps the same
 * angular offset it had at `startPointer` (relative to `startRotation`).
 */
export function rotateObject(
  object: SceneObject,
  startPointer: Point,
  pointer: Point,
  startRotation: number,
  snapDegrees = 0,
): SceneObject {
  const center = getObjectCenter(object);
  const startAngle = angleTo(startPointer, center);
  const currentAngle = angleTo(pointer, center);
  let rotation = startRotation + (currentAngle - startAngle);
  if (snapDegrees > 0) {
    rotation = Math.round(rotation / snapDegrees) * snapDegrees;
  }
  return { ...object, rotation: normalizeAngle(rotation) };
}

/** Moves an object by a world-space delta. */
export function moveObject(object: SceneObject, dx: number, dy: number): SceneObject {
  return { ...object, x: object.x + dx, y: object.y + dy };
}
