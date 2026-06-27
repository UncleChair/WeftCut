//! Export commands — audio-only mix/encode, final mux/transcode, and the
//! export-audio conform gate. Gated behind `export`. The video-sink commands
//! live in `export::videosink` (native-IPC 10-bit frame path) and are dispatched
//! directly — they need only the two Backend stores, not a project snapshot.

use std::path::PathBuf;

use crate::export::{self, AudioEncodeSpec, TargetCodec};
use crate::napi_backend::Backend;

/// Transcode spec for the ffmpeg export path. Absent ⇒ stream-copy mux.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeSpec {
    pub video_codec: String, // "h264" | "hevc" | "av1" | "vp9"
    pub bitrate: u64,
    pub cbr: bool,
    pub duration_us: i64,
    pub gop: u64,
    #[serde(default)]
    pub software: bool,
}

/// Audio-only export → `output_path` (.m4a AAC / .mka Opus). The mix is Rust
/// (sample-accurate over conform PCM); ffmpeg is the encode tail. Emits no
/// events; the JS orchestrator drives the panel. The TS host passes the full
/// project (Phase 2) — export is user-triggered and infrequent, so a one-shot
/// full serialize is fine.
pub async fn export_project_audio_only(
    project: crate::state::Project,
    output_path: String,
    audio: AudioEncodeSpec,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<bool, String> {
    let path = PathBuf::from(output_path);
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    export::export_audio_only(&project, &path, &audio, window)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Mux `video_path` (+ `audio_path` if it exists on disk) into `output_path`.
/// `audio_path` is always passed by the caller; a nonexistent file means
/// video-only (no audio track). With no `transcode`, stream-copies (`-c copy`);
/// with one, re-encodes the video to the target codec (HW-first via the cached
/// probe, software fallback) and emits `export:transcode_progress`. Container =
/// the output extension.
pub async fn mux_export(
    backend: &Backend,
    video_path: String,
    audio_path: String,
    output_path: String,
    transcode: Option<TranscodeSpec>,
) -> Result<(), String> {
    let video = PathBuf::from(video_path);
    let audio = PathBuf::from(audio_path);
    let out = PathBuf::from(output_path);
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create output dir {}: {e}", parent.display()))?;
        }
    }
    match transcode {
        None => export::mux_to_file(&video, &audio, &out)
            .await
            .map_err(|e| format!("{e:#}")),
        Some(spec) => {
            let codec = TargetCodec::parse(&spec.video_codec)
                .ok_or_else(|| format!("unknown codec {}", spec.video_codec))?;
            let encoder: String = if spec.software {
                codec.software_encoder().to_string()
            } else {
                (*backend.hw_encoder.encoder_for(codec).await).clone()
            };
            export::transcode_and_mux(
                &backend.events,
                &encoder,
                codec,
                spec.bitrate,
                spec.cbr,
                spec.gop,
                spec.duration_us,
                &video,
                &audio,
                &out,
            )
            .await
            .map_err(|e| format!("{e:#}"))
        }
    }
}

/// Export-readiness audio gate: media ids of audible in-window audio layers
/// whose conform cache is absent/invalid, each with a conform job kicked.
/// Selection mirrors the mix plan exactly (mute/solo/lock/window). The TS host
/// passes the full project (Phase 2).
pub async fn ensure_export_audio_conform(
    backend: &Backend,
    project: crate::state::Project,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<String>, String> {
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    let waiting = crate::audio::mix::conform_waiting_media(&project, window);
    for id in &waiting {
        let Some(item) = project.media_pool.get(id).cloned() else {
            continue;
        };
        crate::jobs::enqueue_conform(
            backend.events.clone(),
            backend.cache.clone(),
            item,
            backend.read_mirror_handle(),
        );
    }
    Ok(waiting.iter().map(|u| u.to_string()).collect())
}
