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
//! needed, and no background refill pump. One request = one seek + a small,
//! bounded forward decode burst.
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
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use super::decoder::{DecodeAccel, SwFrame, SwOutFormat, SwVideoStream};

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
/// this side keeps only the command channel + join handle.
struct Session {
    tx: Sender<SwSessionMsg>,
    /// `Option` so `close` can `take()` it to join exactly once.
    join: Option<JoinHandle<()>>,
}

/// Fire a poke through the shared sink if one is set. The mutex is held across the
/// call so concurrent sessions serialise (the addon's sink is a non-blocking event
/// enqueue, so this can't deadlock or stall).
fn emit(sink: &FrameSink, poke: SwFramePoke) {
    let guard = sink.lock().unwrap();
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
/// stays open for retry.
fn serve_request(stream: &mut SwVideoStream, target_us: i64, sink: &FrameSink, stream_id: &str) {
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
            None => match stream.next_frame() {
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
            },
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
/// `open`, then run a blocking message loop until `Close` (or the sender drops).
///
/// A plain blocking `rx.recv()` is sufficient here (unlike the GPU mirror's
/// `recv_timeout` pump): there is no background slot-refill work to do between
/// messages, so the thread simply sleeps until the next command.
fn session_thread(
    stream_id: String,
    path: String,
    accel: DecodeAccel,
    rx: Receiver<SwSessionMsg>,
    init_tx: Sender<Result<PreviewSwOpenInfo, String>>,
    sink: FrameSink,
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

    while let Ok(msg) = rx.recv() {
        match msg {
            SwSessionMsg::RequestFrameAt(target_us) => {
                serve_request(&mut stream, target_us, &sink, &stream_id);
            }
            SwSessionMsg::Close => break,
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
        *self.sink.lock().unwrap() = Some(sink);
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
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(stream_id) {
            return Err(format!("preview-sw session '{stream_id}' is already open"));
        }

        let (init_tx, init_rx) = mpsc::channel::<Result<PreviewSwOpenInfo, String>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<SwSessionMsg>();
        let sink = Arc::clone(&self.sink);
        let sid = stream_id.to_string();
        let path_owned = path.to_string();

        let join = thread::Builder::new()
            .name(format!("preview-sw-{sid}"))
            .spawn(move || session_thread(sid, path_owned, accel, cmd_rx, init_tx, sink))
            .map_err(|e| format!("spawn preview-sw session thread failed: {e}"))?;

        match init_rx.recv() {
            Ok(Ok(info)) => {
                sessions.insert(
                    stream_id.to_string(),
                    Session {
                        tx: cmd_tx,
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
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-sw session '{stream_id}'"))?;
        session
            .tx
            .send(SwSessionMsg::RequestFrameAt(target_us))
            .map_err(|_| format!("preview-sw session '{stream_id}' thread is gone"))
    }

    /// Signal the session thread to tear down, then join it. Because the command
    /// channel is FIFO, any `request_frame_at` sent before this `close` is fully
    /// serviced (all its pokes fired) before the thread sees `Close` — so a
    /// completed `close` guarantees no in-flight pokes remain. Guards against
    /// double-close / missing id via the map removal.
    pub fn close(&self, stream_id: &str) -> Result<(), String> {
        // Remove from the map (releasing the sessions lock) before joining, so a
        // slow teardown doesn't block registry ops on other sessions.
        let mut session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(stream_id)
        };
        match session.as_mut() {
            Some(s) => {
                // Best-effort: if the thread already exited, the send fails — join
                // reaps it either way.
                let _ = s.tx.send(SwSessionMsg::Close);
                if let Some(join) = s.join.take() {
                    join.join().map_err(|_| {
                        format!("preview-sw session '{stream_id}' thread panicked during teardown")
                    })?;
                }
                Ok(())
            }
            None => Err(format!("no preview-sw session '{stream_id}'")),
        }
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
}
