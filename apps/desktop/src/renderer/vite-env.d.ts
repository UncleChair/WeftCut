/// <reference types="vite/client" />

// Set to "1" only by the E2E build (`VITE_WEFTCUT_E2E=1`); gates the dev-only
// `window.__weftcutTest` hook so it's dead-code-eliminated from prod bundles.
interface ImportMetaEnv {
  readonly VITE_WEFTCUT_E2E?: string;
  // Set to "1" to route WebCodecs-blind video ORIGINALS through the native
  // export-decode session (ticket 2 hardcoded routing in runExport.ts). Unset
  // ⇒ the existing WebCodecs proxy export path.
  readonly VITE_WEFTCUT_EXPORT_NATIVE?: string;
}

// Vite's `?url` import suffix yields a string URL for any asset. The
// vite/client types cover common extensions but not arbitrary `*?url`
// imports from node_modules, so declare the wildcard once here.
declare module "*?url" {
  const src: string;
  export default src;
}

// Vite's `?arraybuffer` import suffix yields the asset's bytes as an
// ArrayBuffer. vite/client types the suffix for known asset extensions but not
// for arbitrary `*?arraybuffer` imports from node_modules (the E2E test hook
// embeds a woff2 this way), so declare the wildcard here.
declare module "*?arraybuffer" {
  const bytes: ArrayBuffer;
  export default bytes;
}
