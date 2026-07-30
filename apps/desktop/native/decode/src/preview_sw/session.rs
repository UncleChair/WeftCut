//! Per-source software-decode session thread + registry.
//!
//! A strict simplification of `preview_gpu/session.rs`. Each preview session owns
//! a dedicated OS thread that opens a [`SwVideoStream`] and runs a
//! DECODE-ON-REQUEST loop: napi-side commands (`request_frame_at` / `close`) post
//! messages over an mpsc channel; decoded frames leave the thread as owned
//! [`SwFramePoke::Frame`] bytes (NV12, or tightly-packed I420P10 for a 10-bit
//! session — the frame's `format` says which) through a shared sink.
//!
//! What this DROPS vs. the GPU mirror (and why): there is no D3D11 anywhere — no
//! shared-texture pool, no keyed mutex, no slot free-list, no `ConsumeAck`
//! round-trip, and none of the decode-bench timing probes. The GPU path needs all
//! of that because a decoded surface is a *borrowed* GPU texture valid only until
//! the next `next_frame`, so the renderer must ack before the slot is reused. Here
//! the frame bytes ARE the payload: [`SwFrame`] is fully owned and `Send`, so it
//! travels through the sink and outlives the stream — no coherence protocol
//! needed, and no background refill pump.
//!
//! A served request decodes FORWARD FROM WHERE THE LAST ONE STOPPED and keeps
//! [`LOOKAHEAD_HORIZON_US`] of frames ready past the target — see
//! [`serve_request`] and [`PumpCursor`]. Only a request that moves backward, or
//! lands further than [`FORWARD_CONTINUE_US`] past the frontier, pays a seek.
//! Requests are additionally coalesced latest-wins at the loop top: before
//! serving, the thread drains everything already queued, so a scrub storm's
//! superseded targets are dropped unserved (their pokes simply never fire) and
//! only the newest target is served. A drained `Close` wins over any pending
//! request.
//!
//! Thread ownership: [`SwVideoStream`] is `!Send`-in-spirit (raw ffmpeg
//! pointers; marked `Send` forward-compat) but it is created, driven, and
//! dropped entirely on the session thread and never crosses a boundary, so
//! that mark is never exercised here. Only plain `Send` data crosses: the
//! command `Receiver`, the sink `Arc`, the path/id strings in, and the
//! pokes out.
//!
//! The napi addon wires the registry + sink; from the plain-lib build's
//! view the public API is `dead_code` (the unit test exercises it).
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::decoder::{
    DecodeAccel, OutScale, OutputCadence, SwFrame, SwOutFormat, SwVideoStream,
};
use crate::recover::{panic_message, LockExt};

/// How far PAST the request target this lane keeps frames decoded before it
/// stops. This — not a frame count — is the lane's flow control: during playback
/// the target advances one frame per tick, so exactly one new frame falls inside
/// the horizon per request and the lane delivers at content rate instead of
/// racing ahead of its consumer.
///
/// Sized under `FrameRing`'s 1 s lookahead (renderer side) so a full horizon can
/// never overflow the ring's window. A fixed burst count cannot do this job: with
/// one, every request re-emits frames the ring already holds — measured at 4×
/// duplicate delivery on an all-intra source, 93 fps of NV12 pushed across IPC
/// for 30 fps of content.
const LOOKAHEAD_HORIZON_US: i64 = 500_000;

/// Furthest a request may sit PAST the decode frontier and still be served by
/// decoding through the gap rather than seeking to it. Twin of the WebCodecs
/// lane's `FORWARD_SEEK_RESET_US` (`PacketPump.ts`) — same value, same reasoning:
/// a seek costs a keyframe landing plus the entire GOP prefix, so it only wins
/// once the gap is longer than the walk would be.
///
/// LANDMINE: this is what makes forward playback cheap on a long-GOP source.
/// Seeking per request re-walks the GOP prefix every tick, and the prefix grows
/// as the playhead moves through the GOP — measured 137× decode amplification on
/// the 240-frame-GOP H.264 bench fixture (20 629 frames decoded to deliver 150),
/// which is 0.17× realtime where a linear walk is 15×. Anyone re-adding an
/// unconditional seek here re-creates that.
const FORWARD_CONTINUE_US: i64 = 1_000_000;

/// Hard cap on the frames one request may emit. Bounds cold start and horizon
/// re-fill after a long pause: without it a single request could hold the thread
/// away from the next command, and dump an unbounded NV12 burst across IPC in one
/// go. Steady playback never reaches it (one frame per request).
const MAX_BURST_FRAMES: usize = 16;

/// Largest number of backward re-seek attempts when a container's seek overshoots
/// the target. Index-less MPEG-PS/TS estimate the seek byte-offset and can land
/// AFTER the requested time; each retry steps the target back by a growing margin.
/// The final fallback (seek target 0) decodes from the start — always correct.
const MAX_SEEK_RETRIES: u32 = 6;
/// Initial backward step when re-seeking after an overshoot; doubles each retry.
/// ~1 s clears a typical (≤1 s) GOP overshoot in a single retry.
const SEEK_RETRY_MARGIN_US: i64 = 1_000_000;

/// How long `close` waits for the session thread to exit before DETACHING it.
/// The healthy path clears this by orders of magnitude (the shutdown flag
/// preempts the backlog; the thread bails at its next per-frame check), so the
/// grace is only ever paid when the thread is wedged INSIDE a single ffmpeg
/// call (dump-verified: d3d11va stuck under GPU contention). Bounded so the
/// napi caller — Electron's main thread — sees a short blip, never an AppHang.
const CLOSE_GRACE: Duration = Duration::from_millis(300);

/// What `open` hands back once the session thread has opened its decoder: the
/// dimensions frames will SHIP at — the session's [`OutScale`] already applied,
/// so a downscaled preview reports the smaller size rather than the source's.
/// Built from `SwVideoStream`'s public `out_width`/`out_height` fields (set at
/// open) — no frame is decoded just to learn them. The addon maps this to a
/// `#[napi(object)]`.
#[derive(Debug, Clone, Copy)]
pub struct PreviewSwOpenInfo {
    pub width: u32,
    pub height: u32,
}

/// Announced out of a session thread through the shared sink. `Send` (its only
/// payload is the owned [`SwFrame`] + plain strings) so the addon can forward it
/// to its event channel. Every variant carries `stream_id` so a single sink
/// can route to the right per-stream callback.
pub enum SwFramePoke {
    /// A decoded frame, owned packed bytes (`frame.format` names the layout:
    /// NV12 or I420P10) + timing/color. The consumer keeps or drops it freely —
    /// nothing on the session thread references it after this.
    Frame { stream_id: String, frame: SwFrame },
    /// The stream reached its end; no more frames until a `request_frame_at` seeks
    /// backward.
    Eof { stream_id: String },
    /// A non-fatal decode/seek failure. The session stays registered and can be
    /// retried with another `request_frame_at`.
    Error { stream_id: String, message: String },
}

