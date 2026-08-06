//! `LlamaMtmdSidecar` — one-shot `llama-mtmd-cli` child, one spawn per clip.
//!
//! Ingests ALL of a clip's sampled frames in a single invocation (model-load
//! cost amortized over the clip) and returns the full description. Disposable-
//! child pattern, matching whisper.cpp; no long-lived server. Shared by BOTH
//! local backends: Qwen3-VL and MiniCPM-V feed the SAME input (frames + injected
//! `<t s>` text markers — spike-proven that MiniCPM-V needs no `temporal_ids`),
//! and differ only in which [`RawDescription`] style the output is tagged as.
//!
//! ## Command shape
//!
//! ```text
//! llama-mtmd-cli -m MODEL --mmproj MMPROJ --image "p1,p2,..." -p PROMPT \
//!   --temp 0.1 -n 768 -ngl 999 -c 8192 --repeat-penalty 1.15 --repeat-last-n 320
//! ```
//!
//! Every knob here is load-bearing and each one's why lives at its own site:
//! [`build_args`] for the `--image` and `--no-display-prompt` landmines, `CTX`
//! and `REPEAT_PENALTY` for the two decoding guards.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use super::describer::{DescribeRequest, Focus, SceneDescriber, TimedFrame};
use super::error::VlmError;
use super::parser::RawDescription;

// ── Validated sampling/decoding knobs (spike.mjs) ───────────────────────────
const TEMP: &str = "0.1";
const N_PREDICT: &str = "768";
const NGL: &str = "999"; // offload all layers when the build has a GPU backend
// MUST cap: the default follows the model's ~256K native ctx and OOMs the KV
// cache even with free VRAM; 8192 fits the downscaled frames + generation.
const CTX: &str = "8192";
// At low temp the model degenerates into repeating the last segment until `-n`,
// truncating the JSON; the penalty curbs the loop (the parser salvages the rest).
const REPEAT_PENALTY: &str = "1.15";
const REPEAT_LAST_N: &str = "320";
/// MTMD default media marker; images substitute in order where it appears.
const MEDIA_MARKER: &str = "<__media__>";

/// Which raw output style this local model produces — decides the
/// [`RawDescription`] tag so the parser layer dispatches correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStyle {
    /// Qwen3-VL: a clean JSON array with discrete keyword tags.
    Qwen3VlJson,
    /// MiniCPM-V: JSON array with underscore-joined tags + a trailing empty
    /// segment (needs the splitting parser).
    MiniCpmVText,
}

/// One-shot local video-understanding sidecar. Fields come from the backend's
/// [`BackendConfig::Local`](super::config::BackendConfig::Local) entry.
pub struct LlamaMtmdSidecar {
    binary: PathBuf,
    model: PathBuf,
    mmproj: PathBuf,
    /// Reserved GPU-selection hint; not mapped to a CLI arg in v1 (llama.cpp has
    /// no portable per-invocation device flag, and this path can't run in CI).
    #[allow(dead_code)]
    device: Option<String>,
    style: OutputStyle,
}

impl LlamaMtmdSidecar {
    pub fn new(
        binary: PathBuf,
        model: PathBuf,
        mmproj: PathBuf,
        device: Option<String>,
        style: OutputStyle,
    ) -> Self {
        Self { binary, model, mmproj, device, style }
    }
}

#[async_trait]
impl SceneDescriber for LlamaMtmdSidecar {
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError> {
        let prompt = build_prompt(&req.frames, req.focus);
        let args = build_args(&self.model, &self.mmproj, &req.frames, &prompt);
        let timeout = sidecar_timeout(req.frames.len());
        let body = run(&self.binary, &args, timeout).await?;
        Ok(match self.style {
            OutputStyle::Qwen3VlJson => RawDescription::JsonArray(body),
            OutputStyle::MiniCpmVText => RawDescription::MiniCpmVText(body),
        })
    }
}

