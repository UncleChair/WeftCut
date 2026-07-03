//! Per-session decode thread + shared NV12 texture pool + registry.
//!
//! Each preview session owns a dedicated OS thread pinned to its `!Send`
//! D3D11 + ffmpeg objects: the thread opens the `VideoStream`, builds a pool of
//! shared NV12 textures on ffmpeg's own D3D11 device, and runs an anchor-driven
//! decode loop. napi commands (`request_frame_at` / `consume_ack` / `close`)
//! post messages to the thread over an mpsc channel; decoded frames are
//! announced back out through a poke sink (`FrameReady` / `Eof` / `Error`).
//!
//! Why a thread per session: decode must not block the Node main thread, and
//! the D3D11/ffmpeg COM objects are `!Send`. Rather than fight that with unsound
//! `unsafe`, we simply never move them across threads — they are created,
//! used, and dropped entirely on the session's own thread. Only plain `Send`
//! data crosses the boundary: into the thread go the command `Receiver`, the
//! poke `Arc`, and the path/id strings; out of the thread come the slot NT
//! handle *values* (`i64`, not COM pointers) + dimensions, and the pokes. No COM
//! pointer is ever sent, so no `unsafe impl Send` is required here.
//!
//! Slot coherence: a slot is overwritten only after its `consume_ack` marked it
//! free. That ack — fired by Electron's `allReferencesReleased` in the renderer,
//! *not* the keyed mutex across the async `createImageBitmap` boundary — is the
//! coherence guarantee. With `pool_size >= 2` the producer fills slot B while the
//! renderer still snapshots slot A. The keyed mutex only serialises our GPU write
//! against Chromium's GPU read of the same texture.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

use super::decoder::{StreamFrame, VideoStream};

/// Wait `INFINITE` on the keyed mutex — safe because we only ever write a slot
/// the renderer already released (via `consume_ack`), so Chromium isn't holding
/// its read lock when we `AcquireSync`.
const INFINITE: u32 = 0xFFFF_FFFF;
/// `DXGI_SHARED_RESOURCE_READ (0x80000000) | DXGI_SHARED_RESOURCE_WRITE (0x1)`.
/// Raw u32 because the windows-crate newtype OR doesn't coerce to the method's
/// `u32` parameter.
const DXGI_SHARED_RESOURCE_RW: u32 = 0x8000_0001;

/// How far ahead of the anchor the pump pre-decodes. Bounds pre-buffering so a
/// scrub doesn't decode-and-discard a long tail past the new target. ~15 frames
/// at 30 fps; in practice the pool size usually binds first (a full pool stops
/// the pump before this does). Kept <= the implicit backward tolerance so that
/// during forward playback the anchor trailing the frontier never looks like a
/// backward seek.
const LOOKAHEAD_US: i64 = 500_000;

/// A forward jump larger than this (beyond the decoded frontier) seeks to a
/// keyframe instead of decode-and-discarding the gap; smaller forward moves
/// decode naturally. Any backward move always seeks.
const SEEK_FORWARD_THRESHOLD_US: i64 = 1_000_000;

/// recv timeout so the pump makes progress (freed slot -> decode) between
/// messages without busy-spinning.
const RECV_TIMEOUT: Duration = Duration::from_millis(4);

/// Announced out of the session thread. `Send` so it can travel to whatever
/// sink Task 5 wires to the addon's event channel. Carries only plain data.
pub enum PreviewGpuPoke {
    /// A decoded frame was copied into `slot`; the renderer may import/snapshot
    /// it, then `consume_ack(slot)` to release it back to the pool.
    FrameReady {
        stream_id: String,
        slot: u32,
        pts_us: i64,
        dur_us: i64,
    },
    /// The stream reached its end (no more frames until a backward `request_frame_at`).
    Eof { stream_id: String },
    /// A non-fatal notification of a decode/seek/GPU failure. The session stays
    /// registered; a decode error additionally halts the pump until a seek.
    Error { stream_id: String, message: String },
}

/// Boxed poke sink shared with every session thread. `Mutex<Box<dyn Fn + Send>>`
/// is `Send + Sync` (a `Mutex<T>` is `Sync` when `T: Send`), so an `Arc` of it
/// can be cloned into each thread and the mutex serialises calls — sound even
/// though the closure is only `Send`, not `Sync`.
type PokeSink = Arc<Mutex<Option<Box<dyn Fn(PreviewGpuPoke) + Send>>>>;

