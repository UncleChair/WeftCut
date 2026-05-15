//! Segmented preview orchestrator (Phase A2 + A3).
//!
//! Lifecycle: subscribes to actor commits, debounces, computes manifest,
//! diffs vs prior, enqueues new segments into a priority queue drained by
//! N parallel worker tasks. Workers each spawn an ffmpeg child per segment.
//!
//! Concurrency: `min(num_cpus/2, HW_SESSION_CAP=6)` if a HW encoder is
//! probed, else `num_cpus/2` — see [`queue::worker_concurrency`].
//!
//! Cancellation: each in-flight job carries a [`CancelHandle`] keyed by
//! segment hash. When a fresh commit lands and the running job's enqueue
//! commit-id is ≥ 2 stale, we fire its cancel handle → the worker's
//! `tokio::select!` drops the ffmpeg `Child` → `kill_on_drop` terminates.
//! Single-commit-stale jobs are allowed to finish (decision in
//! `docs/preview-segmented-cache.md`).
//!
//! Events emitted (Tauri):
//!   * `preview:manifest_changed` — a fresh manifest has been written.
//!   * `preview:segment_ready { hash, in_us, out_us, path }` — segment
//!     file landed on disk and `cached_ok` passes.
//!   * `preview:segment_error { hash, detail }` — render failed.
//!   * `preview:audio_ready { path }` — whole-timeline audio rendered.
//!   * `preview:audio_error { detail }`.
//!
//! Enabled only when `WEFTCUT_PREVIEW_SEGMENTED=1` (see `lib.rs`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, warn};

use crate::cache::{cached_ok, CacheLayout};
use crate::export::HwEncoderCache;
use crate::state::{Project, ProjectHandle};

use super::encoder::{render_audio, render_segment};
use super::failure::{classify, SegmentFailureKind};
use super::manifest::{
    self, diff_manifests, save_manifest, Manifest, SegmentStatus,
};
use super::queue::{
    worker_concurrency, CancelHandle, PriorityClass, SegmentJob, SegmentQueue,
};

pub mod events {
    pub const MANIFEST_CHANGED: &str = "preview:manifest_changed";
    pub const SEGMENT_READY: &str = "preview:segment_ready";
    pub const SEGMENT_ERROR: &str = "preview:segment_error";
    pub const AUDIO_READY: &str = "preview:audio_ready";
    pub const AUDIO_ERROR: &str = "preview:audio_error";
}

const DEBOUNCE: Duration = Duration::from_millis(250);

/// Cancel an in-flight job whose enqueue commit-id is at least
/// `STALE_COMMIT_THRESHOLD` behind the current commit counter. The lazy
/// default ("let single-commit-stale jobs finish") matches what Pr
/// does and avoids the "progress resets on every keystroke" jitter that
/// naive queues produce.
const STALE_COMMIT_THRESHOLD: u64 = 2;

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
    queue: Arc<SegmentQueue>,
    in_flight: Arc<AsyncMutex<HashMap<String, InFlightEntry>>>,
    commit_counter: Arc<AtomicU64>,
}

#[derive(Clone)]
struct InFlightEntry {
    cancel: CancelHandle,
    commit_id: u64,
}

struct SegmentedRendererInner {
    current_manifest: Option<Manifest>,
    current_manifest_path: Option<PathBuf>,
}

