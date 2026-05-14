//! Project-preview renderer + debounced background trigger.
//!
//! Per `docs/workspace-redesign.md` Q10 the project preview is now a DOM
//! `<video>` element pointed at a state-hashed MP4 on disk, **not** an
//! embedded libmpv HWND. This module owns the render path:
//!
//!   * [`state_hash`] — deterministic key over the project + workspace
//!     paths. Same project state → same hash → same MP4 → instant `src`
//!     swap with no ffmpeg work. The hash covers everything that would
//!     change pixels: the canonical lavfi graph, every input file's
//!     blake3, the canvas params.
//!   * [`render`] — produce `<workspace>/Cache/preview/<hash>.mp4` if it
//!     doesn't exist. Substitutes the per-clip 540p proxy
//!     (`MediaItem.proxy_path`) for the original when present so the
//!     encode is cheap even on 4K sources.
//!   * [`PreviewRenderer::spawn`] — subscriber task. On every actor
//!     commit, debounces 1 s, then triggers a render if the latest
//!     hash differs from the current one. Emits Tauri events so the UI
//!     can swap its `<video>` src.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;
use tracing::{info, warn};

use crate::cache::{cached_ok, CacheLayout};
use crate::export;
use crate::ir::{emit_ffmpeg, lower, materialize_inline_subtitles, RenderTarget};
use crate::state::{Project, ProjectHandle};

pub mod events {
    pub const STARTED: &str = "preview:render_started";
    pub const COMPLETE: &str = "preview:render_complete";
    pub const ERROR: &str = "preview:render_error";
}

const DEBOUNCE: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReady {
    pub state_hash: String,
    pub path: String,
    pub duration_us: i64,
}

/// Compute the canonical state hash for `project`.
///
/// Includes:
///   - lavfi graph emitted from the project's current state
///   - every input file's blake3 hash (so a content change in any
///     referenced media invalidates the cache)
///   - canvas dimensions + fps + sample-rate + channels
///
/// Excludes:
///   - project metadata (name, modified_at)
///   - history cursor
///   - layer / track / media UUIDs (the lavfi graph already encodes the
///     ordering that matters; raw UUIDs would invalidate the cache on a
///     pure-reorder that ends up producing identical output)
pub async fn state_hash(
    project: &Project,
    cache: &CacheLayout,
    app: &AppHandle,
) -> Result<String> {
    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        project.composition.sample_rate,
        project.composition.channels,
    );
    let inline_subs = materialize_inline_subtitles(project, cache)
        .context("materialize inline subtitles")?;
    // Templates are content-addressed by render inputs, so their hashes
    // contribute via the inline subs / lavfi graph downstream. Native
    // `.await` here — calling `tauri::async_runtime::block_on` from
    // inside an already-async tokio task would deadlock-or-panic and
    // the preview loop's task would silently die after the first
    // commit.
    let template_renders = crate::ir::materialize_templates(project, cache, app)
        .await
        .context("materialize templates")?;
    let graph = lower(project, target, &inline_subs, &template_renders).context("lower IR")?;
    let plan = emit_ffmpeg(&graph);

    let mut hasher = blake3::Hasher::new();
    hasher.update(plan.filter_graph.as_bytes());
    hasher.update(b"\0width\0");
    hasher.update(&project.composition.width.to_le_bytes());
    hasher.update(b"\0height\0");
    hasher.update(&project.composition.height.to_le_bytes());
    hasher.update(b"\0fps_num\0");
    hasher.update(&project.composition.fps.num.to_le_bytes());
    hasher.update(b"\0fps_den\0");
    hasher.update(&project.composition.fps.den.to_le_bytes());
    hasher.update(b"\0sr\0");
    hasher.update(&project.composition.sample_rate.to_le_bytes());
    hasher.update(b"\0ch\0");
    hasher.update(&[project.composition.channels]);

    // Sort by media id (stringified) so iteration order doesn't leak into
    // the hash. imbl's HashMap iteration order is implementation-defined.
    let mut media_ids: Vec<_> = project.media_pool.keys().copied().collect();
    media_ids.sort();
    for id in media_ids {
        if let Some(item) = project.media_pool.get(&id) {
            hasher.update(b"\0media\0");
            hasher.update(item.file_hash_blake3.as_bytes());
        }
    }

    Ok(hasher.finalize().to_hex().to_string())
}

/// Render the project to `<workspace>/Cache/preview/<state_hash>.mp4`.
/// Returns the absolute path of the rendered MP4. On cache hit (the
/// destination exists with non-zero size), returns immediately without
/// invoking ffmpeg.
///
/// Substitutes per-clip 540p proxies for the originals when
/// `MediaItem.proxy_path` is populated AND the proxy file exists on disk.
/// This is the load-bearing optimization that makes preview cheap on 4K
/// sources. Falls back to the original for clips whose proxy hasn't been
/// generated yet (race during a fresh import); subsequent renders pick up
/// the proxy once `jobs::proxy` finishes.
pub async fn render(
    app: AppHandle,
    project: &Project,
    cache: &CacheLayout,
) -> Result<PathBuf> {
    let hash = state_hash(project, cache, &app).await?;
    let dest = cache.preview(&hash);

    if cached_ok(&dest) {
        return Ok(dest);
    }

    // Ensure the preview/ dir exists. `cache.ensure_dirs()` runs at
    // workspace-open time but during the brief blank-on-boot window
    // before `set_workspace`, the dir may not exist yet — defensive.
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create {}", parent.display()))?;
    }

    // Swap originals → proxies for the render. Render into a clone so the
    // actor's snapshot stays canonical (this isn't a state mutation).
    let project_for_render = with_proxies_substituted(project);

    // `run_render_silent`, not `run_render`: the export-pipeline events
    // (`export:progress` / `export:complete` / `export:error`) are
    // wired to the React `<ExportPanel>` and would pop a "Exported to
    // ..." toast on every preview re-render. The preview module emits
    // its own `preview:render_*` events for status.
    export::run_render_silent(
        app,
        &project_for_render,
        &dest,
        export::ExportPreset::default(),
    )
    .await
    .context("preview render")?;

    Ok(dest)
}

