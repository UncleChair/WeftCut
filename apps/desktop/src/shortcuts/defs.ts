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
  | "splitFirstLayer"
  | "toggleLog"
  | "focusLogSearch";

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
  splitFirstLayer: { defaultKeys: ["Mod+K"],               labelKey: "actions.split_first" },
  toggleLog:       { defaultKeys: ["Mod+`"],               labelKey: "actions.toggle_log" },
  focusLogSearch:  { defaultKeys: ["Mod+Shift+`"],         labelKey: "actions.focus_log_search" },
};

export const ACTION_IDS = Object.keys(ACTION_DEFS) as ActionId[];
