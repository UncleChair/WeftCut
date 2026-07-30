// Contract for the macOS native application menu: what the renderer pushes to
// main so the native items and the in-app `AppMenuBar` cannot drift.
//
// The split — main owns the menu's structure, the renderer owns every label and
// accelerator in it. Why that direction: labels are i18n keys only i18next can
// resolve (the user switches locale in-app; main has no i18next), and the
// effective binding is catalogue defaults ⊕ `keybindings.json` overrides, which
// the renderer already resolves for its own menu hints. One resolver, both
// surfaces. Which items exist and where: src/main/appMenu.ts. Why the two
// surfaces divide the way they do: ADR 0031 Stage 2.
//
// Types + plain data only: main, preload and the renderer all import this, so
// it must stay free of DOM and Electron types.

/// Action ids the native menu may project. A subset of the renderer's
/// `ActionId` union, named here so main can reference actions without importing
/// renderer code (the renderer asserts the subset relation at compile time —
/// see src/renderer/menu/nativeMenu.ts).
///
/// Deliberately small. In-app menu items derive `disabled` from live state
/// (`busy`, `canUndo`, `canBlade`, `exportLocked`); a native MenuItem is a
/// main-process object, so every one of those transitions would have to be
/// pushed over IPC and re-applied. That sync cost — not the labels — is what
/// full parity would buy.
export const MENU_ACTION_IDS = [
  'importMedia',
  'save',
  'saveAs',
  'closeProject',
  'export',
  'openSettings',
] as const

export type MenuActionId = (typeof MENU_ACTION_IDS)[number]

/// i18n keys for the submenu titles main builds by hand. (Role menus — Edit,
/// Window — carry Electron's own English labels; only OUR titles are ours to
/// translate.)
export const MENU_LABEL_KEYS = ['menu.file', 'menu.view'] as const

export type MenuLabelKey = (typeof MENU_LABEL_KEYS)[number]

/// Fallback titles for the menu installed at `app.whenReady`, before the
/// renderer has painted anything to sync from. English on purpose: it sits
/// beside Electron's English role labels, and it is replaced by the localised
/// projection within the first second of the window's life.
export const DEFAULT_MENU_LABELS: Record<MenuLabelKey, string> = {
  'menu.file': 'File',
  'menu.view': 'View',
}

export interface MenuActionProjection {
  /// Resolved, localised label — `t(ACTION_DEFS[id].labelKey)`.
  label: string
  /// The action's EFFECTIVE bindings in catalogue notation ("Mod+Shift+S"), so
  /// a rebind shows through instead of a stale default. Only the first is
  /// rendered; `[]` means the user unbound the action, and the native item then
  /// carries no accelerator at all. Converted to Electron's notation in main
  /// (`toElectronAccelerator`), never here — main must stay defensive about
  /// what a renderer sends it.
  keys: string[]
}

/// What the renderer can run RIGHT NOW. Absent ids are omitted rather than
/// disabled: the startup screen offers Settings but has no project to save, and
/// an omitted item leaves no dead entry behind (nor any live-state IPC).
export interface MenuProjection {
  actions: Partial<Record<MenuActionId, MenuActionProjection>>
  labels: Partial<Record<MenuLabelKey, string>>
}
