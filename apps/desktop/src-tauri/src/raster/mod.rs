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

/// A render job: snapshot the offscreen webview at each `times_s` value,
/// writing `<dest_dir>/<file_prefix><k>.png` per frame. Stage B keeps this
/// minimal — Stage D adds template_id / props / cache key.
pub struct RasterJob {
    pub times_s: Vec<f64>,
    pub dest_dir: PathBuf,
    pub file_prefix: String,
}

pub struct RasterFrame {
    pub t: f64,
    pub path: PathBuf,
    pub bytes: u64,
}

/// Render every requested time into `dest_dir`. Steps the mocked clock via
/// `__seek_dispatch(t)`, polls `__seek_status().done >= seq` (sub-frame
/// latency typical), then captures the post-flush pixels. Errors propagate
/// per frame — we'd rather complete what we can than abort on one bad seek.
pub async fn render(app: &AppHandle, job: RasterJob) -> Result<Vec<RasterFrame>, String> {
    let window = app
        .get_webview_window("raster-worker")
        .ok_or_else(|| "raster-worker window not spawned".to_string())?;
    std::fs::create_dir_all(&job.dest_dir)
        .map_err(|e| format!("create dest_dir {}: {e}", job.dest_dir.display()))?;

    let mut frames = Vec::with_capacity(job.times_s.len());
    for (idx, &t) in job.times_s.iter().enumerate() {
        wait_seek(&window, t).await?;
        let dest = job
            .dest_dir
            .join(format!("{}{:05}.png", job.file_prefix, idx));
        let bytes = capture_via_webview(&window, &dest).await?;
        frames.push(RasterFrame { t, path: dest, bytes });
    }
    Ok(frames)
}

/// Dispatch `__seek(t)` and poll `__seek_status` until the async awaits
/// inside the shim (rAF flush + fonts.ready + one real compositor frame)
/// complete. Returns when `done >= seq` or after `MAX_WAIT_MS`.
async fn wait_seek(window: &tauri::WebviewWindow, t: f64) -> Result<(), String> {
    const POLL_MS: u64 = 10;
    const MAX_WAIT_MS: u128 = 2_000;
    let raw_seq = eval_async(window, format!("window.__seek_dispatch({t})")).await?;
    let seq: i64 = raw_seq
        .trim()
        .parse()
        .map_err(|e| format!("parse seq {raw_seq:?}: {e}"))?;
    let start = std::time::Instant::now();
    loop {
        let status = eval_async(window, "JSON.stringify(window.__seek_status())".into()).await?;
        // The shim returns JSON like `{"done":1,"latest":1}`. ExecuteScript
        // wraps it again — we ask for the stringified form to skip a level
        // of un-quoting on the Rust side. Parse the inner JSON.
        let stripped = strip_outer_json_quotes(&status);
        if let Some(done) = parse_done_field(&stripped) {
            if done >= seq {
                return Ok(());
            }
        }
        if start.elapsed().as_millis() > MAX_WAIT_MS {
            return Err(format!("__seek({t}) timeout after {MAX_WAIT_MS}ms"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
    }
}

fn strip_outer_json_quotes(s: &str) -> String {
    // ExecuteScript serializes a String JS return value as a JSON string —
    // `"{\"done\":1,\"latest\":1}"`. Strip the outer quotes and unescape
    // inner ones. JSON.parse would be cleaner but pulling serde_json into
    // hot polling is overkill for this tiny shape.
    let trimmed = s.trim();
    if trimmed.len() < 2 || !trimmed.starts_with('"') || !trimmed.ends_with('"') {
        return trimmed.to_string();
    }
    trimmed[1..trimmed.len() - 1].replace("\\\"", "\"")
}

fn parse_done_field(inner: &str) -> Option<i64> {
    let needle = "\"done\":";
    let start = inner.find(needle)? + needle.len();
    let tail = &inner[start..];
    let end = tail.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(tail.len());
    tail[..end].parse().ok()
}

async fn capture_via_webview(
    window: &tauri::WebviewWindow,
    dest: &std::path::Path,
) -> Result<u64, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<u64, String>>();
    let dest_owned = dest.to_path_buf();
    let with_webview = window.with_webview(move |webview| {
        let _ = tx.send(capture_to_file(webview, &dest_owned));
    });
    if let Err(e) = with_webview {
        return Err(format!("with_webview: {e}"));
    }
    rx.await.map_err(|e| format!("oneshot recv: {e}"))?
}

/// Drive the offscreen webview through `__seek(0)`, `__seek(1)`, `__seek(2)`
/// and capture a PNG after each step. Used as the end-to-end smoke for
/// Stages A + B — the captures should show the dot at three different
/// linear positions and the timestamp text matching the seeked value.
pub fn schedule_capture_spike(app: &AppHandle, dest_dir: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Initial page load + first rAF tick + font load. 1500 ms is
        // conservative; the spike page is trivial.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let job = RasterJob {
            times_s: vec![0.0, 1.0, 2.0],
            dest_dir,
            file_prefix: "raster-spike-t".into(),
        };
        match render(&app, job).await {
            Ok(frames) => {
                for f in frames {
                    info!(
                        "raster capture spike: t={} → wrote {} bytes to {}",
                        f.t,
                        f.bytes,
                        f.path.display()
                    );
                }
            }
            Err(e) => warn!("raster capture spike: render failed: {e}"),
        }
    });
}

