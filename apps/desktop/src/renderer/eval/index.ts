// Single source of truth for the WYSIWYG math: thin typed wrappers over the
// weftcut-eval wasm module (compiled from native/eval — the SAME crate the actor
// + export link natively). Tracks are uploaded once per (handle, version) into a
// resident buffer and evaluated per-frame with scalar-only calls. `initEval()`
// must be awaited before any wrapper is called (the renderer bootstrap does so).
import { EVAL_WASM_BASE64 } from './evalWasm.generated'

interface Exports {
  snap_round(tUs: number, num: number, den: number): number
  snap_floor(tUs: number, num: number, den: number): number
  snap_ceil(tUs: number, num: number, den: number): number
  time_us_at_frame(frame: number, num: number, den: number): number
  frame_index_floor(tUs: number, num: number, den: number): number
  frame_index_round(tUs: number, num: number, den: number): number
  frame_index_ceil(tUs: number, num: number, den: number): number
  frame_count(startUs: number, endUs: number, num: number, den: number): number
  us_to_frame(us: number, rate: number): number
  set_n(n: number): void
  set_kf(
    i: number,
    tUs: number,
    value: number,
    interp: number,
    p1x: number,
    p1y: number,
    p2x: number,
    p2y: number,
  ): void
  eval(tUs: number, def: number): number
  set_n_rgba(n: number): void
  set_kf_rgba(
    i: number,
    tUs: number,
    packed: number,
    interp: number,
    p1x: number,
    p1y: number,
    p2x: number,
    p2y: number,
  ): void
  eval_rgba_packed(tUs: number, defPacked: number): number
  db_to_linear(db: number): number
  role_audible(muted: number, solo: number, anySolo: number): number
  pan_coeff(pan: number, channels: number, idx: number): number
  fade_mul(tUs: number, spanUs: number, fadeInUs: number, fadeOutUs: number): number
}

let ex: Exports | null = null
const interpCode: Record<string, number> = { Hold: 0, Linear: 1, EaseIn: 2, EaseOut: 3, Bezier: 4 }

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  // Back the view with an explicit `ArrayBuffer` so the type resolves to
  // `Uint8Array<ArrayBuffer>` (a valid `BufferSource`); a bare `new
  // Uint8Array(len)` widens to `<ArrayBufferLike>` under @types/node, which
  // `WebAssembly.compile` rejects. The renderer (Chromium) + Node (vitest) both
  // have `atob`; `Buffer` is the Node fallback if a future test env lacks it.
  const bin =
    typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('latin1')
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export async function initEval(): Promise<void> {
  if (ex) return
  const bytes = decodeBase64(EVAL_WASM_BASE64)
  // compile-then-instantiate (not the bytes overload of instantiate) keeps the
  // result type unambiguous: instantiate(Module) returns a bare Instance.
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(module, {})
  ex = instance.exports as unknown as Exports
}

function E(): Exports {
  if (!ex) throw new Error('initEval() not awaited before eval use')
  return ex
}

// ---------------------------------------------------------------------------
// Frame grid. One wrapper per leaf primitive; `renderer/frames.ts` is the
// surface the app imports (it adds the composition-level helpers). Degenerate
// fps (a transient 0 from seek/UI — the actor never stores one) short-circuits
// HERE rather than in the leaf, which contracts for a valid rate: a snap returns
// its input untouched, an index/count answers 0.
// ---------------------------------------------------------------------------

/** Round `tUs` to the nearest frame boundary (half-up). */
export function snapFrameRound(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_round(tUs, num, den)
}

/** Floor `tUs` to the canonical start of the frame containing it. */
export function snapFrameFloor(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_floor(tUs, num, den)
}

/** Ceil `tUs` to the next canonical frame start (identity when already on one). */
export function snapFrameCeil(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_ceil(tUs, num, den)
}

/** Canonical µs of frame index `frame` — the ONLY frame-index-to-time policy
 * (half-up). Every grid time in the project traces back to this. */
export function timeUsAtFrame(frame: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().time_us_at_frame(frame, num, den)
}

/** Index of the frame containing `tUs`. */
export function frameIndexFloor(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_index_floor(tUs, num, den)
}

/** Index of the frame boundary nearest `tUs` (half-up). */
export function frameIndexRound(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_index_round(tUs, num, den)
}

/** Index of the first frame at or after `tUs`. */
export function frameIndexCeil(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_index_ceil(tUs, num, den)
}

/** Grid frames in the half-open range `[startUs, endUs)`. */
export function frameCount(startUs: number, endUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_count(startUs, endUs, num, den)
}

/** µs → sample-frame index at `rate` Hz (half-up). Shared with the export mixer
 * (`audio/mix.rs::us_to_frame`) through the leaf so preview + export place audio
 * on one grid. */
export function usToFrame(us: number, rate: number): number {
  return E().us_to_frame(us, rate)
}

/** Keyframe shape from the IPC AnimTrack (renderer/render/animated.ts). */
export interface Kf {
  t_us: number
  value: number
  interp: { kind: string; p1?: [number, number]; p2?: [number, number] }
}

/** Resident keyframe-buffer capacity — mirrors `MAXKF` in
 * native/eval/src/wasm.rs. Bounds ONE animated property of ONE layer (an
 * `AnimTrack` / Rust `Animated<T>` — e.g. a single clip's opacity or x), NOT a
 * timeline track or a whole clip (each property is uploaded separately). A
 * static-allocation backstop (the no_std wasm build has no heap), not a product
 * limit: manual authoring never approaches it. Known limit: beyond this the wasm
 * preview truncates while native export evaluates every keyframe, so they can
 * diverge — see docs/render.md. */
