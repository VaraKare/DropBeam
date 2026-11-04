// Minimal Vite ambient types — we avoid `/// <reference types="vite/client" />`
// so `tsc --noEmit` can run before `bun install`.

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
  /** Comma-separated TURN URLs, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349". */
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly url: string;
}

declare module "*?worker" {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}
