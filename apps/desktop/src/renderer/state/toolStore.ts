// Timeline tool selection — which modal tool arms the timeline's layer
// clicks. Session state, deliberately NOT persisted: a project always reopens
// on the Selection tool, matching every NLE.
//
// A module-level store rather than App state because the Quick Actions Panel
// is a Dock Panel: it must read the active tool without sitting on App's
// props chain, and routing the tool through `dockPanelContracts` would rebuild
// that memo — and re-render every open Panel — on each tool switch.
//
// React subscribers must use the ATOMIC selector hook below (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { create } from "zustand";

/// The modal tools. `select` is the default: layer clicks select and drag.
/// `blade` arms the razor — clicks split the layer at the click point.
///
/// Adding a tool is additive: extend this union, give it an `ActionId` + key
/// in `ACTION_DEFS`, and add a row to the Quick Actions tool section.
export type Tool = "select" | "blade";

interface State {
  tool: Tool;
}

export const useToolStore = create<State>(() => ({ tool: "select" }));

/**
 * Arm `tool`. IDEMPOTENT by design — one tool one key, so `setTool('blade')`
 * twice leaves you in blade mode.
 *
 * LANDMINE: do not "helpfully" reintroduce a toggle here. A toggle only reads
 * as sensible while exactly two tools exist; from a third tool it has no
 * defined return target (blade → ? → hand), which is precisely why every NLE
 * binds one key per tool instead.
 */
export function setTool(tool: Tool): void {
  if (useToolStore.getState().tool !== tool) useToolStore.setState({ tool });
}

/// Imperative read for event-time callers (shortcut handlers) that must not
/// subscribe.
export function activeTool(): Tool {
  return useToolStore.getState().tool;
}

export const useActiveTool = (): Tool => useToolStore((s) => s.tool);
