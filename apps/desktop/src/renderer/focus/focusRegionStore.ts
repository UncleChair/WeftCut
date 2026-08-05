// Which focus region owns the keyboard. DERIVED from DOM focus by
// `useFocusRegions` — feature code reads it and never writes it.
//
// The value is the region of the last `focusin`, and it deliberately does NOT
// reset on `focusout`: a control that blurs to `<body>` (a menu closing, an
// element unmounting, alt-tab away and back) leaves the last-touched panel in
// charge, which is what every NLE's panel highlight shows. `null` is reserved
// for focus genuinely leaving every panel — app chrome, a dock tab, a dialog,
// the startup screen — because that is the case the scope gate must catch.
//
// React subscribers must use the ATOMIC selector hook below (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { create } from "zustand";
import type { PanelKind } from "../workspace/panelRegistry";

interface State {
  region: PanelKind | null;
}

export const useFocusRegionStore = create<State>(() => ({ region: null }));

export function setActiveRegion(region: PanelKind | null): void {
  if (useFocusRegionStore.getState().region !== region) {
    useFocusRegionStore.setState({ region });
  }
}

/// Imperative read for event-time callers — the shortcut dispatcher's scope
/// gate runs inside a `keydown` listener and must not subscribe.
export function activeRegion(): PanelKind | null {
  return useFocusRegionStore.getState().region;
}

export const useActiveRegion = (): PanelKind | null =>
  useFocusRegionStore((s) => s.region);
