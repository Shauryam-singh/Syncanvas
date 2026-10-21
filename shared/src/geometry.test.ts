import { describe, expect, it } from 'vitest';
import {
  getHandlePositions,
  getObjectAABB,
  getObjectCenter,
  hitTest,
  hitTestObject,
  moveObject,
  normalizeAngle,
  resizeObject,
  rotateObject,
  rotatePoint,
  toLocalPoint,
  toWorldPoint,
} from './geometry.js';
import { createSceneObject, type SceneObject } from './object.js';

const rect = (overrides: Partial<SceneObject> = {}): SceneObject =>
  createSceneObject({ id: 'r1', type: 'rect', x: 100, y: 100, w: 200, h: 100, ...overrides });

describe('rotatePoint', () => {
  it('keeps the centre fixed', () => {
    const center = { x: 50, y: 50 };
    const rotated = rotatePoint({ x: 100, y: 50 }, center, 90);
    expect(rotated.x).toBeCloseTo(50);
    expect(rotated.y).toBeCloseTo(100);
  });

  it('is the inverse of itself for 90 degrees', () => {
    const center = { x: 10, y: 20 };
    const point = { x: 37, y: -4 };
    const round = rotatePoint(rotatePoint(point, center, 90), center, -90);
    expect(round.x).toBeCloseTo(point.x);
    expect(round.y).toBeCloseTo(point.y);
  });
});

describe('local / world frames', () => {
  it('maps a local point to world and back', () => {
    const object = rect({ rotation: 30 });
    const local = { x: 20, y: 40 };
    const world = toWorldPoint(object, local);
    const back = toLocalPoint(object, world);
    expect(back.x).toBeCloseTo(local.x);
    expect(back.y).toBeCloseTo(local.y);
  });

  it('rotates the top-left corner around the centre', () => {
    const object = rect({ rotation: 90 });
    const center = getObjectCenter(object);
    const corner = toWorldPoint(object, { x: 0, y: 0 });
    // A 90° rotation maps the top-left corner to the top-right of the box.
    expect(corner.x).toBeCloseTo(center.x + object.h / 2);
    expect(corner.y).toBeCloseTo(center.y - object.w / 2);
  });

  it('computes the axis-aligned bounds of a rotated object', () => {
    const object = rect({ rotation: 90 });
    const aabb = getObjectAABB(object);
    expect(aabb.w).toBeCloseTo(object.h);
    expect(aabb.h).toBeCloseTo(object.w);
    expect(aabb.x).toBeCloseTo(object.x + object.w / 2 - object.h / 2);
  });
});

