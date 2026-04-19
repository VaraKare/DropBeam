// Minimal Vite ambient types — we avoid `/// <reference types="vite/client" />`
// so `tsc --noEmit` can run before `bun install`.

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly url: string;
}

declare module "*?worker" {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}
