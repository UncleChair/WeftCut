//! Headless-Chromium export rasterizer (Phase X.1 spike).
//!
//! The existing WebView2-backed rasterizer (`raster/mod.rs`) pays ~30–100 ms
//! per frame in `CapturePreview` + PNG-encode at 1080p. HyperFrames' engine
//! (https://github.com/heygen-com/hyperframes/tree/main/packages/engine)
//! gets ~10× wall-clock improvements by driving headless Chromium via
//! `HeadlessExperimental.beginFrame` — one atomic CDP call performs
//! layout + paint + composite + screenshot and returns a `hasDamage`
//! flag, so unchanged frames can be skipped entirely. This module is the
//! Rust side of porting that technique.
//!
//! **Bundled chrome-headless-shell — sole supported binary.** Chrome 132+
//! removed legacy headless from `chrome.exe`, and `--headless=new`
//! doesn't expose `HeadlessExperimental.beginFrame` at all. The only
//! way to keep the atomic paint+capture + `hasDamage` skip on modern
//! installs is the standalone `chrome-headless-shell` binary that
//! Google still ships under Chrome for Testing for exactly this use
//! case. We bundle it under `vendor/chrome-headless-shell/` and don't
//! fall back to a detected user-installed Chrome — different binary
//! (no BeginFrame), different launch flags, different rasterizer
//! version key. If the bundled binary isn't present at runtime
//! (installer bug, user moved files, dev environment without the
//! download script run yet), we surface a dialog and fall back to the
//! WebView2 rasterizer in `raster/mod.rs`.
//!
//! **Why alpha-PNG output, not JPEG**: the html-render-group artifact is
//! VP9 + `yuva420p`, which needs real alpha. JPEG has no alpha channel
//! and PNG with `optimizeForSpeed: true` uses a zero-aware codec that
//! crushes mid-alpha values — HyperFrames hit this and disable it for
//! alpha-needed captures. We do the same.

#![cfg(windows)]
#![allow(dead_code)] // Phase X.1 spike — consumers land in Phase X.2.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// Path to the bundled `chrome-headless-shell.exe`. Only one binary
/// matters; if it's missing we fall back to WebView2, not to a detected
/// user-installed Chrome (different binary, no BeginFrame, different
/// rasterizer version key).
#[derive(Clone, Debug)]
pub struct ChromiumBinary {
    pub exe: PathBuf,
}

/// Locate the bundled `chrome-headless-shell.exe`. Returns `None` when
/// the binary isn't where we expect — that's an installer or dev-setup
/// problem (run `vendor/chrome-headless-shell/download.ps1` for the
/// latter). Caller surfaces the install-hint dialog and falls back to
/// the WebView2 rasterizer (`raster/mod.rs`).
///
/// Search order:
///   1. `CHROMIUM_EXPORT_EXE` env var — escape hatch for testing a custom
///      build outside the bundled path.
///   2. `extra_search_roots` — Tauri's `app.path().resource_dir()` for
///      installed builds, where `bundle.resources` copies the vendor
///      directory next to the exe. Pass `&[]` from non-Tauri contexts
///      (the smoke test, unit tests).
///   3. The vendor dir next to the running exe (production install) or
///      walking up to the workspace root (dev / cargo-test runs).
pub fn find_chromium(extra_search_roots: &[PathBuf]) -> Option<ChromiumBinary> {
    if let Ok(custom) = std::env::var("CHROMIUM_EXPORT_EXE") {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(ChromiumBinary { exe: p });
        }
    }
    for root in extra_search_roots {
        let candidate = root
            .join("vendor")
            .join("chrome-headless-shell")
            .join("chrome-headless-shell.exe");
        if candidate.is_file() {
            return Some(ChromiumBinary { exe: candidate });
        }
    }
    for path in headless_shell_candidate_paths() {
        if path.is_file() {
            return Some(ChromiumBinary { exe: path });
        }
    }
    None
}

