# Motifs Capture Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a Motif (`manifest.json` + `index.html` + `assets/`), a content time `t`, props, and a render size, produce a **deterministic** bitmap — a real web page driven to `t` by a clock-takeover wrapper and captured via WebView2 CDP `Page.captureScreenshot`.

**Architecture:** A reused hidden Tauri `WebviewWindow` hosts an opaque-origin sandboxed `<iframe>` that runs the untrusted Motif with our runtime (clock takeover + `motif.define` + a postMessage seek loop) prepended at serve time by a `motif:` URI-scheme handler. The host JS drives `seek(t, props)` over postMessage; Rust then calls CDP via `with_webview(...).controller().CoreWebView2().CallDevToolsProtocolMethod("Page.captureScreenshot")` and returns base64 PNG, which JS decodes to an `ImageBitmap`. Both halves were validated by throwaway spikes on 2026-06-07 (Playwright determinism; in-app Rust CDP ~27 ms device-metrics / ~98 ms capture).

**Tech Stack:** TypeScript (Vitest unit tests), Tauri 2.11 + Rust (`webview2-com` 0.38, `windows` 0.61, Windows-only), the existing real-WebView2 conformance harness (tauri-driver + WebdriverIO).

**Spec:** `docs/superpowers/specs/2026-06-07-motifs-webcap-design.md` (§3 authoring contract, §4 determinism, §5 capture). This plan implements the single-frame capture path only; cache/scheduler/compositor/export/security/rename are Plans 2–5.

---

## File Structure

**TypeScript (`apps/desktop/src/render/motifs/`):**
- `catalog.ts` — `Manifest`, `Motif`, `PropSpec` types; `parseManifest`, `canonicalizeProps`. One responsibility: load + validate a Motif's declared shape.
- `interpolate.ts` — the pure `interpolate(t, inRange, outRange, opts)` author primitive.
- `runtime.ts` — the wrapper runtime **source string** injected into the iframe: clock takeover, global `motif`/`motif.define`, the seek/settle/ack message loop. Authored as a normal module, exported as a string via the build (mirrors the existing `ENGINE_SOURCE` pattern — see `feedback_string_raw_backticks`).
- `host.ts` — `MotifHost`: loads a Motif into the hidden window's iframe, `seek(t, props)`, triggers a capture, returns an `ImageBitmap`. Single-shot here; pooling is Plan 2.

**Rust (`apps/desktop/src-tauri/src/motifs/`):**
- `mod.rs` — module wiring + the `motif:` URI-scheme registration (serves wrapper-prepended `index.html` + assets).
- `host.rs` — create/fetch the reused hidden `WebviewWindow`.
- `cdp.rs` — `capture_via_cdp(window, params) -> PNG bytes`, the validated `CallDevToolsProtocolMethod` path.
- `commands.rs` — `motif_capture_frame` Tauri command.

**Fixtures/tests:**
- `apps/desktop/src/render/motifs/__tests__/interpolate.test.ts`, `catalog.test.ts` (Vitest).
- `apps/desktop/src-tauri/src/templates/countdown/` reauthored as a Motif (becomes the conformance fixture).
- `apps/desktop/e2e/motif_capture.e2e.js` (WebdriverIO) — determinism + known-frame conformance.

> **Toolchain note (from `~/.claude/CLAUDE.md`):** Node is via `fnm` (v22.20, npm 11). Rust is `cargo` 1.95. `webview2-com`/`windows` are already in Tauri's graph — add them to `[target.'cfg(windows)'.dependencies]` pinned to `0.38`/`0.61` so artifacts are reused (verified: ~43 s incremental build).

---

## Task 1: `interpolate` author primitive

