// Main-process manager for native GPU-decode preview sessions. Owns the
// PERSISTENT shared-texture imports: each pool slot is importSharedTexture'd +
// sendSharedTexture'd EXACTLY ONCE at open, then kept alive for the whole
// session so the underlying D3D11 NV12 textures stay reusable. Per-frame
// traffic is only frameReady/consumeAck pokes — never a per-frame import/send.
//
// Why persistent, not per-frame: per-frame sendSharedTexture is IPC-bound —
// a benchmark built on it reports IPC latency as "native throughput".
//
// Windows-only: the addon's previewGpu* methods throw "preview-gpu not built"
// elsewhere. This module never inspects the platform — it just delegates; the
// selection gate upstream decides when a GPU session is even opened.
import { sharedTexture } from 'electron'
import type { BrowserWindow, ColorSpace, SharedTextureImported } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'
import {
  HW_BUDGET_EXCEEDED,
  type HwBarrierMode,
  type PreviewGpuBudget,
  type PreviewGpuTimingReport,
} from '../shared/ipc'
import { clearMainPendingFor } from './previewGpuTiming.js'

interface GpuSession {
  // One imported texture per pool slot, indexed by the slot number the native
  // side names in frameReady{slot}. Held for the session's lifetime and NEVER
  // released mid-session — releasing would tear down the shared textures the
  // decode thread keeps writing into. Released only in closePreviewGpu.
  imported: SharedTextureImported[]
  width: number
  height: number
}

const sessions = new Map<string, GpuSession>()

/// Concurrent HW-session cap. What it rations is the GPU's VideoDecode engine —
/// not the per-frame read barrier (free under `rendererFence`, so cap headroom
/// converts straight into tracks), and not VRAM: 5 sessions × 3 slots × w·h·1.5
/// NV12 is ≈47MB at 1080p, ≈187MB at 4K — NOMINAL desc sizes, not measurements
/// — and even that 4K figure is ~4% of what the app already holds on the GPU at
/// three 4K tracks, where the real consumer is the FrameRing's resolution-blind
/// lookahead. (The 3 is `poolSize`, a renderer-owned knob, not this cap.)
///
/// Landmine: engine load scales with PIXELS, not sessions, so one number for
/// both resolutions is right at 1080p (18.7% at five hardware tracks) and
/// knowingly too high at 4K (58-62% on ONE H.264 track). Three 4K hardware
/// tracks stay nearly clean — 0.00% drops, engine 91.9% — and the FOURTH tips it
/// to 99.9% and starves EVERY session, the healthy three included: all four
/// deliver zero frames and hold their poster. A cliff, not a slope. Kept because
/// 4K's smooth ceiling sits far below the cap anyway, and a LOWER cap is worse
/// at five 4K tracks — its software spills push NV12 over CPU IPC and stall the
/// main thread for tens of seconds. The ½/¼ playback-resolution dial cannot
/// help: the decoder downscales before IPC, cutting IPC bytes and raster cost,
/// never engine load. Per-resolution caps are backlog (docs/roadmap.md).
///
/// Landmine: LOWERING this silently shrinks ordering coverage. The E2E order
/// gate derives its session counts from this value at runtime rather than
/// restating it, and `decodeBenchConcurrentOrderCheck` refuses a run with
/// `sessions > budget.max` — so the at-cap concurrency probe simply stops
/// probing, with no failure to warn anyone. Reordering on this transport
/// surfaces as WRONG PIXELS, not as a slow cell.
///
/// Over-budget opens throw the typed reason the renderer's resolver maps to a
/// per-source downgrade to the next tier.
const MAX_HW_SESSIONS = 5

/// Barrier strategy applied before a slot is acked, read ONCE from
/// `WEFTCUT_HW_BARRIER` and reported on every open reply (see `HwBarrierMode`
/// for what each mode does, and note that under `rendererFence` the barrier runs
/// in the RENDERER, not the preload). Main owns the decision rather than either
/// of them so one process reads the environment and every session agrees on the
/// answer.
///
/// Silent defaulting is deliberate: a typo'd mode must degrade to a mode that
/// ORDERS CORRECTLY, so the fall-through can only ever be one of the deferred
/// fences or `readback`, never the reordering `none`/`gpuflush`.
const HW_BARRIER_MODES: readonly HwBarrierMode[] = [
  'readback',
  'fence',
  'gpuflush',
  'none',
  'rendererFence',
]
const HW_BARRIER_DEFAULT: HwBarrierMode = 'rendererFence'
const HW_BARRIER_MODE: HwBarrierMode = HW_BARRIER_MODES.includes(
  (process.env.WEFTCUT_HW_BARRIER ?? '') as HwBarrierMode,
)
  ? (process.env.WEFTCUT_HW_BARRIER as HwBarrierMode)
  : HW_BARRIER_DEFAULT

