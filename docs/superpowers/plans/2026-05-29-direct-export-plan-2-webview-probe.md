# Direct Export — Plan 2: webview decode-capability probe

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let WebCodecs-decodable HEVC / AV1 / VP9 footage take the `DirectExport` path (export from original, preview proxy only) on machines that can actually decode it, falling back to a full ffmpeg proxy where they can't.

**Architecture:** A webview probe runs `VideoDecoder.isConfigSupported(...)` at startup, reports a `DecodeCaps` map to Rust via an IPC command. Rust persists it in a managed `DecodeCapabilityStore` (mirrors `AppSettingsStore`). `proxy_decision::decide` gains a `&DecodeCaps` argument; `decodable_directly` becomes codec-aware (H.264 always; HEVC/AV1/VP9 gated by the probe). The import flow reads the store and passes the caps in.

**Tech Stack:** Rust (Tauri, `cargo test`), TypeScript (Vitest), WebCodecs.

**Spec:** `docs/superpowers/specs/2026-05-29-direct-export-decodable-sources-design.md`. **Builds on Plan 1** (`2026-05-29-direct-export-plan-1-decision-model.md`), which must be merged/present first — this plan modifies `ProxyPlan`/`decide`/`spawn_proxy_decision` from Plan 1.

**v1 design decisions (refine spec §1/§3 + open questions):**
- **`isConfigSupported`-only, no trial-decode** (spec open-Q #1). It captures essentially all the value: on Windows, HEVC/AV1 `isConfigSupported` returns `true` only when the platform decoder (Store extension) is present, which is also when hardware decode works. Trial-decode (authoring per-codec bitstreams to rule out a slow software path) is deferred as a future hardening lever; if false positives surface, add it then.
- **No invalidation key.** The webview re-probes and re-reports on every startup, so the store is always fresh for that session; the persisted copy only serves imports that happen in the brief window before the first report lands. (GPU/driver/WebView2-version keying is a future refinement.)
- **HEVC takes `DirectExport`, not `DirectBoth`** (spec open-Q #2): HEVC is never previewed from the original in v1 — preview always uses a proxy. So no GOP analysis is needed here either.

**Out of scope (Plan 3):** `auto_generate_preview_proxy` off-switch, per-clip override, runtime decode-failure recovery. 10-bit/HDR stays carved out (`pix_fmt_is_browser_friendly` already excludes it).

**⚠️ Verification reality:** the probe's real output depends on the WebView2 runtime + OS codec extensions + GPU. Unit tests cover the pure logic (capability map → decision; store persistence; probe summarization), but the **end-to-end confirmation (HEVC clip imports as DirectExport, exports from original) requires running `tauri:dev` on a machine with the HEVC extension** — it cannot be verified headlessly. This is called out again at the end.

---

## Task 1: `DecodeCaps` + `DecodeCapabilityStore` (Rust)

**Files:**
- Create: `apps/desktop/src-tauri/src/decode_caps.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `mod decode_caps;` near the other `mod` lines ~11; `app.manage(...)` near line 212)

- [ ] **Step 1: Write the store with tests**

Create `decode_caps.rs` (mirrors `app_settings.rs` persistence discipline):

```rust
//! Per-machine WebCodecs decode capability, reported by the webview probe
//! (`src/decode/probeDecodeCaps.ts`) at startup and persisted so the first
//! import after launch — before the probe round-trips — can still use the
//! previous session's verdict. H.264 is always decodable and is NOT stored.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const DECODE_CAPS_FILE: &str = "decode_caps.json";

/// Codecs WebCodecs can decode on this machine (beyond H.264, which is
/// always decodable). Missing fields default false (conservative).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodeCaps {
    #[serde(default)]
    pub hevc: bool,
    #[serde(default)]
    pub av1: bool,
    #[serde(default)]
    pub vp9: bool,
}

impl DecodeCaps {
    /// Conservative default used when no probe has reported yet: only
    /// H.264 is treated as directly decodable.
    pub fn none() -> Self {
        Self::default()
    }
}

#[derive(Clone)]
pub struct DecodeCapabilityStore {
    path: Arc<RwLock<PathBuf>>,
}

impl DecodeCapabilityStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: Arc::new(RwLock::new(config_dir.join(DECODE_CAPS_FILE))),
        }
    }

    pub fn get(&self) -> DecodeCaps {
        let path = self.path.read().expect("decode_caps path lock").clone();
        if !path.exists() {
            return DecodeCaps::none();
        }
        match fs::read_to_string(&path) {
            Ok(body) if !body.trim().is_empty() => {
                serde_json::from_str(&body).unwrap_or_else(|e| {
                    tracing::warn!("decode_caps parse {}: {e:#}", path.display());
                    DecodeCaps::none()
                })
            }
            Ok(_) => DecodeCaps::none(),
            Err(e) => {
                tracing::warn!("decode_caps read {}: {e:#}", path.display());
                DecodeCaps::none()
            }
        }
    }

    pub fn set(&self, caps: DecodeCaps) -> Result<()> {
        let path = self.path.read().expect("decode_caps path lock").clone();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&caps).context("serialize decode_caps")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, &path)
            .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn none_when_no_file() {
        let tmp = TempDir::new().unwrap();
        let store = DecodeCapabilityStore::new(tmp.path().to_path_buf());
        assert_eq!(store.get(), DecodeCaps::none());
    }

    #[test]
    fn set_then_get_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let store = DecodeCapabilityStore::new(tmp.path().to_path_buf());
        store.set(DecodeCaps { hevc: true, av1: true, vp9: false }).unwrap();
        let got = DecodeCapabilityStore::new(tmp.path().to_path_buf()).get();
        assert!(got.hevc && got.av1 && !got.vp9);
    }

    #[test]
    fn corrupt_file_falls_back_to_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(DECODE_CAPS_FILE);
        fs::write(&path, "{ not json").unwrap();
        let store = DecodeCapabilityStore::new(tmp.path().to_path_buf());
        assert_eq!(store.get(), DecodeCaps::none());
    }

    #[test]
    fn missing_field_defaults_false() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(DECODE_CAPS_FILE);
        fs::write(&path, r#"{ "hevc": true }"#).unwrap();
        let got = DecodeCapabilityStore::new(tmp.path().to_path_buf()).get();
        assert!(got.hevc && !got.av1 && !got.vp9);
    }
}
```

- [ ] **Step 2: Register the module + managed store**

In `lib.rs`, add `mod decode_caps;` alongside the other module declarations (near line 11, after `mod cache;`). Then near line 212 (after the `AppSettingsStore` manage), add:

```rust
            // Per-machine WebCodecs decode capability (Plan 2). The webview
            // probe reports on startup; persisted so the first import after
            // launch uses last session's verdict.
            app.manage(decode_caps::DecodeCapabilityStore::new(config_dir.clone()));
