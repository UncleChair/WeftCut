import { invoke } from "@tauri-apps/api/core";

export interface CompositionSummary {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

export interface HistoryView {
  cursor: number;
  len: number;
  can_undo: boolean;
  can_redo: boolean;
  /// `Some(reason)` while the agent holds the revert lock. Editor-mode
  /// disables Undo/Redo with this as tooltip; agent-mode shows a badge.
  lock_reason?: string | null;
}

export interface MediaSummary {
  id: string;
  label: string;
  path: string;
  kind: string;
  duration_us: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number;
  /// Phase C.2 (workspace-redesign): false when path_abs doesn't resolve
  /// to a real file. UI surfaces a "missing source" badge; project still
  /// opens; layers referencing the missing item render placeholders.
  available: boolean;
  /// Absolute path of the 540p proxy MP4 (H.264 + AAC, 1 s GOP) once the
  /// background job has produced it. `null` while pending or for media
  /// kinds that don't get proxied (audio-only sources). DOM preview
  /// falls back to `path` when null. See `docs/preview-dom.md`.
  proxy_path: string | null;
}

export interface LayerSummary {
  id: string;
  label: string | null;
  t_start_us: number;
  t_end_us: number;
  kind: string;
  color_hint: string;
  enabled: boolean;
  locked: boolean;
  params: LayerParamsView;
}

export type LayerParamsView =
  | ({ kind: "VideoClip" } & VideoClipView)
  | ({ kind: "ImageOverlay" } & ImageOverlayView)
  | ({ kind: "Text" } & TextView)
  | ({ kind: "Color" } & ColorView)
  | ({ kind: "Audio" } & AudioView)
  | ({ kind: "Subtitles" } & SubtitlesView)
  | ({ kind: "Template" } & TemplateView);

export interface TemplateView {
  template_id: string;
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
  /// User-set props for this template instance, validated against the
  /// template manifest's `props_schema`. Injected verbatim as
  /// `__props__` on the per-instance shadowed window-proxy inside the
  /// DOM-preview template host (`<div>` + Shadow DOM; see
  /// `TemplateHandle.ts`).
  props: Record<string, unknown>;
}

export interface VideoClipView {
  media_id: string;
  media_label: string;
  src_in_us: number;
  src_out_us: number;
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
  speed: number;
  flip_h: boolean;
  flip_v: boolean;
  fade_in_us: number;
  fade_out_us: number;
}

export interface ImageOverlayView {
  media_id: string;
  media_label: string;
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
  fade_in_us: number;
  fade_out_us: number;
}

export interface TextView {
  content: string;
  font_family: string;
  font_size_px: number;
  color: Rgba;
  x: number;
  y: number;
  opacity: number;
}

export interface ColorView {
  color: Rgba;
  width: number;
  height: number;
}

export interface AudioView {
  media_id: string;
  media_label: string;
  src_in_us: number;
  src_out_us: number;
  gain_db: number;
  pan: number;
  mute: boolean;
}

export interface SubtitlesView {
  source_kind: "Media" | "InlineAss" | "InlineSrt";
  source_value: string;
}

/// A/B-roll role stamp (`docs/ab-roll-redesign`). Serialized from the Rust
/// `TrackRole` enum as kebab-case. Null for additional / legacy tracks.
export type TrackRole = "a-roll" | "b-roll" | "audio-a" | "audio-b";

export interface TrackSummary {
  id: string;
  /// V.5 (A/B-roll v2): tracks are kind-agnostic on the backend, but
  /// this field is preserved as a derived "dominant layer class" label
  /// (Video / Audio / Subtitle) so the existing timeline CSS + drag-
  /// drop checks keep working through V.10's frontend cleanup. After
  /// V.10 this field goes away.
  kind: string;
  label: string | null;
  enabled: boolean;
  locked: boolean;
  /// `null` for tracks created after the reserved 4 (additional video, music,
  /// SFX, captions, voiceover, etc.) and for legacy projects. AB display mode
  /// hides any track where `role === null`; Show-All ignores the field.
  role: TrackRole | null;
  /// True when the track was spawned by the "one new hidden track per
  /// import" path and is therefore auto-pruned the moment its layers go
  /// to zero (R.4). The UI may render the track-header chrome differently
  /// to signal the impermanence.
  transient: boolean;
  layers: LayerSummary[];
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  composition: CompositionSummary;
  track_count: number;
  layer_count: number;
  duration_us: number;
  history: HistoryView;
  media: MediaSummary[];
  tracks: TrackSummary[];
  markers: MarkerSummary[];
  /// `docs/group-system.md`. Empty when no groups exist. UI uses this to
  /// render the tinted-border indicator and to resolve "what group is
  /// this layer in?" for click-selects-whole-group behavior.
  groups: GroupSummary[];
}

export interface GroupSummary {
  id: string;
  label: string | null;
  layer_ids: string[];
  /// Group-level effect chain (`docs/html-render-groups.md` 2026-05-17
  /// redesign). The TS distiller reads `HtmlTransform` from here to
  /// build the engine's `compositionTransform`. Any enabled effect
  /// whose kind requires html-cap rendering (today only
  /// `HtmlTransform`) flags the group for the html-render path —
  /// there is no separate `render_mode` flag.
  effects: Effect[];
}

/// Wire-compatible mirror of the Rust `Interpolation` enum.
export type Interpolation =
  | { kind: "Hold" }
  | { kind: "Linear" }
  | { kind: "EaseIn" }
  | { kind: "EaseOut" }
  | { kind: "Bezier"; p1: [number, number]; p2: [number, number] };

export interface Keyframe<T> {
  id: string;
  t_us: number;
  value: T;
  interp: Interpolation;
}

/// Wire-compatible mirror of the Rust `Animated<T>` enum
/// (`#[serde(tag = "mode", content = "value")]`).
export type AnimTrack<T> =
  | { mode: "Static"; value: T }
  | { mode: "Keyframed"; value: Keyframe<T>[] };

export interface Effect {
  id: string;
  enabled: boolean;
  params: EffectParams;
}

/// Effect params discriminated union. Today we only need the
/// `HtmlTransform` variant typed for the preview-side distiller;
/// other variants pass through opaquely. When per-effect authoring
/// lands, fill in the others.
export type EffectParams =
  | { kind: "HtmlTransform"; x: AnimTrack<number>; y: AnimTrack<number>; scale_x: AnimTrack<number>; scale_y: AnimTrack<number>; rotation_deg: AnimTrack<number>; opacity: AnimTrack<number> }
  | { kind: "ColorCorrect"; [k: string]: unknown }
  | { kind: "Blur"; [k: string]: unknown }
  | { kind: "ChromaKey"; [k: string]: unknown }
  | { kind: "Speed"; [k: string]: unknown }
  | { kind: "Vignette"; [k: string]: unknown };

export interface MarkerSummary {
  id: string;
  t_us: number;
  end_t_us: number | null;
  label: string;
  color_hint: string;
}

export interface LayerPatch {
  label?: string;
  t_start_us?: number;
  t_end_us?: number;
  enabled?: boolean;
  locked?: boolean;
}

/** Mirrors `Rgba` in `state/color.rs`. r/g/b/a all 0-255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TextPatch {
  content?: string;
  font_family?: string;
  font_size_px?: number;
  color?: Rgba;
  x?: number;
  y?: number;
  opacity?: number;
}

export interface VideoClipPatch {
  src_in_us?: number;
  src_out_us?: number;
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  opacity?: number;
  speed?: number;
  flip_h?: boolean;
  flip_v?: boolean;
  fade_in_us?: number;
  fade_out_us?: number;
}

export interface ImageOverlayPatch {
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  opacity?: number;
  fade_in_us?: number;
  fade_out_us?: number;
}

export interface ColorPatch {
  color?: Rgba;
  width?: number;
  height?: number;
}

export interface AudioPatch {
  src_in_us?: number;
  src_out_us?: number;
  gain_db?: number;
  pan?: number;
  mute?: boolean;
}

/// Tagged union mirroring `LayerParamsPatch` in state/actor.rs. Tauri/serde
/// expects the discriminant in `kind` to match the layer's current
/// LayerParams kind; mismatches return `LayerParamsKindMismatch`.
export type LayerParamsPatch =
  | ({ kind: "Text" } & TextPatch)
  | ({ kind: "VideoClip" } & VideoClipPatch)
  | ({ kind: "ImageOverlay" } & ImageOverlayPatch)
  | ({ kind: "Color" } & ColorPatch)
  | ({ kind: "Audio" } & AudioPatch);

export async function ping(): Promise<string> {
  return invoke<string>("ping");
}

export async function projectSummary(): Promise<ProjectSummary> {
  return invoke<ProjectSummary>("project_summary");
}

export async function addVideoTrack(): Promise<string> {
  return invoke<string>("add_video_track");
}

export async function addDemoColorLayer(): Promise<string> {
  return invoke<string>("add_demo_color_layer");
}

export async function addDemoTextLayer(): Promise<string> {
  return invoke<string>("add_demo_text_layer");
}

export async function addMediaLayer(
  trackId: string,
  mediaId: string,
  tStartUs: number,
): Promise<string> {
  return invoke<string>("add_media_layer", {
    trackId,
    mediaId,
    tStartUs,
  });
}

export async function addTextLayer(
  trackId: string,
  content: string,
  tStartUs: number,
  durationUs: number,
): Promise<string> {
  return invoke<string>("add_text_layer", {
    trackId,
    content,
    tStartUs,
    durationUs,
  });
}

export async function projectUndo(): Promise<void> {
  return invoke<void>("project_undo");
}

export async function projectRedo(): Promise<void> {
  return invoke<void>("project_redo");
}

export async function splitFirstLayer(): Promise<void> {
  return invoke<void>("split_first_layer");
}

export async function projectSave(): Promise<void> {
  return invoke<void>("project_save");
}

export async function projectSaveAs(path: string): Promise<void> {
  return invoke<void>("project_save_as", { path });
}

export async function projectOpen(path: string): Promise<void> {
  return invoke<void>("project_open", { path });
}

// ============================================================
// Workspace lifecycle (Phase B — workspace-redesign.md)
// ============================================================

export interface CanvasPreset {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

/// Create a fresh workspace at `<parentFolder>/<name>/` with the given
/// canvas params, replace the actor's state, and push to recents.
/// Returns the absolute path of the new workspace folder.
export async function projectNewWorkspace(args: {
  parentFolder: string;
  name: string;
  canvas: CanvasPreset;
}): Promise<string> {
  return invoke<string>("project_new_workspace", {
    parentFolder: args.parentFolder,
    name: args.name,
    width: args.canvas.width,
    height: args.canvas.height,
    fpsNum: args.canvas.fpsNum,
    fpsDen: args.canvas.fpsDen,
  });
}

export interface RecentEntry {
  path: string;
  name: string;
  /// ISO-8601 timestamp from chrono::DateTime<Utc>.
  last_opened: string;
}

export async function recentsList(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_list");
}

export async function recentsRemove(path: string): Promise<void> {
  return invoke<void>("recents_remove", { path });
}

export async function recentsMostRecent(): Promise<RecentEntry | null> {
  return invoke<RecentEntry | null>("recents_most_recent");
}

/// Parent folder of the last project the user created via "+ New project".
/// `null` on first launch — the UI falls back to the OS Documents
/// directory via `@tauri-apps/api/path::documentDir`.
export async function recentsLastNewProjectParent(): Promise<string | null> {
  return invoke<string | null>("recents_last_new_project_parent");
}

export async function recentsGetReopenOnLaunch(): Promise<boolean> {
  return invoke<boolean>("recents_get_reopen_on_launch");
}

export async function recentsSetReopenOnLaunch(value: boolean): Promise<void> {
  return invoke<void>("recents_set_reopen_on_launch", { value });
}

// ============================================================
// Keyboard-shortcut overrides
// ============================================================
//
// Per-user app-level overrides for the static defaults declared in
// `shortcuts/defs.ts`. Empty / missing entries inherit the default.
// An empty `keys` array means "explicitly unbound" — distinct from
// "use the default."

export type KeybindingsMap = Record<string, string[]>;

export async function keybindingsGet(): Promise<KeybindingsMap> {
  return invoke<KeybindingsMap>("keybindings_get");
}

export async function keybindingsSet(
  action: string,
  keys: string[],
): Promise<void> {
  return invoke<void>("keybindings_set", { action, keys });
}

export async function keybindingsResetAll(): Promise<void> {
  return invoke<void>("keybindings_reset_all");
}

export async function keybindingsExport(dest: string): Promise<void> {
  return invoke<void>("keybindings_export", { dest });
}

export async function keybindingsImport(src: string): Promise<KeybindingsMap> {
  return invoke<KeybindingsMap>("keybindings_import", { src });
}

// ============================================================
// Per-workspace view state (timeline zoom + per-track heights).
// Lives at `<workspace>/view.json`. Frontend reads on mount, writes
// debounced 200 ms after the last edit. Pre-workspace, get returns
// defaults and set silently no-ops.
// ============================================================

export interface ViewState {
  timeline_px_per_sec: number;
  track_heights: Record<string, number>;
}

export async function viewStateGet(): Promise<ViewState> {
  return invoke<ViewState>("view_state_get");
}

export async function viewStateSet(state: ViewState): Promise<void> {
  return invoke<void>("view_state_set", { state });
}

// ============================================================
// App-level settings (A/B-roll redesign, `docs/ab-roll-redesign`).
// Strict app-level scope: same value across every project. The pill /
// View menu / `T` shortcut all funnel through `appSettingsSet`. The
// backend emits `app_settings:changed` on every successful write so
// subscribers re-render without an extra round-trip.
// ============================================================

export type DisplayMode = "AbRoll" | "ShowAll";

export interface AppSettings {
  display_mode: DisplayMode;
  /// Half-width of the symmetric peek window in microseconds (default
  /// 10_000_000 = 10 s). Clamped server-side to [1 s, 5 min].
  delta_window_us: number;
  /// Remembered last-toggle of the left MediaPool drawer.
  media_pool_drawer_open: boolean;
}

/// Patch shape — every field optional. The backend merges into the
/// current settings, persists atomically, and returns the post-patch
/// snapshot. Use this for one-field flips (e.g., `{ display_mode: "ShowAll" }`)
/// instead of round-tripping the whole struct.
export interface AppSettingsPatch {
  display_mode?: DisplayMode;
  delta_window_us?: number;
  media_pool_drawer_open?: boolean;
}

export async function appSettingsGet(): Promise<AppSettings> {
  return invoke<AppSettings>("app_settings_get");
}

export async function appSettingsSet(
  patch: AppSettingsPatch,
): Promise<AppSettings> {
  return invoke<AppSettings>("app_settings_set", { patch });
}

export const APP_SETTINGS_EVENTS = {
  changed: "app_settings:changed",
} as const;

export async function projectRestoreCheckpoint(checkpointId: string): Promise<void> {
  return invoke<void>("project_restore_checkpoint", { checkpointId });
}

// ============================================================
// Agent session — view mode controlled by MCP. UI shows agent mode
// when `agent_session_get` returns Some(...); editor mode otherwise.
// The frontend ONLY exits (`agent_session_end`); entry is MCP-only.
// ============================================================

export interface AgentSession {
  client: string;
  reason: string;
  /// ISO 8601 timestamp from chrono::DateTime<Utc>.
  started_at: string;
}

export const AGENT_SESSION_EVENTS = {
  changed: "agent_session:changed",
} as const;

export async function agentSessionGet(): Promise<AgentSession | null> {
  return invoke<AgentSession | null>("agent_session_get");
}

export async function agentSessionEnd(): Promise<void> {
  return invoke<void>("agent_session_end");
}

// ============================================================
// Background import worker (Phase C.1 — workspace-redesign.md Q6)
// ============================================================

export type ImportStatus =
  | { kind: "Pending" }
  | { kind: "Copying" }
  | { kind: "Completed" }
  | { kind: "Failed"; detail: string }
  | { kind: "Cancelled" };

export interface ImportEntry {
  media_id: string;
  source: string;
  destination_rel: string | null;
  status: ImportStatus;
}

export const IMPORT_EVENTS = {
  queue: "import:queue",
  started: "import:started",
  complete: "import:complete",
  error: "import:error",
} as const;

/// Per-media derivative job events. Emitted by `jobs/{proxy,thumbnails,
/// waveform}.rs` so the UI can react to background generation finishing.
/// Phase C.3 uses started/complete/error to track an in-flight count for
/// a small "Generating derivatives…" indicator near the project bar.
export const MEDIA_JOB_EVENTS = {
  started: "media:job_started",
  complete: "media:job_complete",
  error: "media:job_error",
} as const;

export interface MediaJobEvent {
  media_id: string;
  kind: string;
}

export async function importQueueList(): Promise<ImportEntry[]> {
  return invoke<ImportEntry[]>("import_queue_list");
}

export async function importCancel(mediaId: string): Promise<boolean> {
  return invoke<boolean>("import_cancel", { mediaId });
}

export interface CompiledGraph {
  inputs: string[];
  filter_graph: string;
  maps: string[];
  node_count: number;
}

export async function compileProject(): Promise<CompiledGraph> {
  return invoke<CompiledGraph>("compile_project");
}

export async function importMedia(path: string): Promise<string> {
  return invoke<string>("import_media", { path });
}

export interface ExportProgress {
  progress: number;
  currentTimeUs: number;
  frame: number;
  fps: number;
  speed: number;
}

export interface ExportComplete {
  outputPath: string;
  durationUs: number;
}

export const EXPORT_EVENTS = {
  progress: "export:progress",
  complete: "export:complete",
  error: "export:error",
  queue: "export:queue",
} as const;

/// Phase H.7 — per-html-group raster progress (`docs/html-render-groups.md`).
/// Fired by `raster::html_group::materialize_group`; a future ExportPanel
/// extension subscribes to surface per-group progress next to the main
/// `export:progress` bar.
export const HTML_GROUP_EVENTS = {
  start: "html_group:start",
  progress: "html_group:progress",
  complete: "html_group:complete",
} as const;

export interface HtmlGroupStartEvent {
  groupId: string;
  frameCount: number;
  width: number;
  height: number;
  durationUs: number;
}

export interface HtmlGroupProgressEvent {
  groupId: string;
  frame: number;
  total: number;
}

export interface HtmlGroupCompleteEvent {
  groupId: string;
  frameCount: number;
  /// True when the rasterizer short-circuited via a cache hit — UI can
  /// distinguish "0 seconds" from "ran for real".
  cached: boolean;
}

/// Mirrors `ExportPreset` in `export/preset.rs`. Names match the Rust
/// variants so serde tagging works without rename rules.
export type ExportPreset =
  | "H264Mp4_1080p"
  | "H264Mp4_4K"
  | "ProResMov"
  | "Gif";

export const EXPORT_PRESETS: ExportPreset[] = [
  "H264Mp4_1080p",
  "H264Mp4_4K",
  "ProResMov",
  "Gif",
];

export function presetExtension(p: ExportPreset): string {
  switch (p) {
    case "H264Mp4_1080p":
    case "H264Mp4_4K":
      return "mp4";
    case "ProResMov":
      return "mov";
    case "Gif":
      return "gif";
  }
}

export async function exportProject(
  outputPath: string,
  preset?: ExportPreset,
): Promise<void> {
  return invoke<void>("export_project", { outputPath, preset });
}

/// Render the project synchronously into an OS temp MP4 and return
/// the path. Used by the DOM preview's "Render & Play" verification
/// path (`docs/preview-dom.md` Phase E). No `export:*` events fire.
export async function exportToTempPreview(): Promise<string> {
  return invoke<string>("export_to_temp_preview");
}

/// Delete a temp MP4 produced by `exportToTempPreview`. Safety-guarded
/// on the Rust side: only files matching the temp-render naming
/// convention under `std::env::temp_dir()` are removed.
export async function cleanupTempPreview(path: string): Promise<void> {
  return invoke<void>("cleanup_temp_preview", { path });
}

export type ExportQueueStatus =
  | { kind: "Pending" }
  | { kind: "Running" }
  | { kind: "Completed" }
  | { kind: "Failed"; detail: string }
  | { kind: "Cancelled" };

export interface ExportQueueItem {
  id: string;
  output_path: string;
  preset: ExportPreset;
  status: ExportQueueStatus;
}

export async function exportQueueEnqueue(
  outputPath: string,
  preset?: ExportPreset,
): Promise<string> {
  return invoke<string>("export_queue_enqueue", { outputPath, preset });
}

export async function exportQueueList(): Promise<ExportQueueItem[]> {
  return invoke<ExportQueueItem[]>("export_queue_list");
}

export async function exportQueueRemove(id: string): Promise<void> {
  return invoke<void>("export_queue_remove", { id });
}

export async function exportQueueClearFinished(): Promise<void> {
  return invoke<void>("export_queue_clear_finished");
}

export type HwEncoder =
  | "Nvenc"
  | "Qsv"
  | "Amf"
  | "VideoToolbox"
  | "Vaapi";

export interface HwEncoderProbe {
  available: HwEncoder[];
  recommended: HwEncoder | null;
}

export async function hwEncoderProbe(): Promise<HwEncoderProbe> {
  return invoke<HwEncoderProbe>("hw_encoder_probe");
}

export async function updateLayer(layerId: string, patch: LayerPatch): Promise<void> {
  return invoke<void>("update_layer", { layerId, patch });
}

export async function updateLayerParams(
  layerId: string,
  patch: LayerParamsPatch,
): Promise<void> {
  return invoke<void>("update_layer_params", { layerId, patch });
}

export async function addSubtitlesLayer(
  mediaId: string,
  tStartUs: number,
  durationUs: number,
): Promise<string> {
  return invoke<string>("add_subtitles_layer", {
    mediaId,
    tStartUs,
    durationUs,
  });
}

export async function moveLayer(
  layerId: string,
  newTrackId: string,
  newTStartUs: number,
  escapeGroup = false,
): Promise<void> {
  return invoke<void>("move_layer", {
    layerId,
    newTrackId,
    newTStartUs,
    escapeGroup,
  });
}

/** `docs/group-system.md` — group-aware trim. `edge` is `"in"` or `"out"`. */
export async function trimLayer(
  layerId: string,
  edge: "in" | "out",
  newTUs: number,
  escapeGroup = false,
): Promise<void> {
  return invoke<void>("trim_layer", {
    layerId,
    edge,
    newTUs,
    escapeGroup,
  });
}

export async function splitLayerGrouped(
  layerId: string,
  atTUs: number,
  escapeGroup = false,
): Promise<[string, string]> {
  return invoke<[string, string]>("split_layer_grouped", {
    layerId,
    atTUs,
    escapeGroup,
  });
}

/** `docs/group-system.md` — bundle ≥2 layer ids into a group. */
export async function groupsCreate(
  layerIds: string[],
  label: string | null = null,
  reassign = false,
): Promise<string> {
  return invoke<string>("groups_create", {
    layerIds,
    label,
    reassign,
  });
}

export async function groupsDissolve(groupId: string): Promise<void> {
  return invoke<void>("groups_dissolve", { groupId });
}

/// V.7: lift an Audio layer onto a freshly-created non-transient
/// track inserted directly after its source. Group membership
/// survives. Returns the new track's id. UI consequence: V.6's
/// combined-row collapses to V-only on the source row; the new row
/// below shows the waveform on its own (J/L-cut friendly).
export async function separateAudioToNewTrack(
  layerId: string,
): Promise<string> {
  return invoke<string>("separate_audio_to_new_track", { layerId });
}

export async function duplicateLayer(
  layerId: string,
  tOffsetUs: number,
): Promise<string> {
  return invoke<string>("duplicate_layer", { layerId, tOffsetUs });
}

export async function deleteLayer(layerId: string): Promise<void> {
  return invoke<void>("delete_layer", { layerId });
}

export async function mpvPlayFile(path: string): Promise<void> {
  return invoke<void>("mpv_play_file", { path });
}

/// Open a libmpv popup window for the given media item. Used by the
/// media-pool play button. Survives Phase D — it's a standalone OS
/// window (no z-order conflict with the DOM `<video>` element), so it
/// keeps libmpv only for that single isolated use.
export async function mpvPlayMedia(mediaId: string): Promise<void> {
  return invoke<void>("mpv_play_media", { mediaId });
}

export interface McpInfoView {
  bind: string;
  sse_url: string;
  message_url: string;
  events_url: string;
  bearer_token: string;
}

/// Returns the live MCP server connection details, or `null` if the server is
/// still starting. Used by the connect-agent panel.
export async function getMcpInfo(): Promise<McpInfoView | null> {
  return invoke<McpInfoView | null>("get_mcp_info");
}

/// Regenerate the bearer token. The server stays bound on the same port —
/// only the token rotates. Persists to `mcp_auth.json` so the next launch
/// reuses the new token. Returns the fresh token so the panel can update
/// without a follow-up `getMcpInfo` call.
export async function resetMcpToken(): Promise<string> {
  return invoke<string>("reset_mcp_token");
}

export interface ApiKeyStatus {
  provider: string;
  label: string;
  configured: boolean;
}

export async function settingsGetApiKeyStatus(): Promise<ApiKeyStatus[]> {
  return invoke<ApiKeyStatus[]>("settings_get_api_key_status");
}

export async function settingsSetApiKey(provider: string, key: string): Promise<void> {
  return invoke<void>("settings_set_api_key", { provider, key });
}

export async function settingsClearApiKey(provider: string): Promise<void> {
  return invoke<void>("settings_clear_api_key", { provider });
}

export interface ConnectionTestInfo {
  /// The provider tag the result is attributed to (matches `ApiKeyStatus.provider`).
  provider: string;
  /// One-line success summary for the user.
  summary: string;
}

/// Run a cheap smoke check against the configured provider key. Resolves with
/// a structured info object on success; rejects with the structured cloud
/// error message (MissingKey / InvalidKey / RateLimited / ...) so the UI can
/// render it inline.
export async function settingsTestProvider(
  provider: string,
): Promise<ConnectionTestInfo> {
  return invoke<ConnectionTestInfo>("settings_test_provider", { provider });
}

export interface WaveformPeaks {
  /// One f32 in [0.0, 1.0] per peak window; max-abs over `1 / peaks_per_second`
  /// of source audio. Resolves rejected with the literal string "not_ready" if
  /// the waveform job hasn't finished — the caller should retry on the
  /// matching `media:job_complete` event.
  peaks: number[];
  peaks_per_second: number;
}

export async function getWaveformPeaks(mediaId: string): Promise<WaveformPeaks> {
  return invoke<WaveformPeaks>("get_waveform_peaks", { mediaId });
}

/// Returns a `data:image/jpeg;base64,...` URL for the middle thumbnail of a
/// video media item. Rejects with "not_ready" if the thumbnails job is still
/// running.
export async function getMediaThumbnail(mediaId: string): Promise<string> {
  return invoke<string>("get_media_thumbnail", { mediaId });
}

// ============================================================
// Templates (Stage F + Stage F-Picker)
// ============================================================

/// Discriminated union mirroring `raster::template::PropSpec`. The picker
/// switches on `type` to render the right input. New prop types must be
/// added here AND in the picker's form generator.
export type PropSpec =
  | { type: "string"; default: string; max_length?: number }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number };

