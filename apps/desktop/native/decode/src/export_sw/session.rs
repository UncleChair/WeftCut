//! Per-source export-decode session thread + registry + credit window.
//!
//! Owns: a dedicated OS thread per session that opens a
//! [`SwVideoStream`](crate::preview_sw::decoder::SwVideoStream), services
//! `decode_range` commands posted over an mpsc channel, and ships owned
//! [`SwFrame`] bytes (NV12 or I420P10, per the session's [`ExportOutFormat`])
//! out through a shared sink one credit at a time. The reorder,
//! GOP walk, and EOS drain are the decoder's; the coverage/continuation contract
//! is [`serve_range`]; the flow-control contract is [`CreditWindow`].
//!
//! Does NOT own the decode surface (`preview_sw::decoder`) or any VideoFrame
//! pool. See the export-decode engine spec, decisions 3/6, for why this contract
//! differs from the preview path.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

use crate::preview_sw::decoder::{SwColorTags, SwFrame, SwOutFormat, SwVideoStream};
use crate::recover::{panic_message, LockExt};

/// Default credits (frames in flight) when a caller does not specify one. The
/// spec's ~4–8 window: bounds a 4K 10-bit export's main-process frame memory to
/// ~100–200 MB while keeping the decoder far enough ahead of the encoder that it
/// never idles between chunks.
pub const DEFAULT_CREDIT_WINDOW: u32 = 6;

/// Largest number of backward re-seek attempts when a container's seek overshoots
/// the target. Index-less MPEG-PS/TS estimate the seek byte-offset and can land
/// AFTER the requested time; each retry steps the target back by a growing
/// margin. The final fallback (seek target 0) decodes from the start — always a
/// valid at-or-before landing. Mirrors `preview_sw::session::serve_request`.
const MAX_SEEK_RETRIES: u32 = 6;
/// Initial backward step when re-seeking after an overshoot; doubles each retry.
const SEEK_RETRY_MARGIN_US: i64 = 1_000_000;

/// The pixel format a session emits (8-bit NV12 or 10-bit I420P10 — layouts on
/// [`SwOutFormat`]); `parse` rejects any other requested format at `open` so a
/// caller never receives silently wrong-format output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportOutFormat {
    Nv12,
    I420p10,
}

impl ExportOutFormat {
    /// Parse the caller's requested output-format tag (case-insensitive on the
    /// canonical name). Anything the software lane cannot emit is an error
    /// carrying the offending string, so `open` fails loudly and names the format
    /// it could not produce.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_uppercase().as_str() {
            "NV12" => Ok(ExportOutFormat::Nv12),
            "I420P10" => Ok(ExportOutFormat::I420p10),
            other => Err(format!("unsupported export output format '{other}'")),
        }
    }

    /// The decoder-level target this session format packs into.
    fn decoder_format(self) -> SwOutFormat {
        match self {
            ExportOutFormat::Nv12 => SwOutFormat::Nv12,
            ExportOutFormat::I420p10 => SwOutFormat::I420p10,
        }
    }
}

/// What `open` hands back once the session thread has opened its decoder: the
/// stream's frame dimensions, color tags, and source-normalized start PTS. Built
/// from `SwVideoStream`'s public fields (set at open) — no frame is decoded just
/// to learn them.
#[derive(Debug, Clone)]
pub struct ExportSwOpenInfo {
    pub width: u32,
    pub height: u32,
    pub color: SwColorTags,
    /// The container's first-packet PTS in source-normalized microseconds (the
    /// offset `pts_to_source_us` subtracts). 0 for a stream that starts at t=0.
    pub start_pts_us: i64,
}

/// Announced out of a session thread through the shared sink. `Send` (its only
/// payload is the owned [`SwFrame`] + plain strings). Every variant carries
/// `session_id` so a single sink routes to the right per-session callback.
pub enum ExportPoke {
    /// A decoded in-range frame: owned bytes + timing/color, layout tagged by
    /// `frame.format`.
    Frame { session_id: String, frame: SwFrame },
    /// The current `decode_range` has emitted every frame intersecting its
    /// `[a, b]`; the range is satisfied. Fired once per completed range (also
    /// for a zero-frame already-covered range).
    RangeEnd { session_id: String },
    /// The stream reached its end during a range: the final GOP's trailing frames
    /// were flushed internally (no external "next key" needed) and delivered
    /// before this signal. A subsequent backward range re-arms decoding.
    Ended { session_id: String },
    /// A decode/seek failure while serving a range. The session stays registered
    /// and can be retried with another `decode_range` (or a backward re-seek).
    Error { session_id: String, message: String },
}

