/** Bounded producer-side buffer for LogBus entries emitted before a workspace —
 *  and therefore before a `LogBus` — exists. The MCP host binds at
 *  `app.whenReady()`, so its `listening` row has nothing to land in and Rust's
 *  `log_emit` drops it silently (`native/src/logs/bus.rs`); this holds it until
 *  the workspace-open path installs a bus.
 *
 *  Producer-side only: `LogBus`, `Clear` and `log_list` semantics are untouched
 *  (`.scratch/mcp-logbus/spec.md` decision 5). Owns the bound and the replay
 *  order; owns no emit path of its own — the caller hands one to `flush`.
 */

import type { McpLogEntryInput } from './mcp/withLog.js'

/** Queue bound, oldest dropped. What is worth replaying into a workspace opened
 *  minutes later is the handful of rows around boot, not a transcript of an idle
 *  app that never opens one — and dropping rather than refusing is what keeps
 *  the bound true whether or not a workspace ever arrives. */
export const DEFERRED_LOG_CAPACITY = 50

export interface DeferredLog {
  /** Hold one entry, evicting the oldest once the bound is reached. */
  push(entry: McpLogEntryInput): void
  /** Replay every held entry through `emit`, oldest first, then forget them. */
  flush(emit: (entry: McpLogEntryInput) => void): void
  /** Entries currently held. */
  readonly size: number
}

export function createDeferredLog(): DeferredLog {
  const held: McpLogEntryInput[] = []
  return {
    push(entry) {
      held.push(entry)
      while (held.length > DEFERRED_LOG_CAPACITY) held.shift()
    },
    flush(emit) {
      // Detach before replaying: `emit` is the same seam whose pre-workspace
      // branch pushes here, so an entry produced *during* the replay must wait
      // for the next flush instead of extending the array being walked.
      const pending = held.splice(0, held.length)
      for (const entry of pending) emit(entry)
    },
    get size() {
      return held.length
    },
  }
}
