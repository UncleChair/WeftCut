import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const compat = (m: string) => path.resolve(HERE, 'src/electron-compat', m)

// Vitest reads this config (the build is driven by electron.vite.config.ts).
// The renderer keeps importing @tauri-apps/* verbatim; mirror the build's
// alias table so tests resolve those imports to the electron-compat shims
// instead of the real (Tauri) packages. Without these, every test file that
// transitively imports an @tauri-apps surface fails to resolve at mock time.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Unit tests live under src/. The Playwright Electron specs in e2e/ use the
  // Playwright runner (npm run e2e:electron) — keep Vitest from scooping up
  // their *.spec.ts (they fail under Vitest because they're not Vitest tests).
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(HERE, 'src'),
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
})