/// Boxed sink shared with every session thread. `Mutex<Box<dyn Fn + Send>>` is
/// `Send + Sync`, so an `Arc` clones into each thread and the mutex serialises
/// concurrent sessions' calls. Mirrors `preview_sw`'s `FrameSink`.
type ExportSink = Arc<Mutex<Option<Box<dyn Fn(ExportPoke) + Send>>>>;

fn emit(sink: &ExportSink, poke: ExportPoke) {
    let guard = sink.lock_recover();
    if let Some(f) = guard.as_ref() {
        f(poke);
    }
}

// ── credit window ────────────────────────────────────────────────────────────

struct CreditInner {
    credits: i64,
    closed: bool,
}

/// A counting semaphore bounding frames in flight. The producer thread
/// `acquire`s one credit per emitted frame (parking when none remain); the
/// consumer `release`s credits as it takes frames. `close` unblocks a parked
/// producer for teardown.
struct CreditWindow {
    lock: Mutex<CreditInner>,
    cv: Condvar,
}

impl CreditWindow {
    fn new(window: u32) -> Self {
        Self {
            lock: Mutex::new(CreditInner {
                credits: window.max(1) as i64,
                closed: false,
            }),
            cv: Condvar::new(),
        }
    }

    /// Take one credit, parking while none are available. Returns `false` if the
    /// window was closed while waiting (or already) — the caller must abandon the
    /// range rather than emit.
    fn acquire(&self) -> bool {
        let mut st = self.lock.lock_recover();
        while st.credits <= 0 && !st.closed {
            st = self.cv.wait(st).unwrap_or_else(|p| p.into_inner());
        }
        if st.closed {
            return false;
        }
        st.credits -= 1;
        true
    }

    /// Return `n` consumed credits, waking a parked producer.
    fn release(&self, n: u32) {
        let mut st = self.lock.lock_recover();
        st.credits += n as i64;
        drop(st);
        self.cv.notify_all();
    }

    /// Mark closed and wake any parked producer so it can exit.
    fn close(&self) {
        let mut st = self.lock.lock_recover();
        st.closed = true;
        drop(st);
        self.cv.notify_all();
    }
}

// ── session thread ───────────────────────────────────────────────────────────

/// Control messages posted to a session thread. Credit returns do NOT travel
/// here — they hit the shared [`CreditWindow`] directly, so they can unblock a
/// producer parked mid-range while this FIFO channel is busy.
enum ExportMsg {
    DecodeRange(i64, i64),
    Close,
}

/// The registry's per-session handle: the command channel, the shared credit
/// window (so `return_credit` can reach it without a message), and the join
/// handle. The decoder itself lives on the thread, never here.
struct Session {
    tx: Sender<ExportMsg>,
    credit: Arc<CreditWindow>,
    join: Option<JoinHandle<()>>,
}

/// Per-thread cursor state carried across `decode_range` calls. Owned by the
/// session thread; never crosses a boundary.
#[derive(Default)]
struct RangeState {
    /// A frame decoded past the previous range's `b`, held so a forward
    /// continuation resumes on it instead of re-feeding the stream prefix.
    pending: Option<SwFrame>,
    /// `a` of the last serviced range; a range with `a >= last_range_a` is a
    /// forward continuation, otherwise a backward re-seek.
    last_range_a: Option<i64>,
    /// Largest presentation `pts_us` delivered so far; lets a forward range whose
    /// `b` is fully behind us short-circuit without re-decoding.
    covered_through_us: i64,
    /// EOS reached and not yet re-armed by a backward seek.
    ended: bool,
}

impl RangeState {
    fn new() -> Self {
        Self {
            covered_through_us: i64::MIN,
            ..Default::default()
        }
    }
}

