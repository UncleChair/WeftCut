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

pub mod codec;
pub mod encoder;
pub mod failure;
pub mod manifest;
pub mod queue;
pub mod segmented;

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
use crate::ir::{
    emit_ffmpeg, lower, lower::rebase_project_for_segment, lower_range, materialize_inline_subtitles,
    RenderTarget,
};
use crate::state::layer::{LayerParams, SubtitlesSource};
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

/// Content hash for the segment `[in_us, out_us]` of `project`. Used by the
/// segmented preview cache (`docs/preview-segmented-cache.md`) — two project
/// states whose segment-local content is identical produce the same hash,
/// even if the segment sits at a different absolute timeline position.
///
/// Inputs:
///   - the lavfi sub-graph emitted by `lower_range` (segment-local time)
///   - blake3 of every media file referenced by surviving layers in the
///     rebased segment (sorted by MediaId for canonicality)
///   - canvas size + fps (sample_rate / channels deliberately omitted —
///     audio is whole-timeline, segments are video-only)
///
/// Deliberately NOT included:
///   - absolute `in_us` / `out_us` on the timeline. Inserting a 2s clip at
///     t=5 shifts every later segment's position; their hashes should be
///     unchanged so the diff algorithm short-circuits on "this segment
///     content is already in the cache, just re-time the manifest entry".
pub async fn segment_hash(
    project: &Project,
    cache: &CacheLayout,
    app: &AppHandle,
    in_us: i64,
    out_us: i64,
) -> Result<String> {
    let inline_subs = materialize_inline_subtitles(project, cache)
        .context("materialize inline subtitles")?;
    let template_renders = crate::ir::materialize_templates(project, cache, app)
        .await
        .context("materialize templates")?;
    segment_hash_core(project, &inline_subs, &template_renders, in_us, out_us)
}

/// Sync core of `segment_hash`. Separated so unit tests can hash arbitrary
/// projects without needing a real `AppHandle` for the template-render side.
/// Production code should call `segment_hash` which runs materialization
/// first; tests can pass `&Default::default()` for both materialization maps.
pub(crate) fn segment_hash_core(
    project: &Project,
    inline_subs: &crate::ir::InlineSubPaths,
    template_renders: &crate::ir::TemplateRenders,
    in_us: i64,
    out_us: i64,
) -> Result<String> {
    let target = RenderTarget::full(
        project.composition.width,
        project.composition.height,
        project.composition.fps,
        project.composition.sample_rate,
        project.composition.channels,
    );
    let graph = lower_range(project, target, inline_subs, template_renders, in_us, out_us)
        .context("lower_range")?;
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

    // Media references from the rebased project — only those actually used
    // by surviving layers in this segment. Sorted by MediaId so iteration
    // order doesn't leak into the hash (imbl::HashMap iteration order is
    // implementation-defined).
    let rebased = rebase_project_for_segment(project, in_us, out_us);
    let mut referenced: Vec<crate::state::ids::MediaId> = referenced_media_ids(&rebased)
        .into_iter()
        .collect();
    referenced.sort();
    for id in referenced {
        if let Some(item) = project.media_pool.get(&id) {
            hasher.update(b"\0media\0");
            hasher.update(item.file_hash_blake3.as_bytes());
        }
    }

    Ok(hasher.finalize().to_hex().to_string())
}

/// Build the full Manifest for `project`. Every segment + audio enters with
/// `status: Pending` — actual file production happens later via the
/// orchestrator's render queue.
pub async fn compute_manifest(
    project: &Project,
    cache: &CacheLayout,
    app: &AppHandle,
) -> Result<manifest::Manifest> {
    compute_manifest_with_profile(
        project,
        cache,
        app,
        codec::CodecProfile::default_for_platform(),
    )
    .await
}

