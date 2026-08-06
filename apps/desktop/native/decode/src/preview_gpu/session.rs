//! Per-session decode thread + shared RGBA8 texture pool + registry.
//!
//! Each preview session owns a dedicated OS thread pinned to its `!Send`
//! D3D11 + ffmpeg objects: the thread opens the `VideoStream`, builds a pool of
//! shared RGBA8 textures on ffmpeg's own D3D11 device (the NV12→RGBA convert
//! target), and runs an anchor-driven decode loop. napi commands
//! (`request_frame_at` / `consume_ack` / `close`) post messages to the thread
//! over an mpsc channel; decoded frames are announced back out through a poke
//! sink (`FrameReady` / `Eof` / `Error`).
//!
//! Why a thread per session: the D3D11/ffmpeg COM objects are `!Send`, so each
//! session owns its thread and only plain `Send` data crosses the boundary (see
//! `OpenInfo`).
//!
//! Slot coherence: a slot is overwritten only after its `consume_ack` marked it
//! free. That ack — invoked explicitly by the preload once the snapshot's
//! cross-device read has GPU-completed, *not* the keyed mutex across the async
//! `createImageBitmap` boundary — is the coherence guarantee. With
//! `pool_size >= 2` the producer fills slot B while the renderer still snapshots
//! slot A. The keyed mutex only serialises our GPU write against Chromium's GPU
//! read of the same texture.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::{Interface, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

use super::convert::ConvertPass;
use super::decoder::{StreamFrame, VideoStream};
use crate::recover::{panic_message, LockExt};

/// Cap on retained timing samples per metric. A 30s throughput window at native's
/// ~44fps yields ~1300 samples — far under this; the cap is only a runaway backstop
/// (timing is native-only, so WebCodecs frame rates never reach it). Stop-appending
/// once full (keeps the earliest, steady-state samples).
pub const TIMING_SAMPLE_CAP: usize = 20_000;

/// Per-metric millisecond summary handed across the napi boundary (mapped to a
/// `#[napi(object)]` in `backend.rs`). Percentiles use linear interpolation
/// over ascending samples, matching the TS-side `percentile` convention.
#[derive(Clone, Copy)]
pub struct TimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Everything `TimingAccum::drain` produces for one bench window.
pub struct TimingReport {
    /// Whole JS coordination round-trip: `FrameReady` emit -> main relay -> preload
    /// getVideoFrame/createImageBitmap -> `consume_ack` relay back to this thread.
    pub coord_rtt: TimingSummary,
    /// Decode + GPU-convert cost for one delivered frame (`next_frame` +
    /// `convert_frame_into_slot`) — CPU wall time, submission included.
    pub decode_copy: TimingSummary,
    /// GPU-side cost of the NV12→RGBA conversion pass (staging copy + draw),
    /// measured with timestamp-disjoint queries on the decode device. A
    /// SUBSAMPLE: one bracket in flight at a time, polled non-blocking, so
    /// `count` legitimately trails the delivered-frame count.
    pub convert_gpu: TimingSummary,
    /// Bottleneck probe: gap from a slot's `ConsumeAck` (slot freed on this thread)
    /// to the *next* `FrameReady` emitted into that same slot. This is the one
    /// per-slot-cycle segment `coord_rtt` (emit->ack) does NOT cover; by
    /// telescoping, `coord_rtt.mean + ack_to_emit.mean` ~= the slot's inter-emit
    /// period (`pool_size * frame_interval`), so whichever is larger localises the
    /// throughput ceiling. A large `ack_to_emit` = the pump idles between freeing a
    /// slot and refilling it (Rust-side); a small one = the ceiling is the ack
    /// arrival rate (renderer-side).
    pub ack_to_emit: TimingSummary,
    /// Corroborates `ack_to_emit`'s mechanism: count of `pump` early-returns caused
    /// by the lookahead gate *while a free slot was available*. If large, the pump
    /// idle is the lookahead/anchor gate (anchor not advancing); if ~0, the idle is
    /// pool-full (waiting on the renderer's ack cadence), not the gate. The only
    /// other early-returns with a free slot are `eof` (excluded mid-stream) and
    /// the acquire-failed return (counted apart as `acquire_failed`).
    pub lookahead_gated_skips: u64,
    /// Frames `pump` discarded as already-late (see `LATE_FRAME_DROP_US`) rather
    /// than copying + delivering. This is the drop policy's own meter: 0 means the
    /// pipeline kept up, sustained non-zero means decode fell behind and the drop
    /// is what kept the delivery chain (and the displayed lag) bounded.
    pub late_frame_drops: u64,
    /// Session-thread cadence, measured in the thread's own clock:
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
    /// Stall attribution. Every `pump` early-return increments exactly one of
    /// these; the dominant one over the run names the halt:
    /// `eof_returns` = decoder ended, `pool_full_returns` = no free slot
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
    /// Fencing-token protocol counters. `lease_timeouts` = delivered slots the
    /// owner reclaimed after [`LEASE_TIMEOUT`] with no ack (each is one
    /// possibly-torn frame traded against a wedge — routine non-zero means the
    /// consumer is stalling). `stale_gen_acks` = acks dropped on a generation
    /// mismatch (the ABA the token exists to catch, usually the late ack of a
    /// reclaimed lease arriving after the slot refilled).
    pub lease_timeouts: u64,
    pub stale_gen_acks: u64,
    /// This session's shared-pool VRAM: `width × height × 4 (RGBA8) × slots`.
    /// Static per session — stamped by `take_timings` from the registry's
    /// session record, NOT accumulated (drain leaves it 0).
    pub pool_slot_bytes: u64,
}