/// Live HW-session count (for the renderer's budget-aware resolution + tests).
export function hwSessionCount(): number {
  return sessions.size
}

/// The budget as the renderer sees it (`previewGpu:budget`). The count alone is
/// unreadable without the cap it is compared against, so both travel together —
/// a lane readout wants "2/5", not "2". Whether an open would be REFUSED is the
/// only decision this supports, and `used >= max` is that predicate.
///
/// A sample is a point in time, not a promise: the count falls asynchronously
/// (a renderer teardown fires `previewGpu:close` without awaiting it), so
/// `used < max` at read time does not guarantee the next open succeeds.
export function hwBudget(): PreviewGpuBudget {
  return { used: sessions.size, max: MAX_HW_SESSIONS }
}

/// Tail of the open-serialisation chain. `openPreviewGpu` awaits inside its
/// per-slot announce→import→send loop, so two concurrent `previewGpu:open`
/// invokes would interleave their loops — and the preload pairs receiver
/// callbacks to announces through ONE positional FIFO queue, so interleaved
/// opens mis-key each other's slot textures (wrong pixels, or a slot with no
/// import at all). Chaining every open through here keeps at most one loop
/// in flight. Cheap: opens are rare (once per session) and short.
let openChain: Promise<unknown> = Promise.resolve()

/// Open a native GPU-decode session and hand its whole shared-texture pool to
/// the renderer up front. For each slot we announce the slot index, import the
/// shared handle, and transfer it to the renderer's main frame — in that order,
/// because the preload pairs each incoming receiver callback to a slot by the
/// FIFO order of the `previewGpu:slot` announces, and each announce must be
/// enqueued renderer-side before its sendSharedTexture makes the receiver fire.
export function openPreviewGpu(
  backend: NativeDecode,
  win: BrowserWindow,
  streamId: string,
  path: string,
  poolSize: number,
  colorSpace: ColorSpace,
): Promise<{ width: number; height: number; poolSize: number; barrierMode: HwBarrierMode }> {
  // Serialise: run after whatever open is already in flight, succeeded or not
  // (hence the `.catch`, so one failed open doesn't poison the chain).
  const mine = openChain
    .catch(() => {})
    .then(() => doOpenPreviewGpu(backend, win, streamId, path, poolSize, colorSpace))
  openChain = mine
  return mine
}

