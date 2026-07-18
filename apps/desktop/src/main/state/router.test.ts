import { describe, it, expect } from 'vitest'
import {
  routeChannel,
  HYBRID_CHANNELS, SLICE_INJECTED_READS, PURE_NATIVE, PERSISTENCE, MOTIF_CHANNELS,
} from './router'
import { PRODUCTION_OPS } from './commands'

// ── Partition gate manifest ──────────────────────────────────────────────────
// Every renderer `cmd` string the router classifies. KEEP IN SYNC: adding a
// channel requires adding it here AND classifying it into exactly one router
// bucket, or the gate below fails (an unclassified channel routes to
// {kind:'reject'}). This is the single-writer safety backstop: no
// project-touching channel may reach Rust.
const ALL_CHANNELS: readonly string[] = [
  // category-A mutations → PRODUCTION_OPS (command) or BLOCKED_UNDER_FLAG (reject)
  'add_track', 'separate_audio_to_new_track', 'add_demo_color_layer', 'add_color_layer',
  'add_media_layer', 'add_text_layer', 'add_demo_text_layer', 'update_layer', 'update_layer_params',
  'update_layer_param_track', 'update_layer_param_tracks', 'add_effect', 'update_effect',
  'move_effect', 'remove_effect', 'move_layer', 'trim_layer', 'split_layer_grouped',
  'groups_create', 'groups_dissolve', 'duplicate_layer', 'paste_layer', 'delete_layer', 'set_composition',
  'fit_composition_to_layers', 'update_track_flags', 'set_role_gain', 'update_role_flags',
  'project_undo', 'project_redo', 'project_restore_checkpoint', 'update_project_settings',
  'restyle_captions', 'add_motif',
  // router special-cases (summary / settings / persistence seam / agent-session)
  'project_summary', 'get_project_settings', 'project_open', 'project_save_as',
  'project_new_workspace', 'project_save', 'agent_session_end',
  // motif route (TS authoring + read + install + staleness — Phase 2/3)
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft',
  'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif',
  'motif_staleness_report', 'acknowledge_motif_staleness',
  // pure native (no project actor)
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish',
  'export_video_sink_cancel', 'import_cancel', 'import_queue_list', 'report_audio_meter',
  'settings_get_api_key_status', 'settings_test_provider',
  // hybrids (native-compute → TS-write)
  'import_media',
  // slice-injected native reads (receive their state slice as a call argument)
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy',
  'generate_quick_proxy',
  'get_media_thumbnail', 'get_waveform_peaks',
  // backend stores (config-dir, not the project actor)
  'app_settings_get', 'app_settings_set', 'workspace_get', 'workspace_set_current',
  'workspace_set_active', 'workspace_save_baseline', 'workspace_create_profile',
  'workspace_rename_profile', 'workspace_delete_profile',
  'view_state_get', 'view_state_set', 'export_settings_get',
  'export_settings_set', 'workspace_dir', 'recents_list', 'recents_remove',
  'recents_get_reopen_on_launch', 'recents_set_reopen_on_launch', 'recents_most_recent',
  'recents_last_new_project_parent', 'keybindings_get', 'keybindings_set', 'keybindings_reset_all',
  'keybindings_export', 'keybindings_import', 'agent_session_get', 'log_list', 'log_clear',
  'log_emit', 'log_dir_path',
]

/** Curated set of channels allowed to route to {kind:'rust'}: read-only +
 *  config-store + pure-native — NONE touch the project actor for writes. The
 *  gate asserts no channel routes to rust outside this set. */
const RUST_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...PURE_NATIVE, ...PERSISTENCE, ...SLICE_INJECTED_READS,
])

