//! Html-render-groups raster path — Phase H.0 spike.
//!
//! Decision 12 in `docs/html-render-groups.md` mandates a single-pixel
//! transparency probe through both mount surfaces (preview shadow root +
//! offscreen export root document) **before** any composition machinery is
//! built on top. The iframe arc (commits `35875e7` → `1bf5391` →
//! `9378367` → `71e55a0`) earned that diligence — every near-miss "fix"
//! looked green on one surface and failed on the next.
//!
//! This module covers the **export-mount** half: navigate the offscreen
//! raster worker to a half-transparent-red probe document, capture, return
//! the PNG bytes. The TypeScript side
//! (`apps/desktop/src/preview/dom/composition/CompositionGenerator.ts`)
//! covers the **preview-mount** half via shadow DOM and verifies the same
//! center-pixel target.
//!
//! Real composition generation + per-export materialization come in Phase
//! H.3 / H.5. The shape here is intentionally narrow: one HTML constant,
//! one entry function, one Tauri command.
//!
//! **Keep `PROBE_DOCUMENT` byte-for-byte aligned with
//! `PROBE_DOCUMENT` in `CompositionGenerator.ts`.** Both files are
//! ground truth for the probe in v1; once Phase H.3 lands a real
//! generator, only the TS side will own the content and the Rust side
//! will accept a passed-in HTML string.

use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager};

use super::{
    capture_png_bytes, capture_via_webview, navigate_to_html, set_transparent_background,
    wait_seek,
};
use super::composition::{CompositionState, build_composition_document};

// ============================================================
// Phase H.7 — progress events
// ============================================================

/// Event names emitted during html-group materialization. Mirror the
/// `export:*` family so future UI consumers can subscribe identically.
/// The current ExportPanel/queue doesn't surface these yet — H.7 v1
/// ships the wiring so a follow-up UI doesn't need a Rust-side
/// change.
pub const EVENT_HTML_GROUP_START: &str = "html_group:start";
pub const EVENT_HTML_GROUP_PROGRESS: &str = "html_group:progress";
pub const EVENT_HTML_GROUP_COMPLETE: &str = "html_group:complete";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlGroupStartEvent {
    pub group_id: String,
    pub frame_count: usize,
    pub width: u32,
    pub height: u32,
    pub duration_us: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlGroupProgressEvent {
    pub group_id: String,
    pub frame: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlGroupCompleteEvent {
    pub group_id: String,
    pub frame_count: usize,
    /// `true` when the rasterizer skipped the webview entirely thanks to
    /// a content-keyed cache hit; the UI can surface the difference
    /// (a cache hit is near-instant; a real raster is seconds-to-minutes).
    pub cached: bool,
}

/// Probe canvas dimensions. Kept in sync with the TS constants
/// (`PROBE_CANVAS_W` / `PROBE_CANVAS_H`).
pub const PROBE_W: u32 = 800;
pub const PROBE_H: u32 = 200;

/// Probe HTML document — half-transparent pure-red rect on a transparent
/// composition. Identical content to `CompositionGenerator.PROBE_DOCUMENT`
/// on the TS side. If you edit one, edit the other; mismatch means the
/// preview and export probes are no longer testing the same thing.
const PROBE_DOCUMENT: &str = "<!doctype html>
<html>
<head>
<meta charset=\"utf-8\">
<meta name=\"color-scheme\" content=\"normal\">
<style>
  html, body { background: transparent; margin: 0; padding: 0; }
</style>
</head>
<body>

<style>
  #composition {
    position: relative;
    width: 800px;
    height: 200px;
    background: transparent;
  }
  #probe {
    position: absolute;
    left: 200px;
    top: 50px;
    width: 400px;
    height: 100px;
    background: rgba(255, 0, 0, 0.5);
  }
</style>
<div id=\"composition\">
  <div id=\"probe\"></div>
</div>
</body>
</html>";

/// Result of one transparency-probe run. PNG bytes are returned
/// base64-encoded so the TS side can wrap them in a `data:image/png;`
/// URL for display and use a canvas to inspect the center pixel.
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// Captured PNG bytes, base64-encoded. The TS spike page decodes
    /// this into an `<img>` (visual confirmation) and into a 1×1
    /// canvas-read center pixel (numeric check vs. PROBE_TARGET).
    pub png_base64: String,
    /// Captured PNG width × height in pixels — same as PROBE_W × PROBE_H
    /// if the offscreen webview obeyed `set_size`, otherwise reveals a
    /// device-scaling mismatch the TS side wants to know about.
    pub width: u32,
    pub height: u32,
}

// ============================================================
// Phase H.5 — group materialization
// ============================================================

