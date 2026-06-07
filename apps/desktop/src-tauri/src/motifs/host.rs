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

/// Extract the Motif id from the host window's current URL.
///
/// The URL form is `http://motif.localhost/<id>/index.html`; we split on `/`
/// and take the first non-empty path segment as the id. Returns `None` if the
/// URL cannot be parsed or has no id segment.
fn motif_id_from_url(url: &tauri::Url) -> Option<String> {
    url.path_segments()
        .and_then(|mut segs| segs.find(|s| !s.is_empty()))
        .map(str::to_owned)
}

/// Build (or fetch the existing) hidden host window, loaded with `motif_id`'s
/// `index.html` and the clock-takeover `runtime` injected as an
/// `initialization_script`.
///
/// The window is hidden (`.visible(false)`) and sized to match the Motif so the
/// page lays out at its natural size before CDP `setDeviceMetricsOverride`
/// (in the capture path) re-sizes the render surface to the requested capture
/// dimensions.
///
/// **v1 single-Motif caveat:** if a host already exists we return it as-is,
/// but only if it is already bound to the same `motif_id`. Requesting a
/// different id on an existing window returns `Err` with a clear message;
/// multi-Motif navigation (navigate-or-rebuild) is a follow-up. We pass
/// `width`/`height` only as the initial window size hint.
pub fn ensure_host(
    app: &AppHandle,
    runtime: &str,
    motif_id: &str,
    width: u32,
    height: u32,
) -> tauri::Result<(WebviewWindow, bool)> {
    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        // Guard: if the existing window is bound to a different Motif id,
        // reject the call rather than silently rendering the wrong page.
        let bound_id = win.url().ok().and_then(|u| motif_id_from_url(&u));
        if bound_id.as_deref() != Some(motif_id) {
            let bound = bound_id.as_deref().unwrap_or("<unknown>");
            return Err(tauri::Error::Anyhow(anyhow::anyhow!(
                "motif host already bound to '{bound}'; \
                 multi-Motif navigation is a follow-up — \
                 requested '{motif_id}' cannot reuse this window"
            )));
        }
        return Ok((win, false));
    }

    // `http://motif.localhost/<id>/index.html` on Windows — the remapped form
    // of the `motif:` custom scheme (see `builtin` module docs).
    let url = format!("{SCHEME_ORIGIN}/{motif_id}/index.html");
    let parsed = url.parse().map_err(tauri::Error::InvalidUrl)?;

    let win = WebviewWindowBuilder::new(app, HOST_LABEL, WebviewUrl::CustomProtocol(parsed))
        .title("motif-host")
        .inner_size(width as f64, height as f64)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        // Defense-in-depth: this window has no need for the Tauri IPC bridge.
        // Tauri 2.11 does not expose `WebviewWindowBuilder::ipc(bool)` so we
        // cannot suppress IPC script injection from Rust. Capabilities already
        // reject all calls from this origin, which is the operative guard.
        // Track upstream issue and re-add `.ipc(false)` when the API ships.
        //
        // Approach A: inject the clock-takeover runtime at document-start, so
        // `window.motif` exists before the Motif's inline `motif.define(...)`.
        .initialization_script(runtime)
        .build()?;
    Ok((win, true))
}
