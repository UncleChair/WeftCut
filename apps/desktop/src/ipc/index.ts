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
  | { kind: "Template"; template_id: string };

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

export interface TrackSummary {
  id: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  locked: boolean;
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

export async function projectSaveAs(path: string): Promise<void> {
  return invoke<void>("project_save_as", { path });
}

export async function projectOpen(path: string): Promise<void> {
  return invoke<void>("project_open", { path });
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
): Promise<void> {
  return invoke<void>("move_layer", {
    layerId,
    newTrackId,
    newTStartUs,
  });
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

export async function mpvPlayMedia(mediaId: string): Promise<void> {
  return invoke<void>("mpv_play_media", { mediaId });
}

export async function mpvSeek(tUs: number): Promise<void> {
  return invoke<void>("mpv_seek", { tUs });
}

export async function mpvSetPaused(paused: boolean): Promise<void> {
  return invoke<void>("mpv_set_paused", { paused });
}

export interface MpvPreviewStatus {
  primary: string | null;
  external_count: number;
  has_video: boolean;
  has_audio: boolean;
  graph_len: number;
}

/// Compile the current project to a libmpv `lavfi-complex` graph and load it
/// in the preview window. After this call, every project commit hot-reloads
/// the graph automatically (see `lib.rs` setup).
export async function mpvPreviewProject(): Promise<MpvPreviewStatus> {
  return invoke<MpvPreviewStatus>("mpv_preview_project");
}

/// Close the libmpv preview window and drop the player handle.
export async function mpvClosePreview(): Promise<void> {
  return invoke<void>("mpv_close_preview");
}

/// Reposition the embed host HWND so it tracks the React `#video-surface`
/// placeholder. Coordinates are physical pixels — the caller is responsible
/// for multiplying CSS-px `getBoundingClientRect()` by `devicePixelRatio`
/// before invoking. No-op on non-Windows builds.
export async function mpvSetSurfaceRect(
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  return invoke<void>("mpv_set_surface_rect", { x, y, w, h });
}

/// Toggle the embed host HWND's visibility. Use for full-screen overlays
/// (modal panels) that cover most of the preview pane. For partial
/// overlays like dropdown menus, prefer `mpvSetHostClip` so the preview
/// keeps showing around the overlay.
/// No-op on non-Windows builds.
export async function mpvSetHostVisible(visible: boolean): Promise<void> {
  return invoke<void>("mpv_set_host_visible", { visible });
}

/// Punch a rectangular hole in the embed host HWND so WebView2 shows
/// through there. Pass `null` to restore the full host. Coordinates are
/// physical pixels (CSS px × devicePixelRatio), same coord space as
/// `mpvSetSurfaceRect`. No-op on non-Windows builds.
export async function mpvSetHostClip(
  rect: { x: number; y: number; w: number; h: number } | null,
): Promise<void> {
  return invoke<void>("mpv_set_host_clip", {
    x: rect?.x ?? null,
    y: rect?.y ?? null,
    w: rect?.w ?? null,
    h: rect?.h ?? null,
  });
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
