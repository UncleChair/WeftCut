// Integration test for the native export-decode session (export-decode engine
// spec, ticket 01). Drives the @weftcut/native-decode napi seam DIRECTLY from
// Node — open → decodeRange → returnCredit → close — with zero renderer/Electron
// involvement, and asserts exactly-once, GOP-exact, presentation-ordered
// coverage against ffprobe-known fixtures, plus the credit-window flow control
// and internal EOS flush.
//
// Component-gated: the addon is Windows-only today and needs its ffmpeg-lgpl
// DLLs + a `napi:build:decode`. When it can't load (other platforms, or not yet
// built) the whole suite SKIPS — matching the conformance-harness discipline in
// the spec (CI runs pure-function tests everywhere; native gates are local-only).
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportSwFrame, NativeDecode } from '@weftcut/native-decode'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..', '..') // apps/desktop
const DECODE = path.join(APP, 'native', 'decode')
const DLL_DIR = path.join(APP, 'resources', 'ffmpeg-lgpl', 'win', 'bin')
const PRORES = path.join(DECODE, 'tests', 'fixtures', 'tiny_prores.mov')
const MPEG2 = path.join(DECODE, 'tests', 'fixtures', 'tiny_mpeg2.mpg')

// Load the built addon the way main does: prepend the DLL dir to PATH (Windows
// dlopen resolves the ffmpeg family via PATH) before requiring. Any failure —
// wrong platform, missing DLLs, addon not built — degrades to `mod = null` and
// the suite skips.
function tryLoadAddon(): typeof import('@weftcut/native-decode') | null {
  if (process.platform !== 'win32') return null
  try {
    process.env.PATH = `${DLL_DIR}${path.delimiter}${process.env.PATH ?? ''}`
    const require_ = createRequire(import.meta.url)
    return require_(path.join(DECODE, 'index.js')) as typeof import('@weftcut/native-decode')
  } catch {
    return null
  }
}

const addon = tryLoadAddon()

interface EventEnvelope {
  event: string
  payload: { sessionId?: string; message?: string }
}

/** One test session: its collected frames plus a handle to the shared backend. */
interface Ctx {
  backend: NativeDecode
  events: EventEnvelope[]
}