/// Run `script` inside the offscreen webview and wait for it to resolve
/// (top-level promises included — the WebView2 ExecuteScript completion
/// handler doesn't fire until the script returns). Returns the script's
/// JSON-encoded return value as a `String`.
///
/// Replaces the `tokio::sleep` hack from the Stage A spike: now the host
/// knows EXACTLY when `await window.__seek(t)` has finished and the next
/// capture will see the post-seek frame.
pub async fn eval_async(
    window: &tauri::WebviewWindow,
    script: String,
) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let with_webview = window.with_webview(move |webview| {
        let _ = tx.send(eval_async_blocking(webview, &script));
    });
    if let Err(e) = with_webview {
        return Err(format!("with_webview: {e}"));
    }
    rx.await.map_err(|e| format!("oneshot recv: {e}"))?
}

#[cfg(windows)]
fn eval_async_blocking(
    webview: tauri::webview::PlatformWebview,
    script: &str,
) -> Result<String, String> {
    use std::sync::{Arc, Mutex};

    use webview2_com::ExecuteScriptCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    use windows::core::PCWSTR;

    let controller = webview.controller();
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("get CoreWebView2: {e}"))?;

    // Wide-encode the script for the COM call. The buffer must outlive the
    // ExecuteScript invocation; WebView2 marshals the string synchronously
    // so it's safe to drop once `core.ExecuteScript` returns.
    let script_wide: Vec<u16> = script.encode_utf16().chain(std::iter::once(0)).collect();
    let result_slot: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let result_for_cb = result_slot.clone();

    ExecuteScriptCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| -> webview2_com::Result<()> {
            unsafe {
                core.ExecuteScript(PCWSTR::from_raw(script_wide.as_ptr()), &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }
        }),
        Box::new(move |hr, json_value| -> windows::core::Result<()> {
            hr?;
            *result_for_cb.lock().expect("eval_async result mutex poisoned") = json_value;
            Ok(())
        }),
    )
    .map_err(|e| format!("ExecuteScript async op: {e}"))?;

    let s = result_slot
        .lock()
        .expect("eval_async result mutex poisoned")
        .clone();
    Ok(s)
}

#[cfg(not(windows))]
fn eval_async_blocking(
    _webview: tauri::webview::PlatformWebview,
    _script: &str,
) -> Result<String, String> {
    Err("raster eval_async: only wired on Windows so far".into())
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
