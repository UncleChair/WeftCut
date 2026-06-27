//! Media commands — import lifecycle + derivative queries. Gated behind `jobs`.

use std::path::PathBuf;

use chrono::Utc;

use crate::io;
use crate::jobs::import::ImportEntry;
use crate::napi_backend::Backend;
use crate::state::{self, MediaItem, MediaKind};

/// Probe a source file into a `MediaItem` (no actor write). Stat-only +
/// metadata probe + kind detection — NO blake3 (instant timeline appearance).
/// `file_hash_blake3` is a PROVISIONAL sentinel (`pending-{id}`) that is never
/// used as a cache key: the TS host runs the standalone `hash_media_source` pass
/// and sets the real hash via `set_media_hash` BEFORE enqueuing any derivative
/// (stateless-compute Phase 4 — ADR 0007 superseded). Mints the media id
/// internally. The `probe_media` napi reuses this exact body.
pub fn probe_media_item(source_buf: PathBuf) -> Result<MediaItem, String> {
    let media_id = uuid::Uuid::new_v4();
    let (file_size, file_mtime) = io::probe::stat_file(&source_buf).map_err(|e| format!("{e:#}"))?;
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
        decode_route: state::DecodeRoute::Bypass,
        waveform_path: None,
        conform_path: None,
        thumbnails_dir: None,
        file_hash_blake3: format!("pending-{media_id}"),
        file_size,
        file_mtime,
        imported_at: Utc::now(),
    })
}

// `import_media` (the monolithic flag-off importer that wrote the Rust actor and
// fanned out jobs in one call) was deleted in Phase 4b: the renderer + MCP route
// `import_media` through the hybrid (probe_media / parse_subtitles napi compute →
// TS-actor write), and the workspace copy + derivative jobs are kicked separately
// (enqueue_workspace_copy / enqueue_jobs_for_media napi). `probe_media_item`
// above stays — it is the compute half the `probe_media` napi reuses.

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

pub async fn get_media_thumbnail(item: MediaItem) -> Result<String, String> {
    let dir = item.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let path = dir.join("004.jpg");
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

pub async fn get_waveform_peaks(item: MediaItem) -> Result<WaveformPeaks, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let peaks = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_peaks_file(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read peaks: {e:#}"))?;
    Ok(WaveformPeaks { peaks, peaks_per_second: crate::jobs::waveform::PEAKS_PER_SECOND })
}

pub async fn ensure_full_proxy(backend: &Backend, item: MediaItem) -> Result<(), String> {
    let id = item.id;
    if matches!(item.decode_route, state::DecodeRoute::Proxied { full_proxy: Some(ref p), .. } if p.is_file()) {
        return Ok(());
    }
    let corrected = item.decode_route.clone().route_corrected();
    crate::jobs::commit_media_derivatives(
        &backend.events, id,
        state::MediaDerivativesPatch { set_route: Some(corrected), ..Default::default() },
    ).await.map_err(|e| format!("route-correct {id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), item);
    Ok(())
}

pub async fn ensure_conform(backend: &Backend, item: MediaItem) -> Result<(), String> {
    if item.metadata.audio.is_none() {
        return Ok(());
    }
    if crate::cache::cached_ok(&backend.cache.audio_conform(&item.file_hash_blake3)) {
        return Ok(());
    }
    crate::jobs::enqueue_conform(backend.events.clone(), backend.cache.clone(), item);
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
    use crate::state::{DecodeRoute, MediaItem, MediaKind, MediaMetadata};

    fn mirror_only_item(id: uuid::Uuid) -> MediaItem {
        MediaItem {
            id,
            label: None,
            path_abs: std::path::PathBuf::from("/nonexistent"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: format!("test-{id}"),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    /// `get_media_thumbnail` resolves from the passed-in item (no mirror).
    /// `thumbnails_dir` is None → "not_ready" proves it read the arg.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_media_thumbnail_uses_passed_item() {
        let sink = Arc::new(crate::events::VecEventSink::new());
        let b = crate::napi_backend::Backend::new_for_test(sink as Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = mirror_only_item(id); // thumbnails_dir: None
        let args = serde_json::json!({ "item": item }).to_string();
        let err = b.dispatch("get_media_thumbnail", &args).await.unwrap_err();
        assert_eq!(err, "not_ready", "expected not_ready from passed item, got: {err}");
    }

    /// `ensure_full_proxy` routes the derivative write through the seam
    /// (`commit_media_derivatives`), which always emits `media:derivatives` for
    /// the TS host to apply (the Rust-write arm is gone post-4b).
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ensure_full_proxy_routes_through_seam() {
        let sink = Arc::new(crate::events::VecEventSink::new());
        let b = crate::napi_backend::Backend::new_for_test(sink.clone() as Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = mirror_only_item(id);
        let args = serde_json::json!({ "item": item }).to_string();
        b.dispatch("ensure_full_proxy", &args)
            .await
            .expect("ensure_full_proxy must succeed via the seam");
        assert!(
            sink.names().iter().any(|n| n == "media:derivatives"),
            "media:derivatives must be emitted via seam; got: {:?}",
            sink.names()
        );
    }
}
