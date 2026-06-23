//! Background-job pipeline for media derivatives.
//!
//! Each `enqueue_*` spawns a tokio task that runs ffmpeg under a global
//! semaphore (default 2 concurrent ffmpeg children — importing 10 files at
//! once shouldn't fork-bomb the host). On completion, the task routes the
//! `MediaItem`'s derivative patch through `commit_media_derivatives` — the
//! Rust actor's `set_media_derivatives` when it's authoritative, or a
//! `media:derivatives` event to the TS actor when it is — so subscribers
//! (UI, hot-reload, MCP change feed) re-fetch.
//!
//! Atomicity: all writes go through `cache::temp_path` + `promote_temp`. A
//! killed ffmpeg leaves a `<dest>.tmp` that the next run discards, never a
//! zero-byte `<dest>` that fools skip-if-cached.
//!
//! Events for UI:
//! - `media:job_started`  — `{ media_id, kind }`
//! - `media:job_complete` — `{ media_id, kind, path? }`
//! - `media:job_error`    — `{ media_id, kind, error }`

pub mod conform;
mod frame;
pub mod hwaccel;
pub mod import;
pub mod proxy;
pub mod proxy_decision;
pub mod quick_proxy;
mod thumbnails;
pub mod waveform;

pub use frame::extract as extract_frame;
pub use proxy::run as run_proxy;
pub use quick_proxy::run as run_quick_proxy;
pub use thumbnails::run as run_thumbnails;
pub use waveform::{read_peaks_file, run as run_waveform};

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use std::sync::Arc;

use crate::events::EventSink;
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::cache::CacheLayout;
use crate::state::{Actor, CommandError, MediaDerivativesPatch, MediaId, MediaItem, MediaKind, ProjectHandle};

/// Which engine owns the project state's media-pool, for job-completion
/// write-back. `false` (default) = the Rust actor is authoritative (jobs
/// call `set_media_derivatives` directly). `true` = the TS actor in Electron
/// main is authoritative; completion emits a `media:derivatives` event the
/// main process applies to the TS actor. `Backend::init` sets this from the
/// `WEFTCUT_TS_ACTOR` env flag; otherwise only tests flip it. Process-global
/// by the same rationale as the det-id toggle (`state/ids.rs`): jobs spawn
/// from many sites and a global avoids threading an engine handle through
/// every signature.
static TS_DERIVATIVE_AUTHORITY: AtomicBool = AtomicBool::new(false);

/// Set the derivative write-back authority (see `TS_DERIVATIVE_AUTHORITY`).
pub fn set_ts_derivative_authority(on: bool) {
    TS_DERIVATIVE_AUTHORITY.store(on, Ordering::SeqCst);
}

pub(crate) fn ts_derivative_authority() -> bool {
    TS_DERIVATIVE_AUTHORITY.load(Ordering::SeqCst)
}

/// Apply a completed job's derivative patch to whichever engine is
/// authoritative. Rust mode: the actor command (unchanged). TS mode: emit
/// `media:derivatives {media_id, patch}` — the patch serializes with the
/// absent/null/string tri-state for the `Option<Option<PathBuf>>` proxy fields
/// (mutations/media.ts:67). Returns `Ok` in TS mode (fire-and-forget; the TS
/// actor's `set_media_derivatives` is `MediaNotFound`-tolerant and the caller
/// only logs failures). `pub(crate)` so the napi open-time derivative
/// fan-out can reuse the same seam for stale-proxy clearing.
pub(crate) async fn commit_media_derivatives(
    events: &Arc<dyn EventSink>,
    project: &ProjectHandle,
    media_id: MediaId,
    patch: MediaDerivativesPatch,
) -> Result<(), CommandError> {
    if ts_derivative_authority() {
        events.emit(
            "media:derivatives",
            serde_json::json!({ "media_id": media_id.to_string(), "patch": patch }),
        );
        Ok(())
    } else {
        project.set_media_derivatives(actor_for_jobs(), media_id, patch).await
    }
}

pub const EVENT_STARTED: &str = "media:job_started";
pub const EVENT_COMPLETE: &str = "media:job_complete";
pub const EVENT_ERROR: &str = "media:job_error";

const MAX_PARALLEL_FFMPEG: usize = 2;