/// Clone the project with each MediaItem.path_abs replaced by its
/// `proxy_path` when that proxy exists on disk. Per-clip proxies are 540p
/// H.264 (`jobs::proxy::PROXY_HEIGHT`); the lavfi graph scales to the
/// canvas anyway so resolution substitution is transparent.
fn with_proxies_substituted(project: &Project) -> Project {
    let mut next = project.clone();
    let updates: Vec<_> = next
        .media_pool
        .iter()
        .filter_map(|(id, item)| {
            let proxy = item.proxy_path.as_ref()?;
            if !proxy.is_file() {
                return None;
            }
            let mut swapped = item.clone();
            swapped.path_abs = proxy.clone();
            Some((*id, swapped))
        })
        .collect();
    for (id, item) in updates {
        next.media_pool.insert(id, item);
    }
    next
}

/// Background subscriber that renders the preview whenever the project
/// changes. 1 s debounce coalesces rapid edits (e.g. a drag emitting one
/// commit per move tick) into a single render.
#[derive(Clone)]
pub struct PreviewRenderer {
    inner: Arc<Mutex<PreviewRendererInner>>,
}

struct PreviewRendererInner {
    current_hash: Option<String>,
    current_path: Option<PathBuf>,
    in_flight: bool,
}

impl PreviewRenderer {
    pub fn spawn(app: AppHandle, handle: ProjectHandle) -> Self {
        let me = Self {
            inner: Arc::new(Mutex::new(PreviewRendererInner {
                current_hash: None,
                current_path: None,
                in_flight: false,
            })),
        };
        let me_for_loop = me.clone();
        tauri::async_runtime::spawn(async move {
            preview_loop(app, handle, me_for_loop).await;
        });
        me
    }

    /// Current preview MP4 path on disk, if a render has landed. Used by
    /// the React preview component on mount to set the initial
    /// `<video src>` without waiting for the next commit.
    pub fn current_path(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .expect("preview lock")
            .current_path
            .clone()
    }

    fn record(&self, hash: String, path: PathBuf) {
        let mut g = self.inner.lock().expect("preview lock");
        g.current_hash = Some(hash);
        g.current_path = Some(path);
    }
}

async fn preview_loop(app: AppHandle, handle: ProjectHandle, renderer: PreviewRenderer) {
    let mut rx = handle.subscribe();
    info!("preview renderer subscribed; waiting for commits");
    loop {
        // Wait for the first sign of work.
        match rx.recv().await {
            Ok(_) => {}
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => return,
        }

        // Debounce: keep draining events until 1s of quiet.
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

        // Quiet window elapsed. Take the latest snapshot and render if
        // the hash changed from what we currently have on disk.
        let cache = match app.try_state::<CacheLayout>() {
            Some(c) => c.inner().clone(),
            None => {
                warn!("preview: no cache layout managed; skipping render");
                continue;
            }
        };
        let project = handle.snapshot().await;
        let hash = match state_hash(&project, &cache, &app).await {
            Ok(h) => h,
            Err(e) => {
                warn!("preview: state_hash failed: {e:#}");
                continue;
            }
        };
        let already = renderer.inner.lock().expect("preview lock").current_hash.clone();
        if already.as_deref() == Some(hash.as_str()) {
            // No change — nothing to render.
            continue;
        }
        // No layers: nothing to render. `run_render` rejects projects
        // with no decoded inputs, and the React side gates `hasContent`
        // on `layer_count > 0` so it already shows the empty hint.
        // Importing media into the pool without dragging it onto the
        // timeline lands here.
        if project.tracks.iter().all(|t| t.layers.is_empty()) {
            continue;
        }
        {
            let mut g = renderer.inner.lock().expect("preview lock");
            if g.in_flight {
                continue;
            }
            g.in_flight = true;
        }
        let _ = app.emit(events::STARTED, serde_json::json!({ "stateHash": &hash }));
        let result = render(app.clone(), &project, &cache).await;
        renderer.inner.lock().expect("preview lock").in_flight = false;
        match result {
            Ok(path) => {
                info!("preview rendered → {}", path.display());
                renderer.record(hash.clone(), path.clone());
                let ready = PreviewReady {
                    state_hash: hash,
                    path: path.to_string_lossy().to_string(),
                    duration_us: project.composition.duration_us.max(1_000_000),
                };
                let _ = app.emit(events::COMPLETE, ready);
            }
            Err(e) => {
                let detail = format!("{e:#}");
                warn!("preview render failed: {detail}");
                let _ = app
                    .emit(events::ERROR, serde_json::json!({ "detail": detail }));
            }
        }
    }
}