/// Boxed sink shared with every session thread. `Mutex<Box<dyn Fn + Send>>` is
/// `Send + Sync` (a `Mutex<T>` is `Sync` when `T: Send`), so an `Arc` of it clones
/// into each thread and the mutex serialises concurrent sessions' calls — sound
/// even though the closure is only `Send`, not `Sync`. Mirrors the GPU path's
/// `PokeSink`.
type FrameSink = Arc<Mutex<Option<Box<dyn Fn(SwFramePoke) + Send>>>>;

/// Control messages posted to a session thread by the registry. No `ConsumeAck`:
/// with owned frame bytes there is no slot to release.
enum SwSessionMsg {
    /// Seek to this source-microsecond target and decode a bounded burst forward.
    RequestFrameAt(i64),
    /// Tear down and exit the thread.
    Close,
}

/// The registry's per-session handle. The decoder lives on the thread, not here;
/// this side keeps only the command channel + shutdown flag + done signal +
/// join handle.
struct Session {
    tx: Sender<SwSessionMsg>,
    /// Set (Release) by `close` BEFORE its `Close` send; the thread checks it
    /// (Acquire) on each message and inside a burst, and bails. The loop-top
    /// latest-wins drain ALSO breaks on a drained `Close`, but this flag stays
    /// the authority for teardown: it alone can abort a burst MID-decode, and
    /// it holds even when the `Close` message is never received (thread busy
    /// past the grace, registry gone). The drain's Close-wins is an
    /// optimization on the same path, not a replacement.
    shutdown: Arc<AtomicBool>,
    /// Thread-exit signal: nothing is ever SENT — the paired `Sender` sits in
    /// the session thread's closure frame, so `recv_timeout` observing
    /// `Disconnected` means the thread body finished. Drop-based rather than an
    /// explicit send-as-last-action because unwind drops the frame too: a
    /// PANICKING thread releases the signal, where a final `send` would never
    /// run and `close` would burn the full grace on every panic.
    done_rx: Receiver<()>,
    /// `Option` so `close` can `take()` it to join exactly once.
    join: Option<JoinHandle<()>>,
}

/// Which teardown path [`PreviewSwRegistry::close`] took. Split out (rather
/// than folded into the `Result`) so the unit tests can assert the healthy
/// path really reaps — with a bounded grace, a plain `Ok` alone no longer
/// proves the thread exited.
#[derive(Debug, PartialEq, Eq)]
enum CloseOutcome {
    /// The thread exited within the grace window and was joined.
    Reaped,
    /// The thread was still busy at the deadline; its handle was dropped. It
    /// self-cleans when the blocking call returns and it sees the flag.
    Detached,
}

/// Fire a poke through the shared sink if one is set. The mutex is held across the
/// call so concurrent sessions serialise (the addon's sink is a non-blocking event
/// enqueue, so this can't deadlock or stall).
fn emit(sink: &FrameSink, poke: SwFramePoke) {
    let guard = sink.lock_recover();
    if let Some(f) = guard.as_ref() {
        f(poke);
    }
}

/// Where the decoder is, carried ACROSS `request_frame_at` calls. This is the
/// whole of the lane's flow control; without it every request is a fresh seek
/// and a fixed burst, which starves long-GOP sources and floods intra ones.
/// Owned by the session thread, never crosses a boundary.
#[derive(Default)]
struct PumpCursor {
    /// A frame decoded past the previous request's horizon, held so the next
    /// forward request resumes ON it rather than decoding it a second time.
    pending: Option<SwFrame>,
    /// Target of the last request served. A request at or after it is FORWARD;
    /// anything earlier is a backward seek. `None` before the first request.
    last_target_us: Option<i64>,
    /// PTS of the newest frame decoded so far — the frontier a forward request
    /// measures its gap against ([`FORWARD_CONTINUE_US`]).
    frontier_us: i64,
    /// EOF reached, and not yet re-armed by a backward seek. Without this, every
    /// tick past the end of a clip re-seeks and re-decodes the tail to rediscover
    /// the same EOF.
    ended: bool,
}

impl PumpCursor {
    /// Forget where the decoder is, so the next request — forward or not — seeks
    /// before it decodes. Used after a seek/decode failure: the stream's position
    /// is undefined at that point, and continuing from it would deliver frames
    /// from the wrong place. (The pre-cursor code got this for free by seeking
    /// unconditionally.)
    fn invalidate(&mut self) {
        self.pending = None;
        self.last_target_us = None;
        self.ended = false;
    }
}

/// Robustly seek to a keyframe at/before `target_us` and return the first frame
/// decoded there — the initial candidate for the forward scan.
///
/// ffmpeg's BACKWARD seek is only approximate on index-less containers
/// (MPEG-PS/TS): it estimates a byte offset and can overshoot, landing AFTER the
/// target. Probe the first decoded frame; if it is past the target, re-seek
/// earlier with a growing margin until it lands at/before (or we reach the file
/// start, always a valid at-or-before landing). Indexed containers (MOV/MP4) land
/// correctly on the first try — zero retries. Mirrors `export_sw`'s
/// `robust_seek_and_probe`.
///
/// `Ok(None)` = the seek landed at EOF. Returns early with `Ok(None)` on
/// teardown too; the caller checks `shutdown` itself before emitting anything.
fn robust_seek_and_probe(
    stream: &mut SwVideoStream,
    target_us: i64,
    shutdown: &AtomicBool,
) -> Result<Option<SwFrame>, String> {
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    loop {
        // Teardown preempts: each attempt is itself a seek + a decode probe.
        if shutdown.load(Ordering::Acquire) {
            return Ok(None);
        }
        stream
            .seek(seek_target)
            .map_err(|e| format!("seek to {seek_target}us failed: {e}"))?;
        match stream.next_frame()? {
            Some(f) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
                    // Overshoot — step the seek target back and retry.
                    seek_target = (target_us - margin).max(0);
                    margin = margin.saturating_mul(2);
                    attempt += 1;
                    continue;
                }
                return Ok(Some(f)); // landed at/before target (or can't retry further)
            }
            None => return Ok(None),
        }
    }
}

