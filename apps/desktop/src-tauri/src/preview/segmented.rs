//! Segmented preview orchestrator (Phase A2).
//!
//! Mirrors `PreviewRenderer`'s lifecycle: subscribes to actor commits,
//! debounces, then materializes the segment-cache state for the current
//! project snapshot. For A2 the rendering loop is SEQUENTIAL — one
//! segment at a time. A3 layers on parallelism + priority + cancellation.
//!
//! Events emitted (Tauri):
//!   * `preview:manifest_changed` — a fresh manifest has been written.
//!   * `preview:segment_ready { hash, in_us, out_us, path }` — segment
//!     file landed on disk and `cached_ok` passes.
//!   * `preview:segment_error { hash, detail }` — render failed; surfaces
//!     via LogBus in A5.
//!   * `preview:audio_ready { path }` — whole-timeline audio rendered.
//!   * `preview:audio_error { detail }`.
//!
//! Enabled per `lib.rs` setup hook only when the env var
//! `WEFTCUT_PREVIEW_SEGMENTED=1` is set. Otherwise the old whole-timeline
//! `PreviewRenderer` runs as today.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tracing::{info, warn};

use crate::cache::{cached_ok, CacheLayout};
use crate::state::ProjectHandle;

use super::encoder::{render_audio, render_segment};
use super::manifest::{
    self, diff_manifests, load_manifest, save_manifest, Manifest, SegmentStatus,
};

pub mod events {
    /// Emitted when a fresh manifest has been computed and saved.
    pub const MANIFEST_CHANGED: &str = "preview:manifest_changed";
    /// A specific segment landed on disk.
    pub const SEGMENT_READY: &str = "preview:segment_ready";
    pub const SEGMENT_ERROR: &str = "preview:segment_error";
    pub const AUDIO_READY: &str = "preview:audio_ready";
    pub const AUDIO_ERROR: &str = "preview:audio_error";
}

