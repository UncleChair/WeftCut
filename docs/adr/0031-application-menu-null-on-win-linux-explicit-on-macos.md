---
status: accepted
---
# 0031 — Application menu: `null` on Windows/Linux, explicit minimal menu on macOS

> **Revised 2026-07-30 by the probe this ADR asked for.** Stage 1 (Windows/Linux) stands
> as written and is implemented. The macOS half changed: the probe overturned this ADR's
> premise that macOS menu accelerators preempt the renderer, so **Stage 2 was redesigned**
> — see "Probe verdicts" and the rewritten Stage 2 below. Verdict details live in
> `docs/notes/electron-chromium-behavior.md`; the implementation plan lives in
> `.scratch/macos-native-menu/`.
>
> **Stage 2 implemented 2026-07-30** as revised (`src/main/appMenu.ts`,
> `src/shared/menu.ts`, `src/renderer/menu/nativeMenu.ts`, gated by
> `e2e/electron/menu.spec.ts`). The open decisions below are settled — see
> "Stage 2 as built".

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

**Stage 2 — macOS (superseded as designed; see "Probe verdicts" and "Stage 2, revised"):**
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

## Probe verdicts (2026-07-30, Electron 42.4.1 / macOS)
The Stage 2 probe ran. Full matrix in `docs/notes/electron-chromium-behavior.md`; three
results correct this ADR's text above.

1. **The premise is false.** macOS menu accelerators do **not** preempt the renderer. The
   renderer's keydown listener fires in every menu configuration, *and* a renderer
   `preventDefault()` suppresses the matching menu role — verified on `role: 'copy'`
   (4/4 alternating) and on the destructive `role: 'close'` (Cmd+W left the window open).
   The renderer is upstream; the menu is downstream.
2. **"Roles but no accelerators" does not work** — the literal question this ADR deferred.
   `accelerator: ''` kills the role's native behavior, and `registerAccelerator: false` is
   ignored on macOS (the accelerator still fires). A role item is all-or-nothing.
3. **`setApplicationMenu(null)` does not break Cmd+C/V** on Electron 42 (contradicting the
   second "Rejected" bullet below): with no menu at all, a text input still copies natively.
   A menu that *exists without* a copy role is what breaks it. Treat this asymmetry as an
   implementation detail, not a contract — it is not a reason to ship macOS menu-less.

Because of (1), the renderer needs no clipboard/undo reimplementation and no display-only
menu items: it already `preventDefault()`s the chords it consumes, and `fireWhenEditing:
false` actions already stand down inside text inputs — which is exactly when the native role
should serve. Installing a real menu is therefore **additive** to the existing dispatcher.

## Stage 2, revised — divide by ownership, don't duplicate
The native menu is not a second copy of `AppMenuBar`; it is the **OS-integration surface**,
and the in-app bar stays the **application command surface**. Note the in-app bar is the more
available of the two on macOS: `.app-header` renders in fullscreen, where the system hides
the native menu bar behind a hover reveal. Fullscreen is therefore **not** an argument for
moving commands into the native menu.

- **Native menu** — `appMenu` / `editMenu` / `windowMenu` roles verbatim (About, Services,
  Hide, Quit, the clipboard items, Substitutions/Speech, Minimize, Zoom, Bring All to Front),
  plus the few items Mac convention demands: a File projection, View → Enter Full Screen
  (`role: 'togglefullscreen'`), and **Settings under `Cmd+,`** (the `appMenu` role has no
  Settings slot; today Settings hides in the in-app File menu, where no Mac user looks).
  Build View **by hand** — `role: 'viewMenu'` re-adds Reload and DevTools.
- **In-app `AppMenuBar`** — Insert, View (workspace profiles), timeline actions, Help, Dev
  stay renderer-only and stay primary. Identical on all three platforms and in fullscreen.
- **Overlap is expected**: File/Edit/View appear in both. The native one is a thin projection
  whose items dispatch the *same* actions over IPC.
- **Generate, never hand-write a second list.** Labels and accelerators come from the
  `shortcuts/defs.ts` catalogue so the two surfaces cannot drift.
- **Keep the native menu small, for one concrete reason:** the in-app items derive `disabled`
  from live state (`busy`, `canUndo`, `canRedo`, `canBlade`, `exportLocked`), while a native
  `MenuItem` is a main-process object — every one of those transitions would have to be
  pushed over IPC and re-applied. That sync cost, not the labels, is what full parity buys.