/// Build the timestamp-annotated multi-image prompt: interleaved `Frame at <t>s:`
/// text + one `<__media__>` marker per frame (images substitute in order), then
/// the JSON-array output instruction. `focus` biases what populates `tags`.
/// Mirrors `spike.mjs:buildPrompt` (validated on Qwen3-VL AND MiniCPM-V).
pub fn build_prompt(frames: &[TimedFrame], focus: Focus) -> String {
    let mut lines = vec![
        "You are analyzing frames sampled from a single video clip.".to_string(),
        "Each frame below is labeled with its exact timestamp in seconds.".to_string(),
        "Describe what is happening across the clip as a timeline.".to_string(),
        String::new(),
    ];
    for f in frames {
        lines.push(format!("Frame at {:.2}s:", f.t_us as f64 / 1_000_000.0));
        lines.push(MEDIA_MARKER.to_string());
        lines.push(String::new());
    }
    lines.push("Return ONLY a JSON array, no prose. Each element:".to_string());
    lines.push(
        r#"{"t_start": <seconds>, "t_end": <seconds>, "text": "<what happens>", "tags": ["<keyword>", ...]}"#
            .to_string(),
    );
    lines.push("Rules:".to_string());
    lines.push("- t_start and t_end MUST be chosen from the frame timestamps listed above.".to_string());
    lines.push("- Merge adjacent frames that show the same action/scene into one segment.".to_string());
    lines.push(match focus {
        Focus::General => {
            "- tags: short visual keywords (subjects, setting, camera motion, shot type)."
        }
        Focus::ShotType => {
            "- tags: emphasize shot type and camera (e.g. close-up, wide, low-angle, pan, static, handheld)."
        }
    }.to_string());
    lines.join("\n")
}

/// Build the `llama-mtmd-cli` argument vector. Free function (paths borrowed) so
/// the CLI contract — comma-joined `--image`, the capped `-c`, the repeat
/// penalty — is unit-testable without a running binary (the only automated pin
/// on this contract; the end-to-end run needs a GPU + a multi-GB model).
///
/// Landmine: never add `--no-display-prompt` — it is an invalid arg in this
/// build and the child fails; the parser strips the prompt echo instead.
pub fn build_args(
    model: &Path,
    mmproj: &Path,
    frames: &[TimedFrame],
    prompt: &str,
) -> Vec<OsString> {
    // Landmine: ONE comma-separated --image value; repeated --image keeps only
    // the last. Frame paths live in a temp dir and contain no commas.
    let mut image = OsString::new();
    for (i, f) in frames.iter().enumerate() {
        if i > 0 {
            image.push(",");
        }
        image.push(f.path.as_os_str());
    }

    let mut args: Vec<OsString> = Vec::with_capacity(18);
    args.push("-m".into());
    args.push(model.as_os_str().to_owned());
    args.push("--mmproj".into());
    args.push(mmproj.as_os_str().to_owned());
    args.push("--image".into());
    args.push(image);
    args.push("-p".into());
    args.push(prompt.into());
    args.push("--temp".into());
    args.push(TEMP.into());
    args.push("-n".into());
    args.push(N_PREDICT.into());
    args.push("-ngl".into());
    args.push(NGL.into());
    args.push("-c".into());
    args.push(CTX.into());
    args.push("--repeat-penalty".into());
    args.push(REPEAT_PENALTY.into());
    args.push("--repeat-last-n".into());
    args.push(REPEAT_LAST_N.into());
    args
}

/// A generous hang-guard timeout — NOT the expected runtime, a ceiling that
/// kills a wedged child. Cold start pays model-load + shader compile (~40s), and
/// an 8B on CPU can run tens of seconds per frame, so allow a large floor plus
/// per-frame headroom.
fn sidecar_timeout(n_frames: usize) -> Duration {
    const FLOOR_SECS: u64 = 300;
    const PER_FRAME_SECS: u64 = 20;
    Duration::from_secs(FLOOR_SECS + (n_frames as u64).saturating_mul(PER_FRAME_SECS))
}

