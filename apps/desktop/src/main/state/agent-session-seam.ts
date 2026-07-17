// The agent_session_end history-unlock seam (commands/prefs.rs). The
// renderer's "Exit to editor" / workspace-change / MCP-disconnect paths call
// this: clear the agent-session slot (a Rust process-global; the UI listens via
// `agent_session:changed`) AND release any `lock_history` the agent took. The
// authoritative history is the TS actor, so the unlock must hit the TS actor —
// not the Rust handle. The `agent_session_end` channel routes here (injecting
// the napi slot-end + actor.unlockHistory).
export interface AgentSessionSeamDeps {
  /** Clear the Rust agent-session slot + emit `agent_session:changed`. */
  endSlot: () => void
  /** Release any revert-lock on the authoritative (TS) history. */
  unlockHistory: () => void
}

/** Mirrors prefs.rs:209 ordering: end_and_emit FIRST, then unlock_history. */
export function agentSessionEnd(deps: AgentSessionSeamDeps): void {
  deps.endSlot()
  deps.unlockHistory()
}
