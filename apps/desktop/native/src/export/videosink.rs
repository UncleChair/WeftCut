//! Native-IPC video sink for the export pipeline. The renderer composites in
//! a Worker, packs each frame to the sink's configured rawvideo pix_fmt
//! (yuv420p / yuv420p10le for 8/10-bit delivery codecs, yuv422p / yuv422p10le
//! for the DNxHR / ProRes intermediates), and posts it over the export
//! `chunk` channel; the main process forwards each frame to `video_sink_write`,
//! which pipes it into an ffmpeg encode. `finish` drops stdin (EOF) and reaps
//! ffmpeg directly. See docs/export-ipc-transport.md.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin};

use crate::process::NoConsoleWindow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::encoder_registry::{
    Acceleration, BitDepth, BitrateMode, DnxhrProfile, EncodeUnavailable, EncoderIntent,
    EncoderPlan, EncoderRegistry, OutputContainer, ProresProfile, RateControl,
    SelectedAcceleration, Speed, VideoCodec,
};
use crate::logs::{LogBusSlot, LogCategory, LogEntryInput, LogLevel, LogSource};

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
    /// "h264" | "hevc" | "av1" | "prores" | "dnxhr".
    pub codec: String,
    /// Target (average) bitrate in bits per second — ffmpeg's `-b:v`.
    pub bitrate: u64,
    pub cbr: bool,
    /// Peak ceiling in bits per second (`-maxrate`), VBR only. Omitted ⇒
    /// uncapped ABR. Ignored under `cbr`, where the ceiling is the target by
    /// definition.
    #[serde(default)]
    pub max_bitrate: Option<u64>,
    /// VBV buffer in BITS (`-bufsize`). Omitted ⇒ derived from the ceiling by
    /// the encoder registry.
    #[serde(default)]
    pub buffer_size: Option<u64>,
    pub gop: u64,
    pub software: bool,
    /// Empty ⇒ no ffmpeg (byte-count only; used by tests). Non-empty ⇒ encode.
    pub output_path: String,
    /// rawvideo input format the renderer packs: "yuv420p" | "yuv420p10le" |
    /// "yuv422p" | "yuv422p10le". Defaults to yuv420p10le when the caller
    /// omits it.
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

/// Translate the IPC wire shape into the typed, library-agnostic intent at the
/// encoder-registry seam. The registry validates cross-field invariants.
fn encoder_intent(args: &VideoSinkStartArgs) -> Result<EncoderIntent, EncodeUnavailable> {
    let codec = VideoCodec::parse(&args.codec)?;
    let bit_depth = BitDepth::from_raw_pixel_format(&args.pix_fmt)?;
    let rate_control = match codec {
        VideoCodec::Prores => {
            RateControl::ProresProfile(ProresProfile::parse(args.profile.as_deref())?)
        }
        VideoCodec::Dnxhr => {
            RateControl::DnxhrProfile(DnxhrProfile::parse(args.profile.as_deref())?)
        }
        VideoCodec::H264 | VideoCodec::Hevc | VideoCodec::Av1 => match args.crf {
            Some(quality) => RateControl::ConstantQuality { quality },
            None => RateControl::Bitrate {
                target_bps: args.bitrate,
                mode: if args.cbr {
                    BitrateMode::Constant
                } else {
                    BitrateMode::Variable
                },
                max_bps: args.max_bitrate,
                buffer_bits: args.buffer_size,
            },
        },
    };
    Ok(EncoderIntent {
        codec,
        bit_depth,
        acceleration: if args.software {
            Acceleration::Software
        } else {
            Acceleration::Automatic
        },
        rate_control,
        speed: Speed::parse(args.preset.as_deref())?,
        gop_frames: args.gop,
        container: OutputContainer::from_path(Path::new(&args.output_path))?,
    })
}