/// Candidate paths for the bundled `chrome-headless-shell.exe`. v1 looks
/// in two places: (a) `vendor/chrome-headless-shell/` next to the running
/// exe, for dev builds where `target/debug/weftcut.exe` runs from the
/// repo, and (b) the Tauri-bundled resources dir at runtime (wired by
/// `tauri.conf.json -> bundle.resources` in Phase X.5).
fn headless_shell_candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    // Walk up from the running exe (or cwd in tests) and look at
    // `vendor/chrome-headless-shell/chrome-headless-shell.exe` at each
    // ancestor. Covers the dev `target/debug/...` layout AND the
    // production install dir where the vendor folder is a sibling of
    // the app exe (via tauri.conf.json resources, Phase X.5).
    if let Ok(exe) = std::env::current_exe() {
        let mut ancestor = exe.parent();
        while let Some(dir) = ancestor {
            let candidate = dir
                .join("vendor")
                .join("chrome-headless-shell")
                .join("chrome-headless-shell.exe");
            if candidate.is_file() {
                out.push(candidate);
            }
            ancestor = dir.parent();
        }
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let candidate = Path::new(&manifest)
            .join("vendor")
            .join("chrome-headless-shell")
            .join("chrome-headless-shell.exe");
        out.push(candidate);
    }
    out
}

// ============================================================================
// Phase X.1 smoke: spawn Chrome, capture one frame via BeginFrame.
// Wired behind a public fn so a Tauri command (or a test) can invoke it
// without going through the full export pipeline.
// ============================================================================

use chromiumoxide::{
    cdp::browser_protocol::target::CreateTargetParams,
    Browser, BrowserConfig,
};
use futures::StreamExt;

/// Outcome of a single BeginFrame capture. `hasDamage` is `true` when the
/// renderer produced any output for this frame; `false` lets the caller
/// reuse the previous frame's bytes (Phase X.3).
#[derive(Debug)]
pub struct BeginFrameCapture {
    pub png_bytes: Vec<u8>,
    pub has_damage: bool,
    pub width: u32,
    pub height: u32,
}

