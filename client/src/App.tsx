import { SceneCanvas } from './canvas/SceneCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

export function App() {
  useKeyboardShortcuts();

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__title">
          <h1>Syncanvas</h1>
          <p>Real-time collaborative scene editor</p>
        </div>
        <span className="badge">Stage 1 · canvas + operations</span>
      </header>

      <Toolbar />

      <div className="app-body">
        <div className="canvas-frame">
          <SceneCanvas />
        </div>
        <PropertiesPanel />
      </div>

      <StatusBar />
    </div>
  );
}
