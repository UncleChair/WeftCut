// Main-process manager for native SOFTWARE-decode preview sessions (the
// WebCodecs-blind-format path: ProRes/DNxHD/MPEG-2/VC-1 — no shared-texture
// GPU pool, no proxy). MUCH simpler than previewGpu.ts: each decoded NV12
// frame ships as a plain napi Buffer through the addon's per-stream
// ThreadsafeFunction callback, which we relay straight to the renderer over a
// dedicated `previewSw:frame` channel. No slots, no consumeAck, no timings —
// the callback captures `win`, so routing is automatic (no
// `Map<streamId, webContents>` needed).
import type { BrowserWindow } from 'electron'
import type { NativeDecode } from '@weftcut/native-decode'

/// Open a native SW-decode session. Synchronous on the addon side: returns
/// frame dimensions immediately, and registers the frame callback BEFORE the
/// decode thread spawns, so no early frame is dropped. Frames only start
/// flowing after `requestFrameAtPreviewSw`.
///
/// `lane`/`device` optionally select a HARDWARE copy-back lane (Linux
/// NVDEC/VAAPI, `device` = the DRM node for VAAPI) that rides this SAME
/// transport as software — hw accel, then copy-back to the identical NV12
/// frames. A null `lane` = software decode, matching today exactly; the frame
/// contract the callback relays is unchanged either way.
///
/// `scaleDiv` is the playback-resolution divisor (1 | 2 | 4; null = 1 = full):
/// native swscales each frame DOWN before packing, so a 4K frame crosses this
/// IPC at a fraction of its 12.44 MB. The returned dimensions and every relayed
/// frame report the SHIPPED size — native owns that math.
export function openPreviewSw(
  backend: NativeDecode,
  win: BrowserWindow,
  streamId: string,
  path: string,
  lane: string | null,
  device: string | null,
  scaleDiv: number | null,
): { width: number; height: number } {
  const info = backend.previewSwOpen(streamId, path, (err: Error | null, frame) => {
    if (err) return
    if (win.isDestroyed()) return // renderer reloaded/closed mid-stream → webContents.send would throw
    win.webContents.send('previewSw:frame', frame)
  }, lane, device, scaleDiv)
  return { width: info.width, height: info.height }
}

/// Move the session's decode anchor. targetUs is source microseconds; the
/// addon takes it as f64 (napi has no ergonomic i64 param) and casts down
/// internally. Fire-and-forget: frames arrive via the registered callback.
export function requestFrameAtPreviewSw(backend: NativeDecode, streamId: string, targetUs: number): void {
  backend.previewSwRequestFrameAt(streamId, targetUs)
}

/// Tear down a session. Delegates straight to the addon, which closes+joins
/// the decode thread before dropping the per-stream ThreadsafeFunction.
export function closePreviewSw(backend: NativeDecode, streamId: string): void {
  backend.previewSwClose(streamId)
}
