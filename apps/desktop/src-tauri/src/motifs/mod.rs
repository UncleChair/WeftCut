//! Motifs: web pages captured to deterministic video frames.
//!
//! A Motif is a `manifest.json` + `index.html` + `assets/` bundle. Given a
//! content time `t`, props, and a render size, a clock-takeover wrapper drives
//! the page to `t` and we capture a **taint-free** bitmap via the WebView2
//! DevTools Protocol (CDP).
//!
//! This module currently exposes the Rust-side capture mechanism only
//! ([`cdp::capture_png_base64`]). The hidden host window, the `motif:` URI
//! scheme, the render-ready handshake, and the `#[tauri::command]` wrapper are
//! wired in a later task and will live alongside this module.
//!
//! Windows-only: the capture path is built on `webview2-com` CDP calls.

#[cfg(windows)]
pub mod cdp;