/// Service one `request_frame_at`: make sure everything from `target_us` to
/// `target_us + LOOKAHEAD_HORIZON_US` has been poked, decoding only what is not
/// already delivered.
///
/// A FORWARD request (target at/after the last one, and no further than
/// [`FORWARD_CONTINUE_US`] past the decode frontier) resumes on the cursor's
/// stashed frame and walks the stream — no seek, no re-decode, so a playing
/// timeline costs exactly the frames it displays. Anything else (backward scrub,
/// a long forward jump, the first request) seeks to the keyframe at/before the
/// target and discards the GOP prefix as references.
///
/// Stops on the horizon (stashing the frame that crossed it), on
/// [`MAX_BURST_FRAMES`], on EOF (an `Eof` poke) or on a decode error (an `Error`
/// poke). A seek failure is reported as `Error` and skips the burst — the session
/// stays open for retry. Once `shutdown` is observed set, returns without
/// emitting anything further — no `Error` poke, this is a normal teardown, not a
/// failure.
fn serve_request(
    stream: &mut SwVideoStream,
    cursor: &mut PumpCursor,
    target_us: i64,
    sink: &FrameSink,
    stream_id: &str,
    shutdown: &AtomicBool,
) {
    // Saturating, as the GPU twin is at every equivalent site: `target_us`
    // arrives as `f64 as i64` from napi, so an absurd JS value sits at the i64
    // extremes, where plain `-` panics in debug and wraps (misclassifying
    // forward/backward) in release.
    let forward = cursor.last_target_us.is_some_and(|lt| {
        target_us >= lt && target_us.saturating_sub(cursor.frontier_us) <= FORWARD_CONTINUE_US
    });

    // Forward past a drained stream: there is nothing left to decode and the
    // consumer was already told. Re-seeking to rediscover EOF is the tail cost
    // this avoids on every tick that sits past the end of a clip.
    if forward && cursor.ended {
        return;
    }

    if !forward {
        match robust_seek_and_probe(stream, target_us, shutdown) {
            Ok(Some(f)) => {
                cursor.frontier_us = f.pts_us;
                cursor.pending = Some(f);
                cursor.ended = false;
            }
            Ok(None) => {
                // Teardown wins silently; a real EOF landing is still an EOF.
                if shutdown.load(Ordering::Acquire) {
                    return;
                }
                cursor.pending = None;
                cursor.ended = true;
                // The frontier must track the requested target on an EOF
                // landing: left stale, every post-EOF tick further than
                // FORWARD_CONTINUE_US past it fails the forward test and pays a
                // fresh seek+flush+probe to rediscover the same EOF, forever.
                // Advanced, the retry cadence collapses to one seek per
                // FORWARD_CONTINUE_US of playhead advance — which doubles as
                // self-heal for still-growing files.
                cursor.frontier_us = cursor.frontier_us.max(target_us);
                emit(
                    sink,
                    SwFramePoke::Eof {
                        stream_id: stream_id.to_string(),
                    },
                );
                cursor.last_target_us = Some(target_us);
                return;
            }
            Err(message) => {
                cursor.invalidate();
                emit(
                    sink,
                    SwFramePoke::Error {
                        stream_id: stream_id.to_string(),
                        message,
                    },
                );
                return;
            }
        }
    }
    cursor.last_target_us = Some(target_us);

    let mut emitted = 0usize;
    loop {
        let frame = match cursor.pending.take() {
            Some(f) => f,
            None => {
                // Teardown preempts the (potentially slow) decode of the next
                // frame; long-GOP discard loops pass through here every frame.
                if shutdown.load(Ordering::Acquire) {
                    return;
                }
                match stream.next_frame() {
                    Ok(Some(f)) => {
                        cursor.frontier_us = f.pts_us;
                        f
                    }
                    Ok(None) => {
                        cursor.ended = true;
                        // Same constraint as the seek-landing EOF arm above: an
                        // indexed container's far-forward seek lands on the tail
                        // keyframe and EOF surfaces HERE, with the frontier at
                        // the tail frame's pts — stale, every later tick past
                        // the continue-window would re-seek forever.
                        cursor.frontier_us = cursor.frontier_us.max(target_us);
                        emit(
                            sink,
                            SwFramePoke::Eof {
                                stream_id: stream_id.to_string(),
                            },
                        );
                        return;
                    }
                    Err(message) => {
                        cursor.invalidate();
                        emit(
                            sink,
                            SwFramePoke::Error {
                                stream_id: stream_id.to_string(),
                                message,
                            },
                        );
                        return;
                    }
                }
            }
        };
        // A frame whose interval ends at/before the target is in the past — a GOP
        // prefix decoded only as a reference, or (on a forward continuation) a
        // frame the consumer already holds. `.max(1)` guards a 0/unknown duration
        // so the covering frame (pts ≈ target) is never skipped.
        if frame.pts_us.saturating_add(frame.dur_us.max(1)) <= target_us {
            continue;
        }
        // Past the horizon: enough is ready. Stash it, so the next forward
        // request resumes here and this frame is never decoded twice.
        if frame.pts_us > target_us.saturating_add(LOOKAHEAD_HORIZON_US) {
            cursor.pending = Some(frame);
            return;
        }
        // No Frame poke may fire once teardown is observed — the consumer side
        // is being torn down and must not receive late frames.
        if shutdown.load(Ordering::Acquire) {
            return;
        }
        emit(
            sink,
            SwFramePoke::Frame {
                stream_id: stream_id.to_string(),
                frame,
            },
        );
        emitted += 1;
        if emitted >= MAX_BURST_FRAMES {
            return;
        }
    }
}