/** Count the range/stream-end markers seen so far for a session id. */
function markersFor(events: EventEnvelope[], id: string): number {
  return events.filter(
    (e) =>
      e.payload.sessionId === id &&
      (e.event === 'exportSw:rangeEnd' || e.event === 'exportSw:ended'),
  ).length
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Drive a decodeRange and return credits generously (so the producer never
 * parks) until its rangeEnd/ended marker lands or the deadline passes. Mirrors
 * the Rust-side `run_range` test helper.
 */
async function drainRange(ctx: Ctx, id: string, a: number, b: number): Promise<void> {
  const before = markersFor(ctx.events, id)
  ctx.backend.exportSwDecodeRange(id, a, b)
  for (let i = 0; i < 200; i++) {
    ctx.backend.exportSwReturnCredit(id, 64)
    await sleep(5)
    if (markersFor(ctx.events, id) > before) return
  }
  throw new Error(`range [${a},${b}] on '${id}' never completed`)
}

describe.skipIf(!addon)('native export-decode session (napi seam)', () => {
  let ctx: Ctx
  const openSessions = new Set<string>()

  beforeAll(() => {
    const events: EventEnvelope[] = []
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const backend = new addon!.NativeDecode((err, json) => {
      if (!err) events.push(JSON.parse(json) as EventEnvelope)
    })
    ctx = { backend, events }
  })

  afterAll(() => {
    for (const id of openSessions) {
      try {
        ctx.backend.exportSwClose(id)
      } catch {
        /* already closed */
      }
    }
  })

  /** Open a session and collect its frames; auto-tracked for teardown. */
  function open(id: string, file: string, format = 'NV12', window = 6) {
    const frames: ExportSwFrame[] = []
    const info = ctx.backend.exportSwOpen(id, file, format, window, (err, f) => {
      if (!err) frames.push(f)
    })
    openSessions.add(id)
    return { info, frames }
  }

  function close(id: string) {
    ctx.backend.exportSwClose(id)
    openSessions.delete(id)
  }

  it('open returns dimensions, color tags, and start PTS', () => {
    const { info } = open('open', PRORES)
    expect(info.width).toBe(320)
    expect(info.height).toBe(240)
    expect(info.colorRange).toBe('tv') // ffprobe: color_range=tv
    expect(info.startPtsUs).toBe(0)
    close('open')
  })

  it('open fails loudly for a format the session cannot emit', () => {
    expect(() => open('bad', PRORES, 'RGBA64')).toThrow(/RGBA64/)
    // 10-bit is recognized but not emittable on the SW lane yet.
    expect(() => open('bad10', PRORES, 'I420P10')).toThrow(/I420P10/)
  })

  it('decodeRange delivers exactly the intersecting intra frames, once, in order', async () => {
    const { frames } = open('intra', PRORES)
    // ProRes: 8 intra frames at 0,125k,…,875k (dur 125k). [200k,500k] intersects
    // 125k (ends 250k>a), 250k, 375k, 500k (starts at b, inclusive).
    await drainRange(ctx, 'intra', 200_000, 500_000)
    expect(frames.map((f) => f.ptsUs)).toEqual([125_000, 250_000, 375_000, 500_000])
    close('intra')
  })

  it('NV12 frames carry dimensions, format, byte length, and color tags', async () => {
    const { frames } = open('bytes', PRORES)
    await drainRange(ctx, 'bytes', 0, 125_000)
    const f = frames[0]!
    expect(f.format).toBe('NV12')
    expect(f.width).toBe(320)
    expect(f.height).toBe(240)
    expect(f.colorRange).toBe('tv')
    // Tightly-packed NV12: Y (w*h) + interleaved UV (w*h/2) = w*h*3/2.
    expect(f.data.length).toBe((320 * 240 * 3) / 2)
    close('bytes')
  })

  it('forward ranges continue from the cursor with no duplicates or gaps', async () => {
    const { frames } = open('fwd', PRORES)
    await drainRange(ctx, 'fwd', 0, 300_000) // 0,125k,250k
    await drainRange(ctx, 'fwd', 300_001, 700_000) // 375k,500k,625k
    const pts = frames.map((f) => f.ptsUs)
    expect(pts).toEqual([0, 125_000, 250_000, 375_000, 500_000, 625_000])
    // Strictly increasing ⇒ presentation order preserved, exactly once.
    expect(pts.every((p, i) => i === 0 || p > pts[i - 1]!)).toBe(true)
    close('fwd')
  })

  it('a backward clip-reuse range re-seeks and re-emits earlier frames', async () => {
    const { frames } = open('back', PRORES)
    await drainRange(ctx, 'back', 500_000, 875_000)
    const forwardCount = frames.length
    expect(frames.map((f) => f.ptsUs)).toEqual([500_000, 625_000, 750_000, 875_000])
    // Jump backward (clip reuse): re-seek and produce the earlier frames again.
    await drainRange(ctx, 'back', 0, 200_000)
    expect(frames.slice(forwardCount).map((f) => f.ptsUs)).toEqual([0, 125_000])
    close('back')
  })

  it('long-GOP (MPEG-2) sub-range covers densely, monotonically, within bounds', async () => {
    const { info, frames } = open('gop', MPEG2)
    expect(info.width).toBe(320)
    // MPEG-2 IBBP, container start_time 0.533s → source-normalized. A 0.6s window
    // at 30fps is ~18 frames; B-frame decode-order reordering must not leak into
    // delivery (pts strictly increasing), and every frame must intersect [0,600k].
    await drainRange(ctx, 'gop', 0, 600_000)
    const pts = frames.map((f) => f.ptsUs)
    expect(pts.length).toBeGreaterThanOrEqual(18)
    expect(pts.every((p, i) => i === 0 || p > pts[i - 1]!)).toBe(true)
    expect(pts[0]).toBeLessThan(40_000)
    expect(pts.every((p) => p <= 600_000)).toBe(true)
    close('gop')
  })

  it('full MPEG-2 decode yields all 60 ffprobe frames in strict presentation order, then EOS', async () => {
    const { frames } = open('full', MPEG2)
    // b far past the ~1.97s stream → drains the final GOP internally (no external
    // next-key) and fires exactly one `exportSw:ended`.
    await drainRange(ctx, 'full', 0, 10_000_000)
    const pts = frames.map((f) => f.ptsUs)
    expect(pts.length).toBe(60) // ffprobe: nb_frames path = 60
    expect(pts.every((p, i) => i === 0 || p > pts[i - 1]!)).toBe(true) // B-frame reorder → monotonic
    expect(pts[0]).toBeGreaterThanOrEqual(0)
    expect(pts[0]).toBeLessThan(40_000)
    expect(pts[pts.length - 1]).toBeGreaterThan(1_900_000)
    const ended = ctx.events.filter(
      (e) => e.event === 'exportSw:ended' && e.payload.sessionId === 'full',
    )
    expect(ended.length).toBe(1)
    close('full')
  })

  it('long-GOP mid-stream range covers exactly the linear-decode subset', async () => {
    // The open-GOP case (ticket AC #2): a window starting INSIDE a later GOP
    // forces a seek to an earlier keyframe + a forward decode whose reference
    // chain must be rebuilt. Cross-check exactness against a full LINEAR decode —
    // the mid-stream seek must deliver exactly the frames the linear pass produced
    // in that window, same set and order.
    const linear = open('lin', MPEG2)
    await drainRange(ctx, 'lin', 0, 10_000_000)
    const all = linear.frames.map((f) => ({ pts: f.ptsUs, dur: f.durUs }))
    close('lin')
    expect(all.length).toBe(60)

    const a = 700_000
    const b = 1_100_000
    const expected = all.filter((f) => f.pts + Math.max(f.dur, 1) > a && f.pts <= b).map((f) => f.pts)
    expect(expected.length).toBeGreaterThanOrEqual(10)

    const mid = open('mid', MPEG2)
    await drainRange(ctx, 'mid', a, b)
    expect(mid.frames.map((f) => f.ptsUs)).toEqual(expected)
    close('mid')
  })

  it('a backward clip-reuse range on a long-GOP source re-seeks correctly', async () => {
    const { frames } = open('gopback', MPEG2)
    await drainRange(ctx, 'gopback', 1_400_000, 1_700_000)
    const lateCount = frames.length
    // Jump backward into an earlier GOP: must re-seek and deliver earlier frames.
    await drainRange(ctx, 'gopback', 400_000, 700_000)
    const early = frames.slice(lateCount).map((f) => f.ptsUs)
    expect(early.length).toBeGreaterThan(0)
    expect(early.every((p, i) => i === 0 || p > early[i - 1]!)).toBe(true) // monotonic
    expect(early.every((p) => p + 33_333 > 400_000 && p <= 700_000)).toBe(true)
    expect(early[0]).toBeLessThan(450_000) // first covers a≈400k
    close('gopback')
  })

  it('the credit window halts in-flight frames and resumes on returned credits', async () => {
    // window=3, request all 8 frames, return NO credits: at most 3 emit, then park.
    const { frames } = open('credit', PRORES, 'NV12', 3)
    ctx.backend.exportSwDecodeRange('credit', 0, 875_000)
    await sleep(200)
    expect(frames.length).toBe(3)
    expect(markersFor(ctx.events, 'credit')).toBe(0) // range not done while parked
    // Return 2 → exactly 2 more, then park again at 5.
    ctx.backend.exportSwReturnCredit('credit', 2)
    await sleep(200)
    expect(frames.length).toBe(5)
    // Drain the remainder.
    ctx.backend.exportSwReturnCredit('credit', 64)
    await sleep(200)
    expect(frames.length).toBe(8)
    // Range [0,875k] ends on the last frame, so it drains to EOS — exactly one
    // rangeEnd (and one ended, asserted elsewhere) marks completion.
    const done = ctx.events.filter(
      (e) => e.event === 'exportSw:rangeEnd' && e.payload.sessionId === 'credit',
    ).length
    expect(done).toBe(1)
    close('credit')
  })

  it('closing a session parked on an exhausted window tears down without deadlock', async () => {
    open('parked', PRORES, 'NV12', 1)
    ctx.backend.exportSwDecodeRange('parked', 0, 875_000)
    await sleep(80) // producer emits 1, parks on the exhausted window
    // A clean return (no hang) is the assertion; close unblocks the producer.
    expect(() => close('parked')).not.toThrow()
  })
})