/// Spike: spawn headless Chrome at `binary.exe`, navigate to `html` as a
/// data URL, wait for `load`, then capture one frame at `t_seconds` via
/// `HeadlessExperimental.beginFrame`. Returns the PNG bytes.
///
/// Width/height are the viewport size; the captured PNG matches these
/// dimensions (no DPR scaling for v1 — every wider/scaled capture path
/// can ride on top of this once it works).
///
/// This function is **synchronous from the caller's perspective in async
/// land** — it `.await`s through chromiumoxide's tokio bindings. Callers
/// must be inside a tokio runtime; the rasterizer pipeline already is.
pub async fn smoke_capture_one_frame(
    binary: &ChromiumBinary,
    html: &str,
    width: u32,
    height: u32,
    t_seconds: f64,
) -> Result<BeginFrameCapture> {
    // chrome-headless-shell IS the legacy-headless binary, so no
    // `--headless=...` flag is needed — it's headless by definition. The
    // BeginFrame control surface is unlocked by
    // `--enable-begin-frame-control`; without it, BeginFrame returns
    // "Another frame is pending" because the compositor is pacing itself
    // off the wall clock. `--run-all-compositor-stages-before-draw`
    // guarantees the screenshot the BeginFrame returns is fully composited
    // (no "blank for one frame after navigation" race beyond the warmup
    // we already do below).
    let config = BrowserConfig::builder()
        .chrome_executable(&binary.exe)
        .arg("--enable-begin-frame-control")
        .arg("--run-all-compositor-stages-before-draw")
        .arg("--disable-gpu") // GPU compositor in headless is flaky on Windows
        .arg("--hide-scrollbars")
        // See rasterize_chunk's comment — pin DPR to 1 so the captured
        // PNG's device pixels line up 1:1 with the composition's CSS
        // pixels regardless of host system DPI scaling.
        .arg("--force-device-scale-factor=1")
        .arg(format!("--window-size={},{}", width, height))
        .build()
        .map_err(|e| anyhow!("chromiumoxide BrowserConfig: {e}"))?;

    let (mut browser, mut handler) = Browser::launch(config)
        .await
        .context("launch headless Chrome")?;

    // The handler future drives every CDP message in/out. Spawn it so it
    // runs concurrently with our control flow; abort on drop.
    let handler_task = tokio::spawn(async move {
        while let Some(_event) = handler.next().await {
            // Discard event stream — we drive synchronously via CDP request/reply.
        }
    });

    let capture_result = (async {
        // Open the URL in a fresh tab. data: URLs are fine for the smoke.
        let data_url = format!(
            "data:text/html;charset=utf-8,{}",
            urlencoding_encode(html)
        );
        let page = browser
            .new_page(CreateTargetParams::new(data_url))
            .await
            .context("open new page")?;

        // Wait until the document is loaded — required so fonts and any
        // <img>/<video> resources have started decoding before we BeginFrame.
        page.wait_for_navigation()
            .await
            .context("wait_for_navigation")?;

        // BeginFrame: one atomic call → paint + screenshot. Two-call dance
        // because the first BeginFrame after navigation typically commits
        // a frame WITHOUT producing damage (the renderer is still wiring
        // up its compositor); we burn it as a no-screenshot warmup, then
        // the second call carries the screenshot. The screenshot params
        // shape is a subset of Page.captureScreenshot's — only `format`
        // (and `quality` for jpeg) are valid. `optimizeForSpeed` is NOT
        // — that's Page.captureScreenshot-only and BeginFrame silently
        // drops the screenshot when an unknown field appears.
        //
        // frameTimeTicks is the simulated clock in ms; we set it from
        // `t_seconds` so synthetic-clock pages (our composition engine's
        // __setTime / __seek shim) tick deterministically.
        let frame_time_ticks = (t_seconds * 1000.0).max(1.0) as i64;
        let warmup = serde_json::json!({
            "frameTimeTicks": frame_time_ticks,
            "interval": 16,
            "noDisplayUpdates": false,
        });
        let _ = page
            .execute(GenericCommand {
                method: std::borrow::Cow::Borrowed("HeadlessExperimental.beginFrame"),
                params: warmup,
            })
            .await
            .context("HeadlessExperimental.beginFrame (warmup)")?;

        let cmd = serde_json::json!({
            "frameTimeTicks": frame_time_ticks + 16,
            "interval": 16,
            "screenshot": { "format": "png" }
        });
        let response = page
            .execute(GenericCommand {
                method: std::borrow::Cow::Borrowed("HeadlessExperimental.beginFrame"),
                params: cmd,
            })
            .await
            .context("HeadlessExperimental.beginFrame")?;
        let result: &serde_json::Value = &response.result;

        let has_damage = result
            .get("hasDamage")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let screenshot_b64 = result
            .get("screenshotData")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("BeginFrame returned no screenshotData (hasDamage={has_damage})"))?;
        let png_bytes = base64_decode(screenshot_b64)
            .context("decode BeginFrame screenshotData base64")?;

        anyhow::Ok(BeginFrameCapture {
            png_bytes,
            has_damage,
            width,
            height,
        })
    })
    .await;

    // Always try to close cleanly so the Chrome process exits even on error.
    let _ = browser.close().await;
    let _ = handler_task.await;

    capture_result
}

/// Minimal URL-encoder for the data-URL body. We only need to escape the
/// characters that are illegal inside a `data:` URL — pulling in the
/// `urlencoding` crate for this would be overkill. Caller passes HTML
/// directly; we percent-encode anything outside the unreserved set.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{:02X}", byte));
                }
            }
        }
    }
    out
}

/// Base64 decode using the already-present `base64` crate (Cargo manifest
/// pins it for the MCP blob path). Standard alphabet, no padding required.
fn base64_decode(s: &str) -> Result<Vec<u8>> {
    use base64::{engine::general_purpose, Engine as _};
    general_purpose::STANDARD
        .decode(s)
        .map_err(|e| anyhow!("base64 decode: {e}"))
}

/// Tiny shim wrapping a string method name + JSON params so we can call
/// arbitrary CDP methods that chromiumoxide doesn't have typed bindings for
/// (notably `HeadlessExperimental.beginFrame`, which is marked experimental
/// and excluded from the generated types).
///
/// Implements the `Method` + `Command` traits chromiumoxide expects;
/// `Response` is left as `serde_json::Value` so we don't have to declare a
/// per-call response struct.
#[derive(Debug, serde::Serialize)]
struct GenericCommand {
    #[serde(skip)]
    method: std::borrow::Cow<'static, str>,
    #[serde(flatten)]
    params: serde_json::Value,
}

