# S5 — Motif Capture Migration: Acceptance Notes

## What ships in S5

### Architectural inversion: Rust → JS CDP capture

The Tauri implementation drove the Motif capture pipeline from Rust: a hidden
`WebView2` window created by `tauri-plugin-webview`, CDP commands issued from a
`tokio` task via `webview2-com` + `windows` crates.  The Electron build inverts
this: capture is driven entirely from the Node.js/main-process side.

- `apps/desktop/electron/main/motif/capture.ts` — the new JS capture orchestrator.
  Creates a single hidden `BrowserWindow` with `offscreen:true`, attaches the
  Electron `Debugger` API (`webContents.debugger`), and drives the full CDP
  sequence: `Page.enable` → `Runtime.enable` → inject the clock-takeover runtime
  via `Page.addScriptToEvaluateOnNewDocument` → navigate to `motif://<id>/index.html?v=<hash>`
  → probe readiness → `Emulation.setDeviceMetricsOverride` → `Emulation.setDefaultBackgroundColorOverride`
  (alpha 0, the transparent-backdrop fix) → call `window.__motifRender(t, props, meta)`
  via `Runtime.evaluate` → `Page.captureScreenshot` (PNG base64, no `data:` prefix).
  A `chain: Promise` serializes all captures (on-demand sprite / pre-baker / MCP)
  on the single host window, replacing the Rust `tokio::Mutex`.

- The renderer registers the clock-takeover runtime via `motif_register_runtime`
  at boot; main injects it into the offscreen host via
  `addScriptToEvaluateOnNewDocument`.  The intercept is in `electron/main/index.ts`.

### Deleted Rust modules

The following Rust code was deleted in Task 1:

- `src-tauri/src/motifs/cdp/` — the full CDP command shim (`DevTools`, `Page.*`,
  `Runtime.*`, `Emulation.*`, `Page.captureScreenshot`).
- `src-tauri/src/motifs/host/` — the hidden `WebView2` host-window lifecycle
  (`create_host`, `navigate`, `inject_runtime`, `capture_frame`).
- `src-tauri/src/motifs/commands/capture.rs` — the Tauri `motif_capture_frame`
  command.

Dropped crate dependencies (no longer in `Cargo.toml`):

- `webview2-com` — the COM bindings for the `ICoreWebView2` CDP interface.
- `windows` (the `Microsoft.Web.WebView2.Core.*` feature set used by the capture
  host).

### New napi methods

Two new methods added to the `Backend` napi class (Task 2):

| Method | Signature | Purpose |
|---|---|---|
| `motifResolveFile(id, rest)` | `(string, string) → MotifFile \| null` | Serve `motif://<id>/<rest>` from the Rust brain; returns `{ bytes: Buffer, contentType: string }` or `null` on miss. Used by the protocol handler. |
| `motifCtxDurationS(motifId, propsJson)` | `(string, string) → number` | Resolve the effective `duration` to pass as `meta.duration` to `__motifRender`. Reads the manifest's `content_duration_s` / `max_duration_s` / `max_duration_prop` chain. |

### `motif:` custom protocol

`apps/desktop/electron/main/motif/protocol.ts` registers a `motif:` scheme via
`protocol.registerSchemesAsPrivileged` (before `app.whenReady`) and
`protocol.handle('motif', ...)` (after init).  Privileges: `standard:true`,
`secure:true`, `supportFetchAPI:true`.  The handler resolves
`motif://<id>/<rest>` through `backend.motifResolveFile`, returning 200 with the
appropriate `Content-Type` and a strict CSP
(`default-src 'none'; script-src 'unsafe-inline'; ...`), or 404 on miss.

### `motifs` feature gate

The full Motif surface (store, watcher, catalog, authoring commands, brain
dispatch arms, napi methods, and the capture host) is compiled under
`--features motifs`.  The production build script uses:

```
napi build --platform --release --manifest-path src-tauri/Cargo.toml \
  --output-dir src-tauri --features jobs,export,mcp,cloud,motifs
```

---

## Test evidence

