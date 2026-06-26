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

/// Probe + hash a source file into a `MediaItem` (no actor write). Pure compute:
/// stat (+ deferred `pending-{id}` hash when a workspace will copy the file in,
/// or full blake3 hash otherwise), metadata probe, kind detection. Mints the
/// media id internally. Extracted from `import_media`'s `spawn_blocking` body so
/// the `probe_media` napi (Phase 3d-e hybrid: Rust computes, the TS host writes)
/// reuses the EXACT same probe; `import_media` (flag-off path) calls it unchanged.
pub fn probe_media_item(source_buf: PathBuf, has_workspace: bool) -> Result<MediaItem, String> {
    let media_id = uuid::Uuid::new_v4();
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
    let workspace_root = backend.workspace.current();
    let has_workspace = workspace_root.is_some();

    let item = tokio::task::spawn_blocking({
        let source_buf = source_buf.clone();
        move || probe_media_item(source_buf, has_workspace)
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    let media_id = item.id;
    let item_for_jobs = item.clone();
    let id = handle
        .add_media_item(Actor::User, item)
        .await
        .map_err(|e| e.to_string())?;

    crate::jobs::enqueue_for_media(backend.events.clone(), cache.clone(), handle.clone(), item_for_jobs, backend.read_mirror_handle());

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
    let snap = backend.snapshot_for_read().await?;
    let media = snap.media_pool.get(&id).ok_or_else(|| format!("media {media_id} not found"))?;
    let dir = media.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let path = dir.join("004.jpg");
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

pub async fn get_waveform_peaks(backend: &Backend, media_id: String) -> Result<WaveformPeaks, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = backend.snapshot_for_read().await?;
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
    let snap = backend.snapshot_for_read().await?;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    let handle = backend.project()?;
    crate::jobs::commit_media_derivatives(
        &backend.events, handle, id,
        state::MediaDerivativesPatch { export_uses_original: Some(false), ..Default::default() },
    ).await.map_err(|e| format!("route-correct {media_id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), handle.clone(), item, backend.read_mirror_handle());
    Ok(())
}

pub async fn ensure_conform(backend: &Backend, media_id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = backend.snapshot_for_read().await?;
    let handle = backend.project()?;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    if item.metadata.audio.is_none() {
        return Ok(());
    }
    if crate::cache::cached_ok(&backend.cache.audio_conform(&item.file_hash_blake3)) {
        return Ok(());
    }
    crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), handle.clone(), item, backend.read_mirror_handle());
    Ok(())
}

pub async fn report_audio_meter(backend: &Backend, report: AudioMeterReport) -> Result<(), String> {
    *backend.audio_meter.0.lock().map_err(|_| "meter lock poisoned".to_string())? =
        Some((std::time::Instant::now(), report));
    Ok(())
}

#[cfg(test)]
mod mirror_tests {
    use std::sync::Arc;
    use chrono::Utc;
    use crate::state::{MediaItem, MediaKind, MediaMetadata};

    fn mirror_only_item(id: uuid::Uuid) -> MediaItem {
        MediaItem {
            id,
            label: None,
            path_abs: std::path::PathBuf::from("/nonexistent"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: format!("test-{id}"),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    /// `get_media_thumbnail` must read from the mirror, not the frozen actor.
    /// Without the re-point the blank actor has no such media → "media … not
    /// found"; with it the mirror finds the item and returns "not_ready"
    /// (thumbnails_dir is None), proving mirror resolution succeeded.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_media_thumbnail_reads_mirror_not_actor() {
        let sink = Arc::new(crate::events::VecEventSink::new());
        let b = crate::napi_backend::Backend::new_for_test(sink as Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        // A media item present ONLY in the mirror (actor stays blank).
        let mut p = (*b.project().unwrap().snapshot().await).clone();
        let id = uuid::Uuid::now_v7();
        p.media_pool.insert(id, mirror_only_item(id));
        b.set_project_mirror(serde_json::to_string(&p).unwrap(), "{}".into()).unwrap();
        // thumbnails_dir is None → "not_ready" proves the item was FOUND via the
        // mirror.  A blank-actor read would error "media … not found".
        let err = b.dispatch("get_media_thumbnail", &format!("{{\"mediaId\":\"{id}\"}}")).await.unwrap_err();
        assert_eq!(err, "not_ready", "expected not_ready from mirror item, got: {err}");
    }

    /// `ensure_full_proxy` must route the derivative write through the seam
    /// (`commit_media_derivatives`) rather than calling `set_media_derivatives`
    /// on the actor directly.  Under TS authority the seam emits
    /// `media:derivatives`; under the old code `set_media_derivatives` on the
    /// blank actor would error "media … not found" and return Err.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ensure_full_proxy_routes_through_seam() {
        // Serialize against the other TS_DERIVATIVE_AUTHORITY toggle tests; the
        // guard's Drop resets the flag to false even on an early `expect` panic.
        let _authority = crate::jobs::AuthorityTestGuard::acquire();
        let sink = Arc::new(crate::events::VecEventSink::new());
        let b = crate::napi_backend::Backend::new_for_test(sink.clone() as Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        // Populate mirror with an item that has no proxy yet.
        let mut p = (*b.project().unwrap().snapshot().await).clone();
        let id = uuid::Uuid::now_v7();
        p.media_pool.insert(id, mirror_only_item(id));
        b.set_project_mirror(serde_json::to_string(&p).unwrap(), "{}".into()).unwrap();
        // Activate TS derivative authority so commit_media_derivatives emits
        // the event rather than writing the actor.
        crate::jobs::set_ts_derivative_authority(true);
        // The seam path returns Ok; the old direct-actor path returns Err on a
        // mirror-only item because the blank actor has no such media.
        b.dispatch("ensure_full_proxy", &format!("{{\"mediaId\":\"{id}\"}}"))
            .await
            .expect("ensure_full_proxy must succeed via the seam");
        assert!(
            sink.names().iter().any(|n| n == "media:derivatives"),
            "media:derivatives must be emitted via seam; got: {:?}",
            sink.names()
        );
    }
}
