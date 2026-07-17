// Static defaults — the source of truth for which shortcuts exist.
//
// Each `ActionId` maps to one or more chord strings parsed by `match.ts`
// and a label key reused from the menu's i18n namespace. New shortcuts
// are added by extending the `ActionId` union and `ACTION_DEFS`, then
// wiring the handler in `App.tsx`'s `useShortcuts({...})` call.
// Optional-field semantics live on `ActionDef`'s fields below.

export type ActionId =
  | "save"
  | "saveAs"
  | "closeProject"
  | "undo"
  | "redo"
  | "togglePlay"
  | "deleteSelected"
  | "copySelected"
  | "pasteAtPlayhead"
  | "importMedia"
  | "export"
  | "toggleBladeMode"
  | "toggleLog"
  | "focusLogSearch"
  | "toggleDisplayMode"
  | "toggleMediaPool"
  | "focusNextPanel"
  | "focusPreviousPanel"
  | "toggleMaximizePanel"
  | "restoreMaximizedPanel"
  | "groupSelected"
  | "dissolveSelectedGroup"
  | "seekFrameBack"
  | "seekFrameForward"
  | "seekSecondBack"
  | "seekSecondForward"
  | "seekStart"
  | "seekEnd"
  | "openSearchPalette";

export interface ActionDef {
  defaultKeys: string[];
  labelKey: string;
  /// While an `<input>` / `<textarea>` / `contentEditable` is focused,
  /// chord bindings (Ctrl/Meta/Alt) fire by default and bare keys don't
  /// (derived at `resolveEntries`). Set only to force the opposite for
  /// one action — e.g. copy/paste stay native inside text fields.
  fireWhenEditing?: boolean;
  /// Key-repeat events (`e.repeat === true`) are dropped unless true.
  /// Set for bindings the user holds down (undo/redo, arrow seeks).
  repeatable?: boolean;
  /// Dispatch in the keydown CAPTURE phase so the binding wins over a
  /// focused chrome control that would otherwise consume the key
  /// (NLE-style transport). The dispatcher still yields to text editors
  /// and open transient widgets — see `useShortcuts`. Reserve for bare
  /// single keys that read as global app commands.
  captureGlobal?: boolean;
  /// Yield when focus is owned by an open menu, dialog, listbox, or other
  /// transient widget. Workspace navigation uses this even though its chord
  /// does not need capture-phase priority.
  suppressInTransientWidget?: boolean;
}

export const ACTION_DEFS: Record<ActionId, ActionDef> = {
  save:            { defaultKeys: ["Mod+S"],               labelKey: "actions.save" },
  saveAs:          { defaultKeys: ["Mod+Shift+S"],         labelKey: "actions.save_as" },
  closeProject:    { defaultKeys: ["Mod+W"],               labelKey: "actions.save_and_close" },
  undo:            { defaultKeys: ["Mod+Z"],               labelKey: "actions.undo", repeatable: true },
  redo:            { defaultKeys: ["Mod+Shift+Z"],         labelKey: "actions.redo", repeatable: true },
  // captureGlobal: Space must toggle playback even when focus is parked on a
  // menubar trigger / toolbar button after a click — a Base UI trigger would
  // otherwise treat Space as "open the menu".
  togglePlay:      { defaultKeys: ["Space"],               labelKey: "actions.toggle_play", captureGlobal: true },
  deleteSelected:  { defaultKeys: ["Delete", "Backspace"], labelKey: "actions.delete_selected" },
  // Clipboard actions belong to the timeline, not an active text editor. The
  // explicit false preserves native copy/paste inside inputs and text fields.
  copySelected:    { defaultKeys: ["Mod+C"],               labelKey: "actions.copy_selected", fireWhenEditing: false },
  pasteAtPlayhead: { defaultKeys: ["Mod+V"],               labelKey: "actions.paste_at_playhead", fireWhenEditing: false },
  importMedia:     { defaultKeys: ["Mod+I"],               labelKey: "actions.import_media" },
  export:          { defaultKeys: ["Mod+E"],               labelKey: "actions.export" },
  // Bare-letter `C` toggles blade-tool mode in the timeline. While
  // active, clicking a layer splits it at the click point (snapped to
  // the composition-frame grid) instead of selecting/dragging it.
  // Press `C` again or `Esc` to exit. Bare-letter chords don't fire
  // in text inputs by default.
  toggleBladeMode: { defaultKeys: ["C"],                   labelKey: "actions.toggle_blade_mode" },
  toggleLog:       { defaultKeys: ["Mod+`"],               labelKey: "actions.toggle_log" },
  focusLogSearch:  { defaultKeys: ["Mod+Shift+`"],         labelKey: "actions.focus_log_search" },
  // `docs/data-model.md` R.8: bare-letter `T` flips the app-level
  // display_mode (AB ↔ Show All). Rebindable through Settings →
  // Keyboard. Bare-letter chords don't fire in text inputs by default.
  toggleDisplayMode: { defaultKeys: ["T"],                 labelKey: "actions.toggle_display_mode" },
  // `docs/data-model.md` R.9: bare-letter `M` toggles the MediaPool
  // left drawer (closed/open). The app-pref store remembers state.
  toggleMediaPool:   { defaultKeys: ["M"],                 labelKey: "actions.toggle_media_pool" },
  focusNextPanel: {
    defaultKeys: ["Ctrl+Shift+Period"],
    labelKey: "actions.focus_next_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  focusPreviousPanel: {
    defaultKeys: ["Ctrl+Shift+Comma"],
    labelKey: "actions.focus_previous_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  toggleMaximizePanel: {
    defaultKeys: ["Backquote"],
    labelKey: "actions.toggle_maximize_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  restoreMaximizedPanel: {
    defaultKeys: ["Escape"],
    labelKey: "actions.restore_maximized_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  // `docs/groups.md` — Ctrl/Cmd+G groups the current multi-
  // selection; Ctrl/Cmd+Shift+G dissolves every group represented in
  // the selection. Handler lives in Timeline.tsx, while the complete
  // selection itself is renderer-global. Surfaced here so the Keyboard
  // Shortcuts panel shows them and the user can rebind.
  groupSelected:          { defaultKeys: ["Mod+G"],        labelKey: "actions.group_selected" },
  dissolveSelectedGroup:  { defaultKeys: ["Mod+Shift+G"],  labelKey: "actions.dissolve_selected_group" },
  // Playhead movement — composition-frame grid. Repeatable so holding
  // the arrow steps continuously.
  seekFrameBack:     { defaultKeys: ["ArrowLeft"],         labelKey: "actions.seek_frame_back",     repeatable: true },
  seekFrameForward:  { defaultKeys: ["ArrowRight"],        labelKey: "actions.seek_frame_forward",  repeatable: true },
  seekSecondBack:    { defaultKeys: ["Shift+ArrowLeft"],   labelKey: "actions.seek_second_back",    repeatable: true },
  seekSecondForward: { defaultKeys: ["Shift+ArrowRight"],  labelKey: "actions.seek_second_forward", repeatable: true },
  seekStart:         { defaultKeys: ["Home"],              labelKey: "actions.seek_start" },
  seekEnd:           { defaultKeys: ["End"],               labelKey: "actions.seek_end" },
  // Global search palette. A chord, so it fires while a text input is
  // focused (default chord behavior) — expected for a Spotlight-style UI.
  openSearchPalette: { defaultKeys: ["Mod+K"], labelKey: "actions.open_search" },
};

export const ACTION_IDS = Object.keys(ACTION_DEFS) as ActionId[];
