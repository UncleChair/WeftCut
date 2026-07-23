// apps/desktop/src/main/state/model.ts
import type { IdGen } from './ids'
import type { DecodeRoute } from '../../shared/decode-route'

export const SCHEMA_VERSION = 10

export type Uuid = string
export type TimeUs = number
export interface Rational { num: number; den: number }
export interface Rgba { r: number; g: number; b: number; a: number }
export type ColorSpace = 'Bt709' | 'Bt601' | 'Bt2020' | 'SRgb'
export type AudioRole = 'dialogue' | 'music' | 'sfx' | 'voiceover'
export type TrackRole = 'ARoll' | 'BRoll' | 'AudioA' | 'AudioB' | 'Caption'
export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten' | 'Add' | 'Difference'

export type Interpolation =
  | { kind: 'Hold' } | { kind: 'Linear' } | { kind: 'EaseIn' } | { kind: 'EaseOut' }
  | { kind: 'Bezier'; p1: [number, number]; p2: [number, number] }
export interface Keyframe<T> { id: Uuid; t_us: TimeUs; value: T; interp: Interpolation }
export type Animated<T> = { mode: 'Static'; value: T } | { mode: 'Keyframed'; value: Keyframe<T>[] }

export interface Transform {
  x: Animated<number>; y: Animated<number>
  scale_x: Animated<number>; scale_y: Animated<number>
  rotation_deg: Animated<number>
  anchor: [number, number]
}
export interface Rect { x: number; y: number; w: number; h: number }

export interface FontSpec { family: string; size_px: number; weight: number; italic: boolean }
export type TextAlign = 'Left' | 'Center' | 'Right'
export interface Shadow { color: Rgba; offset_x: number; offset_y: number; blur: number }
export interface Outline { color: Rgba; width: number }
export type TextAnimPreset = 'FadeIn' | 'FadeOut' | 'SlideUp' | 'SlideDown' | 'Typewriter'
export type TextBackend = 'Auto' | 'DrawText' | 'Rasterized'

export interface VideoClipParams {
  kind: 'VideoClip'; media: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  transform: Transform; opacity: Animated<number>; crop: Rect | null
  flip_h: boolean; flip_v: boolean; blend_mode: BlendMode; speed: number
  fade_in_us: number; fade_out_us: number
}
export interface ImageOverlayParams {
  kind: 'ImageOverlay'; media: Uuid; transform: Transform; opacity: Animated<number>
  blend_mode: BlendMode; fade_in_us: number; fade_out_us: number
}
export interface TextParams {
  kind: 'Text'; content: string; font: FontSpec; color: Animated<Rgba>; align: TextAlign
  transform: Transform; opacity: Animated<number>; shadow: Shadow | null; outline: Outline | null
  intro: TextAnimPreset | null; outro: TextAnimPreset | null; backend_hint: TextBackend
}
export interface MotifParams {
  kind: 'Motif'; motif_id: string; motif_version: number; props: Record<string, unknown>
  src_in_us: TimeUs; transform: Transform; opacity: Animated<number>
}
export interface MotifRebindEntry {
  layer_id: string; motif_id: string; motif_version: number; props: Record<string, unknown>
}
export interface AudioParams {
  kind: 'Audio'; media: Uuid; src_in_us: TimeUs; src_out_us: TimeUs
  gain_db: Animated<number>; pan: Animated<number>
  fade_in_us: number; fade_out_us: number; mute: boolean; role: AudioRole
}
export interface ColorParams { kind: 'Color'; color: Animated<Rgba>; width: number; height: number }
export type LayerParams =
  | VideoClipParams | ImageOverlayParams | TextParams | MotifParams | AudioParams | ColorParams

export interface Effect { id: Uuid; kind: string; enabled: boolean; params: Record<string, Animated<number>> }
export interface Layer {
  id: Uuid; label: string | null; t_start_us: TimeUs; t_end_us: TimeUs
  enabled: boolean; locked: boolean; metadata: Record<string, unknown>
  params: LayerParams; effects: Effect[]
}
export interface Track {
  id: Uuid; label: string | null; enabled: boolean; locked: boolean
  muted: boolean; solo: boolean; removable: boolean; role: TrackRole | null
  transient: boolean; height_px: number; layers: Layer[]
}
export interface Composition {
  width: number; height: number; fps: Rational; duration_us: TimeUs; duration_pinned: boolean
  sample_rate: number; channels: number; color_space: ColorSpace; background: Rgba
}
export interface Marker { id: Uuid; t_us: TimeUs; end_t_us: TimeUs | null; label: string; color: Rgba; metadata: Record<string, unknown> }
/** Motion direction, not reveal side — semantics in native/src/state/transition.rs (the serde twin). */
export type TransitionDirection = 'left' | 'right' | 'up' | 'down'
export type TransitionKind =
  | { kind: 'Crossfade' }
  | { kind: 'Wipe'; direction: TransitionDirection }
  | { kind: 'Slide'; direction: TransitionDirection }