/// The full ffmpeg argv (minus program name) for one sink run. The sink owns
/// raw-frame input and process lifecycle; every output-side encoder argument
/// comes from the already probed `EncoderPlan`.
pub(crate) fn sink_cmd_args(
    args: &VideoSinkStartArgs,
    plan: &EncoderPlan,
) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;
    let mut a: Vec<OsString> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        OsString::from(&args.pix_fmt),
        "-video_size".into(),
        format!("{}x{}", args.width, args.height).into(),
        "-framerate".into(),
        format!("{}/{}", args.fps_num, args.fps_den).into(),
        "-i".into(),
        "-".into(),
        // Tag the FRAMES (rawvideo carries no colour metadata) so every encoder
        // family emits the full bt709/limited 4-tuple (export_10bit gate).
        "-vf".into(),
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv".into(),
    ];
    a.extend(plan.ffmpeg_args.iter().cloned());
    a.push(OsString::from(&args.output_path));
    a
}

pub async fn export_video_sink_start(
    state: &VideoSinkState,
    registry: &EncoderRegistry,
    log_slot: &LogBusSlot,
    args: VideoSinkStartArgs,
) -> Result<(), String> {
    // An active sink here is always stale (single-export invariant); reclaim it.
    reclaim_stale_sink(&state.0);

    let mut child_opt: Option<Child> = None;
    let mut stdin_opt: Option<ChildStdin> = None;
    let mut stderr_temp: Option<std::process::ChildStderr> = None;

    if !args.output_path.is_empty() {
        let intent = encoder_intent(&args).map_err(|error| error.to_string())?;
        let plan = registry
            .resolve(intent)
            .await
            .map_err(|error| error.to_string())?;
        info!(
            encoder = plan.encoder_name,
            codec = ?plan.codec,
            bit_depth = ?plan.bit_depth,
            acceleration = ?plan.acceleration,
            "video sink resolved encoder plan"
        );
        // Status-log producer: the tracing line above reaches stderr only
        // (the LogBus tracing bridge forwards errors, not info), so the
        // encoder actually selected at runtime was invisible in packaged
        // builds. Surface it in the status log + session JSONL.
        //
        // `ffmpeg` (and, when one exists, `ffmpegShadowRefused`) ride along
        // because WHICH binary answered the probes is the other half of the
        // answer: both times an export silently downgraded to a software
        // encoder, the encoder name alone looked like a hardware failure when
        // the real cause was an exe-adjacent shadow build (issue #7 boundary
        // #7). The shadow can no longer win — see crate::ffmpeg — but naming
        // it here is what makes the misconfiguration self-evident.
        let ffmpeg_bin = crate::ffmpeg::ffmpeg_path();
        let refused_shadow = crate::ffmpeg::refused_shadow();
        log_slot.emit(LogEntryInput {
            level: if refused_shadow.is_some() {
                LogLevel::Warn
            } else {
                LogLevel::Info
            },
            category: LogCategory::Export,
            source: LogSource::System,
            message: format!(
                "Export encoder: {} ({})",
                plan.encoder_name,
                match plan.acceleration {
                    SelectedAcceleration::Hardware => "hardware",
                    SelectedAcceleration::Software => "software",
                }
            ),
            details: Some(serde_json::json!({
                "encoder": plan.encoder_name,
                "codec": format!("{:?}", plan.codec),
                "bitDepth": match plan.bit_depth {
                    BitDepth::Eight => 8,
                    BitDepth::Ten => 10,
                },
                "acceleration": format!("{:?}", plan.acceleration),
                "pixFmt": args.pix_fmt.clone(),
                "size": format!("{}x{}", args.width, args.height),
                "ffmpeg": ffmpeg_bin.display().to_string(),
                "ffmpegShadowRefused": refused_shadow.as_ref().map(|p| p.display().to_string()),
            })),
            ..Default::default()
        });
        let mut cmd = std::process::Command::new(&ffmpeg_bin);
        cmd.no_console_window();
        for arg in sink_cmd_args(&args, &plan) {
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
    info!(
        "video sink started (ipc, output={})",
        !args.output_path.is_empty()
    );
    Ok(())
}

/// Write one raw frame, in the sink's configured rawvideo pix_fmt, to the
/// active sink's ffmpeg stdin (None => byte-count only) and bump the counters
/// reported by finish. The blocking pipe write runs on a blocking thread;
/// awaiting it is the renderer's backpressure.
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
        shared
            .ipc_bytes
            .fetch_add(data.len() as u64, Ordering::Relaxed);
        shared.ipc_frames.fetch_add(1, Ordering::Relaxed);
        Ok(())
    })
    .await
    .map_err(|e| format!("write join: {e}"))?
}