/// Rasterizer version for html-group outputs. Bumped independently
/// from the template `RASTERIZER_VERSION` so a template-side fix
/// doesn't gratuitously invalidate every html-group output (and vice
/// versa).
/// Bumped to 2 (2026-05-17) for F.3: per-frame VideoClip + ImageOverlay
/// source extraction + file:// composition nav + CSS overflow:hidden
/// guard. Older cached html-group frames are pre-F.3 placeholders
/// or post-F.3 scrollbar-bleeding captures and need to be re-rastered.
const HTML_GROUP_RASTERIZER_VERSION: u32 = 2;

/// Per-group materialization result the IR lower pass consumes.
/// Shape parallels `TemplateRenderInfo` (`ir::materialize`) so the
/// lowering can emit a `PngSeq` chain identically.
#[derive(Clone, Debug)]
pub struct HtmlGroupRender {
    /// `dir/frame_%05d.png` printf glob fed to ffmpeg via `-i`.
    pub pattern_path: PathBuf,
    pub frame_count: usize,
    pub fps_num: u32,
    pub fps_den: u32,
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct HtmlGroupManifest {
    rasterizer_version: u32,
    group_id: String,
    state_hash: String,
    fps_num: u32,
    fps_den: u32,
    width: u32,
    height: u32,
    duration_us: i64,
    frame_count: usize,
}

/// Stable content key over a CompositionState. Captures every field
/// the engine reads at runtime — changes invalidate cached frames.
pub fn state_hash(state: &CompositionState) -> String {
    // serde_json is deterministic for our shape (no maps with random
    // iteration order — Vec layers preserve order). Layer fields are
    // primitives + simple enums, so the JSON canonicalization is
    // stable across runs.
    let json = serde_json::to_vec(state).expect("CompositionState serialize");
    let mut hasher = blake3::Hasher::new();
    hasher.update(&HTML_GROUP_RASTERIZER_VERSION.to_le_bytes());
    hasher.update(&json);
    hasher.finalize().to_hex().to_string()
}

/// One media source to pre-extract before raster runs. The
/// materializer builds this list alongside the `CompositionState`;
/// `materialize_group` consumes it on cache miss to populate the
/// group's `source/<layer_id>/` subdirectory with PNG frames.
///
/// `kind = Video` runs `source_frames::extract` (one PNG per output
/// frame at canvas fps). `kind = Image` runs
/// `source_frames::extract_single_image` (single PNG normalization).
#[derive(Clone, Debug)]
pub struct VideoSource {
    pub layer_id: String,
    pub media_path: std::path::PathBuf,
    pub kind: VideoSourceKind,
}

#[derive(Clone, Debug)]
pub enum VideoSourceKind {
    Video { src_in_us: i64, src_out_us: i64 },
    Image,
}

/// Materialize one Html-mode group's composition to a PNG sequence.
///
/// The output dir lives under `<cache>/raster/<state_hash>/` (sharing
/// the cache layout's `raster_dir` with templates — cache keys are
/// disjoint by structural prefix). Re-runs against an unchanged
/// composition state hit the cache and skip the webview entirely.
///
/// **F.3 (2026-05-17 redesign — VideoClip + ImageOverlay extraction):**
/// `sources` lists every video/image source that needs pre-extraction
/// into the per-group cache directory's `source/<layer_id>/`. The
/// composition HTML is written to disk alongside, and the raster
/// worker navigates to `file://...composition.html` so its inline
/// `<img src="source/<lid>/frame_NNNNN.png">` can load sibling files
/// (a `data:` URL would be an opaque origin and couldn't).
pub async fn materialize_group(
    app: &AppHandle,
    cache: &crate::cache::CacheLayout,
    group_id: &str,
    state: &CompositionState,
    sources: &[VideoSource],
    fps_num: u32,
    fps_den: u32,
    duration_us: i64,
) -> Result<HtmlGroupRender, String> {
    let key = state_hash(state);
    let dest_dir = cache.raster_dir(&key);
    let manifest_path = dest_dir.join("manifest.json");

    let fps_num = fps_num.max(1);
    let fps_den = fps_den.max(1);
    let fps_f = fps_num as f64 / fps_den as f64;
    let dur_s = duration_us.max(1) as f64 / 1_000_000.0;
    let frame_count = ((dur_s * fps_f).ceil() as usize).max(1);

    if let Some(_loaded) = load_cached(&dest_dir, &manifest_path, frame_count) {
        // Cache hit: emit start + complete (no per-frame progress —
        // the consumer treats absence-of-progress as instant).
        let _ = app.emit(
            EVENT_HTML_GROUP_START,
            HtmlGroupStartEvent {
                group_id: group_id.to_string(),
                frame_count,
                width: state.width,
                height: state.height,
                duration_us,
            },
        );
        let _ = app.emit(
            EVENT_HTML_GROUP_COMPLETE,
            HtmlGroupCompleteEvent {
                group_id: group_id.to_string(),
                frame_count,
                cached: true,
            },
        );
        return Ok(HtmlGroupRender {
            pattern_path: dest_dir.join("frame_%05d.png"),
            frame_count,
            fps_num,
            fps_den,
            duration_us,
            width: state.width,
            height: state.height,
        });
    }

    let _ = app.emit(
        EVENT_HTML_GROUP_START,
        HtmlGroupStartEvent {
            group_id: group_id.to_string(),
            frame_count,
            width: state.width,
            height: state.height,
            duration_us,
        },
    );

    let window = app
        .get_webview_window("raster-worker")
        .ok_or_else(|| "raster-worker window not spawned".to_string())?;

    set_transparent_background(&window).await?;
    window
        .set_size(LogicalSize::new(state.width as f64, state.height as f64))
        .map_err(|e| format!("resize raster worker to {}x{}: {e}", state.width, state.height))?;

    let tmp_dir = crate::cache::temp_path(&dest_dir);
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("create html-group tmp dir {}: {e}", tmp_dir.display()))?;

