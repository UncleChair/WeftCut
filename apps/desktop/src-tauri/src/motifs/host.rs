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
/// freshly created **or** navigated to a different Motif id **or** a changed
/// content version (`content_hash`); the caller should reset `CaptureState` in
/// all cases so the ready-probe re-confirms `window.__motifRender` on the new
/// page and `setDeviceMetricsOverride` re-applies for the new Motif's size.
/// WebView2 re-runs the `initialization_script` (the clock-takeover runtime)
/// automatically on every navigation, so no manual re-injection is needed.
///
/// The host URL carries a `?v=<content_hash>` cache-buster: an in-place draft
/// edit (same id, new content) yields a new URL, so the host navigates (reload)
/// and WebView2 re-fetches the edited disk file. The `motif:` scheme handler
/// ignores the query (it resolves `/<id>/index.html`), so the cache-buster is
/// harmless to serving.
///
/// When the host is already bound to the requested `motif_id` AND the same
/// content version, the window is returned as-is with `needs_reset = false`.
pub fn ensure_host(
    app: &AppHandle,
    runtime: &str,
    motif_id: &str,
    content_hash: &str,
    width: u32,
    height: u32,
) -> tauri::Result<(WebviewWindow, bool)> {
    // `?v=<content_hash>` is a cache-buster: a content change yields a new URL so
    // WebView2 re-fetches the (edited) disk file. The `motif:` scheme handler
    // ignores the query (resolves `/<id>/index.html`), so it's harmless to serving.
    let url = format!("{SCHEME_ORIGIN}/{motif_id}/index.html?v={content_hash}");
    let parsed: tauri::Url = url.parse().map_err(tauri::Error::InvalidUrl)?;

    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        if let Ok(bound) = win.url() {
            let same_id = motif_id_from_url(&bound).as_deref() == Some(motif_id);
            let bound_v = bound
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            // Reuse only when BOTH the id and the content version match — so an
            // in-place draft edit (same id, new content_hash) forces a reload.
            if same_id && bound_v == content_hash {
                return Ok((win, false));
            }
        }
        // Different id OR changed content: navigate (reload). WebView2 re-runs the
        // `initialization_script`, so the clock-takeover runtime re-injects before
        // the new page's `motif.define(...)`. The caller resets `CaptureState`
        // (returned `true`) so the ready-probe re-confirms `__motifRender` on the
        // new page and `setDeviceMetricsOverride` re-applies for the new size.
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

    #[test]
    fn extracts_id_from_host_url_with_version_query() {
        let u: tauri::Url = "http://motif.localhost/lower-third/index.html?v=abc123"
            .parse()
            .unwrap();
        assert_eq!(super::motif_id_from_url(&u).as_deref(), Some("lower-third"));
    }
}