/// Robust seek: land on a keyframe AT/BEFORE `target_us` and return the first
/// decoded frame there (the initial candidate for the forward scan), re-seeking
/// earlier with a growing margin if an index-less container overshoots. Returns
/// `Ok(None)` if the seek landed at EOF. Mirrors `preview_sw`'s inline retry.
fn robust_seek_and_probe(
    stream: &mut SwVideoStream,
    target_us: i64,
) -> Result<Option<SwFrame>, String> {
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    loop {
        stream
            .seek(seek_target)
            .map_err(|e| format!("seek to {seek_target}us failed: {e}"))?;
        match stream.next_frame()? {
            Some(f) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
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

/// Service one `decode_range(a, b)`: deliver every frame whose presentation
/// interval `[pts, pts+dur)` intersects `[a, b]` (b inclusive — matches the
/// WebCodecs `ExportFrameStore` half-open containment + `pts <= bUs` feed
/// cutoff), exactly once, in presentation order, throttled through the credit
/// window.
///
/// Coverage is a plain forward scan because `next_frame` already yields
/// presentation order (monotonic `pts_us`): seek to the GOP key at/before `a`,
/// skip frames ending at/before `a` (decoded only as references), emit through
/// `b`, then STOP at the first frame past `b` — no stop-key packet bookkeeping,
/// no mid-flush. A range is a *forward* continuation when `a >= last_range_a`,
/// resuming on the previous range's stopped-on frame ([`RangeState::pending`])
/// with no prefix re-feed; otherwise (backward clip-reuse jump) it re-seeks.
fn serve_range(
    stream: &mut SwVideoStream,
    state: &mut RangeState,
    credit: &CreditWindow,
    sink: &ExportSink,
    session_id: &str,
    a: i64,
    b: i64,
) {
    let forward = state.last_range_a.is_some_and(|la| a >= la);

    // Forward past a drained stream, or fully behind what we've already emitted:
    // nothing to decode, the range is trivially satisfied.
    if forward && (state.ended || b < state.covered_through_us) {
        emit(
            sink,
            ExportPoke::RangeEnd {
                session_id: session_id.to_string(),
            },
        );
        return;
    }

    // Backward jump (or first range): re-seek to the GOP key at/before `a` and
    // arm the scan on the landing frame. A forward range keeps `pending`.
    if !forward {
        match robust_seek_and_probe(stream, a) {
            Ok(landing) => {
                state.pending = landing;
                state.ended = false;
                // The high-water mark no longer means "everything below was
                // delivered" once the cursor jumps back: keeping it would let a
                // later forward range whose [a, b] was never covered short-circuit
                // as trivially satisfied and deliver nothing. Mirrors the WebCodecs
                // handle's rebuild resetting `coveredThroughUs`.
                state.covered_through_us = i64::MIN;
            }
            Err(e) => {
                emit(
                    sink,
                    ExportPoke::Error {
                        session_id: session_id.to_string(),
                        message: e,
                    },
                );
                return;
            }
        }
    }
    state.last_range_a = Some(a);

    loop {
        let frame = match state.pending.take() {
            Some(f) => f,
            None => match stream.next_frame() {
                Ok(Some(f)) => f,
                Ok(None) => {
                    // Internal EOS: the final GOP's trailing frames have already
                    // been drained + delivered above. Signal end-of-stream, then
                    // close the range.
                    state.ended = true;
                    emit(
                        sink,
                        ExportPoke::Ended {
                            session_id: session_id.to_string(),
                        },
                    );
                    emit(
                        sink,
                        ExportPoke::RangeEnd {
                            session_id: session_id.to_string(),
                        },
                    );
                    return;
                }
                Err(e) => {
                    emit(
                        sink,
                        ExportPoke::Error {
                            session_id: session_id.to_string(),
                            message: e,
                        },
                    );
                    return;
                }
            },
        };

        // Past the range end. Presentation order is monotonic, so no later frame
        // can re-enter `[a, b]`: stash this frame for the next forward range and
        // finish. (`>` not `>=`: a frame starting exactly at `b` still intersects
        // the inclusive range and must be delivered.)
        if frame.pts_us > b {
            state.pending = Some(frame);
            emit(
                sink,
                ExportPoke::RangeEnd {
                    session_id: session_id.to_string(),
                },
            );
            return;
        }

        // Entirely before the range start: decoded only as a reference for later
        // frames, not part of `[a, b]`. `.max(1)` guards a 0/unknown duration so a
        // frame at pts ≈ a is never mis-skipped.
        if frame.pts_us + frame.dur_us.max(1) <= a {
            continue;
        }

        // In range. Gate on a credit BEFORE emitting so in-flight frames never
        // exceed the window; a closed window means teardown — abandon silently.
        if !credit.acquire() {
            return;
        }
        if frame.pts_us > state.covered_through_us {
            state.covered_through_us = frame.pts_us;
        }
        emit(
            sink,
            ExportPoke::Frame {
                session_id: session_id.to_string(),
                frame,
            },
        );
    }
}

/// The session thread body: open the decoder targeting the session's parsed
/// output format, report metadata back to `open`, then run a blocking message
/// loop until `Close` (or the sender drops).
fn session_thread(
    session_id: String,
    path: String,
    out_format: ExportOutFormat,
    credit: Arc<CreditWindow>,
    rx: Receiver<ExportMsg>,
    init_tx: Sender<Result<ExportSwOpenInfo, String>>,
    sink: ExportSink,
) {
    let mut stream = match SwVideoStream::open_with_format(&path, out_format.decoder_format()) {
        Ok(s) => s,
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return;
        }
    };
    let info = ExportSwOpenInfo {
        width: stream.width,
        height: stream.height,
        color: stream.color.clone(),
        start_pts_us: stream.start_pts_us,
    };
    if init_tx.send(Ok(info)).is_err() {
        return; // `open` gave up waiting; drop `stream` and exit.
    }

    let mut state = RangeState::new();
    while let Ok(msg) = rx.recv() {
        match msg {
            ExportMsg::DecodeRange(a, b) => {
                // A panic in the ffmpeg decode path must not silently kill this
                // thread and strand the export Worker on frames that never arrive.
                // Catch it, surface it in-band as an `Error` message (so JS fails
                // the range / tears the session down), then stop: the stream's
                // libav state is suspect after an unwind, so we never touch it or
                // `state` again — which is what makes the `AssertUnwindSafe`
                // (needed for the `&mut stream` / `&mut state` captures) sound.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    serve_range(&mut stream, &mut state, &credit, &sink, &session_id, a, b)
                }));
                if let Err(payload) = outcome {
                    emit(
                        &sink,
                        ExportPoke::Error {
                            session_id: session_id.clone(),
                            message: format!(
                                "export-sw decode panicked: {}",
                                panic_message(&*payload)
                            ),
                        },
                    );
                    break;
                }
            }
            ExportMsg::Close => break,
        }
    }
    // `stream` drops here: the decoder + format context release on this thread.
}

