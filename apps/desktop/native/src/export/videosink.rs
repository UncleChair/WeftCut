//! Native-IPC video sink for the 10-bit export. The renderer composites in a
//! Worker, packs each frame to yuv420p10le, and posts it over the export
//! `chunk` channel; the main process forwards each frame to `video_sink_write`,
//! which pipes it into an ffmpeg encode. `finish` drops stdin (EOF) and reaps
//! ffmpeg directly. See docs/export-ipc-transport.md.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};

use crate::process::NoConsoleWindow;
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
    /// "h264" | "hevc" | "av1".
    pub codec: String,
    pub bitrate: u64,
    pub cbr: bool,
    pub gop: u64,
    pub software: bool,
    /// Empty ⇒ no ffmpeg (byte-count only; used by tests). Non-empty ⇒ encode.
    pub output_path: String,
    /// rawvideo input format the renderer packs: "yuv420p" | "yuv420p10le"
    /// (E3 adds "yuv422p" | "yuv422p10le"). Defaults to the legacy 10-bit
    /// format so pre-E2 callers keep working.
    #[serde(default = "default_sink_pix_fmt")]
    pub pix_fmt: String,
    /// Constant-quality value (rateMode "quality"). Some ⇒ CRF/quality args
    /// replace -b:v. Only sent with software=true by the renderer.
    #[serde(default)]
    pub crf: Option<u32>,
    /// Software-encoder speed preset: "fast" | "medium" | "slow".
    #[serde(default)]
    pub preset: Option<String>,
    /// Intermediate-codec profile: prores proxy|lt|422|hq, dnxhr lb|sq|hq.
    #[serde(default)]
    pub profile: Option<String>,
}

