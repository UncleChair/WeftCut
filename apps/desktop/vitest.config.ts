import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Vitest reads this config (the build is driven by electron.vite.config.ts).
// The renderer's backend/platform calls go through src/renderer/bridge/* (the
// Electron bridge), resolved via the @ alias just like the build.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Unit tests live under src/renderer (the app) and src/main (pure
  // main-process helpers, e.g. the fs:* path guard). The Playwright Electron
  // specs in e2e/ use the Playwright runner (npm run e2e:electron) — keep
  // Vitest from scooping up their *.spec.ts (they fail under Vitest; not Vitest
  // tests). Only add main-process tests for modules that DON'T import `electron`
  // (it can't load under Vitest).
  test: {
    include: [
      'src/renderer/**/*.{test,spec}.{ts,tsx}',
      'src/main/**/*.{test,spec}.{ts,tsx}',
      'src/shared/**/*.{test,spec}.{ts,tsx}',
    ],
    // Loads the weftcut-eval wasm before every test file (snap/keyframe/audio
    // math now runs through it). Requires the generated module — the `pretest`
    // npm hook runs build:wasm first.
    setupFiles: ['./src/renderer/testSetup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(HERE, 'src/renderer'),
    },
  },
})
