//! Motifs: web pages captured to deterministic video frames.
//!
//! A Motif is a `manifest.json` + `index.html` + `assets/` bundle. Given a
//! content time `t`, props, and a render size, a clock-takeover wrapper drives
//! the page to `t` and we capture a **taint-free** bitmap via the WebView2
//! DevTools Protocol (CDP).
//!
//! ## Architecture (Approach A — window-as-isolation)
//!
//! 1. A Motif is loaded as a **hidden WebView2 window's top-level document**
//!    (no iframe), served by the custom [`builtin`] `motif:` URI scheme.
//! 2. The clock-takeover runtime (defined on the JS side as
//!    `MOTIF_RUNTIME_SOURCE`) is injected via the window's
//!    `initialization_script`, which wry runs at document-start — before the
//!    Motif's own inline `motif.define(...)` — so `window.motif` exists in
//!    time. The runtime string is handed to Rust at app boot via
//!    [`motif_register_runtime`] and stored in [`MotifRuntime`].
//! 3. Capture is driven from Rust over CDP ([`cdp`]):
//!    [`cdp::eval_await`] runs `window.__motifRender(t, props, meta)` to
//!    render + settle, then [`cdp::capture_png_base64`] grabs the PNG.
//!
//! Windows-only: the capture path is built on `webview2-com` CDP calls.

#[cfg(windows)]
pub mod cdp;

pub mod builtin;

#[cfg(windows)]
pub mod commands;
#[cfg(windows)]
pub mod host;

use parking_lot::Mutex;
use tauri::State;

/// App-managed slot holding the JS-side Motif runtime source string.
///
/// The frontend hands this over once at boot via [`motif_register_runtime`]
/// (the source is `MOTIF_RUNTIME_SOURCE` from
/// `apps/desktop/src/render/motifs/runtime.ts`). The hidden host window injects
/// it as its `initialization_script`. `None` until the frontend registers it —
/// the capture command errors clearly in that window.
pub struct MotifRuntime(pub Mutex<Option<String>>);

impl MotifRuntime {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Return a clone of the registered runtime source, if any.
    pub fn get(&self) -> Option<String> {
        self.0.lock().clone()
    }
}

impl Default for MotifRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// Store the JS-side Motif runtime source so the hidden host window can inject
/// it as an `initialization_script`. Called once by the frontend at startup
/// (fire-and-forget). Idempotent — a later call simply replaces the source.
#[tauri::command]
pub fn motif_register_runtime(state: State<'_, MotifRuntime>, source: String) {
    *state.0.lock() = Some(source);
}