/// Session-thread timing accumulator. Nanosecond samples in; drained to ms summaries.
#[derive(Default)]
pub struct TimingAccum {
    coord_rtt_ns: Vec<u64>,
    decode_copy_ns: Vec<u64>,
    convert_gpu_ns: Vec<u64>,
    ack_to_emit_ns: Vec<u64>,
    lookahead_gated_skips: u64,
    late_frame_drops: u64,
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
    lease_timeouts: u64,
    stale_gen_acks: u64,
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
    pub fn push_convert_gpu(&mut self, ns: u64) {
        Self::push_capped(&mut self.convert_gpu_ns, ns);
    }
    pub fn push_ack_to_emit(&mut self, ns: u64) {
        Self::push_capped(&mut self.ack_to_emit_ns, ns);
    }
    /// A `pump` pass found a free slot but the lookahead gate stopped it decoding.
    /// Saturating so the runaway backstop matches the sample cap's intent (a 30s
    /// window can only tick the pump ~7.5k times via `RECV_TIMEOUT`, far under u64).
    pub fn note_lookahead_gated_skip(&mut self, free_slots: u32, eof: bool) {
        self.lookahead_gated_skips = self.lookahead_gated_skips.saturating_add(1);
        // Record the terminal snapshot here TOO. LANDMINE: this return used to be
        // the only pump early-exit that left `final_free_slots` alone, so a
        // gate-wedged session reported a stale `final_free_slots: 0` from some
        // earlier pool-full return — reading as pool starvation when the pool was
        // fine. That cost a diagnosis. Every early-exit must stamp the snapshot.
        self.final_free_slots = free_slots;
        self.final_eof = eof;
    }
    /// A decoded frame was discarded as already-late (`pump`'s late-frame drop)
    /// instead of being copied + delivered. Non-zero means the drop policy is
    /// actively protecting the delivery chain; a run with sustained non-zero here
    /// is a run where decode could not keep up.
    pub fn note_late_frame_drop(&mut self) {
        self.late_frame_drops = self.late_frame_drops.saturating_add(1);
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
    /// Pump-stop attribution. Each records the terminal free-slot count +
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
    /// A delivered slot's lease expired and the owner reclaimed it (gen bump).
    pub fn note_lease_timeout(&mut self) {
        self.lease_timeouts = self.lease_timeouts.saturating_add(1);
    }
    /// A `ConsumeAck` was dropped because its generation didn't match the
    /// slot's current fill.
    pub fn note_stale_gen_ack(&mut self) {
        self.stale_gen_acks = self.stale_gen_acks.saturating_add(1);
    }
    /// Compute the summaries and clear the buffers.
    pub fn drain(&mut self) -> TimingReport {
        let report = TimingReport {
            coord_rtt: summarize(&self.coord_rtt_ns),
            decode_copy: summarize(&self.decode_copy_ns),
            convert_gpu: summarize(&self.convert_gpu_ns),
            ack_to_emit: summarize(&self.ack_to_emit_ns),
            lookahead_gated_skips: self.lookahead_gated_skips,
            late_frame_drops: self.late_frame_drops,
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
            lease_timeouts: self.lease_timeouts,
            stale_gen_acks: self.stale_gen_acks,
            pool_slot_bytes: 0,
        };
        self.coord_rtt_ns.clear();
        self.decode_copy_ns.clear();
        self.convert_gpu_ns.clear();
        self.ack_to_emit_ns.clear();
        self.lookahead_gated_skips = 0;
        self.late_frame_drops = 0;
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
        self.lease_timeouts = 0;
        self.stale_gen_acks = 0;
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

/// Ceiling on the keyed-mutex wait in [`convert_frame_into_slot`]. We only ever
/// write a slot the renderer already released (via `consume_ack`), so
/// Chromium isn't holding its read lock when we `AcquireSync` — a free slot
/// acquires in microseconds. This value is generous on purpose: it never
/// trips on that happy path (so it can't drop frames or skew the benchmark's
/// throughput numbers) and only fires when a slot is genuinely stuck (e.g.
/// held by Chromium past its ack), turning what would otherwise be a
/// permanent session-thread hang into an observable, recoverable skip.
const ACQUIRE_TIMEOUT_MS: u32 = 1000;

/// Owner-side lease ceiling: how long a delivered slot may sit un-acked before
/// [`SessionState::reclaim_expired_leases`] takes it back (gen bump + free +
/// counter). Two orders of magnitude above the p99 ack latency under full load
/// (coord-RTT tens of ms) and 3× the AcquireSync ceiling, so it can only fire
/// on a genuinely wedged/vanished consumer — an occluded renderer whose
/// rAF-paced ack stalled, a dead port, a dropped IPC message. Deliberately NOT
/// tighter: a reclaim of a slot Chromium is still reading trades one torn
/// frame for the unwedge, and that trade should stay rare.
const LEASE_TIMEOUT: Duration = Duration::from_secs(3);
/// `WAIT_TIMEOUT` (winbase.h `0x00000102`), as it surfaces from
/// `IDXGIKeyedMutex::AcquireSync`'s raw return code. Its sign bit is 0, so
/// windows-rs's generated safe wrapper (`HRESULT::ok`, `windows-result` crate,
/// which treats any non-negative code as success) collapses a timeout to
/// `Ok(())` — indistinguishable from actually holding the mutex. We therefore
/// call the vtable function directly in `convert_frame_into_slot` and compare
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
///
/// Also the SEED for the measured keyframe interval (`key_interval_us`) until two
/// keyframes have been seen.
const SEEK_FORWARD_THRESHOLD_US: i64 = 1_000_000;

/// Floor/ceiling on the measured-keyframe-interval resync threshold
/// (`resync_threshold_us`). The floor keeps a short-GOP source (a 0.5 s-GOP quick
/// proxy) from re-seeking on every few frames of drift — a seek still costs a
/// decoder flush plus the re-approach. The ceiling keeps a pathological
/// keyframe-once-per-minute source from disabling resync entirely.
const MIN_RESYNC_US: i64 = 250_000;
const MAX_RESYNC_US: i64 = 3_000_000;

/// How far BEHIND the anchor a decoded frame's presentation interval must end
/// before the pump discards it instead of delivering it (`pump`'s late-frame
/// drop — ffplay's `framedrop`, mpv's `--framedrop=vo`).
///
/// Not zero: the margin is the A/V lag we are willing to SHOW rather than drop,
/// so a decoder that is only slightly behind still presents its most recent
/// frames instead of going blank. 100 ms matches ffplay's `AV_SYNC_THRESHOLD_MAX`
/// and doubles as the renderer ring's own `CLAMP_TO_FIRST_GAP_US`, so a frame
/// this pump keeps is a frame the ring can still serve.
const LATE_FRAME_DROP_US: i64 = 100_000;

/// How far the anchor must fall BEHIND the decoded frontier before that counts as
/// a backward divergence worth a seek, independent of how the anchor got there.
/// Must exceed `LOOKAHEAD_US`, or ordinary paused pre-buffering (frontier legally
/// leads the anchor by up to one lookahead) would read as a backward jump and
/// re-seek forever.
const BACKWARD_DIVERGENCE_US: i64 = 2 * LOOKAHEAD_US;

/// What a forward gap must exceed before seeking beats decoding through it.
///
/// A seek is not free: it flushes the decoder and must re-decode from the key
/// packet at/before the target, so it costs up to one keyframe interval of decode.
/// Decoding forward costs the gap. So seek when `gap > keyframe interval` —
/// measured, not guessed, because the right answer differs by an order of
/// magnitude between a 0.5 s-GOP proxy and a 3 s-GOP 4K original.
///
/// This prices the SEEK arm only. Bounding the A/V lag is [`is_late_frame`]'s job;
/// dropping is what makes tolerating a long GOP affordable in the first place.
fn resync_threshold_us(key_interval_us: i64) -> i64 {
    key_interval_us.clamp(MIN_RESYNC_US, MAX_RESYNC_US)
}

/// Pure seek decision for one `request_frame_at`. `anchor` is the PREVIOUS anchor,
/// `frontier_pts` the furthest pts decoded (`i64::MIN` = nothing since open/seek).
fn needs_seek(t: i64, anchor: i64, frontier_pts: i64, key_interval_us: i64) -> bool {
    if frontier_pts == i64::MIN {
        // Nothing decoded yet: seek only if the very first target is far from the
        // container start; a target near 0 is cheaper to reach by forward decode.
        return t > SEEK_FORWARD_THRESHOLD_US;
    }
    // Playhead moved backward — forward decode can't rewind.
    //
    // The `frontier` arm is a STRUCTURAL backstop, not a restatement of the
    // `anchor` one: it keys on what we actually DECODED rather than on where the
    // anchor last was. Without it, any path that lands the anchor behind a
    // far-ahead frontier WITHOUT passing through a successful seek (a seek that
    // returned Err; a request stream resuming after the anchor was already reset)
    // leaves `pump`'s lookahead gate permanently satisfied — `frontier >= anchor +
    // LOOKAHEAD_US` forever — and the session never decodes another frame for the
    // rest of its life. Live-observed: 178 requests, 0 emits, 329/329 pump
    // attempts exiting via the gate.
    if t < anchor || t.saturating_add(BACKWARD_DIVERGENCE_US) < frontier_pts {
        return true;
    }
    // Forward move: seek only on a jump the decoder can't cheaply cover.
    t > frontier_pts.saturating_add(resync_threshold_us(key_interval_us))
}

/// Whether a decoded frame is too late to be worth DELIVERING: its presentation
/// interval ended more than [`LATE_FRAME_DROP_US`] before the playhead, so nothing
/// downstream will ever show it (the renderer's `FrameRing` binds the newest frame
/// at or before the anchor, and this is not it). ffplay's `framedrop`.
///
/// `.max(1)` on the duration guards a 0/unknown value so the frame COVERING the
/// anchor is never mistaken for a past one.
fn is_late_frame(pts_us: i64, dur_us: i64, anchor: i64) -> bool {
    pts_us
        .saturating_add(dur_us.max(1))
        .saturating_add(LATE_FRAME_DROP_US)
        <= anchor
}

/// Fold an observed keyframe pts into the interval average. EWMA 3:1 toward
/// history — smooths an open-GOP source with irregular key spacing without
/// pinning to a first outlier. A non-advancing or first-ever key is a no-op.
fn fold_key_interval(key_interval_us: i64, last_key_pts: i64, pts_us: i64) -> i64 {
    if last_key_pts == i64::MIN || pts_us <= last_key_pts {
        return key_interval_us;
    }
    (key_interval_us * 3 + (pts_us - last_key_pts)) / 4
}

/// Whether a `ConsumeAck` for `slot` may free it: only a currently-busy slot
/// whose ack echoes the CURRENT fill generation qualifies. Exactly-once acks
/// are otherwise enforced only by JS bookkeeping spread across three processes
/// — a duplicate, stale, or out-of-range ack reaching here would free a slot
/// the renderer may still be reading, letting the pump overwrite it mid-read:
/// the exact frame reorder/tear the order gate exists to catch.
///
/// The generation check is the ABA immunity the busy flag alone cannot give:
/// after a lease timeout reclaims + refills a slot, the ORIGINAL occupant's
/// late ack arrives against a busy slot again — busy-only validation would
/// free the new frame mid-read. `gen` names WHICH occupancy the ack releases.
fn ack_frees_slot(free: &[bool], slot_gen: &[u32], slot: usize, gen: u32) -> bool {
    free.get(slot) == Some(&false) && slot_gen.get(slot) == Some(&gen)
}

/// recv timeout so the pump makes progress (freed slot -> decode) between
/// messages without busy-spinning.
const RECV_TIMEOUT: Duration = Duration::from_millis(4);

/// Announced out of the session thread. `Send` so it can travel to whatever
/// sink the addon wires to its event channel. Carries only plain data.
pub enum PreviewGpuPoke {
    /// A decoded frame was copied into `slot`; the renderer may import/snapshot
    /// it, then `consume_ack(slot, gen)` to release it back to the pool.
    FrameReady {
        stream_id: String,
        slot: u32,
        /// The slot's fill generation — the fencing token. Bumped on every
        /// fill; the matching ack must echo it — see `ack_frees_slot`.
        gen: u32,
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
    /// The renderer released this slot; it may be reused. Carries the fill
    /// generation the renderer received with the frame — mismatch = stale ack,
    /// dropped whole.
    ConsumeAck(u32, u32),
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
    width: u32,
    height: u32,
    /// Slot count actually allocated (drives the `pool_slot_bytes` stamp).
    pool_size: u32,
    /// Same `Arc` the session thread appends to; `take_timings` drains it.
    timing: Arc<Mutex<TimingAccum>>,
}

/// One reusable shared RGBA8 texture in the pool. Created on ffmpeg's device and
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
    /// textures were created on it. The per-frame convert goes through `context`.
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    pool: Vec<PoolSlot>,
    /// Session-owned NV12→RGBA conversion pass (shader compiled once at open
    /// with the stream's matrix/range constants baked in).
    convert: ConvertPass,
    /// Per-slot free flag, owned solely by this thread (acks arrive as messages,
    /// so no cross-thread access -> a plain `Vec<bool>`, no atomics needed).
    free: Vec<bool>,
    /// Per-slot fill generation — the fencing token. Bumped on every fill
    /// (and on a lease-timeout reclaim, which is what invalidates the late
    /// ack); emitted with `FrameReady` and echoed by `ConsumeAck`. Wrapping
    /// u32: ABA across 2^32 fills of one slot is not a real risk.
    slot_gen: Vec<u32>,
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
    /// pts of the last keyframe the pump decoded; `i64::MIN` until one is seen.
    /// Paired with `key_interval_us` to price a resync seek.
    last_key_pts: i64,
    /// Measured interval between consecutive keyframes (µs), seeded to
    /// `SEEK_FORWARD_THRESHOLD_US`, then an EWMA over observed gaps — see
    /// `resync_threshold_us`.
    key_interval_us: i64,
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
    /// Session-level (not per-slot) last-emit / last-ack instants for the
    /// cadence probes (`inter_emit` / `inter_ack`). NOT consumed by `take` — each
    /// event overwrites the prior, and the delta is the inter-event gap.
    last_emit_at: Option<Instant>,
    last_ack_at: Option<Instant>,
}

impl Drop for SessionState {
    fn drop(&mut self) {
        // Close each slot's NT handle before the textures (and device/decoder)
        // release.
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

    /// Handle a `request_frame_at`: set the anchor and, if `needs_seek` says the
    /// target left the reachable forward window, seek. Decision logic is the pure
    /// [`needs_seek`] (unit-gated); this method owns only the state transition.
    fn on_request(&mut self, t: i64, poke: &PokeSink, stream_id: &str) {
        let needs_seek = needs_seek(t, self.anchor, self.frontier_pts, self.key_interval_us);
        self.anchor = t;
        if needs_seek {
            match self.stream.seek(t) {
                Ok(()) => {
                    self.post_seek = true;
                    self.eof = false;
                    self.frontier_pts = i64::MIN;
                    self.last_delivered_pts = i64::MIN;
                    // The next keyframe after a seek is the landing key, not the
                    // natural successor of the one before the seek, so the gap
                    // across it is not an interval. Keep the learned average.
                    self.last_key_pts = i64::MIN;
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
        // Lease sweep first, so a slot whose consumer vanished re-enters the
        // free pool on the same tick that would otherwise report pool-full.
        self.reclaim_expired_leases();
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
                let free = self.free.iter().filter(|&&f| f).count() as u32;
                if let Ok(mut t) = self.timing.lock() {
                    t.note_lookahead_gated_skip(free, self.eof);
                }
                return;
            }

            let decode_start = Instant::now();
            let decoded = match self.stream.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    self.eof = true;
                    // Every pump exit must stamp the terminal snapshot, or a
                    // `take_timings` in this window reads the PREVIOUS exit's
                    // final_* (see `note_lookahead_gated_skip`'s landmine).
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_eof_return(free, true);
                    }
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
                    // later seek reopens decoding. The halt IS the eof state.
                    self.eof = true;
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_eof_return(free, true);
                    }
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

            // Keyframe cadence, for `resync_threshold_us`. Folded before any
            // discard below, because a discarded frame still tells us the GOP
            // structure — and the discard paths are exactly when we need it.
            if decoded.key {
                self.key_interval_us =
                    fold_key_interval(self.key_interval_us, self.last_key_pts, decoded.pts_us);
                self.last_key_pts = decoded.pts_us;
            }

            // Post-seek: drop frames before the anchor (the seek landed on a
            // keyframe at/<= the target) until the first one at/after it.
            if self.post_seek {
                if decoded.pts_us < self.anchor {
                    self.frontier_pts = decoded.pts_us;
                    continue; // slot stays free
                }
                self.post_seek = false;
            }

            // Already-late frame: discard so the delivery chain isn't spent on a
            // frame nobody sees; the slot stays free. Why the margin isn't zero:
            // see `LATE_FRAME_DROP_US`.
            if is_late_frame(decoded.pts_us, decoded.dur_us, self.anchor) {
                self.frontier_pts = decoded.pts_us;
                if let Ok(mut t) = self.timing.lock() {
                    t.note_late_frame_drop();
                }
                continue; // slot stays free
            }

            let copy = unsafe {
                convert_frame_into_slot(
                    &self.context,
                    &mut self.convert,
                    &self.pool[slot_idx],
                    slot_idx,
                    &self.stream,
                    &decoded,
                    &self.timing,
                )
            };
            match copy {
                Ok(CopyOutcome::AcquireFailed(message)) => {
                    // Report it but don't halt the pump — return to the session
                    // loop so it re-services its mailbox (including a pending
                    // `Close`) instead of retrying in a tight loop against a
                    // slot that may stay stuck.
                    //
                    // The frame WAS consumed from the stream whether or not
                    // the copy landed: the frontier is the decoder's position,
                    // not the delivery's, or the lookahead gate and
                    // `needs_seek` drift off the real position.
                    self.frontier_pts = decoded.pts_us;
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
                    self.frontier_pts = decoded.pts_us;
                    let free = self.free.iter().filter(|&&f| f).count() as u32;
                    if let Ok(mut t) = self.timing.lock() {
                        t.note_eof_return(free, true);
                    }
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
            // The fill IS the generation boundary: from here this occupancy is
            // named by the new token, and only an ack echoing it frees the slot.
            self.slot_gen[slot_idx] = self.slot_gen[slot_idx].wrapping_add(1);
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
                    gen: self.slot_gen[slot_idx],
                    pts_us: decoded.pts_us,
                    dur_us: decoded.dur_us,
                },
            );
        }
    }

    /// Owner-side lease timeout: reclaim delivered slots whose ack never came
    /// back within [`LEASE_TIMEOUT`]. The trade is decided (drainFenceAcks
    /// precedent): one possibly-torn frame < a permanently wedged session —
    /// `pool_size` stranded slots stop production for good, and only the OWNER
    /// can break that. Bumping the generation is what makes the reclaim safe
    /// to observe: the original occupant's late ack now fails the gen check
    /// instead of freeing whatever the slot holds by then. The keyed mutex
    /// still serialises any actual GPU access if Chromium is genuinely
    /// mid-read (worst case: the next fill's AcquireSync waits/times out).
    ///
    /// Runs at the top of every `pump` (each message + each 4ms idle tick), so
    /// an expiry is noticed within one tick of `LEASE_TIMEOUT`.
    fn reclaim_expired_leases(&mut self) {
        let now = Instant::now();
        for slot in 0..self.pool.len() {
            if self.free[slot] {
                continue;
            }
            let Some(emit_at) = self.slot_emit[slot] else {
                continue; // busy-but-never-emitted: not a lease (mid-fill)
            };
            if now.duration_since(emit_at) < LEASE_TIMEOUT {
                continue;
            }
            // Take the emit stamp so the (never-arriving) coord-RTT sample is
            // cancelled with the lease rather than paired with a future ack —
            // and the stale ack stamp, so the next fill's ack_to_emit doesn't
            // pair against an ack from a previous occupancy.
            self.slot_emit[slot] = None;
            self.slot_ack_at[slot] = None;
            self.slot_gen[slot] = self.slot_gen[slot].wrapping_add(1);
            self.free[slot] = true;
            if let Ok(mut t) = self.timing.lock() {
                t.note_lease_timeout();
            }
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

/// Releases a slot's keyed mutex (key 0) on scope exit. One is constructed only
/// after `AcquireSync` has succeeded, so `ReleaseSync` MUST run on every path out
/// of the copy region — normal return, an early `?`, or a panic unwinding through
/// it. Without this, the session loop's `catch_unwind` would catch a
/// mid-copy panic and drop the pool with a slot's mutex still held, wedging
/// Chromium's next read of that shared surface. [`release`](Self::release) runs it
/// explicitly so the happy path can still surface a `ReleaseSync` error; `Drop` is
/// the unwind/early-return backstop, guarded against a double release.
struct KeyedMutexRelease<'a> {
    keyed_mutex: &'a IDXGIKeyedMutex,
    released: bool,
}

impl KeyedMutexRelease<'_> {
    fn release(&mut self) -> Result<(), String> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        // SAFETY: constructed only after a successful `AcquireSync(0)` on this
        // thread; the `&IDXGIKeyedMutex` borrow keeps the COM object alive here.
        unsafe { self.keyed_mutex.ReleaseSync(0) }
            .map_err(|e| format!("ReleaseSync(slot) failed: {e}"))
    }
}

impl Drop for KeyedMutexRelease<'_> {
    fn drop(&mut self) {
        if !self.released {
            // Unwinding (or a return that skipped `release`): best-effort release so
            // the slot's mutex is never left held. Any error is moot while unwinding.
            // SAFETY: same contract as `release` — held mutex, live COM object.
            let _ = unsafe { self.keyed_mutex.ReleaseSync(0) };
        }
    }
}

/// Convert the decoded NV12 surface into a pool slot's RGBA8 texture, bracketed
/// by the slot's keyed mutex (our GPU write vs. Chromium's read) and ffmpeg's
/// device-context lock (decode thread vs. ALL of our context use — staging copy,
/// draw, flush and the timing-query poll).
///
/// Acquire uses the finite `ACQUIRE_TIMEOUT_MS` via the raw vtable — see that
/// constant and `DXGI_KEYED_MUTEX_WAIT_TIMEOUT`.
///
/// # Safety
/// `decoded.src_texture` must still be valid (no `next_frame` since it was
/// produced), and `context`/`stream`/`convert` must be the ones the surface
/// belongs to.
unsafe fn convert_frame_into_slot(
    context: &ID3D11DeviceContext,
    convert: &mut ConvertPass,
    slot: &PoolSlot,
    slot_idx: usize,
    stream: &VideoStream,
    decoded: &StreamFrame,
    timing: &Arc<Mutex<TimingAccum>>,
) -> Result<CopyOutcome, String> {
    let src_tex = ID3D11Texture2D::from_raw_borrowed(&decoded.src_texture)
        .ok_or_else(|| "decoded D3D11 texture is null".to_string())?;

    // Raw vtable call — see `DXGI_KEYED_MUTEX_WAIT_TIMEOUT`.
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

    // Mutex held from here — see `KeyedMutexRelease`.
    let mut release = KeyedMutexRelease {
        keyed_mutex: &slot.keyed_mutex,
        released: false,
    };

    if let Some(lock) = stream.lock {
        lock(stream.lock_ctx);
    }
    // Previous frame's GPU-time bracket, polled non-blocking while we already
    // hold the context lock (GetData is context use too).
    if let Some(gpu_ns) = convert.poll_gpu_time(context) {
        if let Ok(mut t) = timing.lock() {
            t.push_convert_gpu(gpu_ns);
        }
    }
    let converted = convert.convert_into_slot(context, src_tex, decoded.src_index, slot_idx);
    context.Flush();
    if let Some(unlock) = stream.unlock {
        unlock(stream.lock_ctx);
    }
    // Propagate a convert failure only after the lock was paired; the keyed
    // mutex is still covered by the `Drop` backstop on this early return.
    converted?;
    // Explicit release so a `ReleaseSync` failure surfaces here (the `Drop`
    // backstop only fires on an unwind / skipped-`release` return).
    release.release()?;
    Ok(CopyOutcome::Copied)
}


/// Fire a poke through the shared sink if one is set. The mutex is held across
/// the call so concurrent sessions serialise (the addon's sink is a
/// non-blocking event enqueue, so this can't deadlock or stall).
fn emit(poke: &PokeSink, poke_val: PreviewGpuPoke) {
    let guard = poke.lock_recover();
    if let Some(sink) = guard.as_ref() {
        sink(poke_val);
    }
}

/// Open the decoder + build the shared RGBA8 pool on ffmpeg's device, plus the
/// session's NV12→RGBA conversion pass. Runs on the session thread (all
/// COM/ffmpeg objects stay here).
///
/// `matrix`/`full_range` are the stream's renderer-derived color tags: they
/// select the conversion constants baked into this session's shader, so the
/// shared texture is already working-space RGBA and the import side tags it
/// sRGB-passthrough unconditionally.
fn init_session(
    path: &str,
    pool_size: u32,
    matrix: &str,
    full_range: bool,
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
        // are set together. Shared textures reject initial data; fill via the
        // conversion pass. RENDER_TARGET: each slot is the conversion's RTV.
        let nt_km = (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
            | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
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

        let slot_textures: Vec<ID3D11Texture2D> =
            pool.iter().map(|s| s.texture.clone()).collect();
        let convert = ConvertPass::new(&device, width, height, matrix, full_range, &slot_textures)?;

        let free = vec![true; pool.len()];
        // Computed before the struct literal (like `free` above): `pool` is moved
        // into its own field within the literal, so `pool.len()` must be captured
        // here rather than inline at the per-slot fields.
        let slot_gen = vec![0u32; pool.len()];
        let slot_emit = vec![None; pool.len()];
        let slot_ack_at = vec![None; pool.len()];

        Ok(SessionState {
            stream,
            _device: device,
            context,
            pool,
            convert,
            free,
            slot_gen,
            width,
            height,
            anchor: i64::MIN,
            frontier_pts: i64::MIN,
            last_delivered_pts: i64::MIN,
            post_seek: false,
            last_key_pts: i64::MIN,
            key_interval_us: SEEK_FORWARD_THRESHOLD_US,
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
    matrix: String,
    full_range: bool,
    rx: Receiver<SessionMsg>,
    init_tx: Sender<Result<OpenInfo, String>>,
    poke: PokeSink,
    timing: Arc<Mutex<TimingAccum>>,
) {
    let mut state = match init_session(&path, pool_size, &matrix, full_range, timing) {
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
        // Thread time-budget probe: time the recv itself (0 when a message
        // was already queued; ~RECV_TIMEOUT when the thread blocked idle) and tally
        // the wake reason, before dispatching. One uncontended lock/iteration.
        let t_recv = Instant::now();
        let msg = rx.recv_timeout(RECV_TIMEOUT);
        let block_ns = t_recv.elapsed().as_nanos() as u64;
        if let Ok(mut t) = state.timing.lock() {
            t.push_recv_block(block_ns);
            match &msg {
                Ok(SessionMsg::ConsumeAck(..)) => t.note_recv_ack(),
                Ok(SessionMsg::RequestFrameAt(_)) => t.note_recv_req(),
                Err(RecvTimeoutError::Timeout) => t.note_recv_timeout(),
                _ => {}
            }
        }
        // A panic on the ffmpeg/GPU decode path (inside `on_request`/`pump`) must
        // not silently kill this thread — the renderer would wait forever on frames
        // that never arrive — nor cascade through the shared poke lock. Catch it,
        // surface it as a normal `Error` poke (so JS tears the session down), then
        // stop: after an unwind the stream's libav state (and any half-done GPU
        // copy) is suspect, so we never touch `state` again — which is what makes
        // the `AssertUnwindSafe` capture of `&mut state` sound here. Any slot caught
        // mid-copy already had its keyed mutex released by `convert_frame_into_slot`'s
        // `KeyedMutexRelease` guard, so the pool isn't left wedged.
        let flow = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match msg {
            Ok(SessionMsg::RequestFrameAt(t)) => {
                state.on_request(t, &poke, &stream_id);
                state.pump(&poke, &stream_id);
                ControlFlow::Continue(())
            }
            Ok(SessionMsg::ConsumeAck(slot, gen)) => {
                // A duplicate/stale/out-of-range/wrong-generation ack is
                // dropped whole — no free, no coord-RTT record — see
                // `ack_frees_slot`. The pump still runs: the mailbox deserves
                // service either way. Gen mismatches are counted apart from
                // silence: routine stale acks mean the consumer is answering
                // leases the owner already reclaimed (a latency finding).
                if ack_frees_slot(&state.free, &state.slot_gen, slot as usize, gen) {
                    state.record_ack(slot as usize);
                    state.free[slot as usize] = true;
                } else if state.free.get(slot as usize) == Some(&false) {
                    if let Ok(mut t) = state.timing.lock() {
                        t.note_stale_gen_ack();
                    }
                }
                state.pump(&poke, &stream_id);
                ControlFlow::Continue(())
            }
            Ok(SessionMsg::Close) => ControlFlow::Break(()),
            Err(RecvTimeoutError::Timeout) => {
                state.pump(&poke, &stream_id);
                ControlFlow::Continue(())
            }
            Err(RecvTimeoutError::Disconnected) => ControlFlow::Break(()),
        }));
        match flow {
            Ok(ControlFlow::Continue(())) => {}
            Ok(ControlFlow::Break(())) => break,
            Err(payload) => {
                emit(
                    &poke,
                    PreviewGpuPoke::Error {
                        stream_id: stream_id.clone(),
                        message: format!(
                            "preview-gpu decode panicked: {}",
                            panic_message(&*payload)
                        ),
                    },
                );
                break;
            }
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
        *self.poke.lock_recover() = Some(sink);
    }

    /// Open `path` for GPU preview: spawn its decode thread, build the pool +
    /// conversion pass, and hand back the slot NT handles + dimensions once the
    /// thread reports ready. `matrix`/`full_range` are the stream's
    /// renderer-derived color tags (they pick the conversion constants — see
    /// `convert::coef_for_matrix`).
    pub fn open(
        &self,
        stream_id: &str,
        path: &str,
        pool_size: u32,
        matrix: &str,
        full_range: bool,
    ) -> Result<OpenInfo, String> {
        let mut sessions = self.sessions.lock_recover();
        if sessions.contains_key(stream_id) {
            return Err(format!("preview-gpu session '{stream_id}' is already open"));
        }

        let (init_tx, init_rx) = mpsc::channel::<Result<OpenInfo, String>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<SessionMsg>();
        let poke = Arc::clone(&self.poke);
        let sid = stream_id.to_string();
        let path_owned = path.to_string();
        let matrix_owned = matrix.to_string();
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
                    matrix_owned,
                    full_range,
                    cmd_rx,
                    init_tx,
                    poke,
                    timing_thread,
                )
            })
            .map_err(|e| format!("spawn preview-gpu session thread failed: {e}"))?;

        // Block until the thread reports open success/failure.
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
                        pool_size: info.slot_handles.len() as u32,
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
        let sessions = self.sessions.lock_recover();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        session
            .tx
            .send(SessionMsg::RequestFrameAt(target_us))
            .map_err(|_| format!("preview-gpu session '{stream_id}' thread is gone"))
    }

    /// Mark a slot free again (the renderer released its cross-process refs).
    /// `gen` must echo the `FrameReady` that delivered the slot, or the session
    /// thread drops the ack as stale (fencing token).
    pub fn consume_ack(&self, stream_id: &str, slot: u32, gen: u32) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        session
            .tx
            .send(SessionMsg::ConsumeAck(slot, gen))
            .map_err(|_| format!("preview-gpu session '{stream_id}' thread is gone"))
    }

