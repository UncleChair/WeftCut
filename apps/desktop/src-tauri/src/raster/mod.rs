//! Offscreen wry-based rasterizer turning HTML overlay templates into PNG sequences.
//!
//! Time-mock JS shim drives the page deterministically — `__seek(t)` advances clock,
//! flushes rAF + Web Animations, and waits for fonts before each capture. PNGs land in
//! a content-keyed cache (sled + filesystem, 5 GB LRU).
//!
//! Design: `docs/rendering.md` part 2.
//!
//! Phase 0 spike: spawn one hidden `wry` webview off-screen, load a static page, call
//! the platform snapshot API once and write the PNG to disk:
//!   Windows: `CapturePreview` on the WebView2 controller.
//!   macOS:   `WKWebView.takeSnapshot(with:completionHandler:)`.
//!   Linux:   `webkit_web_view_get_snapshot` (async; soft spot — fall back to bundled
//!            headless Chromium via `chromiumoxide` if WebKitGTK misbehaves).
//!
//! `spawn_spike` validates the offscreen-webview half of the spike. Real PNG capture
//! is the Phase 5 job (`docs/rendering.md` part 2).

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::info;

const SPIKE_HTML: &str = "data:text/html,<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;background:%231f2937;color:%2360a5fa;font:14px ui-sans-serif,system-ui;display:flex;align-items:center;justify-content:center;height:100vh}</style></head><body>raster spike</body></html>";

pub fn spawn_spike(app: &AppHandle) -> Result<()> {
    if app.get_webview_window("raster-worker").is_some() {
        return Ok(()); // already spawned (e.g., dev hot-reload)
    }

    let url: tauri::Url = SPIKE_HTML.parse().context("parse spike data URL")?;
    let _window = WebviewWindowBuilder::new(app, "raster-worker", WebviewUrl::External(url))
        .visible(false)
        .inner_size(800.0, 200.0)
        .resizable(false)
        .skip_taskbar(true)
        .build()
        .context("build offscreen raster worker window")?;

    info!("raster spike: hidden webview spawned (Phase 5 will add PNG capture)");
    Ok(())
}
