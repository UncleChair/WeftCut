import type { Rgba, TextAlign, TextParams } from '../model'
import { defaultTransform } from './add'

/** subtitles/mod.rs:27 CueStyle — per-cue style hints (all optional; absent ⇒
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
/** subtitles/mod.rs:16 Cue — one subtitle cue (text keeps explicit '\n'). */
export interface Cue { start_us: number; end_us: number; text: string; style?: CueStyle }

const DEFAULT_CAPTION_FONT = 'Liberation Sans, Noto Sans SC'
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
  const [anchor, baseX, baseY] = anchorFor(an, compW, compH)
  const [x, y] = s.pos ?? [baseX, baseY]
  return {
    kind: 'Text', content: cue.text,
    font: { family: s.font_family ?? DEFAULT_CAPTION_FONT, size_px: size, weight: s.bold ? 700 : 400, italic: s.italic ?? false },
    color: { mode: 'Static', value: primary },
    align: alignFor(an),
    transform: { ...defaultTransform(), x: { mode: 'Static', value: x }, y: { mode: 'Static', value: y }, anchor },
    opacity: { mode: 'Static', value: 1 },
    shadow: { color: BLACK, offset_x: shadowOff, offset_y: shadowOff, blur: shadowOff },
    outline: { color: s.outline_color ?? BLACK, width: outlineW },
    intro: null, outro: null, backend_hint: 'DrawText',
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
