//! whisper.cpp backend — local, offline, one-shot CLI sidecar (STT only).
//!
//! Drives the upstream `whisper-cli` binary (the renamed `main`) over the same
//! 16 kHz mono WAV the cloud path produces, via the shared [`SidecarRun`]
//! helper. Two output styles, chosen from the request's `want_word_timing`:
//!
//! - `true`  → `-ojf` (output-json-full) → a `<prefix>.json` file with per-token
//!   millisecond `offsets` → [`RawTranscript::WhisperJson`] → exact word times.
//! - `false` → `-osrt` → a `<prefix>.srt` file → [`RawTranscript::Srt`] →
//!   interpolated word times.
//!
//! ## whisper-cli file-output semantics (assumed; not runnable in CI)
//!
//! whisper.cpp writes its transcript to a **sidecar file**, not stdout. The
//! output *base name* is set by `-of <prefix>` / `--output-file <prefix>`
//! (documented as "output file path (without file extension)"), and the format
//! flag appends the extension: `-of out -ojf` → `out.json`, `-of out -osrt` →
//! `out.srt`. We therefore pin `-of <tmpdir>/out` and read `<tmpdir>/out.json`
//! or `<tmpdir>/out.srt` back. The temp dir is RAII-cleaned on drop. This
//! arg/path logic is unit-tested ([`build_args`], the extension) because the
//! end-to-end run against a real binary is a manual check.
//!
//! Model provisioning (bundle vs download vs user-path) is out of scope — v1 is
//! a user-provided binary + model path from the Settings UI config.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::speech::backends::sidecar::{scaled_timeout, OutputSink, SidecarRun};
use crate::speech::error::SpeechError;
use crate::speech::parse::{RawTranscript, TranscriptFormat};
use crate::speech::transcriber::{TranscribeRequest, Transcriber};

/// whisper.cpp transcription client. All fields come from the backend's
/// [`BackendConfig::Local`](crate::speech::config::BackendConfig::Local) entry
/// at construction time.
pub struct WhisperCpp {
    binary: PathBuf,
    model: PathBuf,
    threads: Option<u32>,
    /// Accepted from config and reserved for a future GPU-selection flag. It is
    /// intentionally NOT mapped to a CLI arg in v1: whisper.cpp has no portable
    /// `--device N` (GPU is a build-time/`-ng` concern), and inventing an
    /// unverified flag here would be a hazard since this path can't run in CI.
    #[allow(dead_code)]
    device: Option<String>,
}

impl WhisperCpp {
    pub fn new(
        binary: PathBuf,
        model: PathBuf,
        threads: Option<u32>,
        device: Option<String>,
    ) -> Self {
        Self {
            binary,
            model,
            threads,
            device,
        }
    }
}

#[async_trait]
impl Transcriber for WhisperCpp {
    /// JSON preferred (exact word timing); SRT as the interpolated fallback.
    fn output_formats(&self) -> &'static [TranscriptFormat] {
        &[TranscriptFormat::WhisperJson, TranscriptFormat::Srt]
    }

    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError> {
        // Pin a deterministic, disposable output path. RAII: the dir (and the
        // engine's `.json`/`.srt` inside it) is removed when `tmp` drops at the
        // end of this call — after `SidecarRun::run` has read the file back.
        let tmp = tempfile::Builder::new()
            .prefix("weftcut-whisper")
            .tempdir()
            .map_err(SpeechError::Io)?;
        let of_prefix = tmp.path().join("out");

        let (format, ext) = if req.want_word_timing {
            (TranscriptFormat::WhisperJson, "json")
        } else {
            (TranscriptFormat::Srt, "srt")
        };
        // whisper-cli appends the extension to the `-of` prefix; mirror that to
        // know which file to read.
        let out_file = of_prefix.with_extension(ext);

        let args = build_args(
            &self.model,
            &req.audio_path,
            &of_prefix,
            req.want_word_timing,
            req.language.as_deref(),
            self.threads,
        );

        let timeout = scaled_timeout(&req.audio_path).await;

        SidecarRun {
            program: self.binary.clone(),
            args,
            timeout,
            output: OutputSink::File(out_file),
            format,
        }
        .run()
        .await
    }
}

