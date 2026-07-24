//! The speech-backend catalog: the enum of engines we know how to drive, their
//! locality (cloud vs local sidecar), capability surfaces, and the default
//! order the resolver falls back through.
//!
//! HARD CONSTRAINT — `SpeechBackend::OpenAi.as_str()` is `"openai"` and that
//! string is a wire + on-disk contract: it is the `Backend.speech_config` map
//! key, the `set_cloud_key("openai", …)` argument pushed in from TS, the
//! Settings status command's `provider` field, and the key format persisted in
//! `cloud_keys.json`. Do NOT change it. New backends use `"whisper_cpp"` /
//! `"funasr"`.
//!
//! Config material (the API key, or a local engine's binary/model paths) lives
//! in [`super::config`]; this module is only the backend identity + its static
//! facts. Selection + availability is [`super::resolve_transcriber`] /
//! [`super::config::availability`].

use serde::{Deserialize, Serialize};

/// Speech engines WeftCut can drive. `OpenAi` is a cloud HTTP API (one key
/// activates Whisper transcription + tts-1 synthesis); `WhisperCpp` and
/// `FunAsr` are local one-shot CLI sidecars (transcription only, needing a
/// binary + model on disk).
///
/// The serde `rename_all = "kebab-case"` derive is carried over unchanged from
/// the pre-rename `Provider` enum to keep any serialized form identical — note
/// that the serde tag (`"open-ai"`) is deliberately distinct from the stable
/// map/wire tag [`SpeechBackend::as_str`] (`"openai"`); callers key the config
/// map and IPC by `as_str`, never by the serde form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpeechBackend {
    /// OpenAI API. One key activates both Whisper transcription and tts-1
    /// synthesis, so the user configures a single credential.
    OpenAi,
    /// whisper.cpp — local offline transcription CLI (STT only).
    WhisperCpp,
    /// FunASR Paraformer via the sherpa-onnx offline CLI (STT only).
    FunAsr,
}

/// Where a backend runs. Drives the availability check: a cloud backend needs
/// an API key; a local backend needs its binary + model file present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locality {
    Cloud,
    Local,
}

/// The order the resolver walks after honoring the caller's `preferred` hint.
/// All three backends have working impls (OpenAI cloud; whisper.cpp / FunASR
/// CLI sidecars). OpenAI leads: with both a key and a local engine configured
/// and no preference set, cloud wins — it needs no local model download and
/// its quality is the known baseline; users who want local-first say so via
/// the Settings preferred engine.
pub const DEFAULT_ORDER: &[SpeechBackend] = &[
    SpeechBackend::OpenAi,
    SpeechBackend::WhisperCpp,
    SpeechBackend::FunAsr,
];

impl SpeechBackend {
    /// Stable string tag — the `speech_config` map key AND the TS/napi wire
    /// contract. `OpenAi` MUST stay `"openai"` (see the module HARD CONSTRAINT).
    pub fn as_str(self) -> &'static str {
        match self {
            SpeechBackend::OpenAi => "openai",
            SpeechBackend::WhisperCpp => "whisper_cpp",
            SpeechBackend::FunAsr => "funasr",
        }
    }

    /// Human-facing label for the Settings row / Test button.
    pub fn label(self) -> &'static str {
        match self {
            SpeechBackend::OpenAi => "OpenAI (Whisper)",
            SpeechBackend::WhisperCpp => "whisper.cpp (local)",
            SpeechBackend::FunAsr => "FunASR (local)",
        }
    }

    /// Every backend we know about, in the default resolution order.
    pub fn all() -> &'static [SpeechBackend] {
        DEFAULT_ORDER
    }

    /// Cloud (HTTP, key-gated) vs Local (spawned CLI, file-gated).
    pub fn locality(self) -> Locality {
        match self {
            SpeechBackend::OpenAi => Locality::Cloud,
            SpeechBackend::WhisperCpp | SpeechBackend::FunAsr => Locality::Local,
        }
    }

    /// Which capability surfaces this backend can serve. The resolver walks
    /// [`DEFAULT_ORDER`], filters by the requested capability, requires
    /// `availability == Available`, and returns the first match — so a single
    /// OpenAI key still activates both transcription and TTS with no per-surface
    /// configuration on the user side.
    pub fn capabilities(self) -> Capabilities {
        match self {
            SpeechBackend::OpenAi => Capabilities {
                transcription: true,
                tts: true,
                // response_format=srt only — word times are interpolated
                // downstream, never engine-exact.
                exact_word_timing: false,
            },
            SpeechBackend::WhisperCpp => Capabilities {
                transcription: true,
                tts: false,
                exact_word_timing: true, // -ojf per-token offsets
            },
            SpeechBackend::FunAsr => Capabilities {
                transcription: true,
                tts: false,
                exact_word_timing: true, // per-token (per-character) timestamps
            },
        }
    }
}

/// Per-backend declaration of which capability surfaces are reachable through
/// it. A transcription-only local engine is `transcription: true, tts: false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub transcription: bool,
    pub tts: bool,
    /// Whether the engine reports per-word/token timestamps itself
    /// (`WordTiming::Exact`), as opposed to word times interpolated from cue
    /// spans. A static fact of the engine's output format — shown as a badge
    /// in Settings so users choosing an engine can see it.
    pub exact_word_timing: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_tags_are_stable() {
        // Wire/on-disk contract — must never drift.
        assert_eq!(SpeechBackend::OpenAi.as_str(), "openai");
        assert_eq!(SpeechBackend::WhisperCpp.as_str(), "whisper_cpp");
        assert_eq!(SpeechBackend::FunAsr.as_str(), "funasr");
    }

    #[test]
    fn openai_backend_supports_both_surfaces_and_is_cloud() {
        let caps = SpeechBackend::OpenAi.capabilities();
        assert!(caps.transcription);
        assert!(caps.tts);
        // SRT-only → word times are interpolated, never engine-exact.
        assert!(!caps.exact_word_timing);
        assert_eq!(SpeechBackend::OpenAi.locality(), Locality::Cloud);
    }

    #[test]
    fn local_backends_are_transcription_only_and_local() {
        for b in [SpeechBackend::WhisperCpp, SpeechBackend::FunAsr] {
            let caps = b.capabilities();
            assert!(caps.transcription, "{b:?} should transcribe");
            assert!(!caps.tts, "{b:?} has no TTS");
            assert!(caps.exact_word_timing, "{b:?} reports engine-exact word times");
            assert_eq!(b.locality(), Locality::Local, "{b:?} is local");
        }
    }

    #[test]
    fn default_order_leads_with_openai() {
        assert_eq!(DEFAULT_ORDER.first(), Some(&SpeechBackend::OpenAi));
        assert_eq!(SpeechBackend::all(), DEFAULT_ORDER);
    }
}
