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
//! **Scope of Phase X.1**: Chrome/Edge discovery on Windows + a smoke
//! function that spawns headless Chrome, captures one frame from a static
//! data URL via `HeadlessExperimental.beginFrame`, and returns the PNG
//! bytes. Phase X.2 swaps this into the actual export pipeline; Phase X.3
//! adds the `hasDamage` skip; Phase X.4 parallelizes across N instances;
//! Phase X.5 wires the fallback dialog when no Chrome is found.
//!
//! **Why detect-only (no bundled Chromium)** for v1: bundling ships
//! ~150 MB of binary inside the installer. ~95% of Windows users have
//! Chrome or Edge installed (Edge ships with Windows 10+). We surface a
//! clear "install Chrome for faster exports" dialog when neither is
//! present and fall back to the WebView2 rasterizer (which still works,
//! just slower).
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

/// Resolved Chromium-family browser, used to invoke headless Chrome.
/// Edge is a fallback for users without Chrome; both are Chromium-based
/// and expose the same CDP surface including `HeadlessExperimental`.
#[derive(Clone, Debug)]
pub struct ChromiumBinary {
    pub exe: PathBuf,
    pub flavor: ChromiumFlavor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChromiumFlavor {
    /// Bundled `chrome-headless-shell` (legacy-headless renamed binary, from
    /// Chrome for Testing). The only flavor where
    /// `HeadlessExperimental.beginFrame` works on modern installs — we
    /// prefer it for the atomic paint+capture + `hasDamage` skip.
    HeadlessShell,
    /// Detected installed Chrome (chrome.exe). Falls back to
    /// `Page.captureScreenshot` since Chrome 132+ removed legacy headless.
    Chrome,
    /// Detected installed Edge (msedge.exe). Same fallback path as Chrome.
    Edge,
}

/// Locate a Chromium binary suitable for headless export raster.
///
/// Lookup order (first hit wins):
///   1. `CHROMIUM_EXPORT_EXE` env var (escape hatch for testing).
///   2. Bundled `chrome-headless-shell.exe` from `vendor/chrome-headless-shell/`
///      — this is the renamed legacy-headless binary, the ONLY Chromium build
///      that still exposes `HeadlessExperimental.beginFrame`. Chrome 132+ and
///      modern Edge dropped legacy headless from `chrome.exe`; chrome-headless-
///      shell is published separately under Chrome for Testing exactly for this
///      automation use case.
///   3. Installed Chrome at the standard `Program Files` / `Local\\AppData`
///      paths (fallback to `Page.captureScreenshot` since BeginFrame is gone).
///   4. Installed Edge at the standard `Program Files` paths (always present
///      on Windows 10+, so this is the "always works" last resort).
///
/// Returns `None` only when *no* Chromium binary is found — at that point the
/// caller should surface the install-hint dialog (Phase X.5) and fall back to
/// the WebView2 rasterizer (`raster/mod.rs`).
pub fn find_chromium() -> Option<ChromiumBinary> {
    if let Ok(custom) = std::env::var("CHROMIUM_EXPORT_EXE") {
        let p = PathBuf::from(custom);
        if p.is_file() {
            return Some(ChromiumBinary {
                exe: p,
                flavor: ChromiumFlavor::HeadlessShell,
            });
        }
    }

    for path in headless_shell_candidate_paths() {
        if path.is_file() {
            return Some(ChromiumBinary {
                exe: path,
                flavor: ChromiumFlavor::HeadlessShell,
            });
        }
    }
    for path in chrome_candidate_paths() {
        if path.is_file() {
            return Some(ChromiumBinary {
                exe: path,
                flavor: ChromiumFlavor::Chrome,
            });
        }
    }
    for path in edge_candidate_paths() {
        if path.is_file() {
            return Some(ChromiumBinary {
                exe: path,
                flavor: ChromiumFlavor::Edge,
            });
        }
    }
    None
}

/// Candidate paths for the bundled `chrome-headless-shell.exe`. v1 looks in
/// two places: (a) `vendor/chrome-headless-shell/` next to the running exe,
/// for dev builds where `target/debug/weftcut.exe` runs from the repo, and
/// (b) the Tauri-bundled resources dir at runtime (wired by
/// `tauri.conf.json -> bundle.resources` in Phase X.5).
fn headless_shell_candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    // Walk up from the running exe (or cwd in tests) to the repo root and
    // look at `apps/desktop/src-tauri/vendor/chrome-headless-shell/...`.
    // For dev/test, the exe is somewhere under `target/`; the vendor dir
    // sits at a known relative offset from the workspace root.
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

fn chrome_candidate_paths() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ];
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let user_chrome = Path::new(&localappdata)
            .join("Google")
            .join("Chrome")
            .join("Application")
            .join("chrome.exe");
        out.push(user_chrome);
    }
    out
}

