// Integration test for the native export-decode session (export-decode engine
// spec, ticket 01). Drives the @weftcut/native-decode napi seam DIRECTLY from
// Node — open → decodeRange → returnCredit → close — with zero renderer/Electron
// involvement, and asserts exactly-once, GOP-exact, presentation-ordered
// coverage against ffprobe-known fixtures, plus the credit-window flow control,
// internal EOS flush, and the in-band ordering of control signals (frames and
// rangeEnd/ended/error share one per-session channel).
//
// Component-gated: the addon builds on Windows + Linux (each needs its
// ffmpeg-lgpl libs + a `napi:build:decode`); macOS has no LGPL asset yet. When
// it can't load (unsupported platform, or not yet built) the whole suite SKIPS
// — matching the conformance-harness discipline in the spec (CI runs
// pure-function tests everywhere; native gates are local-only).
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExportSwFrame, ExportSwMsg, NativeDecode } from '@weftcut/native-decode'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..', '..') // apps/desktop
const DECODE = path.join(APP, 'native', 'decode')
const DLL_DIR = path.join(APP, 'resources', 'ffmpeg-lgpl', 'win', 'bin')
const PRORES = path.join(DECODE, 'tests', 'fixtures', 'tiny_prores.mov')
const MPEG2 = path.join(DECODE, 'tests', 'fixtures', 'tiny_mpeg2.mpg')

