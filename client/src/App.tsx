import { SceneCanvas } from './canvas/SceneCanvas';
import { AccessGate } from './components/AccessGate';
import { PropertiesPanel } from './components/PropertiesPanel';
import { RoomPanel } from './components/RoomPanel';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSync } from './net/useSync';
import { useSceneStore } from './store/sceneStore';

export function App() {
  useKeyboardShortcuts();
  useSync();

  const roomName = useSceneStore((state) => state.roomName);

  return (
    <AccessGate>
      <div className="app">
        <header className="app-header">
          <div className="app-header__title">
            <div className="app-header__heading">
              <h1>Syncanvas</h1>
              <span className="badge">Stage 4 · presence · rooms · auth</span>
            </div>
            <p>
              <strong>{roomName}</strong> · real-time collaborative scene editor
            </p>
          </div>
          <RoomPanel />
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
    </AccessGate>
  );
}
