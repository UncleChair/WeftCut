//! Media-pool drag-to-import: recover real filesystem paths from HTML5
//! file drops.
//!
//! Constraint: `dragDropEnabled: false` is load-bearing — Tauri/wry's own
//! drop target would break the timeline's internal HTML5 drag-and-drop
//! (media-pool → track placement). With it off, external Explorer drags
//! still reach the page as standard HTML5 drag events, but the `File`
//! objects carry no filesystem path, and round-tripping gigabyte video
//! files through the JS heap is a non-starter.
//!
//! WebView2 ships the escape hatch:
//! `chrome.webview.postMessageWithAdditionalObjects` posts DOM `File`
//! objects to the host, where they surface as `ICoreWebView2File` —
//! which HAS a `Path`. The drop handler in the media pool posts
//! `{kind: MESSAGE_MARKER}` plus `DataTransfer.files`; the handler here
//! extracts the paths and emits [`DROP_EVENT`] back to the window, where
//! the frontend feeds them to the same import pipeline as the file
//! picker.
//!
//! The handler is ADDED alongside wry's own `WebMessageReceived`
//! subscriber (COM events fan out to every sink); messages without the
//! marker are ignored here, and wry ignores ours.

use tauri::{Emitter, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::WebMessageReceivedEventHandler;
use windows::core::Interface;

/// Emitted to the main window with `Vec<String>` of absolute paths.
pub const DROP_EVENT: &str = "media:external-drop";

/// Marker the frontend embeds in the posted message string. Namespaced so
/// no other postMessage traffic can collide.
const MESSAGE_MARKER: &str = "weftcut:media-drop";

/// Subscribe to the main webview's `WebMessageReceived` and forward
/// dropped-file paths to the frontend. Call once at setup.
pub fn attach(window: &WebviewWindow) -> tauri::Result<()> {
    let emitter = window.clone();
    window.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else {
            tracing::warn!("media_drop: CoreWebView2 unavailable");
            return;
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // Cheap reject first: read the message string and look for our
            // marker. Non-string messages (ArrayBuffer IPC etc.) error out
            // of TryGetWebMessageAsString — also not ours.
            let mut msg = windows::core::PWSTR::null();
            if args.TryGetWebMessageAsString(&mut msg).is_err() {
                return Ok(());
            }
            let text = take_pwstr(msg);
            if !text.contains(MESSAGE_MARKER) {
                return Ok(());
            }
            let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
                return Ok(());
            };
            let Ok(objects) = args2.AdditionalObjects() else {
                return Ok(());
            };
            let mut count = 0u32;
            if objects.Count(&mut count).is_err() {
                return Ok(());
            }
            let mut paths: Vec<String> = Vec::new();
            for i in 0..count {
                let Ok(obj) = objects.GetValueAtIndex(i) else { continue };
                // Only disk-backed File objects cast to ICoreWebView2File
                // with a non-empty path; synthetic Files (new File([…]))
                // yield empty strings and are dropped here.
                let Ok(file) = obj.cast::<ICoreWebView2File>() else { continue };
                let mut p = windows::core::PWSTR::null();
                if file.Path(&mut p).is_ok() {
                    let path = take_pwstr(p);
                    if !path.is_empty() {
                        paths.push(path);
                    }
                }
            }
            tracing::info!(
                "media_drop: {} dropped object(s), {} with usable paths",
                count,
                paths.len()
            );
            if !paths.is_empty() {
                let _ = emitter.emit(DROP_EVENT, paths);
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        match core.add_WebMessageReceived(&handler, &mut token) {
            Ok(()) => tracing::debug!("media_drop: WebMessageReceived handler registered"),
            Err(e) => tracing::warn!("media_drop: add_WebMessageReceived failed: {e}"),
        }
        // The token is intentionally dropped without removal — the
        // subscription lives exactly as long as the main window.
    })
}

/// Copy a COM-allocated PWSTR into a String and free the original.
unsafe fn take_pwstr(p: windows::core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
    s
}
