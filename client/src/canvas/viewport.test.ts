import { describe, expect, it } from 'vitest';
import { clampZoom, screenToWorld, worldToScreen, zoomAtPoint } from './viewport';

const rect = { left: 100, top: 50, width: 800, height: 400 };

describe('viewport', () => {
  it('maps the canvas origin to the pan position', () => {
    const world = screenToWorld({ x: 100, y: 50 }, rect, { panX: 20, panY: -5, zoom: 1 });
    expect(world).toEqual({ x: 20, y: -5 });
  });

  it('maps screen pixels through the zoom factor', () => {
    const world = screenToWorld({ x: 300, y: 250 }, rect, { panX: 0, panY: 0, zoom: 2 });
    expect(world).toEqual({ x: 100, y: 100 });
  });

  it('round-trips world → screen → world', () => {
    const transform = { panX: 13, panY: -4, zoom: 1.75 };
    const screen = worldToScreen({ x: 320, y: 210 }, rect, transform);
    const world = screenToWorld(screen, rect, transform);
    expect(world.x).toBeCloseTo(320, 6);
    expect(world.y).toBeCloseTo(210, 6);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const transform = { panX: 0, panY: 0, zoom: 1 };
    const cursor = { x: 400, y: 200 };
    const before = screenToWorld(cursor, rect, transform);
    const zoomed = zoomAtPoint(transform, cursor, rect, 2);
    const after = screenToWorld(cursor, rect, zoomed);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.zoom).toBe(2);
  });

  it('clamps the zoom level', () => {
    expect(clampZoom(0.001)).toBe(0.1);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(2)).toBe(2);
  });
});
