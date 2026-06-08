//! The hidden host `WebviewWindow` that runs a Motif as its top-level document.
//!
//! Windows-only (the capture path is CDP/WebView2). A single hidden window is
//! lazily created on first capture and reused across captures. When a capture
//! requests a different Motif id than the one the host is currently bound to,
//! the host navigates to the new id's `index.html` rather than being torn down
//! and rebuilt — see [`ensure_host`].

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
/// Returns `(window, needs_reset)`. `needs_reset` is `true` when the host was
/// freshly created **or** navigated to a different Motif id; the caller should
/// reset `CaptureState` in both cases so the ready-probe re-confirms
/// `window.__motifRender` on the new page and `setDeviceMetricsOverride`
/// re-applies for the new Motif's size. WebView2 re-runs the
/// `initialization_script` (the clock-takeover runtime) automatically on
/// every navigation, so no manual re-injection is needed.
///
/// When the host is already bound to the requested `motif_id`, the window is
/// returned as-is with `needs_reset = false`.
pub fn ensure_host(
    app: &AppHandle,
    runtime: &str,
    motif_id: &str,
    width: u32,
    height: u32,
) -> tauri::Result<(WebviewWindow, bool)> {
    // `http://motif.localhost/<id>/index.html` on Windows — the remapped form
    // of the `motif:` custom scheme (see the `builtin` module docs).
    let url = format!("{SCHEME_ORIGIN}/{motif_id}/index.html");
    let parsed: tauri::Url = url.parse().map_err(tauri::Error::InvalidUrl)?;

    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        let bound_id = win.url().ok().and_then(|u| motif_id_from_url(&u));
        if bound_id.as_deref() == Some(motif_id) {
            // Already on the right Motif — reuse as-is, no reset.
            return Ok((win, false));
        }
        // Bound to a DIFFERENT Motif: navigate the existing hidden host to the
        // new id, reusing the window + CDP session. WebView2 re-runs the
        // `initialization_script` on navigation, so the clock-takeover runtime
        // re-injects before the new page's `motif.define(...)`. The caller
        // resets `CaptureState` (returned `true`) so the ready-probe re-confirms
        // `__motifRender` on the new page and `setDeviceMetricsOverride` re-applies
        // for the new Motif's size.
        win.navigate(parsed)?;
        return Ok((win, true));
    }

    // No host yet: build it (hidden, no taskbar, runtime injected at doc-start).
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

/// Close + drop the hidden host window if it exists. The next `ensure_host`
/// rebuilds a fresh one. Used to recover from a wedged host: a Motif whose JS
/// hangs past the capture timeout leaves the WebView2 UI thread stuck, so the
/// window must be torn down, not reused.
pub fn teardown_host(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        let _ = win.close();
    }
}

#[cfg(test)]
mod tests {
    use super::motif_id_from_url;

    #[test]
    fn extracts_id_from_host_url() {
        let u: tauri::Url = "http://motif.localhost/lower-third/index.html".parse().unwrap();
        assert_eq!(motif_id_from_url(&u).as_deref(), Some("lower-third"));
    }

    #[test]
    fn none_for_root_url() {
        let u: tauri::Url = "http://motif.localhost/".parse().unwrap();
        assert_eq!(motif_id_from_url(&u), None);
    }
}
