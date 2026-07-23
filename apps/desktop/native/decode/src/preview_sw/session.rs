//! Per-source software-decode session thread + registry.
//!
//! A strict simplification of `preview_gpu/session.rs`. Each preview session owns
//! a dedicated OS thread that opens a [`SwVideoStream`] and runs a
//! DECODE-ON-REQUEST loop: napi-side commands (`request_frame_at` / `close`) post
//! messages over an mpsc channel; decoded frames leave the thread as owned NV12
//! [`SwFramePoke::Frame`] bytes through a shared sink.
//!
//! What this DROPS vs. the GPU mirror (and why): there is no D3D11 anywhere — no
//! shared-texture pool, no keyed mutex, no slot free-list, no `ConsumeAck`
//! round-trip, and none of the decode-bench timing probes. The GPU path needs all
//! of that because a decoded surface is a *borrowed* GPU texture valid only until
//! the next `next_frame`, so the renderer must ack before the slot is reused. Here
//! the frame bytes ARE the payload: [`SwFrame`] is fully owned and `Send`, so it
//! travels through the sink and outlives the stream — no coherence protocol
//! needed, and no background refill pump. One SERVED request = one seek + a
//! small, bounded forward decode burst — but requests are coalesced
//! latest-wins at the loop top: before serving, the thread drains everything
//! already queued, so a scrub storm's superseded targets are dropped unserved
//! (their pokes simply never fire) and only the newest target pays a
//! seek+burst. A drained `Close` wins over any pending request.
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

use super::decoder::{DecodeAccel, SwFrame, SwOutFormat, SwVideoStream};
use crate::recover::{panic_message, LockExt};

/// How many frames a single `request_frame_at` emits, starting at the frame that
/// covers the seek target. A "handful" pre-buffers a little playback smoothness
/// without decode-and-discarding a long tail; kept small so a rapid re-scrub
/// isn't stuck finishing a stale burst. `serve_request` decodes forward from the
/// seek's keyframe to the covering frame first (correct for both intra and
/// long-GOP), then emits up to this many frames.
const LOOKAHEAD_FRAMES: usize = 4;

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
/// stream's frame dimensions. Built from `SwVideoStream`'s public `width`/`height`
/// fields (set at open) — no frame is decoded just to learn them. The addon
/// maps this to a `#[napi(object)]`.
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
    /// A decoded frame, owned NV12 bytes + timing/color. The consumer keeps or
    /// drops it freely — nothing on the session thread references it after this.
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