```

> Note: `config_dir` is moved into `AppSettingsStore::new(config_dir)` on line 212. Change that call to `AppSettingsStore::new(config_dir.clone())` and add the `DecodeCapabilityStore` manage immediately after, so both get a clone. Confirm `config_dir` isn't used after this point; if it is, the clones cover it.

- [ ] **Step 3: Run the store tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml decode_caps`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/decode_caps.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(import): DecodeCapabilityStore for per-machine WebCodecs caps"
```

---

## Task 2: `decide` consults `DecodeCaps`

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs`

- [ ] **Step 1: Make `decide` codec-aware**

Change the signature and `decodable_directly` (replace the Plan 1 versions):

```rust
use crate::decode_caps::DecodeCaps;
use crate::state::{MediaItem, MediaKind};

pub fn decide(media: &MediaItem, caps: &DecodeCaps) -> ProxyPlan {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyPlan::DirectBoth;
    }
    if source_is_safe_to_bypass(media) {
        return ProxyPlan::DirectBoth;
    }
    if decodable_directly(media, caps) {
        return ProxyPlan::DirectExportQuickPreview;
    }
    if is_small_source(media) {
        return ProxyPlan::FullProxyOnly;
    }
    ProxyPlan::QuickThenFull
}

/// A source WebCodecs can decode on THIS machine without a proxy. H.264 is
/// universal; HEVC/AV1/VP9 are gated by the webview probe (`DecodeCaps`).
/// Requires an 8-bit browser-friendly pixel format either way — 10-bit/HDR
/// stays carved out to a proxy (the render+encode path is 8-bit).
fn decodable_directly(media: &MediaItem, caps: &DecodeCaps) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    if !pix_fmt_is_browser_friendly(&video.pix_fmt) {
        return false;
    }
    let codec = video.codec.to_ascii_lowercase();
    if codec_is_h264(&codec) {
        return true;
    }
    if codec_is_hevc(&codec) {
        return caps.hevc;
    }
    if codec_is_av1(&codec) {
        return caps.av1;
    }
    if codec_is_vp9(&codec) {
        return caps.vp9;
    }
    false
}

pub fn codec_is_hevc(codec: &str) -> bool {
    matches!(codec.to_ascii_lowercase().as_str(), "hevc" | "h265" | "hvc1" | "hev1")
}

pub fn codec_is_av1(codec: &str) -> bool {
    matches!(codec.to_ascii_lowercase().as_str(), "av1" | "av01")
}

pub fn codec_is_vp9(codec: &str) -> bool {
    matches!(codec.to_ascii_lowercase().as_str(), "vp9" | "vp09")
}
```

