//! The video-understanding backend catalog: the enum of engines we know how to
//! drive, their locality (local sidecar / BYO endpoint / cloud), and the default
//! order the resolver falls back through.
//!
//! Architectural twin of [`speech::backend`](crate::speech) — same shape, same
//! `as_str` wire-tag contract. The tags below (`"qwen3_vl"`, `"minicpm_v"`,
//! `"byo_endpoint"`, `"cloud"`) are the `vlm_config` map keys the TS host injects
//! and the stable IPC contract; do NOT change them once persisted.
//!
//! Config material (a cloud API key, a local engine's binary/model/mmproj paths,
//! or a BYO endpoint URL) lives in [`super::config`]; this module is only the
//! backend identity + its static facts. Selection + availability is
//! [`super::resolve`].

use serde::{Deserialize, Serialize};

/// Video-understanding engines WeftCut can drive. `Qwen3Vl` and `MiniCpmV` are
/// local one-shot `llama-mtmd-cli` sidecars (a GGUF model + mmproj on disk);
/// `ByoEndpoint` is a user-hosted OpenAI-compatible `/v1/chat/completions`;
/// `Cloud` is a hosted VLM behind an API key. All four ingest the SAME
/// timestamped multi-image input (frames + injected `<t s>` text markers) and
/// diverge only in the output parser + availability probe — the whole point of
/// the [`SceneDescriber`](super::describer::SceneDescriber) /
/// [`DescriptionParser`](super::parser::DescriptionParser) split.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VlmBackend {
    /// Qwen3-VL-4B-Instruct via `llama-mtmd-cli` (Apache 2.0). The DEFAULT —
    /// its timestamps are injected plain text, so the llama.cpp path is
    /// low-risk and fully controllable (ticket 06 spike).
    Qwen3Vl,
    /// MiniCPM-V 4.5 via `llama-mtmd-cli`. Reuses the SAME frames + text-marker
    /// input path as Qwen3-VL (spike-proven — `temporal_ids` not needed);
    /// differs only in the output parser (underscore-joined tags + a trailing
    /// empty segment) and the availability probe.
    MiniCpmV,
    /// User-hosted OpenAI-compatible endpoint (self-hosted `llama-server` /
    /// vLLM / SGLang). Same frame-sampling input adapter as the local sidecar;
    /// no bundled runtime.
    ByoEndpoint,
    /// Hosted cloud VLM (OpenAI-compatible; GPT-4o by default) behind the
    /// existing cloud-key plumbing. Privacy-strict: never a silent substitute
    /// for a requested local backend (frames are heavier + more sensitive than
    /// audio — see [`super::resolve`]).
    Cloud,
}

/// Where a backend runs. Drives the availability check: a local backend needs
/// its binary + model + mmproj present; a BYO endpoint needs a URL; a cloud
/// backend needs an API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locality {
    /// Spawned CLI sidecar, file-gated (binary + GGUF + mmproj).
    Local,
    /// User-hosted HTTP endpoint, URL-gated.
    Endpoint,
    /// Hosted HTTP API, key-gated.
    Cloud,
}

/// The order the resolver walks after honoring the caller's `preferred` hint.
/// **Local-first** (unlike STT, which leads with cloud): the whole subsystem is
/// opt-in and privacy-sensitive (frames), so with nothing preferred we pick the
/// on-device engine and only reach the cloud when a user explicitly configures
/// or requests it. Qwen3-VL leads — it is the validated default (ticket 06).
pub const DEFAULT_ORDER: &[VlmBackend] = &[
    VlmBackend::Qwen3Vl,
    VlmBackend::MiniCpmV,
    VlmBackend::ByoEndpoint,
    VlmBackend::Cloud,
];

impl VlmBackend {
    /// Stable string tag — the `vlm_config` map key AND the TS/napi wire
    /// contract. Do NOT change once persisted (see the module note).
    pub fn as_str(self) -> &'static str {
        match self {
            VlmBackend::Qwen3Vl => "qwen3_vl",
            VlmBackend::MiniCpmV => "minicpm_v",
            VlmBackend::ByoEndpoint => "byo_endpoint",
            VlmBackend::Cloud => "cloud",
        }
    }

    /// Human-facing label for the Settings row / Test button. Reserved for the
    /// (out-of-scope) Settings UI, same as `SpeechBackend::label`.
    #[allow(dead_code)]
    pub fn label(self) -> &'static str {
        match self {
            VlmBackend::Qwen3Vl => "Qwen3-VL (local)",
            VlmBackend::MiniCpmV => "MiniCPM-V (local)",
            VlmBackend::ByoEndpoint => "Self-hosted endpoint",
            VlmBackend::Cloud => "Cloud VLM",
        }
    }

    /// Every backend we know about, in the default resolution order.
    pub fn all() -> &'static [VlmBackend] {
        DEFAULT_ORDER
    }

    /// Local (spawned CLI) vs Endpoint (BYO HTTP) vs Cloud (hosted HTTP).
    pub fn locality(self) -> Locality {
        match self {
            VlmBackend::Qwen3Vl | VlmBackend::MiniCpmV => Locality::Local,
            VlmBackend::ByoEndpoint => Locality::Endpoint,
            VlmBackend::Cloud => Locality::Cloud,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_tags_are_stable() {
        // Wire/on-disk contract — must never drift.
        assert_eq!(VlmBackend::Qwen3Vl.as_str(), "qwen3_vl");
        assert_eq!(VlmBackend::MiniCpmV.as_str(), "minicpm_v");
        assert_eq!(VlmBackend::ByoEndpoint.as_str(), "byo_endpoint");
        assert_eq!(VlmBackend::Cloud.as_str(), "cloud");
    }

    #[test]
    fn default_order_is_local_first_and_leads_with_qwen() {
        assert_eq!(DEFAULT_ORDER.first(), Some(&VlmBackend::Qwen3Vl));
        // Cloud is last so it is never a silent substitute for a local engine.
        assert_eq!(DEFAULT_ORDER.last(), Some(&VlmBackend::Cloud));
        assert_eq!(VlmBackend::all(), DEFAULT_ORDER);
    }

    #[test]
    fn localities_are_assigned_per_engine() {
        assert_eq!(VlmBackend::Qwen3Vl.locality(), Locality::Local);
        assert_eq!(VlmBackend::MiniCpmV.locality(), Locality::Local);
        assert_eq!(VlmBackend::ByoEndpoint.locality(), Locality::Endpoint);
        assert_eq!(VlmBackend::Cloud.locality(), Locality::Cloud);
    }
}
