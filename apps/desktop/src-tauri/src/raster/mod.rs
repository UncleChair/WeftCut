//! Offscreen wry-based rasterizer turning HTML overlay templates into PNG sequences.
//!
//! Time-mock JS shim drives the page deterministically — `__seek(t)` advances clock,
//! flushes rAF + Web Animations, and waits for fonts before each capture. PNGs land in
//! a content-keyed cache (sled + filesystem, 5 GB LRU).
//!
//! Design: `docs/rendering.md` part 2.
//!
//! Phase 5 spike (in progress): the WebView2 capture path is wired on Windows; macOS
//! and Linux are stubbed. The spike validates the load-bearing question: can we get a
//! non-empty PNG out of the offscreen webview? Everything downstream (time-mock shim,
//! templates, IR `PngSeq` node, cache layer) is plumbing if this works.
//!
//!   Windows: `CapturePreview` on the WebView2 controller (this file).
//!   macOS:   `WKWebView.takeSnapshot(with:completionHandler:)`  (not yet wired).
//!   Linux:   `webkit_web_view_get_snapshot` (async; soft spot — fall back to bundled
//!            headless Chromium via `chromiumoxide` if WebKitGTK misbehaves).

use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::{info, warn};

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

/// Schedule a one-shot capture of the raster-worker webview after a short load
/// delay. Writes the PNG to `<cache>/raster-spike.png` and logs the byte count
/// (or the failure reason). Driven from app startup so the spike runs without
/// any UI action.
pub fn schedule_capture_spike(app: &AppHandle, dest: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Give the webview time to load the data URL + ready any fonts.
        // 1500 ms is conservative; the spike page is trivial.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let window = match app.get_webview_window("raster-worker") {
            Some(w) => w,
            None => {
                warn!("raster capture spike: raster-worker window missing");
                return;
            }
        };
        let dest_for_capture = dest.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<u64, String>>();
        let result = window.with_webview(move |webview| {
            let outcome = capture_to_file(webview, &dest_for_capture);
            let _ = tx.send(outcome);
        });
        if let Err(e) = result {
            warn!("raster capture spike: with_webview failed: {e:?}");
            return;
        }
        match rx.await {
            Ok(Ok(bytes)) => info!(
                "raster capture spike: wrote {bytes} bytes to {}",
                dest.display()
            ),
            Ok(Err(msg)) => warn!("raster capture spike: capture failed: {msg}"),
            Err(e) => warn!("raster capture spike: oneshot channel closed: {e}"),
        }
    });
}

#[cfg(windows)]
fn capture_to_file(
    webview: tauri::webview::PlatformWebview,
    dest: &std::path::Path,
) -> Result<u64, String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, ICoreWebView2,
    };
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let controller = webview.controller();
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("get CoreWebView2: {e}"))?;
    // hglobal = null + delete_on_release = true asks Windows to allocate and
    // own the backing buffer; freeing the IStream frees the HGLOBAL.
    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
        .map_err(|e| format!("CreateStreamOnHGlobal: {e}"))?;
    let stream_for_call = stream.clone();
    CapturePreviewCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| -> webview2_com::Result<()> {
            unsafe {
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream_for_call,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }
        }),
        Box::new(move |hr| -> windows::core::Result<()> {
            // `hr` here is already a `Result<(), Error>` — webview2-com's
            // ClosureArg impl converts the raw HRESULT via `.ok()` before
            // handing it to us. Just pass it through.
            hr
        }),
    )
    .map_err(|e| format!("CapturePreview async op: {e}"))?;

    // Stream now holds the PNG bytes. Seek to 0 and copy out.
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 8192];
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| format!("IStream::Seek: {e}"))?;
    }
    loop {
        let mut read: u32 = 0;
        let hr = unsafe {
            stream.Read(
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                Some(&mut read as *mut u32),
            )
        };
        if hr.is_err() {
            return Err(format!("IStream::Read failed: 0x{:08x}", hr.0));
        }
        if read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..read as usize]);
        if (read as usize) < chunk.len() {
            // Partial read = EOF for memory-backed streams. Saves one extra
            // syscall on a guaranteed-empty next iteration.
            break;
        }
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create cache dir {}: {e}", parent.display()))?;
    }
    std::fs::write(dest, &buf).map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(buf.len() as u64)
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn capture_to_file(
    _webview: tauri::webview::PlatformWebview,
    _dest: &std::path::Path,
) -> Result<u64, String> {
    Err("raster capture: only wired on Windows so far (Phase 5 spike)".into())
}
