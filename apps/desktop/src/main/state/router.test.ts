import { describe, it, expect } from 'vitest'
import {
  routeChannel,
  HYBRID_CHANNELS, MIRROR_BACKED_READS, PURE_NATIVE, PERSISTENCE, DEBUG_ONLY, BLOCKED_UNDER_FLAG,
} from './router'
import { PRODUCTION_OPS } from './commands'

// ── Partition gate manifest ──────────────────────────────────────────────────
// Every `cmd` string the Rust `Backend::dispatch` matches (napi_backend.rs
// :557-883). KEEP IN SYNC: adding a dispatch arm in napi_backend.rs requires
// adding it here AND classifying it into exactly one router bucket, or the gate
// below fails (an unclassified channel routes to {kind:'reject'}). This is the
// single-writer safety backstop: no project-touching channel may reach Rust
// under WEFTCUT_TS_ACTOR.
const ALL_CHANNELS: readonly string[] = [
  // category-A mutations → PRODUCTION_OPS (command) or BLOCKED_UNDER_FLAG (reject)
  'add_track', 'separate_audio_to_new_track', 'add_demo_color_layer', 'add_color_layer',
  'add_media_layer', 'add_text_layer', 'add_demo_text_layer', 'update_layer', 'update_layer_params',
  'update_layer_param_track', 'update_layer_param_tracks', 'add_effect', 'update_effect',
  'move_effect', 'remove_effect', 'move_layer', 'trim_layer', 'split_layer_grouped',
  'groups_create', 'groups_dissolve', 'duplicate_layer', 'delete_layer', 'set_composition',
  'fit_composition_to_layers', 'update_track_flags', 'set_role_gain', 'update_role_flags',
  'project_undo', 'project_redo', 'project_restore_checkpoint', 'update_project_settings',
  'restyle_caption_track', 'add_motif',
  // router special-cases (summary / settings / persistence seam / agent-session)
  'project_summary', 'get_project_settings', 'project_open', 'project_save_as',
  'project_new_workspace', 'project_save', 'agent_session_end',
  // hybrids (native-compute → TS-write)
  'import_media', 'install_motif', 'acknowledge_motif_staleness',
  // pure native (no project actor)
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish',
  'export_video_sink_cancel', 'import_cancel', 'import_queue_list', 'report_audio_meter',
  'settings_get_api_key_status', 'settings_test_provider', 'list_motifs', 'get_motif_source',
  'write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'delete_motif',
  // mirror-backed reads (re-pointed to the read-mirror in Group A)
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy',
  'get_media_thumbnail', 'get_waveform_peaks', 'motif_staleness_report',
  // backend stores (config-dir, not the project actor)
  'app_settings_get', 'app_settings_set', 'view_state_get', 'view_state_set', 'export_settings_get',
  'export_settings_set', 'workspace_dir', 'recents_list', 'recents_remove',
  'recents_get_reopen_on_launch', 'recents_set_reopen_on_launch', 'recents_most_recent',
  'recents_last_new_project_parent', 'keybindings_get', 'keybindings_set', 'keybindings_reset_all',
  'keybindings_export', 'keybindings_import', 'agent_session_get', 'log_list', 'log_clear',
  'log_emit', 'log_dir_path',
  // debug_assertions-only, project-touching dev tooling
  'debug_lock_history', 'debug_unlock_history', 'debug_simulate_agent_session',
]

/** Curated set of channels allowed to route to {kind:'rust'}: read-only +
 *  config-store + pure-native + dev-only — NONE touch the project actor for
 *  writes. The gate asserts no channel routes to rust outside this set. */
const RUST_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...PURE_NATIVE, ...PERSISTENCE, ...MIRROR_BACKED_READS, ...DEBUG_ONLY,
])