- [ ] **Step 2: Update Plan 1's tests to pass caps + add HEVC cases**

In the test module, every `decide(&item)` call becomes `decide(&item, &caps)`. Replace the test bodies' decide calls and add HEVC cases. The existing Plan 1 cases use `DecodeCaps::none()` (H.264-only) so they keep their expected results; the HEVC source that was `QuickThenFull`/`FullProxyOnly` under `none()` becomes `DirectExportQuickPreview` under `hevc: true`:

```rust
    use crate::decode_caps::DecodeCaps;

    #[test]
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(decide(&video(|_| {}), &DecodeCaps::none()), ProxyPlan::DirectBoth);
    }

    #[test]
    fn direct_export_for_4k_h264_without_caps() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none()),
            ProxyPlan::DirectExportQuickPreview
        );
    }

    #[test]
    fn hevc_is_proxy_both_without_caps() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, &DecodeCaps::none()), ProxyPlan::QuickThenFull);
    }

    #[test]
    fn hevc_is_direct_export_when_caps_allow() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        let caps = DecodeCaps { hevc: true, ..Default::default() };
        assert_eq!(decide(&item, &caps), ProxyPlan::DirectExportQuickPreview);
    }

    #[test]
    fn hevc_10bit_stays_proxy_even_with_caps() {
        // 10-bit is not browser-friendly → carve-out regardless of caps.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        let caps = DecodeCaps { hevc: true, ..Default::default() };
        assert_eq!(decide(&item, &caps), ProxyPlan::QuickThenFull);
    }

    #[test]
    fn av1_gated_by_caps() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, &DecodeCaps::none()), ProxyPlan::QuickThenFull);
        let caps = DecodeCaps { av1: true, ..Default::default() };
        assert_eq!(decide(&item, &caps), ProxyPlan::DirectExportQuickPreview);
    }
```

(Keep the Plan 1 `direct_export_for_high_bitrate_h264_1080p` and `full_proxy_for_small_non_decodable_source` tests, updating their `decide(&item)` calls to `decide(&item, &DecodeCaps::none())`.)

- [ ] **Step 3: Run — expect FAIL to compile (caller in jobs/mod.rs)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml proxy_decision`
Expected: compile error at `spawn_proxy_decision` (decide now takes 2 args). Fixed in Task 3.

---

## Task 3: Import flow passes caps into `decide`

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs` (`spawn_proxy_decision`)

- [ ] **Step 1: Read the capability store and pass it in**

`spawn_proxy_decision(app: AppHandle, ...)` already holds the `AppHandle`. Inside the `tokio::spawn` block, before the `match`, read the managed store. Replace `match proxy_decision::decide(&media) {` with:

```rust
        use tauri::Manager;
        let caps = app
            .try_state::<crate::decode_caps::DecodeCapabilityStore>()
            .map(|s| s.get())
            .unwrap_or_default();
        match proxy_decision::decide(&media, &caps) {
```

> `try_state` (not `state`) so a missing manager (e.g. in a future headless context) degrades to `DecodeCaps::none()` rather than panicking. `unwrap_or_default()` yields `DecodeCaps::none()`.