/// Spawn the one-shot child, wait (bounded by `timeout`), capture stdout as the
/// raw body. Mirrors `speech::backends::sidecar::SidecarRun::run`: conhost guard,
/// `kill_on_drop` (a timed-out future drops the child → reaped), exit-code →
/// [`VlmError`] mapping.
async fn run(program: &Path, args: &[OsString], timeout: Duration) -> Result<String, VlmError> {
    let child = Command::new(program)
        .no_console_window()
        .kill_on_drop(true)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| VlmError::Spawn {
            program: program.display().to_string(),
            cause: e.to_string(),
        })?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(VlmError::Io(e)),
        Err(_elapsed) => {
            return Err(VlmError::Timeout {
                secs: timeout.as_secs(),
            })
        }
    };
    if !output.status.success() {
        return Err(VlmError::EngineExit {
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(t_us: i64, name: &str) -> TimedFrame {
        TimedFrame { t_us, path: PathBuf::from(name) }
    }

    fn as_strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }
    fn after(args: &[String], flag: &str) -> String {
        let i = args.iter().position(|a| a == flag).expect("flag present");
        args[i + 1].clone()
    }

    #[test]
    fn images_are_one_comma_separated_arg() {
        let frames = vec![frame(0, "a.png"), frame(1_000_000, "b.png"), frame(2_000_000, "c.png")];
        let args = build_args(Path::new("/m.gguf"), Path::new("/mm.gguf"), &frames, "P");
        let s = as_strings(&args);
        // Exactly one --image flag, value is the comma-joined list.
        assert_eq!(s.iter().filter(|a| *a == "--image").count(), 1);
        assert_eq!(after(&s, "--image"), "a.png,b.png,c.png");
    }

    #[test]
    fn encodes_every_spike_landmine() {
        let frames = vec![frame(0, "a.png")];
        let s = as_strings(&build_args(Path::new("/m.gguf"), Path::new("/mm.gguf"), &frames, "P"));
        assert_eq!(after(&s, "-m"), "/m.gguf");
        assert_eq!(after(&s, "--mmproj"), "/mm.gguf");
        assert_eq!(after(&s, "-c"), "8192"); // capped context (KV-OOM guard)
        assert_eq!(after(&s, "--temp"), "0.1");
        assert_eq!(after(&s, "-n"), "768");
        assert_eq!(after(&s, "--repeat-penalty"), "1.15");
        assert_eq!(after(&s, "--repeat-last-n"), "320");
        // No --no-display-prompt (invalid in this build).
        assert!(!s.iter().any(|a| a == "--no-display-prompt"));
    }

    #[test]
    fn prompt_interleaves_one_marker_per_frame_with_timestamps() {
        let frames = vec![frame(0, "a.png"), frame(2_500_000, "b.png")];
        let p = build_prompt(&frames, Focus::General);
        assert_eq!(p.matches(MEDIA_MARKER).count(), 2);
        assert!(p.contains("Frame at 0.00s:"));
        assert!(p.contains("Frame at 2.50s:"));
        assert!(p.contains("Return ONLY a JSON array"));
    }

    #[test]
    fn shot_type_focus_changes_the_tag_instruction() {
        let frames = vec![frame(0, "a.png")];
        let general = build_prompt(&frames, Focus::General);
        let shot = build_prompt(&frames, Focus::ShotType);
        assert!(general.contains("subjects, setting"));
        assert!(shot.contains("shot type and camera"));
    }

    #[test]
    fn timeout_scales_with_frame_count() {
        assert!(sidecar_timeout(16) > sidecar_timeout(1));
        assert!(sidecar_timeout(0).as_secs() >= 300);
    }

    /// Opt-in LIVE smoke of the whole local path — frame extraction → the exact
    /// `llama-mtmd-cli` command → stdout capture → parser. `#[ignore]` by default
    /// (needs a GPU-class machine + a multi-GB GGUF), same stance as the
    /// real-ffmpeg smokes. Set the four `WEFTCUT_VLM_*` env vars and run:
    /// `cargo test --features test-noop -- --ignored --nocapture live_qwen_describe`.
    #[tokio::test]
    #[ignore = "live: needs llama-mtmd-cli + Qwen GGUF + mmproj + a video (WEFTCUT_VLM_* env)"]
    async fn live_qwen_describe() {
        use super::super::describer::{DescribeRequest, Focus};
        use super::super::frame_extract::{plan_anchors, sample_frames};
        use super::super::parser::parse_raw;

        let (Ok(cli), Ok(model), Ok(mmproj), Ok(video)) = (
            std::env::var("WEFTCUT_VLM_CLI"),
            std::env::var("WEFTCUT_VLM_MODEL"),
            std::env::var("WEFTCUT_VLM_MMPROJ"),
            std::env::var("WEFTCUT_VLM_VIDEO"),
        ) else {
            eprintln!("live_qwen_describe skipped — set WEFTCUT_VLM_CLI/MODEL/MMPROJ/VIDEO");
            return;
        };

        let tmp = tempfile::tempdir().unwrap();
        // Sample the first 8 seconds at 1 fps (window-relative anchors).
        let anchors = plan_anchors(0, 8_000_000, 1.0);
        let frames = sample_frames(std::path::Path::new(&video), 0, tmp.path(), &anchors)
            .await
            .expect("frame sampling");
        eprintln!("live_qwen_describe: extracted {} frames", frames.len());

        let sidecar = LlamaMtmdSidecar::new(
            cli.into(),
            model.into(),
            mmproj.into(),
            None,
            OutputStyle::Qwen3VlJson,
        );
        let raw = sidecar
            .describe(DescribeRequest { frames, focus: Focus::General })
            .await
            .expect("describe");
        let segs = parse_raw(raw).expect("parse");
        eprintln!("live_qwen_describe: {} segments", segs.len());
        for s in &segs {
            eprintln!(
                "  [{:.2}s..{:.2}s] {}  tags={:?}",
                s.t_start_us as f64 / 1e6,
                s.t_end_us as f64 / 1e6,
                s.text,
                s.tags
            );
        }
        assert!(!segs.is_empty(), "expected at least one described segment");
    }
}