/// Same as `compute_manifest` but with an explicit codec profile. Used
/// by the orchestrator so the profile chosen at workspace-open time
/// propagates into the manifest's codec strings.
pub async fn compute_manifest_with_profile(
    project: &Project,
    cache: &CacheLayout,
    app: &AppHandle,
    profile: codec::CodecProfile,
) -> Result<manifest::Manifest> {
    // global_hash = the same hash today's whole-timeline path uses. Any
    // change to the project changes it, so each project state gets its own
    // manifest+init+audio. Segments dedup at the segments/ subdir level
    // independently.
    let global_hash = state_hash(project, cache, app).await?;

    // Materialize side-maps once and reuse across every segment_hash call.
    let inline_subs = materialize_inline_subtitles(project, cache)
        .context("materialize inline subtitles")?;
    let template_renders = crate::ir::materialize_templates(project, cache, app)
        .await
        .context("materialize templates")?;

    let boundaries = crate::ir::compute_segment_boundaries(project);
    let mut segments = Vec::with_capacity(boundaries.len());
    for r in boundaries {
        let hash = segment_hash_core(project, &inline_subs, &template_renders, r.in_us, r.out_us)?;
        segments.push(manifest::SegmentEntry {
            in_us: r.in_us,
            out_us: r.out_us,
            hash,
            status: manifest::SegmentStatus::Pending,
        });
    }

    Ok(manifest::Manifest {
        global_hash,
        duration_us: project.composition.duration_us,
        canvas: manifest::CanvasParams {
            width: project.composition.width,
            height: project.composition.height,
            fps_num: project.composition.fps.num,
            fps_den: project.composition.fps.den,
        },
        video: manifest::VideoTrack {
            codec: profile.video_codec_string().to_string(),
            segments,
        },
        audio: manifest::AudioTrack {
            codec: profile.audio_codec_string().to_string(),
            status: manifest::SegmentStatus::Pending,
        },
    })
}

/// Sync core of `compute_manifest`. Skips the materialization pass; callers
/// must pass already-materialized inline_subs + template_renders. Used by
/// tests + the orchestrator's debounce loop.
pub(crate) fn compute_manifest_core(
    project: &Project,
    global_hash: String,
    inline_subs: &crate::ir::InlineSubPaths,
    template_renders: &crate::ir::TemplateRenders,
) -> Result<manifest::Manifest> {
    compute_manifest_core_with_profile(
        project,
        global_hash,
        inline_subs,
        template_renders,
        codec::CodecProfile::default_for_platform(),
    )
}

pub(crate) fn compute_manifest_core_with_profile(
    project: &Project,
    global_hash: String,
    inline_subs: &crate::ir::InlineSubPaths,
    template_renders: &crate::ir::TemplateRenders,
    profile: codec::CodecProfile,
) -> Result<manifest::Manifest> {
    let boundaries = crate::ir::compute_segment_boundaries(project);
    let mut segments = Vec::with_capacity(boundaries.len());
    for r in boundaries {
        let hash = segment_hash_core(project, inline_subs, template_renders, r.in_us, r.out_us)?;
        segments.push(manifest::SegmentEntry {
            in_us: r.in_us,
            out_us: r.out_us,
            hash,
            status: manifest::SegmentStatus::Pending,
        });
    }
    Ok(manifest::Manifest {
        global_hash,
        duration_us: project.composition.duration_us,
        canvas: manifest::CanvasParams {
            width: project.composition.width,
            height: project.composition.height,
            fps_num: project.composition.fps.num,
            fps_den: project.composition.fps.den,
        },
        video: manifest::VideoTrack {
            codec: profile.video_codec_string().to_string(),
            segments,
        },
        audio: manifest::AudioTrack {
            codec: profile.audio_codec_string().to_string(),
            status: manifest::SegmentStatus::Pending,
        },
    })
}