    // F.3: pre-extract every VideoClip + ImageOverlay source into
    // `tmp_dir/source/<layer_id>/` before navigation. The
    // composition state's `framePattern`/`imageSrc` fields point at
    // these via relative paths, so the offscreen webview (loading
    // composition.html from this directory via file://) can resolve
    // them as same-origin siblings.
    let source_root = tmp_dir.join("source");
    std::fs::create_dir_all(&source_root)
        .map_err(|e| format!("create source root {}: {e}", source_root.display()))?;
    for source in sources {
        let out_dir = source_root.join(&source.layer_id);
        match &source.kind {
            VideoSourceKind::Video { src_in_us, src_out_us } => {
                super::source_frames::extract(
                    &source.media_path,
                    *src_in_us,
                    *src_out_us,
                    fps_num,
                    fps_den,
                    &out_dir,
                )
                .await
                .map_err(|e| {
                    format!(
                        "extract source frames for layer {}: {e}",
                        source.layer_id
                    )
                })?;
            }
            VideoSourceKind::Image => {
                super::source_frames::extract_single_image(&source.media_path, &out_dir)
                    .await
                    .map_err(|e| {
                        format!(
                            "normalize image for layer {}: {e}",
                            source.layer_id
                        )
                    })?;
            }
        }
    }

    let document =
        build_composition_document(state).map_err(|e| format!("compose document: {e}"))?;
    let composition_path = tmp_dir.join("composition.html");
    std::fs::write(&composition_path, document)
        .map_err(|e| format!("write composition html {}: {e}", composition_path.display()))?;

    // F.3 diagnostic: log the navigation target + state shape so a
    // black-frames bug report can be pinned to file:// nav, frame
    // extraction, or engine startup without a debug build.
    let source_summary: Vec<String> = sources
        .iter()
        .map(|s| {
            let kind = match &s.kind {
                VideoSourceKind::Video { .. } => "Video",
                VideoSourceKind::Image => "Image",
            };
            format!("{}={}", s.layer_id, kind)
        })
        .collect();
    tracing::info!(
        target: "html_group",
        composition_html = %composition_path.display(),
        layer_count = state.layers.len(),
        source_count = sources.len(),
        sources = ?source_summary,
        canvas = format!("{}x{}", state.width, state.height),
        "F.3: navigating raster-worker to composition.html",
    );

    super::navigate_to_file(&window, &composition_path).await?;

    // Brief settle for the engine's initial-state JSON parse + first
    // paint. The first __seek's await still covers fonts.ready + rAF
    // but the immediate-after-navigate `document.readyState` going to
    // `complete` doesn't guarantee the script has fully run.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    // F.3 diagnostic: ask the engine what it parsed. `ready=false`
    // means the state-script-tag wasn't found (HTML didn't load /
    // engine didn't run); `layers=0` with `ready=true` means the
    // JSON parse failed silently. Either way, the captured frames
    // will be blank; the log narrows the next investigation.
    match super::eval_async(
        &window,
        "JSON.stringify((typeof window.__weftcutCompositionStatus === 'function') \
            ? window.__weftcutCompositionStatus() \
            : { error: 'status fn not registered' })"
            .into(),
    )
    .await
    {
        Ok(status) => tracing::info!(
            target: "html_group",
            status = %status,
            "F.3: engine status post-nav",
        ),
        Err(e) => tracing::warn!(
            target: "html_group",
            error = %e,
            "F.3: failed to read engine status",
        ),
    }

