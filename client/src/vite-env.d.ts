/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of the Syncanvas gateway, e.g. `wss://sync.example.com/ws`. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
