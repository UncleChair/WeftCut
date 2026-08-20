import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { getCommand, type CommandDef } from "../commands/registry";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import { resolveAccelerator } from "../shortcuts/match";
import { useDisplayMode, useMarkersVisible } from "../settings/appSettingsStore";
import { useActiveTool } from "../state/toolStore";
import { useHasMarkedRange } from "../state/rangeStore";
import { useHasTransitionCut } from "../timeline/applyTransition";
import {
  QUICK_ACTION_SECTIONS,
  resolveIcon,
  type QuickActionItem,
  type QuickActionSection,
  type QuickActionState,
} from "./quickActions";

/// Which way the strip runs. Single row or single column, never wrapped —
/// overflow scrolls instead.
export type StripOrientation = "horizontal" | "vertical";

/** The panel's own geometry source — structurally a Dockview `PanelApi`, but
 *  narrowed to what the strip reads so tests can hand in a plain object. */
export interface StripGeometry {
  readonly width: number;
  readonly height: number;
  onDidDimensionsChange(
    listener: (event: { readonly width: number; readonly height: number }) => void,
  ): { dispose(): void };
}

/** Below this |width − height| the axis is left alone. Resizing through square
 *  would otherwise flip the strip back and forth every frame. */
const ORIENTATION_DEADBAND = 24;

function decideOrientation(
  width: number,
  height: number,
  previous: StripOrientation | null,
): StripOrientation {
  if (previous !== null && Math.abs(width - height) <= ORIENTATION_DEADBAND) {
    return previous;
  }
  return height > width ? "vertical" : "horizontal";
}

/**
 * The strip's axis: whichever way it is docked, or — for a strip with no dock
 * position to read (`docked` null: floating, popped out) — whichever way its own
 * box is longer.
 *
 * `docked` leads because the way the bar runs and the edge it can be pinned
 * along have to be the same axis, and only the dock position carries that. A
 * bar beside the Timeline gets a wide, short cell whose one free edge is
 * vertical: read it as a row and the buttons run across an axis that cannot be
 * pinned.
 *
 * The geometry subscription is deliberately NOT hoisted into
 * `DockPanelRuntimeContract`: that context is shared by every Panel, so live
 * dimensions in it would re-render all of them on every splitter drag. Both the
 * strip body and its grip tab call this against the same `api`, so they observe
 * one event stream and stay in step.
 */
export function useStripOrientation(
  geometry: StripGeometry,
  docked: StripOrientation | null,
): StripOrientation {
  const [orientation, setOrientation] = useState<StripOrientation>(() =>
    decideOrientation(geometry.width, geometry.height, null),
  );
  useEffect(() => {
    setOrientation((previous) =>
      decideOrientation(geometry.width, geometry.height, previous),
    );
    const disposable = geometry.onDidDimensionsChange((event) => {
      setOrientation((previous) =>
        decideOrientation(event.width, event.height, previous),
      );
    });
    return () => disposable.dispose();
  }, [geometry]);
  return docked ?? orientation;
}

/** Chromium maps the wheel to horizontal scrolling only under `Shift`, which
 *  nobody knows — a horizontal strip would look like it had jammed. */
function useHorizontalWheel(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || event.shiftKey) return;
      const before = element.scrollLeft;
      element.scrollLeft += event.deltaY;
      // Only claim the gesture if it was actually consumed; at either end the
      // wheel should keep bubbling to whatever scrolls outside the strip.
      if (element.scrollLeft !== before) event.preventDefault();
    };
    // Not passive: the handler calls preventDefault when it scrolls.
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}

/**
 * Roving tabindex, the ARIA toolbar pattern: one Tab stop for the whole strip,
 * arrows move between buttons. Without it, crossing a strip of N buttons would
 * cost N Tab presses.
 */
