import { beforeEach, describe, expect, it } from 'vitest';
import { createSceneState, getObjectsInOrder, type SceneObject } from '@syncanvas/shared';
import { invertGroup, useSceneStore } from './sceneStore';

const store = () => useSceneStore.getState();

function reset(objects: SceneObject[] = []) {
  useSceneStore.setState({
    scene: createSceneState(objects),
    selection: [],
    tool: 'select',
    interaction: null,
    draft: [],
    undoStack: [],
    redoStack: [],
  });
}

beforeEach(() => {
  reset();
});

describe('dispatch', () => {
  it('applies operations and records one undo step per call', () => {
    store().dispatch([{ kind: 'setProp', objectId: 'a', prop: 'x', value: 5 }]);
    expect(store().undoStack).toHaveLength(1);
    expect(store().redoStack).toHaveLength(0);
  });

  it('clears the redo stack when new work arrives', () => {
    store().dispatch([{ kind: 'createObject', object: { id: 'a', type: 'rect' } as SceneObject }]);
    store().undo();
    expect(store().redoStack).toHaveLength(1);
    store().dispatch([{ kind: 'createObject', object: { id: 'b', type: 'rect' } as SceneObject }]);
    expect(store().redoStack).toHaveLength(0);
  });
});

describe('create and delete', () => {
  it('creates an object at the pointer and selects it', () => {
    store().createObject('rect', { x: 100, y: 100 });
    const objects = getObjectsInOrder(store().scene);
    expect(objects).toHaveLength(1);
    // The default rectangle is 160 × 100 and is centred on the pointer.
    expect(objects[0]?.x).toBe(20);
    expect(objects[0]?.y).toBe(50);
    expect(store().selection).toEqual([objects[0]?.id]);
    // Creating a shape switches back to the select tool.
    expect(store().tool).toBe('select');
  });

  it('deletes the selection', () => {
    store().createObject('rect', { x: 0, y: 0 });
    const id = getObjectsInOrder(store().scene)[0]?.id as string;
    store().setSelection([id]);
    store().deleteSelected();
    expect(store().scene.objects.size).toBe(0);
    expect(store().selection).toEqual([]);
  });
});

describe('undo / redo', () => {
  it('undoes and redoes a property change', () => {
    reset([
      { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, fill: '#fff', zIndex: 0 },
    ]);
    store().updateObject('a', { x: 42 });
    expect(store().scene.objects.get('a')?.x).toBe(42);

    store().undo();
    expect(store().scene.objects.get('a')?.x).toBe(0);

    store().redo();
    expect(store().scene.objects.get('a')?.x).toBe(42);
  });

  it('undoes a whole gesture as a single step', () => {
    reset([
      { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, fill: '#fff', zIndex: 0 },
    ]);
    // A drag produces one setProp for x and one for y.
    store().dispatch([
      { kind: 'setProp', objectId: 'a', prop: 'x', value: 10 },
      { kind: 'setProp', objectId: 'a', prop: 'y', value: 20 },
    ]);
    expect(store().undoStack).toHaveLength(1);

    store().undo();
    expect(store().scene.objects.get('a')?.x).toBe(0);
    expect(store().scene.objects.get('a')?.y).toBe(0);
  });

  it('undoes a create by deleting the object again', () => {
    store().createObject('ellipse', { x: 0, y: 0 });
    expect(store().scene.objects.size).toBe(1);
    store().undo();
    expect(store().scene.objects.size).toBe(0);
  });
});

describe('invertGroup', () => {
  it('produces the inverses in reverse order', () => {
    reset([
      { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, fill: '#fff', zIndex: 0 },
    ]);
    const ops = [
      { kind: 'setProp' as const, objectId: 'a', prop: 'x' as const, value: 10 },
      { kind: 'setProp' as const, objectId: 'a', prop: 'x' as const, value: 20 },
    ];
    const inverses = invertGroup(store().scene, ops);
    expect(inverses).toEqual([
      { kind: 'setProp', objectId: 'a', prop: 'x', value: 10 },
      { kind: 'setProp', objectId: 'a', prop: 'x', value: 0 },
    ]);
  });
});

