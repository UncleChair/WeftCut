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
    crate::cache::touch_if_stale(&path);
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("read thumbnail: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

pub async fn get_waveform_peaks(item: MediaItem) -> Result<WaveformPeaks, String> {
    let path = item.waveform_path.clone().ok_or_else(|| "not_ready".to_string())?;
    crate::cache::touch_if_stale(&path);
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

/// The peaks file's level table, header-only (no sample data). The renderer
/// uses this to pick a LOD level for the current zoom before requesting tiles.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformLevels {
    pub channels: u32,
    pub levels: Vec<WaveformLevelInfo>,
}

/// A min/max/rms window range for one channel of one LOD level. All values are
/// normalized to [-1, 1] for min/max and [0, 1] for rms.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformTile {
    pub peaks_per_second: u32,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
    pub rms: Vec<f32>,
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
    crate::cache::touch_if_stale(&path);
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
    crate::cache::touch_if_stale(&path);
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
        rms: range.rms.iter().map(|v| crate::jobs::waveform::dequantize_rms(*v)).collect(),
    })
}

/// Timeline filmstrip tile. `path` is the cached JPG the renderer loads via
/// convertFileSrc; width/height are metadata-derived (informative — the
/// renderer sizes layout from the decoded ImageBitmap).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripTile {
    pub path: PathBuf,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripTileArgs {
    pub item: MediaItem,
    pub lod: u32,
    pub index: u32,
}

/// The proxy-wait rule: Proxied media extract from a landed proxy and NEVER
/// fall back to the original (heavy originals are exactly why proxies exist);
/// direct routes extract from the original. Preference mirrors the renderer's
/// resolveDecode preview path (quick proxy first, then the full master).
#[cfg(feature = "jobs")]
pub fn filmstrip_decode_source(item: &MediaItem) -> Result<(PathBuf, crate::cache::FilmstripSrc), String> {
    use crate::cache::FilmstripSrc;
    if !matches!(item.kind, MediaKind::Video) {
        return Err("filmstrip tiles only valid for Video media".to_string());
    }
    match &item.decode_route {
        // NativeSw: the ProRes original decodes directly (filmstrip already
        // supports these formats), so thumbnails come from the original,
        // immediately — do NOT wait on the proxy the way `Proxied` does.
        state::DecodeRoute::Bypass
        | state::DecodeRoute::DirectExport { .. }
        | state::DecodeRoute::NativeSw { .. } => {
            Ok((item.path_abs.clone(), FilmstripSrc::Orig))
        }
        state::DecodeRoute::Proxied { quick_proxy, full_proxy, .. } => {
            [(quick_proxy, FilmstripSrc::Quick), (full_proxy, FilmstripSrc::Full)]
                .into_iter()
                .filter_map(|(p, tag)| p.as_ref().map(|p| (p, tag)))
                .find(|(p, _)| crate::cache::cached_ok(p))
                .map(|(p, tag)| (p.clone(), tag))
                .ok_or_else(|| "not_ready".to_string())
        }
    }
}

