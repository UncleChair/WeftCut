# S6 — Migration completion: acceptance notes

## T9 — manual verification (2026-06-19)

- **Export: PASS.** User ran the built Electron app (`npx electron out/main/index.js`),
  imported a video via the "Import media…" dialog, placed it, exported H.264, and
  the output wrote + played back. The full import → composite → encode → mux chain
  works in the real app. (The 10-bit export now streams over native IPC, not the
  loopback WebSocket — merged from `wt1`, see `docs/export-ipc-transport.md`.)
- **Drag-drop import: DEFERRED BUG** — see below.

## DEFERRED BUG: Windows drag-drop file import does not work

**Status:** open, deferred (decided 2026-06-19). NOT cut-over-blocking — the
"Import media…" dialog is a working import path. Drag-drop was the Tauri build's
convenience path (`media_drop.rs` + WebView2 `postMessageWithAdditionalObjects`);
on Electron it does not yet work on Windows.

### Symptom
Dragging a file from Explorer onto the media pool does nothing. During the drag
the cursor shows the **"no-drop / forbidden"** style, and **no drag events fire
in the renderer at all** — instrumented `dragenter`/`dragover`/`drop` at the
`window` level AND React's `onDrop` on `.media-pool` all stay silent. So the OS
drag is not reaching the web contents; this is NOT a path-resolution or import
bug (the import chain itself works — see below).

### Ruled out (each tested by building + a real manual drop on Windows 11)
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

### Next steps when picking this up
1. Find why NO drag events reach the renderer on this Windows + Electron 42 setup
   (not drag-region, not DevTools, not frameless). Candidates: build-run vs
   packaged-app difference; a minimal-repro Electron window to bisect window
   options (`sandbox`, `webSecurity`, the custom protocols); whether the OLE drop
   target is registered on the right HWND (Win32 `RegisterDragDrop`).
2. Once events fire, `wireFileDrop()` should resolve + import correctly (the
   #44600 fix is already there).
3. Then delete the dead `onDrop` getPathForFile branch in `src/App.tsx`.
