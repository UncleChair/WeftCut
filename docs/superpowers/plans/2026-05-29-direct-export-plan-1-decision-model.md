# Direct Export — Plan 1: decision-model refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let already-decodable H.264 footage (4K / high-bitrate) export straight from the original instead of through a full 1080p proxy, keeping only a cheap preview proxy for scrubbing.

**Architecture:** Replace the 3-way proxy decision with a 4-way `ProxyPlan` that adds a `DirectExportQuickPreview` class. A new additive `MediaItem.export_uses_original` flag (serde-default `false`, so old projects load unchanged) tells the TS source-resolvers to feed the original to the export decoder while preview still uses a generated quick proxy. Plan 1 uses a *static* decode-capability predicate (H.264 + 8-bit friendly pixel format); Plan 2 swaps in the per-machine WebCodecs probe to extend this to HEVC/AV1.

**Tech Stack:** Rust (Tauri backend, `cargo test`), TypeScript (Vite/Vitest), ffmpeg sidecar.

**Spec:** `docs/superpowers/specs/2026-05-29-direct-export-decodable-sources-design.md`. This plan refines spec §4 (uses an additive `export_uses_original` flag + derived class rather than a stored `decode_class` enum, to minimize migration churn across ~8 construction sites) and defers GOP detection, the settings toggle, the per-clip override, the webview capability probe, and decode-failure recovery to later plans.

**Out of scope (later plans):** webview `DecodeCapabilityProbe` → HEVC/AV1 (Plan 2); `auto_generate_preview_proxy` off-switch + per-clip "Generate/Remove preview proxy" override + runtime decode-failure recovery (Plan 3). Plan 1 ships the default-on behavior (a preview proxy is always generated for `DirectExport`), which is the desired default; only the ability to turn it *off* is deferred.

---

## What ships at the end of Plan 1

A 4K or high-bitrate **H.264** source (e.g. game capture, 4K phone H.264) imports as `DirectExportQuickPreview`: it becomes editable immediately, scrubs on a 720p preview proxy, and **exports decoded straight from the 4K original** — no minutes-long full transcode, no 1080p ceiling, no CRF-22 generational loss. HEVC/AV1 are untouched (still `QuickThenFull`/`FullProxyOnly`) until Plan 2.

---

## Task 1: `ProxyPlan` v2 with `DirectExportQuickPreview`

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs`

- [ ] **Step 1: Replace the enum + add the `decodable_directly` predicate and decide logic**

In `proxy_decision.rs`, replace the `ProxyDecision` enum and `decide` fn (lines 16–38) with:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyPlan {
    /// No proxy. The workspace copy is used directly for BOTH preview and
    /// export. (Formerly `Bypass`.)
    DirectBoth,
    /// Export decodes the original directly; a fast preview proxy is
    /// generated for scrubbing only. No full proxy is produced.
    DirectExportQuickPreview,
    /// Small source: skip the fast phase, generate the full proxy directly.
    FullProxyOnly,
    /// Fast preview proxy first, then the full proxy in the background.
    QuickThenFull,
}

pub fn decide(media: &MediaItem) -> ProxyPlan {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyPlan::DirectBoth;
    }
    if source_is_safe_to_bypass(media) {
        return ProxyPlan::DirectBoth;
    }
    if decodable_directly(media) {
        return ProxyPlan::DirectExportQuickPreview;
    }
    if is_small_source(media) {
        return ProxyPlan::FullProxyOnly;
    }
    ProxyPlan::QuickThenFull
}

/// Static decode-capability predicate for Plan 1: a source WebCodecs can
/// decode on ANY machine without a proxy. H.264 in an 8-bit browser-friendly
/// pixel format qualifies regardless of resolution or bitrate — those only
/// affect *scrub* comfort (handled by the preview proxy), not whether the
/// export decoder can read the original. Plan 2 replaces this body with a
/// per-machine `DecodeCapabilityProfile` lookup (adds HEVC/AV1/VP9).
fn decodable_directly(media: &MediaItem) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    codec_is_h264(&video.codec) && pix_fmt_is_browser_friendly(&video.pix_fmt)
}
```

