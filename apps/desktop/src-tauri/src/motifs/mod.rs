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

pub mod authoring;
pub mod authoring_commands;
pub mod builtin;
pub mod catalog;
pub mod store;

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

/// Per-host capture bookkeeping, guarded by `MotifCapture`'s async mutex so the
/// three JS fill loops (on-demand sprite, prewarmer, baker) can never interleave
/// `__motifRender` + screenshot on the one shared host DOM/vclock and capture a
/// wrong frame. The same critical section lets us skip the ready-probe and the
/// `setDeviceMetricsOverride` on warm frames (they are idempotent once set).
#[derive(Default)]
pub struct CaptureState {
    /// Size last applied via `Emulation.setDeviceMetricsOverride` to the current
    /// host. `None` until the first capture after a (re)created host window.
    pub last_size: Option<(u32, u32)>,
    /// Motif id whose host is confirmed render-ready (page loaded +
    /// `window.__motifRender` defined). Skip the ready-probe when it matches.
    pub ready_for: Option<String>,
}

impl CaptureState {
    /// Drop both caches — called when `ensure_host` (re)creates the window.
    pub fn reset(&mut self) {
        self.last_size = None;
        self.ready_for = None;
    }
}

/// App-managed async lock that BOTH serializes captures and guards
/// [`CaptureState`]. `tokio::sync::Mutex` (not `parking_lot`) because the guard
/// is held across `.await` points (the whole render + capture).
pub struct MotifCapture(pub tokio::sync::Mutex<CaptureState>);

impl MotifCapture {
    pub fn new() -> Self {
        Self(tokio::sync::Mutex::new(CaptureState::default()))
    }
}

impl Default for MotifCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// Probe the host only when it isn't already confirmed ready for this motif id.
pub fn should_probe(ready_for: Option<&str>, motif_id: &str) -> bool {
    ready_for != Some(motif_id)
}

/// Re-issue `setDeviceMetricsOverride` only when the requested size differs from
/// what is already applied to the host (constant per motif today → set once).
pub fn should_set_metrics(last_size: Option<(u32, u32)>, w: u32, h: u32) -> bool {
    last_size != Some((w, h))
}

#[cfg(test)]
mod capture_state_tests {
    use super::*;

    #[test]
    fn probes_until_ready_for_matches() {
        assert!(should_probe(None, "countdown"));
        assert!(should_probe(Some("other"), "countdown"));
        assert!(!should_probe(Some("countdown"), "countdown"));
    }

    #[test]
    fn sets_metrics_only_on_change() {
        assert!(should_set_metrics(None, 480, 480));
        assert!(should_set_metrics(Some((100, 100)), 480, 480));
        assert!(!should_set_metrics(Some((480, 480)), 480, 480));
    }

    #[test]
    fn reset_clears_both() {
        let mut s = CaptureState {
            last_size: Some((480, 480)),
            ready_for: Some("countdown".into()),
        };
        s.reset();
        assert_eq!(s.last_size, None);
        assert_eq!(s.ready_for, None);
    }
}
