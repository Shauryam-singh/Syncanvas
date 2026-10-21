import { create } from 'zustand';
import {
  applyOps,
  createInitialScene,
  createSceneObject,
  createSceneState,
  getObjectsInOrder,
  invertOp,
  moveObject,
  resizeObject,
  rotateObject,
  type MutableProp,
  type Op,
  type PeerPresence,
  type Point,
  type ResizeHandle,
  type SceneObject,
  type SceneObjectType,
  type SceneState,
} from '@syncanvas/shared';
import type { ConnectionState } from '../net/syncClient';

export type Tool = 'select' | SceneObjectType;

/**
 * Where local operations go.
 *
 * `null` means "apply them here and now" — the single-user behaviour of
 * stage 1. When the gateway is connected the store hands the operations to
 * the sync client instead, and they come back in the gateway's order.
 */
export type OpSender = (ops: Op[], meta: { undoable: boolean }) => void;

export interface MoveInteraction {
  kind: 'move';
  objectIds: string[];
  startPointer: Point;
  startObjects: SceneObject[];
}

export interface ResizeInteraction {
  kind: 'resize';
  objectId: string;
  handle: ResizeHandle;
  startPointer: Point;
  startObject: SceneObject;
  preserveAspectRatio: boolean;
  fromCenter: boolean;
}

export interface RotateInteraction {
  kind: 'rotate';
  objectId: string;
  startPointer: Point;
  startObject: SceneObject;
}

export type Interaction = MoveInteraction | ResizeInteraction | RotateInteraction;

export interface InteractionModifiers {
  shift: boolean;
  alt: boolean;
}

/** Properties that can be edited from the properties panel. */
export type EditableProps = Partial<Pick<SceneObject, MutableProp>>;

/** One undoable step: the operations and the operations that undo them. */
export interface UndoEntry {
  ops: Op[];
  inverses: Op[];
}

export interface SceneStore {
  scene: SceneState;
  selection: string[];
  tool: Tool;
  /** The gesture currently in progress, if any. */
  interaction: Interaction | null;
  /** Ephemeral preview of the gesture — never persisted, never an operation. */
  draft: SceneObject[];
  /** One entry per user gesture; a gesture may contain several operations. */
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** How the editor is connected to the gateway. */
  connection: ConnectionState;
  /** The people in the room, this client included. */
  peers: PeerPresence[];
  /** Where local operations are sent; `null` means "apply them locally". */
  opSender: OpSender | null;

  /** Applies operations as a single undoable step. */
  dispatch: (ops: Op[]) => void;
  /** Applies operations the gateway confirmed, in the gateway's order. */
  applyServerOps: (ops: Op[], meta: { mine: boolean; undoable: boolean }) => void;
  setTool: (tool: Tool) => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setConnection: (connection: ConnectionState) => void;
  setPeers: (peers: PeerPresence[]) => void;
  setOpSender: (sender: OpSender | null) => void;

  createObject: (type: SceneObjectType, point: Point) => void;
  updateObject: (id: string, changes: EditableProps) => void;
  deleteSelected: () => void;
  reorderSelection: (action: 'front' | 'forward' | 'backward' | 'back') => void;
  spawnObjects: (count: number) => void;
  loadScene: (objects: SceneObject[]) => void;

  beginMove: (objectIds: string[], pointer: Point) => void;
  beginResize: (
    objectId: string,
    handle: ResizeHandle,
    pointer: Point,
    modifiers: InteractionModifiers,
  ) => void;
  beginRotate: (objectId: string, pointer: Point) => void;
  updateInteraction: (pointer: Point, modifiers: InteractionModifiers) => void;
  endInteraction: () => void;
  cancelInteraction: () => void;

  undo: () => void;
  redo: () => void;
}

/**
 * Computes the operations that undo a group of operations.
 *
 * The inverses are returned in the order they must be applied: the inverse of
 * the last operation first, exactly like a stack.
 */
export function invertGroup(startState: SceneState, ops: Op[]): Op[] {
  const states: SceneState[] = [startState];
  let current = startState;
  for (const op of ops) {
    current = applyOps(current, [op]);
    states.push(current);
  }

  const inverses: Op[] = [];
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (!op) continue;
    const inverse = invertOp(states[i] as SceneState, op);
    if (inverse) inverses.push(inverse);
  }
  return inverses;
}

function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

const DEFAULT_SIZE: Record<SceneObjectType, { w: number; h: number }> = {
  rect: { w: 160, h: 100 },
  ellipse: { w: 140, h: 140 },
  line: { w: 200, h: 20 },
  text: { w: 220, h: 40 },
};

const DEFAULT_FILL: Record<SceneObjectType, string> = {
  rect: '#6366f1',
  ellipse: '#22c55e',
  line: '#0f172a',
  text: '#0f172a',
};