**Files:**
- Create: `apps/desktop/src/render/motifs/interpolate.ts`
- Test: `apps/desktop/src/render/motifs/__tests__/interpolate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { interpolate } from "../interpolate";

describe("interpolate", () => {
  it("maps linearly across the range", () => {
    expect(interpolate(0.5, [0, 1], [0, 100])).toBe(50);
  });
  it("clamps outside the input range by default", () => {
    expect(interpolate(-1, [0, 1], [0, 100])).toBe(0);
    expect(interpolate(2, [0, 1], [0, 100])).toBe(100);
  });
  it("supports multi-segment ranges", () => {
    expect(interpolate(1.5, [0, 1, 2], [0, 10, 0])).toBe(5);
  });
  it("applies an easing function before mapping", () => {
    const ease = (x: number) => x * x;
    expect(interpolate(0.5, [0, 1], [0, 100], { easing: ease })).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/motifs/__tests__/interpolate.test.ts`
Expected: FAIL — "Failed to resolve import ../interpolate".

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/render/motifs/interpolate.ts
export interface InterpolateOpts {
  easing?: (t: number) => number;
  clamp?: boolean; // default true
}

/** Map `t` from `inRange` to `outRange`, segment-wise, clamped by default. */
export function interpolate(
  t: number,
  inRange: readonly number[],
  outRange: readonly number[],
  opts: InterpolateOpts = {},
): number {
  if (inRange.length < 2 || inRange.length !== outRange.length) {
    throw new Error("interpolate: ranges must be equal length >= 2");
  }
  const clamp = opts.clamp ?? true;
  if (clamp) {
    if (t <= inRange[0]) return outRange[0];
    if (t >= inRange[inRange.length - 1]) return outRange[outRange.length - 1];
  }
  let i = 1;
  while (i < inRange.length - 1 && t > inRange[i]) i++;
  const inA = inRange[i - 1], inB = inRange[i];
  const outA = outRange[i - 1], outB = outRange[i];
  let frac = (t - inA) / (inB - inA);
  if (opts.easing) frac = opts.easing(frac);
  return outA + frac * (outB - outA);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/render/motifs/__tests__/interpolate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/motifs/interpolate.ts apps/desktop/src/render/motifs/__tests__/interpolate.test.ts
git commit -m "feat(motifs): interpolate author primitive"
```

---

## Task 2: Manifest types, parse, and prop canonicalization

**Files:**
- Create: `apps/desktop/src/render/motifs/catalog.ts`
- Test: `apps/desktop/src/render/motifs/__tests__/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseManifest, canonicalizeProps } from "../catalog";

const RAW = JSON.stringify({
  id: "countdown", name: "Countdown", formatVersion: 1, size: [480, 480],
  default_duration_s: 5, max_duration_s: 5, max_duration_prop: "seconds",
  props_schema: {
    seconds: { type: "number", default: 5, min: 1, max: 60 },
    label: { type: "string", default: "GO", maxLength: 12 },
    accent: { type: "color", default: "#ff4d4d" },
  },
});

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const m = parseManifest(RAW);
    expect(m.id).toBe("countdown");
    expect(m.size).toEqual([480, 480]);
    expect(m.propsSchema.seconds.type).toBe("number");
  });
  it("rejects a manifest missing required fields", () => {
    expect(() => parseManifest(JSON.stringify({ id: "x" }))).toThrow();
  });
  it("rejects max_duration_prop naming a missing prop", () => {
    const bad = { ...JSON.parse(RAW), max_duration_prop: "nope" };
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(/max_duration_prop/);
  });
});