fn edge_candidate_paths() -> Vec<PathBuf> {
    vec![
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ]
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
    // Flavor-aware launch flags. `chrome-headless-shell` IS the legacy
    // headless binary, so it doesn't need `--headless=...` at all and it
    // honors `--enable-begin-frame-control`. Installed `chrome.exe` /
    // `msedge.exe` need `--headless=new` and BeginFrame is unavailable
    // there (the smoke + production paths transparently fall back to
    // `Page.captureScreenshot` when BeginFrame returns "method not found").
    let mut builder = BrowserConfig::builder()
        .chrome_executable(&binary.exe)
        .arg("--disable-gpu") // GPU compositor in headless is flaky on Windows
        .arg("--hide-scrollbars")
        .arg(format!("--window-size={},{}", width, height));
    builder = match binary.flavor {
        ChromiumFlavor::HeadlessShell => builder
            .arg("--enable-begin-frame-control")
            .arg("--run-all-compositor-stages-before-draw"),
        ChromiumFlavor::Chrome | ChromiumFlavor::Edge => builder.arg("--headless=new"),
    };
    let config = builder
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
        // Try BeginFrame first (legacy-headless only — Chrome <132 / Edge old).
        // On modern Chrome `--headless=new` removed this domain entirely, so
        // we fall through to `Page.captureScreenshot` when it 404s. The
        // fallback loses BeginFrame's atomic paint+capture guarantee but
        // is the only path that works on Chrome 132+.
        let begin_frame_result = page
            .execute(GenericCommand {
                method: std::borrow::Cow::Borrowed("HeadlessExperimental.beginFrame"),
                params: cmd,
            })
            .await;

        let response_value: serde_json::Value = match begin_frame_result {
            Ok(r) => r.result.clone(),
            Err(e) if format!("{e}").contains("wasn't found") => {
                tracing::info!(
                    "BeginFrame unavailable (Chrome 132+ removed legacy headless); \
                     falling back to Page.captureScreenshot"
                );
                let shot_cmd = serde_json::json!({
                    "format": "png",
                    "optimizeForSpeed": false,
                    "captureBeyondViewport": false,
                });
                let shot = page
                    .execute(GenericCommand {
                        method: std::borrow::Cow::Borrowed("Page.captureScreenshot"),
                        params: shot_cmd,
                    })
                    .await
                    .context("Page.captureScreenshot (BeginFrame fallback)")?;
                // Page.captureScreenshot returns `{ "data": "<base64>" }`.
                // Synthesize a BeginFrame-shaped result so the unwrap below
                // doesn't branch.
                serde_json::json!({
                    "screenshotData": shot.result.get("data").cloned().unwrap_or(serde_json::Value::Null),
                    "hasDamage": true,
                })
            }
            Err(e) => return Err(anyhow::Error::new(e).context("HeadlessExperimental.beginFrame")),
        };
        let result: &serde_json::Value = &response_value;

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
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_returns_some_on_dev_machine() {
        // Skip when neither Chrome nor Edge is installed (CI without browsers).
        // On developer machines this asserts we find one — the smoke test
        // below depends on it.
        let found = find_chromium();
        if found.is_none() {
            eprintln!(
                "skipped: no Chromium-family browser at standard paths; \
                 set CHROMIUM_EXPORT_EXE to override"
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
        let Some(binary) = find_chromium() else {
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