(`source_is_safe_to_bypass`, `is_small_source`, `codec_is_h264`, `pix_fmt_is_browser_friendly`, `estimated_bitrate_bps` are unchanged.)

- [ ] **Step 2: Rewrite the test module to cover the new variants**

Replace the `#[cfg(test)] mod tests` block's test fns (keep the `video(...)` helper) with:

```rust
    #[test]
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(decide(&video(|_| {})), ProxyPlan::DirectBoth);
    }

    #[test]
    fn direct_export_for_4k_h264() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(decide(&item), ProxyPlan::DirectExportQuickPreview);
    }

    #[test]
    fn direct_export_for_high_bitrate_h264_1080p() {
        // 1080p H.264 but ~40 Mbps (over the 25 Mbps bypass ceiling).
        let item = video(|m| {
            m.metadata.duration_us = Some(10_000_000);
            m.file_size = 50 * 1024 * 1024;
        });
        assert_eq!(decide(&item), ProxyPlan::DirectExportQuickPreview);
    }

    #[test]
    fn proxy_both_for_large_hevc() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item), ProxyPlan::QuickThenFull);
    }

    #[test]
    fn full_proxy_for_small_non_decodable_source() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.file_size = 10_000_000;
        });
        assert_eq!(decide(&item), ProxyPlan::FullProxyOnly);
    }

    #[test]
    fn proxy_both_for_10bit_h264() {
        // 10-bit pixel format is not browser-friendly → not directly
        // decodable; large source routes to QuickThenFull.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.pix_fmt = "yuv420p10le".into();
            v.width = 3840;
            v.height = 2160;
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item), ProxyPlan::QuickThenFull);
    }
```

- [ ] **Step 3: Run the tests — expect FAIL to compile (callers still say `ProxyDecision`)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml proxy_decision`
Expected: compile error in `jobs/mod.rs` (`ProxyDecision` no longer exists). That's fixed in Task 3 — proceed; do not commit yet.

---

## Task 2: `MediaItem.export_uses_original` field + patch plumbing

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/media.rs`
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (patch struct + apply + a test)
- Modify (add one field to each `MediaItem {…}` literal): `apps/desktop/src-tauri/src/workspace.rs:74`, `apps/desktop/src-tauri/src/commands.rs:1539`, `apps/desktop/src-tauri/src/io/mod.rs:223,286,324,394`, `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` (test helper ~line 115), `apps/desktop/src-tauri/src/jobs/quick_proxy.rs` (test helper ~line 211)

- [ ] **Step 1: Add the field to `MediaItem`**

In `media.rs`, after the `proxy_bypassed` field (line 35) add:

```rust
    /// True when the export path may decode the ORIGINAL workspace copy
    /// directly (WebCodecs can decode it) even though a preview proxy is
    /// still generated for scrubbing. Distinct from `proxy_bypassed`, which
    /// means *no proxy at all* (original for preview AND export).
    #[serde(default)]
    pub export_uses_original: bool,
```

- [ ] **Step 2: Add a serde-default round-trip test in `media.rs`**

Add a `#[cfg(test)] mod tests` (or extend if present) in `media.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_uses_original_defaults_false_for_old_projects() {
        // A `.vproj` MediaItem written before this field existed must load
        // as `export_uses_original: false`.
        let json = r#"{
            "id": "00000000-0000-0000-0000-000000000000",
            "label": null,
            "path_abs": "clip.mp4",
            "path_rel": null,
            "kind": "Video",
            "metadata": { "duration_us": null, "video": null, "audio": null },
            "proxy_path": null,
            "quick_proxy_path": null,
            "proxy_bypassed": true,
            "waveform_path": null,
            "thumbnails_dir": null,
            "file_hash_blake3": "abc",
            "file_size": 1,
            "file_mtime": 0,
            "imported_at": "2026-05-29T00:00:00Z"
        }"#;
        let item: MediaItem = serde_json::from_str(json).unwrap();
        assert!(!item.export_uses_original);
        assert!(item.proxy_bypassed);
    }
}
```