describe('router partition gate', () => {
  it('every renderer channel is classified; no project-touching channel routes to rust', () => {
    for (const ch of ALL_CHANNELS) {
      const r = routeChannel(ch)
      // Every known channel is classified: a 'reject' is only legitimate when the
      // channel is an intentionally-deferred BLOCKED_UNDER_FLAG one (single-writer).
      // Any OTHER reject is the unclassified-default → an out-of-sync manifest.
      if (r.kind === 'reject') expect(BLOCKED_UNDER_FLAG.has(ch), `${ch} unclassified (reject default)`).toBe(true)
      if (r.kind === 'rust') expect(RUST_ALLOWLIST.has(ch), `${ch} routes to rust`).toBe(true)
    }
    for (const ch of ['import_media', 'install_motif', 'acknowledge_motif_staleness'])
      expect(routeChannel(ch).kind, ch).toBe('hybrid')
  })

  it('an unclassified channel routes to reject (single-writer backstop)', () => {
    expect(routeChannel('totally_unknown_channel').kind).toBe('reject')
  })

  it('the allowlist sets are disjoint from each other and from hybrids/blocked/production/special', () => {
    // SPECIAL: the 7 switch-case channels (project_open, project_save, etc.) handled
    // by dedicated Route kinds. They must never appear in any named allowlist bucket —
    // if a future refactor accidentally adds one to e.g. PURE_NATIVE the disjointness
    // check here will catch it before the partition gate silently hides the duplicate.
    const SPECIAL: ReadonlySet<string> = new Set([
      'project_open', 'project_save', 'project_save_as', 'project_new_workspace',
      'project_summary', 'get_project_settings', 'agent_session_end',
    ])
    const buckets: Array<[string, ReadonlySet<string>]> = [
      ['PURE_NATIVE', PURE_NATIVE], ['PERSISTENCE', PERSISTENCE],
      ['MIRROR_BACKED_READS', MIRROR_BACKED_READS], ['DEBUG_ONLY', DEBUG_ONLY],
      ['HYBRID_CHANNELS', HYBRID_CHANNELS], ['BLOCKED_UNDER_FLAG', BLOCKED_UNDER_FLAG],
      ['PRODUCTION_OPS', PRODUCTION_OPS as ReadonlySet<string>],
      ['SPECIAL', SPECIAL],
    ]
    for (let i = 0; i < buckets.length; i++)
      for (let j = i + 1; j < buckets.length; j++)
        for (const ch of buckets[i][1])
          expect(buckets[j][1].has(ch), `${ch} in both ${buckets[i][0]} and ${buckets[j][0]}`).toBe(false)
  })
})

describe('routeChannel', () => {
  it('routes every PRODUCTION_OPS channel to command', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).toBe('command')
  })
  it('routes reads + persistence + save to dedicated TS handlers', () => {
    expect(routeChannel('project_summary').kind).toBe('summary')
    expect(routeChannel('get_project_settings').kind).toBe('projectSettings')
    expect(routeChannel('project_open').kind).toBe('open')
    expect(routeChannel('project_save_as').kind).toBe('saveAs')
    expect(routeChannel('project_new_workspace').kind).toBe('newWorkspace')
    expect(routeChannel('project_save').kind).toBe('save')
    expect(routeChannel('agent_session_end').kind).toBe('agentSessionEnd')
  })
  it('rejects the two deferred renderer category-A channels', () => {
    expect(routeChannel('add_motif').kind).toBe('reject')
    expect(routeChannel('project_restore_checkpoint').kind).toBe('reject')
  })
  it('forwards independent stores + media/jobs/export to rust', () => {
    // import_media is now a hybrid (native-compute → TS-write), not rust.
    for (const ch of ['app_settings_get','app_settings_set','view_state_get','export_settings_get','recents_list','keybindings_get','agent_session_get','log_list','ensure_full_proxy','export_video_sink_start','list_motifs','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
  })
  it('routes the three hybrid channels to hybrid', () => {
    for (const ch of ['import_media','install_motif','acknowledge_motif_staleness'])
      expect(routeChannel(ch).kind).toBe('hybrid')
  })
  it('never routes a category-A state mutation to rust', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).not.toBe('rust')
  })
})
