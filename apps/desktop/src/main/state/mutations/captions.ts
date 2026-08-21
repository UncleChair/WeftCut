import type { Project, Rgba, TextAlign, TextParams, Track, Uuid } from '../model'
import type { IdGen } from '../ids'
import { snapFrameRound } from '../snap'
import { applyAddLayer, defaultTransform } from './add'
import { DEFAULT_CAPTION_FONT_FAMILY } from '../../../shared/fonts'

/** subtitles/mod.rs CueStyle — per-cue style hints (all optional; absent ⇒
 *  the default caption look applies). `align` is the ASS 9-grid (1..9). */
export interface CueStyle {
  font_family?: string | null
  size_px?: number | null
  primary?: Rgba | null
  bold?: boolean
  italic?: boolean
  outline_px?: number | null
  outline_color?: Rgba | null
  shadow_px?: number | null
  align?: number | null
  pos?: [number, number] | null
}
/** subtitles/mod.rs Cue — one subtitle cue (text keeps explicit '\n'). */
export interface Cue { start_us: number; end_us: number; text: string; style?: CueStyle }

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 }

/** subtitles/layout.rs:14 cue_to_text_params — lay out one cue as a Text layer.
 *  Styleless cues get white fill, black outline + soft shadow, size 5% of comp
 *  height, bottom-centre with an 8% safe-area margin. The ASS 9-grid align (or
 *  \pos) becomes an absolute anchor + position. NOTE the f32 keystone: size_px /
 *  outline width / shadow offsets are f32 in Rust — the differential corpus
 *  supplies explicit clean style values so the auto-multiply path (this fn's
 *  `size * 0.06`) is never differential-gated (it IS unit-tested above). */
export function cueToTextParams(cue: Cue, compW: number, compH: number): TextParams {
  const s = cue.style ?? {}
  const size = s.size_px ?? Math.round(compH * 0.05)
  const primary = s.primary ?? WHITE
  const outlineW = Math.max(s.outline_px ?? size * 0.06, 1.0)
  const shadowOff = Math.max(s.shadow_px ?? 2.0, 1.0)
  const an = s.align ?? 2
  const [[anchorX, anchorY], baseX, baseY] = anchorFor(an, compW, compH)
  const [x, y] = s.pos ?? [baseX, baseY]
  return {
    kind: 'Text', content: cue.text,
    font: { family: s.font_family ?? DEFAULT_CAPTION_FONT_FAMILY, size_px: size, weight: s.bold ? 700 : 400, italic: s.italic ?? false },
    color: { mode: 'Static', value: primary },
    align: alignFor(an),
    transform: { ...defaultTransform(), x: { mode: 'Static', value: x }, y: { mode: 'Static', value: y }, anchor_x: { mode: 'Static', value: anchorX }, anchor_y: { mode: 'Static', value: anchorY } },
    opacity: { mode: 'Static', value: 1 },
    shadow: { color: BLACK, offset_x: shadowOff, offset_y: shadowOff, blur: shadowOff },
    outline: { color: s.outline_color ?? BLACK, width: outlineW },
    intro: null, outro: null,
    box_w: null, box_h: null, valign: 'Middle', line_height: 0, letter_spacing: 0,
  }
}

/** layout.rs:60 anchor_for — ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle,
 *  7-9 top; 1/4/7 left, 2/5/8 centre, 3/6/9 right. 8% safe-area margins (f64). */
function anchorFor(an: number, w: number, h: number): [[number, number], number, number] {
  const mx = w * 0.08, my = h * 0.08
  let ax: number, x: number
  if (an === 1 || an === 4 || an === 7) { ax = 0.0; x = mx }
  else if (an === 3 || an === 6 || an === 9) { ax = 1.0; x = w - mx }
  else { ax = 0.5; x = w / 2.0 }
  let ay: number, y: number
  if (an === 7 || an === 8 || an === 9) { ay = 0.0; y = my }
  else if (an === 4 || an === 5 || an === 6) { ay = 0.5; y = h / 2.0 }
  else { ay = 1.0; y = h - my }
  return [[ax, ay], x, y]
}
/** layout.rs:76 align_for. */
function alignFor(an: number): TextAlign {
  if (an === 1 || an === 4 || an === 7) return 'Left'
  if (an === 3 || an === 6 || an === 9) return 'Right'
  return 'Center'
}