export const MAX_KEYFRAMES = 256

let loadedHandle = -1
let warnedOverflow = false
/** Upload a property's keyframes into the resident wasm buffer ONCE, cached by a
 * monotonically-assigned handle (see render/animated.ts). Re-uploads only when
 * the handle differs from the last-loaded — so per-frame eval pays no marshaling. */
export function loadTrack(handle: number, kfs: Kf[]): void {
  if (handle === loadedHandle) return
  const e = E()
  if (kfs.length > MAX_KEYFRAMES && !warnedOverflow) {
    warnedOverflow = true
    console.warn(
      `weftcut-eval: an animated property has ${kfs.length} keyframes; only the ` +
        `first ${MAX_KEYFRAMES} are evaluated in the wasm preview. Native export ` +
        `uses all of them, so preview may diverge from export. Known limit — see ` +
        `docs/render.md.`,
    )
  }
  const n = Math.min(kfs.length, MAX_KEYFRAMES)
  for (let i = 0; i < n; i++) {
    const k = kfs[i]!
    const c = interpCode[k.interp.kind] ?? 1
    const p1 = k.interp.p1 ?? [0, 0]
    const p2 = k.interp.p2 ?? [0, 0]
    e.set_kf(i, k.t_us, k.value, c, p1[0], p1[1], p2[0], p2[1])
  }
  e.set_n(n)
  loadedHandle = handle
}

export function evalTrack(tUs: number, def: number): number {
  return E().eval(tUs, def)
}

// ---------------------------------------------------------------------------
// Color keyframes. An `Rgba8` crosses the scalars-only ABI as ONE packed i32
// (RGBA8). The resident color buffer is INDEPENDENT of the scalar one — its own
// cache var below — but reuses MAX_KEYFRAMES + the same overflow-warn pattern.
// ---------------------------------------------------------------------------

/** Color value structurally compatible with the IPC `Rgba` (kept local so this
 * layer stays dependency-light). */
export interface RgbaLike {
  r: number
  g: number
  b: number
  a: number
}

/** Color keyframe shape (mirrors `Kf` for color values). */
export interface KfColor {
  t_us: number
  value: RgbaLike
  interp: { kind: string; p1?: [number, number]; p2?: [number, number] }
}

// Pack/unpack MUST be byte-identical to the Rust shim (`wasm.rs`): r in the HIGH
// byte. `>>> 0` / `& 0xff` keep the values unsigned (JS `<<`/`>>` are signed).
const packRgba = (c: RgbaLike) => (c.r << 24) | (c.g << 16) | (c.b << 8) | c.a
const unpackRgba = (p: number): RgbaLike => {
  const u = p >>> 0
  return { r: (u >>> 24) & 0xff, g: (u >>> 16) & 0xff, b: (u >>> 8) & 0xff, a: u & 0xff }
}

let loadedColorHandle = -1
let warnedColorOverflow = false
/** Upload a color property's keyframes into the resident wasm COLOR buffer ONCE,
 * cached by handle (twin of `loadTrack`; separate buffer + cache var). */
export function loadColorTrack(handle: number, kfs: KfColor[]): void {
  if (handle === loadedColorHandle) return
  const e = E()
  if (kfs.length > MAX_KEYFRAMES && !warnedColorOverflow) {
    warnedColorOverflow = true
    console.warn(
      `weftcut-eval: an animated color property has ${kfs.length} keyframes; only ` +
        `the first ${MAX_KEYFRAMES} are evaluated in the wasm preview. Native export ` +
        `uses all of them, so preview may diverge from export. Known limit — see ` +
        `docs/render.md.`,
    )
  }
  const n = Math.min(kfs.length, MAX_KEYFRAMES)
  for (let i = 0; i < n; i++) {
    const k = kfs[i]!
    const c = interpCode[k.interp.kind] ?? 1
    const p1 = k.interp.p1 ?? [0, 0]
    const p2 = k.interp.p2 ?? [0, 0]
    e.set_kf_rgba(i, k.t_us, packRgba(k.value), c, p1[0], p1[1], p2[0], p2[1])
  }
  e.set_n_rgba(n)
  loadedColorHandle = handle
}

/** Evaluate the resident color track at `tUs` (OkLab + premult, via the leaf). */
export function evalRgbaPacked(tUs: number, def: RgbaLike): RgbaLike {
  return unpackRgba(E().eval_rgba_packed(tUs, packRgba(def)))
}

export function dbToLinear(db: number): number {
  return E().db_to_linear(db)
}

export function roleAudible(muted: boolean, solo: boolean, anySolo: boolean): boolean {
  return E().role_audible(muted ? 1 : 0, solo ? 1 : 0, anySolo ? 1 : 0) !== 0
}

/** Equal-power pan coefficient `[a,b,c,d][idx]` for `(pan, channels)` — the
 * leaf law shared with the export mixer. `channels` 1 (mono) or 2 (stereo). */
export function panCoeff(pan: number, channels: number, idx: number): number {
  return E().pan_coeff(pan, channels, idx)
}

/** Fade ramp multiplier — leaf-sourced twin of `audio/mix.rs` fade_multiplier. */
export function fadeMul(
  tUs: number,
  spanUs: number,
  fadeInUs: number,
  fadeOutUs: number,
): number {
  return E().fade_mul(tUs, spanUs, fadeInUs, fadeOutUs)
}
