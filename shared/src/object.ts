export type SceneObjectType = 'rect' | 'ellipse' | 'line' | 'text';

/**
 * The canonical shape of every object that lives on a Syncanvas scene.
 *
 * This is the wire format, the persisted format, and the CRDT register layout:
 * the server never invents fields that are not declared here.
 */
export interface SceneObject {
  id: string;
  type: SceneObjectType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  fill: string;
  zIndex: number;
  text?: string;
}

export type SceneObjectProp = keyof SceneObject;

/**
 * Property names that are mutated independently by the LWW-map CRDT.
 *
 * `id` and `type` are immutable by construction and `zIndex` is *derived* from
 * the z-order sequence (an RGA in stage 3), so neither is a register.
 */
export const MUTABLE_PROPS = [
  'x',
  'y',
  'w',
  'h',
  'rotation',
  'fill',
  'text',
] as const satisfies readonly SceneObjectProp[];

export type MutableProp = (typeof MUTABLE_PROPS)[number];

export function isMutableProp(prop: string): prop is MutableProp {
  return (MUTABLE_PROPS as readonly string[]).includes(prop);
}

export interface CreateSceneObjectInput {
  id: string;
  type: SceneObjectType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  fill?: string;
  zIndex?: number;
  text?: string;
}

export const DEFAULT_SCENE_OBJECT: Omit<SceneObject, 'id' | 'type'> = {
  x: 0,
  y: 0,
  w: 120,
  h: 80,
  rotation: 0,
  fill: '#6366f1',
  zIndex: 0,
};

export function createSceneObject(input: CreateSceneObjectInput): SceneObject {
  return {
    ...DEFAULT_SCENE_OBJECT,
    ...input,
    text: input.type === 'text' ? (input.text ?? '') : undefined,
  };
}