function useRovingFocus(
  ref: RefObject<HTMLElement | null>,
  orientation: StripOrientation,
) {
  const [focusIndex, setFocusIndex] = useState(0);
  // The strip's own axis leads; the cross-axis arrows are accepted too so the
  // keys never feel dead after the strip flips.
  const back =
    orientation === "vertical" ? ["ArrowUp", "ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
  const forward =
    orientation === "vertical"
      ? ["ArrowDown", "ArrowRight"]
      : ["ArrowRight", "ArrowDown"];

  const onKeyDown = (event: React.KeyboardEvent) => {
    const container = ref.current;
    if (!container) return;
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[data-quick-action]"),
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    const from = current < 0 ? focusIndex : current;
    let target: number | null = null;
    if (back.includes(event.key)) target = from - 1;
    else if (forward.includes(event.key)) target = from + 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = buttons.length - 1;
    if (target === null) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(buttons.length - 1, target));
    setFocusIndex(clamped);
    buttons[clamped]?.focus();
    // Optional call: jsdom doesn't implement scrollIntoView.
    buttons[clamped]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  return { focusIndex, setFocusIndex, onKeyDown };
}

interface QuickActionButtonProps {
  item: QuickActionItem;
  command: CommandDef;
  state: QuickActionState;
  /// The owning section's mode, which picks the ARIA state attribute below.
  /// See `QuickActionSection.mode` in quickActions.ts.
  mode: QuickActionSection["mode"];
  tabbable: boolean;
  onFocus: () => void;
}

function QuickActionButton({
  item,
  command,
  state,
  mode,
  tabbable,
  onFocus,
}: QuickActionButtonProps) {
  const { t } = useTranslation();
  const binding = useEffectiveBindings(command.actionId);
  const accelerator = binding ? resolveAccelerator(binding) : "";
  // `command` items carry no `active` predicate; they never render pressed.
  const active = item.active?.(state) ?? false;
  const disabled = command.enabled?.() === false;
  // A state-bearing hint where the item has one (the display-mode button needs
  // "showing X, click for Y"); otherwise the command's own label.
  const label = t(item.hint ? item.hint(state) : command.labelKey);
  // Same override shape as the hint: a state-bearing glyph where the item
  // declares one, its static icon otherwise.
  const Icon = resolveIcon(item, state);
  return (
    <button
      type="button"
      data-quick-action={item.id}
      className="weft-quick-action"
      data-active={active ? "true" : "false"}
      disabled={disabled}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      {...(mode === "radio"
        ? { role: "radio", "aria-checked": active }
        : mode === "independent"
          ? { "aria-pressed": active }
          : {})}
      aria-label={label}
      title={accelerator ? `${label} (${accelerator})` : label}
      onClick={() => void command.run()}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

/**
 * The Quick Actions strip — a single row or single column of icon buttons for
 * the commands worth one click, split into three sections: modal tools,
 * independent toggles, and momentary in/out commands.
 *
 * Layout invariant: NEVER wraps. Whatever doesn't fit scrolls, with the ends
 * fading to advertise that there is more.
 */
export function QuickActionsPanel({
  geometry,
  docked = null,
}: {
  geometry: StripGeometry;
  /** The axis the Dock Tree dictates. Omitted or null for a strip with no dock
   *  position to read, which falls back to its own shape — see
   *  `useStripOrientation`. */
  docked?: StripOrientation | null;
}) {
  const { t } = useTranslation();
  const tool = useActiveTool();
  const displayMode = useDisplayMode();
  // Subscribed, not read imperatively: `clearRange`'s `enabled` predicate is
  // evaluated during THIS render, so without a subscription the button would
  // stay greyed out until some unrelated state happened to re-render the strip.
  // The boolean selector means marking or dragging in/out re-renders the strip
  // only when the range appears or disappears, not on every position change.
  const hasRange = useHasMarkedRange();
  const markersVisible = useMarkersVisible();
  // Same subscribed-not-imperative reasoning as `hasRange` directly above,
  // for `applyDefaultTransition`'s enabled state.
  const hasTransitionCut = useHasTransitionCut();
  const orientation = useStripOrientation(geometry, docked);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useHorizontalWheel(scrollRef, orientation === "horizontal");
  const { focusIndex, setFocusIndex, onKeyDown } = useRovingFocus(
    scrollRef,
    orientation,
  );

  const state: QuickActionState = {
    tool,
    displayMode,
    hasRange,
    markersVisible,
    hasTransitionCut,
  };

  // Buttons resolve against the command registry, so a command whose provider
  // hasn't mounted yet is simply absent rather than a dead button.
  const sections = QUICK_ACTION_SECTIONS.map((section) => ({
    ...section,
    resolved: section.items
      .map((item) => ({ item, command: getCommand(item.id) }))
      .filter(
        (entry): entry is { item: QuickActionItem; command: CommandDef } =>
          entry.command !== undefined,
      ),
  })).filter((section) => section.resolved.length > 0);

  let index = -1;
  return (
    <div
      ref={scrollRef}
      className="weft-quick-actions"
      data-orientation={orientation}
      role="toolbar"
      aria-orientation={orientation}
      aria-label={t("dock_workspace.panels.quick-actions")}
      onKeyDown={onKeyDown}
    >
      {sections.map((section) => (
        <div
          key={section.id}
          className="weft-quick-actions-section"
          // Every section is a labelled landmark so a screen reader walking the
          // toolbar hears which family it has entered; only the modal one is a
          // `radiogroup`, because only there does "exactly one is chosen" hold.
          role={section.mode === "radio" ? "radiogroup" : "group"}
          aria-label={t(`quick_actions.${section.id}`)}
        >
          {section.resolved.map(({ item, command }) => {
            index += 1;
            const own = index;
            return (
              <QuickActionButton
                key={item.id}
                item={item}
                command={command}
                state={state}
                mode={section.mode}
                tabbable={own === focusIndex}
                onFocus={() => setFocusIndex(own)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