    /// Drain the session's accumulated timing samples into a summary report.
    /// Called once at the end of a bench window (before `close`), from the Node
    /// main thread via the addon.
    pub fn take_timings(&self, stream_id: &str) -> Result<TimingReport, String> {
        let sessions = self.sessions.lock_recover();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        // Bind first: the timing guard borrows through `sessions`, so it must
        // drop before the return.
        let mut report = session.timing.lock_recover().drain();
        report.pool_slot_bytes =
            session.width as u64 * session.height as u64 * 4 * session.pool_size as u64;
        Ok(report)
    }

    /// Signal the session thread to tear down, then join it. The thread closes
    /// each slot's NT handle and drops the decoder on the way out.
    pub fn close(&self, stream_id: &str) -> Result<(), String> {
        // Remove from the map (releasing the sessions lock) *before* joining, so
        // a slow teardown doesn't block registry ops on other sessions.
        let mut session = {
            let mut sessions = self.sessions.lock_recover();
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
        a.note_lookahead_gated_skip(2, false);
        a.note_late_frame_drop();
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
        assert_eq!(r.late_frame_drops, 1);
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
        assert_eq!(r2.late_frame_drops, 0);
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
            a.note_lookahead_gated_skip(1, false);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_wait::wait_for;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // --- Playback-load policy: the pure decisions `pump`/`on_request` delegate to.
    // These are the whole behavioural contract of the late-frame drop + adaptive
    // resync, so they are gated here rather than only through a live GPU session
    // (which needs D3D11 + a real file and can't assert a counterfactual).

    /// One frame interval at 29.97 fps — the measured stress case.
    const F30: i64 = 33_367;

    #[test]
    fn late_frame_drop_keeps_the_covering_frame_and_the_tolerated_lag() {
        // The frame COVERING the anchor is never late, however long its duration.
        assert!(!is_late_frame(1_000_000, F30, 1_000_000));
        assert!(!is_late_frame(1_000_000, F30, 1_000_000 + F30 - 1));
        // A zero/unknown duration must not turn the covering frame into a past one
        // (the `.max(1)` guard) — pts == anchor is still current.
        assert!(!is_late_frame(1_000_000, 0, 1_000_000));
        // Frames inside the A/V tolerance still get delivered: showing a slightly
        // stale frame beats showing nothing, which is why the margin isn't zero.
        assert!(!is_late_frame(1_000_000, F30, 1_000_000 + LATE_FRAME_DROP_US));
        // Past the tolerance, drop: nothing downstream would ever bind it.
        assert!(is_late_frame(
            1_000_000,
            F30,
            1_000_000 + F30 + LATE_FRAME_DROP_US
        ));
        // A deep backlog (the sustained-shortfall case) drops wholesale.
        assert!(is_late_frame(1_000_000, F30, 5_000_000));
    }

    #[test]
    fn late_frame_drop_never_fires_while_pre_buffering_ahead() {
        // Paused / healthy playback decodes AHEAD of the anchor. Every such frame
        // must be delivered — a false positive here would blank the preview.
        for ahead in [1, F30, LOOKAHEAD_US, 10 * LOOKAHEAD_US] {
            assert!(
                !is_late_frame(1_000_000 + ahead, F30, 1_000_000),
                "frame {ahead}us ahead of the anchor must not be dropped"
            );
        }
    }

    #[test]
    fn resync_threshold_tracks_the_measured_keyframe_interval_within_clamps() {
        // A short-GOP quick proxy resyncs promptly...
        assert_eq!(resync_threshold_us(500_000), 500_000);
        // ...but never so promptly that it thrashes on a few frames of drift.
        assert_eq!(resync_threshold_us(F30), MIN_RESYNC_US);
        // A long-GOP 4K original (3 s GOP, measured) tolerates more drift, because
        // a seek there costs re-decoding up to a whole GOP.
        assert_eq!(resync_threshold_us(3_000_000), 3_000_000);
        // A pathological keyframe-once-a-minute source can't disable resync.
        assert_eq!(resync_threshold_us(60_000_000), MAX_RESYNC_US);
    }

    #[test]
    fn key_interval_folds_gaps_and_ignores_non_advancing_keys() {
        // First key ever: nothing to measure, seed survives.
        assert_eq!(
            fold_key_interval(SEEK_FORWARD_THRESHOLD_US, i64::MIN, 5_000_000),
            SEEK_FORWARD_THRESHOLD_US
        );
        // A repeated / out-of-order key pts is not an interval.
        assert_eq!(fold_key_interval(1_000_000, 5_000_000, 5_000_000), 1_000_000);
        assert_eq!(fold_key_interval(1_000_000, 5_000_000, 4_000_000), 1_000_000);
        // EWMA converges toward a real 3 s GOP from the 1 s seed rather than jumping.
        let mut k = SEEK_FORWARD_THRESHOLD_US;
        let mut last = 0;
        for i in 1..=12 {
            let pts = i * 3_000_000;
            k = fold_key_interval(k, last, pts);
            last = pts;
        }
        assert!(
            (2_900_000..=3_000_000).contains(&k),
            "expected convergence toward the 3s GOP, got {k}"
        );
    }

    #[test]
    fn ack_frees_slot_accepts_only_a_busy_slot() {
        let free = [true, false, true];
        let gen = [7u32, 7, 7];
        // Busy slot + matching generation: the renderer released it, the ack
        // frees it.
        assert!(ack_frees_slot(&free, &gen, 1, 7));
        // Busy slot, WRONG generation (the ABA case: a late ack from a
        // previous occupancy after a lease-timeout reclaim + refill): dropped,
        // or it would free the CURRENT frame mid-read.
        assert!(!ack_frees_slot(&free, &gen, 1, 6));
        assert!(!ack_frees_slot(&free, &gen, 1, 8));
        // Already-free slot (duplicate or stale ack): freeing again would let
        // the pump overwrite a slot the renderer may still be reading.
        assert!(!ack_frees_slot(&free, &gen, 0, 7));
        assert!(!ack_frees_slot(&free, &gen, 2, 7));
        // Out-of-range slot: never frees anything.
        assert!(!ack_frees_slot(&free, &gen, 3, 7));
        assert!(!ack_frees_slot(&free, &gen, usize::MAX, 7));
    }

    #[test]
    fn needs_seek_covers_cold_start_backward_and_forward_jumps() {
        const K: i64 = 3_000_000; // long-GOP source
        // Cold start: a near-zero target is cheaper to reach by forward decode.
        assert!(!needs_seek(0, i64::MIN, i64::MIN, K));
        assert!(needs_seek(90_000_000, i64::MIN, i64::MIN, K));
        // Backward move relative to the previous anchor.
        assert!(needs_seek(1_000_000, 8_000_000, 8_500_000, K));
        // Ordinary forward playback within the resync window: no seek. This is the
        // arm the late-frame drop relies on — catch up by dropping, not by seeking.
        assert!(!needs_seek(8_100_000, 8_000_000, 8_500_000, K));
        assert!(!needs_seek(10_000_000, 8_000_000, 8_500_000, K));
        // A forward jump past what a GOP re-decode would cost: seek.
        assert!(needs_seek(20_000_000, 8_000_000, 8_500_000, K));
        // Same gap on a SHORT-GOP source seeks much sooner (the adaptive part).
        assert!(needs_seek(9_000_000, 8_000_000, 8_500_000, 400_000));
        assert!(!needs_seek(9_000_000, 8_000_000, 8_500_000, K));
    }

    #[test]
    fn needs_seek_backstops_an_anchor_stranded_behind_the_frontier() {
        // THE WEDGE — see `needs_seek`'s frontier arm.
        // Re-requesting the SAME anchor must still be recognised as divergence.
        assert!(needs_seek(0, 0, 12_500_000, 3_000_000));
        // ...and must not depend on the anchor having moved backward this call.
        assert!(needs_seek(1_000_000, 1_000_000, 12_500_000, 3_000_000));
    }

    #[test]
    fn needs_seek_tolerates_legitimate_pre_buffer_lead() {
        // Paused pre-buffering legally runs the frontier one LOOKAHEAD_US ahead of
        // a held anchor. That must NOT read as backward divergence, or a parked
        // playhead would re-seek on every idle tick.
        let anchor = 5_000_000;
        assert!(!needs_seek(
            anchor,
            anchor,
            anchor + LOOKAHEAD_US,
            3_000_000
        ));
        // The backstop only fires beyond the pre-buffer lead it must tolerate.
        assert!(BACKWARD_DIVERGENCE_US > LOOKAHEAD_US);
    }

    #[test]
    fn decode_panic_surfaces_as_error_poke_and_leaves_registry_usable() {
        // Mirrors the SW/export lanes' panic test: a panic on the session thread's
        // decode path must NOT silently kill the thread (renderer waits forever on
        // frames that never arrive) and must NOT cascade through the shared poke
        // lock. The sink panics on its FIRST call — simulating a panic in the
        // emit/routing path while the poke lock is held, which poisons that lock.
        // This exercises both fixes at once: the session loop's `catch_unwind` turns
        // the panic into an `Error` poke, and the recovery `emit` only reaches the
        // sink because `lock_recover` recovers the poisoned lock instead of
        // re-panicking (revert either and this test fails).
        //
        // GPU-lane caveat: unlike the SW lane, `open` needs a real d3d11va device —
        // it does NOT fall back to software (decoder.rs). On a host without one
        // (e.g. a headless CI runner) `open` fails; the panic-resilience logic is
        // host-independent, so we skip rather than fail. On a GPU host (dev boxes,
        // GPU CI) this runs for real. The panic fires on whatever poke `pump` emits
        // first — `FrameReady`, `Eof`, or a decode `Error` — so it validates the
        // resilience path even when the fixture can't be hardware-decoded.
        let calls = Arc::new(AtomicUsize::new(0));
        let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let calls2 = calls.clone();
        let errors2 = errors.clone();
        let reg = PreviewGpuRegistry::new();
        reg.set_poke_sink(Box::new(move |poke| {
            if calls2.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("boom in preview-gpu sink");
            }
            if let PreviewGpuPoke::Error { message, .. } = poke {
                errors2.lock().unwrap().push(message);
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");
        let Ok(_info) = reg.open("s1", p, 2, "bt709", false) else {
            eprintln!("skipping preview-gpu panic test: no d3d11va device on this host");
            return;
        };
        reg.request_frame_at("s1", 0).expect("request_frame_at");
        // Polled, not a fixed 500 ms — see test_wait. The export-lane twin of
        // this test failed on a loaded windows CI runner with an empty vec, and
        // this one carried the identical sleep-then-assert shape.
        let saw_panic_poke =
            wait_for(|| errors.lock().unwrap().iter().any(|m| m.contains("panicked")));
        let errs = errors.lock().unwrap();
        assert!(
            saw_panic_poke,
            "expected a decode-panic Error poke, got: {errs:?}"
        );
        drop(errs);
        // The poisoned poke lock did not cascade: the registry still tears down
        // cleanly (join reaps the thread that broke out after the caught panic).
        reg.close("s1")
            .expect("registry usable after a caught decode panic");
    }
}