### Cargo lib tests (`--features jobs,export,mcp,cloud,motifs`)

Command:
```
cd apps/desktop/src-tauri
cargo test --lib --features jobs,export,mcp,cloud,motifs
```

Result: **587 passed; 0 failed** (finished in 1.59s)

S5 added 57 tests relative to S4b (530 → 587); the new tests cover the motif
store round-trips, watcher debounce, authoring command cores (write/install/
delete/staleness), and brain dispatch arms.

### Playwright e2e (full suite)

Command:
```
cd apps/desktop
node <root>/node_modules/@playwright/test/cli.js test \
  --config playwright.config.ts e2e/electron
```

Result: **24 passed; 0 failed** (2m 48s, 1 worker)

Specs executed:

| Spec | Result |
|---|---|
| `s2-smoke.spec.ts` | pass |
| `s3a-handlers.spec.ts` | pass |
| `s3a-import.spec.ts` | pass |
| `s3a-protocol.spec.ts` | pass |
| `s3a-window-visible.spec.ts` | pass |
| `s3b-fs.spec.ts` | pass |
| `s4a-mcp.spec.ts` | pass |
| `s4b-cloud-keys.spec.ts` | pass |
| `conformance.spec.ts` | pass |
| `export_codecs.spec.ts` (3 cases) | pass |
| `export_eos_tail.spec.ts` | pass |
| `export_overlap_same_source.spec.ts` (3 cases) | pass |
| `s5-motif-protocol.spec.ts` | pass |
| `s5-motif-capture.spec.ts` | pass |
| `s5-mcp-motif.spec.ts` | pass |
| `s5-motif-preview.spec.ts` | **pass (new)** |
| `s5-motif-export.spec.ts` | **pass (new)** |
| `s5-motif-lifecycle.spec.ts` (3 cases) | **pass (new)** |

The 5 new S5 tests (`s5-motif-preview`, `s5-motif-export`, and the 3 lifecycle
cases in `s5-motif-lifecycle`) all pass and no regressions were observed in the
prior S2–S4 and S5 specs.

### Implementation note: Electron userData in dev

When the app runs unpackaged (dev build), `app.getPath('userData')` resolves to
`%APPDATA%\Electron` — NOT `%APPDATA%\@weftcut\desktop` (which would be the
packaged app name).  The lifecycle e2e specs discover the actual path at runtime
via `app.evaluate(({ app }) => app.getPath('userData'))` so they are robust to
this difference.  The Tauri wdio specs hard-coded the Tauri identifier path
(`%APPDATA%\dev.weftcut.desktop\motifs`); the Electron specs avoid that.

---

## Deferred follow-ups

### Cross-platform offscreen CDP (S6)

The S5 capture host uses Electron's `BrowserWindow { offscreen: true }` +
`webContents.debugger` — tested and verified on Windows 11.  macOS and Linux
use the same Chromium backend, so the approach should be portable without code
changes.  Verify during S6 cross-platform packaging.

### ConnectAgentPanel streamable-HTTP UI gap

`ConnectAgentPanel.tsx` still emits SSE-shaped snippets and reads the legacy
`McpInfoView.sse_url` / `events_url` fields (unchanged from S4b).  The
streamable-HTTP panel rework (retire `sse_url`/`events_url`, expose single `url`
field, update locale strings) is deferred to a post-S5 UI-gap pass alongside
any other panel touches.  The `[mcp] connect:` startup log line remains the
interim bridge for agent clients.

### Pre-bake idle dot (minor)

The `motif-bake-dot` dot is gated on the overlay track being revealed
(`revealLayer` hook); a collapsed track has no DOM node.  The `prebake.e2e.js`
wdio spec (not ported to Playwright) covers this.  Port is deferred until the
`prebakeLayerAndWait` / `revealLayer` hooks are exercised in a full UX-path spec.

### Minor doc / style sweeps

Tracked in the S5 progress ledger (task notes):

- Evergreen docs audit for S5-era additions.
- The `ConnectAgentPanel` UI string update.
- Any remaining `src/` motif-related component renames from "Template" → "Motif".