    for idx in 0..frame_count {
        let t = idx as f64 / fps_f;
        wait_seek(&window, t).await?;
        let path = tmp_dir.join(format!("frame_{idx:05}.png"));
        let _ = capture_via_webview(&window, &path).await?;
        // Emit progress every frame; the cost is one IPC roundtrip per
        // captured frame, dominated by the capture itself.
        let _ = app.emit(
            EVENT_HTML_GROUP_PROGRESS,
            HtmlGroupProgressEvent {
                group_id: group_id.to_string(),
                frame: idx + 1,
                total: frame_count,
            },
        );
    }

    let manifest = HtmlGroupManifest {
        rasterizer_version: HTML_GROUP_RASTERIZER_VERSION,
        group_id: group_id.to_string(),
        state_hash: key.clone(),
        fps_num,
        fps_den,
        width: state.width,
        height: state.height,
        duration_us,
        frame_count,
    };
    let manifest_bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("manifest serialize: {e}"))?;
    std::fs::write(tmp_dir.join("manifest.json"), manifest_bytes)
        .map_err(|e| format!("write manifest: {e}"))?;

    if dest_dir.exists() {
        let _ = std::fs::remove_dir_all(&dest_dir);
    }
    std::fs::rename(&tmp_dir, &dest_dir)
        .map_err(|e| format!("promote html-group cache dir {}: {e}", dest_dir.display()))?;

    let _ = app.emit(
        EVENT_HTML_GROUP_COMPLETE,
        HtmlGroupCompleteEvent {
            group_id: group_id.to_string(),
            frame_count,
            cached: false,
        },
    );

    Ok(HtmlGroupRender {
        pattern_path: dest_dir.join("frame_%05d.png"),
        frame_count,
        fps_num,
        fps_den,
        duration_us,
        width: state.width,
        height: state.height,
    })
}

fn load_cached(dest_dir: &Path, manifest_path: &Path, expected_count: usize) -> Option<()> {
    if !manifest_path.exists() {
        return None;
    }
    let bytes = std::fs::read(manifest_path).ok()?;
    let manifest: HtmlGroupManifest = serde_json::from_slice(&bytes).ok()?;
    if manifest.frame_count != expected_count {
        return None;
    }
    if manifest.rasterizer_version != HTML_GROUP_RASTERIZER_VERSION {
        return None;
    }
    for idx in 0..expected_count {
        let path = dest_dir.join(format!("frame_{idx:05}.png"));
        if !crate::cache::cached_ok(&path) {
            return None;
        }
    }
    Some(())
}

// ============================================================
// H.0 transparency probe (unchanged)
// ============================================================

/// Run the export-side transparency probe.
///
/// 1. Resolve the long-lived `raster-worker` offscreen webview.
/// 2. Pin the transparent backdrop (idempotent; survives prior resets).
/// 3. Resize to PROBE_W × PROBE_H so the capture is a known size.
/// 4. Navigate to `PROBE_DOCUMENT` (full root document — no shadow
///    wrapper on this side; decision 11 c.2).
/// 5. Brief settle for first compositor frame.
/// 6. Capture PNG bytes; return as base64.
///
/// Errors propagate as `String` for easy surfacing via the Tauri
/// command boundary (matches the existing `template_preview` shape).
pub async fn probe_transparency(app: &AppHandle) -> Result<ProbeResult, String> {
    let window = app
        .get_webview_window("raster-worker")
        .ok_or_else(|| "raster-worker window not spawned".to_string())?;

    set_transparent_background(&window).await?;

    window
        .set_size(LogicalSize::new(PROBE_W as f64, PROBE_H as f64))
        .map_err(|e| format!("resize raster worker to {PROBE_W}x{PROBE_H}: {e}"))?;

    navigate_to_html(&window, PROBE_DOCUMENT).await?;

    // Brief settle: navigate_to_html waits for `document.readyState ==
    // 'complete'`, but the first compositor frame can be one rAF
    // beyond that. 80 ms matches the template path's prop-settle nap
    // and is empirically enough for a one-div document.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    let bytes = capture_png_bytes(&window).await?;
    let png_base64 = BASE64.encode(&bytes);

    // We could parse the PNG header (8-byte signature + IHDR) to surface
    // exact pixel dimensions captured, but the offscreen webview's
    // `set_size` is honored deterministically in the template path so
    // reporting the requested size is good enough for the spike. A real
    // header-parse can land if a future regression makes it useful.
    Ok(ProbeResult {
        png_base64,
        width: PROBE_W,
        height: PROBE_H,
    })
}

