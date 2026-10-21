import { memo } from 'react';
import { getObjectCenter, type SceneObject } from '@syncanvas/shared';

interface ObjectShapeProps {
  object: SceneObject;
}

/**
 * Renders a single scene object.
 *
 * `rotation` is applied around the centre of the object's own box, which is
 * the same convention the geometry helpers use — the renderer and the maths
 * can never disagree about where an object is.
 */
export const ObjectShape = memo(function ObjectShape({ object }: ObjectShapeProps) {
  const center = getObjectCenter(object);
  const transform = `rotate(${object.rotation} ${center.x} ${center.y})`;

  if (object.type === 'ellipse') {
    return (
      <ellipse
        cx={center.x}
        cy={center.y}
        rx={object.w / 2}
        ry={object.h / 2}
        fill={object.fill}
        transform={transform}
      />
    );
  }

  if (object.type === 'line') {
    return (
      <line
        x1={object.x}
        y1={object.y + object.h / 2}
        x2={object.x + object.w}
        y2={object.y + object.h / 2}
        stroke={object.fill}
        strokeWidth={2}
        strokeLinecap="round"
        transform={transform}
      />
    );
  }

  if (object.type === 'text') {
    const fontSize = Math.max(12, Math.min(object.h * 0.6, 48));
    return (
      <text
        x={object.x}
        y={object.y + object.h / 2}
        dominantBaseline="middle"
        fontSize={fontSize}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill={object.fill}
        transform={transform}
      >
        {object.text ?? ''}
      </text>
    );
  }

  return (
    <rect
      x={object.x}
      y={object.y}
      width={object.w}
      height={object.h}
      rx={Math.min(8, object.w / 8, object.h / 8)}
      fill={object.fill}
      transform={transform}
    />
  );
});
