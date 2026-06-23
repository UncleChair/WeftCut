/**
 * Category-A MCP mutation tools: tools that change project state and must be
 * rejected while the TS state actor (WEFTCUT_TS_ACTOR=1) is authoritative.
 *
 * Read-only tools (ping, groups_list, groups_get, get_param_track,
 * list_checkpoints, dry_run, list_motifs, get_motif_source,
 * preview_motif_draft, detect_silences, transcribe_clip) are NOT in the set.
 *
 * Source: apps/desktop/native/src/mcp/catalog.rs tool_table! macro.
 */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  // Agent-mode session lifecycle
  'begin_agent_session',
  // Track mutations
  'add_track',
  'remove_track',
  'move_track',
  // Layer mutations
  'add_color_layer',
  'add_video_layer',
  'apply_subtitles',
  'update_layer',
  'update_layer_params',
  'move_layer',
  'split_layer',
  'delete_layer',
  'trim_layer',
  'duplicate_layer',
  // Group mutations
  'groups_create',
  'groups_dissolve',
  'groups_add_members',
  'groups_remove_members',
  'groups_rename',
  // Keyframe mutations
  'set_keyframe',
  'remove_keyframe',
  'retime_keyframe',
  'set_keyframe_easing',
  'smooth_keyframes',
  'clear_keyframes',
  'set_param_track',
  // Effect mutations
  'add_effect',
  'update_effect',
  'move_effect',
  'remove_effect',
  // Composition mutations
  'set_composition',
  'fit_composition_to_layers',
  // Marker mutations
  'add_marker',
  'update_marker',
  'remove_marker',
  // Media mutations
  'import_media',
  'remove_media',
  // Workflow / history mutations
  'undo',
  'redo',
  'lock_history',
  'unlock_history',
  'checkpoint',
  'restore_checkpoint',
  // Role mix mutations (recorded)
  'set_role_gain',
  // Role flags (unrecorded, but still mutates runtime mix state)
  'set_role_flags',
  // Motif mutations (feature = "motifs")
  'write_motif_draft',
  'install_motif',
  'delete_motif',
  'add_motif',
  // Cloud mutations (feature = "cloud") — synthesize_speech adds an Audio layer
  'synthesize_speech',
])

/**
 * Returns true when the WEFTCUT_TS_ACTOR flag is active AND the given tool
 * name is a category-A mutation that would write to the Rust actor's stale
 * state. Dormant (returns false) when the flag is unset.
 */
export function isPausedUnderTsActor(toolName: string): boolean {
  return process.env['WEFTCUT_TS_ACTOR'] === '1' && MUTATION_TOOLS.has(toolName)
}
