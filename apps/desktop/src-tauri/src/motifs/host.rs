//! The hidden host `WebviewWindow` that runs a Motif as its top-level document.
//!
//! Windows-only (the capture path is CDP/WebView2). For v1 a single Motif is
//! loaded per host window: the window is created lazily on first capture, keyed
//! to its initial Motif id, and reused thereafter. Navigating an existing host
//! to a *different* Motif id is a later concern (see [`ensure_host`]).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::builtin::SCHEME_ORIGIN;

/// Window label of the reused hidden host. There is at most one at a time.
pub const HOST_LABEL: &str = "motif-host";

/// Build (or fetch the existing) hidden host window, loaded with `motif_id`'s
/// `index.html` and the clock-takeover `runtime` injected as an
/// `initialization_script`.
///
/// The window is hidden (`.visible(false)`) and sized to match the Motif so the
/// page lays out at its natural size before CDP `setDeviceMetricsOverride`
/// (in the capture path) re-sizes the render surface to the requested capture
/// dimensions.
///
/// **v1 single-Motif caveat:** if a host already exists we return it as-is. We
/// do *not* currently re-navigate it to a different `motif_id`; the first
/// captured Motif owns the window for the process lifetime. The capture command
/// only drives `countdown` today, so this is sufficient; multi-Motif reuse
/// (navigate-or-rebuild) is a follow-up. We pass `width`/`height` only as the
/// initial window size hint.
pub fn ensure_host(
    app: &AppHandle,
    runtime: &str,
    motif_id: &str,
    width: u32,
    height: u32,
) -> tauri::Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        return Ok(win);
    }

    // `http://motif.localhost/<id>/index.html` on Windows — the remapped form
    // of the `motif:` custom scheme (see `builtin` module docs).
    let url = format!("{SCHEME_ORIGIN}/{motif_id}/index.html");
    let parsed = url.parse().map_err(tauri::Error::InvalidUrl)?;

    WebviewWindowBuilder::new(app, HOST_LABEL, WebviewUrl::CustomProtocol(parsed))
        .title("motif-host")
        .inner_size(width as f64, height as f64)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        // Approach A: inject the clock-takeover runtime at document-start, so
        // `window.motif` exists before the Motif's inline `motif.define(...)`.
        .initialization_script(runtime)
        .build()
}