#[cfg(feature = "jobs")]
pub async fn get_filmstrip_tile(backend: &Backend, args: FilmstripTileArgs) -> Result<FilmstripTile, String> {
    use crate::jobs::filmstrip;
    let (src, src_tag) = filmstrip_decode_source(&args.item)?;
    filmstrip::validate_lod(args.lod).map_err(|e| format!("{e:#}"))?;
    let duration_us = args.item.metadata.duration_us;
    let hash = args.item.file_hash_blake3.clone();
    let path = filmstrip::extract_tile(&backend.cache, &src, src_tag, &hash, duration_us, args.lod, args.index)
        .await
        .map_err(|e| format!("extract filmstrip tile: {e:#}"))?;
    let (width_px, height_px) = match args.item.metadata.video.as_ref() {
        Some(v) if v.height > 0 => {
            let w = (v.width as u64 * filmstrip::FILMSTRIP_TILE_HEIGHT as u64 / v.height as u64) as u32;
            (w & !1, filmstrip::FILMSTRIP_TILE_HEIGHT)
        }
        _ => (0, filmstrip::FILMSTRIP_TILE_HEIGHT),
    };
    Ok(FilmstripTile { path, width_px, height_px })
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
    use super::filmstrip_decode_source;

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

    /// `get_waveform_tile` returns dequantized min/max/rms values for the
    /// requested range. Fixtures a v3 peaks file with known RMS values and
    /// asserts they round-trip correctly through dequantization.
    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn get_waveform_tile_dequantizes_rms() {
        use crate::jobs::waveform::{LevelData, write_peaks};
        use super::{get_waveform_tile, WaveformTileArgs};

        let tmp = tempfile::TempDir::new().unwrap();
        let peaks_path = tmp.path().join("test.v3.peaks");

        // Create a simple v3 peaks file with known values for 1 channel, 1 level.
        let level_data = LevelData {
            channels: 1,
            peak_count: 3,
            mins: vec![vec![-100, -200, -300]],
            maxs: vec![vec![100, 200, 300]],
            rmss: vec![vec![1000, 2000, 3000]],
        };
        write_peaks(&peaks_path, 1, &[(100, level_data)])
            .await
            .expect("write_peaks");

        let mut item = mirror_only_item(uuid::Uuid::now_v7());
        item.waveform_path = Some(peaks_path);

        let tile = get_waveform_tile(WaveformTileArgs {
            item,
            level: 0,
            channel: 0,
            start_peak: 0,
            count: 3,
        })
        .await
        .expect("get_waveform_tile");

        // Verify min/max are dequantized correctly (existing behavior).
        assert_eq!(tile.min[0], -100.0_f32 / 32767.0);
        assert_eq!(tile.max[0], 100.0_f32 / 32767.0);

        // Verify rms is dequantized and present (new behavior).
        assert_eq!(tile.rms.len(), 3);
        assert_eq!(tile.rms[0], 1000.0_f32 / 65535.0);
        assert_eq!(tile.rms[1], 2000.0_f32 / 65535.0);
        assert_eq!(tile.rms[2], 3000.0_f32 / 65535.0);
    }

    fn filmstrip_test_item(
        path_abs: std::path::PathBuf,
        kind: MediaKind,
        decode_route: DecodeRoute,
    ) -> MediaItem {
        let id = uuid::Uuid::now_v7();
        MediaItem {
            id,
            label: None,
            path_abs,
            path_rel: None,
            kind,
            metadata: MediaMetadata::default(),
            decode_route,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: format!("filmstrip-test-{id}"),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn filmstrip_source_bypass_and_direct_export_use_original() {
        use crate::cache::FilmstripSrc;
        let mut item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp4"),
            MediaKind::Video,
            DecodeRoute::Bypass,
        );
        assert_eq!(
            filmstrip_decode_source(&item).unwrap(),
            (std::path::PathBuf::from("orig.mp4"), FilmstripSrc::Orig),
        );
        item.decode_route = DecodeRoute::DirectExport { quick_proxy: None };
        assert_eq!(
            filmstrip_decode_source(&item).unwrap(),
            (std::path::PathBuf::from("orig.mp4"), FilmstripSrc::Orig),
        );
    }

    /// The proxy-wait rule: a Proxied item extracts from whichever proxy has
    /// actually landed on disk and never falls back to the (possibly huge)
    /// original. A stale route entry pointing at a deleted proxy file must
    /// read as "not_ready", not silently retarget the original and kick off
    /// an ffmpeg run against it on every poll.
    #[cfg(feature = "jobs")]
    #[test]
    fn filmstrip_source_proxied_waits_never_falls_back() {
        let tmp = tempfile::TempDir::new().unwrap();
        let quick = tmp.path().join("quick.mp4");
        let full = tmp.path().join("full.mp4");

        // No proxies landed yet -> not_ready, never the original.
        let item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp4"),
            MediaKind::Video,
            DecodeRoute::Proxied { quick_proxy: None, full_proxy: None, format_version: 0 },
        );
        assert_eq!(filmstrip_decode_source(&item).unwrap_err(), "not_ready");

        // Quick proxy landed -> prefer it (mirrors the renderer's preview preference).
        std::fs::write(&quick, b"x").unwrap();
        let item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp4"),
            MediaKind::Video,
            DecodeRoute::Proxied {
                quick_proxy: Some(quick.clone()),
                full_proxy: None,
                format_version: 0,
            },
        );
        assert_eq!(filmstrip_decode_source(&item).unwrap(), (quick.clone(), crate::cache::FilmstripSrc::Quick));

        // Only the full proxy has landed -> use it.
        std::fs::write(&full, b"x").unwrap();
        let item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp4"),
            MediaKind::Video,
            DecodeRoute::Proxied {
                quick_proxy: None,
                full_proxy: Some(full.clone()),
                format_version: 0,
            },
        );
        assert_eq!(filmstrip_decode_source(&item).unwrap(), (full.clone(), crate::cache::FilmstripSrc::Full));

        // quick_proxy path is stale (file missing on disk) and there is no
        // full proxy -> not_ready, not a fallback to the original.
        let missing_quick = tmp.path().join("gone.mp4");
        let item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp4"),
            MediaKind::Video,
            DecodeRoute::Proxied {
                quick_proxy: Some(missing_quick),
                full_proxy: None,
                format_version: 0,
            },
        );
        assert_eq!(filmstrip_decode_source(&item).unwrap_err(), "not_ready");
    }

    #[cfg(feature = "jobs")]
    #[test]
    fn filmstrip_rejects_non_video() {
        let item = filmstrip_test_item(
            std::path::PathBuf::from("orig.mp3"),
            MediaKind::Audio,
            DecodeRoute::Bypass,
        );
        let err = filmstrip_decode_source(&item).unwrap_err();
        assert!(err.contains("filmstrip"), "expected 'filmstrip' in error, got: {err}");
    }
}
