import { useState } from 'react';
import { getObjectsInOrder, type SceneObject } from '@syncanvas/shared';
import { selectCanEdit, useSceneStore } from '../store/sceneStore';

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
}

/**
 * A number input that only commits when the value is complete, so that
 * typing "-" or "1." does not dispatch an operation per keystroke.
 */
function NumberField({ label, value, onCommit, disabled = false }: NumberFieldProps) {
  const [text, setText] = useState(String(Math.round(value)));
  const [lastValue, setLastValue] = useState(value);

  // Adjust the local text when the selected object changes underneath us.
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(Math.round(value)));
  }

  const commit = () => {
    const parsed = Number(text);
    if (text.trim() !== '' && Number.isFinite(parsed)) {
      if (parsed !== value) onCommit(parsed);
      return;
    }
    setText(String(Math.round(value)));
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function PropertiesPanel() {
  const scene = useSceneStore((state) => state.scene);
  const selection = useSceneStore((state) => state.selection);
  const updateObject = useSceneStore((state) => state.updateObject);
  const canEdit = useSceneStore(selectCanEdit);

  const selected: SceneObject[] = getObjectsInOrder(scene).filter((object) =>
    selection.includes(object.id),
  );
  const active = selected.length === 1 ? selected[0] : undefined;

  if (selected.length === 0) {
    return (
      <aside className="panel">
        <h2>Properties</h2>
        <p className="panel-empty">
          Nothing selected. Click an object on the canvas, or press <kbd>R</kbd> / <kbd>O</kbd> /{' '}
          <kbd>L</kbd> / <kbd>T</kbd> to draw one.
        </p>
      </aside>
    );
  }

  if (!active) {
    return (
      <aside className="panel">
        <h2>Properties</h2>
        <p className="panel-empty">{selected.length} objects selected.</p>
      </aside>
    );
  }

  return (
    <aside className="panel">
      <h2>Properties</h2>
      {!canEdit ? (
        <p className="panel-readonly">Read-only — you joined this room as a viewer.</p>
      ) : null}

      <div className="panel-section">
        <h3>Transform</h3>
        <div className="field-grid">
          <NumberField
            label="X"
            value={active.x}
            disabled={!canEdit}
            onCommit={(value) => updateObject(active.id, { x: value })}
          />
          <NumberField
            label="Y"
            value={active.y}
            disabled={!canEdit}
            onCommit={(value) => updateObject(active.id, { y: value })}
          />
          <NumberField
            label="W"
            value={active.w}
            disabled={!canEdit}
            onCommit={(value) => updateObject(active.id, { w: Math.max(1, value) })}
          />
          <NumberField
            label="H"
            value={active.h}
            disabled={!canEdit}
            onCommit={(value) => updateObject(active.id, { h: Math.max(1, value) })}
          />
          <NumberField
            label="Rotation"
            value={active.rotation}
            disabled={!canEdit}
            onCommit={(value) => updateObject(active.id, { rotation: value })}
          />
        </div>
      </div>

      <div className="panel-section">
        <h3>Appearance</h3>
        <label className="field">
          <span>Fill</span>
          <input
            type="color"
            value={active.fill}
            disabled={!canEdit}
            onChange={(event) => updateObject(active.id, { fill: event.target.value })}
          />
        </label>
        {active.type === 'text' ? (
          <label className="field">
            <span>Text</span>
            <input
              type="text"
              value={active.text ?? ''}
              disabled={!canEdit}
              onChange={(event) => updateObject(active.id, { text: event.target.value })}
            />
          </label>
        ) : null}
      </div>

      <div className="panel-section">
        <h3>Object</h3>
        <dl className="meta">
          <dt>Type</dt>
          <dd>{active.type}</dd>
          <dt>Id</dt>
          <dd className="mono">{active.id}</dd>
          <dt>Layer</dt>
          <dd>
            {active.zIndex + 1} of {scene.order.length}
          </dd>
        </dl>
      </div>
    </aside>
  );
}