// Load the built addon the way main does. On Windows, dlopen resolves the
// ffmpeg family via PATH, so prepend the co-located DLL dir first. On Linux the
// addon carries a baked RPATH=$ORIGIN to its co-located libav*.so, so it loads
// with no loader-path shim. macOS has no ffmpeg-lgpl asset yet — skip. Any
// failure — wrong platform, missing libs, addon not built — degrades to
// `mod = null` and the suite skips.
function tryLoadAddon(): typeof import('@weftcut/native-decode') | null {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  try {
    if (process.platform === 'win32') {
      process.env.PATH = `${DLL_DIR}${path.delimiter}${process.env.PATH ?? ''}`
    }
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

/** One test session: the shared backend, the shared-envelope capture, and each
 * session's ordered in-band message stream. */
interface Ctx {
  backend: NativeDecode
  events: EventEnvelope[]
  msgsById: Map<string, ExportSwMsg[]>
}

function countKind(msgs: ExportSwMsg[], kind: string): number {
  return msgs.filter((m) => m.kind === kind).length
}

/** Count the range/stream-end markers seen so far on a session's channel. */
function markersFor(msgs: ExportSwMsg[]): number {
  return countKind(msgs, 'rangeEnd') + countKind(msgs, 'ended')
}

/** The session's decoded frames, in delivery order (kind==='frame' payloads). */
function framesOf(msgs: ExportSwMsg[]): ExportSwFrame[] {
  return msgs.filter((m) => m.kind === 'frame').map((m) => m.frame!)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Drive a decodeRange and return credits generously (so the producer never
 * parks) until its rangeEnd lands or the deadline passes. Mirrors the
 * Rust-side `run_range` test helper. Polls `rangeEnd` specifically: every
 * completed range emits exactly one, AFTER any `ended` — so on the FIFO
 * per-session channel, observing it guarantees the whole tail has crossed.
 */
async function drainRange(ctx: Ctx, id: string, a: number, b: number): Promise<void> {
  const msgs = ctx.msgsById.get(id)!
  const before = countKind(msgs, 'rangeEnd')
  ctx.backend.exportSwDecodeRange(id, a, b)
  for (let i = 0; i < 200; i++) {
    ctx.backend.exportSwReturnCredit(id, 64)
    await sleep(5)
    if (countKind(msgs, 'rangeEnd') > before) return
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
    ctx = { backend, events, msgsById: new Map() }
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

  /** Open a session and collect its in-band messages; auto-tracked for teardown. */
  function open(id: string, file: string, format = 'NV12', window = 6) {
    const msgs: ExportSwMsg[] = []
    const info = ctx.backend.exportSwOpen(id, file, format, window, (err, m) => {
      if (!err) msgs.push(m)
    })
    ctx.msgsById.set(id, msgs)
    openSessions.add(id)
    return { info, msgs }
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
  })

  it('I420P10 opens successfully (the 10-bit lane)', () => {
    const { info } = open('open10', PRORES, 'I420P10')
    expect(info.width).toBe(320)
    expect(info.height).toBe(240)
    expect(info.startPtsUs).toBe(0)
    close('open10')
  })

  it('decodeRange delivers exactly the intersecting intra frames, once, in order', async () => {
    const { msgs } = open('intra', PRORES)
    // ProRes: 8 intra frames at 0,125k,…,875k (dur 125k). [200k,500k] intersects
    // 125k (ends 250k>a), 250k, 375k, 500k (starts at b, inclusive).
    await drainRange(ctx, 'intra', 200_000, 500_000)
    expect(framesOf(msgs).map((f) => f.ptsUs)).toEqual([125_000, 250_000, 375_000, 500_000])
    close('intra')
  })

  it('NV12 frames carry dimensions, format, byte length, and color tags', async () => {
    const { msgs } = open('bytes', PRORES)
    await drainRange(ctx, 'bytes', 0, 125_000)
    const first = msgs[0]!
    expect(first.kind).toBe('frame')
    expect(first.sessionId).toBe('bytes')
    const f = first.frame!
    expect(f.format).toBe('NV12')
    expect(f.width).toBe(320)
    expect(f.height).toBe(240)
    expect(f.colorRange).toBe('tv')
    // Tightly-packed NV12: Y (w*h) + interleaved UV (w*h/2) = w*h*3/2.
    expect(f.data.length).toBe((320 * 240 * 3) / 2)
    close('bytes')
  })

  it('I420P10 frames carry the u16LE plane layout with real 10-bit sample range', async () => {
    const { msgs } = open('bytes10', PRORES, 'I420P10')
    await drainRange(ctx, 'bytes10', 0, 125_000)
    const first = msgs[0]!
    expect(first.kind).toBe('frame')
    const f = first.frame!
    expect(f.format).toBe('I420P10')
    expect(f.width).toBe(320)
    expect(f.height).toBe(240)
    // Tightly-packed u16LE I420P10: Y (w*h*2) + U + V ((w/2)*(h/2)*2 each) = w*h*3.
    expect(f.data.length).toBe(320 * 240 * 3)
    // Real 10-bit range, not 8-bit-quantized: scanning the Y plane as u16LE,
    // at least one sample exceeds the 8-bit ceiling and none exceeds 1023.
    const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength)
    let max = 0
    for (let i = 0; i < 320 * 240; i++) {
      const v = dv.getUint16(i * 2, true)
      if (v > max) max = v
    }
    expect(max).toBeGreaterThan(255)
    expect(max).toBeLessThanOrEqual(1023)
    close('bytes10')
  })

  it('forward ranges continue from the cursor with no duplicates or gaps', async () => {
    const { msgs } = open('fwd', PRORES)
    await drainRange(ctx, 'fwd', 0, 300_000) // 0,125k,250k
    await drainRange(ctx, 'fwd', 300_001, 700_000) // 375k,500k,625k
    const pts = framesOf(msgs).map((f) => f.ptsUs)
    expect(pts).toEqual([0, 125_000, 250_000, 375_000, 500_000, 625_000])
    // Strictly increasing ⇒ presentation order preserved, exactly once.
    expect(pts.every((p, i) => i === 0 || p > pts[i - 1]!)).toBe(true)
    close('fwd')
  })

  it('a backward clip-reuse range re-seeks and re-emits earlier frames', async () => {
    const { msgs } = open('back', PRORES)
    await drainRange(ctx, 'back', 500_000, 875_000)
    const forwardCount = framesOf(msgs).length
    expect(framesOf(msgs).map((f) => f.ptsUs)).toEqual([500_000, 625_000, 750_000, 875_000])
    // Jump backward (clip reuse): re-seek and produce the earlier frames again.
    await drainRange(ctx, 'back', 0, 200_000)
    expect(framesOf(msgs).slice(forwardCount).map((f) => f.ptsUs)).toEqual([0, 125_000])
    close('back')
  })

  it('a forward range after a backward jump is not falsely treated as covered', async () => {
    // Regression: the session's coverage high-water mark must reset on a
    // backward re-seek. Without the reset, the third range below sits under the
    // FIRST range's high-water mark (875k), short-circuits as "already
    // covered", and delivers nothing — though [300k, 400k] was never covered.
    const { msgs } = open('backfwd', PRORES)
    await drainRange(ctx, 'backfwd', 500_000, 875_000) // high-water → 875k
    await drainRange(ctx, 'backfwd', 0, 200_000) // backward jump: coverage resets
    const before = framesOf(msgs).length
    await drainRange(ctx, 'backfwd', 300_000, 400_000) // forward, never covered
    // 250k ([250k,375k) intersects) and 375k ([375k,500k) intersects b=400k).
    expect(framesOf(msgs).slice(before).map((f) => f.ptsUs)).toEqual([250_000, 375_000])
    close('backfwd')
  })

  it('long-GOP (MPEG-2) sub-range covers densely, monotonically, within bounds', async () => {
    const { info, msgs } = open('gop', MPEG2)
    expect(info.width).toBe(320)
    // MPEG-2 IBBP, container start_time 0.533s → source-normalized. A 0.6s window
    // at 30fps is ~18 frames; B-frame decode-order reordering must not leak into
    // delivery (pts strictly increasing), and every frame must intersect [0,600k].
    await drainRange(ctx, 'gop', 0, 600_000)
    const pts = framesOf(msgs).map((f) => f.ptsUs)
    expect(pts.length).toBeGreaterThanOrEqual(18)
    expect(pts.every((p, i) => i === 0 || p > pts[i - 1]!)).toBe(true)
    expect(pts[0]).toBeLessThan(40_000)
    expect(pts.every((p) => p <= 600_000)).toBe(true)
    close('gop')
  })

  it('full MPEG-2 decode yields all 60 ffprobe frames in strict presentation order, then EOS', async () => {
    const { msgs } = open('full', MPEG2)
    // b far past the ~1.97s stream → drains the final GOP internally (no external
    // next-key) and fires exactly one in-band `ended`.
    await drainRange(ctx, 'full', 0, 10_000_000)
    const pts = framesOf(msgs).map((f) => f.ptsUs)
    expect(pts.length).toBe(60) // ffprobe: nb_frames path = 60
    expect(pts.every((p, i) => i === 0 || p > pts[i - 1]!)).toBe(true) // B-frame reorder → monotonic
    expect(pts[0]).toBeGreaterThanOrEqual(0)
    expect(pts[0]).toBeLessThan(40_000)
    expect(pts[pts.length - 1]).toBeGreaterThan(1_900_000)
    // In-band ordering: `ended` shares the frames' channel, so it can NEVER
    // overtake a tail frame — its index must sit after every frame message.
    const kinds = msgs.map((m) => m.kind)
    expect(countKind(msgs, 'ended')).toBe(1)
    const endedIdx = kinds.indexOf('ended')
    expect(kinds.lastIndexOf('frame')).toBeLessThan(endedIdx)
    // EOS emit order is Ended then RangeEnd; the single queue preserves it.
    expect(kinds[endedIdx + 1]).toBe('rangeEnd')
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
    const all = framesOf(linear.msgs).map((f) => ({ pts: f.ptsUs, dur: f.durUs }))
    close('lin')
    expect(all.length).toBe(60)

    const a = 700_000
    const b = 1_100_000
    const expected = all.filter((f) => f.pts + Math.max(f.dur, 1) > a && f.pts <= b).map((f) => f.pts)
    expect(expected.length).toBeGreaterThanOrEqual(10)

    const mid = open('mid', MPEG2)
    await drainRange(ctx, 'mid', a, b)
    expect(framesOf(mid.msgs).map((f) => f.ptsUs)).toEqual(expected)
    close('mid')
  })

  it('a backward clip-reuse range on a long-GOP source re-seeks correctly', async () => {
    const { msgs } = open('gopback', MPEG2)
    await drainRange(ctx, 'gopback', 1_400_000, 1_700_000)
    const lateCount = framesOf(msgs).length
    // Jump backward into an earlier GOP: must re-seek and deliver earlier frames.
    await drainRange(ctx, 'gopback', 400_000, 700_000)
    const early = framesOf(msgs).slice(lateCount).map((f) => f.ptsUs)
    expect(early.length).toBeGreaterThan(0)
    expect(early.every((p, i) => i === 0 || p > early[i - 1]!)).toBe(true) // monotonic
    expect(early.every((p) => p + 33_333 > 400_000 && p <= 700_000)).toBe(true)
    expect(early[0]).toBeLessThan(450_000) // first covers a≈400k
    close('gopback')
  })

  it('the credit window halts in-flight frames and resumes on returned credits', async () => {
    // window=3, request all 8 frames, return NO credits: at most 3 emit, then park.
    const { msgs } = open('credit', PRORES, 'NV12', 3)
    ctx.backend.exportSwDecodeRange('credit', 0, 875_000)
    await sleep(200)
    expect(framesOf(msgs).length).toBe(3)
    expect(markersFor(msgs)).toBe(0) // range not done while parked
    // Return 2 → exactly 2 more, then park again at 5.
    ctx.backend.exportSwReturnCredit('credit', 2)
    await sleep(200)
    expect(framesOf(msgs).length).toBe(5)
    // Drain the remainder.
    ctx.backend.exportSwReturnCredit('credit', 64)
    await sleep(200)
    expect(framesOf(msgs).length).toBe(8)
    // Range [0,875k] ends on the last frame, so it drains to EOS — exactly one
    // rangeEnd (and one ended, asserted elsewhere) marks completion.
    expect(countKind(msgs, 'rangeEnd')).toBe(1)
    close('credit')
  })

  it('the credit window bounds the 10-bit lane identically (no unbounded copy backlog)', async () => {
    // Same shape as the NV12 window test: 10-bit frames are 2× the bytes, so a
    // producer that ignored the window here would balloon memory twice as fast.
    const { msgs } = open('credit10', PRORES, 'I420P10', 3)
    ctx.backend.exportSwDecodeRange('credit10', 0, 875_000)
    await sleep(200)
    expect(framesOf(msgs).length).toBe(3)
    expect(markersFor(msgs)).toBe(0) // range not done while parked
    ctx.backend.exportSwReturnCredit('credit10', 2)
    await sleep(200)
    expect(framesOf(msgs).length).toBe(5)
    ctx.backend.exportSwReturnCredit('credit10', 64)
    await sleep(200)
    expect(framesOf(msgs).length).toBe(8)
    expect(countKind(msgs, 'rangeEnd')).toBe(1)
    close('credit10')
  })

  it('closing a session parked on an exhausted window tears down without deadlock', async () => {
    open('parked', PRORES, 'NV12', 1)
    ctx.backend.exportSwDecodeRange('parked', 0, 875_000)
    await sleep(80) // producer emits 1, parks on the exhausted window
    // A clean return (no hang) is the assertion; close unblocks the producer.
    expect(() => close('parked')).not.toThrow()
  })

  it('the shared event envelope carries no exportSw traffic', () => {
    // Control signals moved in-band; nothing export-decode-shaped may ride the
    // `{event, payload}` envelope anymore. Runs last: `ctx.events` has captured
    // every envelope emission across the whole suite by now.
    expect(ctx.events.filter((e) => e.event.startsWith('exportSw:'))).toEqual([])
  })
})
