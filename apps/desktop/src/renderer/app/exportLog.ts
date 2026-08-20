import { logEmit } from "../ipc";
import type { ExportState } from "../panels/ExportPanel";

/// LogBus mirror for the export lifecycle — the log-row sibling of the
/// taskbar-progress and native-notification mirrors in `useExportFlow`. All
/// three observe `ExportState` transitions instead of instrumenting the
/// pipeline's ~two dozen `setExportState` sites, so every path (video,
/// audio-only, readiness aborts, future stages) is covered by construction.
/// The `ExportPanel` stays the live progress UI; these rows are the record.
///
/// Row shape is the house three-state (`runCommandWithLogging`): a run that
/// settles inside `STARTED_AFTER_MS` is one row with no `op_id`; a slower one
/// is `Started` + `Ok`/`Err` under one `op_id`. A cancel (running → null)
/// closes the op as `Ok`, not `Err` — same convention as the content-download
/// op in `src/main/index.ts`.

export interface ExportLogContext {
  /// User-chosen output path — names the run in every row.
  output: string;
  codec: string;
}

/// House slow-op threshold. Keep equal to `runCommandWithLogging`'s — the
/// 250 ms line is one project-wide definition of "the user is waiting".
const STARTED_AFTER_MS = 250;

/// Progress rows land once per 1/PROGRESS_STEPS of the encode, not per frame
/// or per second: a multi-hour export must not spend the 1000-entry ring on
/// its own progress (each op state-change is one ring entry, however the UI
/// collapses them).
const PROGRESS_STEPS = 10;

interface RunningOp {
  id: string;
  ctx: ExportLogContext;
  startedOut: boolean;
  timer: number;
  lastStep: number;
}

const CATEGORY = { kind: "Export" } as const;
const SOURCE = { kind: "User" } as const;

export function createExportLogMirror(): {
  /// Call at the top of a run with the run's identity; the next observed
  /// non-null state opens the op with it.
  begin(ctx: ExportLogContext): void;
  /// Feed every committed `exportState`. Re-observing the same reference is a
  /// no-op (StrictMode re-runs the effect with an unchanged state).
  observe(state: ExportState | null): void;
} {
  let pendingCtx: ExportLogContext = { output: "", codec: "" };
  let last: ExportState | null = null;
  let op: RunningOp | null = null;

  const emitStarted = () => {
    if (!op || op.startedOut) return;
    op.startedOut = true;
    window.clearTimeout(op.timer);
    void logEmit({
      level: "info",
      category: CATEGORY,
      source: SOURCE,
      message: `Exporting ${op.ctx.output}`,
      i18n_key: "log.export_started",
      i18n_args: { path: op.ctx.output },
      op_id: op.id,
      op_state: { state: "Started" },
      details: { output: op.ctx.output, codec: op.ctx.codec },
    });
  };

  const endOp = (
    level: "info" | "error",
    state: "Ok" | "Err",
    message: string,
    i18nKey: string,
    i18nArgs: Record<string, unknown>,
    details: Record<string, unknown>,
  ) => {
    if (!op) return;
    window.clearTimeout(op.timer);
    void logEmit({
      level,
      category: CATEGORY,
      source: SOURCE,
      message,
      i18n_key: i18nKey,
      i18n_args: i18nArgs,
      // Fast runs never got a Started, so the terminal row stands alone; a
      // dangling op_state would spin the running badge forever.
      ...(op.startedOut ? { op_id: op.id, op_state: { state } } : {}),
      details,
    });
    op = null;
  };

  return {
    begin(ctx: ExportLogContext) {
      pendingCtx = ctx;
    },

    observe(state: ExportState | null) {
      if (state === last) return;
      last = state;
      const kind = state === null ? null : state.kind;
      const running =
        kind === "starting" || kind === "preparing" || kind === "progress";

      if (running && !op) {
        op = {
          id: crypto.randomUUID(),
          ctx: pendingCtx,
          startedOut: false,
          timer: window.setTimeout(emitStarted, STARTED_AFTER_MS),
          lastStep: -1,
        };
      }

      if (op) {
        if (state !== null && state.kind === "progress") {
          // Encode progress means the user is visibly waiting: flush the
          // Started row now so no Progress row can precede it.
          emitStarted();
          const step = Math.floor(state.progress.progress * PROGRESS_STEPS);
          if (step > op.lastStep) {
            op.lastStep = step;
            void logEmit({
              level: "info",
              category: CATEGORY,
              source: SOURCE,
              message: `Exporting ${op.ctx.output}`,
              i18n_key: "log.export_started",
              i18n_args: { path: op.ctx.output },
              op_id: op.id,
              op_state: { state: "Progress", progress: state.progress.progress },
            });
          }
        } else if (state !== null && state.kind === "complete") {
          endOp(
            "info",
            "Ok",
            `Exported ${state.payload.outputPath}`,
            "log.export_ok",
            { path: state.payload.outputPath },
            {
              output: state.payload.outputPath,
              duration_us: state.payload.durationUs,
            },
          );
        } else if (state !== null && state.kind === "error") {
          endOp(
            "error",
            "Err",
            `Export failed: ${state.detail}`,
            "log.export_failed",
            { error: state.detail },
            { output: op.ctx.output, error: state.detail },
          );
        } else if (state === null) {
          // Running → null is the cancel path (readiness aborts); dismissing
          // a terminal panel also lands here but the op is already closed.
          endOp(
            "info",
            "Ok",
            "Export cancelled",
            "log.export_cancelled",
            {},
            { output: op.ctx.output },
          );
        }
        return;
      }

      // No op open: an export refused before it began (e.g. the no-material
      // guard errors straight from idle). One row, no op — same shape as a
      // fast failure.
      if (state !== null && state.kind === "error") {
        void logEmit({
          level: "error",
          category: CATEGORY,
          source: SOURCE,
          message: `Export failed: ${state.detail}`,
          i18n_key: "log.export_failed",
          i18n_args: { error: state.detail },
          details: { output: pendingCtx.output, error: state.detail },
        });
      }
    },
  };
}
