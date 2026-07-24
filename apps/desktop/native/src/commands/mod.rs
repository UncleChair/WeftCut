//! Command surface — the native handlers reachable through `Backend::dispatch`.
//!
//! The TS state actor is the sole writer, so no mutation / history / query /
//! persistence handlers live here — only the native / compute handlers +
//! their args. There is no response *view* builder and no actor-mutation
//! wrapper.

#[cfg(feature = "speech")]
use serde::Serialize;

#[cfg(feature = "speech")]
pub mod speech;
#[cfg(feature = "export")]
pub mod export;
#[cfg(feature = "jobs")]
pub mod media;
pub mod prefs;

#[cfg(feature = "speech")]
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
    /// Full project, injected by the TS host (sole state owner).
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
}

#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConformArgs {
    /// Full project, injected by the TS host (sole state owner).
    pub project: crate::state::Project,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}
