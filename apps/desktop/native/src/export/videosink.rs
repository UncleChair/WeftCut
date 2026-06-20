//! Native-IPC video sink for the 10-bit export. The renderer composites in a
//! Worker, packs each frame to yuv420p10le, and posts it over the export
//! `chunk` channel; the main process forwards each frame to `video_sink_write`,
//! which pipes it into an ffmpeg encode. `finish` drops stdin (EOF) and reaps
//! ffmpeg directly. See docs/export-ipc-transport.md.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

#[derive(Default)]
pub struct VideoSinkState(pub Mutex<Option<ActiveSink>>);

/// Shared between the IPC write command, finish, and cancel.
pub struct SinkShared {
    /// ffmpeg child (None when output_path is empty / after wait).
    pub child: Mutex<Option<Child>>,
    /// ffmpeg stdin. The IPC write command writes here; dropping it = EOF.
    pub stdin: Mutex<Option<ChildStdin>>,
    /// Time origin for SinkStats.
    pub t0: Instant,
    /// IPC-path counters reported as SinkStats.
    pub ipc_bytes: AtomicU64,
    pub ipc_frames: AtomicU64,
    /// Deferred-optimization instrumentation (see docs/export-ipc-transport.md):
    /// nanos spent copying the napi Buffer (`to_vec`) and writing to ffmpeg stdin,
    /// summed across frames; logged at finish to judge whether the per-frame copy
    /// is worth eliminating. Measurement only — does not affect output.
    pub copy_ns: AtomicU64,
    pub write_ns: AtomicU64,
    /// Rolling tail of ffmpeg stderr (bounded to 8192 chars), appended to errors.
    pub stderr_tail: Mutex<String>,
}

pub struct ActiveSink {
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
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// "hevc" | "av1".
    pub codec: String,
    pub bitrate: u64,
    pub cbr: bool,
    pub gop: u64,
    pub software: bool,
    /// Empty ⇒ no ffmpeg (byte-count only; used by tests). Non-empty ⇒ encode.
    pub output_path: String,
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

/// Kill and reap `shared.child`, ignoring all errors.
fn abort_child(shared: &SinkShared) {
    if let Some(mut c) = shared.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Tear down a sink left in `state`, if any. The app runs at most one export at
/// a time, so a sink still present when a NEW export starts is always an orphan
/// (its renderer-side finish/cancel never ran — typically a renderer reload/crash
/// mid-export). Kill its ffmpeg and drop the handle so the next export proceeds.
fn reclaim_stale_sink(state: &Mutex<Option<ActiveSink>>) {
    let stale = state.lock().unwrap().take();
    if let Some(sink) = stale {
        warn!("video sink already active at start — reclaiming orphaned sink (prior export's teardown never ran, e.g. a renderer reload mid-export)");
        abort_child(&sink.shared);
        drop(sink.shared.stdin.lock().unwrap().take());
    }
}

pub async fn export_video_sink_start(
    state: &VideoSinkState,
    hw: &super::hwencoder::HwEncoderCache,
    args: VideoSinkStartArgs,
) -> Result<(), String> {
    // An active sink here is always stale (single-export invariant); reclaim it.
    reclaim_stale_sink(&state.0);

    let mut child_opt: Option<Child> = None;
    let mut stdin_opt: Option<ChildStdin> = None;
    let mut stderr_temp: Option<std::process::ChildStderr> = None;

    if !args.output_path.is_empty() {
        let codec = super::hwencoder::TargetCodec::parse(&args.codec)
            .ok_or_else(|| format!("unknown codec {}", args.codec))?;
        if !matches!(
            codec,
            super::hwencoder::TargetCodec::Hevc | super::hwencoder::TargetCodec::Av1
        ) {
            return Err(format!("10-bit export supports hevc/av1, got {}", args.codec));
        }
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
        // Tag the FRAMES (rawvideo carries no colour metadata) so every encoder
        // family emits the full bt709/limited 4-tuple (export_10bit gate).
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
        t0: Instant::now(),
        ipc_bytes: AtomicU64::new(0),
        ipc_frames: AtomicU64::new(0),
        copy_ns: AtomicU64::new(0),
        write_ns: AtomicU64::new(0),
        stderr_tail: Mutex::new(String::new()),
    });

    if let Some(stderr) = stderr_temp {
        let shared_for_thread = shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut buf = shared_for_thread.stderr_tail.lock().unwrap();
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 8192 {
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

    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        // Race: another concurrent start won. Tear down ours.
        drop(guard);
        abort_child(&shared);
        drop(shared.stdin.lock().unwrap().take());
        return Err("video sink already active".into());
    }
    *guard = Some(ActiveSink { shared });
    info!("video sink started (ipc, output={})", !args.output_path.is_empty());
    Ok(())
}

/// Write one raw yuv420p10le frame to the active sink's ffmpeg stdin (None =>
/// byte-count only) and bump the counters reported by finish. The blocking pipe
/// write runs on a blocking thread; awaiting it is the renderer's backpressure.
pub async fn video_sink_write(
    state: &VideoSinkState,
    data: Vec<u8>,
    copy_ns: u64,
) -> Result<(), String> {
    let shared = {
        let guard = state.0.lock().unwrap();
        let sink = guard.as_ref().ok_or("no active video sink")?;
        sink.shared.clone()
    };
    shared.copy_ns.fetch_add(copy_ns, Ordering::Relaxed);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let w0 = Instant::now();
        {
            let mut stdin = shared.stdin.lock().unwrap();
            if let Some(s) = stdin.as_mut() {
                s.write_all(&data)
                    .map_err(|e| format!("ffmpeg stdin: {e}{}", tail_suffix(&shared)))?;
            }
        }
        shared
            .write_ns
            .fetch_add(w0.elapsed().as_nanos() as u64, Ordering::Relaxed);
        shared.ipc_bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
        shared.ipc_frames.fetch_add(1, Ordering::Relaxed);
        Ok(())
    })
    .await
    .map_err(|e| format!("write join: {e}"))?
}

