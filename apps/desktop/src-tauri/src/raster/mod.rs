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

/// JS shim that pins time, replaces rAF, and exposes `window.__seek(t)`.
/// Injected before the page script runs so templates see the mocked clock
/// from the very first frame.
const TIME_MOCK_SHIM: &str = include_str!("time_mock.js");

/// Test page used by the spike. A rAF-driven Canvas animation that draws the
/// current `performance.now()` and a dot whose x-position is a linear
/// function of that time. With the shim active, captures at t=0 / t=1 / t=2
/// produce visibly different frames at known positions.
const SPIKE_HTML: &str = r##"data:text/html,<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:%231f2937;color:%2360a5fa;font:14px ui-sans-serif,system-ui}</style></head>
<body>
<canvas id="c" width="800" height="200"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  function tick() {
    const t = performance.now() / 1000;
    ctx.fillStyle = '%231f2937';
    ctx.fillRect(0, 0, 800, 200);
    ctx.fillStyle = '%2360a5fa';
    ctx.font = '32px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('t = ' + t.toFixed(2) + ' s', 24, 60);
    ctx.beginPath();
    ctx.arc(60 + t * 100, 120, 16, 0, 2 * Math.PI);
    ctx.fillStyle = '%23f472b6';
    ctx.fill();
    requestAnimationFrame(tick);
  }
  tick();
</script>
</body></html>"##;

/// Builds the offscreen raster worker webview with the time-mock shim
/// injected. The webview stays hidden for the lifetime of the app — the
/// rest of Phase 5 (worker pool, cache, IR PngSeq) drives it via JS calls
/// + capture.
pub fn spawn_spike(app: &AppHandle) -> Result<()> {
    if app.get_webview_window("raster-worker").is_some() {
        return Ok(()); // already spawned (e.g., dev hot-reload)
    }

    let url: tauri::Url = SPIKE_HTML.parse().context("parse spike data URL")?;
    let _window = WebviewWindowBuilder::new(app, "raster-worker", WebviewUrl::External(url))
        .initialization_script(TIME_MOCK_SHIM)
        .visible(false)
        .inner_size(800.0, 200.0)
        .resizable(false)
        .skip_taskbar(true)
        .build()
        .context("build offscreen raster worker window")?;

    info!("raster spike: hidden webview spawned, time-mock shim injected");
    Ok(())
}

/// Drive the offscreen webview through `__seek(0)`, `__seek(1)`, `__seek(2)`
/// and capture a PNG after each step. Writes three files under `dest_dir`:
/// `raster-spike-t0.png`, `raster-spike-t1.png`, `raster-spike-t2.png`. Logs
/// each result so the spike's signal lives in the dev log (and the user can
/// open the files to confirm the captures actually differ — the dot moves,
/// the timestamp text advances).
///
/// Time-mock validation: if the captures all show the same image, the shim
/// isn't taking effect (initialization-script not running before the page
/// script, or rAF override bypassed). If they differ in the expected linear
/// way, the deterministic time step works end-to-end.
pub fn schedule_capture_spike(app: &AppHandle, dest_dir: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Initial page load + first rAF tick + font load. 1500 ms is
        // conservative; the spike page is trivial.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let window = match app.get_webview_window("raster-worker") {
            Some(w) => w,
            None => {
                warn!("raster capture spike: raster-worker window missing");
                return;
            }
        };

        for t in [0.0f64, 1.0, 2.0] {
            // Step the mocked clock. `eval` is fire-and-forget; we sleep
            // briefly to let __seek's awaits (font ready + one real frame)
            // resolve before capturing. Stage B (worker pool) will swap
            // this for an ExecuteScript-with-completion-handler so we
            // don't have to guess.
            let script = format!("window.__seek({t});");
            if let Err(e) = window.eval(&script) {
                warn!("raster capture spike: eval __seek({t}) failed: {e:?}");
                continue;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;

            let dest = dest_dir.join(format!("raster-spike-t{}.png", t as i32));
            let dest_for_capture = dest.clone();
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<u64, String>>();
            let with_webview = window.with_webview(move |webview| {
                let outcome = capture_to_file(webview, &dest_for_capture);
                let _ = tx.send(outcome);
            });
            if let Err(e) = with_webview {
                warn!("raster capture spike: with_webview failed at t={t}: {e:?}");
                continue;
            }
            match rx.await {
                Ok(Ok(bytes)) => info!(
                    "raster capture spike: t={t} → wrote {bytes} bytes to {}",
                    dest.display()
                ),
                Ok(Err(msg)) => warn!("raster capture spike: t={t} capture failed: {msg}"),
                Err(e) => warn!("raster capture spike: t={t} oneshot closed: {e}"),
            }
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