- [ ] **Step 2: Build + run the full backend suite**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: all pass (Plan 1 tests + new HEVC/AV1 cases + store tests).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/mod.rs
git commit -m "feat(import): decide() consults per-machine DecodeCaps for HEVC/AV1/VP9"
```

---

## Task 4: IPC command `report_decode_caps`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (new command, near `app_settings_set` ~line 1345)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register in `generate_handler!` ~line 101)

- [ ] **Step 1: Add the command**

In `commands.rs`, after `app_settings_set`:

```rust
#[tauri::command]
pub async fn report_decode_caps(
    store: State<'_, crate::decode_caps::DecodeCapabilityStore>,
    caps: crate::decode_caps::DecodeCaps,
) -> Result<(), String> {
    store.set(caps).map_err(|e| format!("{e:#}"))?;
    tracing::info!("decode caps reported: {caps:?}");
    Ok(())
}
```

- [ ] **Step 2: Register the handler**

In `lib.rs` `generate_handler!`, after `commands::app_settings_set,` (line 101) add:

```rust
            commands::report_decode_caps,
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(import): report_decode_caps IPC command"
```

---

## Task 5: Webview probe (pure core + wiring)

**Files:**
- Create: `apps/desktop/src/decode/probeDecodeCaps.ts`
- Create (test): `apps/desktop/src/decode/probeDecodeCaps.test.ts`
- Modify: `apps/desktop/src/ipc/index.ts` (add `DecodeCaps` type + `reportDecodeCaps` wrapper)
- Modify: `apps/desktop/src/App.tsx` (kick off the probe on mount)

- [ ] **Step 1: Write the probe with a unit-testable pure core**

Create `probeDecodeCaps.ts`:

```ts
// Per-machine WebCodecs decode capability probe. Runs at startup, asks
// `VideoDecoder.isConfigSupported` for the codecs we'd want to DirectExport,
// and reports the result to Rust (`report_decode_caps`). H.264 is assumed
// universal and not probed.
//
// v1 is isConfigSupported-only (no trial-decode): on Windows, HEVC/AV1
// report supported exactly when the platform decoder is installed, which is
// when hardware decode works. See the Plan 2 doc for the rationale.

import { reportDecodeCaps, type DecodeCaps } from "../ipc";

/// codec string → which DecodeCaps field it proves. Codec strings are the
/// canonical WebCodecs ids at a representative profile/level/resolution.
export const PROBE_CONFIGS: ReadonlyArray<{
  key: keyof DecodeCaps;
  config: VideoDecoderConfig;
}> = [
  {
    key: "hevc",
    // HEVC Main, Level 5.1 (4K capable), 8-bit.
    config: { codec: "hev1.1.6.L153.B0", codedWidth: 3840, codedHeight: 2160 },
  },
  {
    key: "av1",
    // AV1 Main profile, level 5.1, 8-bit.
    config: { codec: "av01.0.12M.08", codedWidth: 3840, codedHeight: 2160 },
  },
  {
    key: "vp9",
    // VP9 profile 0, level 5.1, 8-bit.
    config: { codec: "vp09.00.51.08", codedWidth: 3840, codedHeight: 2160 },
  },
];

/// Pure: fold an array of (key, supported) probe results into a DecodeCaps.
/// Unit-testable without a real `VideoDecoder`.
export function summarizeProbe(
  results: ReadonlyArray<{ key: keyof DecodeCaps; supported: boolean }>,
): DecodeCaps {
  const caps: DecodeCaps = { hevc: false, av1: false, vp9: false };
  for (const r of results) caps[r.key] = r.supported;
  return caps;
}

/// Impure: run the probe and report to Rust. Best-effort — any failure
/// leaves the persisted caps untouched (Rust treats absence as
/// H.264-only). Never throws into the caller.
export async function probeAndReportDecodeCaps(): Promise<void> {
  // WebCodecs may be absent (SSR/test). Bail to a conservative report.
  if (typeof VideoDecoder === "undefined" || !VideoDecoder.isConfigSupported) {
    return;
  }
  const results: { key: keyof DecodeCaps; supported: boolean }[] = [];
  for (const { key, config } of PROBE_CONFIGS) {
    try {
      const res = await VideoDecoder.isConfigSupported(config);
      results.push({ key, supported: res.supported === true });
    } catch {
      results.push({ key, supported: false });
    }
  }
  const caps = summarizeProbe(results);
  try {
    await reportDecodeCaps(caps);
  } catch (e) {
    console.warn("reportDecodeCaps failed:", e);
  }
}
```

- [ ] **Step 2: Write failing tests for the pure core**

Create `probeDecodeCaps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { summarizeProbe, PROBE_CONFIGS } from "./probeDecodeCaps";

