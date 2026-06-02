/// <reference types="vite/client" />

// Set to "1" only by the E2E build (`VITE_WEFTCUT_E2E=1`); gates the dev-only
// `window.__weftcutTest` hook so it's dead-code-eliminated from prod bundles.
interface ImportMetaEnv {
  readonly VITE_WEFTCUT_E2E?: string;
}

// Vite's `?url` import suffix yields a string URL for any asset. The
// vite/client types cover common extensions but not arbitrary `*?url`
// imports from node_modules (jassub worker.js + wasm), so declare
// the wildcard once here.
declare module "*?url" {
  const src: string;
  export default src;
}
