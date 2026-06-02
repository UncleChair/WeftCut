import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env["TAURI_DEV_HOST"];

export default defineConfig({
  plugins: [react()],
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
    // destructuring to Safari 13, so that path broke the build. `tauri build`
    // on Windows already used chrome105, so this is a no-op for the shipping
    // path while making the standalone build use the same target it ships with.
    target: "chrome105",
    minify: !process.env["TAURI_ENV_DEBUG"] ? "esbuild" : false,
    sourcemap: !!process.env["TAURI_ENV_DEBUG"],
  },
});
