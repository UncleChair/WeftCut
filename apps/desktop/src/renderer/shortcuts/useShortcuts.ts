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

/// Mounts a `window` keydown listener that dispatches to the handlers
/// passed in. Handler identities are read through a ref each event so
/// React's render churn doesn't force the listener to reattach.
///
/// **Multiple instances are supported** as long as their handler maps
/// are disjoint (no two instances both define `handlers[id]` for the
/// same `id`). In v1 the App-level call covers global actions; the
/// Timeline call covers `groupSelected` + `dissolveSelectedGroup`
/// (group ops need `selectedLayerIds`, which is Timeline-local).
/// Each instance's dispatcher short-circuits on the first matched
/// entry; entries without a handler don't preventDefault, so the
/// other instance's matching handler can still fire.
///
/// Dispatch rules:
/// - Always `preventDefault` + `stopPropagation` on a matched event.
/// - Skip `e.repeat === true` unless the action declared `repeatable`.
/// - When focus is inside an editable element, fire only if the action
///   declared `fireWhenEditing` (auto-derived: chord = yes, bare = no).
///
/// Two phases:
/// - `captureGlobal` actions dispatch in the **capture** phase (on `window`,
///   so they run before any focused control's own keydown). This is how
///   Space → togglePlay wins over a Base UI menubar trigger that still holds
///   focus after a click. They additionally yield when focus is inside an open
///   transient widget (menu / listbox / dialog), where the key is the
///   widget's.
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

    function dispatch(e: KeyboardEvent, candidates: ResolvedEntry[]): void {
      if (disabledRef.current) return;
      // Color-pick session = modal: the overlay owns the keyboard (Esc/S); every
      // app shortcut — including captureGlobal ones registered before the
      // overlay's listener — must stay dead until the session settles.
      if (usePickSessionStore.getState().session) return;
      const editing = isEditableTarget(e.target);
      const inWidget = isInTransientWidget(e.target);
      for (const entry of candidates) {
        if (e.repeat && !entry.repeatable) continue;
        if (!matchEvent(entry.parsed, e)) continue;
        // Yield to the focused context: text editors (unless the action opts
        // into firing while editing) and open transient widgets that own the
        // key. Returning without `preventDefault` lets the widget handle it.
        if (editing && !entry.fireWhenEditing) return;
        if (entry.captureGlobal && inWidget) return;
        const fn = handlersRef.current[entry.id];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        runWithLogging(entry.id, fn);
        return;
      }
    }

    const onKeyCapture = (e: KeyboardEvent) => dispatch(e, captureEntries);
    const onKey = (e: KeyboardEvent) => dispatch(e, bubbleEntries);
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKeyCapture, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [entries]);
}

/// Wrap a shortcut handler so its result lands in the activity log.
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
function runWithLogging(actionId: ActionId, fn: () => void | Promise<void>) {
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