async function doOpenPreviewGpu(
  backend: NativeDecode,
  win: BrowserWindow,
  streamId: string,
  path: string,
  poolSize: number,
  colorSpace: ColorSpace,
): Promise<{ width: number; height: number; poolSize: number; barrierMode: HwBarrierMode }> {
  // Budget gate FIRST — before any native allocation. The throw rejects the
  // `previewGpu:open` invoke; the renderer's resolver treats 'hw-budget-exceeded'
  // as a sticky downgrade off tier 1 rather than a hard failure.
  if (sessions.size >= MAX_HW_SESSIONS) throw new Error(HW_BUDGET_EXCEEDED)
  // Latch the barrier mode in the preload. WHERE THIS SITS IS THE CONTRACT:
  // after the budget gate (a refused open must not latch a stream that will
  // never produce a frame) and before `previewGpuOpen` (which starts the decode
  // thread — the first thing that can emit a frameReady poke).
  //
  // `evt:previewGpu:barrier` and `evt:previewGpu:frameReady` are the SAME
  // ordered webContents channel, so sending here — before the producer exists —
  // is what guarantees the preload has the mode before any frame of this stream
  // arrives. Move this below the native open and the race silently returns: an
  // early frame finds no latch, stamps the preload's unlatched fallback, later
  // frames stamp the configured mode, and the session reports two applied modes.
  // That reads as an INVALID bench cell, not a slow one.
  //
  // The open reply can't carry this job (though it still carries the value, as
  // the configured label to check the observed one against): an invoke reply is
  // a separate channel, and it loses to frameReady once 2+ sessions are opening.
  win.webContents.send('evt:previewGpu:barrier', { streamId, mode: HW_BARRIER_MODE })
  const info = backend.previewGpuOpen(streamId, path, poolSize)
  const imported: SharedTextureImported[] = []
  try {
    for (let k = 0; k < info.slots.length; k++) {
      // Slot-correlation announce FIRST (see fn doc): the preload pushes this onto
      // its announce queue and pairs the NEXT receiver callback to slot k.
      win.webContents.send('evt:previewGpu:slot', { streamId, slot: k })
      const imp = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: info.width, height: info.height },
          visibleRect: { x: 0, y: 0, width: info.width, height: info.height },
          pixelFormat: 'nv12',
          colorSpace,
          timestamp: 0,
          // info.slots[k].handle is the LE bytes of the slot texture's NT handle.
          handle: { ntHandle: info.slots[k].handle },
        },
        // Persistent import: keep the texture importable for every frame. We never
        // call .release() until closePreviewGpu, so this callback stays a no-op.
        allReferencesReleased: () => {},
      })
      // Track the import the instant it exists (importSharedTexture holds a GPU
      // reference from the moment it returns, per Electron docs) — BEFORE the
      // fallible send below, so the catch's release loop covers this slot too
      // if sendSharedTexture throws.
      imported.push(imp)
      // sendSharedTexture has its own internal timeout (~1000ms) and can reject.
      await sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imp })
    }
  } catch (err) {
    // Partial-open failure: slots 0..k-1 are already imported, but we haven't
    // reached `sessions.set` yet, so a later close() would find no session and
    // leak both those imports and the native session `previewGpuOpen` already
    // created. Release what succeeded and drop the orphaned native session
    // ourselves, then rethrow so the ipc caller sees the open failure.
    for (const imp of imported) imp.release()
    backend.previewGpuClose(streamId)
    throw err
  }
  sessions.set(streamId, { imported, width: info.width, height: info.height })
  return { width: info.width, height: info.height, poolSize: info.slots.length, barrierMode: HW_BARRIER_MODE }
}

/// Move the session's decode anchor. targetUs is source microseconds; the addon
/// takes it as f64 (napi has no ergonomic i64 param) and casts down internally.
export function requestFrameAtPreviewGpu(backend: NativeDecode, streamId: string, targetUs: number): void {
  backend.previewGpuRequestFrameAt(streamId, targetUs)
}

/// Release a slot back to the native pool. Called by the preload's per-frame
/// loop AFTER createImageBitmap resolves (the ack-after-read contract) — never
/// before, or the native side could overwrite the slot mid-read.
export function consumeAckPreviewGpu(backend: NativeDecode, streamId: string, slot: number): void {
  backend.previewGpuConsumeAck(streamId, slot)
}

/// Drain a session's per-frame timing samples. Delegates straight to the addon;
/// the registry drains its accumulator and returns the ms summaries.
export function takeTimingsPreviewGpu(backend: NativeDecode, streamId: string): PreviewGpuTimingReport {
  return backend.previewGpuTakeTimings(streamId)
}

/// Tear down a session. Close the native side FIRST (it signals + joins the
/// decode thread, so no frame can be mid-read afterward), THEN drop our
/// persistent imports and forget the session.
///
/// Idempotent no-op when there is no live session: the open-catch above already
/// calls backend.previewGpuClose on a partial-open failure (without ever calling
/// sessions.set), so an ordinary dispose()->close() that follows would otherwise
/// call the native close a SECOND time on an unknown/already-closed stream —
/// which the native registry may reject. Gate on sessions.has() so a caller can
/// always call close() exactly once per open() attempt, succeeded or not.
export function closePreviewGpu(backend: NativeDecode, streamId: string): void {
  // Drop any un-acked send stamps for this stream so a frame in flight at
  // teardown can't leak a pending-map entry (decode-bench signal attribution).
  clearMainPendingFor(streamId)
  const session = sessions.get(streamId)
  if (!session) return
  backend.previewGpuClose(streamId)
  for (const imp of session.imported) imp.release()
  sessions.delete(streamId)
}
