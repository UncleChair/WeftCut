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
  | "focusNextPanel"
  | "focusPreviousPanel"
  | "toggleMaximizePanel"
  | "restoreMaximizedPanel"
  | "openTabsOverflowMenu"
  | "groupSelected"
  | "dissolveSelectedGroup"
  | "nudgeAudioSampleBack"
  | "nudgeAudioSampleForward"
  | "nudgeAudioMsBack"
  | "nudgeAudioMsForward"
  | "resyncAudioToVideo"
  | "seekFrameBack"
  | "seekFrameForward"
  | "seekSecondBack"
  | "seekSecondForward"
  | "seekPrevEdit"
  | "seekNextEdit"
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
  /// Key-repeat events (`e.repeat === true`) re-fire the handler only
  /// when true; otherwise repeats are consumed without firing — letting
  /// one through would re-arm the focused control's native Space
  /// activation. Set for bindings the user holds down (undo/redo,
  /// arrow seeks).
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
  // Opens the active dock group's hidden-tabs dropdown (the chevron at the
  // tab strip's right end) for keyboard navigation — arrows move, Enter
  // activates. No-op when nothing overflows.
  openTabsOverflowMenu: {
    defaultKeys: ["Ctrl+Alt+O"],
    labelKey: "actions.open_tabs_overflow_menu",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  // `docs/features.md#groups` — Ctrl/Cmd+G groups the current multi-
  // selection; Ctrl/Cmd+Shift+G dissolves every group represented in
  // the selection. Handler lives in Timeline.tsx, while the complete
  // selection itself is renderer-global. Surfaced here so the Keyboard
  // Shortcuts panel shows them and the user can rebind.
  groupSelected:          { defaultKeys: ["Mod+G"],        labelKey: "actions.group_selected" },
  dissolveSelectedGroup:  { defaultKeys: ["Mod+Shift+G"],  labelKey: "actions.dissolve_selected_group" },
  // Sub-frame audio slip (ADR 0038). Two tiers because ONE SAMPLE is 0.042 px at the
  // 2000 px/s zoom ceiling — sample precision is unreachable by dragging, so keys and
  // numbers are the entry points, and a single-sample step alone would be unusable
  // for a real ~ms sync fix. Alt+Arrow is free (bare arrows are the playhead seek).
  // Repeatable so holding the key walks; each press steps by an INDEX, so 10 000
  // presses out and back land on the original sample exactly.
  nudgeAudioSampleBack:    { defaultKeys: ["Alt+ArrowLeft"],        labelKey: "actions.nudge_audio_sample_back",    repeatable: true },
  nudgeAudioSampleForward: { defaultKeys: ["Alt+ArrowRight"],       labelKey: "actions.nudge_audio_sample_forward", repeatable: true },
  nudgeAudioMsBack:        { defaultKeys: ["Alt+Shift+ArrowLeft"],  labelKey: "actions.nudge_audio_ms_back",        repeatable: true },
  nudgeAudioMsForward:     { defaultKeys: ["Alt+Shift+ArrowRight"], labelKey: "actions.nudge_audio_ms_forward",     repeatable: true },
  // Zero the derived sync offset — the companion to the nudges, since the offset is
  // geometry with no field to reset.
  resyncAudioToVideo:      { defaultKeys: ["Alt+Shift+S"],          labelKey: "actions.resync_audio_to_video" },
  // Playhead movement — composition-frame grid. Repeatable so holding
  // the arrow steps continuously.
  seekFrameBack:     { defaultKeys: ["ArrowLeft"],         labelKey: "actions.seek_frame_back",     repeatable: true },
  seekFrameForward:  { defaultKeys: ["ArrowRight"],        labelKey: "actions.seek_frame_forward",  repeatable: true },
  seekSecondBack:    { defaultKeys: ["Shift+ArrowLeft"],   labelKey: "actions.seek_second_back",    repeatable: true },
  seekSecondForward: { defaultKeys: ["Shift+ArrowRight"],  labelKey: "actions.seek_second_forward", repeatable: true },
  // Edit-point navigation (Premiere-style ↑/↓): parks the playhead ON the
  // cut, which displays the incoming clip's first frame; one ← from there
  // shows the outgoing clip's last frame. See docs/data-model.md (boundary
  // semantics).
  seekPrevEdit:      { defaultKeys: ["ArrowUp"],           labelKey: "actions.seek_prev_edit",      repeatable: true },
  seekNextEdit:      { defaultKeys: ["ArrowDown"],         labelKey: "actions.seek_next_edit",      repeatable: true },
  seekStart:         { defaultKeys: ["Home"],              labelKey: "actions.seek_start" },
  seekEnd:           { defaultKeys: ["End"],               labelKey: "actions.seek_end" },
  // Global search palette. A chord, so it fires while a text input is
  // focused (default chord behavior) — expected for a Spotlight-style UI.
  openSearchPalette: { defaultKeys: ["Mod+K"], labelKey: "actions.open_search" },
};

export const ACTION_IDS = Object.keys(ACTION_DEFS) as ActionId[];