/// Finalize: drop stdin (EOF → ffmpeg finalizes), reap the child directly, and
/// return the IPC counters. No WS thread to join.
pub async fn export_video_sink_finish(state: &VideoSinkState) -> Result<SinkStats, String> {
    let shared = {
        let mut guard = state.0.lock().unwrap();
        guard.take().ok_or("no active video sink")?.shared
    };
    drop(shared.stdin.lock().unwrap().take());
    let shared_for_wait = shared.clone();
    let status = tokio::task::spawn_blocking(move || -> Result<Option<std::process::ExitStatus>, String> {
        let child = shared_for_wait.child.lock().unwrap().take();
        match child {
            Some(mut c) => c.wait().map(Some).map_err(|e| format!("ffmpeg wait: {e}")),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("finish join: {e}"))??;
    if let Some(st) = status {
        if !st.success() {
            return Err(format!("ffmpeg exited {st}{}", tail_suffix(&shared)));
        }
    }
    let bytes = shared.ipc_bytes.load(Ordering::Relaxed);
    let frames = shared.ipc_frames.load(Ordering::Relaxed);
    // Deferred-optimization signal (docs/export-ipc-transport.md): is the per-frame
    // Buffer copy worth eliminating? Compares copy vs stdin-write time across the export.
    let copy_ms = shared.copy_ns.load(Ordering::Relaxed) / 1_000_000;
    let write_ms = shared.write_ns.load(Ordering::Relaxed) / 1_000_000;
    let mb = bytes / 1_048_576;
    let write_mbps = if write_ms > 0 { mb * 1000 / write_ms } else { 0 };
    info!(
        "video sink finished: {frames} frames, {mb} MB; copy {copy_ms} ms, write {write_ms} ms ({write_mbps} MB/s stdin)"
    );
    Ok(SinkStats {
        bytes,
        frames,
        elapsed_ms: shared.t0.elapsed().as_millis() as u64,
    })
}

pub async fn export_video_sink_cancel(state: &VideoSinkState) -> Result<(), String> {
    let sink = state.0.lock().unwrap().take();
    if let Some(sink) = sink {
        // Kill first (breaks the pipe so any blocked write unblocks), then drop stdin.
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
            t0: Instant::now(),
            ipc_bytes: AtomicU64::new(0),
            ipc_frames: AtomicU64::new(0),
            copy_ns: AtomicU64::new(0),
            write_ns: AtomicU64::new(0),
            stderr_tail: Mutex::new(String::new()),
        })
    }

    // A leaked/orphaned sink (renderer reloaded mid-export) must be reclaimed
    // by the next start instead of wedging future exports.
    #[test]
    fn reclaim_clears_orphaned_sink() {
        let shared = dummy_shared();
        let state = Mutex::new(Some(ActiveSink { shared }));
        reclaim_stale_sink(&state);
        assert!(state.lock().unwrap().is_none(), "orphaned sink must be reclaimed");
    }

    #[test]
    fn reclaim_is_a_noop_when_no_sink_is_active() {
        let state: Mutex<Option<ActiveSink>> = Mutex::new(None);
        reclaim_stale_sink(&state);
        assert!(state.lock().unwrap().is_none());
    }

    // IPC + empty output_path (no ffmpeg): push frames through video_sink_write,
    // finish, and confirm the counters AND that finish reaps promptly + clears
    // the sink (the direct-reap path with child=None).
    #[tokio::test]
    async fn ipc_write_counts_and_finish_reaps() {
        let state = VideoSinkState::default();
        let hw = super::super::hwencoder::HwEncoderCache::default();
        export_video_sink_start(
            &state,
            &hw,
            VideoSinkStartArgs {
                width: 64,
                height: 64,
                fps_num: 30,
                fps_den: 1,
                codec: "hevc".into(),
                bitrate: 0,
                cbr: false,
                gop: 30,
                software: false,
                output_path: String::new(),
            },
        )
        .await
        .expect("start");

        let frame = vec![7u8; 64 * 64 * 3];
        for _ in 0..5 {
            video_sink_write(&state, frame.clone(), 0).await.expect("write");
        }

        let stats = export_video_sink_finish(&state).await.expect("finish");
        assert_eq!(stats.frames, 5);
        assert_eq!(stats.bytes, 5 * (64 * 64 * 3) as u64);
        assert!(state.0.lock().unwrap().is_none(), "finish clears the sink");
    }
}
