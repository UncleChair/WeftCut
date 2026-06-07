# Motifs Stage 3 — prewarm/persist redirect, throughput opts & warming UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Motif live preview *smooth-after-warm* (the After-Effects RAM-preview model): serialize CDP captures so the always-on fillers can't corrupt each other, redirect the L2 persist baker to CDP, shave the warm-frame round-trips, and surface warming progress on the timeline.

**Architecture:** Reuse-and-redirect (per `docs/superpowers/specs/2026-06-07-motifs-editor-integration-design.md` §3–§5). The single hidden WebView2 host renders Motifs over CDP; three independent JS fill loops (on-demand `MotifSprite`, `TemplatePrewarmer`, `TemplateBaker`) feed one shared `TemplateFrameCache`. Stage 2 already pointed the on-demand path **and** the prewarmer at CDP via `resolveTemplateFrame`. Stage 3 closes the gaps: (1) a Rust-side async mutex serializes every capture (the three loops otherwise interleave `__motifRender` + screenshot on one shared DOM/vclock and capture *wrong frames* — a latent correctness bug introduced when the prewarmer went CDP-backed); (2) the L2 baker still rasters via the **SVG** path and must move to CDP; (3) warm captures pay a redundant ready-probe and `setDeviceMetricsOverride` every frame; (4) there is no warming indicator.

**Tech Stack:** Rust (Tauri 2.11, `tokio::sync::Mutex`, `webview2-com` CDP), TypeScript (Vitest), React + Zustand, i18next.

**Out of scope (later stages):** export baker → CDP (`exportBake.ts`, Stage 4); deleting the SVG machinery + unifying the two catalogs + renaming the deferred `templates/` internals (Stage 5); multi-Motif host navigation (single built-in today → one host id → not needed); upload security (Plan 4).

---

## Pre-flight (read before Task 1)

Current wiring confirmed by exploration (2026-06-08):

- On-demand path: `MotifSprite.captureAndBind` → `resolveTemplateFrame` → (disk-first) → `rasterMotifFrame` → `captureMotifFrame` (CDP). **Already CDP.**
- Prewarmer: `Compositor.updatePrewarmTargets` render closure → `resolveTemplateFrame`. **Already CDP.**
- Baker (L2 disk persist): `Compositor.updateBakeTargets` render closure → `rasterTemplateFrame` → `rasterizeSvg`. **Still SVG — Task 2 fixes.**
- Export baker: `exportBake.ts` → `TemplateHarness` + `rasterizeSvg`. **Still SVG — Stage 4, leave alone.**
- Rust capture: `motif_capture_frame` (commands.rs) → `ensure_host` → ready-probe (≤30×100ms) → `eval_await(__motifRender)` → `capture_png_base64` (always issues `setDeviceMetricsOverride` then `Page.captureScreenshot`).
- Capture w/h is **always `template.manifest.size`** (sprite applies scale), so the host render size is constant per motif id → set-metrics-once is a pure win.
- Status surface today: `templateBakeStatusStore` (`{phase:"baking"|"ready"|"error", done, total}` per layerId), written by `Compositor.recomputeBakeStatuses` from the **baker** only; surfaced by `TemplateBakeDot` (Timeline.tsx) + `BakeStatusLine` (PropertyPanel.tsx). Idle = absent.

Run the full baseline green before starting:

```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```

Expected: all green (matches the last merged state on `main`).

---

## Task 1: Serialize captures + trim the warm-frame round-trips (Rust)

