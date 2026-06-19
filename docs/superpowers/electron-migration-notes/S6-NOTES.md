# S6 — Migration completion: acceptance notes

## T10 — cut-over complete (2026-06-19)

**Status: DONE.** The Tauri shell has been excised. The branch is now pure Electron.

Deleted:
- `src-tauri/src/sysmon.rs` (Tauri-gated PerfHUD sampler)
- `src-tauri/src/media_drop.rs` (Tauri-gated drag-drop path)
- `src-tauri/tauri.conf.json` (Tauri app manifest)
- `poc/electron-napi/` (proof-of-concept directory, all files)
- `@tauri-apps/api`, `@tauri-apps/plugin-{dialog,fs,notification,shell}` npm deps
- `@tauri-apps/cli` devDep; `tauri`/`tauri:dev`/`tauri:build` npm scripts
- `sysinfo` Cargo dep (only used in the deleted sysmon.rs)
- `media_drop`, `sysmon` feature definitions from Cargo.toml

Kept (load-bearing):
- `electron.vite.config.ts` `@tauri-apps/*` → `src/electron-compat/*` aliases
- All `src/electron-compat/*.ts` shim files
- All `src/**` renderer `@tauri-apps/*` imports (resolve via Vite aliases to shims)

Cut-over gate: all 4 checks PASS
- `napi:build` → Finished release profile, exit 0 (Tauri-free)
- `cargo test --lib --features jobs,export,mcp,cloud,motifs` → **588 passed**
- `VITE_WEFTCUT_E2E=1 electron:build` → exit 0, renderer built with shims
- `e2e:electron` → **28 passed** (all S1–S6 specs green, 3.1 min)

S6 exit criteria (spec §9): CI matrix (Tasks 1–9) + cut-over (Task 10). Cut-over is done locally; CI green on 3 OSes is the remaining gate before merge to main.

## T9 — manual verification (2026-06-19)

- **Export: PASS.** User ran the built Electron app (`npx electron out/main/index.js`),
  imported a video via the "Import media…" dialog, placed it, exported H.264, and
  the output wrote + played back. The full import → composite → encode → mux chain
  works in the real app. (The 10-bit export now streams over native IPC, not the
  loopback WebSocket — merged from `wt1`, see `docs/export-ipc-transport.md`.)
- **Drag-drop import: DEFERRED BUG** — see below.

## ROOT CAUSE FOUND: Windows drag-drop blocked by UIPI when Electron runs elevated

**Status:** ROOT CAUSE CONFIRMED 2026-06-19 — **NOT a code bug.** The drag-drop
code is correct; the OS was blocking the drag because the Electron process ran
**elevated (High integrity / "Run as administrator")** while Explorer runs at
Medium integrity. Windows **UIPI (User Interface Privilege Isolation)** silently
drops drag-drop messages from a lower-integrity source to a higher-integrity
target before they reach Blink. **Fix: launch from a non-elevated terminal.**
(The "Import media…" dialog was always a working alternate import path; on the
Tauri build the convenience path was `media_drop.rs` + WebView2
`postMessageWithAdditionalObjects`.)

### Symptom
Dragging a file from Explorer onto the media pool does nothing. During the drag
the cursor shows the **"no-drop / forbidden"** style, and **no drag events fire
in the renderer at all** — instrumented `dragenter`/`dragover`/`drop` at the
`window` level AND React's `onDrop` on `.media-pool` all stay silent. So the OS
drag is not reaching the web contents; this is NOT a path-resolution or import
bug (the import chain itself works — see below).

### Confirmed root cause (2026-06-19): UIPI / elevated process
Measured the live processes' integrity levels (token `TokenIntegrityLevel` SID):
- electron main process: `S-1-16-12288` = **HIGH (elevated / Administrator)**
- explorer.exe: `S-1-16-8192` = MEDIUM (normal user)

The dev terminal that ran `npx electron .` was elevated, so the Electron window
ran at High integrity. Windows UIPI blocks drag-drop from Medium-integrity
Explorer to the High-integrity window → forbidden cursor + zero drag events. Every
prior manual test was UIPI-blocked while the code was correct. Verified: launching
from a NON-elevated terminal makes drag-drop work end-to-end (probe shows
`dragenter`/`dragover`/`drop` firing with `types=["Files"]`, highlight appears,
import succeeds).

**Fix (dev):** run the dev app from a non-elevated terminal (`cd apps/desktop;
npx electron .`). If VS Code / Windows Terminal was opened "as administrator", its
integrated terminal inherits elevation — use a fresh normal shell.

**Product risk:** a shipped user who uses "Run as administrator" hits the same
break. Default install/launch is Medium (no `requireAdministrator` manifest), so
most users are unaffected. To survive an elevated launch, call
`ChangeWindowMessageFilterEx` on the window HWND to allow `WM_DROPFILES` (0x0233),
`WM_COPYDATA` (0x004A), and `WM_COPYGLOBALDATA` (0x0049) through UIPI.

### Previously ruled out (all correct — none was the cause; the cause was UIPI above)
- **`-webkit-app-region: drag` drag region** — disabling the preload's drag-region
  CSS injection entirely did NOT restore drops. (It's titlebar-scoped anyway:
  `app-header`/`agent-titlebar`/`startup-titlebar`, not the media pool.)
- **DevTools open** (electron/electron#3647) — closing DevTools did NOT help.
- **Frameless window** (`frame: false`) — setting `frame: true` did NOT help.

### Separately CONFIRMED + already handled: `webUtils.getPathForFile` across contextBridge
Independent of the above: on Electron 30+ (we're on 42), a `File` from a drop
event passed THROUGH the contextBridge to `webUtils.getPathForFile()` returns
`''` (the File loses its disk-backing across the isolated-world boundary —
electron/electron#44600). So resolving paths in the renderer's `onDrop` (via
`window.api.getPathForFile`) can never work. **Fix already in place:**
`electron/preload/index.ts` `wireFileDrop()` resolves paths in the preload's OWN
`window` drop listener (native-backed File) and forwards them via
`ipcRenderer.invoke('media:dropped', paths)`. This path is correct and will work
once the events-not-firing root cause is found. (The renderer's legacy `onDrop`
getPathForFile branch in `src/App.tsx` is dead and should be removed when this is
fixed / at any future `src/**` pass.)

### What DOES work (so the wiring downstream is proven)
- `media:dropped` (main) → `webContents.send('evt:media:external-drop', paths)`
  → the existing renderer listener (`App.tsx`) → `importPaths` → `importMedia`.
- Verified by `e2e/electron/s6-dragdrop.spec.ts` (drives `media:dropped` directly,
  asserts media count grows) — green in CI. Only the OS-drop → drag-event step is
  broken.

### Remaining cleanup (root cause is found — see above)
1. ~~Find why NO drag events reach the renderer~~ **DONE: UIPI / elevated launch**
   (see "Confirmed root cause" above). No code change needed for the dev fix —
   launch non-elevated. `wireFileDrop()` resolves + imports correctly once events
   fire (the #44600 fix is already there).
2. Delete the dead `onDrop` getPathForFile branch in `src/renderer/App.tsx`.
3. Optional (only if elevated launch must be supported): `ChangeWindowMessageFilterEx`
   on the window HWND to whitelist the drag-drop window messages past UIPI.
