# Decode Engine (Phase D1–D4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the preview-side decode engine: split `@weftcut/native-decode` out of `@weftcut/core` (D1), replace the `nativeSwSourceFor`/session-bridge special cases with one engine-resolution module + `decode_engine` app setting (D2), widen the SW lane to probe-accepted formats with a machine capability cache (D3), and productize the HW lane with a session budget and sticky downgrade (D4).

**Architecture:** Spec = `docs/superpowers/specs/2026-07-09-dual-engine-decode-export-design.md` §"Decode engine (Phase D)" + §"Conditional first-class". Engine is a **runtime overlay** (P2): `decide()`/`DecodeRoute` on disk stay untouched; a pure resolver maps (AppSettings.decode_engine × component availability × capability cache × session probes × DecodeRoute) → one of four tiers (`native-hw` / `webcodecs-original` / `native-sw` / `proxy`) consumed at `SourceDecoderPool.acquire`. The native runtime lives in a NEW lazily-required napi addon so a missing ffmpeg DLL can never kill `require('@weftcut/core')`. Export-side decode and the proxy-policy flip are **out of scope** (Phase D5–D6, a second plan).

**Tech Stack:** Rust (two napi-rs v3 addons; `ffmpeg-next` 8.1 only in the new one), TypeScript (Electron main + renderer, vitest), Playwright `_electron` e2e (local-only), electron-builder NSIS packaging, BtbN LGPL-shared ffmpeg DLLs (Windows), i18next (en-US + zh-CN).

## Global Constraints