/// Control messages posted to a session thread by the registry.
enum SessionMsg {
    /// Set the decode anchor to this source-microsecond target.
    RequestFrameAt(i64),
    /// The renderer released this slot; it may be reused.
    ConsumeAck(u32),
    /// Tear down and exit the thread.
    Close,
}

/// What `open` hands back to the caller: the pool's per-slot NT handle *values*
/// (each an `i64`; the main process wraps them to a Buffer for
/// `importSharedTexture`) plus the frame dimensions.
pub struct OpenInfo {
    pub width: u32,
    pub height: u32,
    pub slot_handles: Vec<i64>,
}

/// The registry's per-session handle. COM objects live on the thread, not here;
/// this side keeps only the command channel + join handle.
struct Session {
    tx: Sender<SessionMsg>,
    join: Option<JoinHandle<()>>,
    #[allow(dead_code)]
    width: u32,
    #[allow(dead_code)]
    height: u32,
}

/// One reusable shared NV12 texture in the pool. Created on ffmpeg's device and
/// overwritten in place each time its slot is (re)filled.
struct PoolSlot {
    texture: ID3D11Texture2D,
    keyed_mutex: IDXGIKeyedMutex,
    handle: HANDLE,
}

/// Everything the session thread owns and mutates. Never leaves the thread, so
/// it needs no `Send` impl despite the `!Send` COM + ffmpeg objects.
struct SessionState {
    stream: VideoStream,
    /// ffmpeg's device, cloned (AddRef) so it outlives the decoder; the pool
    /// textures were created on it. The per-frame copy goes through `context`.
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    pool: Vec<PoolSlot>,
    /// Per-slot free flag, owned solely by this thread (acks arrive as messages,
    /// so no cross-thread access -> a plain `Vec<bool>`, no atomics needed).
    free: Vec<bool>,
    width: u32,
    height: u32,
    /// Current decode target (source microseconds). `i64::MIN` before the first
    /// `request_frame_at`.
    anchor: i64,
    /// pts of the furthest frame decoded (delivered *or* discarded); `i64::MIN`
    /// when nothing has been decoded since open or since the last seek. Drives
    /// the lookahead gate and the forward-jump seek test.
    frontier_pts: i64,
    /// pts of the last frame actually delivered; `i64::MIN` if none.
    last_delivered_pts: i64,
    /// Set right after a seek: discard decoded frames whose pts is before the
    /// anchor until the first one at/after it.
    post_seek: bool,
    /// Decoder is drained; the pump idles until a backward seek resets this.
    eof: bool,
}

impl Drop for SessionState {
    fn drop(&mut self) {
        // Close each slot's NT handle before the textures (and device/decoder)
        // release, mirroring the poc teardown order.
        unsafe {
            for slot in &self.pool {
                let _ = CloseHandle(slot.handle);
            }
        }
        // stream (decoder + hw_ctx), _device, context, and the pool textures
        // drop here; COM refcounting makes the exact order safe.
    }
}

impl SessionState {
    fn slot_handles(&self) -> Vec<i64> {
        self.pool
            .iter()
            .map(|s| s.handle.0 as isize as i64)
            .collect()
    }

    /// A slot the renderer has released, if any.
    fn free_slot(&self) -> Option<usize> {
        self.free.iter().position(|&f| f)
    }

    /// Handle a `request_frame_at`: set the anchor and, if the target left the
    /// current forward window, seek. A backward move always seeks; a forward
    /// move seeks only when it jumps well past the decoded frontier.
    fn on_request(&mut self, t: i64, poke: &PokeSink, stream_id: &str) {
        let needs_seek = if self.frontier_pts == i64::MIN {
            // Nothing decoded yet: seek only if the very first target is far from
            // the container start; a target near 0 is cheaper to reach by
            // natural forward decode.
            t > SEEK_FORWARD_THRESHOLD_US
        } else if t < self.anchor {
            // Playhead moved backward — forward decode can't rewind.
            true
        } else {
            // Forward move: seek only on a large jump beyond what we've decoded.
            t > self.frontier_pts.saturating_add(SEEK_FORWARD_THRESHOLD_US)
        };
        self.anchor = t;
        if needs_seek {
            match self.stream.seek(t) {
                Ok(()) => {
                    self.post_seek = true;
                    self.eof = false;
                    self.frontier_pts = i64::MIN;
                    self.last_delivered_pts = i64::MIN;
                }
                Err(e) => {
                    // Non-fatal: leave the decode position as-is and report it;
                    // the caller can retry. Don't set eof.
                    emit(
                        poke,
                        PreviewGpuPoke::Error {
                            stream_id: stream_id.to_string(),
                            message: format!("seek to {t}us failed: {e}"),
                        },
                    );
                }
            }
        }
    }