const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestChanged {
    pub global_hash: String,
    pub manifest_path: String,
    pub duration_us: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentReady {
    pub hash: String,
    pub in_us: i64,
    pub out_us: i64,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentError {
    pub hash: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioReady {
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioError {
    pub detail: String,
}

#[derive(Clone)]
pub struct SegmentedRenderer {
    inner: Arc<Mutex<SegmentedRendererInner>>,
}

struct SegmentedRendererInner {
    current_manifest: Option<Manifest>,
    current_manifest_path: Option<PathBuf>,
    in_flight: bool,
}

impl SegmentedRenderer {
    pub fn spawn(app: AppHandle, handle: ProjectHandle) -> Self {
        let me = Self {
            inner: Arc::new(Mutex::new(SegmentedRendererInner {
                current_manifest: None,
                current_manifest_path: None,
                in_flight: false,
            })),
        };
        let me_for_loop = me.clone();
        tauri::async_runtime::spawn(async move {
            segmented_loop(app, handle, me_for_loop).await;
        });
        me
    }

    pub fn current_manifest_path(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .expect("segmented preview lock")
            .current_manifest_path
            .clone()
    }

    fn record(&self, manifest: Manifest, path: PathBuf) {
        let mut g = self.inner.lock().expect("segmented preview lock");
        g.current_manifest = Some(manifest);
        g.current_manifest_path = Some(path);
    }
}

async fn segmented_loop(app: AppHandle, handle: ProjectHandle, renderer: SegmentedRenderer) {
    let mut rx = handle.subscribe();
    info!("segmented preview renderer subscribed; waiting for commits");
    loop {
        match rx.recv().await {
            Ok(_) => {}
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => return,
        }
        // Debounce.
        loop {
            tokio::select! {
                _ = tokio::time::sleep(DEBOUNCE) => break,
                ev = rx.recv() => match ev {
                    Ok(_) => continue,
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return,
                },
            }
        }

        let cache = match app.try_state::<CacheLayout>() {
            Some(c) => c.inner().clone(),
            None => {
                warn!("segmented preview: no CacheLayout managed; skipping cycle");
                continue;
            }
        };
        let project = handle.snapshot().await;
        // No layers → no segments to render (matches PreviewRenderer's
        // gating; React UI shows the empty-state hint).
        if project.tracks.iter().all(|t| t.layers.is_empty()) {
            continue;
        }

        // Mark in-flight; bail if another cycle is mid-process. A3 lifts
        // this restriction.
        {
            let mut g = renderer.inner.lock().expect("segmented preview lock");
            if g.in_flight {
                continue;
            }
            g.in_flight = true;
        }

        let result = run_one_cycle(&app, &cache, &project, &renderer).await;
        renderer
            .inner
            .lock()
            .expect("segmented preview lock")
            .in_flight = false;

        if let Err(e) = result {
            warn!("segmented preview cycle failed: {e:#}");
        }
    }
}

async fn run_one_cycle(
    app: &AppHandle,
    cache: &CacheLayout,
    project: &crate::state::Project,
    renderer: &SegmentedRenderer,
) -> anyhow::Result<()> {
    // 1. Compute fresh manifest.
    let new_manifest = super::compute_manifest(project, cache, app).await?;

    // 2. Diff against last manifest (in-memory snapshot, not on-disk).
    let prior = renderer
        .inner
        .lock()
        .expect("segmented preview lock")
        .current_manifest
        .clone();
    let diff = diff_manifests(prior.as_ref(), &new_manifest);

    // 3. Save manifest atomically. React listens for `manifest_changed`
    // to know the timeline layout has changed.
    let manifest_path = cache.preview_manifest(&new_manifest.global_hash);
    save_manifest(&manifest_path, &new_manifest)?;
    let _ = app.emit(
        events::MANIFEST_CHANGED,
        ManifestChanged {
            global_hash: new_manifest.global_hash.clone(),
            manifest_path: manifest_path.to_string_lossy().to_string(),
            duration_us: new_manifest.duration_us,
        },
    );
    renderer.record(new_manifest.clone(), manifest_path);

    // 4. Render each new segment sequentially. Reused segments are
    // verified against cached_ok and re-enqueued if the bytes are
    // missing (the manifest believed in a cache hit but the file got
    // deleted / GC'd / never existed).
    for entry in diff.new_segments.iter().chain(diff.reused_segments.iter()) {
        let dest = cache.preview_segment(&entry.hash);
        if cached_ok(&dest) {
            // Already on disk — fast-path through to ready event so the
            // React side reflects the cache hit.
            let _ = app.emit(
                events::SEGMENT_READY,
                SegmentReady {
                    hash: entry.hash.clone(),
                    in_us: entry.in_us,
                    out_us: entry.out_us,
                    path: dest.to_string_lossy().to_string(),
                },
            );
            continue;
        }
        match render_segment(app, project, entry.in_us, entry.out_us, &dest).await {
            Ok(()) => {
                let _ = app.emit(
                    events::SEGMENT_READY,
                    SegmentReady {
                        hash: entry.hash.clone(),
                        in_us: entry.in_us,
                        out_us: entry.out_us,
                        path: dest.to_string_lossy().to_string(),
                    },
                );
            }
            Err(e) => {
                let detail = format!("{e:#}");
                warn!("segment render failed for {}: {detail}", entry.hash);
                let _ = app.emit(
                    events::SEGMENT_ERROR,
                    SegmentError {
                        hash: entry.hash.clone(),
                        detail,
                    },
                );
            }
        }
    }

    // 5. Audio: whole-timeline. Render only if global hash changed (which
    // means audio content might have changed) OR the file doesn't exist.
    let audio_path = cache.preview_audio(&new_manifest.global_hash);
    let needs_audio = diff.audio_changed || !cached_ok(&audio_path);
    if needs_audio {
        match render_audio(app, project, &audio_path).await {
            Ok(()) => {
                if cached_ok(&audio_path) {
                    let _ = app.emit(
                        events::AUDIO_READY,
                        AudioReady {
                            path: audio_path.to_string_lossy().to_string(),
                        },
                    );
                }
                // If the project had no audio, render_audio returns Ok
                // without producing a file. Skip the event in that case.
            }
            Err(e) => {
                let detail = format!("{e:#}");
                warn!("preview audio render failed: {detail}");
                let _ = app.emit(events::AUDIO_ERROR, AudioError { detail });
            }
        }
    } else if cached_ok(&audio_path) {
        // Cache hit — emit ready so React reflects the existing file.
        let _ = app.emit(
            events::AUDIO_READY,
            AudioReady {
                path: audio_path.to_string_lossy().to_string(),
            },
        );
    }

    // 6. Update on-disk manifest entries to reflect what's actually ready.
    // Mark as Ready any segment whose cache file passes cached_ok now.
    let mut final_manifest = new_manifest;
    for seg in final_manifest.video.segments.iter_mut() {
        let dest = cache.preview_segment(&seg.hash);
        if cached_ok(&dest) {
            seg.status = SegmentStatus::Ready;
        }
    }
    if cached_ok(&audio_path) {
        final_manifest.audio.status = SegmentStatus::Ready;
    }
    save_manifest(
        &cache.preview_manifest(&final_manifest.global_hash),
        &final_manifest,
    )?;
    renderer.inner.lock().expect("segmented preview lock").current_manifest =
        Some(final_manifest);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check: the event-name constants match the docs/preview-segmented-cache.md
    /// contract. Catches a typo or rename slipping through.
    #[test]
    fn event_names_match_contract() {
        assert_eq!(events::MANIFEST_CHANGED, "preview:manifest_changed");
        assert_eq!(events::SEGMENT_READY, "preview:segment_ready");
        assert_eq!(events::SEGMENT_ERROR, "preview:segment_error");
        assert_eq!(events::AUDIO_READY, "preview:audio_ready");
        assert_eq!(events::AUDIO_ERROR, "preview:audio_error");
    }

    /// Payload structs serialize the way React expects.
    #[test]
    fn segment_ready_serializes_camel_case() {
        let p = SegmentReady {
            hash: "abc".into(),
            in_us: 1_000_000,
            out_us: 5_000_000,
            path: "/tmp/seg.m4s".into(),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"inUs\":1000000"), "expected camelCase inUs: {json}");
        assert!(json.contains("\"outUs\":5000000"));
        assert!(json.contains("\"hash\":\"abc\""));
    }
}
