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

/// Args for the single-media compute channels that now receive the resolved
/// `MediaItem` from the TS host (the sole state owner) instead of a bare id.
#[cfg(feature = "jobs")]
#[derive(serde::Deserialize)]
pub struct MediaItemArgs {
    pub item: crate::state::MediaItem,
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioOnlyArgs {
    /// Full project, injected by the TS host (sole state owner) — Phase 2.
    pub project: crate::state::Project,
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
    /// Full project, injected by the TS host (sole state owner) — Phase 2.
    pub project: crate::state::Project,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

