import { invoke } from "@tauri-apps/api/core";

import type { ExportSettings } from "../render/exportSettings";
import type {
  TemplateEngine,
  TemplateFont,
} from "../render/templates/catalog";

export interface CompositionSummary {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
  /// True when the user has explicitly set the composition duration via
  /// `set_composition { duration_us }`. While pinned, layer edits no
  /// longer mutate `duration_us` (except the `>= max(layer.t_end_us)`
  /// overflow guard). `fit_composition_to_layers` clears it.
  duration_pinned: boolean;
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
  /// Preview-only fast proxy. Export must not use this path.
  quick_proxy_path: string | null;
  /// True when the original workspace copy can be decoded directly.
  proxy_bypassed: boolean;
  /// True when export may decode the original directly (preview still uses a
  /// generated proxy). Export and preview resolvers treat it like a bypass.
  export_uses_original: boolean;
  /// Source video codec ("h264"/"hevc"/"prores"/…), null for audio/image.
  codec: string | null;
  /// Source pixel format ("yuv420p"/"yuv420p10le"/…), null for audio/image.
  pix_fmt: string | null;
  /// ffprobe color tags (color_space/range/primaries/transfer) surfaced from the
  /// source bitstream + container. Used to decode the ORIGINAL with its real
  /// matrix/range on DirectExport (see `ffprobeColorToWebCodecs`). Optional:
  /// older summaries / test fixtures omit them; the resolution default fills in.
  color_matrix?: string | null;
  color_range?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
}