/// The session thread body: open the decoder, report the dimensions back to
/// `open`, then run a blocking message loop until `Close`, the `shutdown` flag,
/// or the sender drops.
///
/// A plain blocking `rx.recv()` is sufficient here (unlike the GPU mirror's
/// `recv_timeout` pump): there is no background slot-refill work to do between
/// messages, so the thread simply sleeps until the next command. Each wake-up
/// then drains the channel non-blockingly and coalesces latest-wins before
/// serving — see the loop body.
fn session_thread(
    stream_id: String,
    path: String,
    accel: DecodeAccel,
    out_format: SwOutFormat,
    out_scale: OutScale,
    output_cadence: OutputCadence,
    rx: Receiver<SwSessionMsg>,
    init_tx: Sender<Result<PreviewSwOpenInfo, String>>,
    sink: FrameSink,
    shutdown: Arc<AtomicBool>,
) {
    let mut stream =
        match SwVideoStream::open_with_accel(&path, out_format, accel, out_scale) {
            Ok(s) => s,
            Err(e) => {
                let _ = init_tx.send(Err(e));
                return;
            }
        };
    stream.set_output_cadence(output_cadence);
    // Dimensions come from the stream's public fields (set at open) — do NOT
    // decode a frame just to learn them. The SHIPPED pair, not the source's:
    // every frame this session emits carries these.
    let info = PreviewSwOpenInfo {
        width: stream.out_width,
        height: stream.out_height,
    };
    if init_tx.send(Ok(info)).is_err() {
        // `open` gave up waiting; drop `stream` and exit.
        return;
    }

    // Lives for the whole session, beside the stream it describes: it is what
    // lets consecutive requests share one forward decode pass.
    let mut cursor = PumpCursor::default();

    while let Ok(first) = rx.recv() {
        // Teardown preempts the queued backlog: the channel is FIFO, so `Close`
        // sits behind every pending `RequestFrameAt`; the flag doesn't.
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        // Latest-wins coalescing: drain everything already queued BEFORE
        // serving. Only the newest scrub target matters for preview, so
        // consecutive `RequestFrameAt` collapse to the last one drained —
        // superseded targets never cost a seek+burst and never poke (the
        // renderer keys frames by pts off a latest-target ring anchor, so a
        // burst that never fires is indistinguishable from one it evicted). A
        // drained `Close` wins outright: teardown is never postponed behind a
        // request. The shutdown flag stays the authority for teardown (it
        // alone aborts a burst MID-decode); this drain is an optimization on
        // the same path, not a replacement. No timers, no extra threads —
        // purely a non-blocking sweep of what recv() woke up to.
        let mut target_us = match first {
            SwSessionMsg::RequestFrameAt(t) => t,
            SwSessionMsg::Close => break,
        };
        let mut close_drained = false;
        loop {
            match rx.try_recv() {
                Ok(SwSessionMsg::RequestFrameAt(t)) => target_us = t,
                Ok(SwSessionMsg::Close) => {
                    close_drained = true;
                    break;
                }
                // Empty = nothing else queued; Disconnected = registry gone.
                // Either way the drain is over — serve what we have (matches
                // the pre-drain behavior of serving, then exiting on the next
                // failed recv).
                Err(_) => break,
            }
        }
        // Re-check the flag after the drain: `close` sets it BEFORE its send,
        // so a flag observed here means the `Close` is either drained above or
        // in flight — never worth a burst first.
        if close_drained || shutdown.load(Ordering::Acquire) {
            break;
        }
        // A panic in the ffmpeg decode path must not silently kill this
        // thread and leave the renderer waiting forever on frames that
        // never arrive. Catch it, surface it as a normal `Error` poke (so
        // JS tears the session down / retries), then stop: the stream's
        // libav state is suspect after an unwind, so we never touch it
        // again — which is exactly what makes the `AssertUnwindSafe`
        // (needed for the `&mut stream` capture) sound here.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            serve_request(
                &mut stream,
                &mut cursor,
                target_us,
                &sink,
                &stream_id,
                &shutdown,
            );
        }));
        if let Err(payload) = outcome {
            emit(
                &sink,
                SwFramePoke::Error {
                    stream_id: stream_id.clone(),
                    message: format!(
                        "preview-sw decode panicked: {}",
                        panic_message(&*payload)
                    ),
                },
            );
            break;
        }
    }
    // `stream` drops here: the decoder + format context release on this thread.
}

/// The set of live software preview sessions. `Send + Sync`, so the addon can
/// hold it (e.g. behind an `Arc`) and drive it from napi calls.
pub struct PreviewSwRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    sink: FrameSink,
}