impl chromiumoxide::Method for GenericCommand {
    fn identifier(&self) -> chromiumoxide::types::MethodId {
        self.method.clone()
    }
}

impl chromiumoxide::Command for GenericCommand {
    type Response = serde_json::Value;
}

// ============================================================================
// Phase X.2 / X.3 / X.4: rasterize an entire composition to a PNG sequence.
//
// X.2 spawned ONE chrome-headless-shell instance for the whole job.
// X.4 splits the frame range across N instances running concurrently, each
// owning a contiguous chunk. Cross-worker reuse of decoded `<img>` bitmaps
// isn't possible (separate processes), but everything inside a chunk is
// kept warm — image decode caches, the engine's per-frame state, even
// font shaping. X.3 layers a `hasDamage` skip inside each worker so an
// unchanged-from-prior-frame state reuses the prior PNG bytes instead of
// re-decoding + re-writing them.
// ============================================================================

/// Default worker count. 4 is the sweet spot in the HyperFrames parallel-
/// coordinator notes — enough to mask paint cost, low enough to fit
/// ~800 MB headroom on a 4-instance peak (each chrome-headless-shell
/// process is ~200 MB resident). Override via `WEFTCUT_CHROME_WORKERS`.
const DEFAULT_WORKERS: usize = 4;

/// Rasterize a composition to a PNG sequence on disk.
///
/// Splits `times_s` across N chrome-headless-shell instances running in
/// parallel; each writes its frames directly into `out_dir` using the
/// global index so the final layout is `frame_00000.png`, `frame_00001.png`,
/// … contiguous and zero-padded regardless of which worker produced each.
///
/// - `composition_html_path` — the on-disk composition (must exist).
/// - `times_s` — per-frame timestamps in composition-local seconds.
/// - `width`/`height` — viewport size; must match composition canvas.
/// - `out_dir` — receives one PNG per `times_s` entry; pre-created by caller.
/// - `on_progress(done, total)` — fires once per completed frame from the
///   coordinator task (serially, no synchronization required by caller).
///
/// Worker count: `WEFTCUT_CHROME_WORKERS` env var, clamped to
/// `[1, times_s.len()]`. Falls back to `DEFAULT_WORKERS`.
pub async fn rasterize_to_dir<F>(
    binary: &ChromiumBinary,
    composition_html_path: &Path,
    times_s: &[f64],
    width: u32,
    height: u32,
    out_dir: &Path,
    mut on_progress: F,
) -> Result<()>
where
    F: FnMut(usize, usize) + Send,
{
    if times_s.is_empty() {
        return Ok(());
    }
    let requested = std::env::var("WEFTCUT_CHROME_WORKERS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_WORKERS);
    let workers = requested.clamp(1, times_s.len());
    tracing::info!(
        target: "raster_chrome",
        workers,
        frames = times_s.len(),
        "Phase X.4: spawning {workers} chrome-headless-shell workers for {} frames",
        times_s.len(),
    );

    let chunks = split_chunks(times_s, workers);

    // Progress channel: each worker sends `()` per completed frame; this
    // coordinator drains, increments `done`, and fires `on_progress`.
    // Sequential delivery into a single FnMut — no shared-state hazards
    // for the caller.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let total = times_s.len();

    let binary = binary.clone();
    let composition_html_path = composition_html_path.to_path_buf();
    let out_dir = out_dir.to_path_buf();

    let mut handles = Vec::with_capacity(workers);
    for chunk in chunks {
        let binary = binary.clone();
        let html_path = composition_html_path.clone();
        let out_dir = out_dir.clone();
        let tx = tx.clone();
        handles.push(tokio::spawn(async move {
            rasterize_chunk(
                &binary,
                &html_path,
                &chunk.times,
                chunk.offset,
                width,
                height,
                &out_dir,
                tx,
            )
            .await
        }));
    }
    // Drop our copy so `rx.recv()` returns None once every worker's tx is
    // dropped — i.e., once all workers exit.
    drop(tx);

    let mut done = 0usize;
    while rx.recv().await.is_some() {
        done += 1;
        on_progress(done, total);
    }

    // All workers have closed their tx; join them and surface the first
    // error if any. Workers run independently — a slow one doesn't block
    // a fast one's completion, but a failure on any aborts the export.
    let mut first_err: Option<anyhow::Error> = None;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(anyhow::anyhow!("chrome worker join: {e}"));
                }
            }
        }
    }
    if let Some(e) = first_err {
        return Err(e);
    }
    Ok(())
}