- [ ] **Step 3: Run it — expect FAIL to compile (literals missing the field)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml export_uses_original_defaults`
Expected: compile errors — "missing field `export_uses_original`" at each `MediaItem {…}` literal.

- [ ] **Step 4: Add `export_uses_original: false,` to every `MediaItem` literal**

At each site listed under **Files** above, add the line `export_uses_original: false,` adjacent to the existing `proxy_bypassed: …,` line. There are 8 sites (2 test helpers + 6 production constructors).

- [ ] **Step 5: Add the patch field to `MediaDerivativesPatch` and its apply**

In `actor.rs`, in `struct MediaDerivativesPatch` (after `proxy_bypassed: Option<bool>`, line 210) add:

```rust
    /// Marks the original as the export decode source (preview still uses a
    /// generated proxy). `None` leaves the flag unchanged.
    pub export_uses_original: Option<bool>,
```

In the apply block (after the `proxy_bypassed` arm, ~line 2745) add:

```rust
        if let Some(v) = patch.export_uses_original {
            item.export_uses_original = v;
        }
```

- [ ] **Step 6: Extend the `set_media_derivatives` test**

In `actor.rs` test `set_media_derivatives_patches_in_place_outside_history` (~line 6029), add to the patch and assert:

```rust
                    export_uses_original: Some(true),
```
…inside the `MediaDerivativesPatch {…}`, and after the existing assertions add:
```rust
        // (Fetch the item again via the same accessor the test already uses
        //  and assert `export_uses_original` is true.)
```
Mirror whatever read-back the existing assertions use (e.g. the media summary / item fetch already in the test) to assert `export_uses_original == true`.

- [ ] **Step 7: Run the state tests — expect PASS**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml state::`
Expected: PASS (media + actor tests green). `jobs/mod.rs` still won't compile — Task 3.

---