describe('router partition gate', () => {
  it('every renderer channel is classified; no project-touching channel routes to rust', () => {
    for (const ch of ALL_CHANNELS) {
      const r = routeChannel(ch)
      // Every known channel must be classified — a 'reject' here means an
      // unclassified channel hit the default → out-of-sync manifest.
      expect(r.kind, `${ch} unclassified (reject default)`).not.toBe('reject')
      if (r.kind === 'rust') expect(RUST_ALLOWLIST.has(ch), `${ch} routes to rust`).toBe(true)
    }
    for (const ch of ['import_media'])
      expect(routeChannel(ch).kind, ch).toBe('hybrid')
    for (const ch of MOTIF_CHANNELS)
      expect(routeChannel(ch).kind, ch).toBe('motif')
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
      ['SLICE_INJECTED_READS', SLICE_INJECTED_READS],
      ['HYBRID_CHANNELS', HYBRID_CHANNELS],
      ['MOTIF_CHANNELS', MOTIF_CHANNELS],
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
  it('routes add_motif to command (Phase 4a-ii §2.2 — pure TS mutation, blocked sets ∅)', () => {
    expect(routeChannel('add_motif').kind).toBe('command')
  })
  it('routes project_restore_checkpoint to command (Phase 4a-i §2.1)', () => {
    expect(routeChannel('project_restore_checkpoint').kind).toBe('command')
  })
  it('forwards independent stores + media/jobs/export to rust', () => {
    // import_media is now a hybrid (native-compute → TS-write), not rust.
    // list_motifs is now a motif route (Phase 2), not rust.
    // app_settings_*, view_state_*, export_settings_*, keybindings_*, and recents_* migrated off rust to TS handlers.
    for (const ch of ['agent_session_get','log_list','ensure_full_proxy','generate_quick_proxy','export_video_sink_start','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
  })
  it('routes export_settings_get/set to the exportSettings TS handler (migrated off rust)', () => {
    expect(routeChannel('export_settings_get').kind).toBe('exportSettings')
    expect(routeChannel('export_settings_set').kind).toBe('exportSettings')
  })
  it('routes all 5 keybindings channels to the keybindings TS handler (migrated off rust)', () => {
    for (const ch of ['keybindings_get', 'keybindings_set', 'keybindings_reset_all', 'keybindings_export', 'keybindings_import'])
      expect(routeChannel(ch).kind, ch).toBe('keybindings')
  })
  it('routes app_settings_get/set to the appSettings TS handler (migrated off rust)', () => {
    expect(routeChannel('app_settings_get').kind).toBe('appSettings')
    expect(routeChannel('app_settings_set').kind).toBe('appSettings')
  })
  it('routes view_state_get/set to the viewState TS handler (migrated off rust)', () => {
    expect(routeChannel('view_state_get').kind).toBe('viewState')
    expect(routeChannel('view_state_set').kind).toBe('viewState')
  })
  it('routes every workspace channel to the workspace TS handler (app-level Dock arrangement + named profiles)', () => {
    for (const ch of [
      'workspace_get', 'workspace_set_current', 'workspace_set_active',
      'workspace_save_baseline', 'workspace_create_profile',
      'workspace_rename_profile', 'workspace_delete_profile',
    ])
      expect(routeChannel(ch).kind, ch).toBe('workspace')
  })
  it('routes all 6 recents channels to the recents TS handler (migrated off rust)', () => {
    for (const ch of ['recents_list', 'recents_remove', 'recents_get_reopen_on_launch', 'recents_set_reopen_on_launch', 'recents_most_recent', 'recents_last_new_project_parent'])
      expect(routeChannel(ch).kind, ch).toBe('recents')
  })
  it('routes the one remaining hybrid channel to hybrid', () => {
    expect(routeChannel('import_media').kind).toBe('hybrid')
  })
  it('routes motif authoring/read/install/staleness channels to the motif route (Phase 2/3)', () => {
    for (const ch of ['list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif', 'motif_staleness_report', 'acknowledge_motif_staleness'])
      expect(routeChannel(ch).kind, ch).toBe('motif')
  })
  it('never routes a category-A state mutation to rust', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).not.toBe('rust')
  })
})
