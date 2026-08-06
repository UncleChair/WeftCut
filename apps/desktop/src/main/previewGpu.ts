// Main-process manager for native GPU-decode preview sessions. Owns the
// PERSISTENT shared-texture imports: each pool slot is importSharedTexture'd +
// sendSharedTexture'd EXACTLY ONCE at open, then kept alive for the whole
// session so the underlying D3D11 RGBA textures stay reusable. Per-frame
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
  HW_BUDGET_RESERVATION_MISMATCH,
  type HwBarrierMode,
  type PreviewGpuBudgetSnapshot,
  type PreviewGpuTimingReport,
} from '../shared/ipc'
import { clearMainPendingFor } from './previewGpuTiming.js'
import {
  createPreviewGpuBudget,
  type PreviewGpuBudgetLease,
} from './previewGpuBudget.js'

interface GpuSession {
  // One imported texture per pool slot, indexed by the slot number the native
  // side names in frameReady{slot}. Held for the session's lifetime and NEVER
  // released mid-session — releasing would tear down the shared textures the
  // decode thread keeps writing into. Released only in closePreviewGpu.
  imported: SharedTextureImported[]
  width: number
  height: number
  budgetLease: PreviewGpuBudgetLease
}

const sessions = new Map<string, GpuSession>()

/// The import tag for every A′ slot texture: the native conversion shader
/// already produced working-space RGBA, so the browser must treat the bytes
/// as plain sRGB and do NO color math of its own. This constant + the native
/// shader constants together ARE the color contract; the source's real tags
/// travel to native via `previewGpuOpen(matrix, fullRange)` instead.
const SRGB_PASSTHROUGH: ColorSpace = {
  primaries: 'bt709',
  transfer: 'srgb',
  matrix: 'rgb',
  range: 'full',
}

/// One admission authority for every open/close. It greedily reserves coded
/// pixel AREA (30fps-calibrated, not pixel-rate) plus a hard session slot before
/// native allocation. The module owns validation, rollback and idempotent lease
/// release; callers never recompute policy.
const previewGpuBudget = createPreviewGpuBudget()

/// Best-effort GPU-reference teardown: one broken Electron import must not
/// prevent the remaining imports from releasing. Admission release is owned by
/// each caller's surrounding `finally`, so this helper never touches the lease.
function releaseImports(
  imported: readonly SharedTextureImported[],
  streamId: string,
  phase: 'rollback' | 'close',
): void {
  for (const imp of imported) {
    try {
      imp.release()
    } catch (releaseErr) {
      console.warn(`[main] previewGpu ${phase} import release failed for ${streamId}`, releaseErr)
    }
  }
}

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
  return previewGpuBudget.snapshot().sessions.used
}

