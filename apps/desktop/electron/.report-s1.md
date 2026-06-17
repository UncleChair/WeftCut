# S1 Electron Shell — Implementation Report

**Status: DONE_WITH_CONCERNS**

## Commit short-hashes

| Task | Hash | Message |
|---|---|---|
| S1.1 | `880235e3` | migrate(s1): electron-vite config + secured main window |
| S1.2 | `6e456b58` | migrate(s1): preload contextBridge window.api (stubbed) |
| S1.3 | `7ccced03` | migrate(s1): @tauri-apps/* compat shims over window.api |
| S1.4 reconcile | `e6242e1d` | migrate(s1): cover remaining @tauri-apps import surface |
| S1.4 acceptance | `457c6239` | migrate(s1): record boot acceptance + boot.png |

## Resolved package versions

| Package | Version |
|---|---|
| electron | 42.4.1 |
| electron-vite | 6.0.0-beta.1 |
| electron-builder | 26.15.3 |

**Note:** Plan floor was `electron-vite ^4.0.0` (latest stable 5.0.0). electron-vite 5.0.0 requires `vite ^5||^6||^7` — incompatible with this project's Vite 8.0.x. Used `6.0.0-beta.1` which adds `^8.0.0` to the peer dep range. Config API is identical to the plan's sketch.

## @tauri-apps import surface (full rg scan result)

```
@tauri-apps/api/core        -> src/electron-compat/tauri-core.ts
@tauri-apps/api/event       -> src/electron-compat/tauri-event.ts
@tauri-apps/api/path        -> src/electron-compat/tauri-path.ts
@tauri-apps/api/window      -> src/electron-compat/tauri-window.ts
@tauri-apps/api/webviewWindow -> src/electron-compat/tauri-webview-window.ts  [NOT in plan — added]
@tauri-apps/plugin-dialog   -> src/electron-compat/plugin-dialog.ts
@tauri-apps/plugin-fs       -> src/electron-compat/plugin-fs.ts
@tauri-apps/plugin-notification -> src/electron-compat/plugin-notification.ts
@tauri-apps/plugin-shell    -> src/electron-compat/plugin-shell.ts
```

### Named exports beyond plan defaults (all added during S1.4 reconciliation)

**tauri-core.ts**: Added `convertFileSrc` — imported by App.tsx, PixiPreview.tsx, runExport.ts. S1 stub returns path unchanged; S3 wires protocol.handle.

**tauri-path.ts**: Added `join`, `tempDir` — App.tsx uses `join`+`tempDir`, ExportSettingsDialog uses `documentDir`+`join`, StartupScreen uses `documentDir`, e2eHook uses `join`.

**tauri-window.ts** (largest addition): Added `isMaximized`, `onResized`, `isFocused`, `setTitle`, `destroy`, `onCloseRequested`, `setProgressBar` — WindowControls.tsx uses `isMaximized`+`onResized`; App.tsx uses `setProgressBar`+`isFocused`+`setTitle`+`destroy`; PerfHUD.tsx uses `onCloseRequested`+`destroy`.

**tauri-webview-window.ts** (new file — not in plan): App.tsx and PerfHUD.tsx import `WebviewWindow` class for spawning a secondary perf-HUD window. S1 stub is a no-op class.

**plugin-fs.ts**: Added `remove` (App.tsx), `exists` (e2eHook.ts), `readDir` (e2eHook.ts).

## Preload output format fix (integration reality)

electron-vite 6.0.0-beta.1 outputs preload as `.mjs` by default when the package has `"type": "module"`. The BrowserWindow `preload` config points to `../preload/index.js`. This mismatch caused a silent preload failure (`window.api` was never set), resulting in a black render.

Fix: added `lib.formats: ['cjs']` + `rollupOptions.output.entryFileNames: '[name].js'` to the preload build config. Preload now compiles to CJS (`require("electron")` style), outputs as `index.js`, and loads correctly.

## Bootstrap commands softened

**None were softened.** All S1 stub rejections are handled by the app's existing error paths:

- `recents_get_reopen_on_launch` → caught in Root's useEffect, falls back to "startup" stage
- `list_motifs` → caught in syncCatalog.ts, degrades to built-in-only catalog (warned to console)
- `recents_list` → caught in StartupScreen.refreshRecents, surfaces as the error banner in the UI (visible in boot.png — this is expected S1 behavior)
- `motif_register_runtime` → fire-and-forget `void invoke()` at main.tsx module scope, unhandled rejection logged but no render crash (app renders correctly)

## boot.png result

**RENDERED — UI fully visible.** Screenshot at `apps/desktop/electron/boot.png` (1570x924).

Content visible: WeftCut startup screen with "新建项目" / "打开项目" buttons, window chrome controls, locale-detected Chinese UI text, and the expected stub error banner for `recents_list`. No white screen. No module-resolution or render crash errors.

## Renderer console error summary

| Error | Type |
|---|---|
| `[stub] backend not wired in S1: motif_register_runtime` | Expected stub — unhandled void rejection, no crash |
| `[stub] backend not wired in S1: list_motifs` | Expected stub — caught, graceful degradation |
| `startup pref read failed: [stub] backend not wired in S1: recents_get_reopen_on_launch` | Expected stub — caught, fallback to startup |
| `[stub] backend not wired in S1: recents_list` | Expected stub — caught, shown as error banner in UI |
| Electron CSP warning | Dev-only advisory, not an app error |

No module-resolution errors. No component render crashes. All errors are the expected S1 stub rejections.

## Concerns

1. **electron-vite beta:** Using `6.0.0-beta.1` rather than a stable release. The stable `5.0.0` is incompatible with Vite 8. If the beta has regressions, S2 may need to either downgrade Vite or wait for electron-vite 6 stable. Alternative: use `"legacy-peer-deps"` with electron-vite 5 and accept the Vite 8 peer dep mismatch (it likely works at runtime since Vite 8 is mostly a minor API evolution from 7).

2. **`motif_register_runtime` unhandled rejection:** The `void invoke("motif_register_runtime", ...)` at main.tsx module scope is fire-and-forget with no `.catch()`. In S1 this creates an unhandled promise rejection in the renderer console. It doesn't crash but is noisy. Could be silenced with `.catch(() => {})` on the existing line — but the constraint says no src/** edits. This is cosmetic noise only.

3. **Preload CJS format:** The fix (CJS preload) works but means the preload can't use ESM-only APIs. This is standard for Electron preloads and no concern in practice.

4. **Security:** The CSP warning is expected in dev mode (Electron 42 warns about unsafe-eval from Vite's dev transforms). Disappears in production builds. Adding a CSP header is a S6/packaging concern.