- Work on branch `feat/decode-engine-phase-d1-d4` off local `main`; commit per task; stage by EXPLICIT path only (`git add <files>` — another session may edit this checkout; never `git add -A`).
- End every commit message with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Two addons, two feature unions.** `@weftcut/core` keeps `jobs,export,mcp,cloud` (`apps/desktop/package.json` `napi:build`) and must NEVER gain `ffmpeg-next`. `@weftcut/native-decode` has NO cargo features (preview_sw always; preview_gpu under `cfg(windows)`), so its union rule is trivially satisfied. Rust test invocations must stay matched with the corresponding build script per addon.
- Building/testing `@weftcut/native-decode` needs `FFMPEG_DIR` (an ffmpeg **shared** build with `include/` + `lib/`) and `LIBCLANG_PATH` (`C:\Program Files\LLVM\bin` locally and on windows-latest CI). Running it needs the matching avcodec/avutil/… DLLs reachable via `PATH` (the loader prepends the bundled/fetched DLL dir on Windows).
- Rebuilding EITHER addon requires the dev app CLOSED (a running app locks both `.node` files). `native/*.node`, `native/index.js`, `native/index.d.ts` are gitignored today; the new addon's `decode/*.node`, `decode/index.js`, `decode/index.d.ts` get the same treatment — every checkout builds locally (see `reference_worktree_bootstrap`).
- TS gates: `npm run typecheck` (tsc -b; needs BOTH addons' generated `index.d.ts` present) and `npm run test` (vitest) from `apps/desktop`.
- Rust gates: `cargo test --manifest-path native/Cargo.toml --lib --features jobs,export,mcp,cloud` (core) and `cargo test --manifest-path native/decode/Cargo.toml` (component, needs FFMPEG_DIR/LIBCLANG_PATH env) from `apps/desktop`.
- The distributed LGPL DLLs come from BtbN `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip` ONLY. The dev machine's `Gyan.FFmpeg.Shared` build is GPL (`full_build-shared`) and must never ship. Any script that stages DLLs for packaging MUST assert the build banner contains neither `--enable-gpl` nor `--enable-nonfree` (one supply-chain mix-up silently collapses the LGPL line — see `project_ffmpeg_licensing`).
- All new user-visible strings get BOTH `en-US.ts` and `zh-CN.ts` keys.
- `app_settings.json` schema changes must be per-field defaulted on read (existing files keep working; unknown keys ignored). The `experimental_native_sw_decode` field is DELETED, not deprecated — its on-disk remnant is silently ignored by the per-field reader.
- Touching the playback loop ⇒ run the memory ratchet locally before merge: `node e2e/scripts/memory-ratchet.mjs` (<30 MB/90 s). Playhead-adjacent React state rules per `feedback_playhead_gate_and_tiers`.
- e2e specs are local-only (self-skip in CI). Running them needs: `npm run napi:build`, `npm run napi:build:decode`, `npm run fetch-ffmpeg`, `npm run fetch-ffmpeg-lgpl`, `VITE_WEFTCUT_E2E=1 npm run build` (bash), then `npx playwright test e2e/electron/<spec>` from `apps/desktop`.
- Vocabulary discipline (`CONTEXT.md`): the new machine-level store is the **capability cache** — never call it "session bridge" (and never call the session bridge "probe cache"). CONTEXT.md gains the new terms in Task 11.
- The overlay must stay a **pure function** of (settings × capability cache × session probes × read-only route) — spec Risk 4. Any hidden state in the resolver is a review-blocker.

## File Structure (what exists / what this plan adds)

Existing (verified 2026-07-11):
- `apps/desktop/native/Cargo.toml` — workspace root (`members = ["eval"]`), package `weftcut`, features at `:102-110` (`preview-gpu`/`preview-sw` gate `dep:ffmpeg-next`, `dep:windows`).
- `apps/desktop/native/src/lib.rs:34-39` — `preview_gpu` / `preview_sw` module gates; `apps/desktop/native/src/preview_sw/{mod,decoder,session}.rs`, `preview_gpu/{mod,decoder,session}.rs` — **zero `crate::` imports; fully self-contained** (ffmpeg_next + windows + std only).
- `apps/desktop/native/src/napi_backend.rs` — `Backend` preview fields `:44-63`, poke-sink wiring `:99-164`, wire structs `:478-525` + `:669-715`, GPU impl `:531-658`, SW impl `:721-797` (incl. feature-off stubs).
- `apps/desktop/native/src/events.rs` — `EventSink` trait + `TsfnEventSink` (`{event, payload}` JSON envelope) + `VecEventSink`.
- `apps/desktop/src/main/index.ts` — eager `require_('@weftcut/core')` `:35-38`; onEvent relay tail `mainWindow?.webContents.send('evt:' + event, payload)` `:200-205`; `startupNotices` `:54`; previewGpu/Sw IPC handlers `:440-479`.
- `apps/desktop/src/main/previewGpu.ts`, `apps/desktop/src/main/previewSw.ts` — take `backend: Backend` as a param; only the type import changes.
- `apps/desktop/src/main/previewGpuTiming.ts` — `recordFrameReadySent`/`recordConsumeAck` (bench timing; keep wired).
- `apps/desktop/src/shared/app-settings.ts`, `apps/desktop/src/main/app-settings.ts` (per-field defaulting reader + atomic write), `apps/desktop/src/renderer/settings/appSettingsStore.ts` (atomic selectors), `apps/desktop/src/renderer/settings/SettingsPanel.tsx` (`NativeSwSection` `:461-483`).
- `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts` — `SourceHandleInit.forceStrategy` `:68-85`, `acquire` `:703-738` (native arm E2E-gated at `:704`).
- `apps/desktop/src/renderer/render/decoder/{SwSourceHandle.ts,NativeGpuSourceHandle.ts,FrameRing.ts,probeSourceDecodable.ts}`.
- `apps/desktop/src/renderer/render/Compositor.ts` — `ensureClip` swap trigger `:1454-1459`, acquire block `:1462-1543`, `beginSwap/pollSwap/completeSwap/abandonSwap` `:1549-1660`, `ActiveClip.builtFromUrl`/`isSoftware`.
- `apps/desktop/src/renderer/render/PixiPreview.tsx` — resolvers `:137-172`, Compositor construction `:174-185`.
- `apps/desktop/src/renderer/render/decodeRoute.ts` — `resolveDecode` + `previewPathLive` (the session bridge overlay).
- `apps/desktop/src/renderer/app/useImportReadiness.ts` — `decodeProbeMemo` `:182`, `previewDecodableMediaIds` `:194-201`, `refreshSources` nudge `:247`.
- `apps/desktop/src/renderer/ipc/index.ts` — `MediaSummary.codec`/`.pix_fmt` `:50-53`, `LogEntryInput` + `logEmit` `:1368-1398`.
- `apps/desktop/electron-builder.yml` — `@weftcut/core` whitelist pattern, `asarUnpack: "**/*.node"`, `extraResources` (sidecar ffmpeg, motifs).
- `.github/workflows/electron-ci.yml` — napi build `:79-80`, ffmpeg cache+fetch `:96-124`, Rust tests `:137-153`.
- `apps/desktop/scripts/fetch-ffmpeg.mjs` — download/retry/verify pattern to mirror.
- `apps/desktop/e2e/electron/preview-sw-families.spec.ts`, `preview-sw-conformance.spec.ts` — set `experimental_native_sw_decode` via `invokeCmd(page, 'app_settings_set', …)`.
- `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs` — `BENCH_MATRIX` fixture generator (D3 rows).
- `apps/desktop/src/renderer/components/AppSelect.tsx` — the select control (used by ExportSettingsDialog).

New files this plan creates:
- `apps/desktop/native/decode/{Cargo.toml,build.rs,package.json,.gitignore}` + `src/{lib.rs,events.rs,backend.rs}` + moved `src/preview_sw/*`, `src/preview_gpu/*` — the `@weftcut/native-decode` addon.
- `apps/desktop/src/main/native-decode.ts` — lazy loader + level-0 availability gate (+ tests `native-decode.test.ts`).
- `apps/desktop/scripts/fetch-ffmpeg-lgpl.mjs` + `apps/desktop/scripts/napi-build-decode.mjs` — LGPL DLL fetch (banner-asserted) + env-wrapped component build.
- `apps/desktop/src/renderer/settings/decodeComponentStore.ts` — renderer mirror of component availability.
- `apps/desktop/src/renderer/render/decoder/decodeEngine.ts` + `decodeEngine.test.ts` — the pure resolution module (D2).
- `apps/desktop/src/renderer/render/decoder/decodeCapability.ts` — renderer session capability map + probe kicks (D3/D4).
- `apps/desktop/src/main/decode-capability.ts` + `decode-capability.test.ts` — machine capability cache file store (D3).
- `apps/desktop/e2e/electron/decode-engine.spec.ts` — tier-resolution e2e (D2/D3/D4 cells).
- `docs/adr/0030-decode-engine-overlay-and-native-component.md` — the ADR the spec mandates.

---

# Stage D1 — split `@weftcut/native-decode` + level-0 gate

**Stage outcome:** the native preview runtime (SW + GPU lanes) lives in its own lazily-required addon; `@weftcut/core` never links `ffmpeg-next`; the app works fully when the component is absent; the Windows installer bundles the component + LGPL DLLs; CI builds and tests the component on Windows.

### Task 1: Create the `weftcut-native-decode` crate and move the preview modules

The preview modules have **zero `crate::` imports** (verified) — this is a directory move plus a new napi entry. The `Backend` struct keeps its preview surface until Task 2 rewires TS; core stripping happens in Task 2 as well so every commit stays green (core's generated `index.d.ts` regenerates only on `napi:build`, so stripping core before TS is rewired would break CI typecheck).

**Files:**
- Create: `apps/desktop/native/decode/Cargo.toml`
- Create: `apps/desktop/native/decode/build.rs`
- Create: `apps/desktop/native/decode/package.json`
- Create: `apps/desktop/native/decode/.gitignore`
- Create: `apps/desktop/native/decode/src/lib.rs`
- Create: `apps/desktop/native/decode/src/events.rs`
- Create: `apps/desktop/native/decode/src/backend.rs`
- Copy (git cp is not a thing — `cp -r`, deletion from core happens in Task 2): `apps/desktop/native/src/preview_sw/` → `apps/desktop/native/decode/src/preview_sw/`; `apps/desktop/native/src/preview_gpu/` → `apps/desktop/native/decode/src/preview_gpu/`
- Modify: `apps/desktop/native/Cargo.toml` (workspace members)
- Modify: `apps/desktop/package.json` (dependency + script)
- Modify: `apps/desktop/.gitignore` (decode addon artifacts)

**Interfaces:**
- Consumes: `preview_sw::{PreviewSwRegistry, SwFramePoke}`, `preview_sw::decoder::SwFrame`, `preview_gpu::{PreviewGpuRegistry, PreviewGpuPoke, TimingReport, TimingSummary}` — moved verbatim, unmodified.
- Produces (later tasks + TS rely on these exact napi names): class `NativeDecode` with constructor `(on_event: ThreadsafeFunction<String>)` and methods `preview_gpu_open/preview_gpu_request_frame_at/preview_gpu_consume_ack/preview_gpu_close/preview_gpu_take_timings`, `preview_sw_open/preview_sw_request_frame_at/preview_sw_close` (JS: `previewGpuOpen`, …, `previewSwClose` — identical camelCase to today's `Backend` methods, so `previewGpu.ts`/`previewSw.ts` only change a type import); module fn `version_info(): string` (JS `versionInfo()`); wire structs `PreviewGpuSlot/PreviewGpuOpenInfo/PreviewGpuTimingSummary/PreviewGpuTimingReport/PreviewSwOpenInfoJs/PreviewSwFrame` (same field names as today).

- [ ] **Step 1: Scaffold the crate config**

`apps/desktop/native/decode/Cargo.toml`:

```toml
# @weftcut/native-decode — the optional native preview-decode component
# (dual-engine spec §"Conditional first-class"). Carries preview_sw +
# preview_gpu and the ONLY ffmpeg-next linkage in the repo; @weftcut/core
# must never link libav. Build needs FFMPEG_DIR (shared build with
# include/ + lib/) and LIBCLANG_PATH; run needs the matching DLLs on PATH.
[package]
name = "weftcut-native-decode"
version = "0.0.0"
edition = "2021"
description = "WeftCut native decode component"
authors = ["WeftCut"]
publish = false
rust-version = "1.77"

[lib]
name = "weftcut_native_decode"
crate-type = ["cdylib"]

[build-dependencies]
napi-build = "2"

[dependencies]
napi = { version = "3", default-features = false, features = ["napi6"] }
napi-derive = "3"
serde_json = "1"
tracing = "0.1"
ffmpeg-next = "8.1"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
  "Win32_Foundation", "Win32_Security", "Win32_Graphics_Direct3D",
  "Win32_Graphics_Direct3D11", "Win32_Graphics_Dxgi", "Win32_Graphics_Dxgi_Common",
] }
```

`apps/desktop/native/decode/build.rs`:

```rust
fn main() {
    napi_build::setup();
}
```

`apps/desktop/native/decode/package.json`:

```json
{
  "name": "@weftcut/native-decode",
  "version": "0.0.0",
  "private": true,
  "main": "index.js",
  "types": "index.d.ts",
  "files": ["index.js", "index.d.ts", "*.node"],
  "napi": {
    "binaryName": "weftcut-native-decode"
  },
  "devDependencies": {
    "@napi-rs/cli": "^3.6.2"
  },
  "scripts": {
    "build": "napi build --platform --release"
  }
}
```

`apps/desktop/native/decode/.gitignore`:

```gitignore
*.node
index.js
index.d.ts
```

- [ ] **Step 2: Register the workspace member**

In `apps/desktop/native/Cargo.toml`, change the workspace header:

```toml
# The napi crate is the workspace root; members: the dependency-light
# `weftcut-eval` leaf (native + wasm32) and the optional `weftcut-native-decode`
# component addon (the only ffmpeg-next consumer — see decode/Cargo.toml).
[workspace]
members = ["eval", "decode"]
```

- [ ] **Step 3: Copy the preview modules (unmodified)**

```bash
cp -r apps/desktop/native/src/preview_sw apps/desktop/native/decode/src/preview_sw
cp -r apps/desktop/native/src/preview_gpu apps/desktop/native/decode/src/preview_gpu
```

Do not edit the copied files. (Core's originals are deleted in Task 2.)

- [ ] **Step 4: Write the component's event sink twin**

`apps/desktop/native/decode/src/events.rs` — a deliberate ~30-line twin of `native/src/events.rs` (the two addons cannot share a crate without dragging core's whole dep tree into the component; the envelope `{event, payload}` must stay byte-identical because Electron main parses both with one relay):

```rust
//! Event sink — bridges component events to Electron main via a napi
//! `ThreadsafeFunction`. TWIN of native/src/events.rs (kept tiny on purpose;
//! the `{event, payload}` JSON envelope must match — main's relay parses both).

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

pub struct TsfnEventSink {
    tsfn: ThreadsafeFunction<String>,
}

impl TsfnEventSink {
    pub fn new(tsfn: ThreadsafeFunction<String>) -> Self {
        Self { tsfn }
    }
}

impl EventSink for TsfnEventSink {
    fn emit(&self, event: &str, payload: Value) {
        let msg = serde_json::json!({ "event": event, "payload": payload }).to_string();
        let _ = self.tsfn.call(Ok(msg), ThreadsafeFunctionCallMode::NonBlocking);
    }
}
```

- [ ] **Step 5: Write the napi entry**

`apps/desktop/native/decode/src/lib.rs`:

```rust
//! WeftCut native decode component (`@weftcut/native-decode`): the optional
//! preview-decode runtime (SW libavcodec lane everywhere, D3D11 GPU lane on
//! Windows). Lazily required by Electron main; absence must never affect
//! `@weftcut/core`. See docs/adr/0030 + the dual-engine spec.

mod backend;
mod events;
#[cfg(windows)]
mod preview_gpu;
mod preview_sw;
```

`apps/desktop/native/decode/src/backend.rs` — this is `napi_backend.rs`'s preview surface, transplanted onto a `NativeDecode` class. The GPU/SW method bodies, wire structs, and doc comments move verbatim from `native/src/napi_backend.rs:474-769` with `Backend`→`NativeDecode` and `crate::preview_*`→`crate::preview_*` (same paths in the new crate). Skeleton with the parts that CHANGE spelled out:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::events::{EventSink, TsfnEventSink};

// ── wire structs ────────────────────────────────────────────────────────────
// PreviewGpuSlot / PreviewGpuOpenInfo / PreviewGpuTimingSummary /
// PreviewGpuTimingReport / PreviewSwOpenInfoJs / PreviewSwFrame move here
// VERBATIM from native/src/napi_backend.rs:474-525 and :669-695 (same
// #[napi(object)] shapes and doc comments), plus `sw_frame_to_napi`
// (:700-715, drop its #[cfg] — the component always has preview_sw).

/// The component's ffmpeg linkage identity — the SW capability-cache envKey
/// (D3). Changes when the bundled/loaded avcodec changes.
#[napi]
pub fn version_info() -> String {
    format!(
        "avcodec={} avutil={}",
        ffmpeg_next::codec::version(),
        ffmpeg_next::util::version()
    )
}

#[napi]
pub struct NativeDecode {
    #[cfg(windows)]
    preview_gpu: crate::preview_gpu::PreviewGpuRegistry,
    preview_sw: crate::preview_sw::PreviewSwRegistry,
    preview_sw_sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<PreviewSwFrame>>>>,
}

#[napi]
impl NativeDecode {
    /// `on_event` receives the same `{event, payload}` JSON envelope the core
    /// Backend's sink emits; main relays both through `evt:*`.
    #[napi(constructor)]
    pub fn new(on_event: ThreadsafeFunction<String>) -> Self {
        let events: Arc<dyn EventSink> = Arc::new(TsfnEventSink::new(on_event));
        // GPU poke → events wiring: VERBATIM from napi_backend.rs:102-132
        // (registry.set_poke_sink emitting previewGpu:frameReady/eof/error).
        #[cfg(windows)]
        let preview_gpu = {
            let registry = crate::preview_gpu::PreviewGpuRegistry::new();
            let sink_events = events.clone();
            registry.set_poke_sink(Box::new(move |poke| {
                use crate::preview_gpu::PreviewGpuPoke;
                match poke {
                    PreviewGpuPoke::FrameReady { stream_id, slot, pts_us, dur_us } => {
                        sink_events.emit(
                            "previewGpu:frameReady",
                            serde_json::json!({
                                "streamId": stream_id, "slot": slot,
                                "ptsUs": pts_us, "durUs": dur_us,
                            }),
                        );
                    }
                    PreviewGpuPoke::Eof { stream_id } => {
                        sink_events.emit("previewGpu:eof", serde_json::json!({ "streamId": stream_id }));
                    }
                    PreviewGpuPoke::Error { stream_id, message } => {
                        sink_events.emit(
                            "previewGpu:error",
                            serde_json::json!({ "streamId": stream_id, "message": message }),
                        );
                    }
                }
            }));
            registry
        };
        #[cfg(not(windows))]
        let _ = &events; // events only feed GPU pokes today; SW frames bypass them
        // SW frame-sink wiring: VERBATIM from napi_backend.rs:139-164.
        let (preview_sw, preview_sw_sinks) = {
            let registry = crate::preview_sw::PreviewSwRegistry::new();
            let sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<PreviewSwFrame>>>> =
                Default::default();
            let sinks_for_cb = sinks.clone();
            registry.set_frame_sink(Box::new(move |poke| {
                use crate::preview_sw::SwFramePoke;
                match poke {
                    SwFramePoke::Frame { stream_id, frame } => {
                        if let Some(tsfn) = sinks_for_cb.lock().unwrap().get(&stream_id) {
                            let _ = tsfn.call(
                                Ok(sw_frame_to_napi(&stream_id, frame)),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                    }
                    SwFramePoke::Eof { stream_id } => tracing::debug!(%stream_id, "preview-sw eof"),
                    SwFramePoke::Error { stream_id, message } => {
                        tracing::warn!(%stream_id, %message, "preview-sw decode error")
                    }
                }
            }));
            (registry, sinks)
        };
        NativeDecode {
            #[cfg(windows)]
            preview_gpu,
            preview_sw,
            preview_sw_sinks,
        }
    }

    // ── GPU methods (Windows) ──────────────────────────────────────────────
    // preview_gpu_open / preview_gpu_request_frame_at / preview_gpu_consume_ack /
    // preview_gpu_close / preview_gpu_take_timings + to_napi_timing_summary:
    // VERBATIM from napi_backend.rs:531-620, with the impl block cfg'd
    // `#[cfg(windows)]` (feature gate gone — the component always builds GPU
    // on Windows). Non-Windows stub impl block: VERBATIM from :626-658 with
    // `#[cfg(not(windows))]` and the same "preview-gpu not built" reasons.

    // ── SW methods (all platforms) ─────────────────────────────────────────
    // preview_sw_open / preview_sw_request_frame_at / preview_sw_close:
    // VERBATIM from napi_backend.rs:721-768 (no cfg — always present).
    // The :775-797 feature-off stubs are NOT carried over (no features here).
}
```

Note on method placement: napi supports multiple `#[napi] impl NativeDecode` blocks exactly as `Backend` uses today — keep the GPU real/stub blocks as two separate `impl` blocks like the original.

- [ ] **Step 6: Wire the npm workspace + build script**

In `apps/desktop/package.json`:
- Add to `dependencies` (next to `"@weftcut/core": "file:native"`): `"@weftcut/native-decode": "file:native/decode"`.
- Add to `scripts` (next to `napi:build`): `"napi:build:decode": "node scripts/napi-build-decode.mjs"` — the wrapper script arrives in Task 3; UNTIL THEN use the raw command in Step 8 directly. To keep this task self-contained, add the script as the raw form now and let Task 3 replace it:

```json
"napi:build:decode": "napi build --platform --release --manifest-path native/decode/Cargo.toml --output-dir native/decode",
```

In `apps/desktop/.gitignore`, after the existing `native/index.d.ts` line, add:

```gitignore
native/decode/*.node
native/decode/index.js
native/decode/index.d.ts
```

Then run `npm install` from the repo root (registers the `file:native/decode` link in `node_modules`).

- [ ] **Step 7: Move the preview Rust unit tests**

The copied `preview_sw/decoder.rs` / `preview_gpu` modules carry their `#[cfg(test)]` blocks with them (e.g. `thread_type_for` tests at `preview_sw/decoder.rs:367-372`) — nothing extra to write; just confirm they came along in the copy.

- [ ] **Step 8: Build + test the component (needs env)**

Run from `apps/desktop` (Git Bash; adjust `FFMPEG_DIR` to the dev machine's shared build until Task 3 fetches the BtbN one):

```bash
export FFMPEG_DIR="$(cygpath -m ~)/AppData/Local/Microsoft/WinGet/Packages"/Gyan.FFmpeg.Shared*/ffmpeg-*-full_build-shared
export LIBCLANG_PATH="C:\\Program Files\\LLVM\\bin"
cargo test --manifest-path native/decode/Cargo.toml
npm run napi:build:decode
```

Expected: tests pass; `native/decode/weftcut-native-decode.win32-x64-msvc.node` (napi names it from `binaryName`) + `index.js` + `index.d.ts` appear. If the glob above doesn't resolve, locate the dir with `ls ~/AppData/Local/Microsoft/WinGet/Packages | grep -i gyan` and export the literal path.

- [ ] **Step 9: Core is untouched — verify**

```bash
cargo test --manifest-path native/Cargo.toml --lib --features jobs,export,mcp,cloud
npm run typecheck
```

Expected: both pass unchanged (core still owns its preview copy; TS still targets `Backend`).

- [ ] **Step 10: Commit**

```bash
git add native/decode native/Cargo.toml package.json .gitignore ../../package-lock.json
git commit -m "feat(decode-engine): scaffold @weftcut/native-decode component crate (D1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Lazy loader + TS rewire + strip preview out of `@weftcut/core`

One atomic task: main-process code switches to the component, THEN core drops its preview surface — a reviewer can't approve one half without the other (stripping first breaks typecheck; rewiring without stripping leaves dead ffmpeg linkage in core).

**Files:**
- Create: `apps/desktop/src/main/native-decode.ts`
- Create: `apps/desktop/src/main/native-decode.test.ts`
- Modify: `apps/desktop/src/main/previewSw.ts` (type import only)
- Modify: `apps/desktop/src/main/previewGpu.ts` (type import only)
- Modify: `apps/desktop/src/main/index.ts:25-38` (loader import), `:200-207` (component construction after backend), `:440-479` (handlers)
- Modify: `apps/desktop/src/preload/index.ts` (add `decodeComponent.status`)
- Modify: `apps/desktop/src/shared/ipc.ts` (Api type + `DecodeComponentStatus`)
- Create: `apps/desktop/src/renderer/settings/decodeComponentStore.ts`
- Modify: `apps/desktop/src/renderer/app/useAppWiring.ts` (wire the store once on mount, same place `wireAppSettingsStream` is called)
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts` + `zh-CN.ts` (`app_notice.native_decode_unavailable`)
- Modify: `apps/desktop/native/Cargo.toml` (delete `preview-gpu`/`preview-sw` features + `ffmpeg-next` + optional `windows` dep)
- Modify: `apps/desktop/native/src/lib.rs:34-39` (delete both module gates)
- Modify: `apps/desktop/native/src/napi_backend.rs` (delete preview fields `:44-63`, wiring `:99-164` preview parts, wire structs `:474-525` + `:660-715`, all four preview impl blocks `:531-658` + `:721-797`)
- Delete: `apps/desktop/native/src/preview_sw/`, `apps/desktop/native/src/preview_gpu/`
- Test: `apps/desktop/src/main/native-decode.test.ts`

**Interfaces:**
- Consumes: `NativeDecode` + `versionInfo()` from `@weftcut/native-decode` (Task 1).
- Produces: `loadNativeDecode(onEvent): NativeDecodeComponent` where `NativeDecodeComponent = { backend: NativeDecode | null; reason: string | null; version: string | null }`; IPC `decodeComponent:status` → `DecodeComponentStatus = { available: boolean; reason: string | null; version: string | null }`; renderer hook `useDecodeComponentAvailable(): boolean` + `useDecodeComponentReason(): string | null` and `wireDecodeComponent(): Promise<void>` (D2's resolver + settings UI consume these); startup notice code `native_decode_unavailable`.

- [ ] **Step 1: Write the failing loader test**

`apps/desktop/src/main/native-decode.test.ts` (vitest; the loader takes an injectable `requireFn` + `dllDir` so tests never touch electron):

```ts
import { describe, expect, it } from "vitest";
import { loadNativeDecodeWith } from "./native-decode";

describe("loadNativeDecodeWith", () => {
  it("returns the backend and version when require succeeds", () => {
    const fakeInstance = { marker: true };
    const mod = {
      NativeDecode: class {
        constructor(public onEvent: unknown) {}
        static instance = fakeInstance;
      },
      versionInfo: () => "avcodec=61 avutil=59",
    };
    const r = loadNativeDecodeWith(() => mod as never, () => {}, null);
    expect(r.backend).not.toBeNull();
    expect(r.version).toBe("avcodec=61 avutil=59");
    expect(r.reason).toBeNull();
  });

  it("degrades to unavailable when require throws (missing DLL)", () => {
    const r = loadNativeDecodeWith(
      () => { throw new Error("The specified module could not be found."); },
      () => {},
      null,
    );
    expect(r.backend).toBeNull();
    expect(r.reason).toContain("could not be found");
    expect(r.version).toBeNull();
  });

  it("prepends the DLL dir to PATH before requiring (Windows contract)", () => {
    const seen: string[] = [];
    const prevPath = process.env.PATH;
    loadNativeDecodeWith(
      () => { seen.push(process.env.PATH ?? ""); throw new Error("stop"); },
      () => {},
      "C:\\bundled\\native-decode",
    );
    expect(seen[0]!.startsWith("C:\\bundled\\native-decode")).toBe(true);
    expect(process.env.PATH).toBe(prevPath); // restored on failure
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/main/native-decode.test.ts` (from `apps/desktop`)
Expected: FAIL — `Cannot find module './native-decode'`.

- [ ] **Step 3: Write the loader**

`apps/desktop/src/main/native-decode.ts`:

```ts
// Level-0 availability gate for the optional @weftcut/native-decode component
// (dual-engine spec §"Conditional first-class"). Main tries the require ONCE in
// a try/catch; failure means the Native decode engine is unavailable — the app
// keeps working, the setting grays out with `reason`, `auto` skips Native tiers.
//
// Why a separate addon: a missing avcodec DLL in a single addon's import table
// would fail the entire require('@weftcut/core') — jobs/export/MCP would die
// with it. Isolation is structural, not optional (docs/adr/0030).
import { createRequire } from 'node:module'
import path from 'node:path'
import type { NativeDecode } from '@weftcut/native-decode'

export type OnComponentEvent = (err: Error | null, json: string) => void

export interface NativeDecodeComponent {
  backend: NativeDecode | null
  reason: string | null
  version: string | null
}

type ComponentModule = typeof import('@weftcut/native-decode')

/// Testable core: injectable require + DLL dir. On Windows the ffmpeg shared
/// DLLs resolve via the process PATH at dlopen time, so prepend the bundled
/// (packaged) / fetched (dev) DLL dir first. PATH is left prepended on success
/// (the addon may lazily load more of the family later) and RESTORED on
/// failure so a broken component can't pollute sidecar ffmpeg resolution.
export function loadNativeDecodeWith(
  requireFn: () => ComponentModule,
  onEvent: OnComponentEvent,
  dllDir: string | null,
): NativeDecodeComponent {
  const prevPath = process.env.PATH
  if (dllDir) process.env.PATH = `${dllDir}${path.delimiter}${prevPath ?? ''}`
  try {
    const mod = requireFn()
    return { backend: new mod.NativeDecode(onEvent), reason: null, version: mod.versionInfo() }
  } catch (e) {
    if (dllDir) process.env.PATH = prevPath
    return { backend: null, reason: e instanceof Error ? e.message : String(e), version: null }
  }
}

let cached: NativeDecodeComponent | null = null

/// Production entry — resolves the DLL dir for the current run mode and
/// memoizes (the component is a singleton like the core backend).
export function loadNativeDecode(onEvent: OnComponentEvent): NativeDecodeComponent {
  if (cached) return cached
  const require_ = createRequire(import.meta.url)
  cached = loadNativeDecodeWith(
    () => require_('@weftcut/native-decode') as ComponentModule,
    onEvent,
    resolveDllDir(),
  )
  return cached
}

function resolveDllDir(): string | null {
  if (process.platform !== 'win32') return null
  // Electron is imported lazily so the pure loader stays test-importable
  // outside an electron process.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native-decode')
    : path.join(app.getAppPath(), 'resources', 'ffmpeg-lgpl', 'win', 'bin')
}
```

Note: if the repo's lint forbids inline `require('electron')`, mirror however `src/main/keys.js` is dynamically imported at `index.ts:210` (`await import(...)`) by making `resolveDllDir` a parameter defaulted at the `loadNativeDecode` call site in `index.ts` — the test seam already supports it.

- [ ] **Step 4: Run the loader tests — pass**

Run: `npx vitest run src/main/native-decode.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Rewire `previewSw.ts` / `previewGpu.ts`**

In both files replace the type import and every `backend: Backend` parameter type:

```ts
// previewSw.ts / previewGpu.ts — was: import type { Backend } from '@weftcut/core'
import type { NativeDecode } from '@weftcut/native-decode'
```

`openPreviewSw(backend: NativeDecode, …)`, `requestFrameAtPreviewSw(backend: NativeDecode, …)`, `closePreviewSw(backend: NativeDecode, …)`, `openPreviewGpu(backend: NativeDecode, …)`, `requestFrameAtPreviewGpu(…)`, `consumeAckPreviewGpu(…)`, `takeTimingsPreviewGpu(…)`, `closePreviewGpu(…)`. Method call sites (`backend.previewSwOpen(...)` etc.) are name-identical — no body changes.

- [ ] **Step 6: Construct the component in `index.ts` and repoint the handlers**

After `await backend.init()` (`index.ts:207-208`), add:

```ts
// Optional native-decode component (level-0 gate). Its events use the same
// {event, payload} envelope as the core backend; relay through evt:* so the
// preload's existing previewGpu listeners keep working unchanged.
const nd = loadNativeDecode((_err, json) => {
  try {
    const { event, payload } = JSON.parse(json) as { event: string; payload: unknown }
    if (event === 'previewGpu:frameReady') {
      const p = payload as { streamId: string; slot: number }
      recordFrameReadySent(p.streamId, p.slot, performance.now())
    }
    mainWindow?.webContents.send('evt:' + event, payload)
  } catch (e) {
    console.warn('[main] native-decode event parse failed', e)
  }
})
if (!nd.backend) {
  console.warn('[main] native-decode component unavailable:', nd.reason)
  startupNotices.push({ level: 'info', code: 'native_decode_unavailable' })
}
const ndBackend = (): NonNullable<typeof nd.backend> => {
  if (!nd.backend) throw new Error('native-decode component unavailable')
  return nd.backend
}
```

Add `import { loadNativeDecode } from './native-decode.js'` next to the `previewSw.js` import at `:25`. `recordFrameReadySent` is already imported for the old relay special-case — after Task 2 the core backend never emits `previewGpu:*`, so DELETE the `if (event === 'previewGpu:frameReady')` special-case from the CORE onEvent closure (`index.ts:200-203`); it lives in the component relay above now.

Repoint every handler at `:440-479`: `openPreviewGpu(backend!, …)` → `openPreviewGpu(ndBackend(), …)`, and the same for `requestFrameAtPreviewGpu`, `consumeAckPreviewGpu`, `closePreviewGpu`, `takeTimingsPreviewGpu`, `openPreviewSw`, `requestFrameAtPreviewSw`, `closePreviewSw`.

Add the status handler next to the previewSw handlers:

```ts
ipcMain.handle('decodeComponent:status', () => ({
  available: !!nd.backend,
  reason: nd.reason,
  version: nd.version,
}))
```

- [ ] **Step 7: Preload + shared type + renderer store**

`apps/desktop/src/shared/ipc.ts` — next to the `previewSw` api block (`:227`):

```ts
/// Availability of the optional @weftcut/native-decode component (level-0
/// gate, dual-engine spec). `reason` is the require error when unavailable.
export interface DecodeComponentStatus {
  available: boolean
  reason: string | null
  version: string | null
}
```

and add to the `Api` interface: `decodeComponent: { status(): Promise<DecodeComponentStatus> }`.

`apps/desktop/src/preload/index.ts` — next to the `previewSw` bridge (`:185-200`):

```ts
decodeComponent: {
  status: () => ipcRenderer.invoke('decodeComponent:status'),
},
```

`apps/desktop/src/renderer/settings/decodeComponentStore.ts`:

```ts
// Renderer mirror of the native-decode component's availability (level-0
// gate). Fetched once on mount — availability can't change within a process
// lifetime (the require is memoized in main).
import { create } from "zustand";
import type { DecodeComponentStatus } from "../../shared/ipc";

interface DecodeComponentState extends DecodeComponentStatus {
  loaded: boolean;
  hydrate: (s: DecodeComponentStatus) => void;
}

export const useDecodeComponentStore = create<DecodeComponentState>((set) => ({
  available: false,
  reason: null,
  version: null,
  loaded: false,
  hydrate: (s) => set({ ...s, loaded: true }),
}));

// Atomic selectors (feedback_zustand_composite_selector).
export const useDecodeComponentAvailable = (): boolean =>
  useDecodeComponentStore((s) => s.available);
export const useDecodeComponentReason = (): string | null =>
  useDecodeComponentStore((s) => s.reason);

export async function wireDecodeComponent(): Promise<void> {
  try {
    const status = await window.api.decodeComponent.status();
    useDecodeComponentStore.getState().hydrate(status);
  } catch (e) {
    console.warn("decodeComponent.status failed:", e);
  }
}
```

Wire `void wireDecodeComponent()` in `apps/desktop/src/renderer/app/useAppWiring.ts` alongside the `wireAppSettingsStream()` call (grep for it there; fire-and-forget, no unlisten needed).

i18n — `en-US.ts` `app_notice` block (after `keyring_unavailable`):

```ts
native_decode_unavailable: {
  title: "Native decode engine unavailable",
  body: "The native decode component (@weftcut/native-decode) failed to load, so previews use the WebCodecs engine only. Reinstall the app to restore it.",
},
```

`zh-CN.ts` mirror:

```ts
native_decode_unavailable: {
  title: "原生解码引擎不可用",
  body: "原生解码组件（@weftcut/native-decode）加载失败，预览将仅使用 WebCodecs 引擎。重新安装应用可恢复。",
},
```

- [ ] **Step 8: Strip core**

- `native/Cargo.toml`: delete the `preview-gpu = [...]` and `preview-sw = [...]` feature lines (`:109-110`), the `ffmpeg-next = { version = "8.1", optional = true }` dep (`:88-90` incl. its comment), and the whole `[target.'cfg(windows)'.dependencies]` block (`:92-96` — `windows` had no other consumer; verify with `grep -rn "windows::" native/src` first; if anything else uses it, keep the dep non-optional instead).
- `native/src/lib.rs`: delete lines `:34-39` (both preview module gates + comment).
- `native/src/napi_backend.rs`: delete the preview fields + doc comments (`:44-63`), the poke/frame-sink wiring in `build_backend` (`:99-164`) and the preview fields from the `Backend { … }` literal (`:181-186`), the wire structs + helpers (`:474-525`, `:611-620`, `:660-715`), and all four preview `impl Backend` blocks (`:531-609`, `:626-658`, `:721-769`, `:775-797`).
- Delete the module dirs: `git rm -r native/src/preview_sw native/src/preview_gpu`.

- [ ] **Step 9: Rebuild both addons + full gates**

```bash
npm run napi:build            # regenerates core index.d.ts WITHOUT preview methods
npm run napi:build:decode
cargo test --manifest-path native/Cargo.toml --lib --features jobs,export,mcp,cloud
cargo test --manifest-path native/decode/Cargo.toml   # (FFMPEG_DIR/LIBCLANG_PATH exported)
npm run typecheck
npm test
```

Expected: all pass. Core's `cargo test` no longer needs (and must not receive) any preview feature.

- [ ] **Step 10: Smoke the app (component present + absent)**

- Present: `npm run dev` → import a ProRes clip, flip the experimental native-SW toggle on, confirm preview works (SW frames flowing = component wired end-to-end).
- Absent: temporarily rename `native/decode/weftcut-native-decode.win32-x64-msvc.node`, `npm run dev` → app boots, an `AppNotices` banner shows "Native decode engine unavailable", nothing else breaks; restore the file.

- [ ] **Step 11: Commit**

```bash
git add src/main/native-decode.ts src/main/native-decode.test.ts src/main/previewSw.ts src/main/previewGpu.ts src/main/index.ts src/preload/index.ts src/shared/ipc.ts src/renderer/settings/decodeComponentStore.ts src/renderer/app/useAppWiring.ts src/renderer/i18n/locales/en-US.ts src/renderer/i18n/locales/zh-CN.ts native/Cargo.toml native/src/lib.rs native/src/napi_backend.rs
git rm -r native/src/preview_sw native/src/preview_gpu
git commit -m "feat(decode-engine): lazy-load @weftcut/native-decode; core drops ffmpeg-next (D1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: `fetch-ffmpeg-lgpl.mjs` + banner gate + build wrapper

**Files:**
- Create: `apps/desktop/scripts/fetch-ffmpeg-lgpl.mjs`
- Create: `apps/desktop/scripts/napi-build-decode.mjs`
- Modify: `apps/desktop/package.json` (scripts `fetch-ffmpeg-lgpl` + replace raw `napi:build:decode`)
- Modify: `apps/desktop/.gitignore` (`resources/ffmpeg-lgpl/`)

**Interfaces:**
- Produces: `resources/ffmpeg-lgpl/win/{bin,include,lib}` (full BtbN LGPL shared build; `bin/*.dll` ship, `include/`+`lib/` are FFMPEG_DIR for building) + `resources/ffmpeg-lgpl/win/manifest.json` (`{ asset, url, sha256, configuration, fetchedAt }`); `npm run napi:build:decode` works with zero exported env when the fetch has run.

- [ ] **Step 1: Write the fetch script**

`apps/desktop/scripts/fetch-ffmpeg-lgpl.mjs` (mirrors `fetch-ffmpeg.mjs`'s download/retry/size-validate pattern — BtbN `latest` is a ROLLING source like the Linux sidecar fetch, so no pinned sha; the banner gate is the integrity check that matters):

```js
// Downloads the BtbN LGPL SHARED ffmpeg build (Windows x64) into
// resources/ffmpeg-lgpl/win/. This is the DISTRIBUTION decode runtime for
// @weftcut/native-decode: bin/*.dll ship as extraResources; include/ + lib/
// serve as FFMPEG_DIR for building the addon (CI + fresh dev machines).
//
// LICENSING GATE (project_ffmpeg_licensing): the shipped DLLs must be LGPL.
// Gyan's full_build-shared (the historical dev FFMPEG_DIR) is GPL and must
// never ship. This script asserts the build banner contains neither
// --enable-gpl nor --enable-nonfree and records it in manifest.json; the
// packaging step re-asserts from that manifest.
import { existsSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

// n8.1 matches the crate pin ffmpeg-next = "8.1" (decode/Cargo.toml).
const ASSET = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip'
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${ASSET}`
const INNER = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1' // top dir inside the zip
const MIN_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_ATTEMPTS = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const dest = join(HERE, '..', 'resources', 'ffmpeg-lgpl', 'win')
const manifestPath = join(dest, 'manifest.json')

/** Pure gate, exported for reuse by napi-build-decode.mjs and the packaging
 *  assert: throws unless the ffmpeg configuration banner is LGPL-clean. */
export function assertLgplBanner(configuration) {
  if (!configuration || typeof configuration !== 'string') {
    throw new Error('ffmpeg-lgpl: empty configuration banner')
  }
  for (const forbidden of ['--enable-gpl', '--enable-nonfree']) {
    if (configuration.includes(forbidden)) {
      throw new Error(`ffmpeg-lgpl: banner contains ${forbidden} — this build must NOT ship`)
    }
  }
  if (!configuration.includes('--enable-shared')) {
    throw new Error('ffmpeg-lgpl: not a shared build (no DLLs to bundle)')
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('fetch-ffmpeg-lgpl: Windows-only (component ships on Windows in v1); skipping.')
    return
  }
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assertLgplBanner(m.configuration) // re-assert even on the cached copy
    console.log(`ffmpeg-lgpl already present (${m.asset}); banner clean.`)
    return
  }
  mkdirSync(dest, { recursive: true })
  const zipPath = join(tmpdir(), ASSET)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) { console.log(`Retry ${attempt}/${MAX_ATTEMPTS}...`); rmSync(zipPath, { force: true }) }
    try { execSync(`curl -L --progress-bar -o "${zipPath}" "${URL}"`, { stdio: 'inherit' }) } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err
      continue
    }
    let size = 0
    try { size = statSync(zipPath).size } catch { /* missing */ }
    if (size >= MIN_ARCHIVE_BYTES) break
    if (attempt === MAX_ATTEMPTS) throw new Error(`download invalid (${size} bytes) from ${URL}`)
  }
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  console.log('Extracting bin/ + include/ + lib/ ...')
  execSync(`tar -xf "${zipPath}" -C "${tmpdir()}" "${INNER}/bin" "${INNER}/include" "${INNER}/lib" "${INNER}/LICENSE.txt"`, { stdio: 'inherit' })
  for (const part of ['bin', 'include', 'lib', 'LICENSE.txt']) {
    execSync(`robocopy "${join(tmpdir(), INNER, part)}" "${join(dest, part)}" /E /NFL /NDL /NJH /NJS || exit /b 0`, { stdio: 'inherit', shell: 'cmd.exe' })
  }
  // Banner: BtbN shared builds ship ffmpeg.exe in bin/ — run it once, capture
  // the `configuration:` line, gate, and record. The exe itself never ships
  // (extraResources filters to *.dll — Task 4).
  const versionOut = execSync(`"${join(dest, 'bin', 'ffmpeg.exe')}" -version`, { encoding: 'utf8' })
  const configLine = versionOut.split(/\r?\n/).find((l) => l.startsWith('configuration:')) ?? ''
  const configuration = configLine.replace(/^configuration:\s*/, '')
  assertLgplBanner(configuration)
  writeFileSync(manifestPath, JSON.stringify({
    asset: ASSET, url: URL, sha256, configuration,
    fetchedAt: new Date().toISOString(),
  }, null, 2))
  rmSync(zipPath, { force: true })
  console.log(`ffmpeg-lgpl installed: ${dest} (banner clean, sha256 ${sha256.slice(0, 12)}…)`)
}

// Allow `import { assertLgplBanner }` without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
```

Note `robocopy`'s exit codes 0–7 mean success — hence the `|| exit /b 0` guard; if robocopy proves awkward under the sandbox, replace with `fs.cpSync(src, dst, { recursive: true })` in-node (preferred if you touch it at all).

- [ ] **Step 2: Write the build wrapper**

`apps/desktop/scripts/napi-build-decode.mjs`:

```js
// Builds @weftcut/native-decode with the env ffmpeg-next needs. Precedence:
// explicit FFMPEG_DIR env > fetched resources/ffmpeg-lgpl/win (canonical).
// LIBCLANG_PATH defaults to the standard LLVM install (dev + windows-latest CI).
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { assertLgplBanner } from './fetch-ffmpeg-lgpl.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const lgplDir = join(HERE, '..', 'resources', 'ffmpeg-lgpl', 'win')

const env = { ...process.env }
if (!env.FFMPEG_DIR) {
  const manifest = join(lgplDir, 'manifest.json')
  if (!existsSync(manifest)) {
    console.error('napi:build:decode — set FFMPEG_DIR or run `npm run fetch-ffmpeg-lgpl` first.')
    process.exit(1)
  }
  assertLgplBanner(JSON.parse(readFileSync(manifest, 'utf8')).configuration)
  env.FFMPEG_DIR = lgplDir
}
if (process.platform === 'win32' && !env.LIBCLANG_PATH) {
  env.LIBCLANG_PATH = 'C:\\Program Files\\LLVM\\bin'
}
execSync(
  'napi build --platform --release --manifest-path native/decode/Cargo.toml --output-dir native/decode',
  { stdio: 'inherit', env, cwd: join(HERE, '..') },
)
```

- [ ] **Step 3: Wire the scripts**

`apps/desktop/package.json`:
- Add `"fetch-ffmpeg-lgpl": "node scripts/fetch-ffmpeg-lgpl.mjs"`.
- Replace the Task-1 raw `napi:build:decode` value with `"node scripts/napi-build-decode.mjs"`.

`apps/desktop/.gitignore`: add `resources/ffmpeg-lgpl/` (next to the existing resources ignore lines — check how `resources/ffmpeg` is ignored and mirror).

- [ ] **Step 4: Run it end-to-end**

```bash
npm run fetch-ffmpeg-lgpl        # downloads ~90MB, extracts, asserts banner, writes manifest
cat resources/ffmpeg-lgpl/win/manifest.json   # eyeball: configuration has --enable-shared, no --enable-gpl
npm run napi:build:decode        # builds against the fetched BtbN dir with NO exported env
```

Expected: manifest written; build succeeds. Then rebuild-sanity the runtime pairing: `npm run dev`, confirm ProRes SW preview still works — the loader (Task 2) prepends `resources/ffmpeg-lgpl/win/bin`, so the app now runs on the BtbN LGPL DLLs, not Gyan's.

- [ ] **Step 5: Negative-test the gate**

```bash
node -e "import('./scripts/fetch-ffmpeg-lgpl.mjs').then(m => { try { m.assertLgplBanner('--enable-gpl --enable-shared'); console.log('BUG: passed'); } catch (e) { console.log('OK rejected:', e.message); } })"
```

Expected: `OK rejected: … --enable-gpl …`.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-ffmpeg-lgpl.mjs scripts/napi-build-decode.mjs package.json .gitignore
git commit -m "feat(decode-engine): BtbN LGPL DLL fetch with banner gate + component build wrapper (D1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Installer packaging (Windows bundles the component + DLLs)

**Files:**
- Modify: `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: `resources/ffmpeg-lgpl/win/bin/*.dll` + `LICENSE.txt` + `manifest.json` (Task 3), the built `native/decode/*.node` (Task 1).
- Produces: packaged app with `resources/native-decode/{*.dll,LICENSE.txt,manifest.json}` and the component `.node` asar-unpacked — matching the loader's `process.resourcesPath + '/native-decode'` (Task 2).

- [ ] **Step 1: Whitelist the component package in `files`**

Mirror the existing `@weftcut/core` pattern exactly — add after the core entries:

```yaml
  - "!**/node_modules/@weftcut/native-decode/**"
  - "**/node_modules/@weftcut/native-decode/index.js"
  - "**/node_modules/@weftcut/native-decode/index.d.ts"
  - "**/node_modules/@weftcut/native-decode/*.node"
```

(`asarUnpack: "**/*.node"` already covers the second binary.)

- [ ] **Step 2: Ship the DLLs as Windows-only extraResources**

Add a per-platform block (electron-builder merges `win.extraResources` with the top-level list):

```yaml
win:
  target:
    - nsis
  icon: build/icon-256.png
  extraResources:
    # LGPL ffmpeg runtime for @weftcut/native-decode (dynamic linking + separate
    # files satisfies LGPL §6; LICENSE + manifest.json carry the notice + exact
    # source pointer). *.dll only — the exes in bin/ are fetch-time tooling.
    - from: resources/ffmpeg-lgpl/win/bin
      to: native-decode
      filter: ["*.dll"]
    - from: resources/ffmpeg-lgpl/win/LICENSE.txt
      to: native-decode/LICENSE.txt
    - from: resources/ffmpeg-lgpl/win/manifest.json
      to: native-decode/manifest.json
```

(The `win:` key already exists with `target`/`icon` — merge these `extraResources` INTO it rather than duplicating the key.)

- [ ] **Step 3: Package smoke (local, Windows)**

```bash
npm run napi:build && npm run napi:build:decode && npm run build && npx electron-builder --publish never
```

Expected: exits 0. Then verify the layout and the installed app:

```bash
ls dist/win-unpacked/resources/native-decode/          # avcodec-*.dll avutil-*.dll … LICENSE.txt manifest.json
ls dist/win-unpacked/resources/app.asar.unpacked/node_modules/@weftcut/native-decode/
./dist/win-unpacked/WeftCut.exe                        # (binary name per productName) — import ProRes, confirm SW preview
```

If the unpacked exe name differs, read it from `electron-builder.yml`'s `productName`.

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml
git commit -m "feat(decode-engine): Windows installer bundles native-decode + LGPL DLLs (D1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: CI — build + test the component on Windows

Per the spec (§Build/CI): CI is headless so the GPU lane can never run there; the component build + its cargo tests (SW-lane units) run on the Windows leg. macOS/Linux stay untouched (v1 ships the component on Windows only).

**Files:**
- Modify: `.github/workflows/electron-ci.yml`
- Modify: `docs/decode-bench.md` (build recipe section, ~lines 206-212)

- [ ] **Step 1: Add the CI steps (Windows leg only)**

After the existing `Fetch ffmpeg` / PATH steps (`:110-124`) and BEFORE `Build app (E2E mode)`:

```yaml
      # ── @weftcut/native-decode (Windows only; v1 distribution scope) ──
      - name: Cache ffmpeg-lgpl
        if: runner.os == 'Windows'
        uses: actions/cache@v5
        with:
          path: apps/desktop/resources/ffmpeg-lgpl
          key: ffmpeg-lgpl-${{ runner.os }}-${{ hashFiles('apps/desktop/scripts/fetch-ffmpeg-lgpl.mjs') }}

      - name: Fetch LGPL ffmpeg (native-decode)
        if: runner.os == 'Windows'
        run: npm run fetch-ffmpeg-lgpl

      - name: Build native-decode addon
        if: runner.os == 'Windows'
        run: npm run napi:build:decode
        # windows-latest ships LLVM at C:\Program Files\LLVM; the wrapper
        # defaults LIBCLANG_PATH there and FFMPEG_DIR to the fetched dir.

      - name: Put LGPL DLLs on PATH (native-decode runtime)
        if: runner.os == 'Windows'
        shell: bash
        run: cygpath -w "$PWD/resources/ffmpeg-lgpl/win/bin" >> "$GITHUB_PATH"
```

And inside the existing `Rust tests` step's script (`:140-153`), append a Windows-only line after the core cargo test:

```bash
          if [ "$RUNNER_OS" = "Windows" ]; then
            # Component crate: no cargo features (union rule is per-addon).
            FFMPEG_DIR="$(cygpath -m "$PWD")/resources/ffmpeg-lgpl/win" \
            LIBCLANG_PATH="C:\\Program Files\\LLVM\\bin" \
            cargo test --manifest-path native/decode/Cargo.toml
          fi
```

- [ ] **Step 2: Typecheck needs the component's `index.d.ts` — Linux/macOS legs**

`npm run typecheck` runs on the Linux leg (`:88-90`) and `src/main/native-decode.ts` imports `@weftcut/native-decode` types. The component doesn't build on Linux (no FFMPEG_DIR). Fix: generate the `.d.ts` without compiling — napi-rs v3 cannot emit types without a build, so instead make the TYPE dependency buildless: in `native/decode/package.json` `files`, nothing changes; in the repo, commit a hand-written fallback `apps/desktop/native/decode/index-fallback.d.ts` is drift-prone — REJECT. The robust fix: the two type-only import sites (`native-decode.ts`, `previewSw.ts`, `previewGpu.ts`) already compile against the GENERATED `.d.ts`; on legs that never build the component, generate it cheaply by running the component build… which needs ffmpeg. Simplest correct answer, and what this step does: run `npm run fetch-ffmpeg-lgpl` + `napi:build:decode` ONLY on Windows, and MOVE the typecheck + vitest steps from the Linux leg to the Windows leg:

```yaml
      - name: Typecheck (tsc -b)
        if: runner.os == 'Windows'
        run: npm run typecheck

      - name: Unit tests (vitest)
        if: runner.os == 'Windows'
        run: npm test
```

Update the comment above them (`:82-87`): "run once on the Windows leg — the only leg that builds BOTH addons (native-decode's generated index.d.ts is a typecheck input)."

- [ ] **Step 3: Update the decode-bench build recipe**

`docs/decode-bench.md` (~lines 206-212) still documents building core with `--features …,preview-gpu`. Rewrite that block: the native strategies now come from the component — `npm run fetch-ffmpeg-lgpl && npm run napi:build:decode` (plus `npm run napi:build` for core), DLL dir on PATH note now points at `resources/ffmpeg-lgpl/win/bin`.

- [ ] **Step 4: Verify + commit + watch CI later**

Local YAML sanity: `npx yaml-lint .github/workflows/electron-ci.yml 2>/dev/null || node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/electron-ci.yml','utf8')); console.log('yaml ok')"` (js-yaml ships with electron-builder's dep tree). CI itself validates on the eventual push — this repo's pattern is local-merge, push later; note it in the PR/merge summary.

```bash
git add ../../.github/workflows/electron-ci.yml docs/decode-bench.md
git commit -m "ci(decode-engine): build + test @weftcut/native-decode on the Windows leg (D1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: D1 verification — e2e parity on the component build

No new code — prove the moved runtime behaves identically before D2 builds on it. (The two preview-sw specs still flip `experimental_native_sw_decode`; that setting survives until Task 8.)

- [ ] **Step 1: Full e2e-prep build**

```bash
npm run napi:build && npm run napi:build:decode && npm run fetch-ffmpeg && npm run fetch-ffmpeg-lgpl
VITE_WEFTCUT_E2E=1 npm run build
```

- [ ] **Step 2: Run the SW-lane specs**

```bash
npx playwright test e2e/electron/preview-sw-families.spec.ts e2e/electron/preview-sw-conformance.spec.ts
```

Expected: PASS (same cells as pre-split). Any failure here is a Task-1/2 transplant defect — fix before proceeding (likely suspects: event envelope drift, per-stream TSFN registration order, DLL PATH in the packaged-vs-dev loader branch).

- [ ] **Step 3: decode-bench spot-check (native lanes still drivable)**

```bash
node e2e/scripts/decode-bench.mjs --self-check
```

Expected: self-check passes (the bench acquires `forceStrategy:'native'`/`'sw'` handles through the same rewired main-process managers).

- [ ] **Step 4: Commit any doc-only fixups; tag the stage**

```bash
git commit --allow-empty -m "test(decode-engine): D1 parity verified — component build passes preview-sw e2e + bench self-check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Stage D2 — engine resolution module + `decode_engine` setting

**Stage outcome:** one pure resolver decides the per-source tier; `decode_engine` (auto/native/webcodecs) replaces `experimental_native_sw_decode`; **auto tier 2 ends the 720p-proxy-default era** (probe-passing sources preview their originals); the Compositor swap machinery is keyed on the resolved identity, ready for D4's downgrades. Proxy JOBS still auto-enqueue (that flip is D6) — they're just no longer what preview shows for tier-0/1/2/3 sources.

### Task 7: `decodeEngine.ts` — the pure resolution module

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/decodeEngine.ts`
- Test: `apps/desktop/src/renderer/render/decoder/decodeEngine.test.ts`

**Interfaces:**
- Consumes: `DecodeRoute` from `../../../shared/decode-route`.
- Produces (Tasks 8-10, 14, 17-18 rely on these exact names):
  - `type DecodeEngineSetting = "auto" | "native" | "webcodecs"`
  - `type LaneState = "ok" | "fail" | "untested" | "unavailable"`
  - `type EngineTier = "native-hw" | "webcodecs-original" | "native-sw" | "proxy"`
  - `interface EngineInputs { setting: DecodeEngineSetting; componentAvailable: boolean; media: { path: string; decode_route: DecodeRoute }; webcodecsOriginal: LaneState; nativeHw: LaneState; nativeSw: LaneState; downgraded?: ReadonlySet<EngineTier>; proxyPreviewPath: string | null }`
  - `interface ResolvedSource { tier: EngineTier; forceStrategy?: "native" | "software"; sourcePath?: string; url: string | null; key: string | null; reason: string }` — `url` is a raw FILE PATH here; the caller converts with `convertFileSrc` (keeps the module pure/testable). `key` is the swap identity `` `${tier}:${sourcePath ?? url}` `` and is `null` exactly when the tier has nothing acquirable yet (proxy still building).
  - `function resolveEngineTier(i: EngineInputs): ResolvedSource`

- [ ] **Step 1: Write the failing tests**

`decodeEngine.test.ts` — the decision-table contract, spec §"auto decision table" + §"User surface":

```ts
import { describe, expect, it } from "vitest";
import { resolveEngineTier, type EngineInputs } from "./decodeEngine";

const bypassRoute = { route: "bypass" } as never;
const nativeSwRoute = {
  route: "native-sw", quick_proxy: null, full_proxy: null, format_version: 1,
} as never;

function base(over: Partial<EngineInputs>): EngineInputs {
  return {
    setting: "auto",
    componentAvailable: true,
    media: { path: "C:/src/a.mov", decode_route: bypassRoute },
    webcodecsOriginal: "untested",
    nativeHw: "unavailable",
    nativeSw: "untested",
    proxyPreviewPath: null,
    ...over,
  };
}

describe("resolveEngineTier — auto", () => {
  it("tier 1: native HW wins when its probe passed", () => {
    const r = resolveEngineTier(base({ nativeHw: "ok", webcodecsOriginal: "ok" }));
    expect(r).toMatchObject({ tier: "native-hw", forceStrategy: "native", sourcePath: "C:/src/a.mov", url: null });
    expect(r.key).toBe("native-hw:C:/src/a.mov");
  });
  it("tier 2: WebCodecs decodes the original when HW is out", () => {
    const r = resolveEngineTier(base({ webcodecsOriginal: "ok" }));
    expect(r).toMatchObject({ tier: "webcodecs-original", url: "C:/src/a.mov" });
    expect(r.forceStrategy).toBeUndefined();
  });
  it("tier 3: native SW when 1-2 are out", () => {
    const r = resolveEngineTier(base({ nativeSw: "ok" }));
    expect(r).toMatchObject({ tier: "native-sw", forceStrategy: "software", sourcePath: "C:/src/a.mov" });
  });
  it("tier 4: proxy fallback carries the proxy path (or null while building)", () => {
    expect(resolveEngineTier(base({ proxyPreviewPath: "C:/cache/p.mp4" }))).toMatchObject({
      tier: "proxy", url: "C:/cache/p.mp4", key: "proxy:C:/cache/p.mp4",
    });
    expect(resolveEngineTier(base({}))).toMatchObject({ tier: "proxy", url: null, key: null });
  });
  it("tier 0: component missing skips BOTH native tiers", () => {
    const r = resolveEngineTier(base({ componentAvailable: false, nativeHw: "ok", nativeSw: "ok" }));
    expect(r.tier).toBe("proxy");
    expect(r.reason).toContain("component");
  });
});

describe("resolveEngineTier — forced engines", () => {
  it("native: HW → SW → only then the WebCodecs machinery", () => {
    expect(resolveEngineTier(base({ setting: "native", nativeHw: "ok" })).tier).toBe("native-hw");
    expect(resolveEngineTier(base({ setting: "native", nativeSw: "ok" })).tier).toBe("native-sw");
    // both native lanes out → falls to WebCodecs-original, then proxy
    expect(resolveEngineTier(base({ setting: "native", webcodecsOriginal: "ok" })).tier).toBe("webcodecs-original");
    expect(resolveEngineTier(base({ setting: "native" })).tier).toBe("proxy");
  });
  it("webcodecs: skips tiers 1 and 3 even when they'd pass", () => {
    const r = resolveEngineTier(base({ setting: "webcodecs", nativeHw: "ok", nativeSw: "ok", webcodecsOriginal: "ok" }));
    expect(r.tier).toBe("webcodecs-original");
    expect(resolveEngineTier(base({ setting: "webcodecs", nativeHw: "ok", nativeSw: "ok" })).tier).toBe("proxy");
  });
});

describe("resolveEngineTier — sticky downgrade", () => {
  it("skips a downgraded tier for the rest of the session", () => {
    const r = resolveEngineTier(base({
      nativeHw: "ok", webcodecsOriginal: "ok",
      downgraded: new Set(["native-hw"] as const),
    }));
    expect(r.tier).toBe("webcodecs-original");
    expect(r.reason).toContain("downgraded");
  });
});

describe("resolveEngineTier — native-sw never auto-swaps to a landed proxy", () => {
  it("keeps tier native-sw when a quick proxy exists (feedback_native_nle_conventions)", () => {
    const r = resolveEngineTier(base({
      media: { path: "C:/src/p.mov", decode_route: nativeSwRoute },
      nativeSw: "ok", proxyPreviewPath: "C:/cache/quick.mp4",
    }));
    expect(r.tier).toBe("native-sw");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/render/decoder/decodeEngine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

`decodeEngine.ts`:

```ts
// The decode-engine overlay's resolution module (dual-engine spec §"Decode
// engine", ADR 0030). PURE — a function of (setting × component availability ×
// lane states × read-only route); no store reads, no probes, no hidden state
// (spec Risk 4: any state added here re-grows the preset maze). Callers gather
// inputs (PixiPreview) and act on the output (Compositor ensureClip).
import type { DecodeRoute } from "../../../shared/decode-route";

export type DecodeEngineSetting = "auto" | "native" | "webcodecs";
export type LaneState = "ok" | "fail" | "untested" | "unavailable";
export type EngineTier = "native-hw" | "webcodecs-original" | "native-sw" | "proxy";

export interface EngineInputs {
  setting: DecodeEngineSetting;
  componentAvailable: boolean;
  media: { path: string; decode_route: DecodeRoute };
  /// Session probe verdict for WebCodecs-decoding the ORIGINAL (tier 2).
  webcodecsOriginal: LaneState;
  /// Machine capability verdicts (capability cache). D2 seeds nativeSw from
  /// the persisted route and pins nativeHw "unavailable"; D3/D4 wire probes.
  nativeHw: LaneState;
  nativeSw: LaneState;
  /// Tiers knocked out this session by runtime failure (P3 sticky downgrade).
  downgraded?: ReadonlySet<EngineTier>;
  /// resolveDecode(media).previewPath — tier 4's decode target (null = building).
  proxyPreviewPath: string | null;
}

export interface ResolvedSource {
  tier: EngineTier;
  /// SourceDecoderPool strategy; undefined = WebCodecs.
  forceStrategy?: "native" | "software";
  /// Original file path for the native lanes (the pool decodes this, not url).
  sourcePath?: string;
  /// WebCodecs decode FILE PATH (original or proxy); caller convertFileSrc's it.
  url: string | null;
  /// Swap identity: `${tier}:${target}`; null when nothing is acquirable yet.
  key: string | null;
  /// Human-readable decision trail (LogBus).
  reason: string;
}

export function resolveEngineTier(i: EngineInputs): ResolvedSource {
  const down = i.downgraded ?? new Set<EngineTier>();
  const trail: string[] = [];
  const usable = (tier: EngineTier, lane: LaneState): boolean => {
    if (down.has(tier)) { trail.push(`${tier}: downgraded`); return false; }
    if (lane !== "ok") { trail.push(`${tier}: ${lane}`); return false; }
    return true;
  };

  const nativeAllowed = i.setting !== "webcodecs";
  const componentOk = i.componentAvailable;
  if (nativeAllowed && !componentOk) trail.push("native tiers: component unavailable");

  // Tier order per setting (spec: auto = 1→2→3→4; native = 1→3→2→4; webcodecs = 2→4).
  const order: EngineTier[] =
    i.setting === "native"
      ? ["native-hw", "native-sw", "webcodecs-original", "proxy"]
      : i.setting === "webcodecs"
        ? ["webcodecs-original", "proxy"]
        : ["native-hw", "webcodecs-original", "native-sw", "proxy"];

  for (const tier of order) {
    switch (tier) {
      case "native-hw":
        if (componentOk && usable("native-hw", i.nativeHw)) {
          return done("native-hw", { forceStrategy: "native", sourcePath: i.media.path, url: null });
        }
        break;
      case "webcodecs-original":
        if (usable("webcodecs-original", i.webcodecsOriginal)) {
          return done("webcodecs-original", { url: i.media.path });
        }
        break;
      case "native-sw":
        if (componentOk && usable("native-sw", i.nativeSw)) {
          return done("native-sw", { forceStrategy: "software", sourcePath: i.media.path, url: null });
        }
        break;
      case "proxy":
        return done("proxy", { url: i.proxyPreviewPath });
    }
  }
  // order always ends in "proxy" — unreachable, but keep TS satisfied.
  return done("proxy", { url: i.proxyPreviewPath });

  function done(
    tier: EngineTier,
    t: { forceStrategy?: "native" | "software"; sourcePath?: string; url: string | null },
  ): ResolvedSource {
    const target = t.sourcePath ?? t.url;
    return {
      tier,
      ...t,
      key: target ? `${tier}:${target}` : null,
      reason: trail.length ? `${tier} (skipped: ${trail.join("; ")})` : tier,
    };
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `npx vitest run src/renderer/render/decoder/decodeEngine.test.ts`
Expected: all pass. Also `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/render/decoder/decodeEngine.ts src/renderer/render/decoder/decodeEngine.test.ts
git commit -m "feat(decode-engine): pure engine-resolution module with tiered fallback (D2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: `decode_engine` setting replaces `experimental_native_sw_decode`

**Files:**
- Modify: `apps/desktop/src/shared/app-settings.ts`
- Modify: `apps/desktop/src/main/app-settings.ts` (+ its existing colocated tests if present — `ls src/main/app-settings*.test.ts`)
- Modify: `apps/desktop/src/renderer/settings/appSettingsStore.ts`
- Modify: `apps/desktop/src/renderer/settings/SettingsPanel.tsx:461-483` (+ its import of `useNativeSwDecodeEnabled`)
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts:529-532`, `zh-CN.ts:516-519`
- Modify: `apps/desktop/e2e/electron/preview-sw-families.spec.ts:50-53,:133`, `preview-sw-conformance.spec.ts:83-91,:234,:255-257,:337`

**Interfaces:**
- Consumes: `DecodeEngineSetting` (Task 7), `useDecodeComponentAvailable`/`useDecodeComponentReason` (Task 2).
- Produces: `AppSettings.decode_engine: DecodeEngineSetting` (default `"auto"`), `useDecodeEngine(): DecodeEngineSetting` selector, i18n keys `settings.decode_engine`, `settings.decode_engine_hint`, `settings.decode_engine_auto|native|webcodecs`, `settings.decode_engine_unavailable`. `experimental_native_sw_decode` and `useNativeSwDecodeEnabled` are GONE from the codebase (grep-clean).

- [ ] **Step 1: Schema**

`shared/app-settings.ts`: replace the `experimental_native_sw_decode` field, patch entry, and default with:

```ts
/// Preview decode engine (dual-engine spec): `auto` resolves the fastest
/// available tier per source (native HW → WebCodecs-original → native SW →
/// proxy); `native`/`webcodecs` pin an engine. Replaces the deleted
/// `experimental_native_sw_decode` (its semantics live inside `auto`).
decode_engine: "auto" | "native" | "webcodecs";
```

Patch: `decode_engine?: "auto" | "native" | "webcodecs";` — default: `decode_engine: "auto"`.

- [ ] **Step 2: Main store reader/writer**

`main/app-settings.ts`: in `read()` replace the old field's line with:

```ts
decode_engine: parsed.decode_engine === 'native' || parsed.decode_engine === 'webcodecs' || parsed.decode_engine === 'auto' ? parsed.decode_engine : d.decode_engine,
```

In `apply()` replace the old field's line with:

```ts
if (patch.decode_engine !== undefined) current.decode_engine = patch.decode_engine
```

(An old `app_settings.json` containing `experimental_native_sw_decode` keeps loading — unknown keys are ignored by design; note there is deliberately NO migration of `true` → `"native"`: the old toggle's behavior is a subset of the new default `auto`.)

- [ ] **Step 3: Renderer store**

`appSettingsStore.ts`: update `FALLBACK` (drop old field, add `decode_engine: "auto"`), replace the selector:

```ts
export const useDecodeEngine = (): AppSettings["decode_engine"] =>
  useAppSettingsStore((s) => s.settings.decode_engine);
```

- [ ] **Step 4: Settings UI**

Replace `NativeSwSection` in `SettingsPanel.tsx` (imports: swap `useNativeSwDecodeEnabled` for `useDecodeEngine`; add `AppSelect` from `../components/AppSelect` — copy its exact usage shape from `ExportSettingsDialog.tsx:388`; add the two decode-component hooks):

```tsx
function DecodeEngineSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const engine = useDecodeEngine();
  const componentAvailable = useDecodeComponentAvailable();
  const componentReason = useDecodeComponentReason();
  return (
    <label className="settings-toggle-row">
      <AppSelect
        value={engine}
        onValueChange={async (next) => {
          onError("");
          try {
            await setAppSettings({ decode_engine: next as "auto" | "native" | "webcodecs" });
          } catch (err) {
            onError(String(err));
          }
        }}
        options={[
          { value: "auto", label: t("settings.decode_engine_auto") },
          {
            value: "native",
            label: t("settings.decode_engine_native"),
            disabled: !componentAvailable,
          },
          { value: "webcodecs", label: t("settings.decode_engine_webcodecs") },
        ]}
      />
      <span>
        <span className="settings-toggle-label">{t("settings.decode_engine")}</span>
        <span className="settings-toggle-hint">
          {componentAvailable
            ? t("settings.decode_engine_hint")
            : t("settings.decode_engine_unavailable", { reason: componentReason ?? "" })}
        </span>
      </span>
    </label>
  );
}
```

`AppSelect`'s real prop names may differ (options/items, onValueChange/onChange, per-option `disabled`) — match `ExportSettingsDialog.tsx`'s usage EXACTLY; if per-option disabling isn't supported, render the native option with a " — unavailable" suffix and guard in the handler (`if (next === 'native' && !componentAvailable) return`). Update the `<NativeSwSection …/>` render site to `<DecodeEngineSection …/>` — it stays under the "Experimental" heading? NO — this is no longer experimental: move the render site OUT of the Experimental block to sit right below it as its own row, and delete the Experimental heading only if this was its sole child (check `:225` context; if `experimental_heading` loses all children, remove the heading + both locales' key).

i18n `en-US.ts` (replace `native_sw_decode`/`_hint`):

```ts
decode_engine: "Preview decode engine",
decode_engine_hint:
  "Auto picks the fastest engine per clip (native hardware → WebCodecs on the original → native software → proxy). Pin an engine to override.",
decode_engine_auto: "Auto (recommended)",
decode_engine_native: "Native (FFmpeg)",
decode_engine_webcodecs: "WebCodecs",
decode_engine_unavailable: "Native engine unavailable: {{reason}}",
```

`zh-CN.ts`:

```ts
decode_engine: "预览解码引擎",
decode_engine_hint:
  "自动模式按素材选择最快的引擎（原生硬件 → WebCodecs 直解原片 → 原生软件 → 代理）。也可固定某个引擎。",
decode_engine_auto: "自动（推荐）",
decode_engine_native: "原生（FFmpeg）",
decode_engine_webcodecs: "WebCodecs",
decode_engine_unavailable: "原生引擎不可用：{{reason}}",
```

- [ ] **Step 5: e2e specs**

In both preview-sw specs, replace every `{ experimental_native_sw_decode: true }` patch with `{ decode_engine: 'native' }`, `…: false` with `{ decode_engine: 'auto' }`, and the assertion lines with `expect(after.decode_engine).toBe('native')`. Update the `:83` comment in the conformance spec ("The Compositor reads `experimental_native_sw_decode` live…" → "Engine resolution reads `decode_engine` live at acquire…"). NOTE: these specs stay red until Task 9 wires the resolver (the old `nativeSwSourceFor` gate reads the deleted flag) — Task 9's gate re-runs them; that's the expected mid-stage state, which is why Tasks 8+9 land back-to-back before any push.

- [ ] **Step 6: Purge check + unit gates**

```bash
grep -rn "experimental_native_sw_decode\|useNativeSwDecodeEnabled" src e2e && echo "LEFTOVERS" || echo "clean"
npm run typecheck && npm test
```

Expected: `clean`; typecheck+vitest pass (the ONLY remaining consumer, `PixiPreview.tsx:163`, is rewritten in this step's typecheck scope — if typecheck flags it, apply Task 9's PixiPreview change first and land both tasks as one commit train).

- [ ] **Step 7: Commit**

```bash
git add src/shared/app-settings.ts src/main/app-settings.ts src/renderer/settings/appSettingsStore.ts src/renderer/settings/SettingsPanel.tsx src/renderer/i18n/locales/en-US.ts src/renderer/i18n/locales/zh-CN.ts e2e/electron/preview-sw-families.spec.ts e2e/electron/preview-sw-conformance.spec.ts
git commit -m "feat(decode-engine): decode_engine setting replaces experimental_native_sw_decode (D2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9: Wire the resolver through PixiPreview + Compositor

The load-bearing task of D2. `nativeSwSourceFor` + the `previewPathLive` bridge collapse into one injected `resolveSource`; `ActiveClip.builtFromUrl`/`isSoftware` become `builtFromKey`; the no-flash swap keys on resolved identity (so proxy-landing can never displace a native/original tier, and D4's downgrades ride the same trigger).

**Files:**
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx:137-185`
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (init fields ~`:194-197`/`:353`/`:486`; `ensureClip` `:1445-1543`; `SwapState`/`beginSwap`/`pollSwap`/`completeSwap` `:238-248`/`:1549-1639`; `ActiveClip` fields `:221-236`)
- Modify: `apps/desktop/src/renderer/render/decodeRoute.ts` (delete `previewPathLive`)
- Modify: `apps/desktop/src/renderer/app/useImportReadiness.ts` (keep `decodeProbeMemo` + `refreshSources`; delete only the `previewPathLive` import if it has one — check)
- Create: `apps/desktop/src/renderer/render/decoder/decodeCapability.ts` (D2 scope: session lane-state maps + LogBus trail; D3 adds probe kicks)

**Interfaces:**
- Consumes: `resolveEngineTier`/`ResolvedSource`/`EngineInputs` (Task 7), `useDecodeEngine` (Task 8), `useDecodeComponentStore` (Task 2), `resolveDecode` (existing), `logEmit` + `LogEntryInput` (`renderer/ipc/index.ts:1368-1398`).
- Produces: Compositor init field `resolveSource?: (mediaId: string) => ResolvedRendererSource | null` where `ResolvedRendererSource = { tier: EngineTier; forceStrategy?: "native" | "software"; sourcePath?: string; assetUrl: string | null; key: string | null }` (assetUrl = ALREADY `convertFileSrc`'d); `ActiveClip.builtFromKey: string`; `decodeCapability.ts` exports `laneStatesFor(mediaId, media): { webcodecsOriginal: LaneState; nativeHw: LaneState; nativeSw: LaneState; downgraded: ReadonlySet<EngineTier> }`, `markDowngraded(mediaId, tier, reason)` (D4 calls this), `noteResolution(mediaId, r: ResolvedSource)` (LogBus once per media per key).

- [ ] **Step 1: Session capability map + resolution logging**

`decodeCapability.ts`:

```ts
// Session-scoped lane knowledge feeding the pure resolver: probe verdicts
// (WebCodecs tier-2 today; native SW/HW capability arrive in D3/D4), sticky
// runtime downgrades (P3), and once-per-change LogBus resolution logging.
// SESSION state — resets on reload; the persisted machine truth is main's
// capability cache (D3), never this map. Distinct from the (retiring)
// "session bridge" term — see CONTEXT.md.
import { logEmit } from "../../ipc";
import type { EngineTier, LaneState, ResolvedSource } from "./decodeEngine";

const downgradedByMedia = new Map<string, Set<EngineTier>>();
const swLaneByMedia = new Map<string, LaneState>();   // D3 wires probe results
const hwLaneByMedia = new Map<string, LaneState>();   // D4 wires probe results
const lastLoggedKey = new Map<string, string>();

export function laneStatesFor(
  mediaId: string,
  media: { decode_route?: { route: string } | null },
): { webcodecsOriginal: LaneState; nativeHw: LaneState; nativeSw: LaneState; downgraded: ReadonlySet<EngineTier> } {
  return {
    // Tier 2 comes from the caller's probe memo (PixiPreview passes it in);
    // this placeholder is overridden there — kept so D3/D4 callers can use
    // laneStatesFor alone.
    webcodecsOriginal: "untested",
    nativeHw: hwLaneByMedia.get(mediaId) ?? "unavailable", // D4 flips to probe-driven
    nativeSw:
      swLaneByMedia.get(mediaId) ??
      (media.decode_route?.route === "native-sw" ? "ok" : "untested"), // list seeds the probe (P1)
    downgraded: downgradedByMedia.get(mediaId) ?? new Set(),
  };
}

export function markDowngraded(mediaId: string, tier: EngineTier, reason: string): void {
  let set = downgradedByMedia.get(mediaId);
  if (!set) { set = new Set(); downgradedByMedia.set(mediaId, set); }
  if (set.has(tier)) return;
  set.add(tier);
  void logEmit({
    level: "Warn",
    category: { kind: "Other", name: "decode-engine" },
    source: { kind: "System" },
    message: `decode downgrade: media ${mediaId} tier ${tier} — ${reason}`,
  });
}

/// LogBus trail: one entry per (media, resolved key) change — P3's
/// "every step logged" without per-frame spam.
export function noteResolution(mediaId: string, r: ResolvedSource): void {
  const k = r.key ?? `${r.tier}:pending`;
  if (lastLoggedKey.get(mediaId) === k) return;
  lastLoggedKey.set(mediaId, k);
  void logEmit({
    level: "Info",
    category: { kind: "Other", name: "decode-engine" },
    source: { kind: "System" },
    message: `decode resolution: media ${mediaId} → ${r.reason}`,
  });
}

export function setSwLane(mediaId: string, s: LaneState): void { swLaneByMedia.set(mediaId, s); }
export function setHwLane(mediaId: string, s: LaneState): void { hwLaneByMedia.set(mediaId, s); }

/// Test/e2e hook: forget session verdicts (used by decode-engine.spec.ts).
export function resetDecodeCapabilitySession(): void {
  downgradedByMedia.clear(); swLaneByMedia.clear(); hwLaneByMedia.clear(); lastLoggedKey.clear();
}
```

Check `LogEntryInput`'s exact `LogLevel`/`LogCategory` variants at `renderer/ipc/index.ts:1350-1382` and match the literal spellings (`"Warn"`/`"Info"`, `{ kind: "Other", name }`, `{ kind: "System" }`) — adjust to the real union members if they differ.

- [ ] **Step 2: PixiPreview builds the resolver**

Replace `proxyAssetUrl` + `nativeSwSourceFor` (`PixiPreview.tsx:137-146` + `:158-167`) with:

```ts
const resolveSource = (mediaId: string) => {
  const m = useProjectStore.getState().mediaById.get(mediaId);
  if (!m) return null;
  const lanes = laneStatesFor(mediaId, m);
  const r = resolveEngineTier({
    setting: useAppSettingsStore.getState().settings.decode_engine,
    componentAvailable: useDecodeComponentStore.getState().available,
    media: { path: m.path, decode_route: m.decode_route },
    // Session probe memo (App's decodeProbeMemo via the prop) — read live so a
    // mid-session probe flip takes effect on the next ensureClip.
    webcodecsOriginal: (previewDecodableOf?.(mediaId) ?? false) ? "ok" : "untested",
    nativeHw: lanes.nativeHw,
    nativeSw: lanes.nativeSw,
    downgraded: lanes.downgraded,
    proxyPreviewPath: resolveDecode(m).previewPath,
  });
  noteResolution(mediaId, r);
  const target = r.sourcePath ?? r.url;
  return {
    tier: r.tier,
    forceStrategy: r.forceStrategy,
    sourcePath: r.sourcePath,
    assetUrl: r.url ? convertFileSrc(r.url) : null,
    key: target ? `${r.tier}:${target}` : null,
  };
};
```

Compositor construction (`:174-185`): replace `proxyAssetUrl` + `nativeSwSourceFor` entries with `resolveSource`. Keep `originalAssetUrl`, `sourceColor`, `mediaById`, `conformAssetUrl` as-is. Imports: add `resolveEngineTier` (type-only where possible), `laneStatesFor`/`noteResolution`, `useDecodeComponentStore`; drop the now-unused `previewPathLive` import; `resolveDecode` stays.

- [ ] **Step 3: Compositor — resolved-source acquire + key-based swap**

`Compositor.ts` changes, in order:

1. Init surface: add `resolveSource?: (mediaId: string) => ResolvedRendererSource | null` (declare the small interface near the init type; doc: "preview mode's engine resolution — REQUIRED in preview mode; export mode keeps `proxyAssetUrl` until Phase D5"). Keep `proxyAssetUrl` for export mode; default `resolveSource` to `() => null` like `nativeSwSourceFor` was, and DELETE the `nativeSwSourceFor` field/doc/default (`:194-197`, `:353`, `:486`).
2. `ActiveClip`: replace `builtFromUrl: string` + `isSoftware: boolean` (`:221-236`) with `builtFromKey: string`. Grep `isSoftware`/`builtFromUrl` across the file and fix every reader (the e2e `activeClipProbe` at `:1097-1104` routes by `instanceof` — unaffected).
3. `ensureClip` existing-clip branch (`:1445-1461`) becomes:

```ts
if (existing && !existing.source.disposed) {
  // No-flash re-resolution: when the resolver's IDENTITY for this media
  // changes (proxy landed for a tier-4 clip, engine flipped, D4 downgrade),
  // begin an overlap-swap; keep showing the existing clip until the new
  // handle holds the visible frame. Keying on tier+target (not URL) means a
  // landed proxy can NEVER displace a native/original tier — the resolver
  // simply keeps returning the higher tier (feedback_native_nle_conventions).
  if (this.mode === "preview") {
    const rs = this.resolveSource(layer.params.media_id);
    if (rs?.key && rs.key !== existing.builtFromKey && (rs.assetUrl !== null || rs.sourcePath)) {
      this.beginSwap(existing, layer, rs);
    }
  }
  return existing;
}
```

4. Acquire block (`:1462-1502`): preview mode resolves once; export mode keeps today's proxy path:

```ts
const mediaId = layer.params.media_id;
const rs = this.mode === "preview"
  ? this.resolveSource(mediaId)
  : rsFromExportProxy(this.proxyAssetUrl(mediaId)); // helper below
if (!rs || (!rs.assetUrl && !rs.sourcePath)) {
  console.warn(`[weftcut/pixi] no decode source for media ${mediaId} (clip ${layer.id})`);
  return null;
}
const sourceColor = this.sourceColor(mediaId);
const sourceStartPtsUs = this.mediaById(mediaId)?.video_start_pts_us ?? this.mediaById(mediaId)?.start_pts_us ?? null;
const builtFromKey = rs.key!; // non-null: guarded above
const source = this.pool.acquire({
  layerId: layer.id,
  mediaId,
  ...(this.mode === "export"
    ? { handleKey: exportHandleKey(mediaId, layer.params.src_in_us, layer.t_start_us) }
    : {}),
  proxyAssetUrl: rs.assetUrl ?? "",
  sourceColor,
  sourceStartPtsUs,
  ...(rs.forceStrategy ? { forceStrategy: rs.forceStrategy, sourcePath: rs.sourcePath ?? "" } : {}),
});
```

with the tiny module-level helper (export mode has exactly one tier):

```ts
function rsFromExportProxy(url: string | null): ResolvedRendererSource | null {
  return url ? { tier: "proxy", assetUrl: url, key: `proxy:${url}`, sourcePath: undefined, forceStrategy: undefined } : null;
}
```

Update the revival branch + fresh-clip literal (`:1517-1538`): `existing.builtFromKey = builtFromKey` (drop `isSoftware`); `clip` literal gets `builtFromKey` instead of `builtFromUrl`/`isSoftware`.
5. Swap machinery: `SwapState.newUrl: string` → carry the whole target — `{ handle, swapLayerId, key: string, timer, deadline }`; `beginSwap(clip, layer, rs: ResolvedRendererSource)` (`:1549-1591`) — the in-flight dedupe compares `inflight.key === rs.key`; the acquire inside uses the SAME spread as ensureClip's (`proxyAssetUrl: rs.assetUrl ?? ""`, `...(rs.forceStrategy ? { forceStrategy: rs.forceStrategy, sourcePath: rs.sourcePath ?? "" } : {})`) under the synthetic `swapLayerId`/`swapMediaId`; `completeSwap` (`:1618-1639`) sets `clip.builtFromKey = state.key`; log lines print `state.key`. `pollSwap`/`abandonSwap` unchanged.

- [ ] **Step 4: Delete `previewPathLive`**

Remove it from `decodeRoute.ts:47-58`. `grep -rn "previewPathLive" src e2e` → the only consumer was `PixiPreview.tsx` (Step 2). The `previewDecidableOf` prop + `decodeProbeMemo` STAY (they feed tier 2 now); update `useImportReadiness.ts`'s comment at the `refreshSources()` call (`:247`): the nudge now re-runs ENGINE resolution rather than the bridge.

- [ ] **Step 5: Gates**

```bash
npm run typecheck && npm test
VITE_WEFTCUT_E2E=1 npm run build
npx playwright test e2e/electron/preview-sw-families.spec.ts e2e/electron/preview-sw-conformance.spec.ts
node e2e/scripts/memory-ratchet.mjs
```

Expected: typecheck/vitest green; both preview-sw specs green again (Task 8 left them red on purpose); memory ratchet <30 MB/90 s (this task touched the playback acquire path).

- [ ] **Step 6: Manual behavior spot-check (the era-ender)**

`npm run dev` → import an HEVC clip: it should preview immediately from the ORIGINAL (LogBus shows `decode resolution: … webcodecs-original`), keep previewing the original after the quick proxy lands (no swap logged), and scrub acceptably. Import a ProRes clip with `decode_engine: auto` — resolves `native-sw` with NO experimental toggle.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/render/PixiPreview.tsx src/renderer/render/Compositor.ts src/renderer/render/decodeRoute.ts src/renderer/render/decoder/decodeCapability.ts src/renderer/app/useImportReadiness.ts
git commit -m "feat(decode-engine): engine resolution drives preview acquire + key-based no-flash swap (D2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: e2e — tier-resolution cells

**Files:**
- Create: `apps/desktop/e2e/electron/decode-engine.spec.ts`
- Modify: `apps/desktop/src/renderer/testhook/e2eHook.ts` (expose the resolved tier)

**Interfaces:**
- Consumes: `activeClipProbe` hook pattern (`e2eHook.ts`; instance-of routing exists in Compositor `:1097-1104`), `invokeCmd`/`importAndPlaceMedia`/`waitForHook` from `e2e/electron/helpers/driver`, fixture-generation pattern from `preview-sw-families.spec.ts` (ffmpeg CLI in beforeAll).
- Produces: `window.__weftcutTest.activeClipProbe(id)` gains `builtFromKey: string | null` (tier prefix assertable).

- [ ] **Step 1: Extend the probe hook**

In the Compositor's e2e probe (`Compositor.ts:1097-1104` region) include the clip's `builtFromKey` in the returned object; thread it through `e2eHook.ts`'s `activeClipProbe` typing. (Grep `activeClipProbe` in both files; the addition is one field.)

- [ ] **Step 2: Write the spec**

`decode-engine.spec.ts`, following `preview-sw-families.spec.ts`'s structure (launchApp/newProject/import helpers, self-skip in CI). Three cells:

```ts
// Cell 1 — auto + HEVC: tier 2 ends the proxy-default era.
// Generate an HEVC fixture in beforeAll (mirror preview-sw-families' ffmpeg
// invocation shape): ffmpeg -f lavfi -i testsrc2=duration=4:size=640x360:rate=30
//   -c:v libx265 -pix_fmt yuv420p -tag:v hvc1 <tmp>/hevc-tier2.mp4
// Import + place; wait for the clip probe; assert:
//   probe.sourceKind === 'webcodecs'
//   probe.builtFromKey!.startsWith('webcodecs-original:')
// Then wait for the quick proxy to land (media:job_complete kind 'quick_proxy'
// via the driver's event helpers or poll mediaDecodeRouteKind) and re-assert
// builtFromKey is UNCHANGED (no auto-swap to proxy).

// Cell 2 — auto + ProRes: blind-spot resolves native-sw with no toggle.
// Reuse preview-sw-families' ProRes fixture generation; assert
// probe.sourceKind === 'sw' && builtFromKey!.startsWith('native-sw:').

// Cell 3 — pinned webcodecs skips native tiers.
// invokeCmd 'app_settings_set' { decode_engine: 'webcodecs' } BEFORE import of
// the same ProRes fixture; assert sourceKind === 'webcodecs' and builtFromKey
// starts with 'proxy:' once the proxy lands (ProRes originals aren't
// WebCodecs-decodable, so tier 2 fails → tier 4).
```

Write the full spec with real code — every helper named above exists in the two preview-sw specs; copy their import list and fixture/beforeAll scaffolding verbatim, then express the three cells' waits with `waitForHook` exactly as `preview-sw-families.spec.ts:61-100` does.

- [ ] **Step 3: Run**

```bash
VITE_WEFTCUT_E2E=1 npm run build
npx playwright test e2e/electron/decode-engine.spec.ts
```

Expected: 3 cells pass locally.

- [ ] **Step 4: Commit**

```bash
git add e2e/electron/decode-engine.spec.ts src/renderer/testhook/e2eHook.ts src/renderer/render/Compositor.ts
git commit -m "test(decode-engine): tier-resolution e2e cells (auto/hevc-original, auto/prores-sw, pinned-webcodecs) (D2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: D2 close-out — ADR, vocabulary, docs

**Files:**
- Create: `docs/adr/0030-decode-engine-overlay-and-native-component.md`
- Modify: `CONTEXT.md` (Session bridge entry + new terms)
- Modify: `docs/preview.md` (engine resolution section)

- [ ] **Step 1: ADR 0030**

Follow the ADR house style (frontmatter with `status: accepted`, evergreen voice per `feedback_evergreen_docs` — no dates/phases/hashes in the body). Content: (1) engine is a runtime overlay — three layers of truth (disk `DecodeRoute` / machine capability cache / session resolution), no engine state persisted into media; (2) the native runtime is a conditionally-first-class SPLIT addon `@weftcut/native-decode` — missing-DLL isolation is structural (import-table failure would kill all of `@weftcut/core`), lazy require + level-0 gate, Windows-bundled v1; (3) licensing line: in-process = LGPL DLLs (banner-gated at fetch/build/package), sidecar CLI = GPL; the addon split is NOT a license boundary (FSF plugin doctrine) — the LGPL build is. Reference ADR 0029 (ship-bytes transport) and ADR 0021 (color chokepoint).

- [ ] **Step 2: CONTEXT.md vocabulary**

- **Session bridge** entry: reword to past-tense scope — the bridge's behavior is subsumed by the decode engine's tier 2 (`webcodecs-original`); the term now refers only to the residual probe-memo plumbing, fully retired in D6. Keep the `_Avoid_` list.
- Add **Decode engine** — the runtime overlay picking a per-source decode tier (`native-hw`/`webcodecs-original`/`native-sw`/`proxy`) from settings × capability × route. _Avoid_: decode route (that's the persisted disk truth), preset.
- Add **Capability cache** — machine-level probe verdicts keyed by format class, persisted by main (D3). _Avoid_: session bridge, decode memo.

- [ ] **Step 3: docs/preview.md**

Add/replace the routing section: the engine resolution flow diagram (settings + capability cache + DecodeRoute → resolveEngineTier → pool acquire), the four tiers, forced-engine orders, and the "originals are the default; proxy is opt-in-or-fallback" posture. Delete any text describing `experimental_native_sw_decode` or the original→proxy auto-swap as current behavior. Evergreen voice.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0030-decode-engine-overlay-and-native-component.md ../../CONTEXT.md docs/preview.md
git commit -m "docs(decode-engine): ADR 0030 + vocabulary + preview.md engine section (D2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Path note: `CONTEXT.md` sits at the REPO ROOT — the `../../` above assumes the working dir is `apps/desktop`; verify with `git status` before committing.)

---

# Stage D3 — SW lane widened to probe-accepted formats + capability cache

**Stage outcome:** tier 3 accepts "anything ffmpeg decodes, probe-verified" — not just the blind-spot list. Verdicts persist per machine in a capability cache keyed by format class, invalidated when the component's ffmpeg changes.

### Task 12: Component napi — `preview_sw_probe`

**Files:**
- Modify: `apps/desktop/native/decode/src/backend.rs`
- Modify: `apps/desktop/native/decode/src/preview_sw/mod.rs` (re-export if needed)
- Test: inline `#[cfg(test)]` in `backend.rs` is impractical (needs a media file); instead extend `apps/desktop/native/decode/src/preview_sw/decoder.rs`'s existing test module with a fixture-generated probe test IF those tests already synthesize media; otherwise the e2e cell in Task 14 is the behavior gate — check what `preview_sw/decoder.rs`'s tests actually do first and match their pattern.

**Interfaces:**
- Consumes: `SwVideoStream::{open, next_frame}` (`preview_sw/decoder.rs:124-255` — open + pull-one-frame is exactly a probe).
- Produces: napi method `preview_sw_probe(path: String) -> napi::Result<PreviewSwProbeResult>` (JS `previewSwProbe`), wire struct `PreviewSwProbeResult { ok: boolean; codec: string | null; pixFmt: string | null; width: number; height: number; reason: string | null }`.

- [ ] **Step 1: Implement the probe**

In `backend.rs`, add the wire struct + method on `NativeDecode` (in the always-present SW impl block):

```rust
/// Verdict of a one-frame SW decode probe. `codec`/`pix_fmt` echo what
/// libavformat identified — main derives the capability-cache class key from
/// these (probe-informed, not caller-guessed).
#[napi(object)]
pub struct PreviewSwProbeResult {
    pub ok: bool,
    pub codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub reason: Option<String>,
}
```

```rust
/// One-frame decode probe for the SW lane (P1: probes over lists). Opens a
/// THROWAWAY stream (never registered in the session registry), decodes one
/// frame, closes. Failure is a verdict, not an error — Err only for panics
/// worth surfacing.
#[napi]
pub fn preview_sw_probe(&self, path: String) -> napi::Result<PreviewSwProbeResult> {
    match crate::preview_sw::decoder::SwVideoStream::open(&path) {
        Ok(mut stream) => {
            let (codec, pix_fmt, width, height) = stream.probe_identity();
            match stream.next_frame() {
                Ok(Some(_frame)) => Ok(PreviewSwProbeResult {
                    ok: true, codec: Some(codec), pix_fmt: Some(pix_fmt),
                    width, height, reason: None,
                }),
                Ok(None) => Ok(PreviewSwProbeResult {
                    ok: false, codec: Some(codec), pix_fmt: Some(pix_fmt),
                    width, height, reason: Some("no decodable frame".into()),
                }),
                Err(e) => Ok(PreviewSwProbeResult {
                    ok: false, codec: Some(codec), pix_fmt: Some(pix_fmt),
                    width, height, reason: Some(e.to_string()),
                }),
            }
        }
        Err(e) => Ok(PreviewSwProbeResult {
            ok: false, codec: None, pix_fmt: None, width: 0, height: 0,
            reason: Some(e.to_string()),
        }),
    }
}
```

`probe_identity()` is a small new accessor on `SwVideoStream` (in `decoder.rs`) returning `(codec_name, pix_fmt_name, width, height)` from the already-open decoder context — read the struct's fields (`decoder.rs:83-104`) and expose what's there; the codec/pix_fmt names come from `ffmpeg_next`'s `codec().id()` descriptor name and `format()` — match how `frame_to_nv12`/`open` already touch these.

- [ ] **Step 2: Build + test**

```bash
cargo test --manifest-path native/decode/Cargo.toml
npm run napi:build:decode
```

Sanity from node (dev DLLs on PATH via the fetched dir):

```bash
node -e "const m = require('./native/decode'); const nd = new m.NativeDecode(() => {}); console.log(nd.previewSwProbe('e2e/fixtures/whatever-exists.mp4'))"
```

(Use any real media file on disk; expected `ok: true` with codec/pixFmt filled.)

- [ ] **Step 3: Commit**

```bash
git add native/decode/src/backend.rs native/decode/src/preview_sw/decoder.rs
git commit -m "feat(decode-engine): preview_sw_probe one-frame decode probe (D3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 13: Main — machine capability cache + probe IPC

**Files:**
- Create: `apps/desktop/src/main/decode-capability.ts`
- Create: `apps/desktop/src/main/decode-capability.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (IPC handler + store construction next to the app-settings store)
- Modify: `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/ipc.ts` (bridge + types)

**Interfaces:**
- Consumes: `previewSwProbe` (Task 12), `versionInfo` (Task 1) as the SW lane's envKey, the injectable-fs store pattern from `main/app-settings.ts`.
- Produces: `createDecodeCapabilityStore(deps: { fs: AppSettingsFs; path: string; dir: string })` → `{ get(lane, classKey, envKey): boolean | null; put(lane, classKey, envKey, ok): void }` (envKey mismatch wipes that lane's entries — GPU/driver or ffmpeg change invalidation, spec §"Capability probe cache"); IPC `decodeCap:probeSw(path: string)` → `{ ok: boolean; classKey: string | null; reason: string | null }`; renderer api `window.api.decodeCap.probeSw(path)`.

- [ ] **Step 1: Failing store tests**

`decode-capability.test.ts` (in-memory fs exactly like `app-settings` tests — if `src/main/app-settings.test.ts` exists, copy its fake-fs helper; otherwise write a 10-line `Map`-backed `AppSettingsFs`):

```ts
import { describe, expect, it } from "vitest";
import { createDecodeCapabilityStore } from "./decode-capability";
import type { AppSettingsFs } from "./app-settings";

function memFs(): AppSettingsFs {
  const files = new Map<string, string>();
  return {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFile: (p, t) => void files.set(p, t),
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    mkdirp: () => {},
  };
}

describe("decode capability cache", () => {
  it("misses, stores, hits", () => {
    const s = createDecodeCapabilityStore({ fs: memFs(), path: "/x/decode_capability.json", dir: "/x" });
    expect(s.get("sw", "prores::yuv422p10le:hd", "avcodec=61")).toBeNull();
    s.put("sw", "prores::yuv422p10le:hd", "avcodec=61", true);
    expect(s.get("sw", "prores::yuv422p10le:hd", "avcodec=61")).toBe(true);
  });
  it("envKey change invalidates the lane", () => {
    const s = createDecodeCapabilityStore({ fs: memFs(), path: "/x/c.json", dir: "/x" });
    s.put("sw", "k", "v1", true);
    expect(s.get("sw", "k", "v2")).toBeNull();       // stale env → miss
    s.put("sw", "k", "v2", false);
    expect(s.get("sw", "k", "v2")).toBe(false);
  });
  it("corrupt file degrades to empty", () => {
    const fs = memFs();
    fs.writeFile("/x/c.json", "{nope");
    const s = createDecodeCapabilityStore({ fs, path: "/x/c.json", dir: "/x" });
    expect(s.get("sw", "k", "v")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — fail; implement the store**

`decode-capability.ts`:

```ts
// Machine capability cache (dual-engine spec §"Capability probe cache"):
// probe verdicts keyed (lane, format class), persisted at
// <userData>/decode_capability.json. envKey pins the environment the verdict
// was measured in — SW: the component's ffmpeg version; HW (D4): the GPU +
// driver identity — a mismatch wipes that lane (machine truth went stale).
// NOT the session bridge and NOT per-file (ADR 0010 stays: per-file
// incapability is session-scoped; this caches per-format-CLASS capability).
import type { AppSettingsFs } from './app-settings'

type Lane = 'sw' | 'hw'

interface CacheFile {
  env: Partial<Record<Lane, string>>
  entries: Partial<Record<Lane, Record<string, { ok: boolean; at: string }>>>
}

const EMPTY: CacheFile = { env: {}, entries: {} }

export interface DecodeCapabilityStore {
  get(lane: Lane, classKey: string, envKey: string): boolean | null
  put(lane: Lane, classKey: string, envKey: string, ok: boolean): void
}

export function createDecodeCapabilityStore(deps: { fs: AppSettingsFs; path: string; dir: string }): DecodeCapabilityStore {
  function read(): CacheFile {
    if (!deps.fs.exists(deps.path)) return structuredClone(EMPTY)
    try {
      const parsed = JSON.parse(deps.fs.readFile(deps.path)) as CacheFile
      return { env: parsed.env ?? {}, entries: parsed.entries ?? {} }
    } catch {
      return structuredClone(EMPTY)
    }
  }
  function write(c: CacheFile): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(c, null, 2))
    deps.fs.rename(tmp, deps.path)
  }
  return {
    get(lane, classKey, envKey) {
      const c = read()
      if (c.env[lane] !== envKey) return null
      return c.entries[lane]?.[classKey]?.ok ?? null
    },
    put(lane, classKey, envKey, ok) {
      const c = read()
      if (c.env[lane] !== envKey) {
        c.env[lane] = envKey
        c.entries[lane] = {}
      }
      ;(c.entries[lane] ??= {})[classKey] = { ok, at: new Date().toISOString() }
      write(c)
    },
  }
}

/// Format-class key: codec:profile:pix_fmt:resolution-class. Probe-informed
/// (Task 12 returns codec/pixFmt); resolution classes keep 4K verdicts from
/// vouching for 8K.
export function classKeyOf(codec: string, pixFmt: string | null, width: number, height: number): string {
  const px = Math.max(width, height)
  const res = px <= 1024 ? 'sd' : px <= 2048 ? 'hd' : px <= 4096 ? 'uhd' : 'huge'
  return `${codec}::${pixFmt ?? 'unknown'}:${res}`
}
```

Run: `npx vitest run src/main/decode-capability.test.ts` — pass.

- [ ] **Step 3: IPC + bridge**

`main/index.ts` — construct next to the app-settings store (find `createAppSettingsStore(` and mirror its `fs`/paths wiring; same node:fs adapter object):

```ts
const decodeCapability = createDecodeCapabilityStore({
  fs: appSettingsFsAdapter, // whatever local name the app-settings adapter has
  path: path.join(app.getPath('userData'), 'decode_capability.json'),
  dir: app.getPath('userData'),
})
```

Handler (next to `decodeComponent:status`):

```ts
ipcMain.handle('decodeCap:probeSw', (_e, a: { path: string }) => {
  if (!nd.backend) return { ok: false, classKey: null, reason: 'component unavailable' }
  const envKey = nd.version ?? 'unknown'
  const probe = nd.backend.previewSwProbe(a.path)
  const classKey = probe.codec ? classKeyOf(probe.codec, probe.pixFmt, probe.width, probe.height) : null
  if (classKey) {
    const cached = decodeCapability.get('sw', classKey, envKey)
    if (cached === null) decodeCapability.put('sw', classKey, envKey, probe.ok)
    // Cache-first shortcut: a cached true for this class skips nothing here
    // (we already probed to LEARN the class from this file), but the verdict
    // below prefers the cache so a one-off file glitch can't poison a class.
    return { ok: cached ?? probe.ok, classKey, reason: probe.reason }
  }
  return { ok: probe.ok, classKey, reason: probe.reason }
})
```

(Design note, recorded for the reviewer: the class key needs codec/pix_fmt, which main learns FROM the probe — so per-file the probe always runs once, and the cache's job is cross-session/cross-file *class* memory plus D4's HW lane where probing is expensive. If per-file SW probe cost ever shows up, the renderer already knows `MediaSummary.codec`/`pix_fmt` and can pre-compute the key — deliberate YAGNI today.)

`shared/ipc.ts` Api: `decodeCap: { probeSw(path: string): Promise<{ ok: boolean; classKey: string | null; reason: string | null }> }`; preload: `decodeCap: { probeSw: (path) => ipcRenderer.invoke('decodeCap:probeSw', { path }) }`.

- [ ] **Step 4: Gates + commit**

```bash
npm run typecheck && npm test
git add src/main/decode-capability.ts src/main/decode-capability.test.ts src/main/index.ts src/preload/index.ts src/shared/ipc.ts
git commit -m "feat(decode-engine): machine capability cache + SW probe IPC (D3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 14: Renderer — probe-driven tier 3

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/decodeCapability.ts`
- Modify: `apps/desktop/e2e/electron/decode-engine.spec.ts` (new cell)
- Test: `apps/desktop/src/renderer/render/decoder/decodeCapability.test.ts`

**Interfaces:**
- Consumes: `window.api.decodeCap.probeSw` (Task 13), `setSwLane`/`laneStatesFor` (Task 9), the `refreshSources` nudge pattern (`useImportReadiness.ts:247` — PixiPreview exposes it via ref; find the exact prop/ref name there and reuse).
- Produces: `kickSwProbe(mediaId, path, onSettled: () => void): void` — single-flight per media; on resolve `setSwLane(mediaId, ok ? "ok" : "fail")` then `onSettled()`.

- [ ] **Step 1: Failing test for single-flight + settle**

`decodeCapability.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { kickSwProbe, laneStatesFor, resetDecodeCapabilitySession, setSwLane } from "./decodeCapability";

describe("kickSwProbe", () => {
  it("marks ok/fail and settles once, single-flight", async () => {
    resetDecodeCapabilitySession();
    let calls = 0;
    (globalThis as never as { window: unknown }).window = {
      api: { decodeCap: { probeSw: async () => { calls++; return { ok: true, classKey: "k", reason: null }; } } },
    };
    const settled = vi.fn();
    kickSwProbe("m1", "C:/a.mov", settled);
    kickSwProbe("m1", "C:/a.mov", settled); // deduped while in flight
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(calls).toBe(1);
    expect(laneStatesFor("m1", { decode_route: { route: "proxied" } }).nativeSw).toBe("ok");
  });
});
```

(If mutating `globalThis.window` fights the vitest environment, inject the probe fn instead: give `kickSwProbe` an optional `probeFn` parameter defaulting to `window.api.decodeCap.probeSw` — same seam style as `loadNativeDecodeWith`.)

- [ ] **Step 2: Implement**

Append to `decodeCapability.ts`:

```ts
const swProbeInFlight = new Set<string>();

/// Kick the SW-lane probe for a source whose lane is "untested". Single-flight
/// per media; the verdict lands via setSwLane and `onSettled` nudges the
/// caller (PixiPreview refreshSources) so ensureClip re-resolves — the same
/// probe→nudge rhythm the import decodability sweep already uses.
export function kickSwProbe(
  mediaId: string,
  path: string,
  onSettled: () => void,
  probeFn: (p: string) => Promise<{ ok: boolean }> = (p) => window.api.decodeCap.probeSw(p),
): void {
  if (swProbeInFlight.has(mediaId) || swLaneByMedia.has(mediaId)) return;
  swProbeInFlight.add(mediaId);
  void probeFn(path)
    .then((r) => setSwLane(mediaId, r.ok ? "ok" : "fail"))
    .catch(() => setSwLane(mediaId, "fail"))
    .finally(() => { swProbeInFlight.delete(mediaId); onSettled(); });
}
```

Wire the kick in PixiPreview's `resolveSource` (Task 9's function): after computing `lanes`, when the resolver WOULD consider tier 3 (i.e. `setting !== 'webcodecs'`, component available) and `lanes.nativeSw === 'untested'` and tiers 1-2 didn't already win, call `kickSwProbe(mediaId, m.path, () => previewRef-style refreshSources)`. Concretely: run `resolveEngineTier` first; if the result tier is `proxy` and `lanes.nativeSw === "untested"` and the setting allows native, kick the probe — the source shows its proxy (or waits) exactly as today, then upgrades via the no-flash swap when the verdict lands and the nudge re-resolves. The `refreshSources` callable: PixiPreview owns the Compositor instance — the nudge is whatever `useImportReadiness.ts:247` calls (`previewRef.current?.refreshSources()`); inside PixiPreview itself call the same method on the local compositor/engine reference directly.

Also update `laneStatesFor`'s `nativeSw` line — the map now takes precedence over the route seed (it already does: `swLaneByMedia.get(mediaId) ?? routeSeed`), and the route seed STAYS (P1: the blind-spot list pre-passes known formats without waiting a probe).

- [ ] **Step 3: e2e cell — widened acceptance**

Add Cell 4 to `decode-engine.spec.ts`: pin `decode_engine: 'native'`, import the HEVC fixture (NOT in the blind-spot list; WebCodecs tier skipped by the pin) → wait → assert `probe.sourceKind === 'sw'` and `builtFromKey.startsWith('native-sw:')` — proving tier 3 accepted a probe-passed format beyond the list.

- [ ] **Step 4: Gates + commit**

```bash
npx vitest run src/renderer/render/decoder/decodeCapability.test.ts
npm run typecheck && npm test
VITE_WEFTCUT_E2E=1 npm run build && npx playwright test e2e/electron/decode-engine.spec.ts
git add src/renderer/render/decoder/decodeCapability.ts src/renderer/render/decoder/decodeCapability.test.ts src/renderer/render/PixiPreview.tsx e2e/electron/decode-engine.spec.ts
git commit -m "feat(decode-engine): probe-driven SW lane beyond the blind-spot list (D3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 15: decode-bench — MPEG-2 + VC-1 fixture rows

The spec's gates table: "SW strategy widens with the lane (add mpeg2/vc1 fixture rows)". The bench already models the lanes via `--strategy webcodecs|native|sw`.

**Files:**
- Modify: `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs` (`BENCH_MATRIX` + generation)
- Modify: `docs/decode-bench.md` (fixture table row additions)

- [ ] **Step 1: Add the fixtures**

Open `gen-decode-bench-fixtures.mjs`, find `BENCH_MATRIX` and one existing entry's ffmpeg invocation (e.g. hevc-1080), then add two rows following the SAME duration/size/validation conventions the file uses:

- `mpeg2-1080`: `-c:v mpeg2video -pix_fmt yuv420p -b:v 12M` in an `.mpg` or `.mxf` container matching how the preview-sw e2e fixtures generate MPEG-2 (grep `mpeg2` in `e2e/` for the proven container flags and reuse them).
- `vc1-1080`: ffmpeg cannot ENCODE VC-1 — check how the existing preview-sw family fixtures obtain a VC-1 sample (grep `vc1|wmv3` in `e2e/`); reuse that mechanism (WMV3 via `-c:v wmv2` is NOT vc1 — if the repo has no VC-1 source recipe, mark the row `sw`-only-skipped with a comment and keep mpeg2 as the widened-row proof; do not invent an encoder).

- [ ] **Step 2: Regenerate + run the SW rows**

```bash
node e2e/scripts/gen-decode-bench-fixtures.mjs
node e2e/scripts/decode-bench.mjs --fixture mpeg2-1080 --strategy sw --scenario throughput --runs 1
```

Expected: fixture validates; the SW row produces a report with `endedAtEof: true`. Record the fps in the commit message body (baseline breadcrumb).

- [ ] **Step 3: Doc + commit**

Add the new rows to `docs/decode-bench.md`'s fixture table.

```bash
git add e2e/scripts/gen-decode-bench-fixtures.mjs docs/decode-bench.md
git commit -m "test(decode-engine): mpeg2/vc1 decode-bench fixture rows for the widened SW lane (D3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Stage D4 — HW lane productization

**Stage outcome:** `forceStrategy: "native"` is no longer E2E-gated; tier 1 goes live behind a real probe + GPU-keyed capability cache; concurrent HW sessions are budget-capped; runtime failures downgrade per-source, stickily, through the same no-flash swap. CI stays blind to the GPU lane (headless) — the manual hardware smoke closes the gap.

### Task 16: Component napi — `preview_gpu_probe` + HW capability IPC

**Files:**
- Modify: `apps/desktop/native/decode/src/backend.rs` (+ `preview_gpu/session.rs` if a probe helper is cleaner there)
- Modify: `apps/desktop/src/main/index.ts` (IPC `decodeCap:probeHw`), `apps/desktop/src/main/previewGpu.ts` (no change expected — probe goes straight at the backend), `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/ipc.ts`

**Interfaces:**
- Consumes: `PreviewGpuRegistry::{open, request_frame_at, close}` + the poke sink (FrameReady/Error already reach main as `previewGpu:*` events); `classKeyOf` + capability store (Task 13); `MediaSummary.codec/pix_fmt` (renderer sends them — the HW probe is expensive, so the class key must be computable BEFORE deciding to probe).
- Produces: napi `preview_gpu_probe(path: String, timeout_ms: u32) -> napi::Result<PreviewGpuProbeResult>` with `PreviewGpuProbeResult { ok: bool, reason: Option<String> }` (Windows impl + non-Windows stub returning `ok:false, reason:"not windows"`); IPC `decodeCap:probeHw(path, classKey)` → `{ ok: boolean; reason: string | null }` consulting the `hw` lane cache FIRST (classKey supplied by the renderer), envKey = GPU identity.

- [ ] **Step 1: Rust probe**

The probe must be synchronous and self-contained (no shared-texture handoff — decode viability, not transport): open a throwaway session against a probe-private poke sink, request frame 0, wait for the first `FrameReady` or `Error` poke with a deadline, close. Registry-level implementation (in `preview_gpu/session.rs`, exported through `mod.rs`):

```rust
/// One-frame HW decode probe: opens a private session (pool_size = minimum
/// the session layer allows), requests t=0, and waits for the first
/// FrameReady/Error with a deadline. Never touches the shared registry or the
/// installed poke sink — capability only, no transport.
pub fn probe(path: &str, timeout: std::time::Duration) -> Result<(), String>
```

Build it from the session module's existing open/decode-thread plumbing (read `session.rs` around the registry's `open` — `:22` documents `pool_size >= 2`; use a `std::sync::mpsc` channel as the private sink, `recv_timeout(timeout)`, always join/close before returning). Then the napi wrapper on `NativeDecode` (Windows impl block):

```rust
#[napi]
pub fn preview_gpu_probe(&self, path: String, timeout_ms: u32) -> napi::Result<PreviewGpuProbeResult> {
    match crate::preview_gpu::probe(&path, std::time::Duration::from_millis(timeout_ms as u64)) {
        Ok(()) => Ok(PreviewGpuProbeResult { ok: true, reason: None }),
        Err(e) => Ok(PreviewGpuProbeResult { ok: false, reason: Some(e) }),
    }
}
```

plus the `#[cfg(not(windows))]` stub (`ok: false, reason: Some("preview-gpu not built".into())`) and the always-compiled wire struct.

- [ ] **Step 2: GPU envKey + IPC**

`main/index.ts`:

```ts
// GPU identity for the HW capability lane: vendor/device/driver — a driver
// update or GPU swap invalidates every cached HW verdict.
async function hwEnvKey(): Promise<string> {
  try {
    const info = (await app.getGPUInfo('basic')) as {
      gpuDevice?: { vendorId?: number; deviceId?: number; driverVersion?: string }[]
    }
    const d = info.gpuDevice?.[0]
    return `gpu:${d?.vendorId ?? 0}:${d?.deviceId ?? 0}:${d?.driverVersion ?? 'unknown'}`
  } catch {
    return 'gpu:unknown'
  }
}

ipcMain.handle('decodeCap:probeHw', async (_e, a: { path: string; classKey: string }) => {
  if (process.platform !== 'win32' || !nd.backend) {
    return { ok: false, reason: 'hw lane unavailable' }
  }
  const envKey = await hwEnvKey()
  const cached = decodeCapability.get('hw', a.classKey, envKey)
  if (cached !== null) return { ok: cached, reason: 'cached' }
  const r = nd.backend.previewGpuProbe(a.path, 4000)
  decodeCapability.put('hw', a.classKey, envKey, r.ok)
  return { ok: r.ok, reason: r.reason }
})
```

`getGPUInfo('basic')`'s exact payload shape varies by Electron version — log it once during development and adjust the field access; keep the `catch → 'gpu:unknown'` so a shape change degrades to "cache never hits" rather than a crash. Preload + `shared/ipc.ts`: `decodeCap.probeHw(path, classKey)`.

- [ ] **Step 3: Gates + commit**

```bash
cargo test --manifest-path native/decode/Cargo.toml
npm run napi:build:decode && npm run typecheck && npm test
git add native/decode/src/backend.rs native/decode/src/preview_gpu/session.rs native/decode/src/preview_gpu/mod.rs src/main/index.ts src/preload/index.ts src/shared/ipc.ts
git commit -m "feat(decode-engine): preview_gpu_probe + GPU-keyed HW capability lane (D4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 17: Ungate the native strategy + HW session budget + tier 1 live

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts:68-76,:703-717`
- Modify: `apps/desktop/src/main/previewGpu.ts` (session cap)
- Modify: `apps/desktop/src/renderer/render/decoder/decodeCapability.ts` (`kickHwProbe`)
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx` (feed `nativeHw` + kick)
- Modify: `apps/desktop/e2e/electron/decode-engine.spec.ts` (pinned-native HW cell — LOCAL, GPU box only)

**Interfaces:**
- Consumes: `decodeCap.probeHw` (Task 16), `setHwLane` (Task 9), `classKeyOf`-compatible key built renderer-side from `MediaSummary.codec/pix_fmt` + dimensions (mirror `classKeyOf`'s format string EXACTLY — add a tiny exported `classKeyOfMedia(m)` in `decodeCapability.ts` and a comment pinning the twin).
- Produces: production-legal `forceStrategy: "native"`; `MAX_HW_SESSIONS` budget in `previewGpu.ts` (open beyond cap throws `Error('hw-budget-exceeded')` — the typed reason the resolver maps to a downgrade, Task 18).

- [ ] **Step 1: Remove the E2E gate**

`SourceDecoderPool.ts:704`: `if (import.meta.env.VITE_WEFTCUT_E2E === "1" && init.forceStrategy === "native")` → `if (init.forceStrategy === "native")`. Rewrite the `forceStrategy` doc comment (`:68-76`): `'native'` is now production-legal, chosen only by engine resolution (tier 1 requires a passed HW probe); `poolSize` stays bench-only. Update the pool's class-level docstring similarly (`:695-702`).

- [ ] **Step 2: Session budget**

`previewGpu.ts` — before `openPreviewGpu`'s napi open:

```ts
/// Conservative v1 session cap (spec Risk 3: bench data is single-source).
/// 3 sessions × 3 slots × ~4.5MB/1080p-NV12-slot ≈ 40MB VRAM steady-state;
/// widen only on measurement. Over-budget opens throw the typed reason the
/// renderer's resolver maps to a per-source downgrade to the next tier.
const MAX_HW_SESSIONS = 3

export function hwSessionCount(): number { return sessions.size }
```

and at the top of `openPreviewGpu`:

```ts
if (sessions.size >= MAX_HW_SESSIONS) throw new Error('hw-budget-exceeded')
```

- [ ] **Step 3: Renderer tier-1 inputs**

`decodeCapability.ts` — add `kickHwProbe(mediaId, path, classKey, onSettled, probeFn?)` mirroring `kickSwProbe` (single-flight, `setHwLane`), plus:

```ts
/// TWIN of main's classKeyOf (decode-capability.ts) — same format string.
export function classKeyOfMedia(m: { codec: string | null; pix_fmt: string | null; width?: number | null; height?: number | null }): string | null {
  if (!m.codec) return null;
  const px = Math.max(m.width ?? 0, m.height ?? 0);
  const res = px <= 1024 ? "sd" : px <= 2048 ? "hd" : px <= 4096 ? "uhd" : "huge";
  return `${m.codec}::${m.pix_fmt ?? "unknown"}:${res}`;
}
```

(Check `MediaSummary`'s width/height field names — grep `width` in `renderer/ipc/index.ts` near `:31-53`; use the real names.) PixiPreview: `nativeHw` input becomes `lanes.nativeHw` with a kick when `'untested'`, Windows only, component available, setting allows native, and the media has a class key; on non-Windows leave the map empty so `laneStatesFor` keeps returning... note: Task 9's `laneStatesFor` defaults `nativeHw` to `"unavailable"` — change that default to `"untested"` ONLY on Windows (`navigator.platform.startsWith("Win")` or an exposed platform const from preload — grep for an existing platform flag in the renderer and reuse it). Non-Windows keeps `"unavailable"`.

- [ ] **Step 4: e2e cell (local GPU box only)**

Cell 5 in `decode-engine.spec.ts`: pin `decode_engine: 'native'`, import an 8-bit H.264 fixture, expect `probe.sourceKind === 'native-gpu'` and `builtFromKey.startsWith('native-hw:')`. Skip-guard the cell like the GPU-dependent specs do (grep the repo's existing GPU-skip pattern in `e2e/` — decode-bench specs or headless-GL skips — and reuse it verbatim so CI stays green).

- [ ] **Step 5: Gates + memory ratchet + commit**

```bash
npm run typecheck && npm test
VITE_WEFTCUT_E2E=1 npm run build
npx playwright test e2e/electron/decode-engine.spec.ts e2e/electron/preview-sw-families.spec.ts
node e2e/scripts/memory-ratchet.mjs
git add src/renderer/render/decoder/SourceDecoderPool.ts src/main/previewGpu.ts src/renderer/render/decoder/decodeCapability.ts src/renderer/render/PixiPreview.tsx e2e/electron/decode-engine.spec.ts
git commit -m "feat(decode-engine): HW lane live — ungated native strategy, probe-gated tier 1, session budget (D4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 18: Sticky runtime downgrade

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts` (error surface)
- Modify: `apps/desktop/src/renderer/render/decoder/SwSourceHandle.ts` (error surface)
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (wire handle failure → downgrade → re-resolve)
- Test: `apps/desktop/src/renderer/render/decoder/decodeCapability.test.ts` (downgrade path)

**Interfaces:**
- Consumes: `markDowngraded` (Task 9), the key-based swap (Task 9 — a downgrade changes the resolved key, so the existing-clip branch swaps automatically on the next `ensureClip`), `scheduleRepaint`/`refreshSources`.
- Produces: `DecoderHandle.onFatalError?(cb: (reason: string) => void)` — optional, implemented by the two native handles (WebCodecs' existing internal fallback machinery stays as-is).

- [ ] **Step 1: Error surfaces on the native handles**

Both native handles already receive terminal errors (`evt:previewGpu:error` relayed per-stream for GPU — see the preload loop; the SW lane's `Error` pokes are currently log-only Rust-side but the SESSION also errors out through open/ensureReady rejections). Add to each handle class:

```ts
private fatalCb: ((reason: string) => void) | null = null;
onFatalError(cb: (reason: string) => void): void { this.fatalCb = cb; }
```

and invoke it wherever the handle today learns it is dead: `NativeGpuSourceHandle` — the `previewGpu:error` port/event handler and an `ensureReady` rejection (incl. the `hw-budget-exceeded` open throw); `SwSourceHandle` — its open/ensureReady failure path (grep `catch` in the file; if the SW lane has no mid-stream error signal, the open-failure + a "no frames within deadline" watchdog is the v1 surface — implement the open-failure part only and leave a `docs/preview.md` note that mid-stream SW errors surface in D6's polish; do NOT build a watchdog speculatively).

- [ ] **Step 2: Compositor wiring**

In `ensureClip` right after `source.onFirstFrame(...)` (`:1503-1509`), when the acquire came from a native tier:

```ts
if (rs.forceStrategy && source.onFatalError) {
  const failedTier = rs.tier; // "native-hw" | "native-sw"
  source.onFatalError((reason) => {
    markDowngraded(mediaId, failedTier, reason);          // P3: sticky + LogBus warn
    this.scheduleRepaint();                                // next ensureClip re-resolves →
  });                                                      // key change → no-flash swap
}
```

(`markDowngraded` import; the swap-on-key-change from Task 9 does the rebuild — no new mechanism.)

- [ ] **Step 3: Test the resolver-visible effect**

Extend `decodeCapability.test.ts`: `markDowngraded("m1","native-hw","boom")` → `laneStatesFor("m1", …).downgraded.has("native-hw")` → feed through `resolveEngineTier` (imports from Task 7's test toolkit) and assert the tier falls to the next lane and `reason` mentions `downgraded`.

- [ ] **Step 4: Manual failure drill (GPU box)**

`npm run dev`, pin native, play an H.264 clip on the HW lane, then force a failure (easiest lever: temporarily set `MAX_HW_SESSIONS = 0` and reload — open throws `hw-budget-exceeded`): the clip must land on the next tier without a black flash, LogBus shows the Warn, and the tier does NOT bounce back (sticky). Revert the lever.

- [ ] **Step 5: Gates + commit**

```bash
npm run typecheck && npm test
git add src/renderer/render/decoder/NativeGpuSourceHandle.ts src/renderer/render/decoder/SwSourceHandle.ts src/renderer/render/Compositor.ts src/renderer/render/decoder/decodeCapability.test.ts
git commit -m "feat(decode-engine): sticky per-source runtime downgrade riding the no-flash swap (D4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 19: Final gates, docs, and the hardware smoke checklist

- [ ] **Step 1: Full local gate sweep**

```bash
npm run typecheck && npm test
cargo test --manifest-path native/Cargo.toml --lib --features jobs,export,mcp,cloud
cargo test --manifest-path native/decode/Cargo.toml
VITE_WEFTCUT_E2E=1 npm run build
npx playwright test e2e/electron/decode-engine.spec.ts e2e/electron/preview-sw-families.spec.ts e2e/electron/preview-sw-conformance.spec.ts
node e2e/scripts/memory-ratchet.mjs
node e2e/scripts/decode-bench.mjs --self-check
```

All green before merge. Also re-run the packaging smoke from Task 4 once (the installer is a D1 deliverable — make sure D2-D4 didn't break it).

- [ ] **Step 2: Manual hardware smoke checklist (CI-blind surface)**

Run on this machine (RTX 3050) and record pass/fail in the merge summary: (a) auto-tier H.264/HEVC/VP9 1080p originals play + scrub on `native-hw` (LogBus tier lines); (b) 3+ HW clips at once → 4th resolves down without visual glitch (budget); (c) AV1 + Hi10P originals resolve PAST the HW tier (probe-fail → cache `ok:false` → no per-open retry — verify `decode_capability.json`); (d) driver-key sanity: edit the cached env string in `decode_capability.json`, relaunch, confirm the lane re-probes.

- [ ] **Step 3: Evergreen docs final pass**

- `docs/preview.md`: D4 additions (HW budget, sticky downgrade semantics, capability cache file location).
- `docs/decode-bench.md`: note that `--strategy native` now exercises the production path (gate removed), keep the harness-contract section.
- Roadmap: tick the hardware-smoke slot if the repo's roadmap doc tracks it (grep `roadmap` in docs/).

- [ ] **Step 4: Commit + merge prep**

```bash
git add docs/preview.md docs/decode-bench.md
git commit -m "docs(decode-engine): D4 evergreen updates — HW budget, downgrade semantics, bench note

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Then hand off per `superpowers:finishing-a-development-branch` (user's pattern: FF-merge to local main, branch deleted, push deferred). NOT in scope here: Phase D5/D6 (export-side decode + proxy-policy flip — second plan), Plan B res-throttle (follow-on), deleting the dual-engine spec (happens after D6 when the content consolidates).

---

## Self-review checklist (ran at authoring)

- **Spec coverage (Phase D1–D4 lines 367-373 + supporting sections):** D1 split/gate/installer → Tasks 1-6; §"Conditional first-class" lazy-load + LGPL line → Tasks 2-4; D2 resolution module + setting + auto table → Tasks 7-11; tier-2 era-ender → Tasks 9-10 (cell 1); §"Capability probe cache" → Task 13; D3 widened SW lane → Tasks 12-14; gates-table bench rows → Task 15; D4 gate removal/VRAM budget/downgrade → Tasks 16-18; §"Failure & fallback" resolution-time (silent next tier + LogBus info) → Tasks 7/9 (`noteResolution`), runtime (sticky + warn + no-flash rebuild) → Task 18; §"Resource discipline" memory ratchet → Tasks 9/17/19; §Build/CI per-addon unions → Tasks 1/5; new-ADR mandate → Task 11. NOT covered by design: D5/D6 (second plan), macOS/Linux component distribution (spec non-goal), MCP exposure (non-goal), per-source engine override UI (v1.5).
- **Ordering hazards addressed:** core strip only after TS rewire (Task 2 atomic); preview-sw e2e intentionally red between Tasks 8 and 9 (called out in both); typecheck moved to the CI leg that builds both addons (Task 5 Step 2).
- **Type consistency:** `NativeDecode`/`versionInfo` (T1) ↔ loader (T2) ↔ probe methods (T12/T16); `ResolvedSource`/`EngineTier`/`LaneState` (T7) ↔ `decodeCapability.ts` (T9/T14/T17) ↔ Compositor `ResolvedRendererSource` (T9, assetUrl-converted variant — distinct name, conversion at PixiPreview); `classKeyOf` main (T13) ↔ `classKeyOfMedia` renderer twin (T17, comment-pinned); `builtFromKey` naming consistent across T9/T10/T18.
- **Known execution-time verifications (deliberate, flagged inline):** `AppSelect` prop names (T8), `LogEntryInput` literal variants (T9), `getGPUInfo` payload shape (T16), `MediaSummary` width/height field names (T17), VC-1 fixture source recipe (T15), robocopy-vs-cpSync (T3). Each has a stated fallback.





