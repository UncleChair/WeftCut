import type { HandlerMap } from "../shortcuts";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import { followPlayheadEnabled, markersVisible } from "../settings/appSettingsStore";
import { hasMarkedRange } from "../state/rangeStore";
import { hasTransitionCut } from "../timeline/applyTransition";
import { useProjectStore } from "../state/projectStore";
import { useSelectionStore } from "../state/selectionStore";
import { activeTool } from "../state/toolStore";
import { layerOverlapClass } from "../timeline/geometry";
import {
  evaluateTimelinePlacements,
  SPAWN_TRACK_ID,
  type TimelinePlacement,
} from "../timeline/placement";
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
  // Checkpoint CREATE only. Restore and Delete are per-row actions with no
  // command form: a palette entry would have to name one of N checkpoints, and
  // the registry has no parameterized-command shape (`CommandDef.run` takes
  // nothing). The History Panel's section is their home.
  //
  // No keyboard binding either — `Mod+Z` / `Mod+Shift+Z` are the history keys
  // and stay untouched; a checkpoint is a deliberate, named act, not a reflex.
  "createCheckpoint",
  // Raise-to-top. No binding on purpose — the key budget belongs to
  // higher-frequency operations, and z-order rearrangement is not one
  // (ADR 0042).
  "moveToNewTrack",
  // Marker display. No binding on purpose: `M` went to `addMarkerAtPlayhead`
  // (ACTION_DEFS) — the reservation this entry once held open, now spent — and
  // the toggle itself is not a reflex. Being a no-binding command is also what
  // makes the Quick Actions button resolvable and puts the toggle in the search
  // palette for free. Marker rename/delete have no command form for the
  // createCheckpoint reason above: they are per-row actions, and the registry
  // has no parameterized-command shape. The marker context menu is their home.
  "toggleMarkersVisible",
  // Crossfade at the cut nearest the playhead (`transitionTargetCut`). The
  // registry's no-arguments shape is exactly the Premiere "apply default
  // transition" contract — the target comes from state, not a parameter. No
  // binding on purpose (the key budget rule above); discoverability rides the
  // strip button, the palette, and the Transitions panel instead.
  "applyDefaultTransition",
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
  createCheckpoint: "actions.create_checkpoint",
  moveToNewTrack: "actions.move_to_new_track",
  toggleMarkersVisible: "actions.toggle_markers_visible",
  applyDefaultTransition: "actions.apply_default_transition",
};

/// "Move to a new track" is offered only when one fresh lane could actually hold
/// the whole selection, so the impossible request is prevented rather than
/// refused afterwards.
///
/// Both stores are read LIVE, for the reason `clearRange` reads `rangeStore`:
/// App does not subscribe to `selectedLayerIds` (a multi-select change would
/// re-render the whole tree), so a flag captured at App render time would freeze
/// the moment the user clicked a clip.
///
/// The overlap question is `evaluateTimelinePlacements`' own: projecting every
/// selected layer onto `SPAWN_TRACK_ID` asks exactly "could one empty lane take
/// them all", and `"collision"` is its answer for no.
function canMoveSelectionToNewTrack(): boolean {
  const selected = useSelectionStore.getState().selectedLayerIds;
  if (selected.size === 0) return false;
  const tracks = useProjectStore.getState().summary?.tracks ?? [];
  const placements: TimelinePlacement[] = [];
  for (const track of tracks) {
    for (const layer of track.layers) {
      if (!selected.has(layer.id)) continue;
      placements.push({
        layerId: layer.id,
        trackId: SPAWN_TRACK_ID,
        tStartUs: layer.t_start_us,
        tEndUs: layer.t_end_us,
        overlapClass: layerOverlapClass(layer),
        // Lock is not this predicate's question, and `"locked"` OUTRANKS
        // `"collision"` in the verdict — feeding one in would let a locked clip
        // mask the self-overlap this exists to catch. A locked source lane is
        // the actor's refusal (`TrackLocked`).
        locked: false,
      });
    }
  }
  // A selection the summary no longer holds: nothing to place.
  if (placements.length === 0) return false;
  return (
    evaluateTimelinePlacements({
      tracks,
      placements,
      replacedLayerIds: selected,
    }).validity !== "collision"
  );
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
    // Same live-read reason as `clearRange` below the flags: App does not
    // re-render on an app-settings flip, so a captured flag would freeze.
    toggleFollowPlayhead: () => followPlayheadEnabled(),
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

  // Menu-only ids get gates too — same shape as `enabledFor` above, keyed on the
  // other half of the id namespace.
  const menuEnabledFor: Partial<Record<MenuOnlyCommandId, () => boolean>> = {
    moveToNewTrack: canMoveSelectionToNewTrack,
    // Live-read for the same reason as `clearRange`: whether an eligible cut
    // exists changes with every edit, and App renders on none of them.
    applyDefaultTransition: hasTransitionCut,
  };

  // …and check state, same shape and same rule as `checkedFor` above: a
  // no-binding command can be a toggle just as easily as a binding-backed one.
  const menuCheckedFor: Partial<Record<MenuOnlyCommandId, () => boolean>> = {
    toggleMarkersVisible: () => markersVisible(),
  };

  for (const id of MENU_ONLY_COMMAND_IDS) {
    const enabled = menuEnabledFor[id];
    const checked = menuCheckedFor[id];
    defs.push({
      id,
      labelKey: MENU_ONLY_LABEL_KEYS[id],
      ...(enabled ? { enabled } : {}),
      ...(checked ? { checked } : {}),
      run: menu[id],
    });
  }
  return defs;
}