    /// Decode forward into free slots until the pool is full, the lookahead is
    /// satisfied, or the stream ends. Called after every message and on every
    /// recv timeout, so freed slots get refilled promptly without busy-spinning.
    fn pump(&mut self, poke: &PokeSink, stream_id: &str) {
        loop {
            if self.eof {
                return;
            }
            // A free slot is required to decode: a deliverable frame must land
            // somewhere, and its GPU surface is only valid until the next
            // `next_frame`. Discarded (pre-anchor) frames don't consume the slot,
            // so one free slot covers the whole post-seek discard + first deliver.
            let Some(slot_idx) = self.free_slot() else {
                return; // pool full; wait for a ConsumeAck.
            };
            // Lookahead gate: stop once decoded far enough ahead of the anchor.
            // (frontier is behind the anchor during post-seek discard, so this
            // never fires mid-discard.)
            if self.frontier_pts != i64::MIN
                && self.frontier_pts >= self.anchor.saturating_add(LOOKAHEAD_US)
            {
                return;
            }

            let decoded = match self.stream.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    self.eof = true;
                    emit(
                        poke,
                        PreviewGpuPoke::Eof {
                            stream_id: stream_id.to_string(),
                        },
                    );
                    return;
                }
                Err(e) => {
                    // Halt the pump so we don't spin on a persistent error; a
                    // later seek reopens decoding.
                    self.eof = true;
                    emit(
                        poke,
                        PreviewGpuPoke::Error {
                            stream_id: stream_id.to_string(),
                            message: e,
                        },
                    );
                    return;
                }
            };

            // Post-seek: drop frames before the anchor (the seek landed on a
            // keyframe at/<= the target) until the first one at/after it.
            if self.post_seek {
                if decoded.pts_us < self.anchor {
                    self.frontier_pts = decoded.pts_us;
                    continue; // slot stays free
                }
                self.post_seek = false;
            }

            let copy = unsafe {
                copy_frame_into_slot(
                    &self.context,
                    &self.pool[slot_idx],
                    &self.stream,
                    &decoded,
                    self.width,
                    self.height,
                )
            };
            if let Err(e) = copy {
                self.eof = true;
                emit(
                    poke,
                    PreviewGpuPoke::Error {
                        stream_id: stream_id.to_string(),
                        message: e,
                    },
                );
                return;
            }

            self.free[slot_idx] = false;
            self.frontier_pts = decoded.pts_us;
            self.last_delivered_pts = decoded.pts_us;
            emit(
                poke,
                PreviewGpuPoke::FrameReady {
                    stream_id: stream_id.to_string(),
                    slot: slot_idx as u32,
                    pts_us: decoded.pts_us,
                    dur_us: decoded.dur_us,
                },
            );
        }
    }
}

/// Copy the decoded GPU surface into a pool slot, bracketed by the slot's keyed
/// mutex (our write vs. Chromium's read) and ffmpeg's device-context lock
/// (decode thread vs. this copy). Lifted from the poc's in-place slot overwrite.
///
/// # Safety
/// `decoded.src_texture` must still be valid (no `next_frame` since it was
/// produced), and `context`/`stream` must be the ones the surface belongs to.
unsafe fn copy_frame_into_slot(
    context: &ID3D11DeviceContext,
    slot: &PoolSlot,
    stream: &VideoStream,
    decoded: &StreamFrame,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let src_tex = ID3D11Texture2D::from_raw_borrowed(&decoded.src_texture)
        .ok_or_else(|| "decoded D3D11 texture is null".to_string())?;

    slot.keyed_mutex
        .AcquireSync(0, INFINITE)
        .map_err(|e| format!("AcquireSync(slot) failed: {e}"))?;
    if let Some(lock) = stream.lock {
        lock(stream.lock_ctx);
    }
    let region = D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: width,
        bottom: height,
        back: 1,
    };
    context.CopySubresourceRegion(
        &slot.texture,
        0,
        0,
        0,
        0,
        src_tex,
        decoded.src_index,
        Some(&region),
    );
    context.Flush();
    if let Some(unlock) = stream.unlock {
        unlock(stream.lock_ctx);
    }
    slot.keyed_mutex
        .ReleaseSync(0)
        .map_err(|e| format!("ReleaseSync(slot) failed: {e}"))?;
    Ok(())
}

