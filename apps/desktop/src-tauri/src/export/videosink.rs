//! Localhost video sink for the 10-bit export. The webview streams raw
//! yuv420p10le frames over a one-shot loopback WebSocket; this module pipes
//! them into an ffmpeg encode (Task 3). `mode: "discard"` byte-counts instead
//! -- the transport spike and the throughput e2e use it. Token = first text
//! message on the socket; anything else closes the connection.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{info, warn};

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
    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut h);
    std::process::id().hash(&mut h);
    let a = h.finish();
    a.hash(&mut h);
    format!("{:016x}{:016x}", a, h.finish())
}

/// Accept exactly one WS client, verify the token, then pump binary frames
/// into `shared.stdin` (None => discard). A non-Normal close kills ffmpeg
/// (abort); a Normal close drops stdin (EOF) and waits for ffmpeg to exit.
fn run_ws_sink(
    listener: TcpListener,
    token: String,
    shared: Arc<SinkShared>,
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
                    return Err("sink: no client within 30s".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("sink accept: {e}")),
        }
    };
    stream
        .set_nonblocking(false)
        .map_err(|e| format!("sink stream: {e}"))?;
    let mut ws =
        tungstenite::accept(stream).map_err(|e| format!("ws handshake: {e}"))?;
    match ws.read() {
        Ok(tungstenite::Message::Text(t)) if t == token => {}
        other => return Err(format!("sink: bad first message ({other:?})")),
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
                return Err(format!("ws read: {e}"));
            }
        }
    }
    // EOF => ffmpeg finalizes; then reap it.
    drop(shared.stdin.lock().unwrap().take());
    let status = match shared.child.lock().unwrap().take() {
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
    args: VideoSinkStartArgs,
) -> Result<VideoSinkStartReply, String> {
    if state.0.lock().unwrap().is_some() {
        return Err("video sink already active".into());
    }
    if args.mode != "discard" && args.mode != "ws" {
        return Err(format!("unknown sink mode {}", args.mode));
    }
    // Task 3 spawns ffmpeg here for mode == "ws"; discard runs sinkless.
    let shared = Arc::new(SinkShared {
        child: Mutex::new(None),
        stdin: Mutex::new(None),
    });
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("sink bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = make_token();
    info!("video sink listening on 127.0.0.1:{port} mode={}", args.mode);
    let join = {
        let token = token.clone();
        let shared = shared.clone();
        std::thread::spawn(move || run_ws_sink(listener, token, shared))
    };
    *state.0.lock().unwrap() = Some(ActiveSink {
        join: Some(join),
        shared,
    });
    Ok(VideoSinkStartReply { port, token })
}

#[tauri::command]
pub async fn export_video_sink_finish(
    state: State<'_, VideoSinkState>,
) -> Result<SinkStats, String> {
    let join = {
        let mut guard = state.0.lock().unwrap();
        let sink = guard.as_mut().ok_or("no active video sink")?;
        sink.join.take().ok_or("sink already finished")?
    };
    let res = tauri::async_runtime::spawn_blocking(move || {
        join.join().unwrap_or_else(|_| Err("sink thread panicked".into()))
    })
    .await
    .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = None;
    res
}

#[tauri::command]
pub async fn export_video_sink_cancel(
    state: State<'_, VideoSinkState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(sink) = guard.take() {
        drop(sink.shared.stdin.lock().unwrap().take());
        if let Some(c) = sink.shared.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
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
    let guard = state.0.lock().unwrap();
    let sink = guard.as_ref().ok_or("no active video sink")?;
    let mut stdin = sink.shared.stdin.lock().unwrap();
    match stdin.as_mut() {
        Some(s) => s.write_all(bytes).map_err(|e| format!("ffmpeg stdin: {e}")),
        None => Ok(()), // discard mode
    }
}
