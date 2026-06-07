//! WebView2 DevTools-Protocol (CDP) frame capture for Motifs.
//!
//! A Motif is a web page rendered to a deterministic bitmap. We capture it
//! from Rust by driving the host `WebviewWindow`'s WebView2 via CDP:
//!
//! - `Emulation.setDeviceMetricsOverride` — render at an arbitrary resolution
//!   (decoupled from the host window's physical size), and
//! - `Page.captureScreenshot` — a **taint-free** PNG (unlike a DOM/canvas
//!   capture, the CDP screenshot is not subject to cross-origin canvas
//!   tainting, which is the whole reason we capture this way).
//!
//! This path was validated in a throwaway spike (2026-06-07): from Rust,
//! `WebviewWindow::with_webview(|pw| pw.controller().CoreWebView2()?
//! .CallDevToolsProtocolMethod(...))` reaches the controller;
//! `setDeviceMetricsOverride` completed in ~27 ms and `captureScreenshot`
//! returned a real PNG (~47 KB base64) in ~98 ms.
//!
//! ## Threading: do NOT block the UI thread
//!
//! `with_webview(closure)` runs `closure` on the WebView2 **UI thread**, and
//! `CallDevToolsProtocolMethod`'s completion handler *also* fires on that
//! thread's message loop — asynchronously, after `closure` returns. So the
//! closure must **not** block waiting for the result (no `recv()` /
//! `recv_timeout()` inside it): a blocked UI thread can't pump its message
//! loop, the handler never fires, and we deadlock.
//!
//! The async-safe shape used here:
//!   1. Build a `tokio::sync::oneshot` channel.
//!   2. `with_webview` issues both CDP calls and *returns immediately*. The
//!      screenshot's completion handler **moves the `Sender`** and sends the
//!      result when it fires (back on the now-pumping UI thread).
//!   3. The async caller `.await`s the `Receiver` **off** the UI thread, under
//!      a timeout.
//!
//! CDP processes commands in order on a session, so when both are issued,
//! `setDeviceMetricsOverride` then `captureScreenshot` back-to-back applies the
//! metrics before the shot — no handler chaining required (which is good,
//! because `ICoreWebView2` is `!Send` and cannot be moved into a handler). The
//! metrics call is gated by `set_metrics` (the size is constant per Motif, so
//! the caller skips it after the first frame); the screenshot is unconditional.

#![cfg(windows)]

use std::time::Duration;

use anyhow::{anyhow, Context};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;

/// How long to wait for the screenshot completion handler to fire before
/// giving up. The validated spike returned in ~98 ms; 5 s is a generous ceiling
/// that still surfaces a wedged UI thread / never-firing handler as an error
/// rather than hanging the calling future forever.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// Capture the current page of `window`'s WebView2 as a base64-encoded PNG,
/// rendered at `w` x `h` logical pixels.
///
/// This is the public building block for the Motifs capture path (the hidden
/// host window, the `motif:` scheme, the render-ready handshake, and the
/// `#[tauri::command]` wrapper are wired in a later task). It is async and
/// **never blocks the WebView2 UI thread** — see the module docs.
///
/// Returns the raw base64 string from `Page.captureScreenshot`'s
/// `{"data":"<base64>"}` result (no `data:` URI prefix).
///
/// `set_metrics`: when true, issue `Emulation.setDeviceMetricsOverride` to
/// `w`×`h` before the shot; when false, skip it and capture at whatever
/// resolution was last applied. Callers pass false once the host's render size
/// is known-unchanged (constant per Motif), saving a CDP round-trip per frame.
pub async fn capture_png_base64(window: &WebviewWindow, w: u32, h: u32, set_metrics: bool) -> anyhow::Result<String> {
    let (tx, rx) = oneshot::channel::<Result<String, String>>();

    // Issue both CDP calls on the UI thread. The closure returns immediately;
    // the screenshot handler (which owns `tx`) sends the result once it fires.
    window
        .with_webview(move |pw| unsafe {
            issue_capture_calls(pw, w, h, set_metrics, tx);
        })
        .context("with_webview failed (could not reach the WebView2 UI thread)")?;

    // Await the result OFF the UI thread, under a timeout. A timeout here means
    // the screenshot completion handler never fired (e.g. a wedged message
    // loop) — distinct from the handler reporting a CDP/HRESULT error.
    match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(Ok(b64))) => Ok(b64),
        Ok(Ok(Err(msg))) => Err(anyhow!("CDP capture failed: {msg}")),
        // Sender dropped without sending — should not happen (the handler
        // always sends), but treat it as an error rather than a silent hang.
        Ok(Err(_recv_err)) => Err(anyhow!(
            "CDP capture channel closed before a result was sent"
        )),
        Err(_elapsed) => Err(anyhow!(
            "CDP capture timed out after {:?} (screenshot completion handler never fired)",
            CAPTURE_TIMEOUT
        )),
    }
}