/** Batch style applied to a caption track's Text layers. null/absent =
 *  "don't touch". */
export interface CaptionStylePatch {
  font_family?: string | null
  font_size_px?: number | null
  color?: Rgba | null
  outline_width?: number | null
}

/** add_caption_track — greedy lane-pack the cues into Caption
 *  tracks (one Text layer per cue). Cues stable-sorted by start_us; each cue goes
 *  to the FIRST lane whose last layer's snapped end <= this cue's snapped start,
 *  else a new Caption track is opened (appended after the existing tracks).
 *  Returns the primary (first-opened) track id. Empty cues still create one empty
 *  Caption track. ★ ID ORDER: opening a lane mints the track id (newCaptionTrack
 *  → idGen) BEFORE the layer id (applyAddLayer → idGen) — mirror Track::new()
 *  then apply_add_layer exactly. No explicit autofit (applyAddLayer autofits per
 *  layer). */
export function applyAddCaptionTrack(p: Project, idGen: IdGen, cues: Cue[], compW: number, compH: number, label: string | null): Uuid {
  const fps = p.composition.fps
  const sorted = cues.slice().sort((a, b) => (a.start_us < b.start_us ? -1 : a.start_us > b.start_us ? 1 : 0)) // stable by start_us
  const trackIds: Uuid[] = []
  const trackEnds: number[] = []
  for (const cue of sorted) {
    const snappedStart = snapFrameRound(cue.start_us, fps.num, fps.den)
    const slot = trackEnds.findIndex((end) => end <= snappedStart)
    let trackId: Uuid
    if (slot >= 0) { trackId = trackIds[slot] }
    else { trackId = newCaptionTrack(p, idGen, label); trackIds.push(trackId); trackEnds.push(0) }
    applyAddLayer(p, idGen, trackId, cueToTextParams(cue, compW, compH), cue.start_us, cue.end_us)
    trackEnds[trackIds.indexOf(trackId)] = snapFrameRound(cue.end_us, fps.num, fps.den)
  }
  if (trackIds.length > 0) return trackIds[0]
  return newCaptionTrack(p, idGen, label) // empty-cues safety net (Track::new after the loop)
}

/** Track::new() defaults + role=Caption, appended to the END of the track list
 *  (push_back). A role stamp makes it part of the reserved skeleton, so
 *  `transient` is false and emptying it never removes it — unlike every track
 *  `applyAddTrack` mints. */
function newCaptionTrack(p: Project, idGen: IdGen, label: string | null): Uuid {
  const id = idGen()
  p.tracks.push({ id, label, enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: 'Caption', transient: false, height_px: 64, layers: [] })
  return id
}

/** Patch every Text layer of ONE track with a caption style patch; non-Text
 *  layers skipped. outline_width keeps the existing outline color (or BLACK if
 *  none). */
function restyleTrackTextLayers(track: Track, patch: CaptionStylePatch): void {
  for (const layer of track.layers) {
    if (layer.params.kind !== 'Text') continue
    const tp = layer.params
    if (patch.font_family !== undefined && patch.font_family !== null) tp.font.family = patch.font_family
    if (patch.font_size_px !== undefined && patch.font_size_px !== null) tp.font.size_px = patch.font_size_px
    if (patch.color !== undefined && patch.color !== null) tp.color = { mode: 'Static', value: patch.color }
    if (patch.outline_width !== undefined && patch.outline_width !== null) {
      const existingColor = tp.outline ? tp.outline.color : BLACK
      tp.outline = { color: existingColor, width: patch.outline_width }
    }
  }
}

/** restyle_captions — the Project-wide caption corpus restyle: patch EVERY
 *  caption-role Track's Text layers in one commit, so overlapping caption lanes
 *  restyle atomically as one undo entry. Non-caption tracks are untouched. There
 *  is no TrackNotFound — a project may legitimately hold zero caption tracks, in
 *  which case this is a no-op (commit's no-op guard then records nothing). */
export function applyRestyleCaptions(p: Project, patch: CaptionStylePatch): void {
  for (const track of p.tracks) {
    if (track.role !== 'Caption') continue
    restyleTrackTextLayers(track, patch)
  }
}