describe("summarizeProbe", () => {
  it("maps supported results onto the right fields", () => {
    const caps = summarizeProbe([
      { key: "hevc", supported: true },
      { key: "av1", supported: false },
      { key: "vp9", supported: true },
    ]);
    expect(caps).toEqual({ hevc: true, av1: false, vp9: true });
  });

  it("defaults everything false with no results", () => {
    expect(summarizeProbe([])).toEqual({ hevc: false, av1: false, vp9: false });
  });

  it("probes one config per DecodeCaps field", () => {
    const keys = PROBE_CONFIGS.map((c) => c.key).sort();
    expect(keys).toEqual(["av1", "hevc", "vp9"]);
  });
});
```

- [ ] **Step 3: Run — expect FAIL (module/type not yet wired in ipc)**

Run: `cd apps/desktop && npx vitest run src/decode/probeDecodeCaps.test.ts`
Expected: FAIL — `reportDecodeCaps`/`DecodeCaps` not exported from `../ipc`.

- [ ] **Step 4: Add the IPC type + wrapper**

In `ipc/index.ts`, add (near the other `invoke` wrappers):

```ts
export interface DecodeCaps {
  hevc: boolean;
  av1: boolean;
  vp9: boolean;
}

/// Report this machine's WebCodecs decode capability to the backend, which
/// persists it for the proxy-decision policy. Best-effort, fire-and-forget.
export async function reportDecodeCaps(caps: DecodeCaps): Promise<void> {
  await invoke("report_decode_caps", { caps });
}
```

- [ ] **Step 5: Run the probe tests — expect PASS**

Run: `cd apps/desktop && npx vitest run src/decode/probeDecodeCaps.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Kick off the probe on app mount**

In `App.tsx`, find where `wireAppSettingsStream()` is called on mount (a `useEffect`). Add a fire-and-forget probe call alongside it:

```ts
import { probeAndReportDecodeCaps } from "./decode/probeDecodeCaps";
```
and inside that mount effect:
```ts
    void probeAndReportDecodeCaps();
```

> It's fire-and-forget: it doesn't block boot and reports whenever it resolves. Imports that happen before it lands use the persisted (previous-session) or conservative caps.

- [ ] **Step 7: Typecheck-delta + vitest**

Run: `cd apps/desktop && npx vitest run && (npx tsc --noEmit -p tsconfig.json; echo done)`
Expected: vitest all green. For tsc, compare the error set to `main`'s as in Plan 1 (the repo's `tsc -b --noEmit` is environmentally broken — TS6310); confirm **no new errors** mention `DecodeCaps`/`reportDecodeCaps`/`probeDecodeCaps`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/decode/probeDecodeCaps.ts apps/desktop/src/decode/probeDecodeCaps.test.ts apps/desktop/src/ipc/index.ts apps/desktop/src/App.tsx
git commit -m "feat(import): webview WebCodecs probe reports decode caps on startup"
```

---

## Final verification

- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — all green.
- [ ] `cd apps/desktop && npx vitest run` — all green.
- [ ] TS: no new type errors vs `main` (Plan 1 method).
- [ ] **Runtime smoke (REQUIRES the app + cannot be headless):** `npm run tauri:dev` on this machine (HEVC extension confirmed installed). Import a 4K HEVC clip. Expect: `decode_caps.json` appears under the app config dir with `"hevc": true`; the clip imports as DirectExport (editable in seconds, a 720p `*.quick-q2.mp4` preview proxy, **no** full `<hash>.mp4`); export decodes the 4K HEVC original directly. On a machine WITHOUT the HEVC extension, the same clip must fall back to the full-proxy path (today's behavior).

---

## Self-review

**Spec coverage:** webview probe (Task 5), capability store keyed per-machine + persisted (Task 1), IPC report (Task 4), decision consults capability (Tasks 2–3), decodability-verdict-lives-in-webview architecture (whole plan). 10-bit carve-out preserved (Task 2 `pix_fmt_is_browser_friendly` gate, tested). Deferred items (trial-decode, invalidation key, settings toggle, recovery) listed explicitly.

**Placeholder scan:** none. The `App.tsx` mount-effect edit (Task 5 Step 6) references the existing `wireAppSettingsStream` effect — confirm its exact location when editing; the added line is fully specified.

**Type consistency:** `DecodeCaps { hevc, av1, vp9 }` is identical across Rust (`decode_caps.rs`), the IPC command param, the TS `ipc` type, and the probe. `decide(&MediaItem, &DecodeCaps)` is the single signature used in `proxy_decision.rs` and `jobs/mod.rs`. `DecodeCaps::none()` / `Default` / `unwrap_or_default()` all yield all-false. `report_decode_caps` (Rust command) ↔ `"report_decode_caps"` (invoke) ↔ `reportDecodeCaps` (TS wrapper) match. Probe codec strings map 1:1 to the three `DecodeCaps` fields.
