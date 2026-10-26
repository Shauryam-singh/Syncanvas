import { createSceneObject, type SceneObject } from './object.js';

/**
 * The scene a room starts with — a few objects so the canvas is never an
 * empty void on first load.
 *
 * It lives in `shared` because both sides need the same seed: the client
 * renders it while it is offline, and the gateway materialises it when a
 * room is created. Both derive the same starting state, so a client that
 * joins a fresh room sees no change.
 */
export function createInitialScene(): SceneObject[] {
  return [
    createSceneObject({
      id: 'demo-rect',
      type: 'rect',
      x: 80,
      y: 80,
      w: 220,
      h: 140,
      fill: '#6366f1',
    }),
    createSceneObject({
      id: 'demo-ellipse',
      type: 'ellipse',
      x: 260,
      y: 180,
      w: 160,
      h: 160,
      fill: '#22c55e',
    }),
    createSceneObject({
      id: 'demo-line',
      type: 'line',
      x: 120,
      y: 340,
      w: 280,
      h: 20,
      fill: '#f59e0b',
    }),
  ];
}
