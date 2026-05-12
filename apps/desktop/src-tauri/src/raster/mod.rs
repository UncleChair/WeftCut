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

use std::path::{Path, PathBuf};

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

/// Rasterizer version baked into every cache key. Bump when the capture
/// pipeline changes in a way that should invalidate every prior render
/// (e.g. shim semantics change, PNG format swap, frame timing fix).
const RASTERIZER_VERSION: u32 = 1;

/// A render job. Cache-key inputs go into `blake3` (see [`cache_key`]); if
/// the key already exists on disk we skip the webview entirely and reuse
/// the cached PNG sequence. Stage D fills in `template_id` / `props_json`
/// from a real template manifest; the spike uses a sentinel id + the
/// hard-coded HTML body's hash.
pub struct RasterJob {
    pub template_id: String,
    /// blake3 of all template files concatenated, or any other stable
    /// content fingerprint. Bumping this invalidates stale renders when a
    /// template's HTML/CSS changes during authoring.
    pub template_content_hash: String,
    /// Canonical JSON-encoded props the template was rendered with.
    pub props_json: String,
    pub fps: u32,
    pub size: (u32, u32),
    /// Explicit list of times to capture (seconds). For real templates Stage
    /// D will derive this from `duration_us` + `fps`; the spike passes it
    /// directly so we can sample non-uniformly during development.
    pub times_s: Vec<f64>,
}

pub struct RasterFrame {
    pub idx: usize,
    pub t: f64,
    pub path: PathBuf,
}

pub struct RasterOutput {
    pub dir: PathBuf,
    pub frames: Vec<RasterFrame>,
    pub cached: bool,
}

/// Stable hex hash over every cache-relevant input. Order + format matter —
/// any change here is a cache invalidation. Inputs are joined with `\0` so
/// e.g. template_id="ab" + content_hash="cd" can't collide with template_id
/// ="a" + content_hash="bcd".
pub fn cache_key(job: &RasterJob) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&RASTERIZER_VERSION.to_le_bytes());
    let parts: &[&[u8]] = &[
        job.template_id.as_bytes(),
        job.template_content_hash.as_bytes(),
        job.props_json.as_bytes(),
    ];
    for p in parts {
        hasher.update(p);
        hasher.update(&[0]);
    }
    hasher.update(&job.fps.to_le_bytes());
    hasher.update(&job.size.0.to_le_bytes());
    hasher.update(&job.size.1.to_le_bytes());
    for t in &job.times_s {
        hasher.update(&t.to_le_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RasterManifest {
    rasterizer_version: u32,
    template_id: String,
    template_content_hash: String,
    props_json: String,
    fps: u32,
    width: u32,
    height: u32,
    times_s: Vec<f64>,
    frame_count: usize,
}

/// Render every requested time and write the sequence into the
/// content-addressed cache. Cache hit short-circuits the webview entirely.
pub async fn render(
    app: &AppHandle,
    cache: &crate::cache::CacheLayout,
    job: RasterJob,
) -> Result<RasterOutput, String> {
    let key = cache_key(&job);
    let dest_dir = cache.raster_dir(&key);
    let manifest_path = dest_dir.join("manifest.json");

    // Cache hit: every frame plus the manifest is present + non-empty.
    if let Some(frames) = load_cached_frames(&dest_dir, &manifest_path, job.times_s.len()) {
        return Ok(RasterOutput { dir: dest_dir, frames, cached: true });
    }

    let window = app
        .get_webview_window("raster-worker")
        .ok_or_else(|| "raster-worker window not spawned".to_string())?;

    // Write into a `.tmp` sibling and promote on success so an interrupted
    // render doesn't leave a half-populated cache dir.
    let tmp_dir = crate::cache::temp_path(&dest_dir);
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("create raster tmp dir {}: {e}", tmp_dir.display()))?;

    let mut frames = Vec::with_capacity(job.times_s.len());
    for (idx, &t) in job.times_s.iter().enumerate() {
        wait_seek(&window, t).await?;
        let path = tmp_dir.join(format!("frame_{idx:05}.png"));
        let _ = capture_via_webview(&window, &path).await?;
        frames.push(RasterFrame { idx, t, path });
    }

    let manifest = RasterManifest {
        rasterizer_version: RASTERIZER_VERSION,
        template_id: job.template_id.clone(),
        template_content_hash: job.template_content_hash.clone(),
        props_json: job.props_json.clone(),
        fps: job.fps,
        width: job.size.0,
        height: job.size.1,
        times_s: job.times_s.clone(),
        frame_count: frames.len(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("manifest serialize: {e}"))?;
    std::fs::write(tmp_dir.join("manifest.json"), manifest_bytes)
        .map_err(|e| format!("write manifest: {e}"))?;

    // Atomic promote: rename(tmp_dir, dest_dir). Anything reading the cache
    // through `load_cached_frames` either sees a complete sequence or no
    // entry at all.
    if dest_dir.exists() {
        let _ = std::fs::remove_dir_all(&dest_dir);
    }
    std::fs::rename(&tmp_dir, &dest_dir)
        .map_err(|e| format!("promote raster cache dir {}: {e}", dest_dir.display()))?;

    // Rewrite the frame paths into the promoted location.
    let frames = frames
        .into_iter()
        .map(|f| RasterFrame {
            idx: f.idx,
            t: f.t,
            path: dest_dir.join(f.path.file_name().expect("frame name")),
        })
        .collect();

    Ok(RasterOutput { dir: dest_dir, frames, cached: false })
}

fn load_cached_frames(
    dest_dir: &Path,
    manifest_path: &Path,
    expected_count: usize,
) -> Option<Vec<RasterFrame>> {
    if !manifest_path.exists() {
        return None;
    }
    let bytes = std::fs::read(manifest_path).ok()?;
    let manifest: RasterManifest = serde_json::from_slice(&bytes).ok()?;
    if manifest.frame_count != expected_count {
        return None;
    }
    let mut frames = Vec::with_capacity(expected_count);
    for (idx, &t) in manifest.times_s.iter().enumerate() {
        let path = dest_dir.join(format!("frame_{idx:05}.png"));
        if !crate::cache::cached_ok(&path) {
            return None;
        }
        frames.push(RasterFrame { idx, t, path });
    }
    Some(frames)
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
/// and exercise the full cache path. First call renders + writes the cache
/// entry; second call (forced 100ms later) should report `cached=true` and
/// return in microseconds. The log line `cached=true` is the Stage C signal.
pub fn schedule_capture_spike(app: &AppHandle, cache: crate::cache::CacheLayout) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Initial page load + first rAF tick + font load. 1500 ms is
        // conservative; the spike page is trivial.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let build_job = || RasterJob {
            template_id: "raster-spike".into(),
            template_content_hash: blake3::hash(SPIKE_HTML.as_bytes()).to_hex().to_string(),
            props_json: "{}".into(),
            fps: 1,
            size: (800, 200),
            times_s: vec![0.0, 1.0, 2.0],
        };

        for pass in ["cold", "warm"] {
            let t0 = std::time::Instant::now();
            match render(&app, &cache, build_job()).await {
                Ok(out) => info!(
                    "raster capture spike ({pass}): cached={} dir={} frames={} elapsed={:?}",
                    out.cached,
                    out.dir.display(),
                    out.frames.len(),
                    t0.elapsed()
                ),
                Err(e) => warn!("raster capture spike ({pass}): render failed: {e}"),
            }
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
