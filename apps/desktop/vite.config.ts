import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env["TAURI_DEV_HOST"];
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(HERE, "src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WeftCut ships only on Windows/WebView2 (evergreen Chromium), so we target
    // a modern Chromium baseline unconditionally. The original Tauri-scaffold
    // ternary fell back to "safari13" whenever TAURI_ENV_PLATFORM was unset —
    // i.e. on a bare `vite build` (how CI runs the frontend-bundle gate, since
    // it doesn't go through `tauri build`). esbuild cannot lower jassub's worker
    // destructuring to Safari 13, so that path broke the build.
    // chrome120 floor: Tailwind v4 emits oklch()/color-mix()/@property, which
    // need Chrome 111+ at runtime and must not be downleveled by the CSS
    // minifier. The evergreen WebView2 runtime is far ahead of this (149.x as
    // of 2026-06) and e2e resolves its msedgedriver from the installed runtime,
    // so nothing pins us lower.
    target: "chrome120",
    minify: !process.env["TAURI_ENV_DEBUG"] ? "esbuild" : false,
    sourcemap: !!process.env["TAURI_ENV_DEBUG"],
  },
});
