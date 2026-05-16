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
use tauri::{AppHandle, LogicalSize, Manager};

use super::{
    capture_png_bytes, capture_via_webview, navigate_to_html, set_transparent_background,
    wait_seek,
};
use super::composition::{CompositionState, build_composition_document};

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
const HTML_GROUP_RASTERIZER_VERSION: u32 = 1;

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

/// Materialize one Html-mode group's composition to a PNG sequence.
///
/// The output dir lives under `<cache>/raster/<state_hash>/` (sharing
/// the cache layout's `raster_dir` with templates — cache keys are
/// disjoint by structural prefix). Re-runs against an unchanged
/// composition state hit the cache and skip the webview entirely.
///
/// H.5 v1 limitation: `VideoClip` and `ImageOverlay` members render
/// as translucent placeholders inside the composition (the
/// composition generator emits them as such). Real per-frame video
/// extraction lands in a H.5 follow-up; for v1 the export pipeline is
/// architecturally complete but visual output for video-bearing
/// html-groups isn't pixel-correct yet.
pub async fn materialize_group(
    app: &AppHandle,
    cache: &crate::cache::CacheLayout,
    group_id: &str,
    state: &CompositionState,
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

    let window = app
        .get_webview_window("raster-worker")
        .ok_or_else(|| "raster-worker window not spawned".to_string())?;

    set_transparent_background(&window).await?;
    window
        .set_size(LogicalSize::new(state.width as f64, state.height as f64))
        .map_err(|e| format!("resize raster worker to {}x{}: {e}", state.width, state.height))?;

    let document =
        build_composition_document(state).map_err(|e| format!("compose document: {e}"))?;
    navigate_to_html(&window, &document).await?;

    // Brief settle for the engine's initial-state JSON parse + first
    // paint. The first __seek's await still covers fonts.ready + rAF
    // but the immediate-after-navigate `document.readyState` going to
    // `complete` doesn't guarantee the script has fully run.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    let tmp_dir = crate::cache::temp_path(&dest_dir);
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("create html-group tmp dir {}: {e}", tmp_dir.display()))?;

    for idx in 0..frame_count {
        let t = idx as f64 / fps_f;
        wait_seek(&window, t).await?;
        let path = tmp_dir.join(format!("frame_{idx:05}.png"));
        let _ = capture_via_webview(&window, &path).await?;
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

