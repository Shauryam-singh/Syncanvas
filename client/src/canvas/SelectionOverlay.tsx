import { getHandlePositions, getObjectCenter, type SceneObject } from '@syncanvas/shared';
import { RESIZE_HANDLES } from '@syncanvas/shared';

interface SelectionOverlayProps {
  objects: SceneObject[];
  /** Used to keep the handles a constant size on screen. */
  zoom: number;
}

/**
 * Draws the selection chrome: an outline per selected object plus the resize
 * and rotate handles of the (single) active object.
 */
export function SelectionOverlay({ objects, zoom }: SelectionOverlayProps) {
  const handleSize = 8 / zoom;
  const strokeWidth = 1.5 / zoom;
  const rotateOffset = 28 / zoom;

  const active = objects.length === 1 ? objects[0] : undefined;
  const handles = active ? getHandlePositions(active) : undefined;
  const activeCenter = active ? getObjectCenter(active) : undefined;

  return (
    <g className="selection-overlay">
      {objects.map((object) => {
        const center = getObjectCenter(object);
        return (
          <rect
            key={`outline-${object.id}`}
            x={object.x}
            y={object.y}
            width={object.w}
            height={object.h}
            fill="none"
            stroke="#2563eb"
            strokeWidth={strokeWidth}
            transform={`rotate(${object.rotation} ${center.x} ${center.y})`}
            pointerEvents="none"
          />
        );
      })}

      {active && handles && activeCenter ? (
        <g className="selection-handles">
          <line
            x1={activeCenter.x}
            y1={activeCenter.y - active.h / 2}
            x2={activeCenter.x}
            y2={activeCenter.y - active.h / 2 - rotateOffset}
            stroke="#2563eb"
            strokeWidth={strokeWidth}
            pointerEvents="none"
          />
          <circle
            className="handle handle-rotate"
            data-handle="rotate"
            cx={activeCenter.x}
            cy={activeCenter.y - active.h / 2 - rotateOffset}
            r={handleSize / 1.6}
            fill="#ffffff"
            stroke="#2563eb"
            strokeWidth={strokeWidth}
          />
          {RESIZE_HANDLES.map((handle) => {
            const position = handles[handle];
            return (
              <rect
                key={handle}
                className={`handle handle-${handle}`}
                data-handle={handle}
                x={position.x - handleSize / 2}
                y={position.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                fill="#ffffff"
                stroke="#2563eb"
                strokeWidth={strokeWidth}
              />
            );
          })}
        </g>
      ) : null}
    </g>
  );
}
