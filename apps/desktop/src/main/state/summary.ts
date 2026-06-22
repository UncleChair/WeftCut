// apps/desktop/src/main/state/summary.ts
import type { Animated, Layer, LayerParams, MediaItem, Outline, Rgba, Shadow, TextAlign, Track, Uuid } from './model'

// ── per-kind view structs (mirror commands/mod.rs:150-238; field names verbatim) ──
export interface VideoClipView {
  kind: 'VideoClip'; media_id: string; media_label: string; src_in_us: number; src_out_us: number
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; opacity: Animated<number>
  speed: number; flip_h: boolean; flip_v: boolean; fade_in_us: number; fade_out_us: number
}
export interface ImageOverlayView {
  kind: 'ImageOverlay'; media_id: string; media_label: string
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; opacity: Animated<number>
  fade_in_us: number; fade_out_us: number
}
export interface TextView {
  kind: 'Text'; content: string; font_family: string; font_size_px: number; weight: number; italic: boolean
  color: Animated<Rgba>; align: TextAlign; x: Animated<number>; y: Animated<number>; anchor_x: number; anchor_y: number
  opacity: Animated<number>; shadow: Shadow | null; outline: Outline | null
}
export interface ColorView { kind: 'Color'; color: Animated<Rgba>; width: number; height: number }
export interface AudioView {
  kind: 'Audio'; media_id: string; media_label: string; src_in_us: number; src_out_us: number
  gain_db: Animated<number>; pan: Animated<number>; fade_in_us: number; fade_out_us: number; mute: boolean; role: string
}
export interface MotifView {
  kind: 'Motif'; motif_id: string
  x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; opacity: Animated<number>
  src_in_us: number; props: Record<string, unknown>
}
export type LayerParamsView = VideoClipView | ImageOverlayView | TextView | ColorView | AudioView | MotifView

/** commands/mod.rs:586 layer_kind — the LayerParams discriminant. */
export function layerKind(params: LayerParams): string { return params.kind }

/** commands/mod.rs:607 derive_track_kind_label — visual-class wins; audio-only →
 *  "Audio"; empty → "Video" (so blank A/B-roll rows still style as video lanes). */
export function deriveTrackKindLabel(track: Track): string {
  let hasVisual = false, hasAudio = false
  for (const l of track.layers) {
    if (l.params.kind === 'Audio') hasAudio = true
    else hasVisual = true // VideoClip | ImageOverlay | Color | Motif | Text
  }
  if (hasVisual) return 'Video'
  if (hasAudio) return 'Audio'
  return 'Video'
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** commands/mod.rs:647 hsl_to_hex. Plain f64 (cosmetic; only hue 0 is gated — see
 *  the color-hint landmine in the plan). h is a non-negative integer hue. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r: number, g: number, b: number
  const hi = Math.trunc(h)
  if (hi <= 59) { r = c; g = x; b = 0 }
  else if (hi <= 119) { r = x; g = c; b = 0 }
  else if (hi <= 179) { r = 0; g = c; b = x }
  else if (hi <= 239) { r = 0; g = x; b = c }
  else if (hi <= 299) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const ch = (v: number) => clamp(Math.round((v + m) * 255), 0, 255)
  return `#${hex2(ch(r))}${hex2(ch(g))}${hex2(ch(b))}`
}

function rgbaHex(c: Rgba): string { return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` }

/** commands/mod.rs:629 layer_color_hint — Color clip → its exact rgba (Static, or
 *  the first keyframe value, BLACK if none); else a stable hue from the uuid's
 *  first two bytes (hex-parsed from the UUID string). */
export function layerColorHint(layer: Layer): string {
  if (layer.params.kind === 'Color') {
    const a = layer.params.color
    const rgba = a.mode === 'Static' ? a.value : (a.value[0]?.value ?? { r: 0, g: 0, b: 0, a: 255 })
    return rgbaHex(rgba)
  }
  const hex = layer.id.replace(/-/g, '')
  const b0 = parseInt(hex.slice(0, 2), 16), b1 = parseInt(hex.slice(2, 4), 16)
  const hue = ((b0 << 8) | b1) % 360
  return hslToHex(hue, 0.55, 0.55)
}

/** commands/mod.rs:430 marker color_hint — `#rrggbb`. */
export function markerColorHint(c: Rgba): string { return rgbaHex(c) }

/** commands/mod.rs:333 media label — explicit label, else path basename, else the
 *  whole path. Mirrors the `or_else`/`unwrap_or_else` chain. */
export function mediaLabel(item: MediaItem): string {
  if (item.label) return item.label
  const p = item.path_abs
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = slash >= 0 ? p.slice(slash + 1) : p
  return base.length > 0 ? base : p
}

function mediaLabelFor(id: Uuid, pool: Record<Uuid, MediaItem>): string {
  const m = pool[id]
  return m ? mediaLabel(m) : id
}

/** commands/mod.rs:487 layer_params_view — kind-matched UI projection. NOTE: the
 *  Motif arm is unit-tested only (no Motif layers in the corpus), matching Rust. */
export function layerParamsView(params: LayerParams, pool: Record<Uuid, MediaItem>): LayerParamsView {
  switch (params.kind) {
    case 'VideoClip': {
      const t = params.transform
      return { kind: 'VideoClip', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        src_in_us: params.src_in_us, src_out_us: params.src_out_us, x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y,
        opacity: params.opacity, speed: params.speed, flip_h: params.flip_h, flip_v: params.flip_v,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us }
    }
    case 'ImageOverlay': {
      const t = params.transform
      return { kind: 'ImageOverlay', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y, opacity: params.opacity,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us }
    }
    case 'Text': {
      const t = params.transform
      return { kind: 'Text', content: params.content, font_family: params.font.family, font_size_px: params.font.size_px,
        weight: params.font.weight, italic: params.font.italic, color: params.color, align: params.align,
        x: t.x, y: t.y, anchor_x: t.anchor[0], anchor_y: t.anchor[1], opacity: params.opacity,
        shadow: params.shadow, outline: params.outline }
    }
    case 'Color':
      return { kind: 'Color', color: params.color, width: params.width, height: params.height }
    case 'Audio':
      return { kind: 'Audio', media_id: params.media, media_label: mediaLabelFor(params.media, pool),
        src_in_us: params.src_in_us, src_out_us: params.src_out_us, gain_db: params.gain_db, pan: params.pan,
        fade_in_us: params.fade_in_us, fade_out_us: params.fade_out_us, mute: params.mute, role: params.role }
    case 'Motif': {
      const t = params.transform
      return { kind: 'Motif', motif_id: params.motif_id, x: t.x, y: t.y, scale_x: t.scale_x, scale_y: t.scale_y,
        opacity: params.opacity, src_in_us: params.src_in_us, props: params.props }
    }
  }
}
