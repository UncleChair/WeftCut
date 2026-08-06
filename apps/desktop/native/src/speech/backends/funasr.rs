//! FunASR (Paraformer-zh) backend — local, offline, one-shot CLI sidecar via the
//! sherpa-onnx (k2-fsa) prebuilt `sherpa-onnx-offline` binary (STT only).
//!
//! Same shape as [`WhisperCpp`](super::whisper_cpp): feed the
//! `extract_audio_window` 16 kHz mono WAV to a spawned child through the shared
//! [`SidecarRun`] helper and read one transcript body back. Unlike whisper.cpp,
//! sherpa prints its result JSON to **stdout** (the filename + logs go to
//! stderr), so this uses [`OutputSink::Stdout`] and returns
//! [`RawTranscript::FunAsrJson`] for
//! [`FunAsrParser`](crate::speech::parse::funasr_json::FunAsrParser) to normalize
//! (per-token = per-character exact word timing).
//!
//! The `sherpa-onnx-offline` CLI contract (flag spellings, `--flag=value` form,
//! WAV as trailing positional) is owned and unit-tested at [`build_args`] — an
//! end-to-end run against a real binary is a manual check, never CI.
//! Punctuation / VAD are separate sherpa models, not wired in v1 (tokens +
//! Paraformer only).
//!
//! Model/tokens provisioning (bundle vs download vs user-path) is out of scope —
//! v1 is a user-provided binary + model + tokens path from the Settings UI
//! config.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::speech::backends::sidecar::{scaled_timeout, OutputSink, SidecarRun};
use crate::speech::error::SpeechError;
use crate::speech::parse::{RawTranscript, TranscriptFormat};
use crate::speech::transcriber::{TranscribeRequest, Transcriber};

/// sherpa-onnx-offline (FunASR Paraformer) transcription client. All fields come
/// from the backend's
/// [`BackendConfig::Local`](crate::speech::config::BackendConfig::Local) entry at
/// construction time; `tokens` is required (the resolver only constructs FunASR
/// once its `tokens.txt` is present — see `construct_transcriber`).
pub struct FunAsr {
    binary: PathBuf,
    model: PathBuf,
    tokens: PathBuf,
    threads: Option<u32>,
    /// Accepted from config and reserved for a future device-selection flag. It
    /// is intentionally NOT mapped to a CLI arg in v1: sherpa's provider
    /// selection is a build/provider concern, not a portable CLI flag, and
    /// inventing an unverified one here would be a hazard since this path can't
    /// run in CI (same stance as whisper.cpp).
    #[allow(dead_code)]
    device: Option<String>,
}

impl FunAsr {
    pub fn new(
        binary: PathBuf,
        model: PathBuf,
        tokens: PathBuf,
        threads: Option<u32>,
        device: Option<String>,
    ) -> Self {
        Self {
            binary,
            model,
            tokens,
            threads,
            device,
        }
    }
}

#[async_trait]
impl Transcriber for FunAsr {
    async fn transcribe(&self, req: TranscribeRequest) -> Result<RawTranscript, SpeechError> {
        // sherpa-onnx-offline is language-agnostic per model (Paraformer-zh is
        // Mandarin), so the request's `language` hint has no CLI flag here — the
        // model choice IS the language. `want_word_timing` is likewise implicit:
        // the JSON always carries per-token timestamps (Exact).
        let args = build_args(&self.model, &self.tokens, &req.audio_path, self.threads);
        let timeout = scaled_timeout(&req.audio_path).await;

        SidecarRun {
            program: self.binary.clone(),
            args,
            timeout,
            output: OutputSink::Stdout, // sherpa prints the result JSON to stdout
            format: TranscriptFormat::FunAsrJson,
        }
        .run()
        .await
    }
}

/// Build the `sherpa-onnx-offline` argument vector:
/// `--paraformer=<model> --tokens=<tokens> [--num-threads=<n>] <wav>`.
///
/// sherpa takes `--flag=value` form and the WAV as a trailing positional. Kept a
/// free function (paths borrowed) so the flag logic is unit-testable without a
/// running binary — the only automated pin on this CLI contract.
fn build_args(model: &Path, tokens: &Path, wav: &Path, threads: Option<u32>) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::with_capacity(4);
    args.push(eq_arg("--paraformer=", model.as_os_str()));
    args.push(eq_arg("--tokens=", tokens.as_os_str()));
    if let Some(t) = threads {
        args.push(OsString::from(format!("--num-threads={t}")));
    }
    // The WAV is the trailing positional argument.
    args.push(wav.as_os_str().to_owned());
    args
}

/// Join a `--flag=` prefix with an OS path value WITHOUT a lossy UTF-8 round-trip
/// (paths may be non-UTF-8), so the child sees the exact bytes the OS returned.
fn eq_arg(flag: &str, value: &OsStr) -> OsString {
    let mut s = OsString::from(flag);
    s.push(value);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn paraformer_and_tokens_flags_use_eq_form_with_their_paths() {
        let args = build_args(
            Path::new("/m/paraformer.onnx"),
            Path::new("/m/tokens.txt"),
            Path::new("/a/clip.wav"),
            None,
        );
        let s = as_strings(&args);
        assert!(
            s.contains(&"--paraformer=/m/paraformer.onnx".to_string()),
            "model behind --paraformer=: {s:?}"
        );
        assert!(
            s.contains(&"--tokens=/m/tokens.txt".to_string()),
            "tokens behind --tokens=: {s:?}"
        );
    }

    #[test]
    fn wav_is_the_trailing_positional_argument() {
        let args = build_args(
            Path::new("/m/model.onnx"),
            Path::new("/m/tokens.txt"),
            Path::new("/a/clip.wav"),
            Some(4),
        );
        let s = as_strings(&args);
        assert_eq!(s.last().unwrap(), "/a/clip.wav", "wav must be last: {s:?}");
        // ...and it must NOT carry a flag prefix.
        assert!(!s.last().unwrap().starts_with("--"));
    }

    #[test]
    fn threads_some_adds_num_threads_eq_flag() {
        let args = build_args(
            Path::new("m"),
            Path::new("tk"),
            Path::new("w"),
            Some(8),
        );
        let s = as_strings(&args);
        assert!(
            s.contains(&"--num-threads=8".to_string()),
            "threads → --num-threads=8: {s:?}"
        );
    }

    #[test]
    fn threads_none_omits_num_threads_flag() {
        let args = build_args(Path::new("m"), Path::new("tk"), Path::new("w"), None);
        let s = as_strings(&args);
        assert!(
            !s.iter().any(|a| a.starts_with("--num-threads")),
            "no threads → no --num-threads: {s:?}"
        );
    }

}