/// One catalog entry from `list_templates()`. Superset of the MCP `list_templates`
/// payload — `Manifest` plus the raw `html` / `style` strings so the picker
/// can render live iframe previews without a second round-trip.
export interface TemplateSummary {
  id: string;
  name: string;
  version: number;
  /// `[width, height]` in pixels — the webview size the rasterizer uses.
  size: [number, number];
  default_duration_s: number;
  /// Keyed by prop name. Map order is BTreeMap-stable (alphabetical) so the
  /// picker can render fields in a deterministic order without sorting.
  props_schema: Record<string, PropSpec>;
  /// Raw template HTML with the `__STYLE__` placeholder still present —
  /// substitute the `style` field in to render a preview iframe.
  html: string;
  /// Raw template CSS substituted into the `__STYLE__` placeholder in `html`.
  style: string;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  return invoke<TemplateSummary[]>("list_templates");
}

/// Add a template layer. Mirrors the MCP `add_template` tool's behavior:
/// - `t_end_us` defaults to `t_start_us + default_duration_s * 1e6`.
/// - `track_id` defaults to first existing Video track or auto-creates
///   one labeled "Templates".
/// - `props` is validated against the template's `props_schema`; unknown
///   keys reject, missing keys fall back to defaults.
export async function addTemplate(args: {
  templateId: string;
  tStartUs: number;
  tEndUs?: number;
  trackId?: string;
  props?: Record<string, unknown>;
}): Promise<string> {
  return invoke<string>("add_template", {
    templateId: args.templateId,
    tStartUs: args.tStartUs,
    tEndUs: args.tEndUs,
    trackId: args.trackId,
    props: args.props,
  });
}

