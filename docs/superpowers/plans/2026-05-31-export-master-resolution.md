# Export-Master Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the full proxy's two roles — make it a pure source-resolution (≤4K) export master, and make the quick proxy the permanent preview source — so 4K ProRes/exotic/HDR projects export at full resolution without making preview scrub a 4K stream.

**Architecture:** `quick_proxy` = permanent preview (720p, light); `proxy` = export master at source resolution (`scale=-2:'min(ih,2160)'`, no `-level`, libx264 High → L5.1, CRF 18). Stop deleting the quick proxy when the master lands; flip the preview resolver to prefer it. Every FullProxy-export source now gets a quick proxy (fold `FullProxyOnly` into `QuickThenFull`, removing `is_small` from `job_for`).

**Tech Stack:** Rust (Tauri backend), ffmpeg via `ffmpeg_sidecar`, TypeScript (webview), `cargo test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-05-31-export-master-resolution-design.md`

---

## File Structure

- **Modify** `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` — fold `FullProxyOnly`→`QuickThenFull`: drop `is_small` from `job_for`, remove the `FullOnly` variant, `is_small_source`, and the `DIRECT_FULL_*` consts; update tests (Task 1).
- **Modify** `apps/desktop/src-tauri/src/jobs/mod.rs` — update the spawn match (drop `is_small`, drop the `FullOnly` arm) (Task 1); remove the `quick_proxy_path: Some(None)` clear in `spawn_proxy`'s success patch (Task 3).
- **Modify** `apps/desktop/src-tauri/src/jobs/proxy.rs` — raise the cap to 2160, drop `-level:v 4.2`, CRF 22→18, bump `PROXY_FORMAT_VERSION` 5→6, update the module/version docs; extend the roundtrip test (Task 2).
- **Modify** `apps/desktop/src/state/projectStore.ts` — flip `previewPlaybackPathFor` to prefer `quick_proxy_path` (Task 3).
- **Modify** `apps/desktop/src/state/projectStore.proxyPaths.test.ts` — preview-prefers-quick test (Task 3).
- **Create** `docs/adr/0011-export-master-vs-preview-proxy.md` (Task 4).

Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`. Frontend: from `apps/desktop/`, `npx vitest run <path>`. First Rust compile takes minutes; a Windows "OS error 5" writing the `.exe` while the app runs is a link-step artifact, not a failure.

---

## Task 1: Fold `FullProxyOnly` into `QuickThenFull`

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs:165-262`

Every FullProxy-export source must get a quick proxy (so preview has a light source once the master is source-res). This removes the small-source skip-quick optimization and simplifies `job_for`.

- [ ] **Step 1: Rewrite the `job_for` tests**

In `proxy_decision.rs`, replace the four `job_for` tests (the block under the `// --- job_for(): scheduling oracle ... ` comment — `job_none_for_both_original`, `job_quick_only_for_direct_export`, `job_full_only_for_small_proxy_both`, `job_quick_then_full_for_large_proxy_both`) with:

```rust
    // --- job_for(): scheduling oracle ---

    #[test]
    fn job_none_for_both_original() {
        assert_eq!(job_for(BOTH_ORIGINAL), ProxyJob::None);
    }

    #[test]
    fn job_quick_only_for_direct_export() {
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY), ProxyJob::QuickOnly);
    }

    #[test]
    fn job_quick_then_full_for_proxy_both() {
        // Every FullProxy-export source gets a quick proxy first (preview),
        // then the full master — no small-source skip-quick split.
        assert_eq!(job_for(BOTH_PROXY), ProxyJob::QuickThenFull);
    }
```

