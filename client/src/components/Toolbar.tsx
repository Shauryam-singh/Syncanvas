import { useSceneStore, type Tool } from '../store/sceneStore';

interface ToolButton {
  tool: Tool;
  label: string;
  shortcut: string;
}

const TOOLS: ToolButton[] = [
  { tool: 'select', label: 'Select', shortcut: 'V' },
  { tool: 'rect', label: 'Rect', shortcut: 'R' },
  { tool: 'ellipse', label: 'Ellipse', shortcut: 'O' },
  { tool: 'line', label: 'Line', shortcut: 'L' },
  { tool: 'text', label: 'Text', shortcut: 'T' },
];

export function Toolbar() {
  const tool = useSceneStore((state) => state.tool);
  const setTool = useSceneStore((state) => state.setTool);
  const undo = useSceneStore((state) => state.undo);
  const redo = useSceneStore((state) => state.redo);
  const undoStack = useSceneStore((state) => state.undoStack);
  const redoStack = useSceneStore((state) => state.redoStack);
  const deleteSelected = useSceneStore((state) => state.deleteSelected);
  const reorderSelection = useSceneStore((state) => state.reorderSelection);
  const selection = useSceneStore((state) => state.selection);
  const spawnObjects = useSceneStore((state) => state.spawnObjects);

  const hasSelection = selection.length > 0;

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {TOOLS.map((entry) => (
          <button
            key={entry.tool}
            type="button"
            className={`tool-button${tool === entry.tool ? ' is-active' : ''}`}
            onClick={() => setTool(entry.tool)}
            title={`${entry.label} (${entry.shortcut})`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="tool-button"
          onClick={undo}
          disabled={undoStack.length === 0}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={redo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={deleteSelected}
          disabled={!hasSelection}
          title="Delete (Del)"
        >
          Delete
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="tool-button"
          onClick={() => reorderSelection('front')}
          disabled={!hasSelection}
          title="Bring to front"
        >
          Front
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={() => reorderSelection('forward')}
          disabled={!hasSelection}
          title="Bring forward"
        >
          Forward
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={() => reorderSelection('backward')}
          disabled={!hasSelection}
          title="Send backward"
        >
          Backward
        </button>
        <button
          type="button"
          className="tool-button"
          onClick={() => reorderSelection('back')}
          disabled={!hasSelection}
          title="Send to back"
        >
          Back
        </button>
      </div>

      <div className="toolbar-group toolbar-group--end">
        <button
          type="button"
          className="tool-button"
          onClick={() => spawnObjects(500)}
          title="Add 500 objects — performance check"
        >
          +500
        </button>
      </div>
    </div>
  );
}