fn referenced_media_ids(project: &Project) -> std::collections::BTreeSet<crate::state::ids::MediaId> {
    let mut ids = std::collections::BTreeSet::new();
    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            match &layer.params {
                LayerParams::VideoClip(p) => {
                    ids.insert(p.media);
                }
                LayerParams::Audio(p) => {
                    ids.insert(p.media);
                }
                LayerParams::ImageOverlay(p) => {
                    ids.insert(p.media);
                }
                LayerParams::Subtitles(p) => {
                    if let SubtitlesSource::Media(id) = &p.source {
                        ids.insert(*id);
                    }
                }
                LayerParams::Text(_)
                | LayerParams::Color(_)
                | LayerParams::Template(_) => {}
            }
        }
    }
    ids
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
pub(crate) fn with_proxies_substituted(project: &Project) -> Project {
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

#[cfg(test)]
mod tests_segment_hash {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    use crate::state::animated::Animated;
    use crate::state::color::Rgba;
    use crate::state::composition::Composition;
    use crate::state::ids::{new_id, MediaId};
    use crate::state::layer::{Layer, LayerParams, VideoClipParams};
    use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
    use crate::state::project::{Project, ProjectMetadata};
    use crate::state::time::Rational;
    use crate::state::track::{Track, TrackKind};
    use crate::state::transform::Transform;

    fn mk_media(blake3: &str, duration_us: i64) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: "/m/a.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(duration_us),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: blake3.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    fn mk_video_layer(media: MediaId, t_start: i64, t_end: i64, src_in: i64, src_out: i64) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: t_start,
            t_end_us: t_end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::VideoClip(VideoClipParams {
                media,
                src_in_us: src_in,
                src_out_us: src_out,
                transform: Transform::default(),
                opacity: Animated::Static(1.0),
                crop: None,
                flip_h: false,
                flip_v: false,
                blend_mode: Default::default(),
                speed: 1.0,
                fade_in_us: 0,
                fade_out_us: 0,
            }),
        }
    }

    fn mk_project(duration_us: i64, layers: Vec<Layer>, media: Vec<MediaItem>) -> Project {
        let track = Track {
            id: new_id(),
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            height_px: 64,
            layers: layers.into_iter().collect(),
        };
        let mut media_pool = imbl::HashMap::new();
        for m in media {
            media_pool.insert(m.id, m);
        }
        Project {
            schema_version: 2,
            project_id: new_id(),
            metadata: ProjectMetadata {
                name: "hash-test".into(),
                created_at: Utc::now(),
                modified_at: Utc::now(),
                description: None,
            },
            composition: Composition {
                width: 1920,
                height: 1080,
                fps: Rational::FPS_30,
                duration_us,
                sample_rate: 48_000,
                channels: 2,
                color_space: Default::default(),
                background: Rgba::BLACK,
            },
            media_pool,
            tracks: imbl::vector![track],
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            groups: imbl::Vector::new(),
            settings: Default::default(),
        }
    }

    fn hash(project: &Project, in_us: i64, out_us: i64) -> String {
        segment_hash_core(project, &Default::default(), &Default::default(), in_us, out_us)
            .expect("segment_hash_core")
    }

    #[test]
    fn determinism() {
        let media = mk_media("blake3-a", 10_000_000);
        let clip = mk_video_layer(media.id, 0, 5_000_000, 0, 5_000_000);
        let p = mk_project(5_000_000, vec![clip], vec![media]);

        assert_eq!(hash(&p, 0, 5_000_000), hash(&p, 0, 5_000_000));
    }

    #[test]
    fn dedup_property_shift_insensitive() {
        // The load-bearing property: a segment whose content matches
        // another segment at a different timeline position has the same
        // hash. Without this, inserting a clip at t=0 would invalidate
        // every later segment.
        //
        // Project A: clip on timeline [0, 5], using source [0, 5].
        // Project B: same media, but clip on timeline [3, 8] (after 3s of
        // empty space). Source window still [0, 5].
        // Segment [0,5] of A and segment [3,8] of B must hash identically.
        let media_a = mk_media("blake3-shared", 10_000_000);
        let media_a_id = media_a.id;
        let clip_a = mk_video_layer(media_a_id, 0, 5_000_000, 0, 5_000_000);
        let a = mk_project(5_000_000, vec![clip_a], vec![media_a]);

        // For project B, reuse the same media (same blake3) — that's what
        // "shifted same clip" looks like.
        let media_b = MediaItem {
            id: media_a_id, // same id (same media in the pool)
            ..mk_media("blake3-shared", 10_000_000)
        };
        let clip_b = mk_video_layer(media_a_id, 3_000_000, 8_000_000, 0, 5_000_000);
        let b = mk_project(8_000_000, vec![clip_b], vec![media_b]);

        let hash_a = hash(&a, 0, 5_000_000);
        let hash_b = hash(&b, 3_000_000, 8_000_000);
        assert_eq!(
            hash_a, hash_b,
            "segments with identical local-time content must hash the same regardless of timeline position",
        );
    }

    #[test]
    fn media_content_change_invalidates_hash() {
        let m1 = mk_media("blake3-a", 10_000_000);
        let m1_id = m1.id;
        let clip = mk_video_layer(m1_id, 0, 5_000_000, 0, 5_000_000);
        let p1 = mk_project(5_000_000, vec![clip.clone()], vec![m1]);

        let m2 = MediaItem {
            id: m1_id,
            file_hash_blake3: "blake3-DIFFERENT".into(),
            ..mk_media("blake3-DIFFERENT", 10_000_000)
        };
        let p2 = mk_project(5_000_000, vec![clip], vec![m2]);

        assert_ne!(hash(&p1, 0, 5_000_000), hash(&p2, 0, 5_000_000));
    }

    #[test]
    fn canvas_size_change_invalidates_hash() {
        let media = mk_media("blake3-a", 10_000_000);
        let clip = mk_video_layer(media.id, 0, 5_000_000, 0, 5_000_000);
        let mut p1 = mk_project(5_000_000, vec![clip], vec![media]);
        let mut p2 = p1.clone();
        p2.composition.width = 1280;
        p2.composition.height = 720;

        assert_ne!(hash(&p1, 0, 5_000_000), hash(&p2, 0, 5_000_000));
    }

    #[test]
    fn different_source_window_changes_hash() {
        // Two clips with the same media but different source windows must
        // produce different hashes — they render different pixels.
        let media = mk_media("blake3-a", 10_000_000);
        let media_id = media.id;
        let p1 = mk_project(
            5_000_000,
            vec![mk_video_layer(media_id, 0, 5_000_000, 0, 5_000_000)],
            vec![media.clone()],
        );
        let p2 = mk_project(
            5_000_000,
            vec![mk_video_layer(media_id, 0, 5_000_000, 2_000_000, 7_000_000)],
            vec![media],
        );

        assert_ne!(hash(&p1, 0, 5_000_000), hash(&p2, 0, 5_000_000));
    }

    #[test]
    fn empty_segment_in_empty_project_hashes() {
        // The segment_hash on an empty range must succeed and be stable.
        let p = mk_project(5_000_000, vec![], vec![]);
        let h1 = hash(&p, 1_000_000, 3_000_000);
        let h2 = hash(&p, 1_000_000, 3_000_000);
        assert_eq!(h1, h2);
        assert!(!h1.is_empty());
    }

    fn manifest_for(project: &Project) -> manifest::Manifest {
        compute_manifest_core(
            project,
            "test-global".to_string(),
            &Default::default(),
            &Default::default(),
        )
        .expect("compute_manifest_core")
    }

    #[test]
    fn empty_project_manifest_has_no_segments() {
        let p = mk_project(0, vec![], vec![]);
        let m = manifest_for(&p);
        assert_eq!(m.global_hash, "test-global");
        assert_eq!(m.duration_us, 0);
        assert!(m.video.segments.is_empty());
    }

    #[test]
    fn single_segment_project_produces_one_entry() {
        // 3s project, no layers — boundary algorithm returns one [0, 3s] range.
        let p = mk_project(3_000_000, vec![], vec![]);
        let m = manifest_for(&p);
        assert_eq!(m.video.segments.len(), 1);
        let seg = &m.video.segments[0];
        assert_eq!(seg.in_us, 0);
        assert_eq!(seg.out_us, 3_000_000);
        assert_eq!(seg.status, manifest::SegmentStatus::Pending);
        assert!(!seg.hash.is_empty());
    }

    #[test]
    fn multi_segment_project_segments_cover_duration_contiguously() {
        // 12s empty project: fixed-step splits at 5s → [0,5][5,10][10,12].
        let p = mk_project(12_000_000, vec![], vec![]);
        let m = manifest_for(&p);
        assert_eq!(m.video.segments.len(), 3);
        assert_eq!(m.video.segments[0].in_us, 0);
        assert_eq!(m.video.segments[0].out_us, 5_000_000);
        assert_eq!(m.video.segments[1].in_us, 5_000_000);
        assert_eq!(m.video.segments[1].out_us, 10_000_000);
        assert_eq!(m.video.segments[2].in_us, 10_000_000);
        assert_eq!(m.video.segments[2].out_us, 12_000_000);
        // The first two segments are both "5s of empty Color" — they
        // SHOULD hash identically (dedup property). The third differs
        // because its duration is 2s.
        assert_eq!(
            m.video.segments[0].hash, m.video.segments[1].hash,
            "two empty 5s segments must dedup to the same hash",
        );
        assert_ne!(
            m.video.segments[1].hash, m.video.segments[2].hash,
            "different duration → different content → different hash",
        );
    }

    #[test]
    fn distinct_content_produces_distinct_segment_hashes() {
        // Project with a clip overlapping part of the timeline — segments
        // containing the clip must hash differently from empty segments.
        let media = mk_media("blake3-c", 10_000_000);
        let media_id = media.id;
        let clip = mk_video_layer(media_id, 2_000_000, 8_000_000, 0, 6_000_000);
        let p = mk_project(10_000_000, vec![clip], vec![media]);

        let m = manifest_for(&p);
        // Boundaries: {0, 2, 8, 10}; ranges [0,2],[2,7],[7,8],[8,10].
        assert!(m.video.segments.len() >= 3, "expected multiple segments: {:?}", m.video.segments);
        let with_clip: Vec<_> = m
            .video
            .segments
            .iter()
            .filter(|s| s.in_us >= 2_000_000 && s.out_us <= 8_000_000)
            .collect();
        let without_clip: Vec<_> = m
            .video
            .segments
            .iter()
            .filter(|s| s.out_us <= 2_000_000 || s.in_us >= 8_000_000)
            .collect();
        assert!(!with_clip.is_empty());
        assert!(!without_clip.is_empty());
        // Clip-containing segments must NOT share hashes with empty segments.
        for c in &with_clip {
            for e in &without_clip {
                assert_ne!(
                    c.hash, e.hash,
                    "clip segment hash matched empty segment: {} == {}",
                    c.hash, e.hash,
                );
            }
        }
    }

    #[test]
    fn canvas_params_propagate_to_manifest() {
        let mut p = mk_project(3_000_000, vec![], vec![]);
        p.composition.width = 1280;
        p.composition.height = 720;
        let m = manifest_for(&p);
        assert_eq!(m.canvas.width, 1280);
        assert_eq!(m.canvas.height, 720);
        assert_eq!(m.canvas.fps_num, 30);
        assert_eq!(m.canvas.fps_den, 1);
    }

    #[test]
    fn manifest_codecs_match_mse_pinning() {
        // The codec strings are part of the MSE wire contract — MUST
        // match what the segment encoder will emit. A mismatch silently
        // rejects appendBuffer() on the React side.
        // On Linux builds the manifest uses VP9+Opus; everywhere else
        // H.264+AAC.
        let p = mk_project(3_000_000, vec![], vec![]);
        let m = manifest_for(&p);
        if cfg!(target_os = "linux") {
            assert_eq!(m.video.codec, "vp09.00.41.08");
            assert_eq!(m.audio.codec, "opus");
        } else {
            assert_eq!(m.video.codec, "avc1.640028");
            assert_eq!(m.audio.codec, "mp4a.40.2");
        }
    }
}
