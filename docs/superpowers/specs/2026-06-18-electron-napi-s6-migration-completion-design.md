# S6 — Migration completion (cross-platform + cut-over): design

**Status:** proposed (2026-06-18)
**Branch:** `migration/electron-napi`
**Predecessors:** S1–S5 (shell → napi state core → media/jobs/export → MCP+cloud → Motif capture), all green (587 Rust + 24 Playwright).
**Master plan:** `docs/superpowers/plans/2026-06-17-electron-napi-migration.md` (this redefines that plan's "S6").

## 1. Goal

Finish the **migration** — not the product. Prove the Electron + napi-rs architecture runs and renders **deterministically across Windows, Linux, and macOS**, close the remaining Electron-vs-Tauri functional gaps, and **delete the Tauri shell** so all subsequent feature work happens on Electron.

This explicitly **defers the release/distribution pipeline** (real code-signing, Apple notarization, auto-update, installer branding/metadata, store submission). Those are product-launch concerns and will be designed after the MVP feature set is complete. S6 produces **unsigned** installers purely as evidence that packaging works on each OS.

## 2. The migration's payoff this stage proves

The reason this migration exists: preview / export / **capture** should run on one engine cross-platform and produce consistent output (determinism, not speed). S6's headline deliverable is the **cross-platform capture-consistency gate** — the empirical proof that offscreen `BrowserWindow` + `webContents.debugger` CDP capture yields perceptually-identical frames on all three OSes. Everything else in S6 exists to support that proof and to make the cut-over safe.

## 3. Scope

### In
1. GitHub Actions CI matrix `{windows-latest, ubuntu-latest, macos-latest}`: build the napi addon, bundle ffmpeg, build the Electron app, run the existing Rust + Playwright suites, and run the new determinism gate.
2. `electron-builder` config producing **unsigned** installers per OS (Win NSIS, Linux AppImage+deb, mac dmg) as packaging-works artifacts.
3. Per-platform ffmpeg-sidecar binary bundling via `extraResources` + runtime path injection.
4. Linux `safeStorage` plaintext-fallback handling (warn + degrade, no hard fail).
5. The determinism harness: a fixed-input capture spec + cross-OS perceptual SSIM comparison + a **negative control** that the gate must fail.
6. Electron functional-parity closure (see §7) — drag-drop import is the one hard, cut-over-blocking gap.
7. Cut-over: remove the Tauri shell, deps, config, scripts, and the throwaway PoC.

### Out (deferred to a post-MVP release stage)
- Real code-signing (Windows cert), Apple notarization, auto-update (electron-updater), installer branding / metadata / icons, app-store or web distribution.
- Any new MVP roadmap feature. S6 ships exactly the functionality that exists today.

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where builds + gate run | GitHub Actions CI matrix | Real mac/Linux without owning hardware; macos/ubuntu runners are free. |
| Platforms in determinism matrix | All 3 (Win, Linux, mac) | Deferring release removed the only mac blocker (notarization); free CI runners + no certs needed make the full original goal achievable now. |
| Signing | None in S6 (unsigned artifacts) | Release machinery deferred to post-MVP; no scaffolding left behind to avoid unused config. |
| Cut-over timing | Last task of S6, after parity + determinism are green | Keep Tauri as a fallback through all packaging/CI work. |
| Render mode for the gate | **Force software rendering (SwiftShader) on all 3 OSes** | Removes GPU-vendor variance so the cross-OS comparison measures the engine, not the driver. Real-GPU render is what *ships*; the gate is a controlled measurement. |
| SSIM threshold | Seed at **0.98**, tune from the first CI run | The negative control guards against an over-loose threshold. |

## 5. Components

### 5.1 CI workflow — `.github/workflows/electron-ci.yml`
- **Triggers:** PR + push to `migration/electron-napi`; `workflow_dispatch`.
- **Build matrix job** (`{windows, ubuntu, macos}`): setup Node 22.20 + Rust toolchain + cargo/registry/`target` cache → `npm ci` → `npm run napi:build` (release, `--features jobs,export,mcp,cloud,motifs`) → fetch the platform ffmpeg into `resources/ffmpeg/<os>/` → `VITE_WEFTCUT_E2E=1 npm run electron:build` → run Rust tests (`cargo test --lib --features jobs,export,mcp,cloud,motifs`) → run Playwright (`npm run e2e:electron`, Linux under `xvfb-run`) → run the determinism capture spec → upload `(os, capture PNGs + hashes)` as an artifact → `electron-builder --publish never` and upload the unsigned installer.
- **Compare job** (needs all three build jobs): download the three capture artifacts; run the cross-OS SSIM matrix + the negative-control assertion; fail the workflow if any real pair < threshold or if the negative control ≥ threshold.

### 5.2 Packaging — `apps/desktop/electron-builder.yml`
- `appId`, `productName: WeftCut`, `directories.output: release/`.
- Targets: `win: nsis (x64)`, `linux: [AppImage, deb] (x64)`, `mac: dmg`.
- `files`: the `out/**` bundle. `asarUnpack: ['**/*.node']` (the native addon cannot execute from inside an asar). Verify `express` + `@modelcontextprotocol/sdk` (prod deps reached from `main`) are packaged, not tree-shaken out.
- `extraResources`: `resources/ffmpeg/<os>/` → ships alongside the app.
- New `package` npm script chained after `napi:build` + `electron:build`.

### 5.3 ffmpeg bundling
- CI downloads a **static** ffmpeg per OS into `resources/ffmpeg/<os>/` (Windows: gyan.dev; Linux: johnvansickle; macOS: evermeet or equivalent static build).
- At runtime, Electron `main` resolves the bundled path under `process.resourcesPath` and injects it into the addon **before** any job runs. Exact mechanism (an `init` option vs. an env var ffmpeg-sidecar honors) is confirmed against the ffmpeg-sidecar 2.x API during implementation; `ffmpeg/mod.rs` uses the injected path instead of PATH lookup. The existing first-run auto-download stays as the dev/unbundled fallback.

### 5.4 Linux safeStorage
- `safeStorage.isEncryptionAvailable()` returns false without a desktop keyring → Electron falls back to `basic_text` (plaintext `cloud_keys.json`).
- `main` checks at startup; if false, logs a warning and surfaces a one-time UI notice via the existing status-log/notice path. Degrade gracefully — never hard-fail. Document the caveat (secure `userData` yourself / install a keyring).

### 5.5 Determinism harness
- **Capture spec** — `apps/desktop/e2e/electron/s6-determinism.spec.ts`. Drives `motif_capture_frame` for a fixed motif set at fixed `t`, frozen clock, fixed viewport (reuses the production offscreen-CDP path). Writes each PNG + a content hash to an artifacts dir. Launches Electron with software rendering forced (`--disable-gpu`, `--use-gl=swiftshader` / `--in-process-gpu` as needed).
- **Cross-OS compare** — a small Node comparison tool (reuse the existing SSIM helper used by the export/motif gates). For each `(motif, t)`, compute SSIM across the OS pairs; assert ≥ threshold.
- **Negative control** — one capture configured to be intrinsically non-deterministic (e.g. a motif that reads wall-clock / `Math.random`, or randomized sub-pixel offset). Its cross-OS (or repeat-capture) SSIM is expected to fall **below** threshold; the gate asserts it does. Without this, a too-loose threshold would pass everything vacuously.
- **Headless reality:** ubuntu/macos CI runners have no discrete GPU; forcing SwiftShader everywhere (including Windows) makes the comparison apples-to-apples. If macOS offscreen-CDP capture proves flaky in CI (the S5-NOTES expectation is "same Chromium → portable"), that flakiness is itself a finding to resolve here.

### 5.6 Cut-over (final task)
Delete, on the branch: `apps/desktop/src-tauri/tauri.conf.json`; the Tauri entry points (`lib.rs` / `main.rs` Tauri arms, `#[tauri::command]` wiring, `tauri-plugin-*`); `Cargo.toml` tauri/tauri-build deps + the `[lib]`/bin wiring that targeted Tauri (keep the napi `cdylib`); `package.json` `@tauri-apps/*` deps + `tauri*` scripts + `@tauri-apps/cli`; the throwaway `apps/desktop/poc/electron-napi/`. Consider renaming `src-tauri/` (now the napi crate, no longer Tauri) — but a rename touches many paths/configs, so it is **optional** and may be its own follow-up to keep the cut-over diff reviewable.

## 6. Data flow notes
- **ffmpeg path:** CI → `resources/ffmpeg/<os>/ffmpeg` (packaged) → `main` resolves under `process.resourcesPath` → injected into the addon → `ffmpeg/mod.rs` spawns it.
- **Determinism artifacts:** per-OS build job → capture PNGs+hashes artifact → compare job → SSIM matrix verdict.

## 7. Electron-vs-Tauri parity gaps (verified 2026-06-18)

| Gap | Status | Cut-over blocker? | Plan |
|---|---|---|---|
| **Drag-drop import** | `MediaDropZone.onDrop` (`src/App.tsx:2378`) calls WebView2-only `window.chrome.webview.postMessageWithAdditionalObjects`; undefined on Electron → drops silently no-op. No `@tauri-apps/*` alias seam (raw inline WebView2 call). | **Yes** | Expose `webUtils.getPathForFile` via preload; **first sanctioned `src/**` edit** — branch `onDrop` so Electron maps dropped `File`s → real paths → the existing media-drop/import command. Per `reference_dragdrop_platform_split`: Windows via this path, mac/Linux can also use it (Electron's `getPathForFile` is cross-platform). |
| **PerfHUD secondary window** | `src/electron-compat/tauri-webview-window.ts` is still a no-op stub; the PerfHUD popup never opens. | No (dev/diagnostic tool) | Decide in plan: either implement a real second `BrowserWindow` (cheap) or accept degraded for S6 and note it. Recommend: implement, small. |
| **ConnectAgentPanel** | Still SSE-shaped (`sse_url`/`events_url`); backend is streamable-HTTP. The `[mcp] connect:` log is the interim bridge. | No (cosmetic/correctness) | Small front-end rework: `McpInfoView` single `url` field + streamable-HTTP snippet + locale strings. |
| **Manual export verification** | Owed since S3b (automated gates cover the path). | No | Run a manual export through the built app as S6 acceptance evidence. |
| onResized maximize glyph | Already wired (`evt:window:resized` emitted in `main`). | — | None (closed). |

The `src/**` edit for drag-drop is a deliberate, scoped exception to the migration's "no `src/**` edits" rule — that rule existed to keep S1–S5 parity-preserving; making a platform-specific renderer feature work on Electron is exactly what S6/cut-over is for.

## 8. Error handling / risk
- **macOS offscreen CDP in CI** — main risk; expected portable but unproven. The CI gate is precisely how we find out; budget time for SwiftShader/headless tuning.
- **Linux keyring absent** — handled by §5.4 graceful degrade.
- **CI flakiness** — the capture spec uses frozen clock + fixed viewport + software render; the SSIM threshold + negative control bound false pass/fail.
- **express / MCP SDK packaging** — verify they survive asar packaging (run the MCP gate against the *packaged* app, not just the dev build).

## 9. Exit criteria
1. CI green on all three OSes: napi builds, ffmpeg bundled, Electron app builds, **587 Rust + 24 Playwright pass**, unsigned installers produced.
2. **Determinism gate passes**: real captures SSIM ≥ threshold across all OS pairs, **and** the negative control falls below threshold (proving the gate has teeth).
3. Drag-drop import works on the built Electron app (manual + a Playwright assertion if feasible); manual export verified.
4. Cut-over complete: Tauri shell/deps/config/scripts and the PoC dir removed; the branch builds and runs purely on Electron.

## 10. Decomposition for the plan
A single S6 stage, but the plan sequences it so the highest-risk / highest-value work lands first and the irreversible step lands last:
1. Packaging foundation (electron-builder config + ffmpeg bundling + napi build wiring) — local, all OSes' config.
2. CI matrix scaffold (3-OS build + existing test suites green in CI).
3. Determinism harness (capture spec + negative control + cross-OS compare) — the headline proof.
4. Linux safeStorage handling.
5. Parity closure (drag-drop [blocker] → PerfHUD → ConnectAgentPanel → manual export verify).
6. Cut-over (last; gated on 1–5 green).
