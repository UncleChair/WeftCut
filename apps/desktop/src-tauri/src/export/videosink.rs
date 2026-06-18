//! Localhost video sink for the 10-bit export. The webview streams raw
//! yuv420p10le frames over a one-shot loopback WebSocket; this module pipes
//! them into an ffmpeg encode (Task 3). `mode: "discard"` byte-counts instead
//! -- the transport spike and the throughput e2e use it. Token = first text
//! message on the socket; anything else closes the connection.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

fn message_kind(m: tungstenite::Message) -> &'static str {
    match m {
        tungstenite::Message::Text(_) => "Text (wrong token)",
        tungstenite::Message::Binary(_) => "Binary",
        tungstenite::Message::Ping(_) => "Ping",
        tungstenite::Message::Pong(_) => "Pong",
        tungstenite::Message::Close(_) => "Close",
        tungstenite::Message::Frame(_) => "Frame",
    }
}

#[derive(Default)]
pub struct VideoSinkState(pub Mutex<Option<ActiveSink>>);

/// Shared between the WS thread, the IPC-fallback write command, and cancel.
pub struct SinkShared {
    /// ffmpeg child (None in discard mode / after wait).
    pub child: Mutex<Option<Child>>,
    /// ffmpeg stdin. WS thread and the IPC write command both write here;
    /// taking it (drop) signals EOF.
    pub stdin: Mutex<Option<ChildStdin>>,
    /// Set after the WS token handshake succeeds — finish() must NOT steal
    /// stdin from a connected WS thread (it would truncate the encode tail).
    pub ws_connected: AtomicBool,
    /// Set by finish()/cancel() — tells the accept loop to wrap up promptly.
    pub finishing: AtomicBool,
    /// Time origin for `last_write_ms` and SinkStats.
    pub t0: Instant,
    /// Millis since `t0` of the last IPC write (liveness for the no-WS path).
    /// Initialized to 0; the deadline logic compares against t0.elapsed() so
    /// a never-writing-worker crash errors ~30s after the connect deadline.
    /// Updated after every successful IPC write (and discard-mode ok path)
    /// so an active IPC stream never trips the staleness check.
    pub last_write_ms: AtomicU64,
    /// IPC-path counters so the fallback's SinkStats are real.
    pub ipc_bytes: AtomicU64,
    pub ipc_frames: AtomicU64,
    /// Rolling tail of ffmpeg stderr (bounded to 8192 chars), appended to
    /// failure messages.
    pub stderr_tail: Mutex<String>,
}