Replacing the default menu is also a **safety** fix independent of any of the above:
Electron's default menu ships `Cmd+R` / `Shift+Cmd+R` reload and `Alt+Cmd+I` DevTools **in
production**, and a renderer reload discards unsaved in-memory timeline state.

Open decision left to implementation: whether `Cmd+W` keeps the Mac convention (close the
window) or maps to the renderer's `closeProject` ("save and close"). Per verdict (1) either
is now reachable; it is a product call, not a technical constraint.

## Stage 2 as built (2026-07-30)
The shape above shipped unchanged. Four decisions it left open, and how they landed:

- **`Cmd+W` maps to `closeProject`**, and the native menu has **no Close Window item** at
  all. Not really a coin-flip once verdict (1) is taken seriously: the renderer already
  binds `Mod+W` to `closeProject` on every platform and `preventDefault()`s it, so a native
  `role: 'close'` would sit in File and do nothing whenever the editor is mounted. The
  single-window app still closes from the red traffic light.
- **Settings is a real catalogue action** (`openSettings`, `Mod+Comma`) rather than an
  accelerator hard-typed into the menu — so it is rebindable, listed in Settings →
  Keyboard, and identical on Windows/Linux, where the in-app File → Settings entry (which
  **stays**, on all platforms) now renders the same chord as its hint.
- **Dev reload/DevTools stay out of the menu**, in `hardenWindow`'s `before-input-event`
  seam, matching Stage 1. Dev and prod ship the same menu on every platform.
- **`undo` / `redo` joined the `fireWhenEditing: false` set.** The design says a
  renderer action stands down inside a text field so the native role can serve — but only
  copy/paste actually carried that flag, so `Cmd+Z` in a text input consumed the chord,
  suppressed both the Edit menu's `role: 'undo'` and Chromium's own editor undo, and
  reverted a *project* edit while the user watched an unchanged text box. Standing down
  fixes text undo on every platform; project undo is unchanged everywhere else.
- **Labels and accelerators are pushed by the renderer**, not read by main. Main cannot
  resolve an i18n key (no i18next) and would otherwise duplicate the defaults ⊕
  `keybindings.json` resolution the renderer already does; so the renderer sends a
  `MenuProjection` (`src/shared/menu.ts`) on mount, on locale switch, and on rebind, and
  main owns only the structure. A consequence worth knowing: the projection describes what
  the CURRENT surface can run, so items are **omitted** rather than disabled — the startup
  screen shows Settings and no File menu. That is what keeps the "no live-state IPC"
  constraint above honest.

Electron's role labels (Edit, Window, Minimize…) stay English whatever the app locale is;
only our own titles and items translate. Accepted — it is Electron's behaviour, not a
choice this menu can make.

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
  **Corrected by the probe:** the symptom on macOS is narrower than assumed — the renderer
  does receive every chord. What the default menu actually costs is that unconsumed chords
  reach a *wrong* handler (Cmd+W closes the window, Cmd+Z runs DOM undo) and that Reload +
  DevTools ship to end users. The gap is a safety and correctness one, not a dead-keys one.
  **Closed 2026-07-30** — Stage 2 shipped; `e2e/electron/menu.spec.ts` keeps it closed.
- **−** The native menu now depends on a renderer that has mounted: between `app.whenReady`
  and the first `menu:sync` it is roles only (no File, no Settings), and a renderer that
  never paints leaves it that way. Acceptable because everything safety-critical — the
  absence of reload/DevTools, the App/Edit/Window roles — is in the boot menu already;
  only the app's own commands wait.
- Rejected — **`registerAccelerator: false` everywhere (option 1):** on frameless
  Windows/Linux the native menu never renders, so it buys nothing over `null` while adding
  per-item accelerator bookkeeping; and it is ignored on macOS anyway.
  (Probe confirms the macOS half: `registerAccelerator: false` on a role item still fires
  the accelerator.)
- Rejected — **`setApplicationMenu(null)` everywhere (pure option 2):** destroys the macOS
  Edit menu and breaks Cmd+C/V in the app's text inputs.
  **This rationale is false on Electron 42** — with no menu at all, a text input still
  copies natively. The conclusion survives on other grounds: macOS wants a real menu for
  platform conventions (App/Edit/Window, `Cmd+,`), and going menu-less would rely on the
  fragile asymmetry recorded in the notes file.
