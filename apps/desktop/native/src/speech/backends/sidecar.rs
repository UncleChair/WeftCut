//! Shared one-shot CLI-sidecar transcription helper.
//!
//! Every *local* speech backend (whisper.cpp, FunASR via sherpa-onnx) has the
//! same shape: feed the `extract_audio_window` 16 kHz mono
//! WAV to a spawned CLI child, wait for it to finish, and read one transcript
//! body back — either off stdout or out of a sidecar file the engine wrote.
//! This module owns everything that MUST be identical across those engines and
//! is easy to get wrong per-backend:
//!
//! - **conhost suppression** (`no_console_window`);
//! - **`kill_on_drop(true)`** (the same landmine as ffmpeg in `jobs/hwaccel.rs`);
//! - the **timeout kill** and the **exit-code → [`SpeechError`]** mapping.
//!
//! A backend supplies only the binary, the built argument vector, where the
//! body lands ([`OutputSink`]), and which [`RawTranscript`] variant to tag it
//! as — both engines reuse [`SidecarRun`] and [`probe_liveness`] verbatim.
//!
//! Parsing/normalization is deliberately NOT here — the returned
//! [`RawTranscript`] is handed to [`parse_raw`](crate::speech::parse::parse_raw)
//! untouched, so ms/centisecond unit contracts stay owned by the parser layer.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::process::NoConsoleWindow;
use crate::speech::error::SpeechError;
use crate::speech::parse::{RawTranscript, TranscriptFormat};

/// Where a sidecar deposits its transcript body.
pub enum OutputSink {
    /// The engine prints the transcript to stdout; the helper captures it.
    Stdout,
    /// The engine writes a sidecar file at this exact path; the helper reads it
    /// back after a successful exit. whisper.cpp's `-of <prefix>` + `-ojf` /
    /// `-osrt` lands here (the format flag appends `.json` / `.srt`).
    File(PathBuf),
}

/// A fully-specified one-shot sidecar transcription run.
pub struct SidecarRun {
    /// The CLI binary to spawn (e.g. `whisper-cli`).
    pub program: PathBuf,
    /// The complete, ordered argument vector.
    pub args: Vec<OsString>,
    /// Hang-guard: kill the child and error with [`SpeechError::Timeout`] if it
    /// runs longer than this. See [`scaled_timeout`].
    pub timeout: Duration,
    /// Where the transcript body will be read from.
    pub output: OutputSink,
    /// Which [`RawTranscript`] variant to tag the body as — must match what the
    /// engine's flags produce (whisper `-ojf` → [`TranscriptFormat::WhisperJson`]).
    pub format: TranscriptFormat,
}

impl SidecarRun {
    /// Spawn, wait (bounded by `timeout`), and return the tagged
    /// [`RawTranscript`]. Errors: [`SpeechError::Spawn`] if the child cannot
    /// start, [`SpeechError::Timeout`] if it overruns, [`SpeechError::EngineExit`]
    /// on a non-zero exit.
    pub async fn run(self) -> Result<RawTranscript, SpeechError> {
        let mut cmd = Command::new(&self.program);
        cmd.no_console_window() // Windows: no conhost flash under Electron.
            .kill_on_drop(true) // dropped future (timeout/cancel) reaps the child.
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(match self.output {
                OutputSink::Stdout => Stdio::piped(),
                OutputSink::File(_) => Stdio::null(),
            })
            .stderr(Stdio::piped());

        let child = cmd.spawn().map_err(|e| SpeechError::Spawn {
            program: self.program.display().to_string(),
            cause: e.to_string(),
        })?;

        // `wait_with_output` consumes the `Child` (it is moved into this
        // future). If `timeout` elapses, tokio drops the future → drops the
        // owned `Child` → `kill_on_drop` kills the process. That is why the
        // `Err(_elapsed)` arm needs no explicit `.kill()`.
        let output = match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(SpeechError::Io(e)),
            Err(_elapsed) => {
                return Err(SpeechError::Timeout {
                    secs: self.timeout.as_secs(),
                })
            }
        };

