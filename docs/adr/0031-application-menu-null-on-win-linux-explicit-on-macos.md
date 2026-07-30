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

An app that calls no `Menu.setApplicationMenu` gets Electron's **default** menu, which
binds Ctrl/Cmd+R reload, Ctrl+Shift+I / Alt+Cmd+I DevTools, Ctrl/Cmd+W close, Ctrl/Cmd+Q
quit, F11 fullscreen, and on macOS the whole App/Edit/Window set. That is a safety problem
before it is anything else: reload and DevTools ship **to end users**, and a renderer
reload discards unsaved in-memory timeline state. It is also a correctness problem —
Cmd+W closes the window where the app's own action is `closeProject`, and Cmd+Z runs
`webContents.undo()` (DOM text undo), never the project history.

Constraints specific to this app:
- Ships on **Windows (nsis), Linux (AppImage/deb), and macOS (dmg)** — see ADR 0024.
- Windows/Linux windows are **frameless** (`frame: false`); the titlebar and menu bar are
  drawn by the renderer (`AppMenuBar` + Base UI `Menu`/`MenuItem`). A native menu bar
  therefore does **not render at all** there.
- macOS cannot opt out the same way: the menu bar belongs to the system, and
  `role: 'appMenu'` has no Settings slot, so `Cmd+,` needs a custom item.
- The action set collides with default-menu accelerators: `Mod+W` (closeProject),
  `Mod+C`/`Mod+V` (copySelected/pasteAtPlayhead), `Mod+Z`/`Mod+Shift+Z` (undo/redo).
- `hardenWindow` already intercepts Chromium's page-zoom accelerators via
  `webContents.on('before-input-event')` — an existing precedent for consuming keys in main.

Measured on Electron 42, full matrix in `docs/notes/electron-chromium-behavior.md`:

1. **The renderer is upstream of the menu on macOS.** It receives every chord in every menu
   configuration, and its `preventDefault()` suppresses the matching menu item — role items
   and custom `click` items alike. A menu with real accelerators can therefore coexist with
   renderer ownership; no display-only items, no renderer reimplementation of clipboard or
   text undo.
2. **A role item is all-or-nothing.** `accelerator: ''` kills the role's native behaviour and
   `registerAccelerator: false` is ignored on macOS. Include a role whole, or omit it.
3. **`role: 'viewMenu'` re-adds Reload and DevTools**, so View has to be built by hand.

## Decision
A **per-platform hybrid**: no application menu on Windows/Linux, an explicit minimal one on
macOS.

**Windows/Linux** — `Menu.setApplicationMenu(null)` at `app.whenReady`, platform-guarded by
`shouldClearApplicationMenu` (`src/main/inputPolicy.ts`). The renderer's `useShortcuts` keeps
uncontested ownership of every shortcut. Developer affordances (reload / toggle DevTools /
fullscreen) live in the `before-input-event` handler in `hardenWindow`, gated on `isDev`, so
dev and prod share one code path.

**macOS** — an explicit menu (`src/main/appMenu.ts`), divided from the in-app bar by
**ownership, not duplication**:

- **Native menu = the OS-integration surface.** `appMenu` / `editMenu` / `windowMenu` roles
  verbatim, plus what Mac convention demands: a File projection, View → Enter Full Screen,
  and Settings at `Cmd+,`. The App menu is hand-assembled from individual roles so Settings
  gets its slot; View is hand-built because of measurement (3).
- **In-app `AppMenuBar` = the application command surface, and the primary one.** Insert,
  View (workspace profiles), timeline actions, Help and Dev stay renderer-only, identical on
  all three platforms. It is also the more *available* surface on macOS: `.app-header`
  renders in fullscreen, where the system hides the native bar behind a hover reveal — so
  fullscreen is not an argument for moving commands into the native menu.
- **Overlap in File is expected**; the native items dispatch the same renderer actions over
  IPC (`menu:action` → the handler map `useShortcuts` uses).