/// Finalize: drop stdin (EOF → ffmpeg finalizes), reap the child directly, and
/// return the IPC counters.
pub async fn export_video_sink_finish(state: &VideoSinkState) -> Result<SinkStats, String> {
    let shared = {
        let mut guard = state.0.lock().unwrap();
        guard.take().ok_or("no active video sink")?.shared
    };
    drop(shared.stdin.lock().unwrap().take());
    let shared_for_wait = shared.clone();
    let status = tokio::task::spawn_blocking(
        move || -> Result<Option<std::process::ExitStatus>, String> {
            let child = shared_for_wait.child.lock().unwrap().take();
            match child {
                Some(mut c) => c.wait().map(Some).map_err(|e| format!("ffmpeg wait: {e}")),
                None => Ok(None),
            }
        },
    )
    .await
    .map_err(|e| format!("finish join: {e}"))??;
    if let Some(st) = status {
        if !st.success() {
            return Err(format!("ffmpeg exited {st}{}", tail_suffix(&shared)));
        }
    }
    let bytes = shared.ipc_bytes.load(Ordering::Relaxed);
    let frames = shared.ipc_frames.load(Ordering::Relaxed);
    // See the `copy_ns` / `write_ns` fields on `SinkShared`.
    let copy_ms = shared.copy_ns.load(Ordering::Relaxed) / 1_000_000;
    let write_ms = shared.write_ns.load(Ordering::Relaxed) / 1_000_000;
    let mb = bytes / 1_048_576;
    let write_mbps = if write_ms > 0 {
        mb * 1000 / write_ms
    } else {
        0
    };
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
        assert!(
            state.lock().unwrap().is_none(),
            "orphaned sink must be reclaimed"
        );
    }

    #[test]
    fn reclaim_is_a_noop_when_no_sink_is_active() {
        let state: Mutex<Option<ActiveSink>> = Mutex::new(None);
        reclaim_stale_sink(&state);
        assert!(state.lock().unwrap().is_none());
    }

    fn args_10bit() -> VideoSinkStartArgs {
        VideoSinkStartArgs {
            width: 1920,
            height: 1080,
            fps_num: 30,
            fps_den: 1,
            codec: "hevc".into(),
            bitrate: 8_000_000,
            cbr: false,
            max_bitrate: None,
            buffer_size: None,
            gop: 30,
            software: true,
            output_path: "C:/tmp/out.mp4".into(),
            pix_fmt: "yuv420p10le".into(),
            crf: None,
            preset: None,
            profile: None,
        }
    }

    fn args_8bit(codec: &str) -> VideoSinkStartArgs {
        VideoSinkStartArgs {
            width: 1920,
            height: 1080,
            fps_num: 30,
            fps_den: 1,
            codec: codec.into(),
            bitrate: 8_000_000,
            cbr: false,
            max_bitrate: None,
            buffer_size: None,
            gop: 30,
            software: true,
            output_path: "C:/tmp/out.mp4".into(),
            pix_fmt: "yuv420p".into(),
            crf: None,
            preset: None,
            profile: None,
        }
    }

    #[test]
    fn wire_args_become_library_agnostic_intent() {
        let mut args = args_10bit();
        args.crf = Some(22);
        args.preset = Some("slow".into());
        let intent = encoder_intent(&args).unwrap();
        assert_eq!(intent.codec, VideoCodec::Hevc);
        assert_eq!(intent.bit_depth, BitDepth::Ten);
        assert_eq!(intent.acceleration, Acceleration::Software);
        assert_eq!(
            intent.rate_control,
            RateControl::ConstantQuality { quality: 22 }
        );
        assert_eq!(intent.speed, Speed::Slow);
        assert_eq!(intent.container, OutputContainer::Mp4);
    }

    // The peak/buffer wire fields land on the Bitrate variant rather than
    // anywhere else on the intent, so CRF mode structurally cannot carry them.
    #[test]
    fn wire_peak_and_buffer_reach_the_bitrate_rate_control() {
        let mut args = args_8bit("h264");
        args.max_bitrate = Some(12_000_000);
        args.buffer_size = Some(6_000_000);
        assert_eq!(
            encoder_intent(&args).unwrap().rate_control,
            RateControl::Bitrate {
                target_bps: 8_000_000,
                mode: BitrateMode::Variable,
                max_bps: Some(12_000_000),
                buffer_bits: Some(6_000_000),
            }
        );

        // CRF wins outright: the whole Bitrate variant (peak and buffer with
        // it) is replaced, so a stale peak can't ride along into a CRF encode.
        args.crf = Some(20);
        assert_eq!(
            encoder_intent(&args).unwrap().rate_control,
            RateControl::ConstantQuality { quality: 20 }
        );
    }

    #[test]
    fn tenbit_pix_fmt_still_defaults_and_gates() {
        // serde default keeps old TS callers valid.
        let v: VideoSinkStartArgs = serde_json::from_str(
            r#"{"width":64,"height":64,"fpsNum":30,"fpsDen":1,
              "codec":"hevc","bitrate":0,"cbr":false,"gop":30,"software":true,
              "outputPath":""}"#,
        )
        .unwrap();
        assert_eq!(v.pix_fmt, "yuv420p10le");
        // Same contract for the rate constraints: a caller that omits them gets
        // the pre-existing uncapped/derived behavior, not a deserialize error.
        assert_eq!(v.max_bitrate, None);
        assert_eq!(v.buffer_size, None);
    }

    // The resolved encoder must be user-reachable, not tracing-stderr-only:
    // start emits one category=Export info entry whose details carry the
    // runtime-selected encoder name (the per-platform capability record's
    // "confirm the encoder actually selected" line reads this). Spawns a
    // real ffmpeg via the sidecar path (like the audio mix roundtrip test);
    // cancel reaps it before asserting.
    #[tokio::test]
    async fn start_logs_the_resolved_encoder_to_the_status_log() {
        let state = VideoSinkState::default();
        let registry = EncoderRegistry::default();
        let slot = LogBusSlot::new();
        let workspace = tempfile::tempdir().expect("tempdir");
        slot.install(crate::logs::LogBus::spawn(
            &workspace.path().to_path_buf(),
            std::sync::Arc::new(crate::events::VecEventSink::new()),
        ));
        let mut args = args_8bit("h264");
        args.width = 64;
        args.height = 64;
        args.output_path = workspace
            .path()
            .join("encoder-log.mp4")
            .to_string_lossy()
            .into_owned();
        export_video_sink_start(&state, &registry, &slot, args)
            .await
            .expect("start");
        export_video_sink_cancel(&state).await.expect("cancel");

        let entries = slot.current().expect("bus installed").list();
        let entry = entries
            .iter()
            .find(|e| e.category == LogCategory::Export)
            .expect("an Export status-log entry");
        assert!(
            entry.message.starts_with("Export encoder: "),
            "unexpected message: {}",
            entry.message
        );
        let encoder = entry
            .details
            .as_ref()
            .and_then(|d| d.get("encoder"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(!encoder.is_empty(), "details.encoder must carry the resolved name");
        // The binary that answered the probes travels with the encoder name:
        // an encoder that "failed" because an exe-adjacent shadow build lacks
        // it (issue #7 boundary #7) is otherwise indistinguishable from one the
        // hardware genuinely cannot do.
        let binary = entry
            .details
            .as_ref()
            .and_then(|d| d.get("ffmpeg"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert_eq!(
            binary,
            crate::ffmpeg::ffmpeg_path().display().to_string(),
            "details.ffmpeg must name the binary the sink actually spawned"
        );
        assert!(
            entry.details.as_ref().is_some_and(|d| d.get("ffmpegShadowRefused").is_some()),
            "details must always carry the shadow slot (null when clean) so its absence is not read as 'not checked'"
        );
    }

    // Unknown codecs are rejected while translating the wire request, before
    // any adapter name can be guessed or any probe can run.
    #[tokio::test]
    async fn start_rejects_vp9_at_8bit() {
        let state = VideoSinkState::default();
        let registry = EncoderRegistry::default();
        let err = export_video_sink_start(&state, &registry, &LogBusSlot::new(), args_8bit("vp9"))
            .await
            .unwrap_err();
        assert!(
            err.contains("invalid encoder intent codec"),
            "unexpected error: {err}"
        );
        assert!(state.0.lock().unwrap().is_none(), "no sink left active");
    }

    // The sink contributes only the rawvideo input half and output path. The
    // registry plan is appended verbatim, with no sink-side reinterpretation.
    #[test]
    fn sink_cmd_args_joins_raw_input_to_the_resolved_plan() {
        let plan = EncoderPlan {
            codec: VideoCodec::Hevc,
            bit_depth: BitDepth::Ten,
            encoder_name: "libx265",
            acceleration: SelectedAcceleration::Software,
            ffmpeg_args: vec![
                "-c:v".into(),
                "libx265".into(),
                "-profile:v".into(),
                "main10".into(),
                "-color_range".into(),
                "tv".into(),
                "-tag:v".into(),
                "hvc1".into(),
            ],
        };
        let argv = sink_cmd_args(&args_10bit(), &plan);
        let s: Vec<String> = argv
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // rawvideo input header
        assert!(s.windows(2).any(|w| w[0] == "-f" && w[1] == "rawvideo"));
        assert!(s
            .windows(2)
            .any(|w| w[0] == "-pix_fmt" && w[1] == "yuv420p10le"));
        assert!(s
            .windows(2)
            .any(|w| w[0] == "-video_size" && w[1] == "1920x1080"));
        assert!(s.windows(2).any(|w| w[0] == "-framerate" && w[1] == "30/1"));
        // frame tagging vf + encoder + 10-bit profile + color tags + hvc1 + output
        assert!(s
            .iter()
            .any(|a| a.starts_with("setparams=colorspace=bt709")));
        assert!(s.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx265"));
        assert!(s
            .windows(2)
            .any(|w| w[0] == "-profile:v" && w[1] == "main10"));
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
        let registry = EncoderRegistry::default();
        export_video_sink_start(
            &state,
            &registry,
            &LogBusSlot::new(),
            VideoSinkStartArgs {
                width: 64,
                height: 64,
                fps_num: 30,
                fps_den: 1,
                codec: "hevc".into(),
                bitrate: 0,
                cbr: false,
                max_bitrate: None,
                buffer_size: None,
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
            video_sink_write(&state, frame.clone(), 0)
                .await
                .expect("write");
        }

        let stats = export_video_sink_finish(&state).await.expect("finish");
        assert_eq!(stats.frames, 5);
        assert_eq!(stats.bytes, 5 * (64 * 64 * 3) as u64);
        assert!(state.0.lock().unwrap().is_none(), "finish clears the sink");
    }
}
