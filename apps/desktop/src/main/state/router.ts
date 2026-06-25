// apps/desktop/src/main/state/router.ts
// Pure splitter classification for the WEFTCUT_TS_ACTOR flip. Consulted by
// src/main/index.ts ONLY when the flag is on; flag-off = everything → rust.
// SAFETY INVARIANT (router.test.ts partition gate): every renderer channel is
// classified into exactly one bucket, and no project-touching channel routes to
// 'rust' (the curated PURE_NATIVE ∪ PERSISTENCE ∪ MIRROR_BACKED_READS ∪
// DEBUG_ONLY allowlist is read-only / config-store / pure-native / dev-only).
// An unclassified channel routes to {kind:'reject'} so the gate fails loud.
import { PRODUCTION_OPS } from './commands'

export type Route =
  | { kind: 'command' }       // actor.command(channel, args)
  | { kind: 'summary' }       // buildProjectSummary
  | { kind: 'projectSettings' } // actor.snapshot().settings
  | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' }
  | { kind: 'agentSessionEnd' } // agentSessionEnd seam: endSlot + unlockHistory
  | { kind: 'hybrid'; tool: string } // native-compute → TS-write (Phase 3d-e)
  | { kind: 'reject'; reason: string }
  | { kind: 'rust' }

/** Renderer-reachable category-A mutations with NO TS path — rejected under the
 *  flag (single-writer), deferred to Phase 4. add_motif needs the motif catalog;
 *  project_restore_checkpoint has no TS command-surface create path (and no
 *  checkpoint can exist during a single-writer soak). */
export const BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set(['add_motif', 'project_restore_checkpoint'])

/** Hybrid Rust-compute → TS-write channels (Phase 3d-e). */
export const HYBRID_CHANNELS: ReadonlySet<string> = new Set(['import_media', 'install_motif', 'acknowledge_motif_staleness'])

/** Read-only native handlers re-pointed to the read-mirror (Group A) — safe on rust. */
export const MIRROR_BACKED_READS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy',
  'get_media_thumbnail', 'get_waveform_peaks', 'motif_staleness_report',
])

/** Native compute with NO project actor access. */
export const PURE_NATIVE: ReadonlySet<string> = new Set([
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish', 'export_video_sink_cancel',
  'import_cancel', 'import_queue_list', 'report_audio_meter', 'settings_get_api_key_status', 'settings_test_provider',
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'delete_motif',
])

/** Backend stores (config-dir), not the project actor. */
export const PERSISTENCE: ReadonlySet<string> = new Set([
  'app_settings_get', 'app_settings_set', 'view_state_get', 'view_state_set', 'export_settings_get', 'export_settings_set',
  'workspace_dir', 'recents_list', 'recents_remove', 'recents_get_reopen_on_launch', 'recents_set_reopen_on_launch',
  'recents_most_recent', 'recents_last_new_project_parent', 'keybindings_get', 'keybindings_set', 'keybindings_reset_all',
  'keybindings_export', 'keybindings_import', 'agent_session_get', 'log_list', 'log_clear', 'log_emit', 'log_dir_path',
])

/** debug_assertions-only, project-touching; dev tooling, not a release/flag-default-on risk. Phase-4. */
export const DEBUG_ONLY: ReadonlySet<string> = new Set(['debug_lock_history', 'debug_unlock_history', 'debug_simulate_agent_session'])

export function routeChannel(channel: string): Route {
  if (PRODUCTION_OPS.has(channel)) return { kind: 'command' }
  if (HYBRID_CHANNELS.has(channel)) return { kind: 'hybrid', tool: channel }
  if (BLOCKED_UNDER_FLAG.has(channel)) return { kind: 'reject', reason: `${channel} is unavailable while the TS state actor is active (WEFTCUT_TS_ACTOR); ported in Phase 4` }
  switch (channel) {
    case 'project_summary': return { kind: 'summary' }
    case 'get_project_settings': return { kind: 'projectSettings' }
    case 'project_open': return { kind: 'open' }
    case 'project_save_as': return { kind: 'saveAs' }
    case 'project_new_workspace': return { kind: 'newWorkspace' }
    case 'project_save': return { kind: 'save' }
    case 'agent_session_end': return { kind: 'agentSessionEnd' }
  }
  if (PURE_NATIVE.has(channel) || PERSISTENCE.has(channel) || MIRROR_BACKED_READS.has(channel) || DEBUG_ONLY.has(channel))
    return { kind: 'rust' }
  return { kind: 'reject', reason: 'unclassified channel under WEFTCUT_TS_ACTOR — classify in router.ts' }
}