export interface LayerSummary {
  id: string;
  label: string | null;
  /// Inclusive start of the layer's display interval, in composition µs.
  /// Snapped to the comp-frame grid by the actor on every mutation.
  t_start_us: number;
  /// EXCLUSIVE end of the layer's display interval, in composition µs.
  /// The half-open interval is `[t_start_us, t_end_us)` — the layer is
  /// active at composition time `t` iff `t_start_us ≤ t < t_end_us`.
  ///
  /// This is a *boundary*, NOT a frame anchor. For a layer covering the
  /// entire 10 s 30 fps comp, `t_end_us = 10_000_000` (the boundary
  /// after frame 299, not frame 299's own anchor at 9_966_667). The
  /// playhead, which IS a frame anchor, can never reach `t_end_us` —
  /// its upper bound is `lastFrameAnchorUs` in `frames.ts`. See
  /// `docs/data-model.md` for the boundary-vs-anchor distinction.
  t_end_us: number;
  kind: string;
  color_hint: string;
  enabled: boolean;
  locked: boolean;
  params: LayerParamsView;
  /// Per-layer effect chain. Inside an html-render group, an enabled
  /// `HtmlTransform` here composes on top of the layer's static
  /// transform from `params` at every composition tick.
  effects: Effect[];
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
  /// template manifest's `props_schema`. Passed verbatim to the template's
  /// `render(t, dur, props)` entry inside the sandboxed capture iframe (via
  /// postMessage; see `render/templates/harness.ts`).
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
  /// Composition length as an EXCLUSIVE boundary; timeline interval is
  /// `[0, duration_us)`. NOT a frame anchor — see `t_end_us` on
  /// `LayerSummary` for the long version. The playhead's upper bound
  /// is `lastFrameAnchorUs(duration_us, fpsNum, fpsDen)`.
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
  | { kind: "Blur"; radius: AnimTrack<number> }
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

export interface TemplatePatch {
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  opacity?: number;
  /// Props to merge FIELD-WISE into the layer's existing `props` map — each
  /// key present here overwrites that key; absent keys are left intact. The
  /// backend merges (never replaces the whole map) so a stale debounced commit
  /// can't clobber a concurrent edit. Values are passed verbatim; the property
  /// panel types them per the template's `props_schema` (`number` / hex
  /// `string` / `string`), so no further validation happens on this path.
  props?: Record<string, unknown>;
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
  | ({ kind: "Template" } & TemplatePatch)
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

export async function exportSettingsGet(): Promise<ExportSettings | null> {
  const v = await invoke<ExportSettings | null>("export_settings_get");
  return v ?? null;
}

export async function exportSettingsSet(
  settings: ExportSettings,
): Promise<void> {
  return invoke<void>("export_settings_set", { settings });
}

/// Absolute path of the current workspace (project) directory, or null when no
/// project is open. Used to default the export output location.
export async function workspaceDir(): Promise<string | null> {
  const v = await invoke<string | null>("workspace_dir");
  return v ?? null;
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
  /// Snap moved timeline layers to nearby layer boundaries and playhead.
  tail_snap_enabled: boolean;
  /// Pixel threshold for boundary snapping. Clamped server-side.
  tail_snap_strength_px: number;
}

/// Patch shape — every field optional. The backend merges into the
/// current settings, persists atomically, and returns the post-patch
/// snapshot. Use this for one-field flips (e.g., `{ display_mode: "ShowAll" }`)
/// instead of round-tripping the whole struct.
export interface AppSettingsPatch {
  display_mode?: DisplayMode;
  delta_window_us?: number;
  media_pool_drawer_open?: boolean;
  tail_snap_enabled?: boolean;
  tail_snap_strength_px?: number;
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

export async function importMedia(path: string): Promise<string> {
  return invoke<string>("import_media", { path });
}

/// Audio encode parameters. `sampleRate`/`channels` are null to follow the
/// composition. Mirrors Rust `AudioEncodeSpec` (serde camelCase).
export interface AudioExportSpec {
  codec: "aac" | "opus";
  bitrate: number;
  sampleRate: number | null;
  channels: number | null;
}

/// Audio-only export at `outputPath` (extension picks the muxer: .m4a for AAC,
/// .mka for Opus). `range` trims the audio to the export window (null = whole
/// project). Awaitable; emits no events.
export async function exportProjectAudioOnly(
  outputPath: string,
  audio: AudioExportSpec,
  range: { startUs: number; endUs: number } | null,
): Promise<void> {
  return invoke<void>("export_project_audio_only", {
    outputPath,
    audio,
    startUs: range?.startUs ?? null,
    endUs: range?.endUs ?? null,
  });
}

/// Optional video transcode spec for the ffmpeg export path. Omit for a
/// stream-copy mux.
export interface TranscodeSpec {
  videoCodec: "h264" | "av1" | "hevc" | "vp9";
  bitrate: number;
  cbr: boolean;
  durationUs: number;
  /// Frames between keyframes for the ffmpeg `-g` (matches the WebCodecs GOP).
  gop: number;
  /// Force a software ffmpeg encoder (libx265/libsvtav1/…) instead of HW-first.
  software: boolean;
}

/// Tauri event emitted (0.0..=1.0) while ffmpeg transcodes the video.
export const EXPORT_TRANSCODE_PROGRESS = "export:transcode_progress";

/// Mux `video` + `audio` into `output`. With `transcode`, re-encodes the
/// video to the target codec (HW-first) instead of stream-copying.
export async function muxExport(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  transcode?: TranscodeSpec,
): Promise<void> {
  return invoke<void>("mux_export", {
    videoPath,
    audioPath,
    outputPath,
    transcode: transcode ?? null,
  });
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

// groupsSetEffects / layersSetEffects deleted in P12-a — the Pixi
// renderer doesn't read effects in v1, so the mutation surface for
// them is gone. The `effects: Effect[]` field on `LayerSummary` /
// `GroupSummary` (above) stays alive until P12-b sweeps the IR visual
// half; legacy DOM preview consumers continue to read it (always
// empty now since nothing can write).

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

export interface CompositionPatchPartial {
  width?: number;
  height?: number;
  fps?: { num: number; den: number };
  duration_us?: number;
  sample_rate?: number;
  channels?: number;
}

/// Update one or more composition fields. Setting `duration_us` pins
/// the composition duration — call `fitCompositionToLayers()` to clear
/// the pin and resume auto-fit. See ADR 0005.
export async function setComposition(
  patch: CompositionPatchPartial,
): Promise<void> {
  return invoke<void>("set_composition", { patch });
}

/// Clear the composition's duration pin and snap `duration_us` to the
/// layer high-water mark. After this call, subsequent layer edits
/// track duration bidirectionally.
export async function fitCompositionToLayers(): Promise<void> {
  return invoke<void>("fit_composition_to_layers");
}

// mpvPlayFile / mpvPlayMedia were the media-pool "click to preview a
// raw clip" surface. Deleted in P12-d alongside the libmpv module.

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

/// Ask the backend to generate the full export proxy for a media item
/// (decode-failure recovery / per-clip generate). Idempotent on the backend.
export async function ensureFullProxy(mediaId: string): Promise<void> {
  await invoke("ensure_full_proxy", { mediaId });
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
/// payload — `Manifest` plus the raw `html` document + capture `engine` + font
/// declarations so the picker can render live previews without a second
/// round-trip.
export interface TemplateSummary {
  id: string;
  name: string;
  version: number;
  /// `[width, height]` in pixels — the document size the capture engine uses.
  size: [number, number];
  default_duration_s: number;
  /// Keyed by prop name. Map order is BTreeMap-stable (alphabetical) so the
  /// picker can render fields in a deterministic order without sorting.
  props_schema: Record<string, PropSpec>;
  /// How the template's frames are captured (defaults to `"svg"`).
  engine: TemplateEngine;
  /// Raw, self-contained template HTML document (SVG markup + inline
  /// `render()` script for the `"svg"` engine).
  html: string;
  /// Fonts the template bundles. Empty for built-ins using system fonts.
  fonts: TemplateFont[];
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
  // Explicit `| undefined` so callers can pass an "auto track" undefined
  // through under `exactOptionalPropertyTypes`.
  trackId?: string | undefined;
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