pub struct ActiveSink {
    pub join: Option<JoinHandle<Result<SinkStats, String>>>,
    pub shared: Arc<SinkShared>,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SinkStats {
    pub bytes: u64,
    pub frames: u64,
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSinkStartArgs {
    /// "ws" | "discard" (Task 3 adds full ffmpeg wiring behind both).
    pub mode: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// "hevc" | "av1" -- unused until Task 3.
    pub codec: String,
    pub bitrate: u64,
    pub cbr: bool,
    pub gop: u64,
    pub software: bool,
    pub output_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSinkStartReply {
    pub port: u16,
    pub token: String,
}

fn make_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Milliseconds elapsed since `t0`.
fn now_ms(t0: Instant) -> u64 {
    t0.elapsed().as_millis() as u64
}

/// Build the ffmpeg-stderr suffix appended to error messages (last ≤8 lines).
fn tail_suffix(shared: &SinkShared) -> String {
    let t = shared.stderr_tail.lock().unwrap();
    if t.is_empty() {
        String::new()
    } else {
        let tail: Vec<&str> = t.lines().rev().take(8).collect();
        format!(
            " ffmpeg stderr tail:\n{}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        )
    }
}

/// Kill and reap `shared.child`, ignoring all errors. Fixes both M1
/// (kill-without-reap) and I5 (pre-pump errors leaving ffmpeg alive).
fn abort_child(shared: &SinkShared) {
    if let Some(mut c) = shared.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Accept exactly one WS client, verify the token, then pump binary frames
/// into `shared.stdin` (None => discard). A non-Normal close kills ffmpeg
/// (abort); a Normal close drops stdin (EOF) and waits for ffmpeg to exit.
fn run_ws_sink(
    listener: TcpListener,
    token: String,
    shared: Arc<SinkShared>,
    max_frame_bytes: usize,
) -> Result<SinkStats, String> {
    let t0 = shared.t0;
    let deadline = t0 + Duration::from_secs(30);
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("sink listener: {e}"))?;
    let stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // --- I1/I2/I3: accept-loop rework (single unified branch) ---

                if shared.finishing.load(Ordering::Relaxed) {
                    // I1: finish()/cancel() signalled — reap child and return OK/Err.
                    let child = shared.child.lock().unwrap().take();
                    let status = match child {
                        Some(mut c) => {
                            Some(c.wait().map_err(|e| format!("ffmpeg wait: {e}"))?)
                        }
                        None => None,
                    };
                    if let Some(st) = status {
                        if !st.success() {
                            return Err(format!(
                                "ffmpeg exited {st}{}",
                                tail_suffix(&shared)
                            ));
                        }
                    }
                    return Ok(SinkStats {
                        bytes: shared.ipc_bytes.load(Ordering::Relaxed),
                        frames: shared.ipc_frames.load(Ordering::Relaxed),
                        elapsed_ms: now_ms(t0),
                    });
                }

                if Instant::now() > deadline {
                    let elapsed = now_ms(t0);
                    let last_write = shared.last_write_ms.load(Ordering::Relaxed);
                    if elapsed.saturating_sub(last_write) > 30_000 {
                        // I2: no WS client AND no IPC writes in 30s → crashed worker.
                        abort_child(&shared);
                        return Err(format!(
                            "sink: no client and no IPC writes within 30s{}",
                            tail_suffix(&shared)
                        ));
                    }

                    // IPC path: writes are still arriving (last_write is recent).
                    // If stdin was already taken (finish() drained via write command),
                    // wait for ffmpeg to finish and reap it.
                    let stdin_present = shared.stdin.lock().unwrap().is_some();
                    if !stdin_present {
                        let child = shared.child.lock().unwrap().take();
                        let status = match child {
                            Some(mut c) => {
                                Some(c.wait().map_err(|e| format!("ffmpeg wait: {e}"))?)
                            }
                            None => None,
                        };
                        if let Some(st) = status {
                            if !st.success() {
                                return Err(format!(
                                    "ffmpeg exited {st}{}",
                                    tail_suffix(&shared)
                                ));
                            }
                        }
                        return Ok(SinkStats {
                            bytes: shared.ipc_bytes.load(Ordering::Relaxed),
                            frames: shared.ipc_frames.load(Ordering::Relaxed),
                            elapsed_ms: now_ms(t0),
                        });
                    }
                }

                // Single 25ms sleep for all sub-cases (no separate 100ms branch).
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("sink accept: {e}")),
        }
    };
    // Helper: abort child and return a formatted error. Used for the three
    // pre-pump failure sites so no return path leaves ffmpeg un-reaped.
    let fail = |msg: String| -> String {
        abort_child(&shared);
        msg
    };
    stream
        .set_nonblocking(false)
        .map_err(|e| fail(format!("sink stream: {e}")))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| fail(format!("sink stream: {e}")))?;
    use tungstenite::protocol::WebSocketConfig;
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(max_frame_bytes.max(64 << 20));
    cfg.max_frame_size = Some(max_frame_bytes.max(16 << 20));
    let mut ws = tungstenite::accept_with_config(stream, Some(cfg))
        .map_err(|e| fail(format!("ws handshake: {e}")))?;
    // --- I5: token errors must kill+reap ffmpeg before returning ---
    match ws.read() {
        Ok(tungstenite::Message::Text(t)) if t == token => {}
        Ok(tungstenite::Message::Binary(b)) => {
            abort_child(&shared);
            return Err(format!("sink: bad first message (Binary, {} bytes)", b.len()));
        }
        Ok(m) => {
            abort_child(&shared);
            return Err(format!("sink: bad first message ({})", message_kind(m)));
        }
        Err(e) => {
            abort_child(&shared);
            return Err(format!("sink: token read: {e}"));
        }
    }
    // --- ws_connected: mark handshake complete so finish() won't steal stdin ---
    shared.ws_connected.store(true, Ordering::Relaxed);
    let ws_t0 = Instant::now();
    let mut bytes: u64 = 0;
    let mut frames: u64 = 0;
    loop {
        match ws.read() {
            Ok(tungstenite::Message::Binary(b)) => {
                bytes += b.len() as u64;
                frames += 1;
                let mut stdin = shared.stdin.lock().unwrap();
                if let Some(s) = stdin.as_mut() {
                    if let Err(e) = s.write_all(&b) {
                        drop(stdin);
                        abort_child(&shared);
                        return Err(format!(
                            "ffmpeg stdin: {e}{}",
                            tail_suffix(&shared)
                        ));
                    }
                }
            }
            Ok(tungstenite::Message::Close(frame)) => {
                let clean = frame
                    .as_ref()
                    .map(|f| u16::from(f.code) == 1000)
                    .unwrap_or(false);
                if !clean {
                    abort_child(&shared);
                    return Err("sink: client aborted".into());
                }
                break;
            }
            Ok(_) => {}
            Err(e) => {
                abort_child(&shared);
                return Err(format!("ws read (stalled client times out after 30s): {e}"));
            }
        }
    }
    // EOF => ffmpeg finalizes; then reap it.
    drop(shared.stdin.lock().unwrap().take());
    let child = shared.child.lock().unwrap().take();
    let status = match child {
        Some(mut c) => Some(c.wait().map_err(|e| format!("ffmpeg wait: {e}"))?),
        None => None,
    };
    if let Some(st) = status {
        if !st.success() {
            return Err(format!("ffmpeg exited {st}{}", tail_suffix(&shared)));
        }
    }
    Ok(SinkStats {
        bytes,
        frames,
        elapsed_ms: ws_t0.elapsed().as_millis() as u64,
    })
}