- [ ] **Step 2: Run to verify it fails (compile error)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml proxy_decision`
Expected: FAIL — `job_for` still takes two args; `ProxyJob::FullOnly` still referenced elsewhere.

- [ ] **Step 3: Simplify `ProxyJob`, `job_for`, and remove the small-source machinery**

In `proxy_decision.rs`:

1. Remove the two consts (top of file):
```rust
const DIRECT_FULL_MAX_DURATION_US: i64 = 10_000_000;
const DIRECT_FULL_MAX_SIZE_BYTES: u64 = 150 * 1024 * 1024;
```

2. Remove the `FullOnly` variant from `ProxyJob` and update the doc:
```rust
/// Which background proxy job(s) a route implies. Pure policy, unit-tested.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyJob {
    /// No proxy: bypass. Preview + export both read the original.
    None,
    /// Standalone quick scrub proxy; export reads the original (DirectExport).
    QuickOnly,
    /// Quick proxy first (preview), then the full export master in the background.
    QuickThenFull,
}
```

3. Replace `job_for` (drop `is_small`, fold the FullProxy arm):
```rust
/// Map a route to the background proxy job to run.
pub fn job_for(route: ProxyRoute) -> ProxyJob {
    match (route.export, route.preview) {
        (ExportSource::Original, PreviewSource::Original) => ProxyJob::None,
        (ExportSource::Original, PreviewSource::Proxy) => ProxyJob::QuickOnly,
        (ExportSource::FullProxy, PreviewSource::Proxy) => ProxyJob::QuickThenFull,
        (ExportSource::FullProxy, PreviewSource::Original) => {
            unreachable!("preview=Original implies export=Original (safe_to_bypass is a subset of export_decodable_statically)")
        }
    }
}
```

4. Delete the entire `is_small_source` function:
```rust
pub fn is_small_source(media: &MediaItem) -> bool {
    media
        .metadata
        .duration_us
        .map(|d| d > 0 && d <= DIRECT_FULL_MAX_DURATION_US)
        .unwrap_or(false)
        && media.file_size <= DIRECT_FULL_MAX_SIZE_BYTES
}
```

- [ ] **Step 4: Update the `jobs/mod.rs` spawn match**

In `apps/desktop/src-tauri/src/jobs/mod.rs::spawn_proxy_decision`:

1. Remove the line `let is_small = proxy_decision::is_small_source(&media);` and change the match to `match proxy_decision::job_for(route) {`.
2. Delete the `proxy_decision::ProxyJob::FullOnly => { spawn_proxy(app, cache, project, media); }` arm entirely. (Keep `None`, `QuickOnly`, `QuickThenFull` arms unchanged. `spawn_proxy` stays defined — it's still called by `spawn_quick_proxy`'s `then_full` chain and by `ensure_full_proxy`.)

- [ ] **Step 5: Run to verify green**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS — `proxy_decision` tests green; the crate compiles with no `FullOnly`/`is_small_source` references.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/mod.rs
git commit -m "refactor(proxy): every FullProxy source gets a quick proxy (fold FullProxyOnly)"
```

---

## Task 2: Full proxy → source-resolution export master

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy.rs`
- Test: `apps/desktop/src-tauri/src/jobs/proxy.rs` (inline tests)

- [ ] **Step 1: Write the failing resolution test**

Add to `proxy.rs`'s `#[cfg(test)] mod tests` (the `make_test_video` helper takes a `size`? it's hardcoded 640x360 — add a sized fixture):

```rust
    async fn make_sized_video(dest: &std::path::Path, size: &str) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi"])
            .arg("-i")
            .arg(format!("testsrc=duration=1:size={size}:rate=30"))
            .args(["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-t", "1"])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("sized fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn proxy_preserves_source_resolution_above_1080() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping resolution smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let src = tmp.path().join("src1440.mp4");
        make_sized_video(&src, "2560x1440").await.expect("fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("src1440.mp4".into()),
            path_abs: src,
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata { duration_us: Some(1_000_000), video: None, audio: None },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "res1440".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let proxy_path = run(&cache, &media).await.expect("proxy run");
        let out = Command::new("ffprobe")
            .args([
                "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=height",
                "-of", "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe height");
        let height: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
        assert_eq!(height, 1440, "master must preserve 1440p source res, not cap to 1080");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml proxy_preserves_source_resolution_above_1080 -- --nocapture`
Expected: FAIL — height is 1080 (current `PROXY_HEIGHT_CAP = 1080` downscales the 1440p source).

- [ ] **Step 3: Raise the cap, drop the level, lower CRF**

In `proxy.rs`:

1. Change the cap const:
```rust
/// Maximum export-master height. Sources taller than this scale down (bounds
/// the worst-case 8K encode); sources shorter stay native (no upscaling).
const PROXY_HEIGHT_CAP: u32 = 2160;
```

2. In the `output_with_hw_decode_fallback` closure args, **remove** the two lines:
```rust
            "-level:v",
            "4.2",
```
(so libx264 auto-picks a valid level — 5.1 for 4K; keep `-profile:v high`).

3. Change CRF 22 → 18: in the same args, replace
```rust
            "-crf",
            "22",
```
with
```rust
            "-crf",
            "18",
```

- [ ] **Step 4: Bump `PROXY_FORMAT_VERSION` and update docs**

1. Change `pub const PROXY_FORMAT_VERSION: u32 = 5;` to `= 6;` and append after the `5 —` entry:
```rust
///   6 — export master: cap raised 1080p→2160p (source-resolution export,
///       no longer downscaled to 1080p for 4K projects), `-level:v` dropped
///       so 4K H.264 gets a valid auto level (L5.1, `avc1.640033`), CRF
///       22→18 (the proxy is now a pure export intermediate, not also a
///       preview artifact). Preview reads the quick proxy instead. See
///       ADR 0011.
```

2. Update the module doc header (top of file) — change the first line from "Transcodes a video to a 1080p-capped H.264/AAC mp4 that the PixiJS + WebCodecs renderer decodes for both preview and export." to:
```rust
//! Proxy generation. Transcodes a video to a source-resolution (<=4K)
//! H.264/AAC mp4 used as the EXPORT master for sources WebCodecs can't decode
//! directly. Preview reads the lighter quick proxy (see ADR 0011), not this.
//! Output sits at `<cache>/proxies/<file_hash>.mp4`.
```
and the "Encoder: ... capped at 1080p height" line to "capped at 2160p (4K) height".

- [ ] **Step 5: Run to verify green**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml proxy -- --nocapture`
Expected: PASS — `proxy_preserves_source_resolution_above_1080` reports 1440; the existing `proxy_roundtrip_against_real_ffmpeg` (640×360, below the cap) still passes (short GOP, 0 B-frames).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy.rs
git commit -m "feat(proxy): export master at source resolution (<=4K), CRF 18 (format v6)"
```

---

## Task 3: Quick proxy is the permanent preview source

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs` (`spawn_proxy` success patch)
- Modify: `apps/desktop/src/state/projectStore.ts`
- Test: `apps/desktop/src/state/projectStore.proxyPaths.test.ts`

- [ ] **Step 1: Write the failing resolver test**

Add to `projectStore.proxyPaths.test.ts` (inside the `describe` block):

```ts
  it("preview prefers the quick proxy over the full (export master) proxy", () => {
    // ProxyBoth: once the source-res master lands the quick proxy is KEPT;
    // preview must use the light quick proxy, not the heavy 4K master.
    const m = video({ proxy_path: "/master.mp4", quick_proxy_path: "/q.mp4" });
    expect(previewPlaybackPathFor(m)).toBe("/q.mp4");
    expect(exportPlaybackPathFor(m)).toBe("/master.mp4");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop/`): `npx vitest run src/state/projectStore.proxyPaths.test.ts`
Expected: FAIL — `previewPlaybackPathFor` returns `/master.mp4` (current order prefers `proxy_path`).

- [ ] **Step 3: Flip the preview resolver to prefer the quick proxy**

In `projectStore.ts`, replace `previewPlaybackPathFor`'s video branch so `quick_proxy_path` is checked first:

```ts
export function previewPlaybackPathFor(media: MediaSummary | undefined): string | null {
  if (!media) return null;
  if (media.kind === "Video") {
    // Prefer the light quick proxy for preview. The full proxy is now a
    // source-resolution EXPORT master (heavy to scrub); it's a last-resort
    // preview source only if no quick proxy exists (ADR 0011).
    if (media.quick_proxy_path) return media.quick_proxy_path;
    if (media.proxy_path) return media.proxy_path;
    // Preview from the original ONLY for DirectBoth (proxy_bypassed = H.264);
    // a DirectExport source before its quick proxy lands stays null (blank).
    return media.proxy_bypassed ? media.path : null;
  }
  return media.path;
}
```

Leave `exportPlaybackPathFor` unchanged (it still prefers `proxy_path`).

(Piece B invariant preserved: preview still reaches an original only via `proxy_bypassed` = H.264, so it never decodes a non-H.264 original.)

- [ ] **Step 4: Run to verify the resolver tests pass**

Run (from `apps/desktop/`): `npx vitest run src/state/projectStore.proxyPaths.test.ts`
Expected: PASS — the new test plus all existing resolver tests (DirectExport→quick, DirectBoth→original, export-prefers-proxy).

- [ ] **Step 5: Stop clearing the quick proxy when the master lands**

In `apps/desktop/src-tauri/src/jobs/mod.rs::spawn_proxy`, in the success `MediaDerivativesPatch`, **remove** the line `quick_proxy_path: Some(None),` so the quick proxy persists as the preview source after the master lands:

```rust
                let patch = MediaDerivativesPatch {
                    proxy_path: Some(Some(proxy_path)),
                    proxy_format_version: Some(proxy::PROXY_FORMAT_VERSION),
                    proxy_bypassed: Some(false),
                    ..Default::default()
                };
```

- [ ] **Step 6: Verify build + full suites**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS (compiles; the `spawn_proxy` change is a field removal).

Run (from `apps/desktop/`): `npm run test`
Expected: PASS — resolver tests + no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/mod.rs apps/desktop/src/state/projectStore.ts apps/desktop/src/state/projectStore.proxyPaths.test.ts
git commit -m "feat(proxy): quick proxy is the permanent preview source; full proxy export-only"
```

---

## Task 4: ADR 0011

**Files:**
- Create: `docs/adr/0011-export-master-vs-preview-proxy.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0011-export-master-vs-preview-proxy.md`:

```markdown
---
status: accepted
---

# Export master vs. preview proxy (the full proxy stops doubling as preview)

The full proxy (`jobs/proxy.rs`) is a pure **export master** at source
resolution (`scale=-2:'min(ih,2160)'`, libx264 High auto-level, CRF 18); the
**quick proxy** (720p, short-GOP) is the **permanent preview source**. The two
no longer overlap: `quick = preview, full = export`.

`spawn_proxy` no longer clears the quick proxy when the master lands, and
`previewPlaybackPathFor` prefers `quick_proxy_path` over `proxy_path`. Every
FullProxy-export source generates a quick proxy first, then the master
(`FullProxyOnly` folded into `QuickThenFull`; `is_small` removed from `job_for`).

## Why

Previously the full proxy served both roles and was capped at 1080p. After lazy
decodability (ADR 0010), the full proxy is the export source only for
non-WebCodecs-decodable footage (ProRes/MPEG-2, 10-bit/HDR) — and the 1080p cap
silently downscaled 4K projects' exports. Raising the cap for export quality
would make preview scrub a 4K stream (the throughput problem the quick proxy
exists to avoid). Separating the roles fixes export resolution while keeping
preview light, and the master encode (slow at 4K) runs in the background without
blocking editability, since the quick proxy lands first.

## Consequences

- A permanent quick proxy plus a source-res master per FullProxy source (more
  local cache; acceptable).
- The master is a lossy CRF-18 intermediate, re-encoded at export → not original
  quality; unavoidable for codecs WebCodecs can't decode. HDR stays
  8-bit-truncated (resolution improves, color does not — a separate piece).
- Migration: existing 1080p masters (format v5) invalidate on open and
  regenerate at source res via `QuickThenFull` (a transient blank-preview window
  until the regenerated quick proxy lands).
- The 4K-H.264-master WebCodecs decode on the export path is smoke-verified
  (`tauri:dev` 4K export), not unit-tested — it lives in the webview.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0011-export-master-vs-preview-proxy.md
git commit -m "docs(adr): 0011 export master vs preview proxy"
```

---

## Manual verification (gating acceptance — not automated)

The WebCodecs decode of the 4K master lives in the export Worker and can't be shell-probed:

- In `tauri:dev`, import a real **4K ProRes** (or other non-family-codec) clip into a 4K project. Confirm: (a) it's editable via the quick proxy within seconds; (b) preview scrubs the 720p quick proxy (not the 4K master — check the decoder source / PerfHUD); (c) export produces a **4K** file (not 1080p) and the master decodes in the export Worker without error.

---

## Self-Review

**Spec coverage:**
- Full proxy → source-res master (cap 2160, no `-level`, CRF 18, v6) → Task 2. ✅
- Quick proxy permanent (stop clearing) + preview resolver prefers it → Task 3. ✅
- Fold `FullProxyOnly`→`QuickThenFull`, remove `is_small` → Task 1. ✅
- Piece B invariant preserved → Task 3 Step 3 note. ✅
- Migration + blank-preview window → ADR (Task 4) + happens via v6 bump (Task 2). ✅
- Smoke-gated 4K decode + quality honesty + HDR caveat → ADR (Task 4) + manual verification section. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows exact edits.

**Type consistency:** `job_for(route)` (one arg) defined in Task 1 Step 3, called in Task 1 Step 4 (`match proxy_decision::job_for(route)`). `ProxyJob` variants (`None`/`QuickOnly`/`QuickThenFull`) consistent between the enum, `job_for`, the spawn match, and the tests. `PROXY_HEIGHT_CAP = 2160` / `PROXY_FORMAT_VERSION = 6` consistent. `previewPlaybackPathFor` order (quick → proxy → bypass-original) matches the new test's expectation.
```