impl Default for PreviewSwRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewSwRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sink: Arc::new(Mutex::new(None)),
        }
    }

    /// Install the sink every session emits pokes through. Set once by the addon
    /// before any `open`; sessions share the same cell, so a later set is seen by
    /// already-running threads too.
    pub fn set_frame_sink(&self, sink: Box<dyn Fn(SwFramePoke) + Send>) {
        *self.sink.lock_recover() = Some(sink);
    }

    /// Open `path` for software preview at full resolution: spawn its decode
    /// thread and hand back the frame dimensions once the thread reports ready.
    /// Blocks on the init handshake so a decoder-open failure surfaces
    /// synchronously. Delegates to
    /// [`open_with_accel`](Self::open_with_accel) on the software lane.
    pub fn open(&self, stream_id: &str, path: &str) -> Result<PreviewSwOpenInfo, String> {
        self.open_with_accel(stream_id, path, DecodeAccel::Software, OutScale::FULL)
    }

    /// Open `path` for preview on `accel` — the software lane (mirrors [`open`]) or
    /// a copy-back hardware lane (`DecodeAccel::Nvdec`/`Vaapi`, issue #5 Block C;
    /// `DecodeAccel::VideoToolbox`, issue #10): the session thread opens its
    /// [`SwVideoStream`] via `open_with_accel` so hw frames are transferred back to
    /// CPU NV12, feeding the SAME frame transport as software. Blocks on the init
    /// handshake so a decoder-open failure (including a hw device that can't be
    /// created) surfaces synchronously and falls back.
    ///
    /// `out_scale` is the playback-resolution divisor: the session ships every
    /// frame at that fraction of the source size, so a 4K frame crosses IPC
    /// smaller. Both lanes honor it — the copy-back lanes land a full-size CPU
    /// frame first either way.
    ///
    /// [`open`]: Self::open
    pub fn open_with_accel(
        &self,
        stream_id: &str,
        path: &str,
        accel: DecodeAccel,
        out_scale: OutScale,
    ) -> Result<PreviewSwOpenInfo, String> {
        self.open_with_accel_and_cadence(
            stream_id,
            path,
            accel,
            SwOutFormat::Nv12,
            out_scale,
            OutputCadence::FULL,
        )
    }

    /// Preview-only extension of [`open_with_accel`](Self::open_with_accel):
    /// `output_cadence` selects which decoded frames are packed and shipped,
    /// and `out_format` the CPU transport format the session packs into —
    /// NV12 (every existing caller), or I420P10 for a 10-bit source on the
    /// VideoToolbox lane (issue #10 ticket 03), whose frame pokes then carry
    /// tightly-packed u16LE planes into the renderer's ten-bit adapter. The
    /// identity cadence + NV12 preserve every existing caller exactly.
    pub fn open_with_accel_and_cadence(
        &self,
        stream_id: &str,
        path: &str,
        accel: DecodeAccel,
        out_format: SwOutFormat,
        out_scale: OutScale,
        output_cadence: OutputCadence,
    ) -> Result<PreviewSwOpenInfo, String> {
        let mut sessions = self.sessions.lock_recover();
        if sessions.contains_key(stream_id) {
            return Err(format!("preview-sw session '{stream_id}' is already open"));
        }

        let (init_tx, init_rx) = mpsc::channel::<Result<PreviewSwOpenInfo, String>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<SwSessionMsg>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let sink = Arc::clone(&self.sink);
        let sid = stream_id.to_string();
        let path_owned = path.to_string();
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = Arc::clone(&shutdown);

        let join = thread::Builder::new()
            .name(format!("preview-sw-{sid}"))
            .spawn(move || {
                // Held, never used: its drop — on return AND on panic unwind —
                // is the done signal `close` bounds its wait on. Do NOT overload
                // `init_tx` for this; it is consumed by the open handshake.
                let _done_tx = done_tx;
                session_thread(
                    sid,
                    path_owned,
                    accel,
                    out_format,
                    out_scale,
                    output_cadence,
                    cmd_rx,
                    init_tx,
                    sink,
                    shutdown_for_thread,
                )
            })
            .map_err(|e| format!("spawn preview-sw session thread failed: {e}"))?;

        match init_rx.recv() {
            Ok(Ok(info)) => {
                sessions.insert(
                    stream_id.to_string(),
                    Session {
                        tx: cmd_tx,
                        shutdown,
                        done_rx,
                        join: Some(join),
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
                // Thread vanished before reporting (e.g. panicked in open).
                let _ = join.join();
                Err(format!(
                    "preview-sw session '{stream_id}' thread exited before init"
                ))
            }
        }
    }

    /// Ask a session to decode toward `target_us`. Fire-and-forget: the thread
    /// seeks + decodes the burst and pokes each frame out through the sink.
    pub fn request_frame_at(&self, stream_id: &str, target_us: i64) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-sw session '{stream_id}'"))?;
        session
            .tx
            .send(SwSessionMsg::RequestFrameAt(target_us))
            .map_err(|_| format!("preview-sw session '{stream_id}' thread is gone"))
    }

    /// Signal the session thread to tear down and wait a BOUNDED grace
    /// ([`CLOSE_GRACE`]) for it to exit. The queued backlog is covered twice
    /// over: the thread's loop-top drain coalesces queued `request_frame_at`s
    /// latest-wins and breaks the moment it drains a `Close`, and the
    /// shutdown flag — set BEFORE the `Close` send — remains the authority
    /// (it alone aborts a burst mid-decode, and it holds even if the `Close`
    /// message is never received). Note the drain means superseded requests
    /// may never fire their pokes AT ALL — that is normal operation, not a
    /// teardown-only effect. On timely exit the thread is reaped (a panicked
    /// thread surfaces as
    /// `Err`, as before); if it is still wedged INSIDE a single decode call at
    /// the deadline (the dump-verified d3d11va hang) it is DETACHED and `close`
    /// returns `Ok` — the caller is the napi (Electron main) thread and must
    /// never wait unboundedly. Landmine: on the detach path a straggler's panic
    /// is unobservable (nothing ever joins it).
    ///
    /// Contract: `close` returns promptly; it does NOT guarantee the thread has
    /// exited — only that no poke will be DELIVERED after the caller removes
    /// its sink entry. A straggler checks `shutdown` before every `Frame` emit,
    /// and the addon's single-sink router drops pokes whose `stream_id` is
    /// unregistered (`Eof`/`Error` route to logs only). Re-opening the same id
    /// is safe: the map entry is removed here, so `open`'s `contains_key` sees
    /// a free id, and the straggler holds only the OLD session's flag + sink
    /// clone — its frame emits stay suppressed. Guards against double-close /
    /// missing id via the map removal.
    pub fn close(&self, stream_id: &str) -> Result<(), String> {
        self.close_with_grace(stream_id, CLOSE_GRACE).map(|_| ())
    }

    /// [`close`](Self::close) with the grace window explicit, reporting which
    /// teardown path ran — the seam the unit tests drive to tell reap from
    /// detach without waiting out production timings.
    fn close_with_grace(&self, stream_id: &str, grace: Duration) -> Result<CloseOutcome, String> {
        // Remove from the map (releasing the sessions lock) before waiting, so
        // a slow teardown doesn't block registry ops on other sessions — and a
        // re-open of this id never collides with the old session.
        let session = self.sessions.lock_recover().remove(stream_id);
        let Some(mut s) = session else {
            return Err(format!("no preview-sw session '{stream_id}'"));
        };
        // Flag first, THEN the send: the send is just a wake-up for an idle
        // thread — the flag is what actually stops a busy one. If the thread
        // already exited the send fails, and the done signal below resolves
        // immediately (`Disconnected`).
        s.shutdown.store(true, Ordering::Release);
        let _ = s.tx.send(SwSessionMsg::Close);
        // Bound the wait on the done signal, never on `join()` (which has no
        // timeout). `Disconnected` = the sender in the thread's closure frame
        // dropped = the thread body finished, by return or unwind alike.
        // `Ok(())` is unreachable (nothing ever sends) but read as done for
        // robustness.
        match s.done_rx.recv_timeout(grace) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(join) = s.join.take() {
                    // Non-blocking now: the body finished; only OS-thread
                    // teardown remains. Err = the thread panicked — surfaced
                    // exactly as the old unbounded-join contract did.
                    join.join().map_err(|_| {
                        format!("preview-sw session '{stream_id}' thread panicked during teardown")
                    })?;
                }
                Ok(CloseOutcome::Reaped)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                tracing::warn!(
                    %stream_id,
                    grace_ms = grace.as_millis() as u64,
                    "preview-sw close: session thread still inside a decode call after grace; detaching"
                );
                // Detach: drop the handle and return. The thread self-cleans
                // once the blocking call returns and it sees the flag.
                drop(s.join.take());
                Ok(CloseOutcome::Detached)
            }
        }
    }

    /// Test-only seam for the detach path: register a session whose thread is
    /// WEDGED — parked in one long sleep that ignores the shutdown flag and the
    /// command channel, standing in for ffmpeg stuck inside a single decode
    /// call. It wires a real `Session` (command channel, flag, done signal,
    /// join handle), so `close` runs the exact production grace/detach code;
    /// only the thread body is fake.
    #[cfg(test)]
    fn open_wedged_for_test(&self, stream_id: &str, wedge: Duration) {
        let (cmd_tx, cmd_rx) = mpsc::channel::<SwSessionMsg>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let join = thread::Builder::new()
            .name(format!("preview-sw-wedged-{stream_id}"))
            .spawn(move || {
                let _done_tx = done_tx;
                let _cmd_rx = cmd_rx; // held so close()'s Close send behaves as in prod
                thread::sleep(wedge);
            })
            .expect("spawn wedged stub thread");
        self.sessions.lock_recover().insert(
            stream_id.to_string(),
            Session {
                tx: cmd_tx,
                shutdown: Arc::new(AtomicBool::new(false)),
                done_rx,
                join: Some(join),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn open_then_request_delivers_a_frame() {
        // Each delivered Frame poke records (width, pts_us).
        let got: Arc<Mutex<Vec<(u32, i64)>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push((frame.width, frame.pts_us));
            }
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let info = reg.open("s1".into(), p.into()).expect("open");
        assert_eq!(info.width, 320);
        let _ = reg.request_frame_at("s1".into(), 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = reg.close("s1".into());
        let frames = got.lock().unwrap();
        assert!(!frames.is_empty(), "expected at least one frame poke");
        // §5: the delivered frame carries a sensible pts_us (seek(0) -> first
        // frame at/after container start, so >= 0). Do NOT assert color tags:
        // the synthetic testsrc fixture may leave them unspecified (None valid).
        assert_eq!(frames[0].0, 320, "frame width");
        assert!(
            frames[0].1 >= 0,
            "expected pts_us >= 0, got {}",
            frames[0].1
        );
    }

    #[test]
    fn open_reports_the_shipped_dimensions_and_honors_the_small_source_floor() {
        // The 320x240 fixture is already at the floor, so even a ¼ request ships
        // full size — and `open`'s reply must agree with the frames, or the
        // renderer sizes its texture against a resolution that never arrives.
        let got: Arc<Mutex<Vec<(u32, u32, usize)>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock()
                    .unwrap()
                    .push((frame.width, frame.height, frame.data.len()));
            }
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let info = reg
            .open_with_accel("sc1", p, DecodeAccel::Software, OutScale::from_divisor(4))
            .expect("open");
        assert_eq!((info.width, info.height), (320, 240));
        let _ = reg.request_frame_at("sc1", 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = reg.close("sc1");
        let frames = got.lock().unwrap();
        assert!(!frames.is_empty(), "expected at least one frame poke");
        assert_eq!(frames[0].0, info.width);
        assert_eq!(frames[0].1, info.height);
        assert_eq!(frames[0].2, (320 * 240) + (320 * 240 / 2));
    }

    // The wired session path for the macOS copy-back lane (issue #10 ticket 02):
    // `preview_sw_open("videotoolbox")` maps to `DecodeAccel::VideoToolbox` and
    // lands here — the registry's session thread must open on that accel and
    // deliver the SAME NV12 frame pokes the software lane does. Deterministic on
    // any macOS host (VideoToolbox is an OS framework; see ticket 01's decoder
    // tests), unlike NVDEC/VAAPI whose registry-path proof stays manual/bench.
    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_session_delivers_nv12_frames_through_the_registry() {
        let got: Arc<Mutex<Vec<(u32, u32, usize)>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock()
                    .unwrap()
                    .push((frame.width, frame.height, frame.data.len()));
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_h264.mp4");
        let info = reg
            .open_with_accel("vt1", p, DecodeAccel::VideoToolbox, OutScale::FULL)
            .expect("open on videotoolbox through the registry");
        assert_eq!((info.width, info.height), (192, 144));
        let _ = reg.request_frame_at("vt1", 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = reg.close("vt1");
        let frames = got.lock().unwrap();
        assert!(!frames.is_empty(), "expected at least one frame poke");
        // Same ship-bytes NV12 shape as software (ADR 0029) — packed w*h*3/2.
        assert_eq!(frames[0].0, 192);
        assert_eq!(frames[0].1, 144);
        assert_eq!(frames[0].2, (192 * 144) + (192 * 144 / 2));
    }

    // Ticket 03 (issue #10): a 10-bit source on the VideoToolbox lane opens
    // with I420P10 output through the WIRED registry path — the session thread
    // decodes on the OS media engine, copies back, and pokes tightly-packed
    // u16LE I420P10 frames whose byte length is exactly what the renderer's
    // `tenBitFrameFromBytes` adapter expects (w*h*3 for even dims; a drift
    // there throws, so the length IS the contract). HEVC Main10 rather than
    // ProRes so the hw path truly engages on EVERY macOS host (the ProRes VT
    // decoder needs a ProRes-engine chip — see the decoder tests).
    #[cfg(target_os = "macos")]
    #[test]
    fn videotoolbox_session_delivers_i420p10_frames_through_the_registry() {
        let got: Arc<Mutex<Vec<(u32, u32, SwOutFormat, usize)>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock()
                    .unwrap()
                    .push((frame.width, frame.height, frame.format, frame.data.len()));
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_hevc10.mp4");
        let info = reg
            .open_with_accel_and_cadence(
                "vtp10",
                p,
                DecodeAccel::VideoToolbox,
                SwOutFormat::I420p10,
                OutScale::FULL,
                OutputCadence::FULL,
            )
            .expect("open HEVC Main10 on videotoolbox with I420P10 output");
        assert_eq!((info.width, info.height), (192, 144));
        let _ = reg.request_frame_at("vtp10", 0);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = reg.close("vtp10");
        let frames = got.lock().unwrap();
        assert!(!frames.is_empty(), "expected at least one frame poke");
        assert_eq!(frames[0].2, SwOutFormat::I420p10, "frame format tag");
        // u16LE Y (w*h) + U + V at (w/2)*(h/2) → 3 bytes/px on even dims — the
        // exact `tenBitFrameFromBytes` layout.
        assert_eq!(frames[0].0, 192);
        assert_eq!(frames[0].1, 144);
        assert_eq!(frames[0].3, 192 * 144 * 3);
    }

    #[test]
    fn long_gop_request_forward_decodes_to_target() {
        // MPEG-2 is long-GOP (GOP 15 here): AVSEEK_FLAG_BACKWARD lands on a
        // keyframe well before the target, so serve_request must decode-forward to
        // the frame COVERING the target. Without that it would deliver the
        // keyframe at ~0.5 s.
        let got: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push(frame.pts_us);
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");
        reg.open("m1".into(), p.into()).expect("open");
        let _ = reg.request_frame_at("m1".into(), 800_000); // ~frame 24, mid-GOP
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = reg.close("m1".into());
        let pts = got.lock().unwrap();
        assert!(!pts.is_empty(), "expected at least one frame poke");
        // FIRST delivered frame covers target 800_000, NOT the keyframe at ~500_000.
        assert!(
            pts[0] >= 700_000,
            "first delivered pts {} should cover target 800_000, not the keyframe (~500_000)",
            pts[0]
        );
        assert!(
            pts[0] <= 900_000,
            "first delivered pts {} overshot the target",
            pts[0]
        );
    }

    #[test]
    fn decode_panic_surfaces_as_error_poke_and_leaves_registry_usable() {
        // A panic on the session thread's decode path must NOT silently kill the
        // thread (renderer waits forever) and must NOT cascade. The sink panics on
        // its FIRST call — simulating a panic in the emit/routing path while the
        // shared sink lock is held, which poisons that lock. This exercises both
        // fixes at once: `serve_request`'s `catch_unwind` turns the panic into an
        // `Error` poke, and the recovery `emit` only reaches the sink because
        // `lock_recover` recovers the poisoned lock instead of re-panicking.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let calls2 = calls.clone();
        let errors2 = errors.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if calls2.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("boom in preview-sw sink");
            }
            if let SwFramePoke::Error { message, .. } = poke {
                errors2.lock().unwrap().push(message);
            }
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("s1".into(), p.into()).expect("open");
        let _ = reg.request_frame_at("s1".into(), 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let errs = errors.lock().unwrap();
        assert!(
            errs.iter().any(|m| m.contains("panicked")),
            "expected a decode-panic Error poke, got: {errs:?}"
        );
        drop(errs);
        // The poisoned sink lock did not cascade: the registry still tears down
        // cleanly (join reaps the thread that broke out after the caught panic).
        reg.close("s1".into())
            .expect("registry usable after a caught decode panic");
    }

    #[test]
    fn close_preempts_queued_backlog() {
        // The command channel is FIFO: with strict FIFO service, close() joins
        // only after the thread services EVERY queued request — here ~5000
        // long-GOP seek+decode bursts (measured ~10 s un-preempted on a fast
        // box, vs. the 2 s bound). Teardown now preempts twice over — the
        // shutdown flag (bail at the next per-message/per-frame check, the
        // mid-burst authority) AND the loop-top drain (a drained Close wins
        // before any burst) — so close() must return promptly, and faster
        // still than flag-only.
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(|_| {}));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");
        reg.open("c1".into(), p.into()).expect("open");
        for i in 0..5000 {
            // Alternate targets so every request is a real seek + forward-decode
            // burst (800_000 is mid-GOP: keyframe at ~500_000 + ~9 discards).
            let target = if i % 2 == 0 { 0 } else { 800_000 };
            reg.request_frame_at("c1".into(), target).expect("request");
        }
        let start = std::time::Instant::now();
        // With a bounded grace, a plain Ok from close() could mean DETACHED —
        // which would pass the timing bound even with preemption broken. Run
        // with a grace equal to the old 2 s bound and assert Reaped, so this
        // test still guards preemption itself (thread exited AND was joined).
        let outcome = reg
            .close_with_grace("c1".into(), std::time::Duration::from_secs(2))
            .expect("close");
        let elapsed = start.elapsed();
        assert_eq!(
            outcome,
            CloseOutcome::Reaped,
            "close detached; the queued backlog was not preempted"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "close() took {elapsed:?}; the queued backlog was not preempted"
        );
    }

    #[test]
    fn scrub_storm_coalesces_to_latest_target() {
        // Latest-wins drain: a queued scrub storm must NOT be served FIFO.
        //
        // Determinism rationale: the session thread races the send loop, so
        // "exactly one burst" cannot be asserted — the thread may legitimately
        // pick up the first request (and a few drain generations) while sends
        // are still queueing. What CANNOT legitimately happen under the drain
        // is full FIFO service: each target-0 burst is a real ffmpeg seek + a
        // decode burst (>= hundreds of microseconds), while an mpsc send is
        // sub-microsecond — for EVERY request to be served, the drain would have
        // to find the queue empty N-1 consecutive times against a tight send
        // loop, which the orders-of-magnitude speed gap rules out. So the test
        // asserts the two invariants that hold under every interleaving: (a) the
        // LAST target's burst IS emitted, and (b) target 0 was served at most
        // once (its low-pts pokes fit inside a single burst). A test-only seam
        // gating the thread's start would buy exact determinism but needs a
        // wedge inside the message loop — rejected as not trivially small.
        //
        // Note the horizon backs the drain up here: a repeat of an
        // already-served target finds the cursor's pending frame past
        // `target + LOOKAHEAD_HORIZON_US` and emits nothing at all. Both
        // mechanisms have to fail for this to trip.
        let got: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push(frame.pts_us);
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");
        reg.open("lw1".into(), p.into()).expect("open");
        // N-1 superseded requests at target 0 (burst pts ~0..135_000), then
        // ONE final request at 800_000 (burst pts >= 700_000, proven by
        // `long_gop_request_forward_decodes_to_target`). The two targets are
        // distinguishable by pts range with a wide dead zone between.
        const N: usize = 100;
        for _ in 0..(N - 1) {
            reg.request_frame_at("lw1".into(), 0).expect("request");
        }
        reg.request_frame_at("lw1".into(), 800_000).expect("request");
        // Poll (not one fixed sleep) until the final target's burst lands, so
        // a slow box waits longer instead of flaking; the timeout only trips
        // if the final request is never served at all.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if got.lock().unwrap().iter().any(|&v| v >= 700_000) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for the final target's burst; pokes so far: {:?}",
                got.lock().unwrap()
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = reg.close("lw1".into());
        let pts = got.lock().unwrap();
        assert!(
            pts.iter().any(|&v| (700_000..=900_000).contains(&v)),
            "final target's burst missing from {pts:?}"
        );
        let low = pts.iter().filter(|&&v| v < 500_000).count();
        assert!(
            low <= MAX_BURST_FRAMES,
            "target 0 was served more than once ({low} low-pts pokes, one burst is at most {MAX_BURST_FRAMES}); the {} superseded requests are not being coalesced",
            N - 1
        );
    }

    #[test]
    fn forward_playback_never_re_emits_a_frame() {
        // THE flow-control invariant (issue 04). Playback issues one request per
        // tick with the target advancing one frame; each must continue the
        // previous decode pass, never re-seek and re-deliver frames the consumer
        // already holds. Before the cursor existed, every request seeked and
        // emitted a fixed 4-frame burst, so consecutive requests overlapped by
        // three frames — 4× the NV12 across IPC, and a ring that filled with
        // duplicate PTS.
        //
        // Duplicates are the assertion because they are interleaving-proof: the
        // latest-wins drain may skip targets (fewer pokes), but no scheduling can
        // make a strictly-forward walk emit one PTS twice.
        let got: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push(frame.pts_us);
            }
        }));
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");
        reg.open("fw1".into(), p.into()).expect("open");
        const TICKS: i64 = 30;
        const STEP_US: i64 = 1_000_000 / 30;
        for i in 0..TICKS {
            reg.request_frame_at("fw1".into(), i * STEP_US)
                .expect("request");
            // Space the ticks so most are served rather than coalesced away —
            // this is a playback cadence, not a scrub storm.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = reg.close("fw1".into());
        let pts = got.lock().unwrap();
        assert!(!pts.is_empty(), "no frames delivered");
        let mut sorted = pts.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            pts.len(),
            "a PTS was delivered twice — the lane re-seeked and re-decoded: {pts:?}"
        );
        assert!(
            pts.windows(2).all(|w| w[0] < w[1]),
            "delivery is not monotonic; a forward tick re-seeked: {pts:?}"
        );
        // Nothing beyond the last target's horizon: the burst is bounded by the
        // horizon, not by how fast the decoder can run.
        let last_target = (TICKS - 1) * STEP_US;
        assert!(
            *pts.last().unwrap() <= last_target + LOOKAHEAD_HORIZON_US,
            "delivered {} us, past the {} us horizon of the last target",
            pts.last().unwrap(),
            last_target + LOOKAHEAD_HORIZON_US
        );
    }

    #[test]
    fn one_request_fills_exactly_the_horizon() {
        // The fixture is 8 frames at 8 fps (125 ms each), so a 500 ms horizon from
        // target 0 is frames 0..=4 and nothing more — an exact count, no timing
        // slack. Intra, so the seek lands on the covering frame with no prefix.
        let got: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push(frame.pts_us);
            }
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("hz1".into(), p.into()).expect("open");
        let _ = reg.request_frame_at("hz1".into(), 0);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = reg.close("hz1".into());
        let pts = got.lock().unwrap();
        assert_eq!(
            *pts,
            vec![0, 125_000, 250_000, 375_000, 500_000],
            "one request must deliver exactly the horizon"
        );
    }

    #[test]
    fn backward_request_reseeks_and_redelivers() {
        // The continuation must not swallow a backward scrub: a target behind the
        // last one re-seeks, and the earlier frames are delivered AGAIN (the
        // consumer's ring has evicted them by then — that is why it asked).
        let got: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let g2 = got.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| {
            if let SwFramePoke::Frame { frame, .. } = poke {
                g2.lock().unwrap().push(frame.pts_us);
            }
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("bw1".into(), p.into()).expect("open");
        let _ = reg.request_frame_at("bw1".into(), 750_000);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let after_forward = got.lock().unwrap().len();
        let _ = reg.request_frame_at("bw1".into(), 0);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = reg.close("bw1".into());
        let pts = got.lock().unwrap();
        assert_eq!(
            pts[..after_forward].first().copied(),
            Some(750_000),
            "forward request should start at its target: {pts:?}"
        );
        assert_eq!(
            pts.get(after_forward).copied(),
            Some(0),
            "backward request must re-seek and re-deliver from 0: {pts:?}"
        );
    }

    #[test]
    fn ticking_past_eof_stays_quiet() {
        // Past the end of the material the renderer keeps ticking (it has no eof
        // signal on this transport). Each of those ticks used to re-seek, re-walk
        // the tail and re-emit the final frame; now the drained cursor absorbs
        // them — one Eof, and no repeat of the last frame.
        let frames: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let eofs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let f2 = frames.clone();
        let e2 = eofs.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| match poke {
            SwFramePoke::Frame { frame, .. } => f2.lock().unwrap().push(frame.pts_us),
            SwFramePoke::Eof { .. } => {
                e2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            SwFramePoke::Error { .. } => {}
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("eof1".into(), p.into()).expect("open");
        // 875_000 is the last frame of the 1 s fixture; the three ticks after it
        // are past the material.
        for t in [875_000, 908_000, 941_000, 974_000] {
            let _ = reg.request_frame_at("eof1".into(), t);
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        let _ = reg.close("eof1".into());
        let pts = frames.lock().unwrap();
        assert_eq!(*pts, vec![875_000], "the tail frame was re-delivered: {pts:?}");
        assert_eq!(
            eofs.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "each post-eof tick re-discovered eof instead of short-circuiting"
        );
    }

    #[test]
    fn far_past_eof_ticks_do_not_reseek() {
        // A target FURTHER than FORWARD_CONTINUE_US past the material (a
        // playhead parked way past a short clip): the seek lands at the tail
        // and EOF is rediscovered — once. Before the EOF arms advanced the
        // frontier, the gap to the stale frontier failed the forward test on
        // EVERY subsequent tick, so each one paid a fresh seek+flush+probe and
        // emitted another Eof poke, forever.
        let frames: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(vec![]));
        let eofs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let f2 = frames.clone();
        let e2 = eofs.clone();
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(move |poke| match poke {
            SwFramePoke::Frame { frame, .. } => f2.lock().unwrap().push(frame.pts_us),
            SwFramePoke::Eof { .. } => {
                e2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            SwFramePoke::Error { .. } => {}
        }));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("feof1".into(), p.into()).expect("open");
        // The fixture is 1 s; 5 s is > FORWARD_CONTINUE_US past its tail, and
        // the tail frame itself is past-discarded — the request yields only an
        // Eof poke. The +33 ms ticks after it stay within the continue window
        // of the advanced frontier, so the drained cursor must absorb them.
        for t in [5_000_000, 5_033_000, 5_066_000, 5_099_000] {
            let _ = reg.request_frame_at("feof1".into(), t);
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        let _ = reg.close("feof1".into());
        let pts = frames.lock().unwrap();
        assert!(
            pts.is_empty(),
            "a far-past-EOF target must deliver no frames: {pts:?}"
        );
        assert_eq!(
            eofs.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "each far-past-eof tick re-seeked and re-discovered eof instead of going quiet"
        );
    }

    #[test]
    fn wedged_thread_close_detaches_within_grace_and_id_reopens() {
        // The dump-verified hang shape: a thread stuck INSIDE one decode call
        // sees neither the flag nor the channel. close() must give up at the
        // grace bound and detach — never propagate an unbounded join to the
        // napi caller.
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(|_| {}));
        reg.open_wedged_for_test("w1", std::time::Duration::from_secs(10));
        let start = std::time::Instant::now();
        let outcome = reg
            .close_with_grace("w1", std::time::Duration::from_millis(250))
            .expect("close must return Ok on the detach path");
        let elapsed = start.elapsed();
        assert_eq!(outcome, CloseOutcome::Detached);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "close() took {elapsed:?}; it must be bounded by the grace, not the wedge"
        );
        // Reuse safety: the map entry went with close(), so the same id opens
        // fresh while the detached straggler is still sleeping.
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("w1".into(), p.into())
            .expect("re-open of a detached id must succeed");
        reg.close("w1".into()).expect("close the re-opened session");
    }

    #[test]
    fn normal_close_reaps_the_thread() {
        // Healthy-path close must NOT detach: the done signal (sender drop in
        // the thread's closure frame) fires within the grace, so the thread is
        // joined and nothing lingers.
        let reg = PreviewSwRegistry::new();
        reg.set_frame_sink(Box::new(|_| {}));
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        reg.open("r1".into(), p.into()).expect("open");
        let _ = reg.request_frame_at("r1".into(), 0);
        let outcome = reg
            .close_with_grace("r1".into(), CLOSE_GRACE)
            .expect("close");
        assert_eq!(outcome, CloseOutcome::Reaped);
    }
}