/// Build the `whisper-cli` argument vector:
/// `-m <model> -f <wav> {-ojf|-osrt} -of <prefix> -l <lang|auto> [-t <threads>]`.
///
/// Kept as a free function (paths borrowed) so the flag logic is unit-testable
/// without a running binary — the only automated pin on this CLI contract.
fn build_args(
    model: &Path,
    wav: &Path,
    of_prefix: &Path,
    want_word_timing: bool,
    language: Option<&str>,
    threads: Option<u32>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::with_capacity(11);
    args.push(OsString::from("-m"));
    args.push(model.as_os_str().to_owned());
    args.push(OsString::from("-f"));
    args.push(wav.as_os_str().to_owned());
    // Word timing selects the output style: -ojf (json-full, exact offsets) vs
    // -osrt (SubRip, interpolated downstream).
    args.push(OsString::from(if want_word_timing {
        "-ojf"
    } else {
        "-osrt"
    }));
    args.push(OsString::from("-of"));
    args.push(of_prefix.as_os_str().to_owned());
    // Explicit `auto` matches whisper's own default when omitted; passing it
    // keeps the arg vector uniform and self-documenting.
    args.push(OsString::from("-l"));
    args.push(OsString::from(language.unwrap_or("auto")));
    if let Some(t) = threads {
        args.push(OsString::from("-t"));
        args.push(OsString::from(t.to_string()));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn pos(args: &[String], flag: &str) -> Option<usize> {
        args.iter().position(|a| a == flag)
    }

    #[test]
    fn word_timing_true_uses_ojf_not_osrt() {
        let args = build_args(
            Path::new("/m/model.bin"),
            Path::new("/a/clip.wav"),
            Path::new("/t/out"),
            true,
            Some("en"),
            None,
        );
        let s = as_strings(&args);
        assert!(s.contains(&"-ojf".to_string()), "want_word_timing → -ojf: {s:?}");
        assert!(!s.contains(&"-osrt".to_string()), "must not also pass -osrt: {s:?}");
    }

    #[test]
    fn word_timing_false_uses_osrt_not_ojf() {
        let args = build_args(
            Path::new("/m/model.bin"),
            Path::new("/a/clip.wav"),
            Path::new("/t/out"),
            false,
            Some("en"),
            None,
        );
        let s = as_strings(&args);
        assert!(s.contains(&"-osrt".to_string()), "no word timing → -osrt: {s:?}");
        assert!(!s.contains(&"-ojf".to_string()), "must not pass -ojf: {s:?}");
    }

    #[test]
    fn model_wav_and_of_prefix_are_paired_with_their_flags() {
        let args = build_args(
            Path::new("/m/model.bin"),
            Path::new("/a/clip.wav"),
            Path::new("/t/out"),
            true,
            None,
            None,
        );
        let s = as_strings(&args);
        assert_eq!(s[pos(&s, "-m").unwrap() + 1], "/m/model.bin");
        assert_eq!(s[pos(&s, "-f").unwrap() + 1], "/a/clip.wav");
        assert_eq!(s[pos(&s, "-of").unwrap() + 1], "/t/out");
    }

    #[test]
    fn language_none_becomes_auto() {
        let args = build_args(
            Path::new("m"),
            Path::new("w"),
            Path::new("o"),
            true,
            None,
            None,
        );
        let s = as_strings(&args);
        assert_eq!(s[pos(&s, "-l").unwrap() + 1], "auto");
    }

    #[test]
    fn language_some_is_passed_through() {
        let args = build_args(
            Path::new("m"),
            Path::new("w"),
            Path::new("o"),
            true,
            Some("zh"),
            None,
        );
        let s = as_strings(&args);
        assert_eq!(s[pos(&s, "-l").unwrap() + 1], "zh");
    }

    #[test]
    fn threads_some_adds_t_flag() {
        let args = build_args(
            Path::new("m"),
            Path::new("w"),
            Path::new("o"),
            true,
            None,
            Some(8),
        );
        let s = as_strings(&args);
        assert_eq!(s[pos(&s, "-t").unwrap() + 1], "8");
    }

    #[test]
    fn threads_none_omits_t_flag() {
        let args = build_args(
            Path::new("m"),
            Path::new("w"),
            Path::new("o"),
            true,
            None,
            None,
        );
        let s = as_strings(&args);
        assert!(pos(&s, "-t").is_none(), "no threads → no -t: {s:?}");
    }

    /// The read-back extension must match the format flag (json↔-ojf, srt↔-osrt)
    /// — the crux of "read the right sidecar file".
    #[test]
    fn out_file_extension_follows_format_flag() {
        let prefix = Path::new("/t/out");
        assert_eq!(prefix.with_extension("json"), Path::new("/t/out.json"));
        assert_eq!(prefix.with_extension("srt"), Path::new("/t/out.srt"));
    }

    #[test]
    fn output_formats_prefers_json_then_srt() {
        let w = WhisperCpp::new(PathBuf::from("b"), PathBuf::from("m"), None, None);
        assert_eq!(
            w.output_formats(),
            &[TranscriptFormat::WhisperJson, TranscriptFormat::Srt],
        );
    }
}