/// The budget as the renderer sees it (`previewGpu:budget`). Both admission
/// constraints travel together: the hard session cap and the coded-pixel-area
/// currency calibrated on the 30fps fixtures. Either constraint can refuse an
/// open.
///
/// A sample is a point in time, not a promise: the count falls asynchronously
/// (a renderer teardown fires `previewGpu:close` without awaiting it), so
/// `used < max` at read time does not guarantee the next open succeeds.
///
/// `slotVram` is computed HERE from the live session records (the admission
/// lease knows coded area but not pool size): Σ w×h×4×slots over open
/// sessions — the measured pool VRAM, not an estimate.
export function hwBudget(): PreviewGpuBudgetSnapshot {
  let usedBytes = 0
  for (const s of sessions.values()) usedBytes += s.width * s.height * 4 * s.imported.length
  return { ...previewGpuBudget.snapshot(), slotVram: { usedBytes, bytesPerPixel: 4 } }
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
  codedWidth: number,
  codedHeight: number,
): Promise<{ width: number; height: number; poolSize: number; barrierMode: HwBarrierMode }> {
  // Serialise: run after whatever open is already in flight, succeeded or not
  // (hence the `.catch`, so one failed open doesn't poison the chain).
  const mine = openChain
    .catch(() => {})
    .then(() =>
      doOpenPreviewGpu(
        backend,
        win,
        streamId,
        path,
        poolSize,
        colorSpace,
        codedWidth,
        codedHeight,
      ),
    )
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
  codedWidth: number,
  codedHeight: number,
): Promise<{ width: number; height: number; poolSize: number; barrierMode: HwBarrierMode }> {
  // Reserve FIRST — before the barrier latch and before any native allocation.
  // Invalid/missing dimensions fail closed in the same transient capacity class:
  // a stale probe must never let main under-count decode load.
  const budgetLease = previewGpuBudget.reserve(streamId, {
    width: codedWidth,
    height: codedHeight,
  })
  if (!budgetLease) throw new Error(HW_BUDGET_EXCEEDED)
  const imported: SharedTextureImported[] = []
  let nativeOpened = false
  try {
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
    // A′ color sovereignty: the SOURCE color tags go to native, which converts
    // NV12→RGBA with its own shader (constants pinned to the conformance
    // goldens). Chromium never sees the YUV. `derived`/`invalid` ranges fall
    // to limited — the same fail-closed default the WebCodecs lane uses.
    const info = backend.previewGpuOpen(
      streamId,
      path,
      poolSize,
      colorSpace.matrix ?? 'bt709',
      colorSpace.range === 'full',
    )
    nativeOpened = true
    if (info.width !== codedWidth || info.height !== codedHeight) {
      throw new Error(
        `${HW_BUDGET_RESERVATION_MISMATCH}: reserved ${codedWidth}x${codedHeight}, native opened ${info.width}x${info.height}`,
      )
    }
    for (let k = 0; k < info.slots.length; k++) {
      // Slot-correlation announce FIRST (see fn doc): the preload pushes this onto
      // its announce queue and pairs the NEXT receiver callback to slot k.
      win.webContents.send('evt:previewGpu:slot', { streamId, slot: k })
      const imp = sharedTexture.importSharedTexture({
        textureInfo: {
          codedSize: { width: info.width, height: info.height },
          visibleRect: { x: 0, y: 0, width: info.width, height: info.height },
          // The slots are native-converted RGBA (A′): import as 'rgba' tagged
          // sRGB passthrough, NOT the source's colorSpace — the color math
          // already happened in the native shader, and this tag is what makes
          // the preload's createImageBitmap a pure byte copy (byte-exact on
          // both geometries). Chromium gets no YUV to convert.
          pixelFormat: 'rgba',
          colorSpace: SRGB_PASSTHROUGH,
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
    sessions.set(streamId, {
      imported,
      width: info.width,
      height: info.height,
      budgetLease,
    })
    return {
      width: info.width,
      height: info.height,
      poolSize: info.slots.length,
      barrierMode: HW_BARRIER_MODE,
    }
  } catch (err) {
    // Partial-open failure: slots 0..k-1 are already imported, but we haven't
    // reached `sessions.set` yet, so a later close() would find no session and
    // leak both those imports and the native session `previewGpuOpen` already
    // created. Release what succeeded and drop the orphaned native session
    // ourselves, then rethrow so the ipc caller sees the open failure.
    if (nativeOpened) {
      try {
        backend.previewGpuClose(streamId)
      } catch (closeErr) {
        console.warn(`[main] previewGpu rollback close failed for ${streamId}`, closeErr)
      }
    }
    try {
      releaseImports(imported, streamId, 'rollback')
    } finally {
      // A texture release may itself fail. Admission must still roll back or a
      // single partial open can permanently leak capacity.
      previewGpuBudget.release(budgetLease)
    }
    throw err
  }
}

/// Move the session's decode anchor. targetUs is source microseconds; the addon
/// takes it as f64 (napi has no ergonomic i64 param) and casts down internally.
export function requestFrameAtPreviewGpu(backend: NativeDecode, streamId: string, targetUs: number): void {
  backend.previewGpuRequestFrameAt(streamId, targetUs)
}

/// Release a slot back to the native pool. Called by the preload's per-frame
/// loop AFTER createImageBitmap resolves (the ack-after-read contract) — never
/// before, or the native side could overwrite the slot mid-read. `gen` echoes
/// the frameReady's fill generation (fencing token); native drops a mismatch.
export function consumeAckPreviewGpu(backend: NativeDecode, streamId: string, slot: number, gen: number): void {
  backend.previewGpuConsumeAck(streamId, slot, gen)
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
  // Remove first so duplicate/re-entrant close is a no-op. The lease itself is
  // identity-checked too, so no stale close can release a newer same-id open.
  sessions.delete(streamId)
  try {
    backend.previewGpuClose(streamId)
  } finally {
    try {
      releaseImports(session.imported, streamId, 'close')
    } finally {
      previewGpuBudget.release(session.budgetLease)
    }
  }
}