- **Generated, never a second hand-written list.** The renderer resolves each action's label
  (i18next) and effective accelerator (catalogue defaults ⊕ `keybindings.json`) and pushes a
  `MenuProjection` (`src/shared/menu.ts`) on mount, on locale switch and on rebind; main owns
  only the structure. Main cannot resolve an i18n key and would otherwise duplicate the
  rebind resolution the renderer already performs.
- **Small on purpose.** In-app items derive `disabled` from live state (`busy`, `canUndo`,
  `canRedo`, `canBlade`, `exportLocked`); a native `MenuItem` is a main-process object, so
  every such transition would need an IPC push. That sync cost — not the labels — is what
  full parity would buy. Instead the projection carries what the *current* surface can run,
  and an action it cannot run is **omitted** rather than disabled (the startup screen offers
  Settings and no File menu).
- **`Cmd+W` maps to `closeProject`** ("Save and Close"), and there is no native Close Window
  item. The renderer already binds `Mod+W` on every platform and consumes it, so a
  `role: 'close'` would sit in File and do nothing whenever the editor is mounted; the
  single-window app still closes from the red traffic light.
- **Settings is a catalogue action** (`openSettings`, `Mod+Comma`), not an accelerator typed
  into the menu — rebindable, listed under Settings → Keyboard, and the same chord on
  Windows/Linux, where the in-app File → Settings entry (which stays, on all platforms)
  renders it as a hint.

Because of measurement (1), the menu is **additive** to the dispatcher rather than a rival to
it. What makes that division work is `fireWhenEditing: false`: an action carrying it stands
down inside a text field, which is exactly when the native role should serve. Copy/paste and
**undo/redo** carry it, so `Cmd+C`/`Cmd+V`/`Cmd+Z` edit the text field the user is typing in
and the project everywhere else.

## Consequences
- **+** The renderer's `useShortcuts` + rebindable `keybindings.json` is the single owner of
  every app shortcut on every platform; no menu silently intercepts a chord.
- **+** No shipped build exposes reload or DevTools through a menu, and no chord reaches a
  wrong handler. `e2e/electron/menu.spec.ts` is the gate.
- **+** Dev/prod parity: one code path per platform, dev keys via `before-input-event`.
- **−** Losing the default menu drops its incidental accelerators on Windows/Linux (e.g.
  Ctrl+Q quit); anything still wanted must be reprovided via `before-input-event` or the
  renderer. Page-zoom keys and dev reload/DevTools/fullscreen already are.
- **−** The macOS menu depends on a renderer that has mounted: between `app.whenReady` and
  the first projection it is roles only — no File, no Settings — and a renderer that never
  paints leaves it that way. Acceptable because everything safety-critical (the absence of
  reload/DevTools, the App/Edit/Window roles) is in the boot menu already; only the app's own
  commands wait.
- **−** Electron's role labels (Edit, Window, Minimize…) stay English whatever the app locale
  is; only our own titles and items translate. That is Electron's behaviour, not a choice
  this menu can make.
- **−** Renderer ownership of the shared chords cannot be gated automatically:
  `webContents.sendInputEvent` injects past AppKit, so an injected-key test passes whatever
  the menu does. It stays a manual check, written down in
  `docs/notes/electron-chromium-behavior.md`.
- Rejected — **`registerAccelerator: false` everywhere:** on frameless Windows/Linux the
  native menu never renders, so it buys nothing over `null` while adding per-item accelerator
  bookkeeping; and measurement (2) says macOS ignores it.
- Rejected — **`setApplicationMenu(null)` everywhere:** macOS wants a real menu for platform
  conventions (App/Edit/Window, `Cmd+,`, text-field undo). Going menu-less there would also
  rely on the asymmetry recorded in the notes file, where *no* menu leaves Cmd+C working but
  a menu *without* a copy role breaks it — an implementation detail, not a contract.
