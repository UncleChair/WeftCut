// Main-process manager for native GPU-decode preview sessions. Owns the
// PERSISTENT shared-texture imports: each pool slot is importSharedTexture'd +
// sendSharedTexture'd EXACTLY ONCE at open, then kept alive for the whole
// session so the underlying D3D11 NV12 textures stay reusable. Per-frame
// traffic is only frameReady/consumeAck pokes — never a per-frame import/send.
//
// Why persistent, not per-frame: per-frame sendSharedTexture is the stale
// IPC-bound path (Result-4 persistent-import model in the Stage-2 design). A
// benchmark built on it would report IPC latency as "native throughput".
//
// Windows-only: the addon's previewGpu* methods throw "preview-gpu not built"
// elsewhere. This module never inspects the platform — it just delegates; the
// selection gate upstream (Task 7) decides when a GPU session is even opened.
import { sharedTexture } from 'electron'
import type { BrowserWindow, ColorSpace, SharedTextureImported } from 'electron'
import type { Backend } from '@weftcut/core'
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

/// Open a native GPU-decode session and hand its whole shared-texture pool to
/// the renderer up front. For each slot we announce the slot index, import the
/// shared handle, and transfer it to the renderer's main frame — in that order,
/// because the preload pairs each incoming receiver callback to a slot by the
/// FIFO order of the `previewGpu:slot` announces, and each announce must be
/// enqueued renderer-side before its sendSharedTexture makes the receiver fire.
export async function openPreviewGpu(
  backend: Backend,
  win: BrowserWindow,
  streamId: string,
  path: string,
  poolSize: number,
  colorSpace: ColorSpace,
): Promise<{ width: number; height: number; poolSize: number }> {
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
export function requestFrameAtPreviewGpu(backend: Backend, streamId: string, targetUs: number): void {
  backend.previewGpuRequestFrameAt(streamId, targetUs)
}

/// Release a slot back to the native pool. Called by the preload's per-frame
/// loop AFTER createImageBitmap resolves (the ack-after-read contract) — never
/// before, or the native side could overwrite the slot mid-read.
export function consumeAckPreviewGpu(backend: Backend, streamId: string, slot: number): void {
  backend.previewGpuConsumeAck(streamId, slot)
}

/// Drain a session's Stage-3 timing samples. Delegates straight to the addon;
/// the registry drains its accumulator and returns the ms summaries.
export function takeTimingsPreviewGpu(backend: Backend, streamId: string): PreviewGpuTimingReport {
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
export function closePreviewGpu(backend: Backend, streamId: string): void {
  // Drop any un-acked send stamps for this stream so a frame in flight at
  // teardown can't leak a pending-map entry (decode-bench signal attribution).
  clearMainPendingFor(streamId)
  const session = sessions.get(streamId)
  if (!session) return
  backend.previewGpuClose(streamId)
  for (const imp of session.imported) imp.release()
  sessions.delete(streamId)
}
