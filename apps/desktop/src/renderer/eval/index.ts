// Single source of truth for the WYSIWYG math: thin typed wrappers over the
// weftcut-eval wasm module (compiled from native/eval — the SAME crate the actor
// + export link natively). Tracks are uploaded once per (handle, version) into a
// resident buffer and evaluated per-frame with scalar-only calls. `initEval()`
// must be awaited before any wrapper is called (the renderer bootstrap does so).
import { EVAL_WASM_BASE64 } from './evalWasm.generated'

interface Exports {
  snap_round(tUs: number, num: number, den: number): number
  snap_floor(tUs: number, num: number, den: number): number
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
  db_to_linear(db: number): number
  role_audible(muted: number, solo: number, anySolo: number): number
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

/** Round `tUs` to the nearest frame boundary. Degenerate fps is a no-op (the
 * actor never stores one, but seek/UI may pass a transient 0). */
export function snapFrameRound(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_round(tUs, num, den)
}

/** Floor `tUs` to the frame boundary at or below. Degenerate fps is a no-op. */
export function snapFrameFloor(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_floor(tUs, num, den)
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

export function dbToLinear(db: number): number {
  return E().db_to_linear(db)
}

export function roleAudible(muted: boolean, solo: boolean, anySolo: boolean): boolean {
  return E().role_audible(muted ? 1 : 0, solo ? 1 : 0, anySolo ? 1 : 0) !== 0
}
