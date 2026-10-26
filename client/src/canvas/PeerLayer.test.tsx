import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSceneState, type PeerPresence, type SceneObject } from '@syncanvas/shared';
import { useSceneStore } from '../store/sceneStore';
import { PeerLayer } from './PeerLayer';

const object: SceneObject = {
  id: 'rect-1',
  type: 'rect',
  x: 10,
  y: 20,
  w: 30,
  h: 40,
  rotation: 0,
  fill: '#fff',
  zIndex: 0,
};

let frames: Array<{ id: number; callback: FrameRequestCallback }>;
let nextFrame: number;

function peer(overrides: Partial<PeerPresence> = {}): PeerPresence {
  return {
    sessionId: 'sess_bob',
    userId: 'user_bob',
    displayName: 'Bob',
    color: '#ef4444',
    cursor: { x: 100, y: 50 },
    selection: [],
    lastSeen: 0,
    ...overrides,
  };
}

/** Runs every queued animation frame once. */
function flushFrames(count = 1): void {
  for (let index = 0; index < count; index += 1) {
    const pending = frames;
    frames = [];
    if (pending.length === 0) return;
    act(() => {
      for (const frame of pending) frame.callback(0);
    });
  }
}

function cursorTransform(container: HTMLElement): string | null {
  return (
    container
      .querySelector<SVGGElement>('.peer-layer > g > g[transform^="translate"]')
      ?.getAttribute('transform') ?? null
  );
}

function cursorX(container: HTMLElement): number {
  const transform = cursorTransform(container);
  const match = /translate\(([-\d.]+)/.exec(transform ?? '');
  return match ? Number(match[1]) : Number.NaN;
}

describe('PeerLayer', () => {
  beforeEach(() => {
    frames = [];
    nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.push({ id, callback });
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames = frames.filter((frame) => frame.id !== id);
    });

    useSceneStore.setState({
      scene: createSceneState([object]),
      peers: [],
      selfSessionId: 'sess_me',
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('draws another peer’s cursor, label and selection outline', () => {
    useSceneStore.setState({
      peers: [peer({ selection: ['rect-1'] })],
    });

    const { container } = render(
      <svg>
        <PeerLayer zoom={1} />
      </svg>,
    );
    flushFrames();

    expect(container.querySelector('.peer-layer text')?.textContent).toBe('Bob');
    expect(container.querySelectorAll('.peer-layer path')).toHaveLength(1);
    const outline = container.querySelector('.peer-layer rect[stroke="#ef4444"]');
    expect(outline?.getAttribute('x')).toBe('10');
    expect(outline?.getAttribute('y')).toBe('20');
    expect(outline?.getAttribute('width')).toBe('30');
    expect(outline?.getAttribute('height')).toBe('40');
  });

  it('interpolates towards the newest cursor position instead of jumping', () => {
    useSceneStore.setState({ peers: [peer()] });

    const { container } = render(
      <svg>
        <PeerLayer zoom={1} />
      </svg>,
    );
    flushFrames();
    expect(cursorX(container)).toBe(100);

    act(() => {
      useSceneStore.setState({ peers: [peer({ cursor: { x: 200, y: 50 } })] });
    });
    flushFrames();
    expect(cursorX(container)).toBeCloseTo(135, 5);

    flushFrames(20);
    expect(cursorX(container)).toBeCloseTo(200, 1);
  });

  it('does not draw this client’s own cursor', () => {
    useSceneStore.setState({
      peers: [peer({ sessionId: 'sess_me', displayName: 'Me' })],
    });

    const { container } = render(
      <svg>
        <PeerLayer zoom={1} />
      </svg>,
    );
    flushFrames();

    expect(container.querySelector('.peer-layer text')).toBeNull();
  });

  it('removes a cursor when the peer leaves', () => {
    useSceneStore.setState({ peers: [peer()] });

    const { container } = render(
      <svg>
        <PeerLayer zoom={1} />
      </svg>,
    );
    flushFrames();
    expect(container.querySelector('.peer-layer path')).not.toBeNull();

    act(() => {
      useSceneStore.setState({ peers: [] });
    });
    flushFrames();

    expect(container.querySelector('.peer-layer path')).toBeNull();
  });

  it('keeps the cursor marker the same size when the canvas is zoomed', () => {
    useSceneStore.setState({ peers: [peer()] });

    const { container } = render(
      <svg>
        <PeerLayer zoom={2} />
      </svg>,
    );
    flushFrames();

    expect(cursorTransform(container)).toContain('scale(0.5)');
  });
});