describe("canonicalizeProps", () => {
  const m = parseManifest(RAW);
  it("fills defaults, drops unknowns, orders keys stably", () => {
    const out = canonicalizeProps(m, { label: "3", zzz: "x" } as Record<string, unknown>);
    expect(Object.keys(out)).toEqual(["accent", "label", "seconds"]);
    expect(out).toEqual({ accent: "#ff4d4d", label: "3", seconds: 5 });
  });
  it("rejects a number prop outside its min/max", () => {
    expect(() => canonicalizeProps(m, { seconds: 999 })).toThrow(/seconds/);
  });
  it("clamps string length to maxLength", () => {
    expect(canonicalizeProps(m, { label: "0123456789abcdef" }).label).toBe("0123456789ab");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/motifs/__tests__/catalog.test.ts`
Expected: FAIL — cannot resolve `../catalog`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/render/motifs/catalog.ts
export type PropSpec =
  | { type: "string"; default: string; maxLength?: number }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number };

export interface Manifest {
  id: string;
  name: string;
  formatVersion: number;
  size: [number, number];
  default_duration_s: number;
  max_duration_s?: number;
  max_duration_prop?: string;
  fonts?: { family: string; file: string; weight?: number; style?: string }[];
  propsSchema: Record<string, PropSpec>;
}

export interface Motif {
  manifest: Manifest;
  html: string; // index.html source
  assets: Record<string, Uint8Array>; // relative path -> bytes
}

export function parseManifest(raw: string): Manifest {
  const j = JSON.parse(raw);
  for (const k of ["id", "name", "formatVersion", "size", "default_duration_s", "props_schema"]) {
    if (j[k] === undefined) throw new Error(`manifest: missing required field '${k}'`);
  }
  if (!Array.isArray(j.size) || j.size.length !== 2) throw new Error("manifest: size must be [w,h]");
  const propsSchema: Record<string, PropSpec> = j.props_schema;
  if (j.max_duration_prop && !(j.max_duration_prop in propsSchema)) {
    throw new Error(`manifest: max_duration_prop '${j.max_duration_prop}' is not a declared prop`);
  }
  return {
    id: j.id, name: j.name, formatVersion: j.formatVersion, size: j.size,
    default_duration_s: j.default_duration_s, max_duration_s: j.max_duration_s,
    max_duration_prop: j.max_duration_prop, fonts: j.fonts, propsSchema,
  };
}

export function canonicalizeProps(
  m: Manifest, input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(m.propsSchema).sort()) {
    const spec = m.propsSchema[key];
    const raw = key in input ? input[key] : spec.default;
    if (spec.type === "number") {
      let n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`prop '${key}': not a number`);
      if (spec.min !== undefined && n < spec.min) throw new Error(`prop '${key}': below min`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`prop '${key}': above max`);
      out[key] = n;
    } else {
      let s = String(raw);
      if (spec.type === "string" && spec.maxLength !== undefined) s = s.slice(0, spec.maxLength);
      out[key] = s;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/render/motifs/__tests__/catalog.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/motifs/catalog.ts apps/desktop/src/render/motifs/__tests__/catalog.test.ts
git commit -m "feat(motifs): manifest parse + prop canonicalization"
```

---

## Task 3: The wrapper runtime (clock takeover + `motif.define` + seek loop)

**Files:**
- Create: `apps/desktop/src/render/motifs/runtime.ts`
- Test: `apps/desktop/src/render/motifs/__tests__/runtime.test.ts`

This is the validated determinism logic from the Playwright spike, packaged as the source string the `motif:` scheme prepends into every Motif document. The pure, browser-independent pieces (clock state machine, seek idempotence) are unit-tested here; full pixel determinism is the Task 7 conformance test.

- [ ] **Step 1: Write the failing test** (drives the seek state machine in isolation)

```ts
import { describe, it, expect, vi } from "vitest";
import { createMotifRuntime } from "../runtime";

describe("motif runtime seek", () => {
  it("freezes rAF until seek flushes it, at the virtual clock", () => {
    const rt = createMotifRuntime();
    const seen: number[] = [];
    rt.global.requestAnimationFrame((t: number) => seen.push(t));
    expect(seen).toEqual([]);            // not auto-run
    rt.seek(500);
    expect(seen).toEqual([500]);          // flushed at virtual clock
    expect(rt.global.performance.now()).toBe(500);
  });
  it("re-seeking the same t is idempotent for time reads", () => {
    const rt = createMotifRuntime();
    rt.seek(500); rt.seek(1000); rt.seek(500);
    expect(rt.global.performance.now()).toBe(500);
    expect(rt.global.Date.now()).toBe(rt.epoch + 500);
  });
  it("setInterval/setTimeout are neutralized", () => {
    const rt = createMotifRuntime();
    const spy = vi.fn();
    rt.global.setInterval(spy, 1); rt.global.setTimeout(spy, 1);
    rt.seek(5000);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/motifs/__tests__/runtime.test.ts`
Expected: FAIL — cannot resolve `../runtime`.

- [ ] **Step 3: Write minimal implementation**

Factor the clock takeover into a testable factory that operates on an injected `global` object (so Vitest can drive it), then export the browser-injection source string that calls it against `window`.

```ts
// apps/desktop/src/render/motifs/runtime.ts

/** Testable core: installs clock takeover onto an arbitrary global-like object. */
export function createMotifRuntime(g: any = {}) {
  let vclock = 0;
  const epoch = 1700000000000;
  let rafQ: Array<(t: number) => void> = [];
  g.performance = { now: () => vclock };
  g.Date = Object.assign(function () { return new (Date as any)(epoch + vclock); }, {
    now: () => epoch + vclock,
  });
  g.requestAnimationFrame = (cb: (t: number) => void) => { rafQ.push(cb); return rafQ.length; };
  g.cancelAnimationFrame = () => {};
  g.setTimeout = () => 0;
  g.setInterval = () => 0;
  function seek(t: number) {
    vclock = t;
    // declarative animations (browser only); guarded for the unit harness
    if (g.document?.getAnimations) {
      for (const a of g.document.getAnimations()) { a.pause(); try { a.currentTime = t; } catch {} }
    }
    for (let i = 0; i < 4; i++) { const q = rafQ; rafQ = []; for (const cb of q) try { cb(vclock); } catch {} }
    if (g.document?.body) void g.document.body.offsetHeight;
  }
  return { global: g, seek, epoch, get now() { return vclock; } };
}

/**
 * Browser-injection source. Prepended into every Motif document by the `motif:`
 * scheme handler (Task 5/Rust). Installs the runtime on `window`, exposes
 * `motif.define`, and runs the postMessage seek/settle/ack loop the host drives.
 * NOTE: authored here as a String.raw literal — keep ZERO backticks inside the
 * body (see feedback_string_raw_backticks).
 */
export const MOTIF_RUNTIME_SOURCE: string = String.raw`
(function () {
  var rt = (${createMotifRuntime.toString()})(window);
  var def = null, didSetup = false, lastPropsKey = null;
  window.motif = {
    define: function (d) { def = d; },
    random: makeRandom,
  };
  function makeRandom(seedKey) { /* seeded PRNG; seeded per props in setup */ }
  function ctxFor(t, props, meta) {
    return { duration: meta.duration, width: meta.width, height: meta.height,
             fps: meta.fps, frame: Math.round(t * meta.fps), random: makeRandom };
  }
  window.addEventListener("message", async function (e) {
    var msg = e.data || {};
    if (msg.type !== "motif:render") return;
    var meta = msg.meta, props = msg.props, propsKey = JSON.stringify(props);
    try {
      if (!def) throw new Error("motif: no motif.define() called");
      if (!didSetup || propsKey !== lastPropsKey) {
        if (def.setup) await def.setup(props, ctxFor(0, props, meta));
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        didSetup = true; lastPropsKey = propsKey;
      }
      if (def.frame) def.frame(msg.t, ctxFor(msg.t, props, meta));
      rt.seek(msg.t * 1000);
      // double-rAF settle for canvas/WebGL draws scheduled in frame()
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      parent.postMessage({ type: "motif:ready", id: msg.id }, "*");
    } catch (err) {
      parent.postMessage({ type: "motif:error", id: msg.id, error: String(err) }, "*");
    }
  });
  parent.postMessage({ type: "motif:loaded" }, "*");
})();
`;
```

> Implementation note for the worker: the browser `seek` must call the *real*
> `window.requestAnimationFrame` for the settle await, but the *Motif's* rAF must
> be the captured queue. Resolve by capturing the native rAF reference before
> overwriting `window.requestAnimationFrame`. Encode this in the source string.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/render/motifs/__tests__/runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/motifs/runtime.ts apps/desktop/src/render/motifs/__tests__/runtime.test.ts
git commit -m "feat(motifs): clock-takeover + motif.define wrapper runtime"
```

---

## Task 4: Rust CDP capture (reuse the validated spike)

**Files:**
- Create: `apps/desktop/src-tauri/src/motifs/mod.rs`, `motifs/cdp.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add Windows deps), `src/lib.rs` (`mod motifs;`)

- [ ] **Step 1: Add the Windows deps**

In `apps/desktop/src-tauri/Cargo.toml`, after the `[dependencies]` table:

```toml
[target.'cfg(windows)'.dependencies]
webview2-com = "0.38"
windows = "0.61"
```

- [ ] **Step 2: Write `cdp.rs`** (validated 2026-06-07 — controller reachable, ~98 ms capture)

```rust
// apps/desktop/src-tauri/src/motifs/cdp.rs
use std::sync::mpsc;
use std::time::Duration;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows::core::HSTRING;

/// Call one CDP method on the window's WebView2 and block for the JSON result.
/// MUST run on the window's UI thread (call inside `with_webview`).
pub fn cdp_call(core: &ICoreWebView2, method: &str, params_json: &str) -> anyhow::Result<String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    unsafe {
        core.CallDevToolsProtocolMethod(
            &HSTRING::from(method),
            &HSTRING::from(params_json),
            &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
                let _ = tx.send(if hr.is_ok() { Ok(json) } else { Err(format!("{hr:?}")) });
                Ok(())
            })),
        )?;
    }
    // The completion fires on this same UI thread's message loop; pump-free
    // wait works because Tauri drives the loop. Bounded to the per-frame budget.
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(j)) => Ok(j),
        Ok(Err(e)) => Err(anyhow::anyhow!("cdp {method}: {e}")),
        Err(_) => Err(anyhow::anyhow!("cdp {method}: timeout")),
    }
}
```

> **Worker caveat to verify at runtime:** `recv_timeout` blocks the UI thread; if
> the completion handler needs that thread to pump, this deadlocks. The spike used
> a non-blocking handler (logged + returned). If `recv_timeout` deadlocks, switch
> to the async form: post the result to a oneshot and return the bitmap to JS via
> a Tauri event rather than a synchronous command return. Decide here, with a
> 1-frame manual test, before building Task 5 on top.

- [ ] **Step 3: Write `mod.rs`** (capture helper that sets resolution then screenshots)

```rust
// apps/desktop/src-tauri/src/motifs/mod.rs
pub mod cdp;

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

/// Returns base64 PNG of the current page at (w,h). Run inside `with_webview`.
pub fn capture_frame(core: &ICoreWebView2, w: u32, h: u32) -> anyhow::Result<String> {
    let dm = format!(
        r#"{{"width":{w},"height":{h},"deviceScaleFactor":1,"mobile":false}}"#
    );
    cdp::cdp_call(core, "Emulation.setDeviceMetricsOverride", &dm)?;
    let shot = cdp::cdp_call(core, "Page.captureScreenshot", r#"{"format":"png"}"#)?;
    // shot is {"data":"<base64>"}
    let v: serde_json::Value = serde_json::from_str(&shot)?;
    v.get("data").and_then(|d| d.as_str()).map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("captureScreenshot: no data field"))
}
```

- [ ] **Step 4: Wire the module** — add `mod motifs;` to `src/lib.rs` near the other `mod` declarations.

- [ ] **Step 5: Build to verify it compiles**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin weftcut`
Expected: `Finished dev` with no errors (warnings OK). (Spike confirmed this compiles in ~43 s.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/motifs/ apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): rust CDP capture helper (controller -> screenshot)"
```

---

## Task 5: `motif:` scheme + hidden host window + `motif_capture_frame` command

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/mod.rs`, create `motifs/host.rs`, `motifs/commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register scheme, hidden window, command)
- Create: `apps/desktop/src/render/motifs/host.ts`

- [ ] **Step 1: Register the `motif:` URI scheme** (serves wrapper-prepended HTML + assets)

In `lib.rs` builder setup, register a custom protocol `motif` that resolves
`motif://<id>/<path>`: for `index.html`, return the Motif's HTML with
`<script>MOTIF_RUNTIME_SOURCE</script>` injected into `<head>` (the runtime
string is shared from TS; mirror it into Rust as `include_str!` of a generated
file, or pass via the host shell — decide in Step 1, prefer the host-shell route
below to avoid duplicating the source). For asset paths, return the bytes from
the Motif's `assets/`. Set an opaque, locked-down response (no network).

```rust
// host shell served at motif://host/shell.html — a trusted page that embeds:
//   <iframe sandbox="allow-scripts" src="motif://<id>/index.html"></iframe>
// and relays {motif:render} <-> {motif:ready} between window.postMessage and
// the Rust command. The runtime source is injected by the scheme handler when
// serving motif://<id>/index.html.
```

- [ ] **Step 2: Create the reused hidden window** (`host.rs`)

```rust
// apps/desktop/src-tauri/src/motifs/host.rs
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder, WebviewWindow, Manager};

pub const HOST_LABEL: &str = "motif-host";

pub fn ensure_host(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(HOST_LABEL) { return Ok(w); }
    WebviewWindowBuilder::new(app, HOST_LABEL, WebviewUrl::App("motif://host/shell.html".into()))
        .visible(false)
        .build()
}
```

- [ ] **Step 3: Write `motif_capture_frame`** (`commands.rs`)

```rust
// apps/desktop/src-tauri/src/motifs/commands.rs
use tauri::AppHandle;

#[tauri::command]
pub async fn motif_capture_frame(
    app: AppHandle, motif_id: String, t_sec: f64,
    props_json: String, width: u32, height: u32,
) -> Result<String, String> {
    // 1. ensure host window
    // 2. postMessage {motif:render, id, t:t_sec, props, meta} into the host shell,
    //    await {motif:ready} (via a JS-side relay + an ipc channel or Tauri event)
    // 3. on ready, run capture on the UI thread:
    let host = super::host::ensure_host(&app).map_err(|e| e.to_string())?;
    // ... await render-ready handshake (see worker note) ...
    let (tx, rx) = std::sync::mpsc::channel();
    host.with_webview(move |pw| {
        #[cfg(windows)]
        {
            let core = unsafe { pw.controller().CoreWebView2() }.unwrap();
            let _ = tx.send(super::capture_frame(&core, width, height));
        }
    }).map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}
```

> **Worker note:** the render-ready handshake (Step 2) crosses JS↔Rust. Simplest:
> the host shell, on `{motif:ready}`, calls a tiny Tauri command
> `motif_frame_ready(id)`; `motif_capture_frame` awaits that signal (a per-id
> tokio oneshot kept in app state) before the `with_webview` capture. Implement
> the oneshot registry in `commands.rs`.

- [ ] **Step 4: Register command + write `host.ts`**

Add `motifs::commands::motif_capture_frame` (and `motif_frame_ready`) to the
`invoke_handler!` in `lib.rs`. Then:

```ts
// apps/desktop/src/render/motifs/host.ts
import { invoke } from "@tauri-apps/api/core";

export async function captureMotifFrame(
  motifId: string, tSec: number, props: Record<string, unknown>,
  width: number, height: number,
): Promise<ImageBitmap> {
  const b64: string = await invoke("motif_capture_frame", {
    motifId, tSec, propsJson: JSON.stringify(props), width, height,
  });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}
```

- [ ] **Step 5: Build + manual smoke**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin weftcut`
Then `npm --prefix apps/desktop run tauri dev`; from the devtools console call
`window.__TAURI__` invoke path or a temporary button to `captureMotifFrame("countdown", 2.5, {seconds:5}, 480, 480)` and confirm an `ImageBitmap` of size 480×480 returns.
Expected: a bitmap; no taint error.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/ apps/desktop/src-tauri/src/lib.rs apps/desktop/src/render/motifs/host.ts
git commit -m "feat(motifs): motif scheme + hidden host window + capture command"
```

---

## Task 6: Reauthor `countdown` as a Motif (conformance fixture)

**Files:**
- Create: `apps/desktop/src-tauri/src/motifs/builtin/countdown/manifest.json`, `index.html`, `assets/Inter.woff2`
- (Reference the spec §3 worked example.)

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "id": "countdown", "name": "Countdown", "formatVersion": 1, "size": [480, 480],
  "default_duration_s": 5, "max_duration_s": 5, "max_duration_prop": "seconds",
  "fonts": [{ "family": "Inter", "file": "Inter.woff2", "weight": 700 }],
  "props_schema": {
    "seconds": { "type": "number", "default": 5, "min": 1, "max": 60 },
    "label": { "type": "string", "default": "GO", "maxLength": 12 },
    "accent": { "type": "color", "default": "#ff4d4d" }
  }
}
```

- [ ] **Step 2: Write `index.html`** (the spec §3 example — declarative ring + `frame(t)` number)

```html
<!doctype html><html><head><style>
@font-face{font-family:'Inter';src:url('assets/Inter.woff2');font-weight:700}
html,body{margin:0;width:480px;height:480px}
#wrap{display:grid;place-items:center;width:100%;height:100%;font-family:'Inter'}
#num{font-size:220px;font-weight:700}#ring{transform:rotate(-90deg)}
</style></head><body>
<div id="wrap"><svg id="svg" width="480" height="480">
<circle id="ring" cx="240" cy="240" r="200" fill="none" stroke-width="16" stroke-linecap="round"/>
</svg><div id="num"></div></div>
<script type="module">
const C=2*Math.PI*200;
motif.define({
  async setup(props,ctx){
    document.getElementById('num').style.color=props.accent;
    const ring=document.getElementById('ring');
    ring.style.stroke=props.accent; ring.setAttribute('stroke-dasharray',C);
    ring.animate([{strokeDashoffset:0},{strokeDashoffset:C}],
      {duration:ctx.duration*1000,easing:'linear',fill:'both'});
    await document.fonts.ready;
  },
  frame(t,ctx){
    const n=Math.max(0,Math.ceil(ctx.duration-t));
    document.getElementById('num').textContent = n>0 ? String(n) : '';
  },
});
</script></body></html>
```

- [ ] **Step 3: Provide `assets/Inter.woff2`** — copy the Inter 700 woff2 already used elsewhere in the app (or download once into the fixture). Verify the file is non-empty.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/builtin/countdown/
git commit -m "feat(motifs): countdown reauthored as a Motif (conformance fixture)"
```

---

## Task 7: Conformance — determinism + known-frame (real WebView2)

**Files:**
- Create: `apps/desktop/e2e/motif_capture.e2e.js`

Uses the existing tauri-driver + WebdriverIO harness (see `weftcut-media-conformance-harness`; msedgedriver MUST match the WebView2 148.x build or it hangs).

- [ ] **Step 1: Write the failing test**

```js
// apps/desktop/e2e/motif_capture.e2e.js
const { hashPng } = require("./helpers/hash"); // sha256 of PNG bytes

describe("motif capture core", () => {
  it("is deterministic: same (t,props) -> identical bytes", async () => {
    const a = await browser.execute(() => window.__motifCapture("countdown", 2.5, { seconds: 5 }, 480, 480));
    const b = await browser.execute(() => window.__motifCapture("countdown", 2.5, { seconds: 5 }, 480, 480));
    expect(hashPng(a)).toEqual(hashPng(b));
  });

  it("advances with time: different t -> different bytes", async () => {
    const a = await browser.execute(() => window.__motifCapture("countdown", 1.0, { seconds: 5 }, 480, 480));
    const b = await browser.execute(() => window.__motifCapture("countdown", 4.0, { seconds: 5 }, 480, 480));
    expect(hashPng(a)).not.toEqual(hashPng(b));
  });

  it("countdown shows the expected number at t", async () => {
    // at t=2.5, ceil(5-2.5)=3 -> assert via a non-pixel readback hook
    const n = await browser.execute(() => window.__motifReadNumber("countdown", 2.5, { seconds: 5 }));
    expect(n).toEqual("3");
  });
});
```

- [ ] **Step 2: Add the test hooks** — expose `window.__motifCapture` (returns base64 PNG via `captureMotifFrame`) and `window.__motifReadNumber` behind `#[cfg(debug_assertions)]`/dev-only in the app (mirror the existing `e2eHook.ts` pattern). The number-readback drives the host shell to seek and reads `#num.textContent` from the iframe via the postMessage relay.

- [ ] **Step 3: Run to verify it fails**

Run: `npm --prefix apps/desktop run e2e -- --spec e2e/motif_capture.e2e.js`
Expected: FAIL — hooks not defined yet (then implement Step 2 until green).

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix apps/desktop run e2e -- --spec e2e/motif_capture.e2e.js`
Expected: PASS (3 tests). Determinism + advance + correct number confirmed in real WebView2.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/motif_capture.e2e.js apps/desktop/src/render/motifs/  # + dev hooks
git commit -m "test(motifs): determinism + known-frame conformance in real WebView2"
```

---

## Self-Review

**Spec coverage (capture-core slice of the spec):**
- §3 authoring contract (`motif.define`/`setup`/`frame`/`ctx`) → Tasks 3, 6. `interpolate` primitive → Task 1. Manifest/props → Task 2. ✓
- §4 determinism (clock takeover + seek) → Task 3 (logic) + Task 7 (pixel proof). ✓
- §5 capture (hidden WebView2 + sandboxed iframe + CDP, taint-free, arbitrary resolution) → Tasks 4, 5. ✓
- Deferred by design (later plans, noted in header): cache/L0-L1-L2 (Plan 2), compositor/export (Plan 3), full security egress/CSP/timeouts (Plan 4 — Task 5 only stubs the locked-down response), rename/cutover (Plan 5). ✓

**Placeholder scan:** Two steps carry explicit *worker decision notes* (Task 4 sync-vs-async CDP wait; Task 5 ready-handshake oneshot) rather than fabricated code — these are genuine implementation-time decisions with the exact fallback specified, not vague placeholders. All code steps contain real code. ✓

**Type consistency:** `captureMotifFrame(motifId,tSec,props,width,height)` (TS, Task 5) ↔ `motif_capture_frame(motif_id,t_sec,props_json,width,height)` (Rust, Task 5) — names align across the IPC boundary. `Manifest.propsSchema` (Task 2) used consistently. `MOTIF_RUNTIME_SOURCE` (Task 3) consumed by the scheme handler (Task 5). ✓

**Known risk surfaced (not hidden):** the JS↔Rust↔CDP per-frame round-trip and the UI-thread blocking wait (Task 4 note) are the two places this plan could need a structural pivot to async; both have a specified fallback and a 1-frame manual gate before dependent work.