**Why first:** serialization is a correctness prerequisite. Once Task 2 makes the baker hit CDP, three loops fire concurrent `motif_capture_frame` calls; without serialization they interleave on the one host and screenshot the wrong vclock. Folding in set-metrics-once and skip-ready-probe-when-warm here is free — they share the same per-host state and critical section.

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/mod.rs` (add `MotifCapture` managed state + pure decision helpers + unit tests)
- Modify: `apps/desktop/src-tauri/src/motifs/host.rs:40-83` (`ensure_host` returns `(WebviewWindow, bool created)`)
- Modify: `apps/desktop/src-tauri/src/motifs/cdp.rs:67-179` (`capture_png_base64` + `issue_capture_calls` gain `set_metrics: bool`)
- Modify: `apps/desktop/src-tauri/src/motifs/commands.rs:34-120` (acquire lock; conditional probe + metrics)
- Modify: `apps/desktop/src-tauri/src/lib.rs:168` (`.manage`) and `:423-437` (smoke macro passes the new state)

- [ ] **Step 1: Write the failing helper tests in `mod.rs`**

Append to `apps/desktop/src-tauri/src/motifs/mod.rs`:

```rust
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
```

- [ ] **Step 2: Run the helper tests — expect FAIL (compile errors: items not yet defined elsewhere are fine; these tests should compile and pass once the block above is added). First run to confirm they pass in isolation:**

```
cd apps/desktop/src-tauri && cargo test -p weftcut capture_state_tests
```

Expected: 3 passed. (If the crate name differs, run `cargo test capture_state_tests`.)

- [ ] **Step 3: Make `ensure_host` report whether it created the window**

In `apps/desktop/src-tauri/src/motifs/host.rs`, change the signature and both return sites:

```rust
pub fn ensure_host(
    app: &AppHandle,
    runtime: &str,
    motif_id: &str,
    width: u32,
    height: u32,
) -> tauri::Result<(WebviewWindow, bool)> {
    if let Some(win) = app.get_webview_window(HOST_LABEL) {
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

    let url = format!("{SCHEME_ORIGIN}/{motif_id}/index.html");
    let parsed = url.parse().map_err(tauri::Error::InvalidUrl)?;

    let win = WebviewWindowBuilder::new(app, HOST_LABEL, WebviewUrl::CustomProtocol(parsed))
        .title("motif-host")
        .inner_size(width as f64, height as f64)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .initialization_script(runtime)
        .build()?;
    Ok((win, true))
}
```

(The block comment above the builder stays as-is.)

- [ ] **Step 4: Make `capture_png_base64` skip the metrics call on warm frames**

In `apps/desktop/src-tauri/src/motifs/cdp.rs`, thread a `set_metrics` bool:

```rust
pub async fn capture_png_base64(
    window: &WebviewWindow,
    w: u32,
    h: u32,
    set_metrics: bool,
) -> anyhow::Result<String> {
    let (tx, rx) = oneshot::channel::<Result<String, String>>();

    window
        .with_webview(move |pw| unsafe {
            issue_capture_calls(pw, w, h, set_metrics, tx);
        })
        .context("with_webview failed (could not reach the WebView2 UI thread)")?;

    // (timeout/match block unchanged)
    match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
        Ok(Ok(Ok(b64))) => Ok(b64),
        Ok(Ok(Err(msg))) => Err(anyhow!("CDP capture failed: {msg}")),
        Ok(Err(_recv_err)) => Err(anyhow!(
            "CDP capture channel closed before a result was sent"
        )),
        Err(_elapsed) => Err(anyhow!(
            "CDP capture timed out after {:?} (screenshot completion handler never fired)",
            CAPTURE_TIMEOUT
        )),
    }
}
```

And in `issue_capture_calls`, add the param and guard the metrics call:

```rust
unsafe fn issue_capture_calls(
    pw: tauri::webview::PlatformWebview,
    w: u32,
    h: u32,
    set_metrics: bool,
    tx: oneshot::Sender<Result<String, String>>,
) {
    let core = match pw.controller().CoreWebView2() {
        Ok(core) => core,
        Err(e) => {
            let _ = tx.send(Err(format!("CoreWebView2() failed: {e}")));
            return;
        }
    };

    // 1) Set the render resolution — ONLY when it changed (constant per motif,
    //    so this fires once per host then never again). CDP applies commands in
    //    order on the session, so a metrics call here still precedes the shot.
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

    // 2) Capture (unchanged from here down).
    let tx_slot = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
    let tx_for_handler = std::rc::Rc::clone(&tx_slot);
    let screenshot_handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |hr: windows::core::Result<()>, json: String| {
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
        if let Some(tx) = tx_slot.borrow_mut().take() {
            let _ = tx.send(Err(format!(
                "CallDevToolsProtocolMethod(captureScreenshot) failed: {e}"
            )));
        }
    }
}
```

- [ ] **Step 5: Acquire the lock and apply the conditional probe + metrics in the command**

In `apps/desktop/src-tauri/src/motifs/commands.rs`, update the signature and body. Add the state param and replace lines 44–119:

```rust
#[tauri::command]
pub async fn motif_capture_frame(
    app: AppHandle,
    state: State<'_, MotifRuntime>,
    capture: State<'_, super::MotifCapture>,
    motif_id: String,
    t_sec: f64,
    props_json: String,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let runtime = state
        .get()
        .ok_or_else(|| "motif runtime not registered yet (call motif_register_runtime)".to_string())?;

    // Serialize the WHOLE render + capture. Held across every await so concurrent
    // captures (on-demand sprite, prewarmer, baker) can't interleave on the one
    // host and screenshot a stale vclock. Also guards the per-host CaptureState.
    let mut cap = capture.0.lock().await;

    let (win, created) = host::ensure_host(&app, &runtime, &motif_id, width, height)
        .map_err(|e| format!("ensure_host failed: {e}"))?;
    if created {
        cap.reset();
    }

    // Ready-probe only when this host isn't already confirmed ready for this id.
    if super::should_probe(cap.ready_for.as_deref(), &motif_id) {
        let ready_probe = "if(!(typeof window.__motifRender==='function'\
            &&document.readyState==='complete'))throw new Error('motif-not-ready');true";
        let mut last_err = None;
        let mut ready = false;
        for _ in 0..READY_ATTEMPTS {
            match cdp::eval_await(&win, ready_probe).await {
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

    let props: serde_json::Value = serde_json::from_str(&props_json)
        .map_err(|e| format!("props_json is not valid JSON: {e}"))?;

    let duration = props
        .get("seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(5.0);
    let meta = serde_json::json!({
        "duration": duration,
        "width": width,
        "height": height,
        "fps": 30,
    });

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
```

Keep the existing `READY_ATTEMPTS`/`READY_POLL` consts and the module doc comment (update the doc's numbered flow to mention "skipped when warm" for the probe/metrics if you wish — non-functional).

- [ ] **Step 6: Manage the state and fix the smoke macro in `lib.rs`**

After line 168 (`app.manage(motifs::MotifRuntime::new());`) add:

```rust
            // Serializes Motif captures + caches per-host metrics/ready state.
            app.manage(motifs::MotifCapture::new());
```

In the `#[cfg(all(windows, debug_assertions))]` smoke block, update the `capture!` macro (around lines 423–437) to fetch and pass the new state:

```rust
                        macro_rules! capture {
                            ($t:expr) => {{
                                let s2 = app_for_smoke.state::<motifs::MotifRuntime>();
                                let c2 = app_for_smoke.state::<motifs::MotifCapture>();
                                motifs::commands::motif_capture_frame(
                                    app_for_smoke.clone(),
                                    s2,
                                    c2,
                                    "countdown".to_string(),
                                    $t,
                                    props.to_string(),
                                    480,
                                    480,
                                )
                                .await
                            }};
                        }
```

- [ ] **Step 7: Compile + run the full Rust test suite**

```
cd apps/desktop/src-tauri && cargo test
```

Expected: all pass (including `capture_state_tests`, the existing `cdp::tests`, and `builtin::tests`). Fix any signature-mismatch compile errors surfaced by the `capture_png_base64` / `ensure_host` callers.

- [ ] **Step 8: Real-WebView2 determinism re-check (the serialization + skip-probe must not change pixels)**

```
cd apps/desktop/src-tauri && set WEFTCUT_MOTIF_SMOKE=1 && cargo run
```

(PowerShell: `$env:WEFTCUT_MOTIF_SMOKE=1; cargo run`.) Watch stdout for `[MOTIF-CONF]` lines. Expected: **Determinism PASS** (two t=2.5 captures byte-identical), **Advance PASS**, **Known-frame PASS**. This proves warm captures (2nd+ frame skips probe + metrics) are pixel-identical to cold. Stop the app after the lines print.

- [ ] **Step 9: Commit**

```
git add apps/desktop/src-tauri/src/motifs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): serialize CDP captures + skip warm-frame probe & set-metrics (Stage 3)"
```

---

## Task 2: Redirect the L2 persist baker SVG→CDP + tune fill cadence (TS)

**Why:** the preview-time L2 baker (`TemplateBaker`, the on-disk PNG writer) still rasters via `rasterTemplateFrame` (SVG). It must write the **same CDP frames** the rest of the pipeline produces, or a baked layer would load SVG pixels that differ from the live CDP capture. Also drop the filler batch sizes to 1 so an on-demand scrub isn't stuck behind a 2–3-deep prewarm/bake batch in the now-serialized Rust queue.

**Files:**
- Modify: `apps/desktop/src/render/motifs/motifRaster.ts` (add `bakeMotifFrame` content-frame helper)
- Test: `apps/desktop/src/render/motifs/__tests__/motifRaster.test.ts`
- Modify: `apps/desktop/src/render/Compositor.ts:278-287` & `:289-308` (batchSize: 1) and `:1072-1073` (baker render closure → CDP)

- [ ] **Step 1: Write the failing test for `bakeMotifFrame`**

Append to `apps/desktop/src/render/motifs/__tests__/motifRaster.test.ts` (it already mocks `../host`):

```ts
import { bakeMotifFrame } from "../motifRaster";

describe("bakeMotifFrame", () => {
  it("captures an arbitrary content frame at the manifest size, no disk read", async () => {
    const template = { manifest: { id: "countdown", size: [480, 480] } } as unknown as Parameters<
      typeof bakeMotifFrame
    >[0];
    // frame 9 at 30fps → tSec = 9 * 1/30 = 0.3
    await bakeMotifFrame(template, 9, 30, 1, { seconds: 5 });
    expect(captureMotifFrame).toHaveBeenCalledWith("countdown", 0.3, { seconds: 5 }, 480, 480);
  });
});
```

(Check the file's existing import of the mocked `captureMotifFrame`; reuse it. If the top of the file doesn't already `import { captureMotifFrame } from "../host";` under the mock, add it.)

- [ ] **Step 2: Run it — expect FAIL (`bakeMotifFrame` not exported)**

```
cd apps/desktop && npx vitest run src/render/motifs/__tests__/motifRaster.test.ts
```

Expected: FAIL — `bakeMotifFrame is not a function` / import error.

- [ ] **Step 3: Implement `bakeMotifFrame`**

Append to `apps/desktop/src/render/motifs/motifRaster.ts`:

```ts
import type { Template } from "../templates/catalog";

/// Capture one ARBITRARY content frame of a Motif directly via CDP, at the
/// motif's manifest size. The baker is the sole L2 writer and already gates on
/// `isOnDisk`, so it must NOT read disk-first (that's `resolveTemplateFrame`'s
/// job for the read paths) — it always captures. `tSec = frame * fpsDen/fpsNum`.
export function bakeMotifFrame(
  template: Template,
  frame: number,
  fpsNum: number,
  fpsDen: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  const [w, h] = template.manifest.size;
  return rasterMotifFrame(template.manifest.id, (frame * fpsDen) / fpsNum, canonicalProps, w!, h!);
}
```

- [ ] **Step 4: Run it — expect PASS**

```
cd apps/desktop && npx vitest run src/render/motifs/__tests__/motifRaster.test.ts
```

Expected: PASS.

- [ ] **Step 5: Point the baker closure at CDP and set batchSize: 1**

In `apps/desktop/src/render/Compositor.ts`:

(a) Add the import near the existing motif imports (the file already imports `rasterTemplateFrame`/`resolveTemplateFrame` from `./templates/templateRaster`):

```ts
import { bakeMotifFrame } from "./motifs/motifRaster";
```

(b) In the `TemplatePrewarmer` instantiation (around line 278) add `batchSize: 1,` to the deps object; in the `TemplateBaker` instantiation (around line 291) add `batchSize: 1,` to its deps object. Rationale comment to add above each:

```ts
          // batchSize 1: captures now serialize in Rust, so a larger batch only
          // adds head-of-line latency for an on-demand scrub. One in-flight
          // capture per loop keeps the shared host queue short.
```

(c) Replace the baker render closure (lines 1072–1073):

```ts
          render: (frame: number) => bakeMotifFrame(template, frame, fpsNum, fpsDen, canonicalProps),
```

and update the closure-comment two lines above (1071) from "`rasterTemplateFrame`" to "`bakeMotifFrame` (CDP capture, no disk read)". `durationSec` is now unused in this closure — leave the `desc.durationSec` local in place (the prewarmer closure still uses it) but it is no longer referenced by the baker closure; that is fine.

- [ ] **Step 6: Typecheck + unit suite**

```
cd apps/desktop && npm run typecheck && npm test
```

Expected: green. (No test references the baker's internal SVG path; the existing `TemplateBaker.test.ts` injects its own `render`.)

- [ ] **Step 7: Commit**

```
git add apps/desktop/src/render/motifs/motifRaster.ts apps/desktop/src/render/motifs/__tests__/motifRaster.test.ts apps/desktop/src/render/Compositor.ts
git commit -m "feat(motifs): L2 baker captures via CDP; fillers batchSize 1 (Stage 3)"
```

---

## Task 3: Tunable settle — single-rAF for CSS-only Motifs (runtime + Rust + manifest)

**Why:** `__motifRender`'s double-rAF settle is ~33 ms of the ~92 ms/frame. A CSS/system-font Motif (the `countdown` built-in) is visually committed after one rAF following the forced reflow `seek()` already does. Exposing a per-motif `settle_rafs` (default 2 = safe; canvas/WebGL keep it) lets `countdown` use 1, lifting fill rate ~13 fps. This is a fill-rate optimization (spec §3) — gate it behind a byte-identity check.

**Files:**
- Modify: `apps/desktop/src/render/motifs/runtime.ts` (`__motifRender` reads `meta.settleRafs`)
- Test: `apps/desktop/src/render/motifs/__tests__/runtime.test.ts`
- Modify: `apps/desktop/src/render/motifs/host.ts` (`captureMotifFrame` optional `settleRafs`)
- Modify: `apps/desktop/src/render/motifs/motifRaster.ts` (thread `settleRafs` through `rasterMotifFrame` + `bakeMotifFrame`)
- Modify: `apps/desktop/src/render/templates/templateRaster.ts` (`resolveTemplateFrame` passes `template.manifest.settle_rafs`)
- Modify: `apps/desktop/src/render/templates/catalog.ts` (`TemplateManifest.settle_rafs?: number`)
- Modify: `apps/desktop/src/render/templates/builtin/countdown/manifest.json` (`"settle_rafs": 1`)
- Modify: `apps/desktop/src-tauri/src/motifs/commands.rs` (`settle_rafs: Option<u32>` param → `meta.settleRafs`)
- Modify: `apps/desktop/src/render/Compositor.ts` (prewarm + bake closures pass the manifest value; on-demand path flows through `resolveTemplateFrame`)

- [ ] **Step 1: Write the failing runtime test**

The runtime factory is unit-testable via `createMotifRuntime`, but `__motifRender` lives only in the `MOTIF_RUNTIME_SOURCE` string. Add a focused test that the SOURCE string honors `meta.settleRafs` by asserting the source no longer hard-codes the double-rAF and references `settleRafs`. Append to `apps/desktop/src/render/motifs/__tests__/runtime.test.ts`:

```ts
import { MOTIF_RUNTIME_SOURCE } from "../runtime";

describe("MOTIF_RUNTIME_SOURCE settle", () => {
  it("reads settleRafs from meta with a default of 2", () => {
    // The source must reference meta.settleRafs and default to 2 (double-rAF).
    expect(MOTIF_RUNTIME_SOURCE).toContain("meta.settleRafs");
    expect(MOTIF_RUNTIME_SOURCE).toContain("=== 2 ? 2 :"); // the clamp expression below
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```
cd apps/desktop && npx vitest run src/render/motifs/__tests__/runtime.test.ts
```

Expected: FAIL (string not present yet).

- [ ] **Step 3: Make the settle tunable in `runtime.ts`**

In `MOTIF_RUNTIME_SOURCE`, replace the settle line inside `__motifRender` (currently):

```js
      rt.seek(t * 1000);
      await new Promise(function (r) { _nativeRaf(function () { _nativeRaf(r); }); });
      return true;
```

with:

```js
      rt.seek(t * 1000);
      // settleRafs: how many real browser frames to wait so the paint commits.
      // 2 (default) is safe for canvas/WebGL; 1 suffices for CSS-only Motifs;
      // 0 captures immediately after seek(). Clamp to {0,1,2}; default 2.
      var sr = meta && typeof meta.settleRafs === 'number' ? meta.settleRafs : 2;
      sr = sr === 2 ? 2 : (sr === 1 ? 1 : (sr === 0 ? 0 : 2));
      if (sr === 2) {
        await new Promise(function (r) { _nativeRaf(function () { _nativeRaf(r); }); });
      } else if (sr === 1) {
        await new Promise(function (r) { _nativeRaf(r); });
      }
      return true;
```

(No raw backticks added — the literal stays `String.raw` safe per `feedback_string_raw_backticks`.)

- [ ] **Step 4: Run — expect PASS**

```
cd apps/desktop && npx vitest run src/render/motifs/__tests__/runtime.test.ts
```

Expected: PASS (and the existing `createMotifRuntime` tests still pass).

- [ ] **Step 5: Thread `settleRafs` through the TS capture chain**

`apps/desktop/src/render/motifs/host.ts` — add the optional arg and forward it:

```ts
export async function captureMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<ImageBitmap> {
  const b64: string = await invoke("motif_capture_frame", {
    motifId,
    tSec,
    propsJson: JSON.stringify(props),
    width,
    height,
    settleRafs: settleRafs ?? null,
  });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}
```

`apps/desktop/src/render/motifs/motifRaster.ts` — add `settleRafs?` to both functions:

```ts
export async function rasterMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
): Promise<ImageBitmap> {
  if (typeof window !== "undefined") {
    const perf = (window as unknown as { __weftcutTemplatePerf?: { renders: number } })
      .__weftcutTemplatePerf;
    if (perf) perf.renders++;
  }
  return captureMotifFrame(motifId, tSec, props, width, height, settleRafs);
}
```

```ts
export function bakeMotifFrame(
  template: Template,
  frame: number,
  fpsNum: number,
  fpsDen: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  const [w, h] = template.manifest.size;
  return rasterMotifFrame(
    template.manifest.id,
    (frame * fpsDen) / fpsNum,
    canonicalProps,
    w!,
    h!,
    template.manifest.settle_rafs,
  );
}
```

`apps/desktop/src/render/templates/templateRaster.ts` — `resolveTemplateFrame`'s final line:

```ts
  return rasterMotifFrame(template.manifest.id, tSec, canonicalProps, w!, h!, template.manifest.settle_rafs);
```

- [ ] **Step 6: Add the manifest field + set countdown to 1**

`apps/desktop/src/render/templates/catalog.ts` — add to `TemplateManifest` (after `engine?`):

```ts
  /// How many real browser frames `__motifRender` waits before capture.
  /// 2 (default, omitted) is safe for canvas/WebGL Motifs; CSS-only Motifs can
  /// set 1 to shave ~16 ms/frame. Clamped to {0,1,2} by the runtime.
  settle_rafs?: number;
```

`apps/desktop/src/render/templates/builtin/countdown/manifest.json` — add `"settle_rafs": 1,` (e.g. after `"engine": "svg",`).

- [ ] **Step 7: Accept + forward `settle_rafs` in the Rust command**

In `apps/desktop/src-tauri/src/motifs/commands.rs`, add the param (after `height: u32,`):

```rust
    settle_rafs: Option<u32>,
```

and include it in the `meta` JSON:

```rust
    let meta = serde_json::json!({
        "duration": duration,
        "width": width,
        "height": height,
        "fps": 30,
        "settleRafs": settle_rafs,
    });
```

(A `null` `settleRafs` → the runtime's `typeof meta.settleRafs === 'number'` is false → default 2. Update the smoke `capture!` macro to pass `None` for the new arg.)

- [ ] **Step 8: Compositor closures pass the manifest value**

In `apps/desktop/src/render/Compositor.ts`, the prewarm closure calls `resolveTemplateFrame` (which now reads `template.manifest.settle_rafs` itself — no change needed there). The bake closure calls `bakeMotifFrame` (reads it internally — no change). So **no Compositor edit is required for settle** beyond Task 2; confirm by re-reading the two closures.

- [ ] **Step 9: Typecheck, unit suite, Rust suite**

```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```

Expected: all green.

- [ ] **Step 10: Byte-identity gate in real WebView2 (single-rAF must equal double-rAF for countdown)**

Temporarily verify `countdown` at `settle_rafs: 1` is pixel-identical to `settle_rafs: 2`. Quickest path: run the smoke (`WEFTCUT_MOTIF_SMOKE=1 cargo run`) — Determinism PASS confirms reproducibility at the *active* settle. Then flip the manifest to `2`, rebuild, re-run, and confirm the **same blake3 hash** is printed for the t=2.5 capture across both settings (the smoke prints the hashes). If they differ, `countdown` needs `settle_rafs: 2` — revert the manifest to 2 (or omit), keep the plumbing (still valuable for future canvas Motifs), and note it.

- [ ] **Step 11: Commit**

```
git add apps/desktop/src/render/motifs apps/desktop/src/render/templates/catalog.ts apps/desktop/src/render/templates/builtin/countdown/manifest.json apps/desktop/src/render/templates/templateRaster.ts apps/desktop/src-tauri/src/motifs/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): per-motif tunable settle (meta.settleRafs); countdown single-rAF (Stage 3)"
```

---

## Task 4: Warming UX — live L0-coverage status + green bar + first-frame placeholder

**Why:** the capture is slow enough that without a warming signal the preview reads as broken. Surface, per Motif layer, how much of its content is warm in the in-RAM cache (the AE green-bar), and stop a first-ever-cold Motif from flashing nothing.

**Design decision (recommended — confirm at plan review):** drive the indicator from **L0 cache coverage over the layer's content frames**, computed in the Compositor and published through the *existing* status store (extended with a `"warming"` phase). This is filler-agnostic (counts whatever the prewarmer / baker / on-demand path filled), needs no per-frame disk I/O, and reuses the dot + panel surfaces. The existing **bake** status keeps precedence when prebake is active (it means "persisted to disk", a stronger guarantee). Known limitation to document: L0 is a 240-frame LRU, so layers/sets whose content exceeds the cap show <100% — honest ("not fully warm in RAM"); durable full coverage is the L2/bake path. The prewarmer gains a tiny `onProgress` hook so coverage updates live while paused (cache fills don't otherwise trigger a recompute).

**Files:**
- Modify: `apps/desktop/src/render/templates/TemplatePrewarmer.ts` (+`onProgress` dep, fired per batch)
- Test: `apps/desktop/src/render/templates/TemplatePrewarmer.test.ts`
- Modify: `apps/desktop/src/timeline/templateBakeStatusStore.ts` (`"warming"` phase + a pure phase/coverage helper)
- Test: `apps/desktop/src/timeline/templateBakeStatusStore.test.ts`
- Modify: `apps/desktop/src/render/Compositor.ts` (`recomputeBakeStatuses` folds in L0 coverage; prewarmer `onProgress` → recompute)
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts` (warming strings)
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (`TemplateBakeDot` warming label + coverage title)
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`BakeStatusLine` warming text)
- Modify: `apps/desktop/src/styles.css` (`.template-bake-dot.is-warming`, optional span coverage bar)
- Modify: `apps/desktop/src/render/sprite/MotifSprite.ts` (neutral placeholder for first-ever-cold)
- Test: a placeholder unit assertion is impractical (Pixi/DOM); verify via the manual run in Step 11.

- [ ] **Step 1: Prewarmer `onProgress` — failing test**

Add to `apps/desktop/src/render/templates/TemplatePrewarmer.test.ts` a test that `onProgress` fires after a drained batch (mirror the existing manual-`schedule` test harness in that file):

```ts
it("calls onProgress after draining a batch", async () => {
  const onProgress = vi.fn();
  let scheduled: (() => void) | null = null;
  const prewarmer = new TemplatePrewarmer({
    cap: 10,
    hasFrame: () => false,
    setFrame: () => {},
    schedule: (cb) => { scheduled = cb; return 1; },
    cancel: () => {},
    onProgress,
    batchSize: 1,
  });
  prewarmer.setTargets([
    { cacheKey: "a", contentFrame: 0, contentDurationFrames: 2, render: async () => makeFakeBitmap() },
  ]);
  scheduled!();              // run the armed idle callback
  await Promise.resolve();   // let drainBatch's Promise.all settle
  await Promise.resolve();
  expect(onProgress).toHaveBeenCalled();
});
```

(Reuse the file's existing `makeFakeBitmap` helper; if absent, copy the one in `TemplateBaker.test.ts`.)

- [ ] **Step 2: Run — expect FAIL (`onProgress` not in deps)**

```
cd apps/desktop && npx vitest run src/render/templates/TemplatePrewarmer.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add `onProgress` to the prewarmer**

In `apps/desktop/src/render/templates/TemplatePrewarmer.ts`, add to `TemplatePrewarmerDeps`:

```ts
  /// Fired after each drained batch so a watcher can recompute cache coverage
  /// (the prewarmer doesn't own status — the Compositor reads L0 coverage).
  /// Never throws. Optional so existing callers/tests don't need it.
  onProgress?: () => void;
```

and at the end of `drainBatch`'s `finally` block, after `this.running = false;` and before `this.arm();` add:

```ts
      this.deps.onProgress?.();
```

- [ ] **Step 4: Run — expect PASS**

```
cd apps/desktop && npx vitest run src/render/templates/TemplatePrewarmer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Extend the status store — `"warming"` phase + a pure helper (failing test)**

Add to `apps/desktop/src/timeline/templateBakeStatusStore.test.ts`:

```ts
import { motifWarmPhase } from "./templateBakeStatusStore";

describe("motifWarmPhase", () => {
  it("prefers a live bake status when present", () => {
    expect(motifWarmPhase({ phase: "baking", done: 1, total: 3 }, 3, 3)).toEqual({ phase: "baking", done: 1, total: 3 });
    expect(motifWarmPhase({ phase: "error", done: 0, total: 3 }, 2, 3)).toEqual({ phase: "error", done: 0, total: 3 });
  });
  it("falls back to L0 coverage when no bake status", () => {
    expect(motifWarmPhase(null, 0, 5)).toBe(null);                                  // idle → omit
    expect(motifWarmPhase(null, 2, 5)).toEqual({ phase: "warming", done: 2, total: 5 });
    expect(motifWarmPhase(null, 5, 5)).toEqual({ phase: "ready", done: 5, total: 5 });
  });
  it("treats a baked-on-disk key with cold L0 as ready", () => {
    expect(motifWarmPhase(null, 0, 5, /* bakedOnDisk */ true)).toEqual({ phase: "ready", done: 5, total: 5 });
  });
});
```

- [ ] **Step 6: Run — expect FAIL**

```
cd apps/desktop && npx vitest run src/timeline/templateBakeStatusStore.test.ts
```

Expected: FAIL (`motifWarmPhase` undefined; `"warming"` not in the phase union).

- [ ] **Step 7: Implement the phase union + helper**

In `apps/desktop/src/timeline/templateBakeStatusStore.ts`, widen the phase union and add the pure helper:

```ts
export interface LayerBakeStatus {
  phase: "warming" | "baking" | "ready" | "error";
  done: number;
  total: number;
}
```

```ts
/// Reduce a layer's (optional live bake status, L0 coverage, baked-on-disk flag)
/// to the single status the timeline/panel shows. Bake takes precedence (it is
/// the stronger "persisted to disk" guarantee). Otherwise L0 coverage drives a
/// `warming`→`ready` bar; zero coverage with nothing on disk is idle (null).
export function motifWarmPhase(
  bake: LayerBakeStatus | null,
  covered: number,
  total: number,
  bakedOnDisk = false,
): LayerBakeStatus | null {
  if (bake) return bake;
  if (covered >= total && total > 0) return { phase: "ready", done: total, total };
  if (covered > 0) return { phase: "warming", done: covered, total };
  if (bakedOnDisk) return { phase: "ready", done: total, total };
  return null;
}
```

- [ ] **Step 8: Run — expect PASS**

```
cd apps/desktop && npx vitest run src/timeline/templateBakeStatusStore.test.ts
```

Expected: PASS.

- [ ] **Step 9: Wire coverage + onProgress into the Compositor**

In `apps/desktop/src/render/Compositor.ts`:

(a) Import the helper alongside the existing store import:

```ts
import {
  setLayerBakeStatuses,
  motifWarmPhase,
  type LayerBakeStatus,
} from "../timeline/templateBakeStatusStore";
```

(b) Add `onProgress` to the `TemplatePrewarmer` deps (the instantiation around line 278):

```ts
          onProgress: () => this.recomputeBakeStatuses(),
```

(c) In `recomputeBakeStatuses` (around line 1132), replace the per-layer body so it folds in L0 coverage. The current loop sets `byLayer[layer.id]` from `live` bake status else `sharedBakedKeyIndex.has`. Replace that inner logic with:

```ts
        const live = this.bakeStatusByCacheKey.get(desc.cacheKey);
        // L0 coverage of this layer's content frames (cheap Map lookups; the
        // cache `hasFrame` doesn't touch recency). This is the "is preview warm"
        // signal that drives the green bar.
        let covered = 0;
        for (let f = 0; f < desc.contentDurationFrames; f++) {
          if (sharedTemplateFrameCache.hasFrame(desc.cacheKey, f)) covered++;
        }
        const status = motifWarmPhase(
          live ?? null,
          covered,
          desc.contentDurationFrames,
          sharedBakedKeyIndex.has(desc.cacheKey),
        );
        if (status) byLayer[layer.id] = status;
```

(`sharedTemplateFrameCache` and `sharedBakedKeyIndex` are already imported in Compositor.ts — they back the prewarmer/baker deps.)

- [ ] **Step 10: i18n + UI surfaces**

`apps/desktop/src/i18n/locales/en-US.ts` — under the timeline block (near `bake_dot_*`) add:

```ts
    bake_dot_warming: "Warming…",
```

and under the property_panel block (near `bake_*`) add:

```ts
    bake_warming: "Warming preview… {{done}}/{{total}}",
```

Mirror both in `apps/desktop/src/i18n/locales/zh-CN.ts` (keep the "Motif" brand noun per existing zh-CN convention), e.g. `bake_dot_warming: "预热中…"`, `bake_warming: "预热预览… {{done}}/{{total}}"`.

`apps/desktop/src/timeline/Timeline.tsx` — extend `TemplateBakeDot` (around line 1213) to handle the new phase:

```tsx
  const label =
    phase === "warming"
      ? t("timeline.bake_dot_warming", { defaultValue: "Warming…" })
      : phase === "baking"
        ? t("timeline.bake_dot_baking", { defaultValue: "Pre-baking…" })
        : phase === "ready"
          ? t("timeline.bake_dot_ready", { defaultValue: "Pre-baked" })
          : t("timeline.bake_dot_error", { defaultValue: "Pre-bake failed" });
```

`apps/desktop/src/properties/PropertyPanel.tsx` — extend `BakeStatusLine` (around line 580):

```tsx
  const text = !status
    ? t("property_panel.bake_idle")
    : status.phase === "warming"
      ? t("property_panel.bake_warming", { done: status.done, total: status.total })
      : status.phase === "baking"
        ? t("property_panel.bake_baking", { done: status.done, total: status.total })
        : status.phase === "ready"
          ? t("property_panel.bake_ready", { total: status.total })
          : t("property_panel.bake_error");
```

`apps/desktop/src/styles.css` — add a warming variant next to the existing `.template-bake-dot.is-*` / `.prop-bake-status.is-*` rules (find them and mirror the baking color, e.g. an amber):

```css
.template-bake-dot.is-warming { background: #f0a020; }
.prop-bake-status.is-warming { color: #f0a020; }
```

- [ ] **Step 11: Neutral placeholder for first-ever-cold in `MotifSprite`**

In `apps/desktop/src/render/sprite/MotifSprite.ts`, hold a neutral placeholder until the first real frame binds (the "hold last bitmap" half of spec §5 is already satisfied — `update` never clears the texture on a miss). Add a `private boundOnce = false;` field, set it `true` inside `bindBitmap`, and in `update`'s preview miss branch (right before `void this.captureAndBind(...)` at line 162) insert:

```ts
    if (!this.boundOnce && this.texture === null && typeof document !== "undefined") {
      this.bindBitmap(neutralPlaceholderBitmap());
    }
```

Add a module-level lazily-built neutral bitmap (preview-only; DOM-guarded) near the top of the file:

```ts
// A faint neutral tile shown while a first-ever-cold Motif's frame 0 is still
// in flight, so the layer reads as "warming" rather than vanishing. Built once
// from a 2×2 canvas (preview only — the export Worker never hits this path).
let _placeholder: ImageBitmap | null = null;
function neutralPlaceholderBitmap(): ImageBitmap {
  if (_placeholder) return _placeholder;
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(128,128,128,0.18)";
  ctx.fillRect(0, 0, 2, 2);
  // transferToImageBitmap isn't on a 2D canvas; use the canvas as the source.
  _placeholder = c as unknown as ImageBitmap;
  return _placeholder;
}
```

NOTE: `bindBitmap` builds an `ImageSource` from the given resource; an `HTMLCanvasElement` is a valid Pixi `ImageSource` resource, so passing the canvas works without `createImageBitmap` (sync). Set `this.boundOnce = true;` at the end of `bindBitmap`. (If the canvas-as-`ImageBitmap` cast trips typecheck, widen `bindBitmap`'s param to `ImageBitmap | HTMLCanvasElement`.)

- [ ] **Step 12: Typecheck + full unit suite**

```
cd apps/desktop && npm run typecheck && npm test
```

Expected: green.

- [ ] **Step 13: Manual real-app verification (the actual payoff)**

```
cd apps/desktop && npm run tauri:dev
```

Add a `countdown` Motif to the timeline (via the picker or the MCP bridge). Verify: a **Warming…** dot appears and the property panel shows **Warming preview… N/total** climbing; after the prewarmer fills, it flips to **Ready**; scrubbing within the warmed span is smooth; a freshly added Motif shows the faint placeholder (not a blank flash) before frame 0. If the dev MCP bridge is up, drive it per `reference_weftcut_second_dev_instance` (`webview_execute_js`).

- [ ] **Step 14: Commit**

```
git add apps/desktop/src/render/templates/TemplatePrewarmer.ts apps/desktop/src/render/templates/TemplatePrewarmer.test.ts apps/desktop/src/timeline/templateBakeStatusStore.ts apps/desktop/src/timeline/templateBakeStatusStore.test.ts apps/desktop/src/render/Compositor.ts apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts apps/desktop/src/timeline/Timeline.tsx apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/styles.css apps/desktop/src/render/sprite/MotifSprite.ts
git commit -m "feat(motifs): warming-coverage status (green bar) + first-frame placeholder (Stage 3)"
```

---

## Completion

After all four tasks: use **superpowers:finishing-a-development-branch** to verify the full suite, then present merge/PR/cleanup options.

Final verification gate:

```
cd apps/desktop && npm run typecheck && npm test
cd apps/desktop/src-tauri && cargo test
```

…plus the two real-WebView2 checks (Task 1 Step 8 smoke determinism; Task 4 Step 13 manual warming). The existing `apps/desktop/e2e/specs/motif_live_preview.e2e.js` should still pass (the on-demand live path is unchanged in shape).

**Update memory** (`project_template_webview_engine.md` + `MEMORY.md` hook) on completion: Stage 3 done; remaining = Stage 4 (export baker → CDP) and Stage 5 (delete SVG machinery + unify catalogs + rename deferred internals), then Plan 4 (upload security).

---

## Self-review notes (author)

- **Spec coverage:** §3 throughput-opts → Task 1 (set-metrics-once, skip-probe) + Task 3 (tunable settle); §4 cache/prewarm/persist → Task 2 (baker→CDP; prewarmer was already CDP via Stage 2) + Task 4 (coverage uses the existing L0 cache); §5 warming UX → Task 4 (status, dot/panel, placeholder, last-bitmap-hold already present); §9 risk "prewarmer tuned for hundreds-fps" → Task 2 batchSize 1 + the Rust serialization that makes any batch size correct. **Added beyond spec:** capture serialization (§9 names the host-lifecycle risk but not the concurrent-interleave correctness bug — surfaced during exploration; it is a prerequisite).
- **Out of scope, deliberately:** export baker (`exportBake.ts`) and the SVG deletion/rename (Stages 4–5); multi-Motif host navigation (one built-in → not needed).
- **Type consistency:** `bakeMotifFrame(template, frame, fpsNum, fpsDen, canonicalProps)` used identically in Task 2/3; `motifWarmPhase(bake, covered, total, bakedOnDisk?)` and the widened `LayerBakeStatus.phase` union used identically in Task 4; Rust `should_probe`/`should_set_metrics`/`CaptureState`/`MotifCapture` consistent across mod/commands/lib.
- **Open decision for review:** the warming signal = L0 coverage with bake-precedence (Task 4 design note). If you'd rather the green bar reflect L2/disk persistence instead of RAM warmth, that's a different `motifWarmPhase` reduction — flag at review.