impl SegmentedRenderer {
    pub fn spawn(app: AppHandle, handle: ProjectHandle) -> Self {
        let me = Self {
            inner: Arc::new(Mutex::new(SegmentedRendererInner {
                current_manifest: None,
                current_manifest_path: None,
            })),
            queue: Arc::new(SegmentQueue::new()),
            in_flight: Arc::new(AsyncMutex::new(HashMap::new())),
            commit_counter: Arc::new(AtomicU64::new(0)),
        };

        // Spawn workers. Concurrency is decided once at startup — we
        // don't currently re-probe HW availability later, matching how
        // `ExportPreset::apply_to_command` consumes the cached probe.
        let app_for_workers = app.clone();
        let me_for_workers = me.clone();
        tauri::async_runtime::spawn(async move {
            spawn_workers(app_for_workers, me_for_workers).await;
        });

        // Spawn the commit-subscriber loop.
        let me_for_loop = me.clone();
        tauri::async_runtime::spawn(async move {
            commit_loop(app, handle, me_for_loop).await;
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

/// Spawn N worker tasks that drain the segment queue. The number of
/// workers is fixed at spawn time from the HW encoder probe + cpu count.
async fn spawn_workers(app: AppHandle, renderer: SegmentedRenderer) {
    let has_hw = match app.try_state::<HwEncoderCache>() {
        Some(c) => c.get().await.is_some(),
        None => false,
    };
    let logical_cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    let n = worker_concurrency(logical_cpus, has_hw);
    info!(
        "segmented preview: spawning {} worker(s) (logical_cpus={}, hw_encoder={})",
        n, logical_cpus, has_hw,
    );
    for worker_id in 0..n {
        let app = app.clone();
        let renderer = renderer.clone();
        tauri::async_runtime::spawn(async move {
            worker_loop(worker_id, app, renderer).await;
        });
    }
}

async fn worker_loop(worker_id: usize, app: AppHandle, renderer: SegmentedRenderer) {
    info!("segmented preview worker #{worker_id} ready");
    let cache = match app.try_state::<CacheLayout>() {
        Some(c) => c.inner().clone(),
        None => {
            warn!("worker #{worker_id}: no CacheLayout managed — exiting");
            return;
        }
    };

    loop {
        let (job, cancel) = renderer.queue.pop().await;
        // Register in_flight before yielding to render.
        {
            let mut g = renderer.in_flight.lock().await;
            g.insert(
                job.hash.clone(),
                InFlightEntry {
                    cancel: cancel.clone(),
                    commit_id: job.commit_id,
                },
            );
        }

        let dest = cache.preview_segment(&job.hash);
        let result = render_segment_with_retry(&app, &job, &dest, &cancel, worker_id).await;

        renderer.in_flight.lock().await.remove(&job.hash);

        match result {
            Ok(()) => {
                let _ = app.emit(
                    events::SEGMENT_READY,
                    SegmentReady {
                        hash: job.hash.clone(),
                        in_us: job.in_us,
                        out_us: job.out_us,
                        path: dest.to_string_lossy().to_string(),
                    },
                );
            }
            Err(detail) if cancel.is_cancelled() => {
                // Cancellation isn't an error from the user's perspective.
                tracing::debug!(
                    "worker #{worker_id}: job {} cancelled ({detail})",
                    job.hash
                );
            }
            Err(detail) => {
                warn!("worker #{worker_id}: job {} failed: {detail}", job.hash);
                let _ = app.emit(
                    events::SEGMENT_ERROR,
                    SegmentError {
                        hash: job.hash.clone(),
                        detail,
                    },
                );
            }
        }
    }
}

/// Run render_segment with the auto-retry policy. Returns Ok on success;
/// Err with a flattened detail string on final failure (after retries).
///
/// Retry rules (one retry max):
///   * `Transient` — re-run unchanged after 2s backoff
///   * `HwEncoderRejected` — re-run with `prefer_sw=true` (1s backoff)
///   * everything else — surface immediately, no retry
async fn render_segment_with_retry(
    app: &AppHandle,
    job: &SegmentJob,
    dest: &std::path::Path,
    cancel: &CancelHandle,
    worker_id: usize,
) -> Result<(), String> {
    // First attempt: let the encoder pick HW if available.
    let first = render_segment(
        app,
        &job.project,
        &job.inline_subs,
        &job.template_renders,
        job.in_us,
        job.out_us,
        dest,
        cancel,
        /*prefer_sw=*/ false,
    )
    .await;

    let first_detail = match first {
        Ok(()) => return Ok(()),
        Err(e) => format!("{e:#}"),
    };

    if cancel.is_cancelled() {
        return Err(first_detail);
    }

    let kind = classify(&first_detail);
    match kind {
        SegmentFailureKind::Transient => {
            info!(
                "worker #{worker_id}: job {} transient failure — retrying in 2s",
                job.hash
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
            if cancel.is_cancelled() {
                return Err(first_detail);
            }
            render_segment(
                app,
                &job.project,
                &job.inline_subs,
                &job.template_renders,
                job.in_us,
                job.out_us,
                dest,
                cancel,
                /*prefer_sw=*/ false,
            )
            .await
            .map_err(|e| format!("{e:#} (after 1 retry)"))
        }
        SegmentFailureKind::HwEncoderRejected => {
            info!(
                "worker #{worker_id}: job {} HW encoder rejected — retrying with software encoder",
                job.hash
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
            if cancel.is_cancelled() {
                return Err(first_detail);
            }
            render_segment(
                app,
                &job.project,
                &job.inline_subs,
                &job.template_renders,
                job.in_us,
                job.out_us,
                dest,
                cancel,
                /*prefer_sw=*/ true,
            )
            .await
            .map_err(|e| format!("{e:#} (after HW→SW retry)"))
        }
        _ => Err(first_detail),
    }
}

async fn commit_loop(app: AppHandle, handle: ProjectHandle, renderer: SegmentedRenderer) {
    let mut rx = handle.subscribe();
    info!("segmented preview commit-loop subscribed");
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
                warn!("commit_loop: no CacheLayout managed; skipping cycle");
                continue;
            }
        };
        let project = handle.snapshot().await;
        if project.tracks.iter().all(|t| t.layers.is_empty()) {
            continue;
        }

        if let Err(e) = run_one_cycle(&app, &cache, &project, &renderer).await {
            warn!("segmented preview cycle failed: {e:#}");
        }
    }
}

async fn run_one_cycle(
    app: &AppHandle,
    cache: &CacheLayout,
    project: &Project,
    renderer: &SegmentedRenderer,
) -> anyhow::Result<()> {
    // Bump the commit counter — workers compare in-flight job commit_ids
    // against this to decide staleness.
    let this_commit = renderer.commit_counter.fetch_add(1, Ordering::Relaxed) + 1;

    // 1. Materialize side maps ONCE per cycle. Workers receive Arc-clones
    // so the entire cycle's segments share one set of paths.
    let inline_subs = Arc::new(
        crate::ir::materialize_inline_subtitles(project, cache)
            .map_err(|e| anyhow::anyhow!("materialize inline subs: {e}"))?,
    );
    let template_renders = Arc::new(
        crate::ir::materialize_templates(project, cache, app)
            .await
            .map_err(|e| anyhow::anyhow!("materialize templates: {e}"))?,
    );

    // 2. Compute manifest. Uses the same already-materialized side maps
    // (via compute_manifest_core for synchronous code reuse).
    let global_hash = super::state_hash(project, cache, app).await?;
    let new_manifest = super::compute_manifest_core(
        project,
        global_hash,
        &inline_subs,
        &template_renders,
    )?;

    // 3. Diff against prior manifest.
    let prior = renderer
        .inner
        .lock()
        .expect("segmented preview lock")
        .current_manifest
        .clone();
    let diff = diff_manifests(prior.as_ref(), &new_manifest);

    // 4. Save manifest atomically + emit manifest_changed.
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
    renderer.record(new_manifest.clone(), manifest_path.clone());

    // 5. Drop obsolete pending jobs from the queue (hashes not in new
    // manifest). Running jobs are cancelled by the staleness check below.
    let new_hashes: std::collections::HashSet<String> =
        new_manifest.video.segments.iter().map(|s| s.hash.clone()).collect();
    let dropped = renderer
        .queue
        .retain_hashes(|h| new_hashes.contains(h))
        .await;
    if dropped > 0 {
        info!("segmented preview: dropped {dropped} obsolete pending jobs");
    }

    // 6. Cancel running jobs whose commit-id is ≥ STALE_COMMIT_THRESHOLD
    // stale. Single-commit-stale jobs are allowed to finish.
    {
        let in_flight = renderer.in_flight.lock().await;
        for (hash, entry) in in_flight.iter() {
            if this_commit.saturating_sub(entry.commit_id) >= STALE_COMMIT_THRESHOLD {
                // Skip if hash is still in new manifest — same content,
                // not stale.
                if new_hashes.contains(hash) {
                    continue;
                }
                info!(
                    "segmented preview: cancelling stale running job {hash} \
                     (enqueued at commit {}, current {})",
                    entry.commit_id, this_commit
                );
                entry.cancel.cancel();
            }
        }
    }

    // 7. Enqueue new segments. Use PriorityClass::Ordered for all in A3;
    // playhead / visible-region priority bumps come from A4 once the
    // React side reports them.
    let project_arc = Arc::new(project.clone());
    for entry in &diff.new_segments {
        let dest = cache.preview_segment(&entry.hash);
        if cached_ok(&dest) {
            // The diff said this was new but the file's already on disk
            // (e.g. from a prior crashed cycle). Fast-path emit.
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
        let job = SegmentJob {
            hash: entry.hash.clone(),
            in_us: entry.in_us,
            out_us: entry.out_us,
            commit_id: this_commit,
            project: project_arc.clone(),
            inline_subs: inline_subs.clone(),
            template_renders: template_renders.clone(),
        };
        let _ = renderer.queue.push(job, PriorityClass::Ordered).await;
    }

    // 8. Reused segments: emit ready if file exists; otherwise enqueue
    // (manifest believed in a cache hit but the bytes aren't on disk).
    for entry in &diff.reused_segments {
        let dest = cache.preview_segment(&entry.hash);
        if cached_ok(&dest) {
            let _ = app.emit(
                events::SEGMENT_READY,
                SegmentReady {
                    hash: entry.hash.clone(),
                    in_us: entry.in_us,
                    out_us: entry.out_us,
                    path: dest.to_string_lossy().to_string(),
                },
            );
        } else {
            let job = SegmentJob {
                hash: entry.hash.clone(),
                in_us: entry.in_us,
                out_us: entry.out_us,
                commit_id: this_commit,
                project: project_arc.clone(),
                inline_subs: inline_subs.clone(),
                template_renders: template_renders.clone(),
            };
            let _ = renderer.queue.push(job, PriorityClass::Ordered).await;
        }
    }

    // 9. Audio (whole-timeline). Sequential, not queued — there's only
    // ever one audio job per cycle. Cancellation: use a fresh handle
    // dedicated to audio so the segment workers' handles don't interfere.
    let audio_path = cache.preview_audio(&new_manifest.global_hash);
    let needs_audio = diff.audio_changed || !cached_ok(&audio_path);
    if needs_audio {
        let audio_cancel = CancelHandle::new();
        match render_audio(
            app,
            project,
            &inline_subs,
            &template_renders,
            &audio_path,
            &audio_cancel,
        )
        .await
        {
            Ok(()) => {
                if cached_ok(&audio_path) {
                    let _ = app.emit(
                        events::AUDIO_READY,
                        AudioReady {
                            path: audio_path.to_string_lossy().to_string(),
                        },
                    );
                }
            }
            Err(e) => {
                let detail = format!("{e:#}");
                warn!("preview audio render failed: {detail}");
                let _ = app.emit(events::AUDIO_ERROR, AudioError { detail });
            }
        }
    } else if cached_ok(&audio_path) {
        let _ = app.emit(
            events::AUDIO_READY,
            AudioReady {
                path: audio_path.to_string_lossy().to_string(),
            },
        );
    }

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

    #[test]
    fn stale_commit_threshold_matches_design() {
        // The grill-me decision was "≥ 2 commits behind → kill". Catches
        // an accidental edit dropping this back to 1 (which produces the
        // jittery "progress resets every keystroke" UX) or pushing it to
        // some larger value (lets too many stale jobs run).
        assert_eq!(STALE_COMMIT_THRESHOLD, 2);
    }
}