        exit_result(output.status.success(), output.status.code(), &output.stderr)?;
        let body = read_body(&self.output, &output.stdout).await?;
        Ok(wrap(self.format, body))
    }
}

/// Liveness probe for a local sidecar: spawn `<program> <args>` (typically
/// `--help`) and treat "the process started and finished within `timeout`" as
/// alive. The exit code is **ignored on purpose** — `--help` / `--version`
/// conventions differ across engines and builds, so this only distinguishes a
/// runnable binary from a bad path / wrong arch ([`SpeechError::Spawn`]) or a
/// wedged binary ([`SpeechError::Timeout`]). Used by `probe_backend`'s
/// Settings "Test" button; reusable by any local engine.
pub async fn probe_liveness(
    program: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<(), SpeechError> {
    let mut cmd = Command::new(program);
    cmd.no_console_window()
        .kill_on_drop(true)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| SpeechError::Spawn {
        program: program.display().to_string(),
        cause: e.to_string(),
    })?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(SpeechError::Io(e)),
        Err(_elapsed) => Err(SpeechError::Timeout {
            secs: timeout.as_secs(),
        }),
    }
}

/// Classify a finished child's status into success or [`SpeechError::EngineExit`].
/// Pure so the mapping is unit-testable without spawning a real engine.
fn exit_result(success: bool, code: Option<i32>, stderr: &[u8]) -> Result<(), SpeechError> {
    if success {
        Ok(())
    } else {
        Err(SpeechError::EngineExit {
            code,
            stderr: String::from_utf8_lossy(stderr).trim().to_string(),
        })
    }
}

/// Read the transcript body from wherever the engine put it. For
/// [`OutputSink::File`] a missing file (engine exited OK but wrote nothing we
/// can find) surfaces as an `Io` error naming the path, rather than a bare
/// "file not found".
async fn read_body(output: &OutputSink, stdout: &[u8]) -> Result<String, SpeechError> {
    match output {
        OutputSink::Stdout => Ok(String::from_utf8_lossy(stdout).into_owned()),
        OutputSink::File(path) => tokio::fs::read_to_string(path).await.map_err(|e| {
            SpeechError::Io(std::io::Error::new(
                e.kind(),
                format!("read engine output {}: {e}", path.display()),
            ))
        }),
    }
}

/// Tag a raw body with its declared style.
fn wrap(format: TranscriptFormat, body: String) -> RawTranscript {
    match format {
        TranscriptFormat::Srt => RawTranscript::Srt(body),
        TranscriptFormat::WhisperJson => RawTranscript::WhisperJson(body),
        TranscriptFormat::FunAsrJson => RawTranscript::FunAsrJson(body),
    }
}

