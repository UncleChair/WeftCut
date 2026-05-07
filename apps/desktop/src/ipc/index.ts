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
} as const;

export async function exportProject(outputPath: string): Promise<void> {
  return invoke<void>("export_project", { outputPath });
}

export async function updateLayer(layerId: string, patch: LayerPatch): Promise<void> {
  return invoke<void>("update_layer", { layerId, patch });
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
