import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ACTION_DEFS, type ActionId } from "./defs";
import {
  isChord,
  isEditableTarget,
  matchEvent,
  parseBinding,
  type ParsedBinding,
} from "./match";
import { logEmit } from "../ipc";
import { usePickSessionStore } from "../colorpick/pickColor";

export type Handler = () => void | Promise<void>;
export type HandlerMap = Partial<Record<ActionId, Handler>>;
export type OverrideMap = Partial<Record<ActionId, string[]>>;

interface ResolvedEntry {
  id: ActionId;
  parsed: ParsedBinding;
  fireWhenEditing: boolean;
  repeatable: boolean;
  captureGlobal: boolean;
  suppressInTransientWidget: boolean;
}

function resolveEntries(overrides: OverrideMap): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    const def = ACTION_DEFS[id];
    const keys = overrides[id] ?? def.defaultKeys;
    for (const k of keys) {
      try {
        const parsed = parseBinding(k);
        const chord = isChord(parsed);
        out.push({
          id,
          parsed,
          // Default: chords fire while editing, bare keys don't. The
          // per-action override (rare) wins when present.
          fireWhenEditing: def.fireWhenEditing ?? chord,
          repeatable: def.repeatable ?? false,
          captureGlobal: def.captureGlobal ?? false,
          suppressInTransientWidget: def.suppressInTransientWidget ?? false,
        });
      } catch (e) {
        console.warn(
          `shortcuts: ignoring invalid binding "${k}" for ${id}:`,
          e,
        );
      }
    }
  }
  return out;
}

interface UseShortcutsOptions {
  handlers: HandlerMap;
  /// Per-user remappings, loaded from the backend. Missing entries fall
  /// back to `ACTION_DEFS[id].defaultKeys`. Pass a stable identity
  /// (state / memoized) so the listener doesn't churn each render.
  overrides?: OverrideMap;
  /// Suspend the global dispatcher. The Keyboard Shortcuts panel sets
  /// this while a "press a key…" capture chip is active so the user's
  /// chord doesn't accidentally fire the bound action mid-rebind.
  disabled?: boolean;
}

const EMPTY_OVERRIDES: OverrideMap = {};

/// Roles of open, transient widgets that own keyboard input while they're up:
/// a key pressed inside one (Space to activate a menu item, arrows to walk a
/// listbox, Enter on a dialog button) belongs to the widget, not to a global
/// transport shortcut. Deliberately excludes `menubar` — a *collapsed* menubar
/// trigger merely holding focus is exactly what `captureGlobal` must override.
const TRANSIENT_WIDGET_SELECTOR =
  '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tree"],[role="grid"]';

function isInTransientWidget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(TRANSIENT_WIDGET_SELECTOR) !== null;
}

/// True while a modal renderer surface owns the keyboard and EVERY app action
/// must stay dead — today the color-pick session, whose overlay owns Esc/S.
///
/// Shared with the macOS native menu (`menu/nativeMenu.ts`) because the two
/// entry points fail differently: the dispatcher below stands down by returning
/// WITHOUT `preventDefault()`, which is exactly what lets an unconsumed chord
/// fall through to a native menu accelerator. Without this guard on both sides,
/// suspending the dispatcher would hand the action to the menu instead of
/// dropping it.
export function appActionsSuspended(): boolean {
  return usePickSessionStore.getState().session !== null;
}

