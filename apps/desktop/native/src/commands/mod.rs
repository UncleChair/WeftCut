//! Command surface — the native handlers reachable through `Backend::dispatch`.
//!
//! Phase 4b deleted the renderer mutation/history/query/persistence fallback
//! (the TS state actor is the sole writer); what remains are the native /
//! compute / mirror-backed-read handlers + their args. The response *view*
//! builder (`build_project_summary`) and the actor-mutation wrappers are gone.

#[cfg(feature = "cloud")]
use serde::Serialize;

pub mod prefs;
#[cfg(feature = "jobs")]
pub mod media;
#[cfg(feature = "export")]
pub mod export;
#[cfg(feature = "cloud")]
pub mod cloud;
#[cfg(feature = "motifs")]
pub mod motifs;
#[cfg(feature = "motifs")]
pub mod motif_authoring;

#[cfg(feature = "cloud")]
#[derive(Serialize, Clone)]
pub struct ApiKeyStatus {
    pub provider: String,
    pub label: String,
    pub configured: bool,
}

// ---- Command args structs (surviving native/compute/read handlers) ----

#[cfg(feature = "jobs")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIdArgs {
    pub media_id: String,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioOnlyArgs {
    pub output_path: String,
    pub audio: crate::export::AudioEncodeSpec,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxExportArgs {
    pub video_path: String,
    pub audio_path: String,
    pub output_path: String,
    pub transcode: Option<crate::commands::export::TranscodeSpec>,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConformArgs {
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

