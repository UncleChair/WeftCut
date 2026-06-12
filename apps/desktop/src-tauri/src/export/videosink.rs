//! Localhost video sink for the 10-bit export. The webview streams raw
//! yuv420p10le frames over a one-shot loopback WebSocket; this module pipes
//! them into an ffmpeg encode (Task 3). `mode: "discard"` byte-counts instead
//! -- the transport spike and the throughput e2e use it. Token = first text
//! message on the socket; anything else closes the connection.

use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
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

/// Accept exactly one WS client, verify the token, then pump binary frames
/// into `shared.stdin` (None => discard). A non-Normal close kills ffmpeg
/// (abort); a Normal close drops stdin (EOF) and waits for ffmpeg to exit.
fn run_ws_sink(
    listener: TcpListener,
    token: String,
    shared: Arc<SinkShared>,
    max_frame_bytes: usize,
) -> Result<SinkStats, String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("sink listener: {e}"))?;
    let stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    // IPC path: if stdin was already taken (finish() drained
                    // frames via write command), reap the child and return OK.
                    // If stdin is still present, a WS client may still arrive.
                    let stdin_present = shared.stdin.lock().unwrap().is_some();
                    if !stdin_present {
                        let child = shared.child.lock().unwrap().take();
                        let status = match child {
                            Some(mut c) => Some(c.wait().map_err(|e| format!("ffmpeg wait: {e}"))?),
                            None => None,
                        };
                        if let Some(st) = status {
                            if !st.success() {
                                return Err(format!("ffmpeg exited {st}"));
                            }
                        }
                        return Ok(SinkStats { bytes: 0, frames: 0, elapsed_ms: 0 });
                    }
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("sink accept: {e}")),
        }
    };
    stream
        .set_nonblocking(false)
        .map_err(|e| format!("sink stream: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| format!("sink stream: {e}"))?;
    use tungstenite::protocol::WebSocketConfig;
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(max_frame_bytes.max(64 << 20));
    cfg.max_frame_size = Some(max_frame_bytes.max(16 << 20));
    let mut ws = tungstenite::accept_with_config(stream, Some(cfg))
        .map_err(|e| format!("ws handshake: {e}"))?;
    match ws.read() {
        Ok(tungstenite::Message::Text(t)) if t == token => {}
        Ok(tungstenite::Message::Binary(b)) => {
            return Err(format!("sink: bad first message (Binary, {} bytes)", b.len()))
        }
        Ok(m) => return Err(format!("sink: bad first message ({})", message_kind(m))),
        Err(e) => return Err(format!("sink: token read: {e}")),
    }
    let t0 = Instant::now();
    let mut bytes: u64 = 0;
    let mut frames: u64 = 0;
    let kill = |shared: &SinkShared| {
        if let Some(c) = shared.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    };
    loop {
        match ws.read() {
            Ok(tungstenite::Message::Binary(b)) => {
                bytes += b.len() as u64;
                frames += 1;
                let mut stdin = shared.stdin.lock().unwrap();
                if let Some(s) = stdin.as_mut() {
                    if let Err(e) = s.write_all(&b) {
                        drop(stdin);
                        kill(&shared);
                        return Err(format!("ffmpeg stdin: {e}"));
                    }
                }
            }
            Ok(tungstenite::Message::Close(frame)) => {
                let clean = frame
                    .as_ref()
                    .map(|f| u16::from(f.code) == 1000)
                    .unwrap_or(false);
                if !clean {
                    kill(&shared);
                    return Err("sink: client aborted".into());
                }
                break;
            }
            Ok(_) => {}
            Err(e) => {
                kill(&shared);
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
            return Err(format!("ffmpeg exited {st}"));
        }
    }
    Ok(SinkStats {
        bytes,
        frames,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn export_video_sink_start(
    state: State<'_, VideoSinkState>,
    hw: tauri::State<'_, super::hwencoder::HwEncoderCache>,
    args: VideoSinkStartArgs,
) -> Result<VideoSinkStartReply, String> {
    if args.mode != "discard" && args.mode != "ws" {
        return Err(format!("unknown sink mode {}", args.mode));
    }
    // Cheap early bail: if already active, refuse immediately.
    if state.0.lock().unwrap().is_some() {
        return Err("video sink already active".into());
    }
    let mut child_opt: Option<Child> = None;
    let mut stdin_opt: Option<ChildStdin> = None;
    if args.mode != "discard" {
        let codec = super::hwencoder::TargetCodec::parse(&args.codec)
            .ok_or_else(|| format!("unknown codec {}", args.codec))?;
        let encoder: String = if args.software {
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
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit());
        let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
        stdin_opt = child.stdin.take();
        child_opt = Some(child);
    }
    let shared = Arc::new(SinkShared {
        child: Mutex::new(child_opt),
        stdin: Mutex::new(stdin_opt),
    });
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
        // Race: another concurrent call won. Kill any spawned ffmpeg and bail.
        drop(guard);
        if let Some(mut c) = shared.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        return Err("video sink already active".into());
    }
    *guard = Some(ActiveSink {
        join: Some(join),
        shared,
    });
    Ok(VideoSinkStartReply { port, token })
}

#[tauri::command]
pub async fn export_video_sink_finish(
    state: State<'_, VideoSinkState>,
) -> Result<SinkStats, String> {
    // Drop stdin so the IPC-write path and the WS path both converge on EOF.
    {
        let guard = state.0.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            drop(s.shared.stdin.lock().unwrap().take());
        }
    }
    let (join, shared) = {
        let mut guard = state.0.lock().unwrap();
        let sink = guard.as_mut().ok_or("no active video sink")?;
        let join = sink.join.take().ok_or("sink already finished")?;
        (join, sink.shared.clone())
    };
    let join_result = tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub async fn export_video_sink_cancel(
    state: State<'_, VideoSinkState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(sink) = guard.take() {
        if let Some(mut c) = sink.shared.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        drop(sink.shared.stdin.lock().unwrap().take());
        warn!("video sink cancelled");
    }
    Ok(())
}

/// IPC fallback: raw-invoke body straight into ffmpeg stdin. Used only when
/// the WS connect fails in the worker (the export still completes, slower).
#[tauri::command]
pub fn export_video_sink_write(
    request: tauri::ipc::Request<'_>,
    state: State<'_, VideoSinkState>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let shared = {
        let guard = state.0.lock().unwrap();
        let sink = guard.as_ref().ok_or("no active video sink")?;
        sink.shared.clone()
    };
    let mut stdin = shared.stdin.lock().unwrap();
    match stdin.as_mut() {
        Some(s) => s.write_all(bytes).map_err(|e| format!("ffmpeg stdin: {e}")),
        None => Ok(()), // discard mode
    }
}
