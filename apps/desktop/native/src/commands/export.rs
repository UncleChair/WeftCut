//! Export commands — audio-only mix/encode, final mux, and the
//! export-audio conform gate. Gated behind `export`. The video-sink commands
//! live in `export::videosink` (native-IPC rawvideo frame path) and are dispatched
//! directly — they need only the two Backend stores, not a project snapshot.

use std::path::PathBuf;

use crate::export::{self, AudioEncodeSpec};
use crate::napi_backend::Backend;

/// Audio-only export → `output_path` (.m4a AAC / .mka Opus). The mix is Rust
/// (sample-accurate over conform PCM); ffmpeg is the encode tail. Emits no
/// events; the JS orchestrator drives the panel. The TS host passes the full
/// project — export is user-triggered and infrequent, so a one-shot
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
/// video-only (no audio track). Always a stream-copy mux (`-c copy`) — every
/// export path (WebCodecs direct-encode, or the native-encode video sink)
/// already writes `video_path` in its final target codec. Container = the
/// output extension.
pub async fn mux_export(
    video_path: String,
    audio_path: String,
    output_path: String,
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
    export::mux_to_file(&video, &audio, &out)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Export-readiness audio gate: media ids of audible in-window audio layers
/// whose conform cache is absent/invalid, each with a conform job kicked.
/// Selection mirrors the mix plan exactly (mute/solo/lock/window).
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
        crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), item);
    }
    Ok(waiting.iter().map(|u| u.to_string()).collect())
}