describe('interactions', () => {
  const object: SceneObject = {
    id: 'a',
    type: 'rect',
    x: 100,
    y: 100,
    w: 100,
    h: 100,
    rotation: 0,
    fill: '#6366f1',
    zIndex: 0,
  };

  it('turns a drag into position operations', () => {
    reset([object]);
    store().beginMove(['a'], { x: 0, y: 0 });
    store().updateInteraction({ x: 25, y: 15 }, { shift: false, alt: false });
    expect(store().draft[0]?.x).toBe(125);
    expect(store().draft[0]?.y).toBe(115);

    store().endInteraction();
    expect(store().scene.objects.get('a')?.x).toBe(125);
    expect(store().scene.objects.get('a')?.y).toBe(115);
    expect(store().interaction).toBeNull();
    expect(store().undoStack).toHaveLength(1);
  });

  it('turns a resize drag into geometry operations', () => {
    reset([object]);
    store().beginResize('a', 'se', { x: 200, y: 200 }, { shift: false, alt: false });
    store().updateInteraction({ x: 250, y: 250 }, { shift: false, alt: false });
    store().endInteraction();

    const updated = store().scene.objects.get('a');
    expect(updated?.w).toBe(150);
    expect(updated?.h).toBe(150);
    expect(updated?.x).toBe(100);
  });

  it('turns a rotate drag into a rotation operation', () => {
    reset([object]);
    // Grab the rotate handle to the right of the centre and drag it down.
    store().beginRotate('a', { x: 250, y: 150 });
    store().updateInteraction({ x: 150, y: 200 }, { shift: false, alt: false });
    store().endInteraction();
    expect(store().scene.objects.get('a')?.rotation).toBeCloseTo(90, 6);
  });

  it('does not record an undo step when nothing moved', () => {
    reset([object]);
    store().beginMove(['a'], { x: 0, y: 0 });
    store().updateInteraction({ x: 0, y: 0 }, { shift: false, alt: false });
    store().endInteraction();
    expect(store().undoStack).toHaveLength(0);
  });

  it('cancels an interaction without touching the scene', () => {
    reset([object]);
    store().beginMove(['a'], { x: 0, y: 0 });
    store().updateInteraction({ x: 500, y: 500 }, { shift: false, alt: false });
    store().cancelInteraction();
    expect(store().scene.objects.get('a')?.x).toBe(100);
    expect(store().draft).toHaveLength(0);
  });
});

describe('z-order', () => {
  const objects: SceneObject[] = [
    { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, fill: '#fff', zIndex: 0 },
    { id: 'b', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, fill: '#fff', zIndex: 1 },
    { id: 'c', type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, fill: '#fff', zIndex: 2 },
  ];

  it('brings an object to the front', () => {
    reset(objects);
    store().setSelection(['a']);
    store().reorderSelection('front');
    expect(store().scene.order).toEqual(['b', 'c', 'a']);
  });

  it('sends an object to the back', () => {
    reset(objects);
    store().setSelection(['c']);
    store().reorderSelection('back');
    expect(store().scene.order).toEqual(['c', 'a', 'b']);
  });

  it('moves an object one step forward', () => {
    reset(objects);
    store().setSelection(['a']);
    store().reorderSelection('forward');
    expect(store().scene.order).toEqual(['b', 'a', 'c']);
  });

  it('moves an object one step backward', () => {
    reset(objects);
    store().setSelection(['c']);
    store().reorderSelection('backward');
    expect(store().scene.order).toEqual(['a', 'c', 'b']);
  });

  it('keeps the zIndex in sync with the order', () => {
    reset(objects);
    store().setSelection(['a']);
    store().reorderSelection('front');
    expect(store().scene.objects.get('a')?.zIndex).toBe(2);
  });
});