/// Global ffmpeg-child semaphore. Shared with `cloud::audio_extract` so cloud
/// transcription slices compete fairly with background derivative jobs
/// (thumbnails/proxy/waveform) rather than spawning unbounded extra ffmpegs.
pub(crate) fn ffmpeg_sem() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(MAX_PARALLEL_FFMPEG))
}

/// Per-media in-flight set for conform jobs. The export gate re-kicks any
/// media whose conform cache is invalid; if the import-time job is still
/// running, a second concurrent run would interleave writes into the SAME
/// `<dest>.tmp` (the ffmpeg semaphore holds 2 permits, so they genuinely
/// overlap). Dedupe instead — the running job's completion event serves
/// every waiter.
fn conform_in_flight() -> &'static std::sync::Mutex<std::collections::HashSet<MediaId>> {
    static S: OnceLock<std::sync::Mutex<std::collections::HashSet<MediaId>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn try_begin_conform(id: MediaId) -> bool {
    conform_in_flight()
        .lock()
        .expect("conform in-flight set poisoned")
        .insert(id)
}

fn end_conform(id: MediaId) {
    conform_in_flight()
        .lock()
        .expect("conform in-flight set poisoned")
        .remove(&id);
}

/// Drop guard so `end_conform` runs on every task exit path.
struct ConformGuard(MediaId);
impl Drop for ConformGuard {
    fn drop(&mut self) {
        end_conform(self.0);
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Thumbnails,
    Proxy,
    #[serde(rename = "quick_proxy")]
    QuickProxy,
    #[serde(rename = "proxy_bypass")]
    ProxyBypass,
    Waveform,
    Conform,
}

#[derive(Debug, Clone, Serialize)]
struct JobStarted {
    media_id: String,
    kind: JobKind,
}

#[derive(Debug, Clone, Serialize)]
struct JobComplete {
    media_id: String,
    kind: JobKind,
    path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct JobError {
    media_id: String,
    kind: JobKind,
    error: String,
}

/// Enqueue ONLY the full export proxy for a media item (no quick proxy, no
/// decision). Used by the export decode-failure recovery (`ensure_full_proxy`
/// command) when a DirectExport original turns out to be undecodable on this
/// machine. Returns immediately; the job runs on tokio::spawn.
pub fn enqueue_full_proxy(
    events: Arc<dyn EventSink>,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    spawn_proxy(events, cache, project, media);
}

/// Look at a freshly imported `MediaItem` and fan out the appropriate
/// background jobs. Returns immediately; jobs run on tokio::spawn.
pub fn enqueue_for_media(
    events: Arc<dyn EventSink>,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    match media.kind {
        MediaKind::Video => {
            let proxy_ready = media
                .proxy_path
                .as_ref()
                .map(|p| p.is_file())
                .unwrap_or(false);
            if proxy_ready || media.proxy_bypassed {
                spawn_decorations(events, cache, project, media);
            } else {
                spawn_proxy_decision(events, cache, project, media);
            }
        }
        MediaKind::Audio => {
            spawn_waveform(events.clone(), cache.clone(), project.clone(), media.clone());
            spawn_conform(events, cache, project, media);
        }
        MediaKind::Image | MediaKind::Subtitle => {
            // No derivatives needed.
        }
    }
}

fn spawn_decorations(events: Arc<dyn EventSink>, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    if matches!(media.kind, MediaKind::Video) {
        spawn_thumbnails(events.clone(), cache.clone(), project.clone(), media.clone());
    }
    if media.metadata.audio.is_some() {
        spawn_waveform(events.clone(), cache.clone(), project.clone(), media.clone());
        spawn_conform(events, cache, project, media);
    }
}

/// Enqueue ONLY the conform job (export readiness gate / pre-conform-era
/// backfill via the `ensure_conform` command). Returns immediately.
pub fn enqueue_conform(
    events: Arc<dyn EventSink>,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    spawn_conform(events, cache, project, media);
}

fn spawn_conform(events: Arc<dyn EventSink>, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    if !try_begin_conform(media.id) {
        // Already conforming — that job's complete/error event serves this
        // caller's wait too.
        return;
    }
    tokio::spawn(async move {
        let media_id = media.id;
        let _guard = ConformGuard(media_id);
        emit(
            &events,
            EVENT_STARTED,
            &JobStarted {
                media_id: media_id.to_string(),
                kind: JobKind::Conform,
            },
        );

        let permit = ffmpeg_sem().acquire().await;
        if permit.is_err() {
            warn!("conform job: semaphore closed; skipping {media_id}");
            return;
        }
        let media = fresh_media_item(&project, media_id, media).await;
        let result = conform::run(&cache, &media).await;
        drop(permit);

        match result {
            Ok(conform_path) => {
                let path_str = conform_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    conform_path: Some(conform_path),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("conform commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::Conform,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("conform ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Conform,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("conform job failed for {media_id}: {e:#}");
                emit(
                    &events,
                    EVENT_ERROR,
                    &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Conform,
                        error: format!("{e:#}"),
                    },
                );
            }
        }
    });
}

fn spawn_proxy_decision(
    events: Arc<dyn EventSink>,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        // Probe the source's keyframe interval (on a blocking worker — it
        // shells out to ffprobe) so the routing policy can demote long-GOP
        // friendly H.264 to a short-GOP scrub proxy instead of a direct decode.
        let source_gop_secs = {
            let path = media.path_abs.clone();
            tokio::task::spawn_blocking(move || {
                crate::io::probe::probe_max_keyframe_gap_secs(&path)
            })
            .await
            .ok()
            .flatten()
        };
        let route = proxy_decision::decide(&media, source_gop_secs);
        match proxy_decision::job_for(route) {
            proxy_decision::ProxyJob::None => {
                emit(
                    &events,
                    EVENT_STARTED,
                    &JobStarted {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                    },
                );
                let patch = MediaDerivativesPatch {
                    proxy_path: Some(None),
                    quick_proxy_path: Some(None),
                    proxy_bypassed: Some(true),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("proxy bypass commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::ProxyBypass,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("proxy bypass accepted for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                spawn_decorations(events, cache, project, media);
            }
            proxy_decision::ProxyJob::QuickOnly => {
                emit(
                    &events,
                    EVENT_STARTED,
                    &JobStarted {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                    },
                );
                let patch = MediaDerivativesPatch {
                    proxy_path: Some(None),
                    proxy_bypassed: Some(false),
                    export_uses_original: Some(true),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("direct-export commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::ProxyBypass,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("direct-export accepted for {media_id}; preview proxy queued");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                // Thumbnails + waveform off the original; preview proxy in the
                // background WITHOUT chaining a full proxy.
                spawn_decorations(events.clone(), cache.clone(), project.clone(), media.clone());
                spawn_quick_proxy(events, cache, project, media, false, source_gop_secs);
            }
            proxy_decision::ProxyJob::QuickThenFull => {
                spawn_quick_proxy(events, cache, project, media, true, source_gop_secs);
            }
        }
    });
}

fn spawn_thumbnails(events: Arc<dyn EventSink>, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &events,
            EVENT_STARTED,
            &JobStarted {
                media_id: media_id.to_string(),
                kind: JobKind::Thumbnails,
            },
        );

        let permit = ffmpeg_sem().acquire().await;
        if permit.is_err() {
            warn!("thumbnail job: semaphore closed; skipping {media_id}");
            return;
        }
        let result = thumbnails::run(&cache, &media).await;
        drop(permit);

        match result {
            Ok(thumbs_dir) => {
                let path_str = thumbs_dir.display().to_string();
                let patch = MediaDerivativesPatch {
                    thumbnails_dir: Some(thumbs_dir),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("thumbnail commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::Thumbnails,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("thumbnails ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Thumbnails,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("thumbnail job failed for {media_id}: {e:#}");
                emit(
                    &events,
                    EVENT_ERROR,
                    &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Thumbnails,
                        error: format!("{e:#}"),
                    },
                );
            }
        }
    });
}

fn spawn_quick_proxy(
    events: Arc<dyn EventSink>,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
    then_full: bool,
    source_gop_secs: Option<f64>,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &events,
            EVENT_STARTED,
            &JobStarted {
                media_id: media_id.to_string(),
                kind: JobKind::QuickProxy,
            },
        );