/// One contiguous chunk of frames assigned to a single chrome instance.
/// `offset` is the global index of the first frame so the worker can
/// write filenames at the right slot.
struct Chunk {
    offset: usize,
    times: Vec<f64>,
}

/// Split `times_s` into `workers` chunks of approximately equal size.
/// Earlier chunks are one frame larger when the length isn't evenly
/// divisible — standard rounding behavior so the last chunk isn't
/// disproportionately bigger.
fn split_chunks(times_s: &[f64], workers: usize) -> Vec<Chunk> {
    let n = times_s.len();
    let base = n / workers;
    let extra = n % workers;
    let mut out = Vec::with_capacity(workers);
    let mut offset = 0;
    for i in 0..workers {
        let len = base + if i < extra { 1 } else { 0 };
        if len == 0 {
            break;
        }
        out.push(Chunk {
            offset,
            times: times_s[offset..offset + len].to_vec(),
        });
        offset += len;
    }
    out
}

/// Single-worker rasterize: spawn one chrome instance, navigate, capture
/// every frame in `times_s`, write to `out_dir/frame_{offset+idx:05}.png`,
/// and signal progress via `progress_tx`. Sends one `()` per written
/// frame.
async fn rasterize_chunk(
    binary: &ChromiumBinary,
    composition_html_path: &Path,
    times_s: &[f64],
    offset: usize,
    width: u32,
    height: u32,
    out_dir: &Path,
    progress_tx: tokio::sync::mpsc::UnboundedSender<()>,
) -> Result<()> {
    let config = BrowserConfig::builder()
        .chrome_executable(&binary.exe)
        .arg("--enable-begin-frame-control")
        .arg("--run-all-compositor-stages-before-draw")
        .arg("--disable-gpu")
        .arg("--hide-scrollbars")
        .arg("--allow-file-access-from-files") // composition.html loads sibling source/<lid>/frame_NNNNN.png as file://
        // Force CSS-pixel == device-pixel. Without this, chrome-headless-shell
        // inherits the host system's DPR (commonly 1.25 / 1.5 / 2.0 on
        // high-DPI Windows displays). A 1920×1080 window with DPR=1.5 gives
        // a 1280×720 CSS viewport, so a 1920×1080 composition overflows the
        // viewport and the captured PNG is a top-left crop of the layout —
        // user-visible as "zoomed in" content. Pinning DPR to 1.0 keeps the
        // composition's CSS pixels aligned with the captured device pixels
        // regardless of host scaling.
        .arg("--force-device-scale-factor=1")
        .arg(format!("--window-size={},{}", width, height))
        .build()
        .map_err(|e| anyhow!("chromiumoxide BrowserConfig: {e}"))?;

    let (mut browser, mut handler) = Browser::launch(config)
        .await
        .context("launch chrome-headless-shell")?;
    let handler_task = tokio::spawn(async move {
        while let Some(_event) = handler.next().await {}
    });

    let result = rasterize_chunk_inner(
        &mut browser,
        composition_html_path,
        times_s,
        offset,
        width,
        height,
        out_dir,
        progress_tx,
    )
    .await;

    // Best-effort cleanup so the chrome process exits even on error.
    let _ = browser.close().await;
    let _ = handler_task.await;
    result
}

