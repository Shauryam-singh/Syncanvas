/**
 * Test environment shims.
 *
 * jsdom implements neither `ResizeObserver` nor layout, so the canvas gets a
 * deterministic 800 × 600 viewport. The pointer capture API is optional in
 * the component (older/limited environments do not implement it).
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
  return {
    left: 0,
    top: 0,
    right: VIEWPORT_WIDTH,
    bottom: VIEWPORT_HEIGHT,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
};
