# S1 Boot Acceptance Notes

## Boot result

**PASS** — React UI rendered (WeftCut startup screen visible with locale-aware text, New Project / Open Project buttons, and window chrome). boot.png at `apps/desktop/electron/boot.png` (1570x924, 2026-06-17).

## Renderer console errors at boot (classified)

| Message | Classification |
|---|---|
| `[stub] backend not wired in S1: motif_register_runtime` | Expected stub rejection — fire-and-forget `void invoke()` at main.tsx module scope; no catch; unhandled promise rejection but no render crash |
| `[weftcut/motifs] syncUserMotifsFromBackend failed: [stub] backend not wired in S1: list_motifs` | Expected stub rejection — caught inside syncCatalog.ts, gracefully degrades to built-in-only catalog |
| `startup pref read failed: [stub] backend not wired in S1: recents_get_reopen_on_launch` | Expected stub rejection — caught in Root useEffect, falls back to "startup" stage correctly |
| `[stub] backend not wired in S1: recents_list` | Expected stub rejection — surfaces in StartupScreen error state (red error banner), does not crash the app |
| Electron CSP warning | Dev-only Electron security advisory; not an app error |

No module-resolution errors. No render crashes.

## Softened bootstrap commands

None were softened. The `recentsGetReopenOnLaunch` stub rejection is caught in the Root component and falls back to `startup` stage. All other early boot calls are either fire-and-forget or guarded.

## @tauri-apps import surface (full rg scan)

```
from "@tauri-apps/api/core"           -> src/electron-compat/tauri-core.ts
from "@tauri-apps/api/event"          -> src/electron-compat/tauri-event.ts
from "@tauri-apps/api/path"           -> src/electron-compat/tauri-path.ts
from "@tauri-apps/api/window"         -> src/electron-compat/tauri-window.ts
from "@tauri-apps/api/webviewWindow"  -> src/electron-compat/tauri-webview-window.ts
from "@tauri-apps/plugin-dialog"      -> src/electron-compat/plugin-dialog.ts
from "@tauri-apps/plugin-fs"          -> src/electron-compat/plugin-fs.ts
from "@tauri-apps/plugin-notification"-> src/electron-compat/plugin-notification.ts
from "@tauri-apps/plugin-shell"       -> src/electron-compat/plugin-shell.ts
```

Named exports added beyond plan defaults:
- `tauri-core.ts`: `convertFileSrc` (used by App.tsx, PixiPreview.tsx, runExport.ts)
- `tauri-path.ts`: `join`, `tempDir` (in addition to `documentDir`)
- `tauri-window.ts`: `isMaximized`, `onResized`, `isFocused`, `setTitle`, `destroy`, `onCloseRequested`, `setProgressBar` (Window API surface used by WindowControls.tsx, App.tsx, PerfHUD.tsx)
- `tauri-webview-window.ts`: `WebviewWindow` class (new shim, not in plan) — `WebviewWindow` used in App.tsx and PerfHUD.tsx
- `plugin-fs.ts`: `remove`, `exists`, `readDir` (in addition to plan's readFile/writeFile/writeTextFile)

## Preload output format fix

electron-vite 6.0.0-beta.1 with `"type": "module"` package produces `index.mjs` for preload by default. Added `lib.formats: ['cjs']` + `rollupOptions.output.entryFileNames: '[name].js'` to force CJS `.js` output — required because Electron looks for `preload/index.js` as specified in the BrowserWindow config and because sandboxed preloads need CommonJS require-style module.

## electron-vite version note

Plan floor was `^4.0.0` (stable). electron-vite 5.0.0 (latest stable) declares `peerDependencies: vite: "^5.0.0 || ^6.0.0 || ^7.0.0"` — incompatible with this project's Vite 8. Used `electron-vite@6.0.0-beta.1` instead, which declares `vite: "^6.0.0 || ^7.0.0 || ^8.0.0"`. The beta's config API is identical to the plan's sketch.