export interface Transition { id: Uuid; from_layer: Uuid; to_layer: Uuid; duration_us: TimeUs; kind: TransitionKind }
/** `members` kept sorted; `label` omitted (not null) when absent — see serialize.ts. */
export interface Group { id: Uuid; label?: string; members: Uuid[] }
export interface RoleMixSettings { gain_db: number; muted: boolean; solo: boolean }
export interface MediaVideoMetadata {
  width?: number; height?: number; fps_num?: number; fps_den?: number
  codec?: string; pix_fmt?: string; start_pts_us?: TimeUs | null
  nb_frames?: number | null; [k: string]: unknown
}
export interface MediaAudioMetadata {
  sample_rate?: number; channels?: number; codec?: string
  start_pts_us?: TimeUs | null; [k: string]: unknown
}
export interface MediaMetadata {
  /** Normalized content duration; timeline source windows use this domain. */
  duration_us: TimeUs | null
  /** Earliest container PTS that maps to content time 0, when known. */
  start_pts_us?: TimeUs | null
  /** Raw ffprobe duration before subtracting start offset, for diagnostics. */
  container_duration_us?: TimeUs | null
  video?: MediaVideoMetadata | null
  audio?: MediaAudioMetadata | null
  container_format?: string | null
  [k: string]: unknown
}
export interface MediaItem {
  id: Uuid; label: string | null; path_abs: string; path_rel: string | null; kind: 'Video' | 'Audio' | 'Image' | 'Subtitle'
  metadata: MediaMetadata; file_hash_blake3: string; file_size: number; file_mtime: number
  imported_at: string
  /** Where preview/export decode from + proxy readiness. Mirrors Rust
   *  `MediaItem.decode_route`; see ../../shared/decode-route. */
  decode_route: DecodeRoute
  conform_path: string | null; waveform_path: string | null; thumbnails_dir: string | null
}
export interface ProjectMetadata { name: string; created_at: string; modified_at: string; description: string | null }
export interface ProjectSettings {
  preview_width: number; preview_height: number; autosave_interval_secs: number | null
  history_capacity: number; auto_pair_audio_on_import: boolean; auto_delete_empty_tracks: boolean
  prefer_proxies: boolean
  proxy_overrides: Record<string, boolean>
}
export interface Project {
  schema_version: number; project_id: Uuid; metadata: ProjectMetadata; composition: Composition
  media_pool: Record<string, MediaItem>; tracks: Track[]; markers: Marker[]
  transitions: Transition[]; groups: Group[]; audio_roles: Record<string, RoleMixSettings>
  settings: ProjectSettings
}

function newTrack(id: Uuid, label: string, role: TrackRole): Track {
  return { id, label, enabled: true, locked: false, muted: false, solo: false,
    removable: false, role, transient: false, height_px: 64, layers: [] }
}
function defaultComposition(): Composition {
  return { width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 0,
    duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709',
    background: { r: 0, g: 0, b: 0, a: 255 } }
}
export function defaultSettings(): ProjectSettings {
  return { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
    history_capacity: 200, auto_pair_audio_on_import: true, auto_delete_empty_tracks: true,
    prefer_proxies: false, proxy_overrides: {} }
}

/** Mirror of Rust `Project::new_blank`. Id order: A-roll, B-roll, project_id. */
export function blankProject(idGen: IdGen, name: string): Project {
  const aRoll = newTrack(idGen(), 'A roll', 'ARoll')
  const bRoll = newTrack(idGen(), 'B roll', 'BRoll')
  const projectId = idGen()
  // LANDMINE: real RFC3339 timestamps, NOT the '<TS>' sentinel. canonicalize()
  // normalizes these away for differential comparison, so a sentinel would pass
  // the gates — but this JSON still round-trips through Rust `DateTime<Utc>`
  // deserialization (`serde_json::from_str::<Project>`) in the export-audio
  // channels and the `project://compiled` MCP resource, which reject a
  // non-timestamp. Mirrors Rust `Project::new_blank`'s `Utc::now()`.
  const now = new Date().toISOString()
  return {
    schema_version: SCHEMA_VERSION, project_id: projectId,
    metadata: { name, created_at: now, modified_at: now, description: null },
    composition: defaultComposition(), media_pool: {}, tracks: [aRoll, bRoll],
    markers: [], transitions: [], groups: [], audio_roles: {}, settings: defaultSettings(),
  }
}
