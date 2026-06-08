//! The `motif_capture_frame` Tauri command: render a Motif to a frame and
//! return it as a base64 PNG.
//!
//! Windows-only (CDP/WebView2). The flow:
//!   1. Read the registered runtime source (errors if the frontend hasn't
//!      called `motif_register_runtime` yet).
//!   2. `ensure_host` — build/reuse the hidden host window with the Motif's
//!      `index.html` as its top-level document and the runtime injected at
//!      document-start.
//!   3. Wait for the page to load AND the Motif's `motif.define` to have run
//!      (so `window.__motifRender` exists), via a bounded retry of a CDP
//!      expression that *throws until ready* (a `false` boolean would resolve
//!      to `Ok(())` and falsely read as ready — so we throw instead).
//!   4. `eval_await(window.__motifRender(t, props, meta))` — render + settle.
//!   5. `capture_png_base64` — taint-free PNG via `Page.captureScreenshot`.

use std::time::Duration;

use tauri::{AppHandle, State};

use super::{cdp, host, MotifCapture, MotifRuntime};

/// How long to wait for the host page to load + the Motif to register
/// `window.__motifRender`. Generous: a cold WebView2 window create + first
/// paint can take a beat. Bounded so a genuinely broken Motif surfaces an
/// error rather than hanging.
const READY_ATTEMPTS: u32 = 30;
const READY_POLL: Duration = Duration::from_millis(100);

/// Render Motif `motif_id` at content time `t_sec` with `props_json`, captured
/// at `width` x `height`. Returns a base64-encoded PNG (no `data:` prefix).
///
/// All errors map to `String` for the IPC boundary.
#[tauri::command]
pub async fn motif_capture_frame(
    app: AppHandle,
    state: State<'_, MotifRuntime>,
    capture: State<'_, MotifCapture>,
    motif_id: String,
    t_sec: f64,
    props_json: String,
    width: u32,
    height: u32,
    settle_rafs: Option<u32>,
) -> Result<String, String> {
    let runtime = state
        .get()
        .ok_or_else(|| "motif runtime not registered yet (call motif_register_runtime)".to_string())?;

    // Serialize the WHOLE render + capture. Held across every await so concurrent
    // captures (on-demand sprite, prewarmer, baker) can't interleave on the one
    // host and screenshot a stale vclock. Also guards the per-host CaptureState.
    let mut cap = capture.0.lock().await;

    let (win, needs_reset) = host::ensure_host(&app, &runtime, &motif_id, width, height)
        .map_err(|e| format!("ensure_host failed: {e}"))?;
    if needs_reset {
        cap.reset();
    }

    // Ready-probe only when this host isn't already confirmed ready for this id.
    if super::should_probe(cap.ready_for.as_deref(), &motif_id) {
        // The pathname guard closes the navigate→stale-page race: when
        // `ensure_host` calls `win.navigate(...)` to switch Motif ids, the old
        // page is still loaded (readyState==='complete', __motifRender defined)
        // until the new page commits.  The old page's pathname is
        // `/<old-id>/index.html`, which fails `indexOf('/<new-id>/')===0` — so
        // the probe correctly keeps retrying until the new document is live.
        let ready_probe = format!(
            "if(!(typeof window.__motifRender==='function'\
            &&document.readyState==='complete'\
            &&location.pathname.indexOf('/{motif_id}/')===0\
            ))throw new Error('motif-not-ready');true"
        );
        let mut last_err = None;
        let mut ready = false;
        for _ in 0..READY_ATTEMPTS {
            match cdp::eval_await(&win, &ready_probe).await {
                Ok(()) => {
                    ready = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    tokio::time::sleep(READY_POLL).await;
                }
            }
        }
        if !ready {
            return Err(format!(
                "motif '{motif_id}' never became ready (window.__motifRender undefined or page not loaded): {}",
                last_err
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "no error captured".to_string())
            ));
        }
        cap.ready_for = Some(motif_id.clone());
    }

    // Build the render expression. `props` is parsed then re-serialized so the
    // canonical JSON (not the raw caller string) is embedded; `t` and `meta`
    // are embedded via serde_json so escaping is correct.
    let props: serde_json::Value = serde_json::from_str(&props_json)
        .map_err(|e| format!("props_json is not valid JSON: {e}"))?;

    // Duration: for v1 derive from the `seconds` prop if present (the countdown
    // Motif's max-duration prop), else fall back to 5s. fps is fixed at 30 for
    // the capture meta.
    // TODO(motifs-plan-2): derive duration from manifest.max_duration_prop instead of
    // hardcoding the "seconds" prop name (only correct for the countdown built-in today).
    let duration = props
        .get("seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(5.0);
    let meta = serde_json::json!({
        "duration": duration,
        "width": width,
        "height": height,
        "fps": 30,
        "settleRafs": settle_rafs,
    });

    // Serialize `t_sec` via serde_json so non-finite values (NaN, ±Inf)
    // become JSON `null` — visibly wrong — instead of the JS `NaN` global,
    // which would silently render the wrong frame.
    let t_json = serde_json::to_string(&t_sec)
        .map_err(|e| format!("failed to serialize t_sec: {e}"))?;
    let render_expr = format!(
        "window.__motifRender({t}, {props}, {meta})",
        t = t_json,
        props = props,
        meta = meta,
    );
    cdp::eval_await(&win, &render_expr)
        .await
        .map_err(|e| format!("__motifRender failed: {e}"))?;

    let set_metrics = super::should_set_metrics(cap.last_size, width, height);
    let b64 = cdp::capture_png_base64(&win, width, height, set_metrics)
        .await
        .map_err(|e| format!("capture failed: {e}"))?;
    if set_metrics {
        cap.last_size = Some((width, height));
    }
    Ok(b64)
}
