/// <reference types="vite/client" />

// Vite's `?url` import suffix yields a string URL for any asset. The
// vite/client types cover common extensions but not arbitrary `*?url`
// imports from node_modules (jassub worker.js + wasm), so declare
// the wildcard once here.
declare module "*?url" {
  const src: string;
  export default src;
}
