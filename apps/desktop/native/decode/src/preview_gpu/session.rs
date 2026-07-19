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
use std::time::{Duration, Instant};

use windows::core::{Interface, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

use super::decoder::{StreamFrame, VideoStream};

/// Cap on retained timing samples per metric. A 30s throughput window at native's
/// ~44fps yields ~1300 samples — far under this; the cap is only a runaway backstop
/// (timing is native-only, so WebCodecs frame rates never reach it). Stop-appending
/// once full (keeps the earliest, steady-state samples).
pub const TIMING_SAMPLE_CAP: usize = 20_000;

/// Per-metric millisecond summary handed across the napi boundary (mapped to a
/// `#[napi(object)]` in `napi_backend.rs`). Percentiles use linear interpolation
/// over ascending samples, matching the TS-side `percentile` convention.
#[derive(Clone, Copy)]
pub struct TimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Both metrics drained together.
pub struct TimingReport {
    /// Whole JS coordination round-trip: `FrameReady` emit -> main relay -> preload
    /// getVideoFrame/createImageBitmap -> `consume_ack` relay back to this thread.
    pub coord_rtt: TimingSummary,
    /// Decode + GPU-copy cost for one delivered frame (`next_frame` + `copy_frame_into_slot`).
    pub decode_copy: TimingSummary,
    /// Bottleneck probe: gap from a slot's `ConsumeAck` (slot freed on this thread)
    /// to the *next* `FrameReady` emitted into that same slot. This is the one
    /// per-slot-cycle segment `coord_rtt` (emit->ack) does NOT cover; by
    /// telescoping, `coord_rtt.mean + ack_to_emit.mean` ~= the slot's inter-emit
    /// period (`pool_size * frame_interval`), so whichever is larger localises the
    /// throughput ceiling. A large `ack_to_emit` = the pump idles between freeing a
    /// slot and refilling it (Rust-side); a small one = the ceiling is the ack
    /// arrival rate (renderer-side). See the throughput-bottleneck handoff doc.
    pub ack_to_emit: TimingSummary,
    /// Corroborates `ack_to_emit`'s mechanism: count of `pump` early-returns caused
    /// by the lookahead gate *while a free slot was available*. If large, the pump
    /// idle is the lookahead/anchor gate (anchor not advancing); if ~0, the idle is
    /// pool-full (waiting on the renderer's ack cadence), not the gate. The only
    /// other early-return with a free slot is `eof`, excluded mid-stream.
    pub lookahead_gated_skips: u64,
    /// Round-2 thread time-budget probe (the per-slot probes above found the ~22ms
    /// is NOT per-slot — it is whole-pipeline dead time). These characterise the
    /// session thread's cadence directly, in its own clock:
    /// gap between consecutive `FrameReady` emits (ANY slot) — the true production interval.
    pub inter_emit: TimingSummary,
    /// gap between consecutive `ConsumeAck` arrivals (ANY slot) — the ack cadence.
    pub inter_ack: TimingSummary,
    /// duration of each `recv_timeout` call: ~0 when a message was already queued,
    /// ~`RECV_TIMEOUT` (4ms) when the thread blocked idle. Its sum ~= total thread
    /// idle time; a sum near the window means the thread is starved, not busy.
    pub recv_block: TimingSummary,
    /// How the thread woke, tallied over the window: 4ms `recv_timeout` expirations
    /// (idle ticks), `ConsumeAck` messages, and `RequestFrameAt` messages. Together
    /// with `inter_emit` these say whether production is paced by acks, by anchor
    /// nudges, or by the idle tick.
    pub recv_timeout_ticks: u64,
    pub recv_ack_msgs: u64,
    pub recv_req_msgs: u64,
    /// Round-3 stall attribution (the round-2 probe found production is a ~4s burst
    /// then a ~26s halt while the driver keeps nudging). Every `pump` early-return
    /// increments exactly one of these; the dominant one over the run names the
    /// halt: `eof_returns` = decoder ended, `pool_full_returns` = no free slot
    /// (slots stuck busy — renderer stopped acking), `acquire_failed` = keyed-mutex
    /// AcquireSync timed out (slot held by Chromium), `lookahead_gated_skips`
    /// (above) = anchor not advancing.
    pub eof_returns: u64,
    pub pool_full_returns: u64,
    pub acquire_failed: u64,
    /// Terminal state snapshot (last `pump` early-return wins): free-slot count and
    /// the eof flag when the pump last gave up. `free_slots == 0` at end confirms a
    /// pool-full stall; `eof == true` confirms a decoder end.
    pub final_free_slots: u32,
    pub final_eof: bool,
}

/// Session-thread timing accumulator. Nanosecond samples in; drained to ms summaries.
#[derive(Default)]
pub struct TimingAccum {
    coord_rtt_ns: Vec<u64>,
    decode_copy_ns: Vec<u64>,
    ack_to_emit_ns: Vec<u64>,
    lookahead_gated_skips: u64,
    inter_emit_ns: Vec<u64>,
    inter_ack_ns: Vec<u64>,
    recv_block_ns: Vec<u64>,
    recv_timeout_ticks: u64,
    recv_ack_msgs: u64,
    recv_req_msgs: u64,
    eof_returns: u64,
    pool_full_returns: u64,
    acquire_failed: u64,
    final_free_slots: u32,
    final_eof: bool,
}

impl TimingAccum {
    fn push_capped(buf: &mut Vec<u64>, ns: u64) {
        if buf.len() < TIMING_SAMPLE_CAP {
            buf.push(ns);
        }
    }
    pub fn push_coord_rtt(&mut self, ns: u64) {
        Self::push_capped(&mut self.coord_rtt_ns, ns);
    }
    pub fn push_decode_copy(&mut self, ns: u64) {
        Self::push_capped(&mut self.decode_copy_ns, ns);
    }
    pub fn push_ack_to_emit(&mut self, ns: u64) {
        Self::push_capped(&mut self.ack_to_emit_ns, ns);
    }
    /// A `pump` pass found a free slot but the lookahead gate stopped it decoding.
    /// Saturating so the runaway backstop matches the sample cap's intent (a 30s
    /// window can only tick the pump ~7.5k times via `RECV_TIMEOUT`, far under u64).
    pub fn note_lookahead_gated_skip(&mut self) {
        self.lookahead_gated_skips = self.lookahead_gated_skips.saturating_add(1);
    }
    pub fn push_inter_emit(&mut self, ns: u64) {
        Self::push_capped(&mut self.inter_emit_ns, ns);
    }
    pub fn push_inter_ack(&mut self, ns: u64) {
        Self::push_capped(&mut self.inter_ack_ns, ns);
    }
    pub fn push_recv_block(&mut self, ns: u64) {
        Self::push_capped(&mut self.recv_block_ns, ns);
    }
    pub fn note_recv_timeout(&mut self) {
        self.recv_timeout_ticks = self.recv_timeout_ticks.saturating_add(1);
    }
    pub fn note_recv_ack(&mut self) {
        self.recv_ack_msgs = self.recv_ack_msgs.saturating_add(1);
    }
    pub fn note_recv_req(&mut self) {
        self.recv_req_msgs = self.recv_req_msgs.saturating_add(1);
    }
    /// Round-3 pump-stop attribution. Each records the terminal free-slot count +
    /// eof flag (last-write-wins) alongside its reason tally.
    pub fn note_eof_return(&mut self, free_slots: u32, eof: bool) {
        self.eof_returns = self.eof_returns.saturating_add(1);
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    pub fn note_pool_full_return(&mut self, free_slots: u32, eof: bool) {
        self.pool_full_returns = self.pool_full_returns.saturating_add(1);
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    pub fn note_acquire_failed(&mut self, free_slots: u32, eof: bool) {
        self.acquire_failed = self.acquire_failed.saturating_add(1);
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    /// Compute the summaries and clear the buffers.
    pub fn drain(&mut self) -> TimingReport {
        let report = TimingReport {
            coord_rtt: summarize(&self.coord_rtt_ns),
            decode_copy: summarize(&self.decode_copy_ns),
            ack_to_emit: summarize(&self.ack_to_emit_ns),
            lookahead_gated_skips: self.lookahead_gated_skips,
            inter_emit: summarize(&self.inter_emit_ns),
            inter_ack: summarize(&self.inter_ack_ns),
            recv_block: summarize(&self.recv_block_ns),
            recv_timeout_ticks: self.recv_timeout_ticks,
            recv_ack_msgs: self.recv_ack_msgs,
            recv_req_msgs: self.recv_req_msgs,
            eof_returns: self.eof_returns,
            pool_full_returns: self.pool_full_returns,
            acquire_failed: self.acquire_failed,
            final_free_slots: self.final_free_slots,
            final_eof: self.final_eof,
        };
        self.coord_rtt_ns.clear();
        self.decode_copy_ns.clear();
        self.ack_to_emit_ns.clear();
        self.lookahead_gated_skips = 0;
        self.inter_emit_ns.clear();
        self.inter_ack_ns.clear();
        self.recv_block_ns.clear();
        self.recv_timeout_ticks = 0;
        self.recv_ack_msgs = 0;
        self.recv_req_msgs = 0;
        self.eof_returns = 0;
        self.pool_full_returns = 0;
        self.acquire_failed = 0;
        self.final_free_slots = 0;
        self.final_eof = false;
        report
    }
}

fn summarize(samples: &[u64]) -> TimingSummary {
    if samples.is_empty() {
        return TimingSummary {
            count: 0,
            mean_ms: 0.0,
            p50_ms: 0.0,
            p95_ms: 0.0,
            max_ms: 0.0,
        };
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    let ns_to_ms = |ns: f64| ns / 1_000_000.0;
    let sum: f64 = sorted.iter().map(|&x| x as f64).sum();
    TimingSummary {
        count: n as u32,
        mean_ms: ns_to_ms(sum / n as f64),
        p50_ms: percentile_ms(&sorted, 50.0),
        p95_ms: percentile_ms(&sorted, 95.0),
        max_ms: ns_to_ms(sorted[n - 1] as f64),
    }
}

/// Linear-interpolated percentile over an ASCENDING-sorted ns slice, returned in ms.
fn percentile_ms(sorted: &[u64], p: f64) -> f64 {
    let n = sorted.len();
    if n == 1 {
        return sorted[0] as f64 / 1_000_000.0;
    }
    let idx = (p / 100.0) * (n as f64 - 1.0);
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    let frac = idx - lo as f64;
    let v = sorted[lo] as f64 + (sorted[hi] as f64 - sorted[lo] as f64) * frac;
    v / 1_000_000.0
}

/// Ceiling on the keyed-mutex wait in [`copy_frame_into_slot`]. We only ever
/// write a slot the renderer already released (via `consume_ack`), so
/// Chromium isn't holding its read lock when we `AcquireSync` — a free slot
/// acquires in microseconds. This value is generous on purpose: it never
/// trips on that happy path (so it can't drop frames or skew the benchmark's
/// throughput numbers) and only fires when a slot is genuinely stuck (e.g.
/// held by Chromium past its ack), turning what would otherwise be a
/// permanent session-thread hang into an observable, recoverable skip.
const ACQUIRE_TIMEOUT_MS: u32 = 1000;
/// `WAIT_TIMEOUT` (winbase.h `0x00000102`), as it surfaces from
/// `IDXGIKeyedMutex::AcquireSync`'s raw return code. Its sign bit is 0, so
/// windows-rs's generated safe wrapper (`HRESULT::ok`, `windows-result` crate,
/// which treats any non-negative code as success) collapses a timeout to
/// `Ok(())` — indistinguishable from actually holding the mutex. We therefore
/// call the vtable function directly in `copy_frame_into_slot` and compare
/// the raw `HRESULT` against this sentinel ourselves instead of trusting the
/// safe wrapper's `Result`.
const DXGI_KEYED_MUTEX_WAIT_TIMEOUT: i32 = 0x0000_0102;
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
/// sink the addon wires to its event channel. Carries only plain data.
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
    /// Same `Arc` the session thread appends to; `take_timings` drains it.
    timing: Arc<Mutex<TimingAccum>>,
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
    /// Shared with the registry so `take_timings` can drain from the Node thread.
    timing: Arc<Mutex<TimingAccum>>,
    /// `Instant` the frame in each slot was announced via `FrameReady`; taken and
    /// turned into a coord-RTT sample when that slot's `ConsumeAck` returns. `None`
    /// when the slot is free or unacked-but-never-emitted. Sized to the pool.
    slot_emit: Vec<Option<Instant>>,
    /// `Instant` each slot's `ConsumeAck` arrived on this thread; taken and turned
    /// into an `ack_to_emit` sample at the next `FrameReady` for that slot. `None`
    /// before a slot has ever been acked (its first fill has no prior ack, so it
    /// yields no sample). Sized to the pool. See `TimingReport::ack_to_emit`.
    slot_ack_at: Vec<Option<Instant>>,
    /// Session-level (not per-slot) last-emit / last-ack instants for the round-2
    /// cadence probes (`inter_emit` / `inter_ack`). NOT consumed by `take` — each
    /// event overwrites the prior, and the delta is the inter-event gap.
    last_emit_at: Option<Instant>,
    last_ack_at: Option<Instant>,
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

    /// Turn a slot's `FrameReady`->`ConsumeAck` gap into a coord-RTT sample, and
    /// stamp the ack instant for the `ack_to_emit` probe (sampled at this slot's
    /// next `FrameReady`). `Option::take` guarantees at most one coord-RTT sample
    /// per emit; an ack with no prior emit (shouldn't happen given the free-flag
    /// protocol) contributes no coord-RTT but still stamps the ack instant.
    fn record_ack(&mut self, slot: usize) {
        let now = Instant::now();
        if let Some(emit_at) = self.slot_emit.get_mut(slot).and_then(Option::take) {
            let rtt_ns = now.duration_since(emit_at).as_nanos() as u64;
            if let Ok(mut t) = self.timing.lock() {
                t.push_coord_rtt(rtt_ns);
            }
        }
        // Ack instant for the ack->next-emit gap probe; the next `pump` emit into
        // this slot takes it and records `now - this`.
        if let Some(entry) = self.slot_ack_at.get_mut(slot) {
            *entry = Some(now);
        }
        // Session-level ack cadence (any slot): gap since the previous ConsumeAck.
        if let Some(prev) = self.last_ack_at.replace(now) {
            let gap_ns = now.duration_since(prev).as_nanos() as u64;
            if let Ok(mut t) = self.timing.lock() {
                t.push_inter_ack(gap_ns);
            }
        }
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
                let free = self.free.iter().filter(|&&f| f).count() as u32;
                if let Ok(mut t) = self.timing.lock() {
                    t.note_eof_return(free, true);
                }
                return;
            }
            // A free slot is required to decode: a deliverable frame must land
            // somewhere, and its GPU surface is only valid until the next
            // `next_frame`. Discarded (pre-anchor) frames don't consume the slot,
            // so one free slot covers the whole post-seek discard + first deliver.
            let Some(slot_idx) = self.free_slot() else {
                // pool full (free count is 0 by definition); wait for a ConsumeAck.
                if let Ok(mut t) = self.timing.lock() {
                    t.note_pool_full_return(0, self.eof);
                }
                return;
            };
            // Lookahead gate: stop once decoded far enough ahead of the anchor.
            // (frontier is behind the anchor during post-seek discard, so this
            // never fires mid-discard.) A free slot is available here (checked
            // above), so a gate hit = the pump idling on the anchor rather than on
            // the pool — count it to attribute the `ack_to_emit` gap (see the probe).
            if self.frontier_pts != i64::MIN
                && self.frontier_pts >= self.anchor.saturating_add(LOOKAHEAD_US)
            {
                if let Ok(mut t) = self.timing.lock() {
                    t.note_lookahead_gated_skip();
                }
                return;
            }

            let decode_start = Instant::now();
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
            match copy {
                Ok(CopyOutcome::AcquireFailed(message)) => {
                    // The slot's keyed mutex is stuck (or a transient acquire
                    // error occurred): no GPU work happened, the slot was
                    // never touched so it stays free, and this decoded frame
                    // is dropped. Report it but don't halt the pump — return
                    // to the session loop so it re-services its mailbox
                    // (including a pending `Close`) instead of retrying in a
                    // tight loop against a slot that may stay stuck.
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_acquire_failed(free, self.eof);
                    }
                    emit(
                        poke,
                        PreviewGpuPoke::Error {
                            stream_id: stream_id.to_string(),
                            message,
                        },
                    );
                    return;
                }
                Err(e) => {
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
                Ok(CopyOutcome::Copied) => {}
            }

            let decode_copy_ns = decode_start.elapsed().as_nanos() as u64;
            self.free[slot_idx] = false;
            self.frontier_pts = decoded.pts_us;
            self.last_delivered_pts = decoded.pts_us;
            // Close the ack->next-emit gap for this slot, if it was previously
            // acked (its first fill has no prior ack -> `take` yields None -> no
            // sample). Measured against the same `now` used to stamp the emit.
            let now = Instant::now();
            let ack_to_emit_ns = self
                .slot_ack_at
                .get_mut(slot_idx)
                .and_then(Option::take)
                .map(|ack_at| now.duration_since(ack_at).as_nanos() as u64);
            // Session-level production cadence (any slot): gap since the previous emit.
            let inter_emit_ns = self
                .last_emit_at
                .replace(now)
                .map(|prev| now.duration_since(prev).as_nanos() as u64);
            // Stamp the slot BEFORE emit so the matching ack can measure the full
            // round-trip; record decode+copy (+ any gaps) for this delivered frame.
            self.slot_emit[slot_idx] = Some(now);
            if let Ok(mut t) = self.timing.lock() {
                t.push_decode_copy(decode_copy_ns);
                if let Some(gap_ns) = ack_to_emit_ns {
                    t.push_ack_to_emit(gap_ns);
                }
                if let Some(gap_ns) = inter_emit_ns {
                    t.push_inter_emit(gap_ns);
                }
            }
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

/// Result of attempting to copy a decoded frame into a pool slot.
enum CopyOutcome {
    /// The mutex was acquired and the frame copied; the caller may mark the
    /// slot busy and emit `FrameReady`.
    Copied,
    /// `AcquireSync` did not grant the mutex (timeout) or returned a genuine
    /// error. No GPU work happened — the slot was never touched, so it stays
    /// free — and this decoded frame is dropped. Carries the message for a
    /// `PreviewGpuPoke::Error`.
    AcquireFailed(String),
}

/// Copy the decoded GPU surface into a pool slot, bracketed by the slot's keyed
/// mutex (our write vs. Chromium's read) and ffmpeg's device-context lock
/// (decode thread vs. this copy). Lifted from the poc's in-place slot overwrite.
///
/// The initial `AcquireSync` uses a finite timeout (`ACQUIRE_TIMEOUT_MS`)
/// rather than `INFINITE`: on the happy path a free slot acquires in
/// microseconds, so the timeout never trips — it exists only so a genuinely
/// stuck slot can never wedge the session thread (and therefore `close`/join)
/// forever. See `ACQUIRE_TIMEOUT_MS` / `DXGI_KEYED_MUTEX_WAIT_TIMEOUT` for why
/// this must call the vtable function directly instead of the safe
/// `IDXGIKeyedMutex::AcquireSync` wrapper.
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
) -> Result<CopyOutcome, String> {
    let src_tex = ID3D11Texture2D::from_raw_borrowed(&decoded.src_texture)
        .ok_or_else(|| "decoded D3D11 texture is null".to_string())?;

    // Call the vtable function directly (bypassing `IDXGIKeyedMutex::AcquireSync`'s
    // safe wrapper) so we see the raw HRESULT: the safe wrapper's `.ok()` treats
    // any non-negative code — including `WAIT_TIMEOUT` — as `Ok(())`, which would
    // make a timeout indistinguishable from actually holding the mutex.
    let acquire_hr: HRESULT = (Interface::vtable(&slot.keyed_mutex).AcquireSync)(
        Interface::as_raw(&slot.keyed_mutex),
        0,
        ACQUIRE_TIMEOUT_MS,
    );
    if acquire_hr.0 == DXGI_KEYED_MUTEX_WAIT_TIMEOUT {
        return Ok(CopyOutcome::AcquireFailed(format!(
            "AcquireSync timeout on slot after {ACQUIRE_TIMEOUT_MS}ms (slot stuck)"
        )));
    }
    if let Err(e) = acquire_hr.ok() {
        return Ok(CopyOutcome::AcquireFailed(format!(
            "AcquireSync(slot) failed: {e}"
        )));
    }

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
    Ok(CopyOutcome::Copied)
}

/// Fire a poke through the shared sink if one is set. The mutex is held across
/// the call so concurrent sessions serialise (the addon's sink is a
/// non-blocking event enqueue, so this can't deadlock or stall).
fn emit(poke: &PokeSink, poke_val: PreviewGpuPoke) {
    let guard = poke.lock().unwrap();
    if let Some(sink) = guard.as_ref() {
        sink(poke_val);
    }
}

/// Open the decoder + build the shared NV12 pool on ffmpeg's device. Runs on the
/// session thread (all COM/ffmpeg objects stay here). Adapted from the poc's
/// `poc_open_video_stream` pool-creation block.
fn init_session(
    path: &str,
    pool_size: u32,
    timing: Arc<Mutex<TimingAccum>>,
) -> Result<SessionState, String> {
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
        let nt_km = (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
            | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32;
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
        // Computed before the struct literal (like `free` above): `pool` is moved
        // into its own field within the literal, so `pool.len()` must be captured
        // here rather than inline at the per-slot fields.
        let slot_emit = vec![None; pool.len()];
        let slot_ack_at = vec![None; pool.len()];

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
            timing,
            slot_emit,
            slot_ack_at,
            last_emit_at: None,
            last_ack_at: None,
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
    timing: Arc<Mutex<TimingAccum>>,
) {
    let mut state = match init_session(&path, pool_size, timing) {
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
        // Round-2 thread time-budget probe: time the recv itself (0 when a message
        // was already queued; ~RECV_TIMEOUT when the thread blocked idle) and tally
        // the wake reason, before dispatching. One uncontended lock/iteration.
        let t_recv = Instant::now();
        let msg = rx.recv_timeout(RECV_TIMEOUT);
        let block_ns = t_recv.elapsed().as_nanos() as u64;
        if let Ok(mut t) = state.timing.lock() {
            t.push_recv_block(block_ns);
            match &msg {
                Ok(SessionMsg::ConsumeAck(_)) => t.note_recv_ack(),
                Ok(SessionMsg::RequestFrameAt(_)) => t.note_recv_req(),
                Err(RecvTimeoutError::Timeout) => t.note_recv_timeout(),
                _ => {}
            }
        }
        match msg {
            Ok(SessionMsg::RequestFrameAt(t)) => {
                state.on_request(t, &poke, &stream_id);
                state.pump(&poke, &stream_id);
            }
            Ok(SessionMsg::ConsumeAck(slot)) => {
                state.record_ack(slot as usize);
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

/// The set of live preview sessions. `Send + Sync`, so the addon can hold it
/// (e.g. behind an `Arc`) and drive it from napi calls.
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

    /// Install the sink every session emits pokes through. Set once by the
    /// addon before any `open`; sessions share the same cell, so a later set
    /// is seen by already-running threads too.
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
        let timing = Arc::new(Mutex::new(TimingAccum::default()));
        let timing_thread = Arc::clone(&timing);

        let join = thread::Builder::new()
            .name(format!("preview-gpu-{sid}"))
            .spawn(move || {
                session_thread(
                    sid,
                    path_owned,
                    pool_size,
                    cmd_rx,
                    init_tx,
                    poke,
                    timing_thread,
                )
            })
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
                        timing,
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

    /// Drain the session's accumulated timing samples into a summary report.
    /// Called once at the end of a bench window (before `close`), from the Node
    /// main thread via the addon.
    pub fn take_timings(&self, stream_id: &str) -> Result<TimingReport, String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        // Bind before returning: the `MutexGuard` from `timing.lock()` borrows
        // through `session` (and so `sessions`); dropping it here (end of this
        // statement) rather than in the tail expression keeps it from outliving
        // the `sessions` guard it's borrowed from.
        let report = session.timing.lock().unwrap().drain();
        Ok(report)
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

#[cfg(test)]
mod timing_tests {
    use super::{TimingAccum, TIMING_SAMPLE_CAP};

    #[test]
    fn summary_percentiles_and_mean_over_known_samples() {
        let mut a = TimingAccum::default();
        for ms in [10u64, 20, 30, 40, 50] {
            a.push_coord_rtt(ms * 1_000_000); // ns
        }
        let r = a.drain();
        assert_eq!(r.coord_rtt.count, 5);
        assert!(
            (r.coord_rtt.mean_ms - 30.0).abs() < 1e-6,
            "mean {}",
            r.coord_rtt.mean_ms
        );
        assert!(
            (r.coord_rtt.p50_ms - 30.0).abs() < 1e-6,
            "p50 {}",
            r.coord_rtt.p50_ms
        );
        // linear interp: idx = 0.95*(5-1) = 3.8 -> 40 + (50-40)*0.8 = 48
        assert!(
            (r.coord_rtt.p95_ms - 48.0).abs() < 1e-6,
            "p95 {}",
            r.coord_rtt.p95_ms
        );
        assert!(
            (r.coord_rtt.max_ms - 50.0).abs() < 1e-6,
            "max {}",
            r.coord_rtt.max_ms
        );
    }

    #[test]
    fn drain_clears_buffers() {
        let mut a = TimingAccum::default();
        a.push_decode_copy(5_000_000);
        a.push_ack_to_emit(7_000_000);
        a.note_lookahead_gated_skip();
        a.push_inter_emit(22_000_000);
        a.push_inter_ack(22_000_000);
        a.push_recv_block(4_000_000);
        a.note_recv_timeout();
        a.note_recv_ack();
        a.note_recv_req();
        a.note_eof_return(2, true);
        a.note_pool_full_return(0, false);
        a.note_acquire_failed(1, false);
        let r = a.drain();
        assert_eq!(r.decode_copy.count, 1);
        assert_eq!(r.ack_to_emit.count, 1);
        assert_eq!(r.lookahead_gated_skips, 1);
        assert_eq!(r.inter_emit.count, 1);
        assert_eq!(r.inter_ack.count, 1);
        assert_eq!(r.recv_block.count, 1);
        assert_eq!(r.recv_timeout_ticks, 1);
        assert_eq!(r.recv_ack_msgs, 1);
        assert_eq!(r.recv_req_msgs, 1);
        assert_eq!(r.eof_returns, 1);
        assert_eq!(r.pool_full_returns, 1);
        assert_eq!(r.acquire_failed, 1);
        // final_* reflect the LAST note (note_acquire_failed(1, false) here).
        assert_eq!(r.final_free_slots, 1);
        assert!(!r.final_eof);
        // Second drain sees the cleared state (buffers + counters reset).
        let r2 = a.drain();
        assert_eq!(r2.decode_copy.count, 0);
        assert_eq!(r2.ack_to_emit.count, 0);
        assert_eq!(r2.lookahead_gated_skips, 0);
        assert_eq!(r2.inter_emit.count, 0);
        assert_eq!(r2.recv_block.count, 0);
        assert_eq!(r2.recv_timeout_ticks, 0);
        assert_eq!(r2.recv_ack_msgs, 0);
        assert_eq!(r2.recv_req_msgs, 0);
        assert_eq!(r2.eof_returns, 0);
        assert_eq!(r2.pool_full_returns, 0);
        assert_eq!(r2.acquire_failed, 0);
        assert_eq!(r2.final_free_slots, 0);
    }

    #[test]
    fn ack_to_emit_summary_and_skip_count() {
        let mut a = TimingAccum::default();
        for ms in [12u64, 24, 36] {
            a.push_ack_to_emit(ms * 1_000_000);
        }
        for _ in 0..5 {
            a.note_lookahead_gated_skip();
        }
        let r = a.drain();
        assert_eq!(r.ack_to_emit.count, 3);
        assert!(
            (r.ack_to_emit.mean_ms - 24.0).abs() < 1e-6,
            "mean {}",
            r.ack_to_emit.mean_ms
        );
        assert!(
            (r.ack_to_emit.p50_ms - 24.0).abs() < 1e-6,
            "p50 {}",
            r.ack_to_emit.p50_ms
        );
        assert_eq!(r.lookahead_gated_skips, 5);
    }

    #[test]
    fn empty_summary_is_zeroed() {
        let mut a = TimingAccum::default();
        let r = a.drain();
        assert_eq!(r.coord_rtt.count, 0);
        assert_eq!(r.coord_rtt.p95_ms, 0.0);
        assert_eq!(r.ack_to_emit.count, 0);
        assert_eq!(r.ack_to_emit.p95_ms, 0.0);
        assert_eq!(r.lookahead_gated_skips, 0);
    }

    #[test]
    fn sample_cap_holds() {
        let mut a = TimingAccum::default();
        for _ in 0..(TIMING_SAMPLE_CAP + 100) {
            a.push_decode_copy(1_000_000);
        }
        assert_eq!(a.drain().decode_copy.count as usize, TIMING_SAMPLE_CAP);
    }
}