        let permit = ffmpeg_sem().acquire().await;
        if permit.is_err() {
            warn!("quick proxy job: semaphore closed; skipping {media_id}");
            return;
        }
        let media = fresh_media_item(&project, media_id, media).await;
        let result = quick_proxy::run(&cache, &media, source_gop_secs).await;
        drop(permit);

        match result {
            Ok(quick_proxy_path) => {
                let path_str = quick_proxy_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    quick_proxy_path: Some(Some(quick_proxy_path)),
                    proxy_bypassed: Some(false),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("quick proxy commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::QuickProxy,
                            error: format!("commit: {e}"),
                        },
                    );
                } else {
                    info!("quick proxy ready for {media_id}");
                    emit(
                        &events,
                        EVENT_COMPLETE,
                        &JobComplete {
                            media_id: media_id.to_string(),
                            kind: JobKind::QuickProxy,
                            path: Some(path_str),
                        },
                    );
                }
            }
            Err(e) => {
                warn!("quick proxy job failed for {media_id}: {e:#}");
                emit(
                    &events,
                    EVENT_ERROR,
                    &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::QuickProxy,
                        error: format!("{e:#}"),
                    },
                );
            }
        }

        if then_full {
            // Full proxy chains after the quick proxy; refresh hash/paths in
            // case the workspace copy + blake3 landed while the quick proxy was queued.
            let media = fresh_media_item(&project, media_id, media).await;
            spawn_proxy(events, cache, project, media);
        }
    });
}