fn default_sink_pix_fmt() -> String {
    "yuv420p10le".to_string()
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

/// The full ffmpeg argv (minus program name) for one sink run. Pure — unit
/// tests lock the shape without spawning. `encoder` is already resolved
/// (HW-probed or software).
pub(crate) fn sink_cmd_args(
    args: &VideoSinkStartArgs,
    codec: Option<super::hwencoder::TargetCodec>,
    encoder: &str,
) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let mut a: Vec<OsString> = vec![
        "-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-f".into(), "rawvideo".into(),
        "-pix_fmt".into(), OsString::from(&args.pix_fmt),
        "-video_size".into(), format!("{}x{}", args.width, args.height).into(),
        "-framerate".into(), format!("{}/{}", args.fps_num, args.fps_den).into(),
        "-i".into(), "-".into(),
        // Tag the FRAMES (rawvideo carries no colour metadata) so every encoder
        // family emits the full bt709/limited 4-tuple (export_10bit gate).
        "-vf".into(),
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv".into(),
    ];
    a.push("-c:v".into());
    a.push(encoder.into());
    match args.codec.as_str() {
        // Intra, quality-fixed families: profile IS the rate control; no -b:v,
        // no GOP pinning (every frame is a keyframe).
        "prores" => {
            let p = match args.profile.as_deref() {
                Some("proxy") => "0",
                Some("lt") => "1",
                Some("hq") => "3",
                _ => "2", // "422"
            };
            a.extend::<Vec<OsString>>(vec![
                "-profile:v".into(), p.into(),
                "-vendor".into(), "apl0".into(),
                "-pix_fmt".into(), "yuv422p10le".into(),
            ]);
        }
        "dnxhr" => {
            let p = match args.profile.as_deref() {
                Some("lb") => "dnxhr_lb",
                Some("hq") => "dnxhr_hq",
                _ => "dnxhr_sq",
            };
            a.extend::<Vec<OsString>>(vec![
                "-profile:v".into(), p.into(),
                "-pix_fmt".into(), "yuv422p".into(),
            ]);
        }
        _ => {
            // Delivery codecs: CRF (quality mode) XOR bitrate, pinned GOP,
            // speed preset for software encoders.
            match args.crf {
                Some(crf) => {
                    a.push("-crf".into());
                    a.push(crf.to_string().into());
                }
                None => {
                    a.push("-b:v".into());
                    a.push(args.bitrate.to_string().into());
                    if args.cbr {
                        a.extend::<Vec<OsString>>(vec![
                            "-maxrate".into(), args.bitrate.to_string().into(),
                            "-minrate".into(), args.bitrate.to_string().into(),
                            "-bufsize".into(), (args.bitrate * 2).to_string().into(),
                        ]);
                    }
                }
            }
            let g = args.gop.max(1).to_string();
            a.extend::<Vec<OsString>>(vec![
                "-g".into(), g.clone().into(), "-keyint_min".into(), g.into(),
            ]);
            let preset = args.preset.as_deref().unwrap_or("medium");
            match encoder {
                "libsvtav1" => {
                    let p = match preset { "fast" => "10", "slow" => "6", _ => "8" };
                    a.extend::<Vec<OsString>>(vec!["-preset".into(), p.into()]);
                }
                "libx265" | "libx264" => {
                    a.extend::<Vec<OsString>>(vec![
                        "-preset".into(), preset.into(),
                        "-sc_threshold".into(), "0".into(),
                    ]);
                }
                _ => {} // HW encoders: defaults
            }
            if args.pix_fmt.ends_with("10le") {
                a.extend(super::hwencoder::tenbit_encode_args(encoder));
            } else {
                a.extend(super::hwencoder::eightbit_encode_args(encoder));
            }
        }
    }
    a.extend::<Vec<OsString>>(vec![
        "-colorspace".into(), "bt709".into(), "-color_primaries".into(), "bt709".into(),
        "-color_trc".into(), "bt709".into(), "-color_range".into(), "tv".into(),
    ]);
    if let Some(c) = codec {
        a.extend(super::hvc1_tag_args(c, std::path::Path::new(&args.output_path)));
    }
    a.push(OsString::from(&args.output_path));
    a
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
        if !matches!(
            args.pix_fmt.as_str(),
            "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le"
        ) {
            return Err(format!("unsupported sink pix_fmt {}", args.pix_fmt));
        }
        let (codec_enum, encoder): (Option<super::hwencoder::TargetCodec>, String) =
            match args.codec.as_str() {
                "prores" => (None, "prores_ks".to_string()),
                "dnxhr" => (None, "dnxhd".to_string()),
                other => {
                    let c = super::hwencoder::TargetCodec::parse(other)
                        .ok_or_else(|| format!("unknown codec {other}"))?;
                    // The sink encodes h264/hevc/av1 only — parseable-but-unsupported
                    // codecs (vp9) must be rejected up front, not silently routed to
                    // libvpx-vp9.
                    if !matches!(
                        c,
                        super::hwencoder::TargetCodec::H264
                            | super::hwencoder::TargetCodec::Hevc
                            | super::hwencoder::TargetCodec::Av1
                    ) {
                        return Err(format!("video sink supports h264/hevc/av1, got {other}"));
                    }
                    let ten_bit = args.pix_fmt.ends_with("10le");
                    if ten_bit
                        && !matches!(
                            c,
                            super::hwencoder::TargetCodec::Hevc | super::hwencoder::TargetCodec::Av1
                        )
                    {
                        return Err(format!("10-bit export supports hevc/av1, got {other}"));
                    }
                    let e = if args.software {
                        c.software_encoder().to_string()
                    } else if ten_bit {
                        hw.encoder_for_10bit(c).await.as_ref().clone()
                    } else {
                        hw.encoder_for(c).await.as_ref().clone()
                    };
                    (Some(c), e)
                }
            };
        let mut cmd = std::process::Command::new(ffmpeg_sidecar::paths::ffmpeg_path());
        cmd.no_console_window();
        for arg in sink_cmd_args(&args, codec_enum, &encoder) {
            cmd.arg(arg);
        }
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

    fn args_10bit() -> VideoSinkStartArgs {
        VideoSinkStartArgs {
            width: 1920, height: 1080, fps_num: 30, fps_den: 1,
            codec: "hevc".into(), bitrate: 8_000_000, cbr: false, gop: 30,
            software: true, output_path: "C:/tmp/out.mp4".into(),
            pix_fmt: "yuv420p10le".into(),
            crf: None, preset: None, profile: None,
        }
    }

    fn args_8bit(codec: &str) -> VideoSinkStartArgs {
        VideoSinkStartArgs {
            width: 1920, height: 1080, fps_num: 30, fps_den: 1,
            codec: codec.into(), bitrate: 8_000_000, cbr: false, gop: 30,
            software: true, output_path: "C:/tmp/out.mp4".into(),
            pix_fmt: "yuv420p".into(),
            crf: None, preset: None, profile: None,
        }
    }

    #[test]
    fn sink_cmd_args_8bit_h264_shape() {
        let argv = sink_cmd_args(&args_8bit("h264"), Some(super::super::TargetCodec::H264), "libx264");
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        // input is 8-bit rawvideo; output pix_fmt is yuv420p; NO main10 profile.
        let pf: Vec<usize> = s.iter().enumerate()
            .filter(|(_, a)| *a == "-pix_fmt").map(|(i, _)| i).collect();
        assert_eq!(pf.len(), 2, "input + output pix_fmt: {s:?}");
        assert_eq!(s[pf[0] + 1], "yuv420p");
        assert_eq!(s[pf[1] + 1], "yuv420p");
        assert!(!s.iter().any(|a| a == "main10"));
        // color tags apply at 8-bit too (the point of the native exit).
        assert!(s.windows(2).any(|w| w[0] == "-color_range" && w[1] == "tv"));
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
    }

    #[test]
    fn sink_args_quality_mode_uses_crf_not_bitrate() {
        let mut a = args_8bit("h264");
        a.crf = Some(18);
        a.preset = Some("slow".into());
        let argv = sink_cmd_args(&a, Some(super::super::TargetCodec::H264), "libx264");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-crf" && w[1] == "18"));
        assert!(!s.iter().any(|x| x == "-b:v"));
        assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "slow"));
    }

    #[test]
    fn sink_args_svtav1_preset_mapping() {
        let mut a = args_8bit("av1");
        a.crf = Some(30);
        a.preset = Some("fast".into());
        let argv = sink_cmd_args(&a, Some(super::super::TargetCodec::Av1), "libsvtav1");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-crf" && w[1] == "30"));
        assert!(s.windows(2).any(|w| w[0] == "-preset" && w[1] == "10")); // fast→10, medium→8, slow→6
    }

    #[test]
    fn sink_args_prores_profile() {
        let mut a = args_8bit("prores");
        a.pix_fmt = "yuv422p10le".into();
        a.profile = Some("hq".into());
        a.output_path = "C:/tmp/out.mov".into();
        let argv = sink_cmd_args(&a, None, "prores_ks");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "prores_ks"));
        assert!(s.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "3")); // proxy0 lt1 std2 hq3
        assert!(s.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv422p10le"));
        assert!(s.windows(2).any(|w| w[0] == "-vendor" && w[1] == "apl0"));
        assert!(!s.iter().any(|x| x == "-b:v" || x == "-g")); // intra, quality-fixed
    }

    #[test]
    fn sink_args_dnxhr_profile() {
        let mut a = args_8bit("dnxhr");
        a.pix_fmt = "yuv422p".into();
        a.profile = Some("sq".into());
        a.output_path = "C:/tmp/out.mov".into();
        let argv = sink_cmd_args(&a, None, "dnxhd");
        let s: Vec<String> = argv.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "dnxhd"));
        assert!(s.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "dnxhr_sq"));
        assert!(s.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv422p"));
    }

    #[test]
    fn tenbit_pix_fmt_still_defaults_and_gates() {
        // serde default keeps old TS callers valid.
        let v: VideoSinkStartArgs =
            serde_json::from_str(r#"{"width":64,"height":64,"fpsNum":30,"fpsDen":1,
              "codec":"hevc","bitrate":0,"cbr":false,"gop":30,"software":true,
              "outputPath":""}"#).unwrap();
        assert_eq!(v.pix_fmt, "yuv420p10le");
    }

    // The sink encodes h264/hevc/av1 only — parseable-but-unsupported codecs
    // (vp9) must be rejected up front, not silently routed to libvpx-vp9.
    #[tokio::test]
    async fn start_rejects_vp9_at_8bit() {
        let state = VideoSinkState::default();
        let hw = super::super::hwencoder::HwEncoderCache::default();
        let err = export_video_sink_start(&state, &hw, args_8bit("vp9"))
            .await
            .unwrap_err();
        assert!(err.contains("h264/hevc/av1"), "unexpected error: {err}");
        assert!(state.0.lock().unwrap().is_none(), "no sink left active");
    }

    // Locks the exact argv the inline builder produced before extraction.
    #[test]
    fn sink_cmd_args_matches_legacy_10bit_shape() {
        let argv = sink_cmd_args(&args_10bit(), Some(super::super::TargetCodec::Hevc), "libx265");
        let s: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        // rawvideo input header
        assert!(s.windows(2).any(|w| w[0] == "-f" && w[1] == "rawvideo"));
        assert!(s.windows(2).any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p10le"));
        assert!(s.windows(2).any(|w| w[0] == "-video_size" && w[1] == "1920x1080"));
        assert!(s.windows(2).any(|w| w[0] == "-framerate" && w[1] == "30/1"));
        // frame tagging vf + encoder + 10-bit profile + color tags + hvc1 + output
        assert!(s.iter().any(|a| a.starts_with("setparams=colorspace=bt709")));
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
        assert!(s.windows(2).any(|w| w[0] == "-profile:v" && w[1] == "main10"));
        assert!(s.windows(2).any(|w| w[0] == "-color_range" && w[1] == "tv"));
        assert!(s.windows(2).any(|w| w[0] == "-tag:v" && w[1] == "hvc1"));
        assert_eq!(s.last().unwrap(), "C:/tmp/out.mp4");
        // input marker present exactly once, before the encoder args
        let i_pos = s.iter().position(|a| a == "-i").unwrap();
        let cv_pos = s.iter().position(|a| a == "-c:v").unwrap();
        assert!(i_pos < cv_pos);
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
                pix_fmt: "yuv420p10le".into(),
                crf: None,
                preset: None,
                profile: None,
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