async fn rasterize_chunk_inner(
    browser: &mut Browser,
    composition_html_path: &Path,
    times_s: &[f64],
    offset: usize,
    width: u32,
    height: u32,
    out_dir: &Path,
    progress_tx: tokio::sync::mpsc::UnboundedSender<()>,
) -> Result<()> {
    // Windows file path → file URL: backslashes to forward, ensure the
    // canonical `file:///C:/...` shape (three slashes).
    let path_str = composition_html_path
        .to_str()
        .ok_or_else(|| anyhow!("composition html path not UTF-8: {:?}", composition_html_path))?
        .replace('\\', "/");
    let file_url = if path_str.starts_with('/') {
        format!("file://{path_str}")
    } else {
        format!("file:///{path_str}")
    };

    // Open at about:blank FIRST so we can set the viewport via CDP
    // before any composition content loads. chrome-headless-shell
    // ignores `--window-size` for the CSS viewport (it defaults to
    // 800×600 regardless) and the only reliable way to set viewport
    // is `Emulation.setDeviceMetricsOverride`. Calling that AFTER
    // navigation triggers a reflow that breaks BeginFrame's screenshot
    // pipeline (commit f9e544a hit this); calling it BEFORE means the
    // composition loads into the correct viewport from the first byte.
    let page = browser
        .new_page(CreateTargetParams::new("about:blank"))
        .await
        .context("open blank composition page")?;
    page.execute(GenericCommand {
        method: std::borrow::Cow::Borrowed("Emulation.setDeviceMetricsOverride"),
        params: serde_json::json!({
            "width": width,
            "height": height,
            "deviceScaleFactor": 1,
            "mobile": false,
        }),
    })
    .await
    .context("Emulation.setDeviceMetricsOverride")?;

    // Force chrome's compositor backdrop to OPAQUE BLACK. The
    // un-covered composition area (e.g. a 1920×1032 source slot in a
    // 1920×1080 canvas → 48px of un-covered space at the bottom)
    // shows up in the captured PNG as black pixels, which matches the
    // ffmpeg gap path's `Color { rgba: project.composition.background }`
    // base (project bg defaults to `Rgba::BLACK`). Both render paths
    // produce the same canvas color so a non-canvas-aspect source
    // doesn't visibly disagree across the html-cap window vs. the
    // surrounding gap segments.
    //
    // We previously set alpha=0 here for transparent composition
    // mixing, but `Emulation.setDefaultBackgroundColorOverride` with
    // alpha=0 didn't take effect reliably across chrome-headless-shell
    // versions — chrome kept painting opaque white in the un-covered
    // region. Opaque-black is robust to that quirk. Future
    // composition-level transparency mixing (e.g. multiple html-cap
    // groups stacking with alpha blending) is a v2 concern; for now
    // single-group + black-background covers the shipped use case.
    page.execute(GenericCommand {
        method: std::borrow::Cow::Borrowed("Emulation.setDefaultBackgroundColorOverride"),
        params: serde_json::json!({
            "color": { "r": 0, "g": 0, "b": 0, "a": 255 },
        }),
    })
    .await
    .context("Emulation.setDefaultBackgroundColorOverride")?;

    // Now navigate into the correctly-sized viewport.
    page.execute(GenericCommand {
        method: std::borrow::Cow::Borrowed("Page.navigate"),
        params: serde_json::json!({ "url": file_url.clone() }),
    })
    .await
    .context("Page.navigate to composition.html")?;
    page.wait_for_navigation()
        .await
        .context("wait_for_navigation on composition.html")?;

    // Diagnostic: read what chrome actually sees for viewport + DPR so
    // we can pin down DPR-related export bugs without a debug rebuild.
    // Logged once per chunk, so a 4-worker export emits 4 lines.
    // Expected values when `--force-device-scale-factor=1` is honored:
    // dpr=1, vw=canvas_w, vh=canvas_h.
    if let Ok(resp) = page
        .execute(GenericCommand {
            method: std::borrow::Cow::Borrowed("Runtime.evaluate"),
            params: serde_json::json!({
                "expression": "JSON.stringify({ dpr: window.devicePixelRatio, vw: window.innerWidth, vh: window.innerHeight, doc: { sw: document.documentElement.clientWidth, sh: document.documentElement.clientHeight } })",
                "returnByValue": true,
            }),
        })
        .await
    {
        if let Some(s) = resp
            .result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
        {
            tracing::info!(
                target: "html_group",
                window = format!("{}x{}", width, height),
                diagnostics = %s,
                "chrome viewport diagnostics",
            );
        }
    }

    // One-time settle: await fonts.ready so the first frame's text shapes
    // are stable. After this, every per-frame setup is sync-CSS +
    // img.decode().
    let _ = page
        .execute(GenericCommand {
            method: std::borrow::Cow::Borrowed("Runtime.evaluate"),
            params: serde_json::json!({
                "expression": "(async () => { try { if (document.fonts) await document.fonts.ready; } catch (e) {} })()",
                "awaitPromise": true,
                "returnByValue": true,
            }),
        })
        .await
        .context("await fonts.ready")?;

    // Warmup BeginFrame: the first one after navigation typically commits
    // an empty frame as the compositor wires up. Burn it before the real
    // capture loop so the first written PNG isn't blank.
    let _ = page
        .execute(GenericCommand {
            method: std::borrow::Cow::Borrowed("HeadlessExperimental.beginFrame"),
            params: serde_json::json!({
                "frameTimeTicks": 1,
                "interval": 16,
                "noDisplayUpdates": false,
            }),
        })
        .await
        .context("HeadlessExperimental.beginFrame (warmup)")?;

    let mut frame_time_ticks: i64 = 2;
    // Phase X.3 hasDamage cache: when BeginFrame reports no damage, the
    // renderer didn't paint anything new, so the previous frame's bytes
    // are still the correct visual output. Save the PNG-decode + write
    // by holding onto the last bytes and reusing them when damage is
    // false. Per-worker (per-chunk) cache — cross-worker boundaries
    // can't reuse since we'd have to ferry bytes between processes.
    let mut last_bytes: Option<Vec<u8>> = None;

    for (chunk_idx, &t_seconds) in times_s.iter().enumerate() {
        let global_idx = offset + chunk_idx;

        // Drive the engine + wait for all <img> in the composition to be
        // decoded so the BeginFrame paint reflects this frame's source
        // PNG (the VideoClip slot's per-tick `<img src=...>` swap is
        // sync from JS's POV but the decoded bitmap isn't immediate).
        let setup_js = format!(
            "(async () => {{ \
                if (typeof window.__setTime === 'function') window.__setTime({t:.6}); \
                const imgs = document.querySelectorAll('img'); \
                await Promise.all(Array.from(imgs).map(i => i.decode().catch(() => null))); \
            }})()",
            t = t_seconds,
        );
        let _ = page
            .execute(GenericCommand {
                method: std::borrow::Cow::Borrowed("Runtime.evaluate"),
                params: serde_json::json!({
                    "expression": setup_js,
                    "awaitPromise": true,
                    "returnByValue": true,
                }),
            })
            .await
            .with_context(|| format!("frame {global_idx}: setup __setTime + decode"))?;

        // BeginFrame with screenshot: atomic paint + capture + hasDamage.
        let resp = page
            .execute(GenericCommand {
                method: std::borrow::Cow::Borrowed("HeadlessExperimental.beginFrame"),
                params: serde_json::json!({
                    "frameTimeTicks": frame_time_ticks,
                    "interval": 16,
                    "screenshot": { "format": "png" },
                }),
            })
            .await
            .with_context(|| format!("frame {global_idx}: BeginFrame"))?;
        frame_time_ticks += 16;

        let has_damage = resp
            .result
            .get("hasDamage")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let screenshot_b64 = resp.result.get("screenshotData").and_then(|v| v.as_str());

        let bytes = match (has_damage, screenshot_b64, last_bytes.as_ref()) {
            // Damage reported AND screenshot present — the common case.
            (true, Some(b64), _) => {
                let bytes = base64_decode(b64)
                    .with_context(|| format!("frame {global_idx}: decode screenshotData"))?;
                last_bytes = Some(bytes.clone());
                bytes
            }
            // No damage but we have a previous frame — reuse. Skips the
            // PNG decode entirely; the previous bytes are still the
            // correct visual output.
            (false, _, Some(prev)) => prev.clone(),
            // Damage but no screenshot bytes — chrome returned nothing
            // usable. Reuse the previous frame if we have one; otherwise
            // error (the first frame must always produce bytes).
            (true, None, Some(prev)) => {
                tracing::warn!(
                    target: "raster_chrome",
                    frame = global_idx,
                    "BeginFrame reported damage but returned no screenshotData; reusing prior frame",
                );
                prev.clone()
            }
            // No damage, no prior — first frame had nothing to render.
            // Synthesize an empty PNG? Not really possible without an
            // encoder. Error so the user sees the regression instead of
            // a half-broken export.
            (false, _, None) | (true, None, None) => {
                return Err(anyhow!(
                    "frame {global_idx}: BeginFrame returned no screenshotData and no prior frame to reuse (hasDamage={has_damage})"
                ));
            }
        };

        let path = out_dir.join(format!("frame_{global_idx:05}.png"));
        std::fs::write(&path, &bytes)
            .with_context(|| format!("frame {global_idx}: write {}", path.display()))?;

        // Signal one completed frame to the coordinator. If the channel
        // is closed (coordinator gave up), bail — no point continuing.
        if progress_tx.send(()).is_err() {
            break;
        }
    }

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_chunks_even_division() {
        let times: Vec<f64> = (0..12).map(|i| i as f64 * 0.1).collect();
        let chunks = split_chunks(&times, 4);
        assert_eq!(chunks.len(), 4);
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.offset, i * 3, "chunk {i} offset");
            assert_eq!(c.times.len(), 3, "chunk {i} len");
        }
    }

    #[test]
    fn split_chunks_uneven_division() {
        // 13 frames / 4 workers → first chunk gets one extra, rest get 3 each.
        let times: Vec<f64> = (0..13).map(|i| i as f64 * 0.1).collect();
        let chunks = split_chunks(&times, 4);
        assert_eq!(chunks.len(), 4);
        let lens: Vec<usize> = chunks.iter().map(|c| c.times.len()).collect();
        assert_eq!(lens, vec![4, 3, 3, 3]);
        // Coverage check: chunks tile times_s with no gaps or overlaps.
        let total_len: usize = lens.iter().sum();
        assert_eq!(total_len, 13);
        let starts: Vec<usize> = chunks.iter().map(|c| c.offset).collect();
        assert_eq!(starts, vec![0, 4, 7, 10]);
    }

    #[test]
    fn split_chunks_more_workers_than_frames() {
        // 3 frames / 8 workers → only 3 non-empty chunks; the rest are dropped.
        let times: Vec<f64> = (0..3).map(|i| i as f64 * 0.1).collect();
        let chunks = split_chunks(&times, 8);
        assert_eq!(chunks.len(), 3);
        for c in &chunks {
            assert_eq!(c.times.len(), 1);
        }
    }

    #[test]
    fn discovery_returns_some_on_dev_machine() {
        // Skip when no chrome-headless-shell binary is installed
        // (CI without the vendor download). On developer machines this
        // asserts we find it — the smoke test below depends on it.
        let found = find_chromium(&[]);
        if found.is_none() {
            eprintln!(
                "skipped: no chrome-headless-shell at standard paths; \
                 set CHROMIUM_EXPORT_EXE to override or run \
                 vendor/chrome-headless-shell/download.ps1"
            );
            return;
        }
        let b = found.unwrap();
        assert!(b.exe.is_file(), "discovery returned a non-file path");
    }

    /// Smoke: spawn Chrome, capture one red square, expect non-empty PNG
    /// header. Skips when no Chrome installed (CI guard).
    #[tokio::test]
    async fn smoke_begin_frame_returns_png() {
        let Some(binary) = find_chromium(&[]) else {
            eprintln!("skipped: no Chrome/Edge installed");
            return;
        };
        let html = r#"<!doctype html><html><body style="margin:0;background:transparent">
          <div style="width:200px;height:200px;background:rgba(255,0,0,0.5)"></div>
          </body></html>"#;
        let cap = smoke_capture_one_frame(&binary, html, 400, 400, 0.0)
            .await
            .expect("smoke capture");
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        assert!(
            cap.png_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]),
            "BeginFrame screenshotData wasn't a PNG (first bytes: {:?})",
            &cap.png_bytes.iter().take(8).collect::<Vec<_>>()
        );
        assert!(cap.png_bytes.len() > 100, "PNG suspiciously small");
    }
}
