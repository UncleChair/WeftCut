//! Media commands — import lifecycle + derivative queries. Gated behind `jobs`.

use std::path::PathBuf;

use chrono::Utc;

use crate::io;
use crate::jobs::import::ImportEntry;
use crate::napi_backend::Backend;
use crate::state::{self, Actor, MediaItem, MediaKind};

/// True for subtitle file extensions (.srt / .ass / .vtt), case-insensitive.
/// Used as a routing gate at the top of `import_media` to bypass the media
/// pool entirely — subtitles are CONSUMED into caption tracks, not pooled.
fn is_subtitle_ext(p: &std::path::Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("srt") | Some("ass") | Some("vtt")
    )
}

/// Probe + hash a source file, insert a `MediaItem`, fan out derivative jobs,
/// and queue the background workspace copy. Returns the media id.
pub async fn import_media(backend: &Backend, path: String) -> Result<String, String> {
    let handle = backend.project()?;
    let source_buf = PathBuf::from(&path);

    // Subtitles are CONSUMED at import: parsed into a caption track of Text
    // layers, never pooled as media. (Q13 — MediaKind::Subtitle is no longer a
    // pool kind; the extension is only a routing signal here.)
    if is_subtitle_ext(&source_buf) {
        let body = std::fs::read_to_string(&source_buf)
            .map_err(|e| format!("read subtitle: {e}"))?;
        let label = source_buf.file_name().map(|n| n.to_string_lossy().to_string());
        let (track_id, _simplified) =
            crate::commands::mutations::import_subtitles(backend, body, None, label).await?;
        // _simplified is surfaced via the apply path; file import just returns the
        // track id (the renderer refreshes off project:changed).
        return Ok(track_id);
    }

    let cache = backend.cache.clone();
    let media_id = uuid::Uuid::new_v4();
    let workspace_root = backend.workspace.current();
    let has_workspace = workspace_root.is_some();

    let item = tokio::task::spawn_blocking({
        let source_buf = source_buf.clone();
        move || -> Result<MediaItem, String> {
            let (file_size, file_mtime, file_hash_blake3) = if has_workspace {
                let (size, mtime) = io::probe::stat_file(&source_buf).map_err(|e| format!("{e:#}"))?;
                (size, mtime, format!("pending-{media_id}"))
            } else {
                let facts = io::probe::hash_and_stat(&source_buf).map_err(|e| format!("{e:#}"))?;
                (facts.size, facts.mtime_secs, facts.blake3_hex)
            };
            let metadata = io::probe::probe_metadata(&source_buf);
            let kind: MediaKind = io::probe::detect_kind(&source_buf, &metadata);
            let label = source_buf.file_name().map(|n| n.to_string_lossy().to_string());
            Ok(MediaItem {
                id: media_id,
                label,
                path_abs: source_buf,
                path_rel: None,
                kind,
                metadata,
                proxy_path: None,
                proxy_format_version: 0,
                quick_proxy_path: None,
                proxy_bypassed: false,
                export_uses_original: false,
                waveform_path: None,
                conform_path: None,
                thumbnails_dir: None,
                file_hash_blake3,
                file_size,
                file_mtime,
                imported_at: Utc::now(),
            })
        }
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    let media_id = item.id;
    let item_for_jobs = item.clone();
    let id = handle
        .add_media_item(Actor::User, item)
        .await
        .map_err(|e| e.to_string())?;

    crate::jobs::enqueue_for_media(backend.events.clone(), cache.clone(), handle.clone(), item_for_jobs);

    if let Some(ws) = workspace_root {
        backend
            .import_queue
            .enqueue(handle.clone(), cache.clone(), media_id, source_buf, ws);
    } else {
        tracing::warn!(
            "import_media: no workspace set; MediaItem stays referencing the original source."
        );
    }

    Ok(id.to_string())
}

pub async fn import_cancel(backend: &Backend, media_id: String) -> Result<bool, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    Ok(backend.import_queue.cancel(id))
}

pub async fn import_queue_list(backend: &Backend) -> Result<Vec<ImportEntry>, String> {
    Ok(backend.import_queue.list())
}

use base64::Engine;

/// Peaks payload for the timeline waveform. `peaks_per_second` maps a layer's
/// src window onto a slice of `peaks`.
#[derive(serde::Serialize)]
pub struct WaveformPeaks {
    pub peaks: Vec<f32>,
    pub peaks_per_second: u32,
}

/// Master-bus meter reading pushed by the renderer (~2 Hz while playing).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeterReport {
    pub rms_db: f64,
    pub peak_db: f64,
}

/// Latest meter report + arrival instant. Staleness (>2 s) reads as "not playing".
#[derive(Clone, Default)]
pub struct AudioMeterState(
    pub std::sync::Arc<std::sync::Mutex<Option<(std::time::Instant, AudioMeterReport)>>>,
);

pub async fn get_media_thumbnail(backend: &Backend, media_id: String) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let media = snap.media_pool.get(&id).ok_or_else(|| format!("media {media_id} not found"))?;
    let dir = media.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let path = dir.join("004.jpg");
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

pub async fn get_waveform_peaks(backend: &Backend, media_id: String) -> Result<WaveformPeaks, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let media = snap.media_pool.get(&id).ok_or_else(|| format!("media {media_id} not found"))?;
    let path = media.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let peaks = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_peaks_file(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read peaks: {e:#}"))?;
    Ok(WaveformPeaks { peaks, peaks_per_second: crate::jobs::waveform::PEAKS_PER_SECOND })
}

pub async fn ensure_full_proxy(backend: &Backend, media_id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    handle
        .set_media_derivatives(
            Actor::Agent { client: "jobs".to_string() },
            id,
            state::MediaDerivativesPatch { export_uses_original: Some(false), ..Default::default() },
        )
        .await
        .map_err(|e| format!("route-correct {media_id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), handle.clone(), item);
    Ok(())
}

pub async fn ensure_conform(backend: &Backend, media_id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    if item.metadata.audio.is_none() {
        return Ok(());
    }
    if crate::cache::cached_ok(&backend.cache.audio_conform(&item.file_hash_blake3)) {
        return Ok(());
    }
    crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), handle.clone(), item);
    Ok(())
}

pub async fn report_audio_meter(backend: &Backend, report: AudioMeterReport) -> Result<(), String> {
    *backend.audio_meter.0.lock().map_err(|_| "meter lock poisoned".to_string())? =
        Some((std::time::Instant::now(), report));
    Ok(())
}
