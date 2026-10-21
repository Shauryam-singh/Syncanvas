import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSceneState, type SceneObject } from '@syncanvas/shared';
import { SceneCanvas } from './SceneCanvas';
import { useSceneStore } from '../store/sceneStore';

const store = () => useSceneStore.getState();

const rect: SceneObject = {
  id: 'rect-1',
  type: 'rect',
  x: 80,
  y: 80,
  w: 200,
  h: 100,
  rotation: 0,
  fill: '#6366f1',
  zIndex: 0,
};

function pointer(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
}

beforeEach(() => {
  useSceneStore.setState({
    scene: createSceneState([rect]),
    selection: [],
    tool: 'select',
    interaction: null,
    draft: [],
    undoStack: [],
    redoStack: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('SceneCanvas', () => {
  it('renders every object of the scene', () => {
    const { container } = render(<SceneCanvas />);
    const groups = container.querySelectorAll('[data-object-id]');
    expect(groups).toHaveLength(1);
    expect(container.querySelector('rect')).not.toBeNull();
  });

  it('selects the object under the pointer', () => {
    const { container } = render(<SceneCanvas />);
    const svg = container.querySelector('svg');
    // Real pointer events land on the shape, not on the wrapper group.
    const shape = container.querySelector('[data-object-id] rect');
    expect(svg).not.toBeNull();
    expect(shape).not.toBeNull();

    shape?.dispatchEvent(pointer('pointerdown', 100, 100));
    expect(store().selection).toEqual(['rect-1']);
  });

  it('turns a pointer drag into a move operation', () => {
    const { container } = render(<SceneCanvas />);
    const svg = container.querySelector('svg');
    const shape = container.querySelector('[data-object-id] rect');

    shape?.dispatchEvent(pointer('pointerdown', 100, 100));
    svg?.dispatchEvent(pointer('pointermove', 160, 130));
    svg?.dispatchEvent(pointer('pointerup', 160, 130));

    expect(store().scene.objects.get('rect-1')?.x).toBe(140);
    expect(store().scene.objects.get('rect-1')?.y).toBe(110);
    expect(store().undoStack).toHaveLength(1);
  });

  it('creates an object when a shape tool is active', () => {
    useSceneStore.getState().setTool('ellipse');
    const { container } = render(<SceneCanvas />);
    const svg = container.querySelector('svg');

    svg?.dispatchEvent(pointer('pointerdown', 400, 300));

    expect(store().scene.objects.size).toBe(2);
    const created = Array.from(store().scene.objects.values()).find(
      (object) => object.type === 'ellipse',
    );
    expect(created?.x).toBe(330);
    expect(created?.y).toBe(230);
  });

  it('clears the selection when the empty canvas is clicked', () => {
    store().setSelection(['rect-1']);
    const { container } = render(<SceneCanvas />);
    const svg = container.querySelector('svg');

    svg?.dispatchEvent(pointer('pointerdown', 700, 500));
    expect(store().selection).toEqual([]);
  });
});