/// Tear down a sink left in `state`, if any. The app runs at most one export
/// at a time, so a sink still present when a NEW export starts is always an
/// orphan — its webview-side `finish()`/`cancel()` never ran. The dominant
/// cause is a webview reload / HMR / crash while a 10-bit export was in flight:
/// `VideoSinkState` is app-global and outlives the webview, so the JS that
/// would have cleaned up is gone and only Rust can reclaim it. Without this,
/// one leaked sink wedges every future export behind "already active" until a
/// full app restart. Signal the old WS thread to wind down, kill its ffmpeg,
/// and drop the handle (the thread observes `finishing` within its ~25ms
/// accept-loop tick and exits; its listener was on an ephemeral port, so the
/// fresh sink's `127.0.0.1:0` bind never collides).
fn reclaim_stale_sink(state: &Mutex<Option<ActiveSink>>) {
    let stale = state.lock().unwrap().take();
    if let Some(sink) = stale {
        warn!("video sink already active at start — reclaiming orphaned sink (prior export's teardown never ran, e.g. a webview reload mid-export)");
        sink.shared.finishing.store(true, Ordering::Relaxed);
        abort_child(&sink.shared);
        drop(sink.shared.stdin.lock().unwrap().take());
    }
}

pub async fn export_video_sink_start(
    state: &VideoSinkState,
    hw: &super::hwencoder::HwEncoderCache,
    args: VideoSinkStartArgs,
) -> Result<VideoSinkStartReply, String> {
    if args.mode != "discard" && args.mode != "ws" {
        return Err(format!("unknown sink mode {}", args.mode));
    }
    // Reclaim any orphaned sink rather than refusing: an active sink here is
    // always stale (single-export invariant), and refusing would wedge every
    // future export until an app restart. See `reclaim_stale_sink`.
    reclaim_stale_sink(&state.0);

    let mut child_opt: Option<Child> = None;
    let mut stdin_opt: Option<ChildStdin> = None;
    // stderr_temp is Some only when we spawned ffmpeg; used to wire the drain
    // thread after the SinkShared Arc is constructed.
    let mut stderr_temp: Option<std::process::ChildStderr> = None;

    if args.mode != "discard" {
        let codec = super::hwencoder::TargetCodec::parse(&args.codec)
            .ok_or_else(|| format!("unknown codec {}", args.codec))?;
        // --- M5: reject codecs unsupported for 10-bit ---
        if !matches!(
            codec,
            super::hwencoder::TargetCodec::Hevc | super::hwencoder::TargetCodec::Av1
        ) {
            return Err(format!(
                "10-bit export supports hevc/av1, got {}",
                args.codec
            ));
        }
        // --- M6: use already-imported State type; drop redundant `: String` ---
        let encoder = if args.software {
            codec.software_encoder().to_string()
        } else {
            hw.encoder_for_10bit(codec).await.as_ref().clone()
        };
        let mut cmd = std::process::Command::new(ffmpeg_sidecar::paths::ffmpeg_path());
        cmd.args(["-y", "-hide_banner", "-loglevel", "error"]);
        cmd.args(["-f", "rawvideo", "-pix_fmt", "yuv420p10le"]);
        cmd.arg("-video_size").arg(format!("{}x{}", args.width, args.height));
        cmd.arg("-framerate").arg(format!("{}/{}", args.fps_num, args.fps_den));
        cmd.args(["-i", "-"]);
        // Tag the FRAMES, not just the codec context: rawvideo frames carry no
        // color metadata, and hevc_nvenc writes its VUI colour_description from
        // the frame side (the `-color_primaries`/`-color_trc` context options
        // below land matrix+range but leave primaries/transfer "unspecified").
        // setparams stamps every frame bt709/limited so every encoder family
        // emits the full 4-tuple (found by the export_10bit gate).
        cmd.args([
            "-vf",
            "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        ]);
        for arg in super::video_encode_args(&encoder, args.bitrate, args.cbr, args.gop) {
            cmd.arg(arg);
        }
        for arg in super::hwencoder::tenbit_encode_args(&encoder) {
            cmd.arg(arg);
        }
        cmd.args([
            "-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-color_range", "tv",
        ]);
        for arg in super::hvc1_tag_args(codec, std::path::Path::new(&args.output_path)) {
            cmd.arg(arg);
        }
        cmd.arg(&args.output_path);
        // --- I4: capture stderr (piped) instead of inheriting ---
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
        stdin_opt = child.stdin.take();
        stderr_temp = child.stderr.take();
        child_opt = Some(child);
    }

    let shared = Arc::new(SinkShared {
        child: Mutex::new(child_opt),
        stdin: Mutex::new(stdin_opt),
        ws_connected: AtomicBool::new(false),
        finishing: AtomicBool::new(false),
        t0: Instant::now(),
        last_write_ms: AtomicU64::new(0),
        ipc_bytes: AtomicU64::new(0),
        ipc_frames: AtomicU64::new(0),
        stderr_tail: Mutex::new(String::new()),
    });

    // --- I4: spawn stderr drain thread now that shared Arc exists ---
    if let Some(stderr) = stderr_temp {
        let shared_for_thread = shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut buf = shared_for_thread.stderr_tail.lock().unwrap();
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 8192 {
                    // Drain from the front to the next newline boundary.
                    let excess = buf.len() - 8192;
                    let drain_to = buf[..excess + 128]
                        .find('\n')
                        .map(|p| p + 1)
                        .unwrap_or(excess);
                    buf.drain(..drain_to);
                }
            }
        });
    }

    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("sink bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = make_token();
    let max_frame_bytes = (args.width as usize) * (args.height as usize) * 3 + 65536;
    info!("video sink listening on 127.0.0.1:{port} mode={}", args.mode);
    let join = {
        let token = token.clone();
        let shared = shared.clone();
        std::thread::spawn(move || run_ws_sink(listener, token, shared, max_frame_bytes))
    };
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        // Race: another concurrent call won.
        drop(guard);
        // --- I3: race-loser cleanup — signal finishing + drop stdin so thread exits promptly ---
        shared.finishing.store(true, Ordering::Relaxed);
        drop(shared.stdin.lock().unwrap().take());
        abort_child(&shared);
        return Err("video sink already active".into());
    }
    *guard = Some(ActiveSink {
        join: Some(join),
        shared,
    });
    Ok(VideoSinkStartReply { port, token })
}

