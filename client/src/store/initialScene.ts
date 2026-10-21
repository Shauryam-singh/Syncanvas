import { createSceneObject, type SceneObject } from '@syncanvas/shared';

/**
 * The scene the editor starts with — a few objects so the canvas is never
 * an empty void on first load.
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
      id: 'demo-text',
      type: 'text',
      x: 100,
      y: 260,
      w: 320,
      h: 44,
      fill: '#0f172a',
      text: 'Drag, resize, rotate — every edit is an operation',
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
