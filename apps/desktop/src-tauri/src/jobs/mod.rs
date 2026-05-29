//! Background-job pipeline for media derivatives.
//!
//! Each `enqueue_*` spawns a tokio task that runs ffmpeg under a global
//! semaphore (default 2 concurrent ffmpeg children — importing 10 files at
//! once shouldn't fork-bomb the host). On completion, the task patches the
//! `MediaItem`'s derivative path through the actor's
//! `set_media_derivatives` so subscribers (UI, hot-reload, MCP change feed)
//! re-fetch.
//!
//! Atomicity: all writes go through `cache::temp_path` + `promote_temp`. A
//! killed ffmpeg leaves a `<dest>.tmp` that the next run discards, never a
//! zero-byte `<dest>` that fools skip-if-cached.
//!
//! Tauri events for UI:
//! - `media:job_started`  — `{ media_id, kind }`
//! - `media:job_complete` — `{ media_id, kind, path? }`
//! - `media:job_error`    — `{ media_id, kind, error }`
//!
//! Job kinds today: `thumbnails`, `proxy`, `quick_proxy`, `proxy_bypass`,
//! `waveform`.

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

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::cache::CacheLayout;
use crate::state::{Actor, MediaDerivativesPatch, MediaId, MediaItem, MediaKind, ProjectHandle};

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

/// Look at a freshly imported `MediaItem` and fan out the appropriate
/// background jobs. Returns immediately; jobs run on tokio::spawn.
pub fn enqueue_for_media(
    app: AppHandle,
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
                spawn_decorations(app, cache, project, media);
            } else {
                spawn_proxy_decision(app, cache, project, media);
            }
        }
        MediaKind::Audio => {
            spawn_waveform(app.clone(), cache.clone(), project.clone(), media.clone());
        }
        MediaKind::Image | MediaKind::Subtitle => {
            // No derivatives needed.
        }
    }
}

fn spawn_decorations(app: AppHandle, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    if matches!(media.kind, MediaKind::Video) {
        spawn_thumbnails(app.clone(), cache.clone(), project.clone(), media.clone());
    }
    if media.metadata.audio.is_some() {
        spawn_waveform(app, cache, project, media);
    }
}

fn spawn_proxy_decision(
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        use tauri::Manager;
        let caps = app
            .try_state::<crate::decode_caps::DecodeCapabilityStore>()
            .map(|s| s.get())
            .unwrap_or_default();
        match proxy_decision::decide(&media, &caps) {
            proxy_decision::ProxyPlan::DirectBoth => {
                emit(
                    &app,
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
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("proxy bypass commit failed for {media_id}: {e}");
                    emit(
                        &app,
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
                    &app,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                spawn_decorations(app, cache, project, media);
            }
            proxy_decision::ProxyPlan::DirectExportQuickPreview => {
                emit(
                    &app,
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
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("direct-export commit failed for {media_id}: {e}");
                    emit(
                        &app,
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
                    &app,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                // Thumbnails + waveform off the original; preview proxy in the
                // background WITHOUT chaining a full proxy.
                spawn_decorations(app.clone(), cache.clone(), project.clone(), media.clone());
                spawn_quick_proxy(app, cache, project, media, false);
            }
            proxy_decision::ProxyPlan::FullProxyOnly => {
                spawn_proxy(app, cache, project, media);
            }
            proxy_decision::ProxyPlan::QuickThenFull => {
                spawn_quick_proxy(app, cache, project, media, true);
            }
        }
    });
}

fn spawn_thumbnails(app: AppHandle, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &app,
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
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("thumbnail commit failed for {media_id}: {e}");
                    emit(
                        &app,
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
                    &app,
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
                    &app,
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
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
    then_full: bool,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &app,
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
        let result = quick_proxy::run(&cache, &media).await;
        drop(permit);

        match result {
            Ok(quick_proxy_path) => {
                let path_str = quick_proxy_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    quick_proxy_path: Some(Some(quick_proxy_path)),
                    proxy_bypassed: Some(false),
                    ..Default::default()
                };
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("quick proxy commit failed for {media_id}: {e}");
                    emit(
                        &app,
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
                        &app,
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
                    &app,
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
            // case the workspace copy + blake3 landed while Phase 1 was queued.
            let media = fresh_media_item(&project, media_id, media).await;
            spawn_proxy(app, cache, project, media);
        }
    });
}

fn spawn_proxy(app: AppHandle, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &app,
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
                    quick_proxy_path: Some(None),
                    proxy_bypassed: Some(false),
                    ..Default::default()
                };
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("proxy commit failed for {media_id}: {e}");
                    emit(
                        &app,
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
                    &app,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::Proxy,
                        path: Some(path_str),
                    },
                );
                spawn_decorations(app, cache, project, thumbnail_media);
            }
            Err(e) => {
                warn!("proxy job failed for {media_id}: {e:#}");
                emit(
                    &app,
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

fn spawn_waveform(app: AppHandle, cache: CacheLayout, project: ProjectHandle, media: MediaItem) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(
            &app,
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
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("waveform commit failed for {media_id}: {e}");
                    emit(
                        &app,
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
                    &app,
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
                    &app,
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

fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: &T) {
    let _ = app.emit(event, payload);
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
