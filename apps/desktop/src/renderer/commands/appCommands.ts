import type { HandlerMap } from "../shortcuts";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import type { CommandDef } from "./registry";

/// App-level command catalog for the palette: derived from the shortcut
/// HandlerMap (so new shortcut actions appear automatically) plus the
/// three menu-only actions that have no binding. Pure factory — App calls
/// it inside useCommandProvider's getter, so flags are read fresh on
/// every listCommands().
export interface AppCommandFlags {
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canBlade: boolean;
  exportLocked: boolean;
}

/// Menu entries with no catalogue action of their own. An action that HAS a
/// binding must not be listed here — it already arrives through the HandlerMap
/// above, and adding it doubles it in the palette.
export interface MenuCommandDeps {
  addColorLayer: () => void | Promise<void>;
  addTextLayer: () => void | Promise<void>;
  openMotifPicker: () => void;
  openAgentPanel: () => void;
  enterAgentMode: () => void | Promise<void>;
}

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
  };

  const defs: CommandDef[] = [];
  for (const id of Object.keys(handlers) as ActionId[]) {
    // The palette shouldn't list "open the palette" inside itself.
    if (id === "openSearchPalette") continue;
    const run = handlers[id];
    if (!run) continue;
    const enabled = enabledFor[id];
    defs.push({
      id,
      actionId: id,
      labelKey: ACTION_DEFS[id].labelKey,
      ...(enabled ? { enabled } : {}),
      run,
    });
  }

  defs.push(
    { id: "addColorLayer", labelKey: "actions.add_color_layer", run: menu.addColorLayer },
    { id: "addTextLayer", labelKey: "actions.add_text_layer", run: menu.addTextLayer },
    { id: "openMotifPicker", labelKey: "actions.motifs", run: menu.openMotifPicker },
    { id: "openAgentPanel", labelKey: "actions.open_agent_panel", run: menu.openAgentPanel },
    { id: "enterAgentMode", labelKey: "actions.enter_agent_mode", run: menu.enterAgentMode },
  );
  return defs;
}
