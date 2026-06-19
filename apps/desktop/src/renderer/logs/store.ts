import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";
import { LOG_EVENTS, logList, type LogEntry } from "../ipc";

/// Frontend mirror of the backend log ring. Capped at 1000 entries to
/// match the Rust ring. Seeded on mount via `log_list`; live-updated via
/// the `log:entry` Tauri event.
///
/// Selectors:
///   * bar — `{ latest, errorCount, runningCount }`
///   * console — full filtered slice
///
/// Pre-workspace: backend bus is `None`, so `log_list` returns `[]` and
/// no `log:entry` events fire. The store sits idle until the user opens
/// a workspace.

const RING_CAP = 1000;

/// Latest-error sticky window: once an Error lands, the bar's latest
/// slot resists overwrite by lower-severity entries for this many ms.
/// Acknowledged on toggleLog (Phase 2 wires the shortcut).
export const ERROR_STICKY_MS = 10_000;

export interface LogStoreState {
  entries: LogEntry[];
  errorCount: number;
  /// op_id → latest OpState. A non-terminal entry (`Started`/`Progress`)
  /// adds; `Ok`/`Err` removes. Used by the bar's running-count badge.
  runningOps: Record<string, "Started" | "Progress">;
  /// The last entry shown in the bar's "latest" slot. May lag `entries[0]`
  /// when an error is sticky.
  latest: LogEntry | null;
  /// Wall-clock ms at which the sticky-on-error window for `latest`
  /// expires. `0` when not sticky.
  latestStickyUntil: number;
  /// True after the initial `log_list` seed + subscription is wired.
  ready: boolean;
}

interface LogStoreActions {
  append: (e: LogEntry) => void;
  seed: (initial: LogEntry[]) => void;
  clear: () => void;
  acknowledgeErrorSticky: () => void;
}

export const useLogStore = create<LogStoreState & LogStoreActions>(
  (set, get) => ({
    entries: [],
    errorCount: 0,
    runningOps: {},
    latest: null,
    latestStickyUntil: 0,
    ready: false,

    append: (e) =>
      set((s) => {
        const next = [e, ...s.entries];
        if (next.length > RING_CAP) next.length = RING_CAP;

        const runningOps = { ...s.runningOps };
        if (e.op_id && e.op_state) {
          const key = e.op_id;
          if (e.op_state.state === "Started" || e.op_state.state === "Progress") {
            runningOps[key] = e.op_state.state;
          } else if (e.op_state.state === "Ok" || e.op_state.state === "Err") {
            delete runningOps[key];
          }
        }

        const now = Date.now();
        const errorIncoming = e.level === "error";
        const errorCount = s.errorCount + (errorIncoming ? 1 : 0);

        // Latest-slot policy: errors always win; otherwise yield only when
        // the prior sticky window has expired. Trace/debug never replace a
        // visible entry — they go straight into entries[] for the console.
        let latest = s.latest;
        let latestStickyUntil = s.latestStickyUntil;
        const wouldShow = e.level !== "trace" && e.level !== "debug";
        if (errorIncoming) {
          latest = e;
          latestStickyUntil = now + ERROR_STICKY_MS;
        } else if (wouldShow && now >= s.latestStickyUntil) {
          latest = e;
        }

        return { entries: next, errorCount, runningOps, latest, latestStickyUntil };
      }),

    seed: (initial) => {
      // initial is in backend order (oldest first in the ring). Reverse so
      // entries[0] is newest, matching `append`'s prepend pattern.
      const reversed = [...initial].reverse();
      const errorCount = reversed.filter((e) => e.level === "error").length;
      const runningOps: Record<string, "Started" | "Progress"> = {};
      for (const e of reversed) {
        if (!e.op_id || !e.op_state) continue;
        if (e.op_state.state === "Started" || e.op_state.state === "Progress") {
          runningOps[e.op_id] = e.op_state.state;
        } else {
          delete runningOps[e.op_id];
        }
      }
      const latest = reversed.find(
        (e) => e.level !== "trace" && e.level !== "debug",
      ) ?? null;
      set({ entries: reversed, errorCount, runningOps, latest, ready: true });
    },

    clear: () =>
      set({
        entries: [],
        errorCount: 0,
        runningOps: {},
        latest: null,
        latestStickyUntil: 0,
      }),

    acknowledgeErrorSticky: () => {
      const s = get();
      if (s.latestStickyUntil > 0) {
        set({ latestStickyUntil: 0 });
      }
    },
  }),
);

/// One-shot mount wiring: seed from `log_list`, then subscribe to
/// `log:entry`. Returns a teardown function.
///
/// Idempotent in practice — the App calls it once in a top-level
/// `useEffect`. If called twice (HMR), the second call's subscription
/// replaces the first; the seed is a no-op since the store entries
/// already mirror the backend.
export async function wireLogStream(): Promise<UnlistenFn> {
  try {
    const initial = await logList();
    useLogStore.getState().seed(initial);
  } catch (e) {
    // Pre-workspace `log_list` returns []; only unexpected failures
    // land here. Don't trigger an error entry because the log isn't
    // wired yet.
    console.warn("logList seed failed:", e);
  }
  return await listen<LogEntry>(LOG_EVENTS.entry, (event) => {
    useLogStore.getState().append(event.payload);
  });
}

