import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Content-Security-Policy for the PACKAGED renderer. Injected at build time
// only (`apply: 'build'`) so the Vite dev server / HMR (which needs inline +
// eval + ws) is untouched. The renderer loads no remote content; this blocks
// the real XSS vector (inline / remote <script>) while still allowing wasm
// (jassub, mediabunny), blob workers (export/jassub), data: fonts/images, and
// the app's own privileged schemes (weftcut-media:, motif:).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: weftcut-media: motif:",
  "font-src 'self' data:",
  "media-src 'self' blob: data: weftcut-media:",
  "connect-src 'self' blob: data: weftcut-media: motif:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'weftcut-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head',
        },
      ]
    },
  }
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'src/main/index.ts' },
      // Externalize native + node-resolved deps. `@modelcontextprotocol/sdk`
      // ships ESM with subpath `.js` imports (e.g. `…/sdk/server/index.js`);
      // the regex keeps those subpaths external too, so Node resolves them from
      // node_modules at runtime rather than the bundler choking on the subpaths.
      rollupOptions: {
        external: ['@weftcut/core', 'express', /^@modelcontextprotocol\/sdk(\/.*)?$/],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: 'src/preload/index.ts', formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: '[name].js' } },
    },
  },
  renderer: {
    root: path.resolve(HERE, 'src/renderer'),
    plugins: [react(), tailwindcss(), cspMeta()],
    define: {
      'import.meta.env.VITE_WEFTCUT_E2E': JSON.stringify(
        process.env.VITE_WEFTCUT_E2E === '1' ? '1' : '0',
      ),
    },
    resolve: {
      alias: {
        '@': path.resolve(HERE, 'src/renderer'),
      },
    },
    build: {
      target: 'chrome120',
      outDir: 'out/renderer',
      rollupOptions: { input: path.resolve(HERE, 'src/renderer/index.html') },
    },
    server: { port: 1420, strictPort: true },
  },
})