/// Fire a poke through the shared sink if one is set. The mutex is held across
/// the call so concurrent sessions serialise (Task 5's sink is a non-blocking
/// event enqueue, so this can't deadlock or stall).
fn emit(poke: &PokeSink, poke_val: PreviewGpuPoke) {
    let guard = poke.lock().unwrap();
    if let Some(sink) = guard.as_ref() {
        sink(poke_val);
    }
}

/// Open the decoder + build the shared NV12 pool on ffmpeg's device. Runs on the
/// session thread (all COM/ffmpeg objects stay here). Adapted from the poc's
/// `poc_open_video_stream` pool-creation block.
fn init_session(path: &str, pool_size: u32) -> Result<SessionState, String> {
    let stream = VideoStream::open(path)?;
    let (width, height) = (stream.width, stream.height);

    unsafe {
        // Borrow ffmpeg's device/context, then clone (AddRef) so they outlive the
        // decoder — the pool textures are created on this device.
        let device = ID3D11Device::from_raw_borrowed(&stream.device)
            .ok_or_else(|| "ffmpeg D3D11 device is null".to_string())?
            .clone();
        let context = ID3D11DeviceContext::from_raw_borrowed(&stream.device_context)
            .ok_or_else(|| "ffmpeg D3D11 device context is null".to_string())?
            .clone();

        // Raw D3D11 only shares an NT-handle texture when NTHANDLE + KEYEDMUTEX
        // are set together. Shared textures reject initial data; fill via copy.
        let nt_km =
            (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: nt_km,
        };

        let mut pool = Vec::with_capacity(pool_size as usize);
        for i in 0..pool_size {
            let mut tex: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(|e| format!("CreateTexture2D(pool slot {i}) failed: {e}"))?;
            let texture = tex.ok_or_else(|| "CreateTexture2D: null texture".to_string())?;
            let keyed_mutex: IDXGIKeyedMutex = texture
                .cast()
                .map_err(|e| format!("cast IDXGIKeyedMutex failed: {e}"))?;
            let resource: IDXGIResource1 = texture
                .cast()
                .map_err(|e| format!("cast IDXGIResource1 failed: {e}"))?;
            let handle = resource
                .CreateSharedHandle(None, DXGI_SHARED_RESOURCE_RW, PCWSTR::null())
                .map_err(|e| format!("CreateSharedHandle failed: {e}"))?;
            pool.push(PoolSlot {
                texture,
                keyed_mutex,
                handle,
            });
        }

        let free = vec![true; pool.len()];

        Ok(SessionState {
            stream,
            _device: device,
            context,
            pool,
            free,
            width,
            height,
            anchor: i64::MIN,
            frontier_pts: i64::MIN,
            last_delivered_pts: i64::MIN,
            post_seek: false,
            eof: false,
        })
    }
}

