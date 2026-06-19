import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const compat = (m: string) => path.resolve(HERE, 'src/electron-compat', m)

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'electron/main/index.ts' },
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
      lib: { entry: 'electron/preload/index.ts', formats: ['cjs'] },
      rollupOptions: { output: { entryFileNames: '[name].js' } },
    },
  },
  renderer: {
    root: HERE,
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_WEFTCUT_E2E': JSON.stringify(
        process.env.VITE_WEFTCUT_E2E === '1' ? '1' : '0',
      ),
    },
    resolve: {
      alias: {
        '@': path.resolve(HERE, 'src'),
        // Redirect every @tauri-apps/* surface to a compat shim.
        // The renderer keeps importing @tauri-apps/* verbatim; Vite rewrites
        // at bundle time to the matching src/electron-compat/* file.
        '@tauri-apps/api/core': compat('tauri-core.ts'),
        '@tauri-apps/api/event': compat('tauri-event.ts'),
        '@tauri-apps/api/path': compat('tauri-path.ts'),
        '@tauri-apps/api/window': compat('tauri-window.ts'),
        '@tauri-apps/api/webviewWindow': compat('tauri-webview-window.ts'),
        '@tauri-apps/plugin-dialog': compat('plugin-dialog.ts'),
        '@tauri-apps/plugin-fs': compat('plugin-fs.ts'),
        '@tauri-apps/plugin-notification': compat('plugin-notification.ts'),
        '@tauri-apps/plugin-shell': compat('plugin-shell.ts'),
      },
    },
    build: {
      target: 'chrome120',
      outDir: 'out/renderer',
      rollupOptions: { input: path.resolve(HERE, 'index.html') },
    },
    server: { port: 1420, strictPort: true },
  },
})