pub async fn export_video_sink_finish(
    state: &VideoSinkState,
) -> Result<SinkStats, String> {
    // --- C1: set finishing; only steal stdin if WS hasn't connected yet ---
    {
        let guard = state.0.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            s.shared.finishing.store(true, Ordering::Relaxed);
            if !s.shared.ws_connected.load(Ordering::Relaxed) {
                // IPC path or pre-handshake: EOF stdin to let ffmpeg finish.
                drop(s.shared.stdin.lock().unwrap().take());
            }
            // WS path: the sink thread drops stdin itself after processing Close;
            // stealing it here would truncate the encode tail.
        }
    }
    let (join, shared) = {
        let mut guard = state.0.lock().unwrap();
        let sink = guard.as_mut().ok_or("no active video sink")?;
        let join = sink.join.take().ok_or("sink already finished")?;
        (join, sink.shared.clone())
    };
    let join_result = tokio::task::spawn_blocking(move || {
        join.join().unwrap_or_else(|_| Err("sink thread panicked".into()))
    })
    .await;
    {
        let mut guard = state.0.lock().unwrap();
        if guard.as_ref().is_some_and(|s| Arc::ptr_eq(&s.shared, &shared)) {
            *guard = None;
        }
    }
    join_result.map_err(|e| e.to_string())?
}