describe('hit testing', () => {
  it('hits a rectangle inside its bounds', () => {
    const object = rect();
    expect(hitTestObject(object, { x: 150, y: 150 })).toBe(true);
    expect(hitTestObject(object, { x: 90, y: 150 })).toBe(false);
  });

  it('respects rotation', () => {
    const object = rect({ rotation: 45 });
    // Inside the *unrotated* box but outside the rotated shape.
    expect(hitTestObject(object, { x: 250, y: 105 })).toBe(false);
    // The centre is inside.
    expect(hitTestObject(object, getObjectCenter(object))).toBe(true);
    // A corner of the unrotated box is not on the rotated shape either.
    expect(hitTestObject(object, { x: 100, y: 100 })).toBe(false);
  });

  it('hits an ellipse only inside the ellipse', () => {
    const object = createSceneObject({
      id: 'e1',
      type: 'ellipse',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    expect(hitTestObject(object, { x: 50, y: 50 })).toBe(true);
    expect(hitTestObject(object, { x: 5, y: 5 })).toBe(false);
  });

  it('returns the top-most object of a stack', () => {
    const bottom = rect({ id: 'bottom' });
    const top = rect({ id: 'top', x: 150, y: 150 });
    const objects = [bottom, top];
    expect(hitTest(objects, { x: 160, y: 160 })?.id).toBe('top');
    expect(hitTest(objects, { x: 120, y: 120 })?.id).toBe('bottom');
    expect(hitTest(objects, { x: 0, y: 0 })).toBeNull();
  });
});

describe('resize', () => {
  it('drags the south-east corner and pins the north-west corner', () => {
    const object = rect();
    const resized = resizeObject(object, 'se', { x: 300, y: 200 });
    expect(resized.w).toBe(200);
    expect(resized.h).toBe(100);
    expect(resized.x).toBe(100);
    expect(resized.y).toBe(100);
  });

  it('keeps the opposite edge fixed when dragging the east handle', () => {
    const object = rect();
    const resized = resizeObject(object, 'e', { x: 400, y: 0 });
    expect(resized.w).toBe(300);
    expect(resized.x).toBe(100);
    expect(resized.y).toBe(100);
    expect(resized.h).toBe(100);
  });

  it('never shrinks below the minimum size', () => {
    const object = rect();
    const resized = resizeObject(object, 'se', { x: 0, y: 0 }, { minSize: 8 });
    expect(resized.w).toBeGreaterThanOrEqual(8);
    expect(resized.h).toBeGreaterThanOrEqual(8);
  });

  it('keeps the anchor pinned in world space when the object is rotated', () => {
    const object = rect({ rotation: 37 });
    const anchorBefore = toWorldPoint(object, { x: 0, y: 0 });
    const resized = resizeObject(object, 'se', { x: 320, y: 260 });
    const anchorAfter = toWorldPoint(resized, { x: 0, y: 0 });
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6);
    // The rotation is untouched by a resize.
    expect(resized.rotation).toBe(object.rotation);
  });

  it('grows along the local axes of a rotated object', () => {
    const object = rect({ rotation: 90 });
    const handles = getHandlePositions(object);
    // With a 90° rotation the local "east" direction points down in world space.
    const east = handles.e;
    const resized = resizeObject(object, 'e', { x: east.x, y: east.y + 50 });
    expect(resized.w).toBeCloseTo(object.w + 50, 6);
    expect(resized.h).toBeCloseTo(object.h, 6);
  });

  it('preserves the aspect ratio when asked to', () => {
    const object = rect();
    const resized = resizeObject(object, 'se', { x: 400, y: 130 }, { preserveAspectRatio: true });
    expect(resized.w / resized.h).toBeCloseTo(2, 6);
  });

  it('resizes around the centre when asked to', () => {
    const object = rect();
    const center = getObjectCenter(object);
    const resized = resizeObject(
      object,
      'se',
      { x: center.x + 50, y: center.y + 50 },
      {
        fromCenter: true,
      },
    );
    expect(getObjectCenter(resized).x).toBeCloseTo(center.x, 6);
    expect(getObjectCenter(resized).y).toBeCloseTo(center.y, 6);
    expect(resized.w).toBeCloseTo(100, 6);
    expect(resized.h).toBeCloseTo(100, 6);
  });
});

describe('rotate', () => {
  it('turns the object towards the pointer', () => {
    const object = rect();
    const center = getObjectCenter(object);
    const rotated = rotateObject(
      object,
      { x: center.x + 100, y: center.y },
      { x: center.x, y: center.y - 100 },
      0,
    );
    expect(Math.abs(rotated.rotation)).toBeCloseTo(90, 6);
  });

  it('snaps to the requested increment', () => {
    const object = rect();
    const center = getObjectCenter(object);
    const rotated = rotateObject(
      object,
      { x: center.x + 100, y: center.y },
      { x: center.x + 100, y: center.y + 8 },
      0,
      15,
    );
    expect(rotated.rotation).toBeCloseTo(0, 6);
  });

  it('normalises the angle into (-180, 180]', () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(0)).toBe(0);
  });
});

describe('move', () => {
  it('translates the object', () => {
    const moved = moveObject(rect(), 10, -5);
    expect(moved.x).toBe(110);
    expect(moved.y).toBe(95);
  });
});

describe('handles', () => {
  it('places the handles on the rotated corners', () => {
    const object = rect({ rotation: 90 });
    const handles = getHandlePositions(object);
    const center = getObjectCenter(object);
    // With a 90° rotation the local north-west corner is above the centre.
    expect(handles.nw.y).toBeCloseTo(center.y - object.w / 2, 6);
    expect(handles.nw.x).toBeCloseTo(center.x + object.h / 2, 6);
  });
});