// ── registry ─────────────────────────────────────────────────────────────────

/// The set of live export software-decode sessions. `Send + Sync`, so the addon
/// can hold it behind an `Arc` and drive it from napi calls.
pub struct ExportSwRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    sink: ExportSink,
}

impl Default for ExportSwRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ExportSwRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sink: Arc::new(Mutex::new(None)),
        }
    }

    /// Install the sink every session emits pokes through. Set once before any
    /// `open`; sessions share the same cell.
    pub fn set_sink(&self, sink: Box<dyn Fn(ExportPoke) + Send>) {
        *self.sink.lock_recover() = Some(sink);
    }

    /// Open `path` for export decode into `out_format`, with a credit window of
    /// `credit_window` frames. Fails loudly (before returning) if the requested
    /// format cannot be emitted or the decoder cannot open. Blocks on the init
    /// handshake so a decoder-open failure surfaces synchronously with metadata.
    pub fn open(
        &self,
        session_id: &str,
        path: &str,
        out_format: &str,
        credit_window: u32,
    ) -> Result<ExportSwOpenInfo, String> {
        // Validate the requested format FIRST — a format the session can't emit
        // must fail at open, before any thread or decoder work.
        let fmt = ExportOutFormat::parse(out_format)?;

        let mut sessions = self.sessions.lock_recover();
        if sessions.contains_key(session_id) {
            return Err(format!("export-sw session '{session_id}' is already open"));
        }

        let (init_tx, init_rx) = mpsc::channel::<Result<ExportSwOpenInfo, String>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<ExportMsg>();
        let credit = Arc::new(CreditWindow::new(credit_window));
        let credit_for_thread = Arc::clone(&credit);
        let sink = Arc::clone(&self.sink);
        let sid = session_id.to_string();
        let path_owned = path.to_string();

        let join = thread::Builder::new()
            .name(format!("export-sw-{sid}"))
            .spawn(move || {
                session_thread(
                    sid,
                    path_owned,
                    fmt,
                    credit_for_thread,
                    cmd_rx,
                    init_tx,
                    sink,
                )
            })
            .map_err(|e| format!("spawn export-sw session thread failed: {e}"))?;

        match init_rx.recv() {
            Ok(Ok(info)) => {
                sessions.insert(
                    session_id.to_string(),
                    Session {
                        tx: cmd_tx,
                        credit,
                        join: Some(join),
                    },
                );
                Ok(info)
            }
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                let _ = join.join();
                Err(format!(
                    "export-sw session '{session_id}' thread exited before init"
                ))
            }
        }
    }

    /// Ask a session to decode `[a_us, b_us]`. Fire-and-forget: the thread seeks/
    /// decodes and pokes frames + a `RangeEnd` (or `Ended`) out through the sink.
    pub fn decode_range(&self, session_id: &str, a_us: i64, b_us: i64) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("no export-sw session '{session_id}'"))?;
        session
            .tx
            .send(ExportMsg::DecodeRange(a_us, b_us))
            .map_err(|_| format!("export-sw session '{session_id}' thread is gone"))
    }

    /// Return `n` consumed credits to a session, resuming a producer parked on an
    /// exhausted window. Reaches the credit window directly (not via the command
    /// channel) so it works even while the thread is mid-range.
    pub fn return_credit(&self, session_id: &str, n: u32) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("no export-sw session '{session_id}'"))?;
        session.credit.release(n);
        Ok(())
    }

    /// Tear down a session: close the credit window FIRST (so a producer parked in
    /// `acquire` wakes and abandons its range) and signal + join the thread. The
    /// FIFO channel guarantees any range sent before this is drained (as a no-op
    /// once closed) before the thread sees `Close`.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let mut session = {
            let mut sessions = self.sessions.lock_recover();
            sessions.remove(session_id)
        };
        match session.as_mut() {
            Some(s) => {
                s.credit.close();
                let _ = s.tx.send(ExportMsg::Close);
                if let Some(join) = s.join.take() {
                    join.join().map_err(|_| {
                        format!("export-sw session '{session_id}' thread panicked during teardown")
                    })?;
                }
                Ok(())
            }
            None => Err(format!("no export-sw session '{session_id}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const PRORES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/tiny_prores.mov"
    );
    const MPEG2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_mpeg2.mpg");

    /// Collects every poke a registry emits, tagged, so tests can assert the
    /// frame PTS sequence, per-frame format/bytes, and the control markers.
    #[derive(Default)]
    struct Collected {
        pts: Vec<i64>,
        durs: Vec<i64>,
        colors: Vec<SwColorTags>,
        formats: Vec<SwOutFormat>,
        datas: Vec<Vec<u8>>,
        range_ends: usize,
        ended: usize,
        errors: Vec<String>,
    }

    fn registry_with_collector() -> (ExportSwRegistry, Arc<Mutex<Collected>>) {
        let got = Arc::new(Mutex::new(Collected::default()));
        let g2 = got.clone();
        let reg = ExportSwRegistry::new();
        reg.set_sink(Box::new(move |poke| {
            let mut c = g2.lock().unwrap();
            match poke {
                ExportPoke::Frame { frame, .. } => {
                    c.pts.push(frame.pts_us);
                    c.durs.push(frame.dur_us);
                    c.colors.push(frame.color.clone());
                    c.formats.push(frame.format);
                    c.datas.push(frame.data);
                }
                ExportPoke::RangeEnd { .. } => c.range_ends += 1,
                ExportPoke::Ended { .. } => c.ended += 1,
                ExportPoke::Error { message, .. } => c.errors.push(message),
            }
        }));
        (reg, got)
    }

    /// Total control markers seen (range ends + stream ends). Read with a SINGLE
    /// lock — reading two fields off two `got.lock()` calls in one expression
    /// would hold both non-reentrant guards at once and self-deadlock.
    fn markers(got: &Arc<Mutex<Collected>>) -> usize {
        let c = got.lock().unwrap();
        c.range_ends + c.ended
    }

    /// Drive a range and return credits generously so the producer never parks,
    /// then wait until a RangeEnd (or Ended) lands or the deadline passes.
    fn run_range(reg: &ExportSwRegistry, id: &str, a: i64, b: i64, got: &Arc<Mutex<Collected>>) {
        let ends_before = markers(got);
        reg.decode_range(id, a, b).unwrap();
        for _ in 0..200 {
            reg.return_credit(id, 64).unwrap();
            if markers(got) > ends_before {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn open_returns_dimensions_color_and_start_pts() {
        let (reg, _got) = registry_with_collector();
        let info = reg
            .open("s", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .expect("open");
        assert_eq!((info.width, info.height), (320, 240));
        // ProRes fixture is color_range=tv; matrix/primaries/transfer unspecified.
        assert_eq!(info.color.range.as_deref(), Some("tv"));
        assert_eq!(info.start_pts_us, 0);
        reg.close("s").unwrap();
    }

    #[test]
    fn open_accepts_i420p10_and_rejects_garbage_loudly() {
        let (reg, _got) = registry_with_collector();
        let err = reg
            .open("s", PRORES, "RGBA64", DEFAULT_CREDIT_WINDOW)
            .unwrap_err();
        assert!(
            err.contains("RGBA64"),
            "error should name the format: {err}"
        );
        // 10-bit is a first-class lane output.
        reg.open("s", PRORES, "I420P10", DEFAULT_CREDIT_WINDOW)
            .expect("I420P10 opens");
        reg.close("s").unwrap();
    }

    #[test]
    fn i420p10_range_from_tenbit_source_preserves_tenbit_samples() {
        // ProRes fixture decodes to yuv422p10le: real 10-bit samples in, so the
        // packed output must show >8-bit code values — an 8-bit-quantized path
        // caps every u16 sample at 255, while even 10-bit limited-range BLACK
        // is 256 (and white ~940).
        let (reg, got) = registry_with_collector();
        let info = reg
            .open("p", PRORES, "I420P10", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        assert_eq!((info.width, info.height), (320, 240)); // even dims → w*h*3 bytes
        run_range(&reg, "p", 0, 300_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(!c.datas.is_empty(), "no frames delivered");
        assert!(
            c.formats.iter().all(|&f| f == SwOutFormat::I420p10),
            "poke-level format tag"
        );
        assert_eq!(
            c.colors[0].range.as_deref(),
            Some("tv"),
            "color tags still carried"
        );
        let y_bytes = 320 * 240 * 2;
        let mut luma_above_8bit = false;
        for d in &c.datas {
            assert_eq!(d.len(), 320 * 240 * 3, "tightly-packed I420P10 length");
            for (i, s) in d.chunks_exact(2).enumerate() {
                let v = u16::from_le_bytes([s[0], s[1]]);
                assert!(v <= 1023, "sample {i} = {v} exceeds the 10-bit range");
                if i * 2 < y_bytes && v > 255 {
                    luma_above_8bit = true;
                }
            }
        }
        assert!(
            luma_above_8bit,
            "no luma sample above 255 — output looks 8-bit-quantized"
        );
        drop(c);
        reg.close("p").unwrap();
    }

    #[test]
    fn i420p10_upconverts_an_8bit_source() {
        // MPEG-2 decodes to 8-bit yuv420p; the lane still emits I420P10
        // (swscale 8→10 upconvert) so a mixed-depth timeline needs no
        // per-source format branch downstream.
        let (reg, got) = registry_with_collector();
        let info = reg
            .open("m", MPEG2, "I420P10", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        assert_eq!((info.width, info.height), (320, 240));
        run_range(&reg, "m", 0, 200_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(!c.datas.is_empty(), "no frames delivered");
        assert!(
            c.formats.iter().all(|&f| f == SwOutFormat::I420p10),
            "poke-level format tag"
        );
        for d in &c.datas {
            assert_eq!(d.len(), 320 * 240 * 3, "tightly-packed I420P10 length");
            let mut max = 0u16;
            for s in d.chunks_exact(2) {
                let v = u16::from_le_bytes([s[0], s[1]]);
                assert!(v <= 1023, "upconverted sample {v} exceeds the 10-bit range");
                max = max.max(v);
            }
            // 8-bit values scale x4 into the 10-bit range — an all-zero (or
            // still-8-bit) buffer must not pass.
            assert!(
                max > 255,
                "upconvert produced no sample above the 8-bit ceiling (max {max})"
            );
        }
        drop(c);
        reg.close("m").unwrap();
    }

    #[test]
    fn intra_range_covers_exactly_the_intersecting_frames() {
        // ProRes: 8 intra frames at 0,125_000,...,875_000 (dur 125_000). Range
        // [200_000, 500_000] intersects frames at 125_000 (ends 250_000 > a),
        // 250_000, 375_000, and 500_000 (starts at b, inclusive). Not 0 (ends at
        // 125_000 <= a) nor 625_000 (starts past b).
        let (reg, got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg, "p", 200_000, 500_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert_eq!(c.pts, vec![125_000, 250_000, 375_000, 500_000]);
        assert_eq!(c.range_ends, 1);
        drop(c);
        reg.close("p").unwrap();
    }

    #[test]
    fn frames_carry_color_tags() {
        let (reg, got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg, "p", 0, 200_000, &got);
        let c = got.lock().unwrap();
        assert!(!c.colors.is_empty());
        assert_eq!(c.colors[0].range.as_deref(), Some("tv"));
        drop(c);
        reg.close("p").unwrap();
    }

    #[test]
    fn forward_ranges_continue_without_duplicates() {
        // Two contiguous forward ranges over ProRes must partition the frames with
        // no repeats and no gaps: [0,300_000] then [300_001,700_000].
        let (reg, got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg, "p", 0, 300_000, &got);
        run_range(&reg, "p", 300_001, 700_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        // [0,300_000]: 0,125_000,250_000 (375_000 starts past 300_000).
        // [300_001,700_000]: 375_000,500_000,625_000,700_000? 700_000 has no frame;
        //   frames are 375_000,500_000,625_000 (750_000 starts past 700_000).
        assert_eq!(c.pts, vec![0, 125_000, 250_000, 375_000, 500_000, 625_000]);
        // Strictly increasing → no duplicates, presentation order preserved.
        assert!(c.pts.windows(2).all(|w| w[0] < w[1]));
        drop(c);
        reg.close("p").unwrap();
    }

    #[test]
    fn backward_range_reseeks_and_reemits() {
        let (reg, got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg, "p", 500_000, 875_000, &got);
        let after_fwd = got.lock().unwrap().pts.clone();
        assert_eq!(after_fwd, vec![500_000, 625_000, 750_000, 875_000]);
        // Clip-reuse jump backward: re-seek and re-emit the earlier frames.
        run_range(&reg, "p", 0, 200_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert_eq!(&c.pts[after_fwd.len()..], &[0, 125_000]);
        drop(c);
        reg.close("p").unwrap();
    }

    #[test]
    fn forward_range_after_backward_jump_is_not_falsely_covered() {
        // Regression: `covered_through_us` must reset on a backward re-seek.
        // Without the reset, the third range below sits under the FIRST range's
        // high-water mark (875k), short-circuits as "already covered", and
        // delivers nothing — though [300k, 400k] was never covered by any range.
        let (reg, got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg, "p", 500_000, 875_000, &got); // high-water → 875k
        run_range(&reg, "p", 0, 200_000, &got); // backward jump: coverage resets
        let before = got.lock().unwrap().pts.len();
        run_range(&reg, "p", 300_000, 400_000, &got); // forward, never covered
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        // 250k ([250k,375k) intersects) and 375k ([375k,500k) intersects b=400k).
        assert_eq!(&c.pts[before..], &[250_000, 375_000]);
        drop(c);
        reg.close("p").unwrap();
    }

    #[test]
    fn long_gop_range_delivers_presentation_order_across_bframes() {
        // MPEG-2 IBBP, start_time 0.533s → source-normalized. A range spanning the
        // first two GOPs must deliver monotonically increasing (presentation-order)
        // PTS despite B-frame decode-order reordering, covering the range densely
        // (30fps → ~33_333us spacing).
        let (reg, got) = registry_with_collector();
        reg.open("m", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&reg, "m", 0, 600_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert!(
            c.pts.len() >= 18,
            "expected dense coverage, got {}",
            c.pts.len()
        );
        // Presentation order (the B-frame reorder guarantee).
        assert!(
            c.pts.windows(2).all(|w| w[0] < w[1]),
            "not monotonic: {:?}",
            c.pts
        );
        // First delivered frame is at/near source t=0 (start_pts subtracted).
        assert!(c.pts[0] >= 0 && c.pts[0] < 40_000, "first pts {}", c.pts[0]);
        // Every delivered frame intersects [0, 600_000] (b inclusive).
        assert!(c.pts.iter().all(|&p| p <= 600_000));
        drop(c);
        reg.close("m").unwrap();
    }

    #[test]
    fn long_gop_midstream_range_covers_exactly_the_linear_subset() {
        // The open-GOP case: a window starting INSIDE a later GOP forces a seek to
        // an earlier keyframe and a forward decode whose reference chain must be
        // rebuilt. Exactness is cross-checked against a full LINEAR decode: the
        // mid-stream seek must deliver exactly the frames the linear pass produced
        // in that window (same set, same presentation order) — a dropped, doubled,
        // or mis-timed frame from a botched seek would diverge.
        let (reg, got) = registry_with_collector();
        reg.open("full", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg, "full", 0, 10_000_000, &got);
        let all: Vec<(i64, i64)> = {
            let c = got.lock().unwrap();
            c.pts.iter().copied().zip(c.durs.iter().copied()).collect()
        };
        reg.close("full").unwrap();
        assert_eq!(all.len(), 60);

        let (a, b) = (700_000, 1_100_000);
        let expected: Vec<i64> = all
            .iter()
            .filter(|&&(p, d)| p + d.max(1) > a && p <= b)
            .map(|&(p, _)| p)
            .collect();
        assert!(expected.len() >= 10, "mid-stream window unexpectedly small");

        let (reg2, got2) = registry_with_collector();
        reg2.open("mid", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW)
            .unwrap();
        run_range(&reg2, "mid", a, b, &got2);
        let delivered = {
            let c = got2.lock().unwrap();
            assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
            c.pts.clone()
        };
        reg2.close("mid").unwrap();
        assert_eq!(delivered, expected);
    }

    #[test]
    fn long_gop_backward_range_reseeks_correctly() {
        // A backward clip-reuse jump on a LONG-GOP source (not the trivial intra
        // case): decode a late window, then jump into an earlier GOP. The session
        // must re-seek to an earlier keyframe and deliver the earlier frames in
        // presentation order, covering the new range.
        let (reg, got) = registry_with_collector();
        reg.open("g", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        run_range(&reg, "g", 1_400_000, 1_700_000, &got);
        let before = {
            let c = got.lock().unwrap();
            assert!(c.pts.windows(2).all(|w| w[0] < w[1]), "late not monotonic");
            assert!(c
                .pts
                .iter()
                .all(|&p| p + 33_333 > 1_400_000 && p <= 1_700_000));
            c.pts.len()
        };
        run_range(&reg, "g", 400_000, 700_000, &got);
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        let early = &c.pts[before..];
        assert!(!early.is_empty(), "backward range delivered nothing");
        assert!(
            early.windows(2).all(|w| w[0] < w[1]),
            "backward not monotonic: {early:?}"
        );
        assert!(
            early.iter().all(|&p| p + 33_333 > 400_000 && p <= 700_000),
            "backward frames out of range: {early:?}"
        );
        assert!(
            early[0] < 450_000,
            "first backward frame not near a=400k: {}",
            early[0]
        );
        drop(c);
        reg.close("g").unwrap();
    }

    #[test]
    fn eos_flushes_final_gop_then_signals_end() {
        // A range past the stream end drains the final GOP's trailing frames (no
        // external next-key) and fires exactly one Ended.
        let (reg, got) = registry_with_collector();
        let info = reg.open("m", MPEG2, "NV12", DEFAULT_CREDIT_WINDOW).unwrap();
        assert_eq!((info.width, info.height), (320, 240));
        run_range(&reg, "m", 0, 10_000_000, &got); // b beyond the ~1.97s stream
        let c = got.lock().unwrap();
        assert!(c.errors.is_empty(), "errors: {:?}", c.errors);
        assert_eq!(c.ended, 1, "expected exactly one Ended");
        // All 60 frames delivered, last near the stream end (~1.966s normalized).
        assert_eq!(c.pts.len(), 60, "expected all 60 frames");
        assert!(*c.pts.last().unwrap() > 1_900_000);
        drop(c);
        reg.close("m").unwrap();
    }

    #[test]
    fn credit_window_halts_then_resumes() {
        // With window=3 and NO credits returned beyond the initial fill, the
        // session emits at most 3 frames then parks. Returning credits resumes it.
        let (reg, got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", 3).unwrap();
        reg.decode_range("p", 0, 875_000).unwrap(); // all 8 frames intersect
        thread::sleep(Duration::from_millis(150));
        {
            let c = got.lock().unwrap();
            assert_eq!(c.pts.len(), 3, "window=3 should halt at 3 in flight");
            assert_eq!(c.range_ends, 0, "range not done while parked");
        }
        // Resume: return 2 credits → 2 more frames, then park again at 5 total.
        reg.return_credit("p", 2).unwrap();
        thread::sleep(Duration::from_millis(150));
        {
            let c = got.lock().unwrap();
            assert_eq!(c.pts.len(), 5, "2 credits → 2 more frames");
        }
        // Drain the rest.
        reg.return_credit("p", 64).unwrap();
        thread::sleep(Duration::from_millis(200));
        {
            let c = got.lock().unwrap();
            assert_eq!(c.pts.len(), 8, "all frames after draining credits");
            assert_eq!(c.range_ends, 1);
        }
        reg.close("p").unwrap();
    }

    #[test]
    fn close_unblocks_a_parked_producer() {
        // A session parked on an exhausted credit window must tear down promptly
        // (no deadlock): open tiny window, request a big range, don't return
        // credits, then close — join must complete.
        let (reg, _got) = registry_with_collector();
        reg.open("p", PRORES, "NV12", 1).unwrap();
        reg.decode_range("p", 0, 875_000).unwrap();
        thread::sleep(Duration::from_millis(80));
        // If close hangs, the test harness will time out; a clean return is the
        // assertion.
        reg.close("p").unwrap();
    }

    #[test]
    fn decode_panic_surfaces_as_error_poke_and_leaves_registry_usable() {
        // Mirror of the preview-sw panic test for the export lane. The sink panics
        // on its FIRST call (poisoning the shared sink lock); `serve_range`'s
        // `catch_unwind` must turn that into an in-band `Error` message, and the
        // recovery `emit` must succeed via `lock_recover` on the poisoned lock —
        // otherwise the export Worker strands on frames that never arrive.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let calls2 = calls.clone();
        let errors2 = errors.clone();
        let reg = ExportSwRegistry::new();
        reg.set_sink(Box::new(move |poke| {
            if calls2.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("boom in export-sw sink");
            }
            if let ExportPoke::Error { message, .. } = poke {
                errors2.lock().unwrap().push(message);
            }
        }));
        reg.open("s", PRORES, "NV12", DEFAULT_CREDIT_WINDOW)
            .expect("open");
        reg.decode_range("s", 0, 875_000).unwrap();
        thread::sleep(Duration::from_millis(300));
        let errs = errors.lock().unwrap();
        assert!(
            errs.iter().any(|m| m.contains("panicked")),
            "expected a decode-panic Error poke, got: {errs:?}"
        );
        drop(errs);
        reg.close("s")
            .expect("registry usable after a caught decode panic");
    }
}
