import { SceneCanvas } from './canvas/SceneCanvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSync } from './net/useSync';

export function App() {
  useKeyboardShortcuts();
  useSync();

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__title">
          <h1>Syncanvas</h1>
          <p>Real-time collaborative scene editor</p>
        </div>
        <span className="badge">Stage 2 · gateway + naive LWW sync</span>
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
