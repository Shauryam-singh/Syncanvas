import { createSceneObject, type SceneObject } from '@syncanvas/shared';

const previewObjects: SceneObject[] = [
  createSceneObject({
    id: 'demo-rect',
    type: 'rect',
    x: 40,
    y: 40,
    w: 160,
    h: 100,
    fill: '#6366f1',
  }),
  createSceneObject({
    id: 'demo-ellipse',
    type: 'ellipse',
    x: 180,
    y: 110,
    w: 120,
    h: 120,
    fill: '#22c55e',
  }),
  createSceneObject({
    id: 'demo-text',
    type: 'text',
    x: 60,
    y: 200,
    w: 240,
    h: 40,
    fill: '#0f172a',
    text: 'Syncanvas — Stage 0',
  }),
];

function ObjectShape({ object }: { object: SceneObject }) {
  const transform = `rotate(${object.rotation} ${object.x + object.w / 2} ${object.y + object.h / 2})`;

  if (object.type === 'ellipse') {
    return (
      <ellipse
        cx={object.x + object.w / 2}
        cy={object.y + object.h / 2}
        rx={object.w / 2}
        ry={object.h / 2}
        fill={object.fill}
        transform={transform}
      />
    );
  }

  if (object.type === 'text') {
    return (
      <text
        x={object.x}
        y={object.y + object.h / 2}
        fill={object.fill}
        fontSize={20}
        fontFamily="ui-monospace, monospace"
        transform={transform}
      >
        {object.text}
      </text>
    );
  }

  return (
    <rect
      x={object.x}
      y={object.y}
      width={object.w}
      height={object.h}
      fill={object.fill}
      transform={transform}
    />
  );
}

export function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>Syncanvas</h1>
        <p>Real-time collaborative scene editor — Stage 0: setup and design</p>
      </header>
      <div className="canvas-frame">
        <svg viewBox="0 0 400 280" className="canvas-preview" role="img" aria-label="Scene preview">
          <rect x="0" y="0" width="400" height="280" fill="#f8fafc" />
          {previewObjects
            .slice()
            .sort((a, b) => a.zIndex - b.zIndex)
            .map((object) => (
              <ObjectShape key={object.id} object={object} />
            ))}
        </svg>
      </div>
      <ul className="checklist">
        <li>Monorepo: client / server / shared</li>
        <li>Docker Compose: Postgres + Redis</li>
        <li>CI: lint + typecheck + tests</li>
        <li>Design doc: data model, protocol, CRDT</li>
      </ul>
    </main>
  );
}