/// A generous hang-guard timeout scaled to the clip length — NOT the expected
/// runtime, a ceiling that kills a wedged child. 16 kHz mono `pcm_s16le` is
/// 32 KB/s (see [`audio_extract`](crate::speech::audio_extract)), so we recover
/// the clip's seconds from the WAV size and allow 10× realtime on top of a 60 s
/// floor: whisper.cpp on CPU with a large model runs near realtime, so 10× is
/// comfortable headroom and small models finish far inside it. Shared by every
/// local sidecar since they all consume the same WAV. A stat failure falls back
/// to the floor (never zero).
pub async fn scaled_timeout(wav_path: &Path) -> Duration {
    let bytes = tokio::fs::metadata(wav_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    scaled_timeout_from_bytes(bytes)
}

fn scaled_timeout_from_bytes(wav_bytes: u64) -> Duration {
    const BYTES_PER_SEC: u64 = 32_000; // 16 kHz * 1 ch * 2 bytes/sample
    const WAV_HEADER_BYTES: u64 = 44;
    const FLOOR_SECS: u64 = 60;
    const REALTIME_FACTOR: u64 = 10;
    let audio_secs = wav_bytes.saturating_sub(WAV_HEADER_BYTES) / BYTES_PER_SEC;
    Duration::from_secs(FLOOR_SECS + audio_secs.saturating_mul(REALTIME_FACTOR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_exit_is_success() {
        assert!(exit_result(true, Some(0), b"").is_ok());
    }

    #[test]
    fn nonzero_exit_maps_to_engine_exit_with_code_and_stderr() {
        let err = exit_result(false, Some(3), b"  model load failed\n").expect_err("nonzero");
        match err {
            SpeechError::EngineExit { code, stderr } => {
                assert_eq!(code, Some(3));
                assert_eq!(stderr, "model load failed"); // trimmed
            }
            other => panic!("expected EngineExit, got {other:?}"),
        }
    }

    #[test]
    fn signal_kill_maps_to_engine_exit_with_no_code() {
        // A child killed by a signal reports `status.code() == None`.
        let err = exit_result(false, None, b"killed").expect_err("no code");
        match err {
            SpeechError::EngineExit { code: None, .. } => {}
            other => panic!("expected EngineExit{{code:None}}, got {other:?}"),
        }
    }

    #[test]
    fn wrap_tags_body_by_format() {
        assert_eq!(
            wrap(TranscriptFormat::Srt, "body".into()),
            RawTranscript::Srt("body".into()),
        );
        assert_eq!(
            wrap(TranscriptFormat::WhisperJson, "{}".into()),
            RawTranscript::WhisperJson("{}".into()),
        );
        assert_eq!(
            wrap(TranscriptFormat::FunAsrJson, "{}".into()),
            RawTranscript::FunAsrJson("{}".into()),
        );
    }

    #[tokio::test]
    async fn read_body_stdout_returns_captured_bytes() {
        let body = read_body(&OutputSink::Stdout, b"hello stdout")
            .await
            .expect("stdout body");
        assert_eq!(body, "hello stdout");
    }

    /// The whisper.cpp file-output path: an engine writes a `-ojf` sidecar file;
    /// we read it back verbatim, wrap it, and it parses to exact word times.
    /// Exercises read → wrap → `parse_raw` without spawning a real engine.
    #[tokio::test]
    async fn read_body_file_then_wrap_parses_exact_words() {
        use crate::speech::parse::parse_raw;
        use crate::speech::transcript::WordTiming;

        const OJF: &str = r#"{
            "result": { "language": "en" },
            "transcription": [
                { "offsets": { "from": 0, "to": 2000 }, "text": " Hi there",
                  "tokens": [
                    { "text": " Hi",    "offsets": { "from": 0,    "to": 900 } },
                    { "text": " there", "offsets": { "from": 900,  "to": 2000 } }
                  ] }
            ]
        }"#;
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.json");
        std::fs::write(&out, OJF).unwrap();

        let body = read_body(&OutputSink::File(out), &[])
            .await
            .expect("read sidecar file");
        let raw = wrap(TranscriptFormat::WhisperJson, body);
        assert!(matches!(raw, RawTranscript::WhisperJson(_)));

        let t = parse_raw(raw).expect("parse");
        assert_eq!(t.word_timing, WordTiming::Exact);
        assert_eq!(t.segments[0].words.len(), 2);
        assert_eq!(t.segments[0].words[0].text, "Hi");
        assert_eq!(t.segments[0].words[0].t_end_us, 900_000); // 900 ms → µs
    }

    #[tokio::test]
    async fn read_body_missing_file_errors_with_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        let err = read_body(&OutputSink::File(missing.clone()), &[])
            .await
            .expect_err("missing file");
        let msg = format!("{err}");
        assert!(msg.contains("nope.json"), "error should name the path: {msg}");
    }

    #[test]
    fn scaled_timeout_has_a_floor_and_scales_with_length() {
        // Empty/tiny WAV → floor only.
        assert_eq!(scaled_timeout_from_bytes(0).as_secs(), 60);
        assert_eq!(scaled_timeout_from_bytes(44).as_secs(), 60);
        // 10 s of audio = 44-byte header + 10 * 32_000 = 320_044 bytes →
        // 60 + 10*10 = 160 s.
        assert_eq!(scaled_timeout_from_bytes(44 + 320_000).as_secs(), 160);
        // Longer clip → strictly larger ceiling (monotonic).
        assert!(scaled_timeout_from_bytes(44 + 3_200_000) > scaled_timeout_from_bytes(44 + 320_000));
    }
}
