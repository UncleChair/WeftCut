---
status: accepted
---
# 0031 — Application menu: `null` on Windows/Linux, explicit minimal menu on macOS

## Context
Every WeftCut keyboard shortcut is dispatched in the **renderer** by `useShortcuts`
(`src/renderer/shortcuts/`): a `window` keydown listener with capture/bubble phases,
editable-target and transient-widget awareness, and per-user rebinds persisted to
`keybindings.json`. The action catalogue (`shortcuts/defs.ts`) is the single source of
truth for which chords exist.

The main process **never calls `Menu.setApplicationMenu`**, so Electron installs its
**default application menu**. That menu registers accelerators (Ctrl/Cmd+R reload,
Ctrl+Shift+I / Cmd+Alt+I DevTools, Ctrl/Cmd+W close, Ctrl/Cmd+Q quit, F11 fullscreen,
and — on macOS — the whole App/Edit/Window/Help set). Those accelerators are resolved
by the browser process (on macOS via the AppKit main-menu responder chain) and preempt
the renderer's keydown listener for the matching chords. That is the root cause of
"shortcuts stop working in some states": the native default menu silently owns keys the
renderer expects to receive.

Constraints specific to this app:
- Ships on **Windows (nsis), Linux (AppImage/deb), and macOS (dmg)** — see ADR 0024.
- Windows are **frameless** (`frame: false`); the titlebar and menu bar are drawn by the
  renderer (`AppMenuBar` + Base UI `Menu`/`MenuItem`). A native menu bar therefore does
  **not render at all** on Windows/Linux.
- The action set collides with default-menu accelerators: `Mod+W` (closeProject),
  `Mod+C`/`Mod+V` (copySelected/pasteAtPlayhead, deliberately `fireWhenEditing: false` so
  native clipboard serves text inputs), `Mod+Z`/`Mod+Shift+Z` (undo/redo).
- `hardenWindow` already intercepts Chromium's page-zoom accelerators via
  `webContents.on('before-input-event')` — an existing precedent for consuming keys in main.

Two community fixes were considered:
1. Install an **explicit** menu and set `registerAccelerator: false` per item on
   Windows/Linux (macOS handled separately).
2. `Menu.setApplicationMenu(null)` and let the renderer own everything (the VS Code route).

Key realization: the two options **converge on macOS** — macOS needs a real native menu
either way (an App menu for Quit/Hide and an Edit menu whose *accelerators* are what make
Cmd+C/V work natively inside text inputs; `registerAccelerator: false` is ignored on
macOS). They differ only on Windows/Linux, and because the window is frameless there, a
native menu is invisible — so option 1's "menu stays discoverable" benefit does not exist,
leaving only the per-item `registerAccelerator: false` maintenance cost. Option 2 is
strictly simpler on Windows/Linux and matches the renderer-drawn-menu architecture.

## Decision
Adopt a **per-platform hybrid**: option 2 on Windows/Linux, option-1-style explicit menu on
macOS. Land it in two stages.

**Stage 1 — Windows/Linux (this pass):**
- Call `Menu.setApplicationMenu(null)` at `app.whenReady`, **platform-guarded**:
  `if (process.platform !== 'darwin')`. The guard is load-bearing — an unconditional call
  would also destroy macOS's default Edit menu and break Cmd+C/V inside the app's own text
  inputs. macOS keeps its default menu untouched in this stage.
- The renderer's `useShortcuts` keeps ownership of every app shortcut; nothing changes there.
- Developer affordances (reload / toggle DevTools / fullscreen) move into the existing
  `before-input-event` handler in `hardenWindow`, gated on `isDev`. No native menu is
  installed in dev or prod, so dev and prod share one code path.

**Stage 2 — macOS (designed here, deferred):**
- Install an **explicit minimal** native menu: an App menu (About/Hide/Quit as roles), an
  Edit menu (cut/copy/paste/selectAll as roles), and a Window menu. File/View/Insert/
  Export/Tools do **not** enter the native menu — they remain renderer-only top-bar menus,
  and their app actions carry **no** native accelerators (renderer keeps ownership + rebind).
- The four keys that conflict with app actions — **Cmd+Z, Cmd+Shift+Z, Cmd+C, Cmd+V** — are
  **display-only** in the Edit menu (no `accelerator`), so the renderer owns them. Because a
  macOS menu accelerator would preempt the renderer for the same chord, the renderer
  implements the input-focused fallback itself (native clipboard via `navigator.clipboard`/
  `execCommand`, text undo) when focus is in a text field, while the timeline keeps the
  project-level action. Note `role: 'undo'` is DOM/text undo (`webContents.undo()`), never
  the project history, so undo/redo can never be a plain role here.
- **Cmd+W** maps to the renderer's `closeProject`; the Window menu does not bind Cmd+W.
- Before implementing, run an Electron 42 macOS probe to confirm whether an Edit menu with
  **roles but no accelerators** still lets Cmd+C/V act natively in text inputs; record the
  verdict in `docs/notes/electron-chromium-behavior.md`, and let it decide whether the
  renderer clipboard fallback is strictly required.

## Consequences
- **+** Windows/Linux: the default menu no longer intercepts keys; the renderer's
  `useShortcuts` + rebindable `keybindings.json` becomes the single, uncontested owner of
  every shortcut. Matches the frameless, renderer-drawn-menu architecture.
- **+** Dev/prod parity on Windows/Linux — one code path, no native menu, dev keys via the
  existing `before-input-event` seam.
- **−** Losing the default menu drops its incidental accelerators on Windows/Linux
  (e.g. Ctrl+Q quit); anything still wanted must be reprovided via `before-input-event` or
  the renderer. Page-zoom keys were already handled; dev reload/DevTools/fullscreen are.
- **−/staged** macOS keeps the default menu until Stage 2, so the original "shortcuts
  unavailable in some states" symptom persists on macOS in the interim — an accepted,
  time-boxed gap given Windows/Linux is the current first-class target.
- Rejected — **`registerAccelerator: false` everywhere (option 1):** on frameless
  Windows/Linux the native menu never renders, so it buys nothing over `null` while adding
  per-item accelerator bookkeeping; and it is ignored on macOS anyway.
- Rejected — **`setApplicationMenu(null)` everywhere (pure option 2):** destroys the macOS
  Edit menu and breaks Cmd+C/V in the app's text inputs.