## Task 3: Import flow — branch on `ProxyPlan` + preview-only quick proxy

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs` (`spawn_proxy_decision` match; `spawn_quick_proxy` signature)

- [ ] **Step 1: Add a `then_full` parameter to `spawn_quick_proxy`**

Change the signature (line 264) to:

```rust
fn spawn_quick_proxy(
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
    then_full: bool,
) {
```

Replace the unconditional chain at the end of the spawned task (lines 334–337) with:

```rust
        if then_full {
            // Full proxy chains after the quick proxy; refresh hash/paths in
            // case the workspace copy + blake3 landed while Phase 1 was queued.
            let media = fresh_media_item(&project, media_id, media).await;
            spawn_proxy(app, cache, project, media);
        }
```

- [ ] **Step 2: Update the `decide` match arms in `spawn_proxy_decision`**

Replace the `match proxy_decision::decide(&media) {…}` arms (lines 140–190). Keep the existing `Bypass` arm body verbatim but rename its pattern to `ProxyPlan::DirectBoth`. Change `FullProxyOnly`/`QuickProxyThenFull` patterns to `ProxyPlan::FullProxyOnly` / `ProxyPlan::QuickThenFull`, and make the `QuickThenFull` arm pass `true`:

```rust
        match proxy_decision::decide(&media) {
            proxy_decision::ProxyPlan::DirectBoth => {
                // ... unchanged bypass branch body (lines 142–182) ...
            }
            proxy_decision::ProxyPlan::DirectExportQuickPreview => {
                emit(
                    &app,
                    EVENT_STARTED,
                    &JobStarted {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                    },
                );
                let patch = MediaDerivativesPatch {
                    proxy_path: Some(None),
                    proxy_bypassed: Some(false),
                    export_uses_original: Some(true),
                    ..Default::default()
                };
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("direct-export commit failed for {media_id}: {e}");
                    emit(
                        &app,
                        EVENT_ERROR,
                        &JobError {
                            media_id: media_id.to_string(),
                            kind: JobKind::ProxyBypass,
                            error: format!("commit: {e}"),
                        },
                    );
                    return;
                }
                info!("direct-export accepted for {media_id}; preview proxy queued");
                emit(
                    &app,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                // Thumbnails + waveform off the original; preview proxy in the
                // background WITHOUT chaining a full proxy.
                spawn_decorations(app.clone(), cache.clone(), project.clone(), media.clone());
                spawn_quick_proxy(app, cache, project, media, false);
            }
            proxy_decision::ProxyPlan::FullProxyOnly => {
                spawn_proxy(app, cache, project, media);
            }
            proxy_decision::ProxyPlan::QuickThenFull => {
                spawn_quick_proxy(app, cache, project, media, true);
            }
        }
```

> Note: the `DirectExportQuickPreview` commit reuses `JobKind::ProxyBypass` for its started/complete events. Readiness is driven by `export_uses_original` (Task 5), so the clip is editable on commit; the preview proxy then emits its own `QuickProxy` events. A dedicated `JobKind` is deferred to Plan 3 (UI).

- [ ] **Step 3: Build the whole backend — expect PASS**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: clean build (all `ProxyDecision`/arity errors resolved).

- [ ] **Step 4: Run the full backend test suite — expect PASS**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit (Tasks 1–3 together — first compiling checkpoint)**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/mod.rs apps/desktop/src-tauri/src/state/media.rs apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src-tauri/src/workspace.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/io/mod.rs apps/desktop/src-tauri/src/jobs/quick_proxy.rs
git commit -m "feat(import): DirectExport plan — export decodable H.264 from original

Adds ProxyPlan::DirectExportQuickPreview + MediaItem.export_uses_original.
4K / high-bitrate H.264 now exports from the original with a preview-only
quick proxy; no full transcode. Backend only; TS resolvers in next commit."
```

---

## Task 4: Bump the preview proxy to 720p (with cache bust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/quick_proxy.rs:18`
- Modify: `apps/desktop/src-tauri/src/cache/mod.rs:105-106` + its test (~line 295)

- [ ] **Step 1: Change the cache filename so stale 540p entries don't get reused**

In `cache/mod.rs`, change `quick_proxy` (line 105–106):

```rust
    /// Fast preview-first proxy for a hashed media file. The `q2` segment is
    /// the recipe version — bumped when the quick-proxy ffmpeg args change
    /// (e.g. 540p → 720p) so stale cached proxies are regenerated, not reused.
    pub fn quick_proxy(&self, hash: &str) -> PathBuf {
        self.proxies_dir().join(format!("{hash}.quick-q2.mp4"))
    }
```

- [ ] **Step 2: Update the cache-layout test**

In `cache/mod.rs` tests (~line 295), change the expected filename:

```rust
        assert_eq!(
            layout.quick_proxy("abc"),
            tmp.path().join("proxies").join("abc.quick-q2.mp4"),
        );
```

- [ ] **Step 3: Run the cache test — expect PASS**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cache::`
Expected: PASS.

- [ ] **Step 4: Bump the height cap to 720**

In `quick_proxy.rs` line 18:

```rust
const QUICK_PROXY_HEIGHT_CAP: u32 = 720;
```

- [ ] **Step 5: Run quick_proxy tests + build — expect PASS**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml quick_proxy && cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS (the `can_remux`/`gop` tests don't depend on the height constant).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/quick_proxy.rs apps/desktop/src-tauri/src/cache/mod.rs
git commit -m "feat(import): preview proxy 540p -> 720p (cache-busted)

The preview proxy is now the only preview surface for DirectExport clips
(no full proxy to sharpen into), so raise it to 720p. Cache filename gains
a recipe-version segment so stale 540p proxies regenerate."
```

---

## Task 5: TS source-resolvers + readiness see `export_uses_original`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`MediaSummary` struct line 214 + builder line ~399)
- Modify: `apps/desktop/src/ipc/index.ts:25-47` (`MediaSummary` type)
- Modify: `apps/desktop/src/state/projectStore.ts:147-165` (both resolvers)
- Modify: `apps/desktop/src/panels/mediaReadiness.ts:33`
- Test: `apps/desktop/src/panels/mediaReadiness.test.ts`
- Test (create): `apps/desktop/src/state/projectStore.proxyPaths.test.ts`

- [ ] **Step 1: Expose the field over IPC (Rust `MediaSummary`)**

In `commands.rs`, after `proxy_bypassed: bool,` (line 237) add:

```rust
    /// True when export may decode the original directly (preview still uses
    /// a generated proxy). See `MediaItem::export_uses_original`.
    pub export_uses_original: bool,
```

In the builder (after `proxy_bypassed: m.proxy_bypassed,` line 399) add:

```rust
                export_uses_original: m.export_uses_original,
```

- [ ] **Step 2: Add the field to the TS `MediaSummary` type**

In `ipc/index.ts`, after `proxy_bypassed: boolean;` (line 46) add:

```ts
  /// True when export may decode the original directly (preview still uses a
  /// generated proxy). Export and preview resolvers treat it like a bypass.
  export_uses_original: boolean;
```

- [ ] **Step 3: Write failing resolver tests**

Create `apps/desktop/src/state/projectStore.proxyPaths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { previewPlaybackPathFor, exportPlaybackPathFor } from "./projectStore";
import type { MediaSummary } from "../ipc";

function video(over: Partial<MediaSummary>): MediaSummary {
  return {
    id: "m1",
    label: "clip",
    path: "/orig.mp4",
    available: true,
    kind: "Video",
    proxy_path: null,
    quick_proxy_path: null,
    proxy_bypassed: false,
    export_uses_original: false,
    ...over,
  } as MediaSummary;
}

describe("direct-export source resolution", () => {
  it("export reads the original when export_uses_original", () => {
    const m = video({ export_uses_original: true });
    expect(exportPlaybackPathFor(m)).toBe("/orig.mp4");
  });

  it("export still prefers a full proxy when present", () => {
    const m = video({ export_uses_original: true, proxy_path: "/proxy.mp4" });
    expect(exportPlaybackPathFor(m)).toBe("/proxy.mp4");
  });

  it("preview uses the quick proxy when present even for direct-export", () => {
    const m = video({ export_uses_original: true, quick_proxy_path: "/q.mp4" });
    expect(previewPlaybackPathFor(m)).toBe("/q.mp4");
  });

  it("preview falls back to the original before the quick proxy lands", () => {
    const m = video({ export_uses_original: true });
    expect(previewPlaybackPathFor(m)).toBe("/orig.mp4");
  });

  it("non-direct-export non-bypass video is not exportable from source", () => {
    expect(exportPlaybackPathFor(video({}))).toBeNull();
  });
});
```

> Verify the import names: `projectStore.ts` exports `exportPlaybackPathFor`; confirm `previewPlaybackPathFor` is also exported (add `export` to its `function` declaration at ~line 145 if it isn't). Match the `MediaSummary` field names/types in the fixture against `ipc/index.ts` (e.g. `available`, `kind` casing) and adjust the fixture if the real type differs.

- [ ] **Step 4: Run — expect FAIL**

Run: `cd apps/desktop && npx vitest run src/state/projectStore.proxyPaths.test.ts`
Expected: FAIL (resolvers don't yet honor `export_uses_original`).

- [ ] **Step 5: Update the resolvers**

In `projectStore.ts`, in `previewPlaybackPathFor` change the final video return (line ~151):

```ts
    return media.proxy_bypassed || media.export_uses_original ? media.path : null;
```

In `exportPlaybackPathFor` change the final video return (line ~162):

```ts
    return media.proxy_bypassed || media.export_uses_original ? media.path : null;
```

- [ ] **Step 6: Run resolver tests — expect PASS**

Run: `cd apps/desktop && npx vitest run src/state/projectStore.proxyPaths.test.ts`
Expected: PASS.

- [ ] **Step 7: Update readiness + its test**

In `mediaReadiness.ts` line 33:

```ts
    if (
      media.proxy_path ||
      media.quick_proxy_path ||
      media.proxy_bypassed ||
      media.export_uses_original
    ) {
      return { ready: true };
    }
```

In `mediaReadiness.test.ts`, add a case (match the file's existing fixture helper + assertion style):

```ts
  it("video with export_uses_original is ready", () => {
    const media = makeVideo({ export_uses_original: true });
    expect(mediaReadiness(media, new Set(), new Map())).toEqual({ ready: true });
  });
```

(If the test file builds `MediaSummary` literals inline rather than via a helper, add `export_uses_original: false` to those literals to satisfy the type, and write the new case with `export_uses_original: true`.)

- [ ] **Step 8: Run TS checks — expect PASS**

Run: `cd apps/desktop && npx vitest run src/panels/mediaReadiness.test.ts src/state/projectStore.proxyPaths.test.ts && npm run typecheck`
Expected: PASS + clean typecheck (all `MediaSummary` literals across the TS test suite now need `export_uses_original`; fix any the typecheck flags).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src/ipc/index.ts apps/desktop/src/state/projectStore.ts apps/desktop/src/state/projectStore.proxyPaths.test.ts apps/desktop/src/panels/mediaReadiness.ts apps/desktop/src/panels/mediaReadiness.test.ts
git commit -m "feat(import): TS resolvers export from original for direct-export clips

previewPlaybackPathFor/exportPlaybackPathFor and mediaReadiness now treat
export_uses_original like a bypass for the original-source decision."
```

---

## Final verification

- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — all green.
- [ ] `cd apps/desktop && npm run typecheck && npx vitest run` — all green.
- [ ] Manual smoke (`npm run tauri:dev`): import a 4K H.264 clip. Expect: editable within seconds; a 720p `*.quick-q2.mp4` appears under the proxy cache; **no** full `<hash>.mp4` proxy is generated; the clip is exportable immediately (export decodes the original). Import a 4K HEVC clip and confirm it still routes through the quick-then-full proxy (unchanged until Plan 2).

---

## Self-review

**Spec coverage (Plan 1 slice):**
- Split export vs preview source → Task 1 (`ProxyPlan`) + Task 5 (resolvers). ✓
- "Decodable" predicate (static, H.264) → Task 1 `decodable_directly`. ✓
- Preview proxy retained + 720p bump → Task 4. ✓
- `MediaItem` migration (additive, back-compatible) → Task 2. ✓
- Deferred (GOP, settings toggle, per-clip override, webview probe, decode-failure recovery) → explicitly listed under "Out of scope". ✓

**Placeholder scan:** No "TBD/TODO". Two "verify/match the existing style" notes (Task 2 Step 6, Task 5 Step 3/7) point at real read-backs the engineer confirms against the actual test file — they are not deferred logic; the behavior and assertions are fully specified.

**Type consistency:** `ProxyPlan` variants (`DirectBoth`/`DirectExportQuickPreview`/`FullProxyOnly`/`QuickThenFull`) are used identically in `proxy_decision.rs` and the `jobs/mod.rs` match. `export_uses_original` is the same name in `MediaItem`, `MediaDerivativesPatch`, Rust `MediaSummary`, TS `MediaSummary`, the resolvers, and readiness. `spawn_quick_proxy(..., then_full: bool)` is called with `false` (DirectExport) and `true` (QuickThenFull). Cache helper `quick_proxy` returns the new `*.quick-q2.mp4` name everywhere it's used (generation + hash migration + cleanup all go through the same fn).