pub async fn export_video_sink_cancel(
    state: &VideoSinkState,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(sink) = guard.take() {
        sink.shared.finishing.store(true, Ordering::Relaxed);
        // Kill first: breaks the pipe so any blocked write_all in the WS thread
        // unblocks immediately. Only then drop stdin (releases the lock / sends EOF).
        abort_child(&sink.shared);
        drop(sink.shared.stdin.lock().unwrap().take());
        warn!("video sink cancelled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_shared() -> Arc<SinkShared> {
        Arc::new(SinkShared {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            ws_connected: AtomicBool::new(false),
            finishing: AtomicBool::new(false),
            t0: Instant::now(),
            last_write_ms: AtomicU64::new(0),
            ipc_bytes: AtomicU64::new(0),
            ipc_frames: AtomicU64::new(0),
            stderr_tail: Mutex::new(String::new()),
        })
    }

    // Regression: a leaked/orphaned sink (webview reloaded mid-export, etc.)
    // must be reclaimed by the next start instead of wedging every future
    // export behind "video sink already active".
    #[test]
    fn reclaim_clears_orphaned_sink_and_signals_finishing() {
        let shared = dummy_shared();
        let probe = shared.clone();
        // Stand-in for the orphaned sink's WS thread join handle.
        let join =
            std::thread::spawn(|| Ok(SinkStats { bytes: 0, frames: 0, elapsed_ms: 0 }));
        let state = Mutex::new(Some(ActiveSink { join: Some(join), shared }));

        reclaim_stale_sink(&state);

        assert!(
            state.lock().unwrap().is_none(),
            "an orphaned sink must be reclaimed so the next start can proceed"
        );
        assert!(
            probe.finishing.load(Ordering::Relaxed),
            "reclaim must signal the old WS thread to wind down"
        );
    }

    #[test]
    fn reclaim_is_a_noop_when_no_sink_is_active() {
        let state: Mutex<Option<ActiveSink>> = Mutex::new(None);
        reclaim_stale_sink(&state);
        assert!(state.lock().unwrap().is_none());
    }
}
