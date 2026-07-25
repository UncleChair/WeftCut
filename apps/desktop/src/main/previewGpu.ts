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
import type { PreviewGpuTimingReport } from '../shared/ipc'
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

/// Conservative HW-session cap (bench data is single-source; widen only on
/// measurement). 3 sessions × 3 slots × ~4.5MB/1080p-NV12-slot ≈ 40MB VRAM
/// steady-state. Over-budget opens throw the typed reason the renderer's
/// resolver maps to a per-source downgrade to the next tier.
const MAX_HW_SESSIONS = 3

/// Live HW-session count (for the renderer's budget-aware resolution + tests).
export function hwSessionCount(): number {
  return sessions.size
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
): Promise<{ width: number; height: number; poolSize: number }> {
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
): Promise<{ width: number; height: number; poolSize: number }> {
  // Budget gate FIRST — before any native allocation. The throw rejects the
  // `previewGpu:open` invoke; the renderer's resolver treats 'hw-budget-exceeded'
  // as a sticky downgrade off tier 1 rather than a hard failure.
  if (sessions.size >= MAX_HW_SESSIONS) throw new Error('hw-budget-exceeded')
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
  return { width: info.width, height: info.height, poolSize: info.slots.length }
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
