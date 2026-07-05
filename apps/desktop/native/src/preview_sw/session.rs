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
//! Thread ownership: [`SwVideoStream`] is `!Send`-in-spirit (raw ffmpeg pointers;
//! Task 2 marks it `Send` forward-compat) but it is created, driven, and dropped
//! entirely on the session thread and never crosses a boundary, so that mark is
//! never exercised here. Only plain `Send` data crosses: the command `Receiver`,
//! the sink `Arc`, the path/id strings in, and the pokes out.
//!
//! Like `decoder.rs`, this is a surface defined ahead of its consumer: Task 4
//! wires the registry + sink to the napi addon, so until then the public API is
//! `dead_code` from the plain-lib build's view (the unit test exercises it).
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use super::decoder::{SwFrame, SwVideoStream};

/// How many frames a single `request_frame_at` decodes forward past the seek
/// target before returning to the mailbox. A "handful" so a scrub pre-buffers a
/// little smoothness without decode-and-discarding a long tail; kept small so a
/// rapid re-scrub isn't stuck finishing a stale burst (the next `RequestFrameAt`
/// is already queued and serviced right after). ProRes/DNxHD are intra-only, so
/// the first decoded frame after the seek IS at/just-before the target.
const LOOKAHEAD_FRAMES: usize = 4;

/// What `open` hands back once the session thread has opened its decoder: the
/// stream's frame dimensions. Built from `SwVideoStream`'s public `width`/`height`
/// fields (set at open) — no frame is decoded just to learn them. Task 4 maps this
/// to a `#[napi(object)]`.
#[derive(Debug, Clone, Copy)]
pub struct PreviewSwOpenInfo {
    pub width: u32,
    pub height: u32,
}

/// Announced out of a session thread through the shared sink. `Send` (its only
/// payload is the owned [`SwFrame`] + plain strings) so Task 4 can forward it to
/// the addon's event channel. Every variant carries `stream_id` so a single sink
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
/// call so concurrent sessions serialise (Task 4's sink is a non-blocking event
/// enqueue, so this can't deadlock or stall).
fn emit(sink: &FrameSink, poke: SwFramePoke) {
    let guard = sink.lock().unwrap();
    if let Some(f) = guard.as_ref() {
        f(poke);
    }
}

/// Service one `request_frame_at`: seek to the keyframe at/before `target_us`,
/// then decode up to [`LOOKAHEAD_FRAMES`] frames forward, poking each. Stops early
/// on EOF (an `Eof` poke) or a decode error (an `Error` poke). A seek failure is
/// reported as `Error` and skips the burst — the session stays open for retry.
fn serve_request(stream: &mut SwVideoStream, target_us: i64, sink: &FrameSink, stream_id: &str) {
    if let Err(e) = stream.seek(target_us) {
        emit(
            sink,
            SwFramePoke::Error {
                stream_id: stream_id.to_string(),
                message: format!("seek to {target_us}us failed: {e}"),
            },
        );
        return;
    }
    for _ in 0..LOOKAHEAD_FRAMES {
        match stream.next_frame() {
            Ok(Some(frame)) => emit(
                sink,
                SwFramePoke::Frame {
                    stream_id: stream_id.to_string(),
                    frame,
                },
            ),
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
    rx: Receiver<SwSessionMsg>,
    init_tx: Sender<Result<PreviewSwOpenInfo, String>>,
    sink: FrameSink,
) {
    let mut stream = match SwVideoStream::open(&path) {
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

/// The set of live software preview sessions. `Send + Sync`, so Task 4 can hold it
/// in the addon (e.g. behind an `Arc`) and drive it from napi calls.
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

    /// Install the sink every session emits pokes through. Set once by Task 4
    /// before any `open`; sessions share the same cell, so a later set is seen by
    /// already-running threads too.
    pub fn set_frame_sink(&self, sink: Box<dyn Fn(SwFramePoke) + Send>) {
        *self.sink.lock().unwrap() = Some(sink);
    }

    /// Open `path` for software preview: spawn its decode thread and hand back the
    /// frame dimensions once the thread reports ready. Blocks on the init
    /// handshake so a decoder-open failure surfaces synchronously.
    pub fn open(&self, stream_id: &str, path: &str) -> Result<PreviewSwOpenInfo, String> {
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
            .spawn(move || session_thread(sid, path_owned, cmd_rx, init_tx, sink))
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
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
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
        assert!(frames[0].1 >= 0, "expected pts_us >= 0, got {}", frames[0].1);
    }
}