fn spawn_proxy(events: Arc<dyn EventSink>, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &events,
            EVENT_STARTED,
            &JobStarted {
                media_id: media_id.to_string(),
                kind: JobKind::Proxy,
            },
        );

        let permit = ffmpeg_sem().acquire().await;
        if permit.is_err() {
            warn!("proxy job: semaphore closed; skipping {media_id}");
            return;
        }
        let media = fresh_media_item(&project, media_id, media).await;
        let result = proxy::run(&cache, &media).await;
        drop(permit);

        match result {
            Ok(proxy_path) => {
                let quick_path = cache.quick_proxy(&media.file_hash_blake3);
                if let Err(e) = tokio::fs::remove_file(&quick_path).await {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        warn!("quick proxy cleanup failed for {media_id}: {e}");
                    }
                }
                let path_str = proxy_path.display().to_string();
                let mut thumbnail_media = media.clone();
                thumbnail_media.path_abs = proxy_path.clone();
                let patch = MediaDerivativesPatch {
                    proxy_path: Some(Some(proxy_path)),
                    proxy_format_version: Some(proxy::PROXY_FORMAT_VERSION),
                    proxy_bypassed: Some(false),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("proxy commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::Proxy,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("proxy ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Proxy,
                        path: Some(path_str),
                    },
                );
                spawn_decorations(events, cache, project, thumbnail_media);
            }
            Err(e) => {
                warn!("proxy job failed for {media_id}: {e:#}");
                emit(
                    &events,
                    EVENT_ERROR,
                    &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Proxy,
                        error: format!("{e:#}"),
                    },
                );
            }
        }
    });
}

fn spawn_waveform(events: Arc<dyn EventSink>, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &events,
            EVENT_STARTED,
            &JobStarted {
                media_id: media_id.to_string(),
                kind: JobKind::Waveform,
            },
        );

        let permit = ffmpeg_sem().acquire().await;
        if permit.is_err() {
            warn!("waveform job: semaphore closed; skipping {media_id}");
            return;
        }
        let result = waveform::run(&cache, &media).await;
        drop(permit);

        match result {
            Ok(waveform_path) => {
                let path_str = waveform_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    waveform_path: Some(waveform_path),
                    ..Default::default()
                };
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
                    warn!("waveform commit failed for {media_id}: {e}");
                    emit(
                        &events,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::Waveform,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("waveform ready for {media_id}");
                emit(
                    &events,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Waveform,
                        path: Some(path_str),
                    },
                );
            }
            Err(e) => {
                warn!("waveform job failed for {media_id}: {e:#}");
                emit(
                    &events,
                    EVENT_ERROR,
                    &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Waveform,
                        error: format!("{e:#}"),
                    },
                );
            }
        }
    });
}

fn emit<T: Serialize>(events: &Arc<dyn EventSink>, event: &str, payload: &T) {
    events.emit(event, serde_json::to_value(payload).unwrap_or(serde_json::Value::Null));
}

