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
//! Job kinds today: `thumbnails`, `proxy`, `waveform`.

mod proxy;
mod thumbnails;
mod waveform;

pub use proxy::run as run_proxy;
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

fn ffmpeg_sem() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(MAX_PARALLEL_FFMPEG))
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Thumbnails,
    Proxy,
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
            spawn_thumbnails(app.clone(), cache.clone(), project.clone(), media.clone());
            spawn_proxy(app.clone(), cache.clone(), project.clone(), media.clone());
            // Waveform: only spawn if the video actually has an audio stream
            // (avoids a guaranteed-fail spawn for silent footage).
            if media.metadata.audio.is_some() {
                spawn_waveform(app.clone(), cache.clone(), project.clone(), media.clone());
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

fn spawn_thumbnails(
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(&app, EVENT_STARTED, &JobStarted {
            media_id: media_id.to_string(),
            kind: JobKind::Thumbnails,
        });

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
                    emit(&app, EVENT_ERROR, &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Thumbnails,
                        error: format!("commit: {e}"),
                    });
                    return;
                }
                info!("thumbnails ready for {media_id}");
                emit(&app, EVENT_COMPLETE, &JobComplete {
                    media_id: media_id.to_string(),
                    kind: JobKind::Thumbnails,
                    path: Some(path_str),
                });
            }
            Err(e) => {
                warn!("thumbnail job failed for {media_id}: {e:#}");
                emit(&app, EVENT_ERROR, &JobError {
                    media_id: media_id.to_string(),
                    kind: JobKind::Thumbnails,
                    error: format!("{e:#}"),
                });
            }
        }
    });
}

fn spawn_proxy(
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(&app, EVENT_STARTED, &JobStarted {
            media_id: media_id.to_string(),
            kind: JobKind::Proxy,
        });

        let permit = ffmpeg_sem().acquire().await;
        if permit.is_err() {
            warn!("proxy job: semaphore closed; skipping {media_id}");
            return;
        }
        let result = proxy::run(&cache, &media).await;
        drop(permit);

        match result {
            Ok(proxy_path) => {
                let path_str = proxy_path.display().to_string();
                let patch = MediaDerivativesPatch {
                    proxy_path: Some(proxy_path),
                    ..Default::default()
                };
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("proxy commit failed for {media_id}: {e}");
                    emit(&app, EVENT_ERROR, &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Proxy,
                        error: format!("commit: {e}"),
                    });
                    return;
                }
                info!("proxy ready for {media_id}");
                emit(&app, EVENT_COMPLETE, &JobComplete {
                    media_id: media_id.to_string(),
                    kind: JobKind::Proxy,
                    path: Some(path_str),
                });
            }
            Err(e) => {
                warn!("proxy job failed for {media_id}: {e:#}");
                emit(&app, EVENT_ERROR, &JobError {
                    media_id: media_id.to_string(),
                    kind: JobKind::Proxy,
                    error: format!("{e:#}"),
                });
            }
        }
    });
}

fn spawn_waveform(
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    tokio::spawn(async move {
        let media_id = media.id;
        emit(&app, EVENT_STARTED, &JobStarted {
            media_id: media_id.to_string(),
            kind: JobKind::Waveform,
        });

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
                    emit(&app, EVENT_ERROR, &JobError {
                        media_id: media_id.to_string(),
                        kind: JobKind::Waveform,
                        error: format!("commit: {e}"),
                    });
                    return;
                }
                info!("waveform ready for {media_id}");
                emit(&app, EVENT_COMPLETE, &JobComplete {
                    media_id: media_id.to_string(),
                    kind: JobKind::Waveform,
                    path: Some(path_str),
                });
            }
            Err(e) => {
                warn!("waveform job failed for {media_id}: {e:#}");
                emit(&app, EVENT_ERROR, &JobError {
                    media_id: media_id.to_string(),
                    kind: JobKind::Waveform,
                    error: format!("{e:#}"),
                });
            }
        }
    });
}

fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: &T) {
    let _ = app.emit(event, payload);
}

/// Stamp every job-driven mutation with a stable Agent actor so history /
/// activity reads can distinguish background work from user / external-MCP
/// edits.
fn actor_for_jobs() -> Actor {
    Actor::Agent {
        client: "jobs".to_string(),
    }
}
