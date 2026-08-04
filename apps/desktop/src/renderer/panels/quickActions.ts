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

import {
  ArrowRightFromLine,
  ArrowRightToLine,
  MousePointer2,
  Rows3,
  Scissors,
  X,
  type LucideIcon,
} from "lucide-react";

import type { DisplayMode } from "../ipc";
import type { Tool } from "../state/toolStore";

/// The store-derived inputs every `active`/`hint` predicate reads. Snapshotted
/// once at the top of the panel component so the per-item predicates stay pure
/// functions — hooks can't be called per row.
export interface QuickActionState {
  tool: Tool;
  displayMode: DisplayMode;
  /// Whether any in/out point is marked (`rangeStore.ts`). Not a position —
  /// the strip can't render one, and subscribing to the positions would
  /// re-render the whole strip on every handle drag.
  hasRange: boolean;
}

export interface QuickActionItem {
  /// Command id in `commands/registry.ts`. Resolved through `getCommand` for
  /// `run` / `enabled` / `labelKey`.
  id: string;
  icon: LucideIcon;
  /// Whether the button renders pressed. For a radio section exactly one item
  /// should be true; for an independent section each item answers for itself.
  /// Omitted by `command` items, which have no pressed state at all.
  active?: (state: QuickActionState) => boolean;
  /// State-bearing tooltip / aria-label key, for buttons whose meaning depends
  /// on the current value ("showing X, click for Y"). Omit to use the
  /// command's own `labelKey`.
  hint?: (state: QuickActionState) => string;
}

export interface QuickActionSection {
  id: string;
  /// How the section's buttons report state to assistive tech, which is the
  /// whole reason the split exists:
  /// - `radio` = modal, mutually exclusive (the exclusivity comes from the
  ///   underlying state, not from this panel) → `aria-checked` in a radiogroup.
  /// - `independent` = each button answers only for itself → `aria-pressed`.
  /// - `command` = momentary; fires and forgets → NEITHER attribute.
  ///
  /// `command` is not cosmetic. A one-shot action carrying `aria-pressed=false`
  /// is narrated as an off switch, which promises a state it does not have —
  /// so these items also omit `active` rather than hard-coding it false.
  mode: "radio" | "independent" | "command";
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
  {
    // In/out marking. The strip is where this feature becomes discoverable at
    // all: the buttons carry their `I` / `O` accelerator in the tooltip, so the
    // one-click path teaches the keyboard path. It cannot show WHERE the points
    // are — that is the ruler's job — but the clear button's enabled state is a
    // standing, zero-cost signal that a range exists at all.
    id: "range",
    mode: "command",
    items: [
      // Direction carries the meaning: content STARTS at this line (arrow
      // leaving it) vs. content ENDS at it (arrow arriving).
      { id: "markIn", icon: ArrowRightFromLine },
      { id: "markOut", icon: ArrowRightToLine },
      {
        id: "clearRange",
        icon: X,
        // The command is disabled with no range marked, and a disabled button
        // with an unchanged tooltip reads as broken — so the hint explains the
        // reason instead of restating the label.
        hint: (s) =>
          s.hasRange ? "actions.clear_range" : "quick_actions.clear_range_empty",
      },
    ],
  },
];

/// Flat id list — used by the alignment test and by anything that needs to
/// know whether a command has a strip button.
export const QUICK_ACTION_IDS: readonly string[] = QUICK_ACTION_SECTIONS.flatMap(
  (section) => section.items.map((item) => item.id),
);