/// Mounts a `window` keydown listener that dispatches to the handlers
/// passed in. Handler identities are read through a ref each event so
/// React's render churn doesn't force the listener to reattach.
///
/// **Multiple instances are supported** as long as their handler maps
/// are disjoint (no two instances both define `handlers[id]` for the
/// same `id`). In v1 the App-level call covers global actions; the
/// Timeline call covers `groupSelected` + `dissolveSelectedGroup`
/// (group ops are Timeline-scoped even though Layer selection is global).
/// Each instance's dispatcher short-circuits on the first matched
/// entry; entries without a handler don't preventDefault, so the
/// other instance's matching handler can still fire.
///
/// Dispatch rules: always `preventDefault` + `stopPropagation` on a matched
/// event; `repeatable` / `fireWhenEditing` semantics live on `ActionDef`.
/// A consumed keydown also consumes its paired keyup — down and up belong
/// to one consumer (Base UI's non-native controls activate on keyup).
///
/// Two phases:
/// - `captureGlobal` actions dispatch in the **capture** phase (on `window`,
///   so they run before any focused control's own keydown), yielding when
///   focus is inside an open transient widget
///   (`TRANSIENT_WIDGET_SELECTOR`).
/// - Every other action dispatches in the **bubble** phase, which keeps
///   deeper capture-phase listeners (e.g. KeyframeLane's selected-keyframe
///   Delete) ahead of the app-level handler.
export function useShortcuts({
  handlers,
  overrides = EMPTY_OVERRIDES,
  disabled,
}: UseShortcutsOptions): void {
  const handlersRef = useRef<HandlerMap>(handlers);
  const disabledRef = useRef<boolean>(!!disabled);

  useLayoutEffect(() => {
    handlersRef.current = handlers;
    disabledRef.current = !!disabled;
  }, [handlers, disabled]);

  const entries = useMemo(() => resolveEntries(overrides), [overrides]);

  useEffect(() => {
    const captureEntries = entries.filter((e) => e.captureGlobal);
    const bubbleEntries = entries.filter((e) => !e.captureGlobal);

    // Physical keys whose keydown this instance consumed. The paired keyup
    // must be consumed too: Base UI Switch/Checkbox render non-native
    // elements (nativeButton=false → <span role="switch">) that activate
    // from Base UI's own keyup handler WITHOUT checking whether the keydown
    // was prevented — a keyup that escapes toggles the focused control on
    // top of the action that consumed the press.
    const consumedCodes = new Set<string>();
    // `code` identifies the physical key across the down/up pair even if
    // modifiers change mid-hold; synthetic events (jsdom) may omit it.
    const codeOf = (e: KeyboardEvent) => e.code || `key:${e.key.toLowerCase()}`;

    function dispatch(e: KeyboardEvent, candidates: ResolvedEntry[]): void {
      if (disabledRef.current) return;
      // Color-pick session = modal: the overlay owns the keyboard (Esc/S); every
      // app shortcut — including captureGlobal ones registered before the
      // overlay's listener — must stay dead until the session settles.
      if (appActionsSuspended()) return;
      const editing = isEditableTarget(e.target);
      const inWidget = isInTransientWidget(e.target);
      for (const entry of candidates) {
        if (!matchEvent(entry.parsed, e)) continue;
        // Yield to the focused context: text editors (unless the action opts
        // into firing while editing) and open transient widgets that own the
        // key. Returning without `preventDefault` lets the widget handle it.
        if (editing && !entry.fireWhenEditing) return;
        if ((entry.captureGlobal || entry.suppressInTransientWidget) && inWidget) return;
        const fn = handlersRef.current[entry.id];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        consumedCodes.add(codeOf(e));
        // Auto-repeat of a non-repeatable action is consumed WITHOUT
        // re-firing. An unprevented repeat keydown would reach the focused
        // control and re-arm a native button's Space activation (:active,
        // then click on keyup) — toggling the control on top of the action
        // that consumed the first press.
        if (e.repeat && !entry.repeatable) return;
        runWithLogging(entry.id, fn);
        return;
      }
    }

    const onKeyCapture = (e: KeyboardEvent) => dispatch(e, captureEntries);
    const onKey = (e: KeyboardEvent) => dispatch(e, bubbleEntries);
    const onKeyUpCapture = (e: KeyboardEvent) => {
      if (consumedCodes.delete(codeOf(e))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Alt-Tab away mid-hold loses the keyup; a stale entry would silently
    // eat the next unrelated press of that key after refocus.
    const onWindowBlur = () => consumedCodes.clear();
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUpCapture, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyCapture, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUpCapture, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [entries]);
}

/// Run an action handler with its result in the activity log. Exported for the
/// macOS native menu (`menu/nativeMenu.ts`), which dispatches the same actions
/// through the same handler map — a menu-chosen Save must log exactly like the
/// Cmd+S that would otherwise have run it.
///
/// Three flavors of entry per dispatch:
///   * Synchronous handler → one `Info` entry on completion.
///   * Async handler resolving in < 250 ms → one `Info` entry on
///     completion. No "Started" — saves a row for the common case.
///   * Async handler still running at 250 ms → emit a `Started` entry
///     (shared `op_id`), then a final `Ok` / `Err` entry when it
///     resolves.
///
/// Errors always emit at `Error` level, regardless of timing.
export function runWithLogging(actionId: ActionId, fn: () => void | Promise<void>) {
  const labelKey = ACTION_DEFS[actionId].labelKey;
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    void logEmit({
      level: "error",
      category: { kind: "Shortcut" },
      source: { kind: "User" },
      message: `Shortcut ${actionId} failed: ${String(err)}`,
      i18n_key: "log.shortcut_failed",
      i18n_args: { actionId, label_key: labelKey, error: String(err) },
    });
    return;
  }
  if (!result || typeof (result as Promise<void>).then !== "function") {
    void logEmit({
      level: "info",
      category: { kind: "Shortcut" },
      source: { kind: "User" },
      message: `Shortcut: ${actionId}`,
      i18n_key: "log.shortcut_ok",
      i18n_args: { actionId, label_key: labelKey },
    });
    return;
  }
  // Async path: gate the Started entry on a 250 ms timer; if the
  // promise resolves first, the timer is cancelled and we emit a
  // single Ok entry. Either way the final Ok/Err shares `op_id` with
  // any prior Started so the console can collapse them.
  const opId = makeOpId();
  let resolved = false;
  const startedTimer = window.setTimeout(() => {
    if (resolved) return;
    void logEmit({
      level: "info",
      category: { kind: "Shortcut" },
      source: { kind: "User" },
      message: `Shortcut: ${actionId}`,
      op_id: opId,
      op_state: { state: "Started" },
      i18n_key: "log.shortcut_started",
      i18n_args: { actionId, label_key: labelKey },
    });
  }, 250);
  (result as Promise<void>).then(
    () => {
      resolved = true;
      window.clearTimeout(startedTimer);
      void logEmit({
        level: "info",
        category: { kind: "Shortcut" },
        source: { kind: "User" },
        message: `Shortcut: ${actionId}`,
        op_id: opId,
        op_state: { state: "Ok" },
        i18n_key: "log.shortcut_ok",
        i18n_args: { actionId, label_key: labelKey },
      });
    },
    (err) => {
      resolved = true;
      window.clearTimeout(startedTimer);
      void logEmit({
        level: "error",
        category: { kind: "Shortcut" },
        source: { kind: "User" },
        message: `Shortcut ${actionId} failed: ${String(err)}`,
        op_id: opId,
        op_state: { state: "Err" },
        i18n_key: "log.shortcut_failed",
        i18n_args: { actionId, label_key: labelKey, error: String(err) },
      });
    },
  );
}

/// RFC 4122 UUID. Required because the backend's `LogEntryInput.op_id`
/// deserializes as `Option<Uuid>`; a non-UUID string would fail
/// `log_emit` and silently lose the async-path Started/Ok entries.
/// Chromium/Electron ships `crypto.randomUUID`, so no polyfill is needed.
function makeOpId(): string {
  return crypto.randomUUID();
}
