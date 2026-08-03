// The Quick Actions strip's authored catalogue: which commands appear, in
// what order, under which section, with which icon, and when each reads as
// armed.
//
// These four facts live HERE rather than on `CommandDef` because they are
// presentation, not contract: `commands/registry.ts` stays pure data with no
// React/lucide dependency, and the ~60 commands that never reach a button
// don't grow optional icon/section/order fields. The behavioural half
// (`run` / `enabled` / `labelKey`) is still resolved from the registry by id,
// so a button can never drift from the command the palette and menus invoke.
//
// LANDMINE: order here is authored and load-bearing. Do NOT switch to
// iterating `listCommands()` — that walks a `Set` of providers registered at
// component mount, so its order is a by-product of mount sequence.

import { MousePointer2, Rows3, Scissors, type LucideIcon } from "lucide-react";

import type { DisplayMode } from "../ipc";
import type { Tool } from "../state/toolStore";

/// The store-derived inputs every `active`/`hint` predicate reads. Snapshotted
/// once at the top of the panel component so the per-item predicates stay pure
/// functions — hooks can't be called per row.
export interface QuickActionState {
  tool: Tool;
  displayMode: DisplayMode;
}

export interface QuickActionItem {
  /// Command id in `commands/registry.ts`. Resolved through `getCommand` for
  /// `run` / `enabled` / `labelKey`.
  id: string;
  icon: LucideIcon;
  /// Whether the button renders pressed. For a radio section exactly one item
  /// should be true; for an independent section each item answers for itself.
  active: (state: QuickActionState) => boolean;
  /// State-bearing tooltip / aria-label key, for buttons whose meaning depends
  /// on the current value ("showing X, click for Y"). Omit to use the
  /// command's own `labelKey`.
  hint?: (state: QuickActionState) => string;
}

export interface QuickActionSection {
  id: string;
  /// `radio` = modal, mutually exclusive (the exclusivity comes from the
  /// underlying state, not from this panel). `independent` = each button
  /// answers only for itself.
  mode: "radio" | "independent";
  items: QuickActionItem[];
}

export const QUICK_ACTION_SECTIONS: readonly QuickActionSection[] = [
  {
    id: "tools",
    mode: "radio",
    items: [
      {
        id: "selectTool",
        icon: MousePointer2,
        active: (s) => s.tool === "select",
      },
      {
        // Historical id — it selects the Blade, it no longer toggles.
        id: "toggleBladeMode",
        icon: Scissors,
        active: (s) => s.tool === "blade",
      },
    ],
  },
  {
    id: "toggles",
    mode: "independent",
    items: [
      {
        id: "toggleDisplayMode",
        icon: Rows3,
        // Pressed = filtered down to the A/B-roll rows.
        active: (s) => s.displayMode === "AbRoll",
        // Reuses the retired inline pill's wording, which already separated
        // state from action ("Showing all tracks. Click to filter to A/B.").
        hint: (s) =>
          s.displayMode === "AbRoll"
            ? "timeline.mode_ab_hint"
            : "timeline.mode_all_hint",
      },
    ],
  },
];

/// Flat id list — used by the alignment test and by anything that needs to
/// know whether a command has a strip button.
export const QUICK_ACTION_IDS: readonly string[] = QUICK_ACTION_SECTIONS.flatMap(
  (section) => section.items.map((item) => item.id),
);
