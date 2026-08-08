import type { HandlerMap } from "../shortcuts";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import { hasMarkedRange } from "../state/rangeStore";
import { activeTool } from "../state/toolStore";
import type { CommandDef } from "./registry";

/// App-level command catalog for the palette: derived from the shortcut
/// HandlerMap (so new shortcut actions appear automatically) plus the
/// menu-only actions that have no binding. Pure factory — App calls
/// it inside useCommandProvider's getter, so flags are read fresh on
/// every listCommands().
export interface AppCommandFlags {
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canBlade: boolean;
  exportLocked: boolean;
}

/// Command ids with no catalogue action of their own. An action that HAS a
/// binding must not be listed here — it already arrives through the HandlerMap
/// above, and adding it doubles it in the palette. Exported as a value so
/// `menuSpec.ts` can type-lock its item ids to `ActionId | MenuOnlyCommandId`.
export const MENU_ONLY_COMMAND_IDS = [
  "addColorLayer",
  "addTextLayer",
  "openMotifPicker",
  "openAgentPanel",
  "enterAgentMode",
] as const;

export type MenuOnlyCommandId = (typeof MENU_ONLY_COMMAND_IDS)[number];

export type MenuCommandDeps = Record<
  MenuOnlyCommandId,
  () => void | Promise<void>
>;

const MENU_ONLY_LABEL_KEYS: Record<MenuOnlyCommandId, string> = {
  addColorLayer: "actions.add_color_layer",
  addTextLayer: "actions.add_text_layer",
  openMotifPicker: "actions.motifs",
  openAgentPanel: "actions.open_agent_panel",
  enterAgentMode: "actions.enter_agent_mode",
};

export function buildAppCommands(
  handlers: HandlerMap,
  menu: MenuCommandDeps,
  flags: AppCommandFlags,
): CommandDef[] {
  const enabledFor: Partial<Record<ActionId, () => boolean>> = {
    save: () => !flags.busy,
    saveAs: () => !flags.busy,
    closeProject: () => !flags.busy,
    undo: () => !flags.busy && flags.canUndo,
    redo: () => !flags.busy && flags.canRedo,
    importMedia: () => !flags.busy,
    export: () => !flags.exportLocked,
    toggleBladeMode: () => !flags.busy && flags.canBlade,
    // Read from the store rather than routed through `flags`, unlike every
    // entry above. A flag is a snapshot taken at App render time, and App
    // deliberately does NOT subscribe to `rangeStore` (marking in/out would
    // re-render the whole tree — see `toolStore.ts` for the same reasoning),
    // so the flag would go stale the moment the user pressed `I`. This
    // predicate is evaluated inside `listCommands()`, so it always reads live.
    clearRange: () => hasMarkedRange(),
  };

  // The armed modal tool, read straight from `toolStore` for the same
  // reason `clearRange` reads `rangeStore`: App doesn't subscribe to tool
  // switches, so a flag would freeze on the App render that captured it.
  const checkedFor: Partial<Record<ActionId, () => boolean>> = {
    selectTool: () => activeTool() === "select",
    toggleBladeMode: () => activeTool() === "blade",
  };

  const defs: CommandDef[] = [];
  for (const id of Object.keys(handlers) as ActionId[]) {
    // The palette shouldn't list "open the palette" inside itself.
    if (id === "openSearchPalette") continue;
    const run = handlers[id];
    if (!run) continue;
    const enabled = enabledFor[id];
    const checked = checkedFor[id];
    defs.push({
      id,
      actionId: id,
      labelKey: ACTION_DEFS[id].labelKey,
      ...(enabled ? { enabled } : {}),
      ...(checked ? { checked } : {}),
      run,
    });
  }

  for (const id of MENU_ONLY_COMMAND_IDS) {
    defs.push({ id, labelKey: MENU_ONLY_LABEL_KEYS[id], run: menu[id] });
  }
  return defs;
}