/// Issue `setDeviceMetricsOverride` then `captureScreenshot` on the WebView2.
///
/// MUST run on the WebView2 UI thread (i.e. only ever called from inside a
/// `with_webview` closure). `unsafe` because the `webview2-com` interface
/// methods (`CoreWebView2`, `CallDevToolsProtocolMethod`) are unsafe.
///
/// Consumes `tx` exactly once: either the screenshot completion handler sends
/// the result, or — if we fail to even issue the calls (e.g. the
/// `CoreWebView2` getter errors) — we send the setup error directly so the
/// awaiting future gets a real message instead of a timeout.
unsafe fn issue_capture_calls(
    pw: tauri::webview::PlatformWebview,
    w: u32,
    h: u32,
    set_metrics: bool,
    tx: oneshot::Sender<Result<String, String>>,
) {
    // `ICoreWebView2` is `!Send`, so it must stay on this thread and must not
    // be moved into either completion handler.
    let core = match pw.controller().CoreWebView2() {
        Ok(core) => core,
        Err(e) => {
            let _ = tx.send(Err(format!("CoreWebView2() failed: {e}")));
            return;
        }
    };

    // 1) Set the render resolution — fires only when the size changed (first
    //    capture after a host (re)create, or a size change). No-op completion
    //    handler: CDP applies commands in order on the session, so we don't
    //    need to wait for this to complete before issuing the screenshot.
    if set_metrics {
        let metrics_params = format!(
            r#"{{"width":{w},"height":{h},"deviceScaleFactor":1,"mobile":false}}"#
        );
        let metrics_handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_hr, _json| Ok(())));
        if let Err(e) = core.CallDevToolsProtocolMethod(
            &HSTRING::from("Emulation.setDeviceMetricsOverride"),
            &HSTRING::from(metrics_params.as_str()),
            &metrics_handler,
        ) {
            let _ = tx.send(Err(format!(
                "CallDevToolsProtocolMethod(setDeviceMetricsOverride) failed: {e}"
            )));
            return;
        }
    }

    // 2) Capture. The completion handler takes the single-use oneshot `Sender`
    //    and sends the parsed base64 PNG when WebView2 invokes it on the
    //    message loop. We hold the `Sender` in a shared `Rc<RefCell<Option<…>>>`
    //    so that if the call fails to *dispatch* at all (handler never fires),
    //    we can recover the still-unused `Sender` and report the dispatch
    //    error rather than leaving the awaiting future to time out. `Rc` is
    //    fine here: the completion-handler closure is not required to be `Send`
    //    and it runs on this same UI thread.
    let tx_slot = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
    let tx_for_handler = std::rc::Rc::clone(&tx_slot);
    let screenshot_handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |hr: windows::core::Result<()>, json: String| {
            // `hr`: the captureScreenshot HRESULT mapped to a `Result<()>`.
            // `json`: the CDP method result body (`{"data":"<base64>"}`).
            let result = match hr {
                Ok(()) => parse_screenshot_data(&json),
                Err(e) => Err(format!("captureScreenshot HRESULT error: {e}")),
            };
            if let Some(tx) = tx_for_handler.borrow_mut().take() {
                let _ = tx.send(result);
            }
            Ok(())
        },
    ));

    if let Err(e) = core.CallDevToolsProtocolMethod(
        &HSTRING::from("Page.captureScreenshot"),
        &HSTRING::from(r#"{"format":"png"}"#),
        &screenshot_handler,
    ) {
        // The handler will never fire (the call did not dispatch), so recover
        // the still-unused `Sender` and report the dispatch error directly.
        if let Some(tx) = tx_slot.borrow_mut().take() {
            let _ = tx.send(Err(format!(
                "CallDevToolsProtocolMethod(captureScreenshot) failed: {e}"
            )));
        }
    }
}

/// Evaluate a JavaScript expression in the WebView2 page and wait for any
/// returned Promise to settle.
///
/// Issues CDP method **`Runtime.evaluate`** with `awaitPromise: true` so that
/// a Promise-returning expression is fully awaited before the handler fires.
/// The function returns `Ok(())` when the expression completes without
/// throwing; if the expression throws (or its Promise rejects), it returns
/// `Err` with the exception description extracted from `exceptionDetails`.
///
/// Uses the same non-blocking pattern as [`capture_png_base64`] — the UI
/// thread is **never blocked** (see the module-level docs).
pub async fn eval_await(window: &WebviewWindow, expression: &str) -> anyhow::Result<()> {
    // Build the params JSON via serde_json so the expression string is
    // correctly escaped regardless of what it contains.
    let params = serde_json::json!({
        "expression": expression,
        "awaitPromise": true,
        "returnByValue": true,
        "userGesture": true,
    })
    .to_string();

    let (tx, rx) = oneshot::channel::<Result<(), String>>();

    window
        .with_webview(move |pw| unsafe {
            issue_eval_call(pw, params, tx);
        })
        .context("with_webview failed (could not reach the WebView2 UI thread)")?;

    match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(msg))) => Err(anyhow!("CDP Runtime.evaluate failed: {msg}")),
        Ok(Err(_recv_err)) => Err(anyhow!(
            "CDP Runtime.evaluate channel closed before a result was sent"
        )),
        Err(_elapsed) => Err(anyhow!(
            "CDP Runtime.evaluate timed out after {:?} (completion handler never fired)",
            CAPTURE_TIMEOUT
        )),
    }
}

