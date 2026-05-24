// Static defaults — the source of truth for which shortcuts exist.
//
// Each `ActionId` maps to one or more chord strings parsed by `match.ts`
// and a label key reused from the menu's i18n namespace. New shortcuts
// are added by extending the `ActionId` union and `ACTION_DEFS`, then
// wiring the handler in `App.tsx`'s `useShortcuts({...})` call.
//
// Notes on the optional fields:
// - `fireWhenEditing`: by default, chord bindings (any of Ctrl/Meta/Alt)
//   fire while an `<input>` / `<textarea>` / `contentEditable` is
//   focused; bare-key bindings (Delete, Space, plain letters) don't.
//   Override here if a specific binding needs the opposite — none of v1
//   does, so the field stays absent everywhere below.
// - `repeatable`: key-repeat events (`e.repeat === true`) are dropped by
//   default. Set `true` for bindings the user wants to hold (Undo /
//   Redo) — every other v1 binding is a one-shot toggle or save.

export type ActionId =
  | "save"
  | "saveAs"
  | "closeProject"
  | "undo"
  | "redo"
  | "togglePlay"
  | "deleteSelected"
  | "importMedia"
  | "export"
  | "toggleBladeMode"
  | "toggleLog"
  | "focusLogSearch"
  | "toggleDisplayMode"
  | "toggleMediaPool"
  | "groupSelected"
  | "dissolveSelectedGroup"
  | "seekFrameBack"
  | "seekFrameForward"
  | "seekSecondBack"
  | "seekSecondForward"
  | "seekStart"
  | "seekEnd";

export interface ActionDef {
  defaultKeys: string[];
  labelKey: string;
  fireWhenEditing?: boolean;
  repeatable?: boolean;
}

export const ACTION_DEFS: Record<ActionId, ActionDef> = {
  save:            { defaultKeys: ["Mod+S"],               labelKey: "actions.save" },
  saveAs:          { defaultKeys: ["Mod+Shift+S"],         labelKey: "actions.save_as" },
  closeProject:    { defaultKeys: ["Mod+W"],               labelKey: "actions.save_and_close" },
  undo:            { defaultKeys: ["Mod+Z"],               labelKey: "actions.undo", repeatable: true },
  redo:            { defaultKeys: ["Mod+Shift+Z"],         labelKey: "actions.redo", repeatable: true },
  togglePlay:      { defaultKeys: ["Space"],               labelKey: "actions.toggle_play" },
  deleteSelected:  { defaultKeys: ["Delete", "Backspace"], labelKey: "actions.delete_selected" },
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
  // `docs/ab-roll-redesign` R.8: bare-letter `T` flips the app-level
  // display_mode (AB ↔ Show All). Rebindable through Settings →
  // Keyboard. Bare-letter chords don't fire in text inputs by default.
  toggleDisplayMode: { defaultKeys: ["T"],                 labelKey: "actions.toggle_display_mode" },
  // `docs/ab-roll-redesign` R.9: bare-letter `M` toggles the MediaPool
  // left drawer (closed/open). The app-pref store remembers state.
  toggleMediaPool:   { defaultKeys: ["M"],                 labelKey: "actions.toggle_media_pool" },
  // `docs/group-system.md` — Ctrl/Cmd+G groups the current multi-
  // selection; Ctrl/Cmd+Shift+G dissolves every group represented in
  // the selection. Handler lives in Timeline.tsx (needs `selectedLayerIds`
  // which is Timeline-local). Surfaced here so the Keyboard Shortcuts
  // panel shows them and the user can rebind.
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
};

export const ACTION_IDS = Object.keys(ACTION_DEFS) as ActionId[];