/// Render a static PNG thumbnail of a template at its manifest defaults.
/// Returns a `data:image/png;base64,…` URL ready to drop into `<img src>`.
/// First call per template is ~200–700ms (cold cache + offscreen webview
/// render); subsequent calls hit the content-keyed raster cache and are
/// near-instant. Pixel-accurate to what ffmpeg emits at render time.
export async function templatePreview(templateId: string): Promise<string> {
  const b64 = await invoke<string>("template_preview", { templateId });
  return `data:image/png;base64,${b64}`;
}

/// Phase H.0 transparency probe — drives the export-side raster mount
/// (offscreen webview navigates to the half-transparent-red probe
/// document, captures, returns PNG bytes). The dev `#html-group-spike`
/// page calls this, decodes the PNG into a canvas, reads the center
/// pixel, and asserts vs. PROBE_TARGET. See
/// `docs/html-render-groups.md` decision 12.
export interface HtmlGroupProbeResult {
  /// PNG bytes from `CapturePreview`, base64-encoded.
  pngBase64: string;
  width: number;
  height: number;
}

export async function htmlGroupProbeTransparency(): Promise<HtmlGroupProbeResult> {
  return invoke<HtmlGroupProbeResult>("html_group_probe_transparency");
}

// ============================================================
// Status / log surface (see `docs/status-log-system.md`)
// ============================================================

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogCategory =
  | { kind: "Shortcut" }
  | { kind: "Mcp" }
  | { kind: "Job" }
  | { kind: "Export" }
  | { kind: "Import" }
  | { kind: "Project" }
  | { kind: "System" }
  | { kind: "Agent" }
  | { kind: "Other"; name: string };

export type LogSource =
  | { kind: "User" }
  | { kind: "Agent"; client: string }
  | { kind: "System" };

export type OpState =
  | { state: "Started"; progress?: null }
  | { state: "Progress"; progress: number }
  | { state: "Ok"; progress?: null }
  | { state: "Err"; progress?: null };

export interface LogEntry {
  id: string;
  ts: string;
  level: LogLevel;
  category: LogCategory;
  source: LogSource;
  message: string;
  i18n_key?: string | null;
  i18n_args?: unknown;
  op_id?: string | null;
  op_state?: OpState | null;
  details?: unknown;
}

export type LogEntryInput = Omit<LogEntry, "id" | "ts">;

export const LOG_EVENTS = {
  entry: "log:entry",
} as const;

export async function logList(): Promise<LogEntry[]> {
  return invoke<LogEntry[]>("log_list");
}

export async function logClear(): Promise<void> {
  return invoke<void>("log_clear");
}

export async function logEmit(input: LogEntryInput): Promise<void> {
  return invoke<void>("log_emit", { input });
}

export async function logDirPath(): Promise<string | null> {
  return invoke<string | null>("log_dir_path");
}