/// Re-read the latest `MediaItem` before ffmpeg starts so a background
/// import hash finalize doesn't leave jobs writing to stale `pending-*`
/// cache keys.
async fn fresh_media_item(
    project: &ProjectHandle,
    media_id: MediaId,
    fallback: MediaItem,
) -> MediaItem {
    project
        .snapshot()
        .await
        .media_pool
        .get(&media_id)
        .cloned()
        .unwrap_or(fallback)
}

/// Stamp every job-driven mutation with a stable Agent actor so history /
/// activity reads can distinguish background work from user / external-MCP
/// edits.
fn actor_for_jobs() -> Actor {
    Actor::Agent {
        client: "jobs".to_string(),
    }
}

/// Serializes the process-global `TS_DERIVATIVE_AUTHORITY` toggle tests and
/// resets the flag to `false` on drop (panic-safe). Two tests flipping the global
/// in parallel — or a panic between `set(true)` and a manual reset — would leak
/// `true` into other jobs tests in this binary. `pub(crate)` so the napi_backend
/// test can share the same lock.
#[cfg(test)]
pub(crate) static AUTHORITY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) struct AuthorityTestGuard(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

#[cfg(test)]
impl AuthorityTestGuard {
    pub(crate) fn acquire() -> Self {
        let g = AUTHORITY_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_ts_derivative_authority(false); // clean start regardless of any prior leak
        AuthorityTestGuard(g)
    }
}

#[cfg(test)]
impl Drop for AuthorityTestGuard {
    fn drop(&mut self) {
        set_ts_derivative_authority(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conform_in_flight_guard_dedups_until_ended() {
        let id = uuid::Uuid::new_v4();
        assert!(try_begin_conform(id), "first begin wins");
        assert!(!try_begin_conform(id), "second begin is deduped");
        end_conform(id);
        assert!(try_begin_conform(id), "free again after end");
        end_conform(id);
    }

    #[test]
    fn derivatives_patch_serializes_tristate() {
        use crate::state::MediaDerivativesPatch;
        use serde_json::json;

        // absent: outer None → key omitted entirely.
        let p = MediaDerivativesPatch { conform_path: Some("c.bin".into()), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("proxy_path").is_none(), "absent proxy_path must be omitted");
        assert_eq!(v.get("conform_path").unwrap(), &json!("c.bin"));

        // clear: Some(None) → null.
        let p = MediaDerivativesPatch { proxy_path: Some(None), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("proxy_path").unwrap(), &serde_json::Value::Null);

        // set: Some(Some(path)) → string.
        let p = MediaDerivativesPatch { quick_proxy_path: Some(Some("q.mp4".into())), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("quick_proxy_path").unwrap(), &json!("q.mp4"));

        // plain bool field skips when None, emits when Some.
        let p = MediaDerivativesPatch { proxy_bypassed: Some(true), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("proxy_bypassed").unwrap(), &json!(true));
    }

    #[tokio::test]
    async fn commit_derivatives_emits_event_when_ts_authoritative() {
        use crate::events::VecEventSink;
        use crate::state::{spawn, MediaDerivativesPatch, Project};
        use std::sync::Arc;

        let _authority = AuthorityTestGuard::acquire();

        let sink = Arc::new(VecEventSink::new());
        let events: Arc<dyn crate::events::EventSink> = sink.clone();
        let handle = spawn(Project::new_blank("ts-auth"));
        let media_id = uuid::Uuid::now_v7();

        set_ts_derivative_authority(true);
        let patch = MediaDerivativesPatch { proxy_path: Some(None), conform_path: Some("c.bin".into()), ..Default::default() };
        commit_media_derivatives(&events, &handle, media_id, patch).await.unwrap();

        let recorded = sink.events.lock().unwrap().clone();
        let (name, payload) = recorded.iter().find(|(n, _)| n == "media:derivatives")
            .expect("a media:derivatives event must be emitted in TS mode");
        assert_eq!(name, "media:derivatives");
        assert_eq!(payload.get("media_id").unwrap(), &serde_json::json!(media_id.to_string()));
        let patch_v = payload.get("patch").unwrap();
        assert_eq!(patch_v.get("proxy_path").unwrap(), &serde_json::Value::Null); // cleared
        assert_eq!(patch_v.get("conform_path").unwrap(), &serde_json::json!("c.bin"));
    }
}