/// Service one `request_frame_at`: robustly seek to a keyframe at/before
/// `target_us` (re-seeking earlier with a growing margin if an index-less
/// container's BACKWARD seek overshoots), decode forward to the frame that
/// covers `target_us` (discarding earlier frames), then poke that covering
/// frame plus a short forward lookahead (up to [`LOOKAHEAD_FRAMES`] total).
/// Stops early on EOF (an `Eof` poke) or a decode error (an `Error` poke). A
/// seek failure is reported as `Error` and skips the burst — the session
/// stays open for retry. Once `shutdown` is observed set, returns without
/// emitting anything further — no `Error` poke, this is a normal teardown,
/// not a failure.
fn serve_request(
    stream: &mut SwVideoStream,
    target_us: i64,
    sink: &FrameSink,
    stream_id: &str,
    shutdown: &AtomicBool,
) {
    // --- Robust seek: land on a keyframe AT/BEFORE the target ---
    // ffmpeg's BACKWARD seek is only approximate on index-less containers
    // (MPEG-PS/TS): it estimates a byte offset and can overshoot, landing AFTER
    // the target. Probe the first decoded frame; if it's past the target, re-seek
    // earlier with a growing margin until it lands at/before (or we reach the file
    // start, always a valid at-or-before landing). Indexed containers (MOV/MP4)
    // land correctly on the first try — zero retries.
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    let first_frame: SwFrame = loop {
        // Teardown preempts: each seek attempt is itself a seek + decode probe.
        if shutdown.load(Ordering::Acquire) {
            return;
        }
        if let Err(e) = stream.seek(seek_target) {
            emit(
                sink,
                SwFramePoke::Error {
                    stream_id: stream_id.to_string(),
                    message: format!("seek to {seek_target}us failed: {e}"),
                },
            );
            return;
        }
        match stream.next_frame() {
            Ok(Some(f)) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
                    // Overshoot — step the seek target back and retry.
                    seek_target = (target_us - margin).max(0);
                    margin = margin.saturating_mul(2);
                    attempt += 1;
                    continue;
                }
                break f; // landed at/before target (or can't/needn't retry further)
            }
            Ok(None) => {
                emit(
                    sink,
                    SwFramePoke::Eof {
                        stream_id: stream_id.to_string(),
                    },
                );
                return;
            }
            Err(e) => {
                emit(
                    sink,
                    SwFramePoke::Error {
                        stream_id: stream_id.to_string(),
                        message: e,
                    },
                );
                return;
            }
        }
    };

    // --- Forward-decode from the landing to the frame covering target_us, then
    // emit the covering frame + a small forward lookahead. For intra families the
    // landing IS the covering frame (zero discards). The probed `first_frame` is
    // the first candidate, so it is never lost. ---
    let mut emitted = 0usize;
    let mut reached = false;
    let mut pending: Option<SwFrame> = Some(first_frame);
    loop {
        let frame = match pending.take() {
            Some(f) => f,
            None => {
                // Teardown preempts the (potentially slow) decode of the next
                // frame; long-GOP discard loops pass through here every frame.
                if shutdown.load(Ordering::Acquire) {
                    return;
                }
                match stream.next_frame() {
                    Ok(Some(f)) => f,
                    Ok(None) => {
                        emit(
                            sink,
                            SwFramePoke::Eof {
                                stream_id: stream_id.to_string(),
                            },
                        );
                        break;
                    }
                    Err(e) => {
                        emit(
                            sink,
                            SwFramePoke::Error {
                                stream_id: stream_id.to_string(),
                                message: e,
                            },
                        );
                        break;
                    }
                }
            }
        };
        if !reached {
            // A frame whose interval ends at/before the target is in the past.
            // `.max(1)` guards a 0/unknown duration so the covering frame
            // (pts ≈ target) is never skipped.
            if frame.pts_us + frame.dur_us.max(1) <= target_us {
                continue;
            }
            reached = true;
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
        if emitted >= LOOKAHEAD_FRAMES {
            break;
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
    rx: Receiver<SwSessionMsg>,
    init_tx: Sender<Result<PreviewSwOpenInfo, String>>,
    sink: FrameSink,
    shutdown: Arc<AtomicBool>,
) {
    let mut stream = match SwVideoStream::open_with_accel(&path, SwOutFormat::Nv12, accel) {
        Ok(s) => s,
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };
    // Dimensions come from the stream's public fields (set at open) — do NOT
    // decode a frame just to learn them.
    let info = PreviewSwOpenInfo {
        width: stream.width,
        height: stream.height,
    };
    if init_tx.send(Ok(info)).is_err() {
        // `open` gave up waiting; drop `stream` and exit.
        return;
    }

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
            serve_request(&mut stream, target_us, &sink, &stream_id, &shutdown);
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

    /// Open `path` for software preview: spawn its decode thread and hand back the
    /// frame dimensions once the thread reports ready. Blocks on the init
    /// handshake so a decoder-open failure surfaces synchronously. Delegates to
    /// [`open_with_accel`](Self::open_with_accel) on the software lane.
    pub fn open(&self, stream_id: &str, path: &str) -> Result<PreviewSwOpenInfo, String> {
        self.open_with_accel(stream_id, path, DecodeAccel::Software)
    }

    /// Open `path` for preview on `accel` — the software lane (mirrors [`open`]) or
    /// a copy-back hardware lane (`DecodeAccel::Nvdec`/`Vaapi`, issue #5 Block C):
    /// the session thread opens its [`SwVideoStream`] via `open_with_accel` so hw
    /// frames are transferred back to CPU NV12, feeding the SAME frame transport as
    /// software. Blocks on the init handshake so a decoder-open failure (including a
    /// hw device that can't be created) surfaces synchronously and falls back.
    ///
    /// [`open`]: Self::open
    pub fn open_with_accel(
        &self,
        stream_id: &str,
        path: &str,
        accel: DecodeAccel,
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
        // is full FIFO service: each target-0 burst is a real ffmpeg seek +
        // LOOKAHEAD_FRAMES decode (>= hundreds of microseconds), while an mpsc
        // send is sub-microsecond — for EVERY request to be served, the drain
        // would have to find the queue empty N-1 consecutive times against a
        // tight send loop, which the orders-of-magnitude speed gap rules out.
        // So the test asserts the two invariants that hold under every
        // interleaving: (a) the LAST target's burst IS emitted, and (b) at
        // least one intermediate target was skipped (low-pts poke count <
        // LOOKAHEAD_FRAMES * (N-1); strict FIFO would emit exactly that many
        // before the final burst ever runs, since target 0 never hits
        // EOF/error). A test-only seam gating the thread's start would buy
        // exact determinism but needs a wedge inside the message loop —
        // rejected as not trivially small.
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
            low < LOOKAHEAD_FRAMES * (N - 1),
            "all {} superseded requests were served ({low} low-pts pokes); the latest-wins drain is not coalescing",
            N - 1
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