/// The session thread body: open + build the pool, report the result back to
/// `open`, then run the message/pump loop until `Close` (or the sender drops).
fn session_thread(
    stream_id: String,
    path: String,
    pool_size: u32,
    rx: Receiver<SessionMsg>,
    init_tx: Sender<Result<OpenInfo, String>>,
    poke: PokeSink,
) {
    let mut state = match init_session(&path, pool_size) {
        Ok(s) => s,
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };
    let info = OpenInfo {
        width: state.width,
        height: state.height,
        slot_handles: state.slot_handles(),
    };
    if init_tx.send(Ok(info)).is_err() {
        // `open` gave up waiting; drop `state` (Drop closes the handles).
        return;
    }

    loop {
        match rx.recv_timeout(RECV_TIMEOUT) {
            Ok(SessionMsg::RequestFrameAt(t)) => {
                state.on_request(t, &poke, &stream_id);
                state.pump(&poke, &stream_id);
            }
            Ok(SessionMsg::ConsumeAck(slot)) => {
                if let Some(f) = state.free.get_mut(slot as usize) {
                    *f = true;
                }
                state.pump(&poke, &stream_id);
            }
            Ok(SessionMsg::Close) => break,
            Err(RecvTimeoutError::Timeout) => {
                state.pump(&poke, &stream_id);
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // `state` drops here: closes each slot's NT handle, drops the VideoStream
    // (unrefs the hw context), device, context, and pool textures.
}

/// The set of live preview sessions. `Send + Sync`, so Task 5 can hold it in the
/// addon (e.g. behind an `Arc`) and drive it from napi calls.
pub struct PreviewGpuRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    poke: PokeSink,
}

impl Default for PreviewGpuRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewGpuRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            poke: Arc::new(Mutex::new(None)),
        }
    }

    /// Install the sink every session emits pokes through. Set once by Task 5
    /// before any `open`; sessions share the same cell, so a later set is seen
    /// by already-running threads too.
    pub fn set_poke_sink(&self, sink: Box<dyn Fn(PreviewGpuPoke) + Send>) {
        *self.poke.lock().unwrap() = Some(sink);
    }

    /// Open `path` for GPU preview: spawn its decode thread, build the pool, and
    /// hand back the slot NT handles + dimensions once the thread reports ready.
    pub fn open(&self, stream_id: &str, path: &str, pool_size: u32) -> Result<OpenInfo, String> {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(stream_id) {
            return Err(format!("preview-gpu session '{stream_id}' is already open"));
        }

        let (init_tx, init_rx) = mpsc::channel::<Result<OpenInfo, String>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<SessionMsg>();
        let poke = Arc::clone(&self.poke);
        let sid = stream_id.to_string();
        let path_owned = path.to_string();
        let pool_size = pool_size.max(1);

        let join = thread::Builder::new()
            .name(format!("preview-gpu-{sid}"))
            .spawn(move || session_thread(sid, path_owned, pool_size, cmd_rx, init_tx, poke))
            .map_err(|e| format!("spawn preview-gpu session thread failed: {e}"))?;

        // Block until the thread reports open success/failure. COM pointers never
        // cross the channel — only the handle values + dimensions do.
        match init_rx.recv() {
            Ok(Ok(info)) => {
                let (width, height) = (info.width, info.height);
                sessions.insert(
                    stream_id.to_string(),
                    Session {
                        tx: cmd_tx,
                        join: Some(join),
                        width,
                        height,
                    },
                );
                Ok(info)
            }
            Ok(Err(e)) => {
                // Thread returned after sending the error; reap it.
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                // Thread vanished before reporting (e.g. panicked in init).
                let _ = join.join();
                Err(format!(
                    "preview-gpu session '{stream_id}' thread exited before init"
                ))
            }
        }
    }

    /// Set the decode anchor for a session; the thread pumps lookahead toward it.
    pub fn request_frame_at(&self, stream_id: &str, target_us: i64) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        session
            .tx
            .send(SessionMsg::RequestFrameAt(target_us))
            .map_err(|_| format!("preview-gpu session '{stream_id}' thread is gone"))
    }

    /// Mark a slot free again (the renderer released its cross-process refs).
    pub fn consume_ack(&self, stream_id: &str, slot: u32) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        session
            .tx
            .send(SessionMsg::ConsumeAck(slot))
            .map_err(|_| format!("preview-gpu session '{stream_id}' thread is gone"))
    }

    /// Signal the session thread to tear down, then join it. The thread closes
    /// each slot's NT handle and drops the decoder on the way out.
    pub fn close(&self, stream_id: &str) -> Result<(), String> {
        // Remove from the map (releasing the sessions lock) *before* joining, so
        // a slow teardown doesn't block registry ops on other sessions.
        let mut session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(stream_id)
        };
        match session.as_mut() {
            Some(s) => {
                // Best-effort: if the thread already exited, the send fails —
                // join reaps it either way.
                let _ = s.tx.send(SessionMsg::Close);
                if let Some(join) = s.join.take() {
                    join.join().map_err(|_| {
                        format!("preview-gpu session '{stream_id}' thread panicked during teardown")
                    })?;
                }
                Ok(())
            }
            None => Err(format!("no preview-gpu session '{stream_id}'")),
        }
    }
}
