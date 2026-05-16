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

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use tauri::{AppHandle, LogicalSize, Manager};

use super::{capture_png_bytes, navigate_to_html, set_transparent_background};

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

