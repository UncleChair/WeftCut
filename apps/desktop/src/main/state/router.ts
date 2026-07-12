// apps/desktop/src/main/state/router.ts
// Pure splitter: the TS actor is authoritative; this splits every renderer channel.
// SAFETY INVARIANT (router.test.ts partition gate): every renderer channel is
// classified into exactly one bucket, and no project-touching channel routes to
// 'rust' (the curated PURE_NATIVE ∪ PERSISTENCE ∪ SLICE_INJECTED_READS allowlist is
// read-only / config-store / pure-native). An unclassified channel routes to
// {kind:'reject'} so the gate fails loud.
import { PRODUCTION_OPS } from './commands'

export type Route =
  | { kind: 'command' }       // actor.command(channel, args)
  | { kind: 'summary' }       // buildProjectSummary
  | { kind: 'projectSettings' } // actor.snapshot().settings
  | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' }
  | { kind: 'agentSessionEnd' } // agentSessionEnd seam: endSlot + unlockHistory
  | { kind: 'appSettings' }   // app-level prefs store, owned in TS main (config-dir)
  | { kind: 'viewState' }     // per-workspace view.json store, owned in TS main
  | { kind: 'exportSettings' } // per-workspace export.json store, owned in TS main
  | { kind: 'keybindings' }   // per-user keybinding overrides, owned in TS main (config-dir)
  | { kind: 'recents' }       // recent-projects list + prefs, owned in TS main (config-dir)
  | { kind: 'hybrid'; tool: string } // native-compute → TS-write (Phase 3d-e)
  | { kind: 'motif'; tool: string }  // TS Motif authoring/read/install (Phase 2)
  | { kind: 'reject'; reason: string }
  | { kind: 'rust' }

/** Hybrid Rust-compute → TS-write channels (Phase 3d-e). install_motif moved to
 *  the motif route (Phase 2); acknowledge_motif_staleness moved to the motif
 *  route (Phase 3). */
export const HYBRID_CHANNELS: ReadonlySet<string> = new Set(['import_media'])

/** Motif catalog-read + authoring + install + staleness channels, served in TS by
 *  runMotifTool (Phase 2/3). */
export const MOTIF_CHANNELS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft',
  'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif',
  'motif_staleness_report', 'acknowledge_motif_staleness',
])

/** Native read/compute handlers that receive their project state slice (a MediaItem
 *  or the full Project) as an injected call argument — the TS host forwards it
 *  before the rust dispatch. Safe on rust: they hold no resident state. */
export const SLICE_INJECTED_READS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy', 'generate_quick_proxy',
  'get_media_thumbnail', 'get_waveform_peaks',
])

/** Native compute with NO project actor access. */
export const PURE_NATIVE: ReadonlySet<string> = new Set([
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish', 'export_video_sink_cancel',
  'import_cancel', 'import_queue_list', 'report_audio_meter', 'settings_get_api_key_status', 'settings_test_provider',
])

/** Backend stores (config-dir), not the project actor. */
export const PERSISTENCE: ReadonlySet<string> = new Set([
  'workspace_dir', 'agent_session_get', 'log_list', 'log_clear', 'log_emit', 'log_dir_path',
])

export function routeChannel(channel: string): Route {
  if (PRODUCTION_OPS.has(channel)) return { kind: 'command' }
  if (HYBRID_CHANNELS.has(channel)) return { kind: 'hybrid', tool: channel }
  if (MOTIF_CHANNELS.has(channel)) return { kind: 'motif', tool: channel }
  switch (channel) {
    case 'project_summary': return { kind: 'summary' }
    case 'get_project_settings': return { kind: 'projectSettings' }
    case 'project_open': return { kind: 'open' }
    case 'project_save_as': return { kind: 'saveAs' }
    case 'project_new_workspace': return { kind: 'newWorkspace' }
    case 'project_save': return { kind: 'save' }
    case 'agent_session_end': return { kind: 'agentSessionEnd' }
    case 'app_settings_get':
    case 'app_settings_set': return { kind: 'appSettings' }
    case 'view_state_get':
    case 'view_state_set': return { kind: 'viewState' }
    case 'export_settings_get':
    case 'export_settings_set': return { kind: 'exportSettings' }
    case 'keybindings_get':
    case 'keybindings_set':
    case 'keybindings_reset_all':
    case 'keybindings_export':
    case 'keybindings_import': return { kind: 'keybindings' }
    case 'recents_list':
    case 'recents_remove':
    case 'recents_get_reopen_on_launch':
    case 'recents_set_reopen_on_launch':
    case 'recents_most_recent':
    case 'recents_last_new_project_parent': return { kind: 'recents' }
  }
  if (PURE_NATIVE.has(channel) || PERSISTENCE.has(channel) || SLICE_INJECTED_READS.has(channel))
    return { kind: 'rust' }
  return { kind: 'reject', reason: 'unclassified channel — classify in router.ts' }
}