/// Issue `Runtime.evaluate` on the WebView2.
///
/// MUST run on the WebView2 UI thread (i.e. only ever called from inside a
/// `with_webview` closure). `unsafe` for the same reasons as
/// [`issue_capture_calls`].
unsafe fn issue_eval_call(
    pw: tauri::webview::PlatformWebview,
    params: String,
    tx: oneshot::Sender<Result<(), String>>,
) {
    let core = match pw.controller().CoreWebView2() {
        Ok(core) => core,
        Err(e) => {
            let _ = tx.send(Err(format!("CoreWebView2() failed: {e}")));
            return;
        }
    };

    let tx_slot = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
    let tx_for_handler = std::rc::Rc::clone(&tx_slot);

    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |hr: windows::core::Result<()>, json: String| {
            let result = match hr {
                Ok(()) => parse_eval_result(&json),
                Err(e) => Err(format!("Runtime.evaluate HRESULT error: {e}")),
            };
            if let Some(tx) = tx_for_handler.borrow_mut().take() {
                let _ = tx.send(result);
            }
            Ok(())
        },
    ));

    if let Err(e) = core.CallDevToolsProtocolMethod(
        &HSTRING::from("Runtime.evaluate"),
        &HSTRING::from(params.as_str()),
        &handler,
    ) {
        if let Some(tx) = tx_slot.borrow_mut().take() {
            let _ = tx.send(Err(format!(
                "CallDevToolsProtocolMethod(Runtime.evaluate) failed: {e}"
            )));
        }
    }
}

/// Parse a `Runtime.evaluate` CDP response.
///
/// Returns `Ok(())` when the evaluation succeeded. Returns `Err` when the
/// response contains a top-level `"exceptionDetails"` field, extracting the
/// human-readable message from `exceptionDetails.exception.description` (the
/// most informative field) with a fallback to `exceptionDetails.text`.
fn parse_eval_result(json: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Runtime.evaluate result was not JSON: {e} (body: {json})"))?;

    if let Some(exc) = value.get("exceptionDetails") {
        // Prefer the exception object's description (e.g. "ReferenceError: x
        // is not defined") over the coarser `text` field.
        let msg = exc
            .get("exception")
            .and_then(|o| o.get("description"))
            .and_then(|d| d.as_str())
            .or_else(|| exc.get("text").and_then(|t| t.as_str()))
            .unwrap_or("unknown exception");
        return Err(format!("Runtime.evaluate exception: {msg}"));
    }

    Ok(())
}

/// Parse `Page.captureScreenshot`'s JSON result (`{"data":"<base64 PNG>"}`)
/// into the raw base64 string.
fn parse_screenshot_data(json: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("captureScreenshot result was not JSON: {e} (body: {json})"))?;
    value
        .get("data")
        .and_then(|d| d.as_str())
        .map(str::to_owned)
        .ok_or_else(|| format!("captureScreenshot result had no `data` field (body: {json})"))
}

#[cfg(test)]
mod tests {
    use super::{parse_eval_result, parse_screenshot_data};

    // --- parse_screenshot_data ---

    #[test]
    fn parses_data_field() {
        let out = parse_screenshot_data(r#"{"data":"AAAB"}"#).unwrap();
        assert_eq!(out, "AAAB");
    }

    #[test]
    fn errors_on_missing_data() {
        assert!(parse_screenshot_data(r#"{"nope":1}"#).is_err());
    }

    #[test]
    fn errors_on_non_json() {
        assert!(parse_screenshot_data("not json").is_err());
    }

    // --- parse_eval_result ---

    #[test]
    fn eval_ok_when_no_exception() {
        // A typical successful Runtime.evaluate response.
        assert!(parse_eval_result(r#"{"result":{"type":"undefined"}}"#).is_ok());
    }

    #[test]
    fn eval_err_uses_exception_description() {
        let json = r#"{
            "result": {"type":"object","subtype":"error"},
            "exceptionDetails": {
                "text": "Uncaught",
                "exception": {
                    "description": "ReferenceError: __motifRender is not defined"
                }
            }
        }"#;
        let err = parse_eval_result(json).unwrap_err();
        assert!(
            err.contains("ReferenceError: __motifRender is not defined"),
            "unexpected message: {err}"
        );
    }

    #[test]
    fn eval_err_falls_back_to_text_when_no_description() {
        let json = r#"{"exceptionDetails":{"text":"Script threw an exception"}}"#;
        let err = parse_eval_result(json).unwrap_err();
        assert!(err.contains("Script threw an exception"), "unexpected: {err}");
    }

    #[test]
    fn eval_err_on_non_json() {
        assert!(parse_eval_result("not json").is_err());
    }
}
