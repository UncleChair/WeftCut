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
        // A fresh import's route is UNDECIDED — the real codec-based decision runs
        // async in `spawn_proxy_decision` (kicked by `enqueue_for_media`). Video
        // must start on a route that triggers that decision; a `Bypass` default
        // would be read as "already decided" and silently skip it. See
        // `proxy_decision::initial_decode_route`.
        decode_route: crate::jobs::proxy_decision::initial_decode_route(kind),
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

const TIMELINE_THUMB_COUNT: usize = 10;

/// Peaks payload for the timeline waveform. `peaks_per_second` maps a layer's
/// src window onto a slice of `peaks`.
#[derive(serde::Serialize)]
pub struct WaveformPeaks {
    pub peaks: Vec<f32>,
    pub peaks_per_second: u32,
}

/// Timeline-oriented thumbnail manifest. Paths point at the existing cached
/// JPGs; the renderer converts them with `convertFileSrc`.
#[derive(Debug, serde::Serialize)]
pub struct ThumbnailManifest {
    pub frames: Vec<ThumbnailFrame>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailFrame {
    pub index: usize,
    pub t_us: i64,
    pub path: PathBuf,
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

pub async fn get_media_thumbnails(item: MediaItem) -> Result<ThumbnailManifest, String> {
    let dir = item.thumbnails_dir.clone().ok_or_else(|| "not_ready".to_string())?;
    let duration_us = item.metadata.duration_us.unwrap_or(0).max(0);
    let mut frames = Vec::with_capacity(TIMELINE_THUMB_COUNT);
    for index in 0..TIMELINE_THUMB_COUNT {
        let path = dir.join(format!("{index:03}.jpg"));
        if !crate::cache::cached_ok(&path) {
            return Err("not_ready".to_string());
        }
        frames.push(ThumbnailFrame {
            index,
            t_us: (duration_us.saturating_mul(index as i64)) / TIMELINE_THUMB_COUNT as i64,
            path,
        });
    }
    Ok(ThumbnailManifest { frames })
}

pub async fn get_waveform_peaks(item: MediaItem) -> Result<WaveformPeaks, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let peaks = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_peaks_file(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read peaks: {e:#}"))?;
    Ok(WaveformPeaks { peaks, peaks_per_second: crate::jobs::waveform::PEAKS_PER_SECOND })
}

/// One LOD level's coarseness (`peaks_per_second`) + how many peak windows it holds.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLevelInfo {
    pub level: u32,
    pub peaks_per_second: u32,
    pub peak_count: u32,
}

/// The v2 peaks file's level table, header-only (no sample data). The renderer
/// uses this to pick a LOD level for the current zoom before requesting tiles.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLevels {
    pub channels: u32,
    pub levels: Vec<WaveformLevelInfo>,
}

/// A min/max window range for one channel of one LOD level.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTile {
    pub peaks_per_second: u32,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTileArgs {
    pub item: MediaItem,
    pub level: u32,
    pub channel: u32,
    pub start_peak: u32,
    pub count: u32,
}

pub async fn get_waveform_levels(item: MediaItem) -> Result<WaveformLevels, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let header = tokio::task::spawn_blocking(move || crate::jobs::waveform::read_header(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("read header: {e:#}"))?;
    Ok(WaveformLevels {
        channels: header.channels,
        levels: header
            .levels
            .iter()
            .enumerate()
            .map(|(i, l)| WaveformLevelInfo {
                level: i as u32,
                peaks_per_second: l.peaks_per_second,
                peak_count: l.peak_count,
            })
            .collect(),
    })
}

pub async fn get_waveform_tile(args: WaveformTileArgs) -> Result<WaveformTile, String> {
    let path = args.item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    let WaveformTileArgs { level, channel, start_peak, count, .. } = args;
    // The range read parses the header anyway, so it hands back the level's pps
    // (the renderer needs it to map peaks→time) — one file open per tile.
    let range = tokio::task::spawn_blocking(move || {
        crate::jobs::waveform::read_range(&path, level as usize, channel as usize, start_peak, count)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .map_err(|e| format!("read tile: {e:#}"))?;
    Ok(WaveformTile {
        peaks_per_second: range.peaks_per_second,
        min: range.min.iter().map(|v| crate::jobs::waveform::dequantize(*v)).collect(),
        max: range.max.iter().map(|v| crate::jobs::waveform::dequantize(*v)).collect(),
    })
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
    use super::{get_media_thumbnails, TIMELINE_THUMB_COUNT};

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

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn get_media_thumbnails_returns_existing_timeline_manifest() {
        let id = uuid::Uuid::now_v7();
        let mut item = mirror_only_item(id);
        item.metadata.duration_us = Some(10_000_000);
        let dir = tempfile::tempdir().unwrap();
        for index in 0..TIMELINE_THUMB_COUNT {
            tokio::fs::write(dir.path().join(format!("{index:03}.jpg")), b"jpg")
                .await
                .unwrap();
        }
        item.thumbnails_dir = Some(dir.path().to_path_buf());

        let manifest = get_media_thumbnails(item).await.expect("manifest");

        assert_eq!(manifest.frames.len(), TIMELINE_THUMB_COUNT);
        for (index, frame) in manifest.frames.iter().enumerate() {
            assert_eq!(frame.index, index);
            assert_eq!(frame.t_us, index as i64 * 1_000_000);
            assert_eq!(frame.path, dir.path().join(format!("{index:03}.jpg")));
        }
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn get_media_thumbnails_reports_not_ready_when_cache_absent() {
        let id = uuid::Uuid::now_v7();
        let mut item = mirror_only_item(id);
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("000.jpg"), b"jpg").await.unwrap();
        item.thumbnails_dir = Some(dir.path().to_path_buf());

        let err = get_media_thumbnails(item).await.unwrap_err();

        assert_eq!(err, "not_ready");
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