export const useSceneStore = create<SceneStore>((set, get) => ({
  scene: createSceneState(createInitialScene()),
  selection: [],
  tool: 'select',
  interaction: null,
  draft: [],
  undoStack: [],
  redoStack: [],
  connection: 'local',
  peers: [],
  opSender: null,

  dispatch: (ops) => {
    if (ops.length === 0) return;
    const sender = get().opSender;
    if (sender) {
      // Connected: the gateway owns the order. The operation is sent and
      // applied when it comes back, so every replica folds the same history.
      sender(ops, { undoable: true });
      return;
    }
    set((state) => ({
      scene: applyOps(state.scene, ops),
      // The inverses are computed against the state *before* the operations
      // were applied — that is the only state they can undo.
      undoStack: [...state.undoStack, { ops, inverses: invertGroup(state.scene, ops) }],
      redoStack: [],
    }));
  },

  applyServerOps: (ops, meta) => {
    if (ops.length === 0) return;
    set((state) => {
      const scene = applyOps(state.scene, ops);
      if (!meta.mine) {
        // Somebody else's edit: it changes the scene but it is not part of
        // this user's history and cannot be undone by them.
        return { scene };
      }
      if (!meta.undoable) {
        // The confirmation of an undo or a redo: the stacks were already
        // updated when the action was triggered.
        return { scene };
      }
      return {
        scene,
        undoStack: [...state.undoStack, { ops, inverses: invertGroup(state.scene, ops) }],
        redoStack: [],
      };
    });
  },

  setTool: (tool) => set({ tool }),
  setSelection: (ids) => set({ selection: ids }),
  toggleSelection: (id) =>
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((selected) => selected !== id)
        : [...state.selection, id],
    })),
  clearSelection: () => set({ selection: [] }),
  setConnection: (connection) => set({ connection }),
  setPeers: (peers) => set({ peers }),
  setOpSender: (opSender) => set({ opSender }),

  createObject: (type, point) => {
    const size = DEFAULT_SIZE[type];
    const object = createSceneObject({
      id: newId('obj'),
      type,
      x: Math.round(point.x - size.w / 2),
      y: Math.round(point.y - size.h / 2),
      w: size.w,
      h: size.h,
      fill: DEFAULT_FILL[type],
      text: type === 'text' ? 'Double-click to edit' : undefined,
    });
    get().dispatch([{ kind: 'createObject', object }]);
    set({ selection: [object.id], tool: 'select' });
  },

  updateObject: (id, changes) => {
    const ops: Op[] = [];
    for (const [prop, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      ops.push({
        kind: 'setProp',
        objectId: id,
        prop: prop as MutableProp,
        value: value as SceneObject[MutableProp],
      });
    }
    get().dispatch(ops);
  },

  deleteSelected: () => {
    const { selection } = get();
    if (selection.length === 0) return;
    get().dispatch(selection.map((id) => ({ kind: 'deleteObject', objectId: id })));
    set({ selection: [] });
  },

  reorderSelection: (action) => {
    const { scene, selection } = get();
    if (selection.length === 0) return;
    const ops: Op[] = [];

    for (const id of selection) {
      const index = scene.order.indexOf(id);
      if (index < 0) continue;

      // `insertZOrder(id, afterId)` puts the object right after `afterId` in
      // the order array (which runs bottom-most → top-most). `afterId: null`
      // means "beginning of the sequence", i.e. the bottom-most layer.
      let afterId: string | null = null;
      switch (action) {
        case 'front': {
          const others = scene.order.filter((other) => other !== id);
          afterId = others[others.length - 1] ?? null;
          break;
        }
        case 'back': {
          afterId = null;
          break;
        }
        case 'forward': {
          // Already the top-most layer.
          if (index >= scene.order.length - 1) continue;
          afterId = scene.order[index + 1] ?? null;
          break;
        }
        case 'backward': {
          // Already the bottom-most layer.
          if (index === 0) continue;
          // Take the place of the layer below: insert after the layer below it.
          afterId = index >= 2 ? (scene.order[index - 2] ?? null) : null;
          break;
        }
      }

      ops.push({ kind: 'insertZOrder', objectId: id, afterId });
    }

    if (ops.length === 0) return;
    get().dispatch(ops);
  },

  spawnObjects: (count) => {
    const ops: Op[] = [];
    for (let i = 0; i < count; i += 1) {
      const type: SceneObjectType = i % 3 === 0 ? 'rect' : i % 3 === 1 ? 'ellipse' : 'text';
      const size = DEFAULT_SIZE[type];
      ops.push({
        kind: 'createObject',
        object: createSceneObject({
          id: newId('obj'),
          type,
          x: Math.round(Math.random() * 1600 - 200),
          y: Math.round(Math.random() * 1000 - 150),
          w: size.w,
          h: size.h,
          rotation: Math.round(Math.random() * 60) - 30,
          fill: DEFAULT_FILL[type],
          text: type === 'text' ? `Object ${i + 1}` : undefined,
        }),
      });
    }
    get().dispatch(ops);
  },

  loadScene: (objects) => {
    set({
      scene: createSceneState(objects),
      selection: [],
      undoStack: [],
      redoStack: [],
      interaction: null,
      draft: [],
    });
  },

  beginMove: (objectIds, pointer) => {
    const { scene } = get();
    const startObjects = getObjectsInOrder(scene).filter((object) => objectIds.includes(object.id));
    if (startObjects.length === 0) return;
    set({
      interaction: { kind: 'move', objectIds, startPointer: pointer, startObjects },
      draft: [],
    });
  },

  beginResize: (objectId, handle, pointer, modifiers) => {
    const object = get().scene.objects.get(objectId);
    if (!object) return;
    set({
      interaction: {
        kind: 'resize',
        objectId,
        handle,
        startPointer: pointer,
        startObject: object,
        preserveAspectRatio: modifiers.shift,
        fromCenter: modifiers.alt,
      },
      draft: [],
    });
  },

  beginRotate: (objectId, pointer) => {
    const object = get().scene.objects.get(objectId);
    if (!object) return;
    set({
      interaction: { kind: 'rotate', objectId, startPointer: pointer, startObject: object },
      draft: [],
    });
  },

  updateInteraction: (pointer, modifiers) => {
    const { interaction } = get();
    if (!interaction) return;

    switch (interaction.kind) {
      case 'move': {
        const dx = pointer.x - interaction.startPointer.x;
        const dy = pointer.y - interaction.startPointer.y;
        set({
          draft: interaction.startObjects.map((object) => moveObject(object, dx, dy)),
        });
        return;
      }
      case 'resize': {
        set({
          draft: [
            resizeObject(interaction.startObject, interaction.handle, pointer, {
              preserveAspectRatio: interaction.preserveAspectRatio || modifiers.shift,
              fromCenter: interaction.fromCenter || modifiers.alt,
            }),
          ],
        });
        return;
      }
      case 'rotate': {
        set({
          draft: [
            rotateObject(
              interaction.startObject,
              interaction.startPointer,
              pointer,
              interaction.startObject.rotation,
              modifiers.shift ? 15 : 0,
            ),
          ],
        });
        return;
      }
    }
  },

  endInteraction: () => {
    const { interaction, draft } = get();
    if (!interaction) return;

    const ops: Op[] = [];
    if (interaction.kind === 'move') {
      for (const original of interaction.startObjects) {
        const updated = draft.find((object) => object.id === original.id);
        if (!updated) continue;
        if (updated.x !== original.x) {
          ops.push({ kind: 'setProp', objectId: original.id, prop: 'x', value: updated.x });
        }
        if (updated.y !== original.y) {
          ops.push({ kind: 'setProp', objectId: original.id, prop: 'y', value: updated.y });
        }
      }
    } else if (interaction.kind === 'resize') {
      const original = interaction.startObject;
      const updated = draft[0];
      if (updated) {
        if (updated.x !== original.x) {
          ops.push({ kind: 'setProp', objectId: original.id, prop: 'x', value: updated.x });
        }
        if (updated.y !== original.y) {
          ops.push({ kind: 'setProp', objectId: original.id, prop: 'y', value: updated.y });
        }
        if (updated.w !== original.w) {
          ops.push({ kind: 'setProp', objectId: original.id, prop: 'w', value: updated.w });
        }
        if (updated.h !== original.h) {
          ops.push({ kind: 'setProp', objectId: original.id, prop: 'h', value: updated.h });
        }
      }
    } else {
      const original = interaction.startObject;
      const updated = draft[0];
      if (updated && updated.rotation !== original.rotation) {
        ops.push({
          kind: 'setProp',
          objectId: original.id,
          prop: 'rotation',
          value: updated.rotation,
        });
      }
    }

    set({ interaction: null, draft: [] });
    if (ops.length > 0) {
      get().dispatch(ops);
    }
  },

  cancelInteraction: () => set({ interaction: null, draft: [] }),

  undo: () => {
    const { scene, undoStack, redoStack, opSender } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    if (opSender) {
      // Connected: undo is itself an edit. The inverse operations travel to
      // the gateway like any other operation and are applied on the way back.
      set({
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, entry],
      });
      opSender(entry.inverses, { undoable: false });
      return;
    }
    set({
      scene: applyOps(scene, entry.inverses),
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, entry],
    });
  },

  redo: () => {
    const { scene, undoStack, redoStack, opSender } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    if (opSender) {
      set({
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, entry],
      });
      opSender(entry.ops, { undoable: false });
      return;
    }
    set({
      scene: applyOps(scene, entry.ops),
      undoStack: [...undoStack, entry],
      redoStack: redoStack.slice(0, -1),
    });
  },
}));
