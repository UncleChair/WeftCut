# Instant Decodable Preview — Plan 1: widen bypass to the probe-decodable family (Rust)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `decodable_here: Option<bool>` axis to `proxy_decision::decide` so that, once the runtime probe confirms this machine decodes a source, `source_is_safe_to_bypass` widens from "static H.264 only" to the whole **8-bit** decodable family (HEVC/AV1/VP9) — building NO proxy for a decodable + scrub-friendly source. Behavior-preserving at the call site (threads `None`), so this plan ships with zero runtime change and a green unit oracle; later plans supply the `Some(true)` verdict.

**Architecture:** `decide(media, source_gop_secs, decodable_here)`. The export axis is unchanged (`export_decodable_statically`). The preview axis's `source_is_safe_to_bypass` gains the third arg: `Some(true)` → widen the codec/pixfmt gate to `export_decodable_statically` (8-bit family, which already guarantees `export=Original`, preserving the `preview=Original ⟹ export=Original` invariant — so **10-bit never bypasses**); `None`/`Some(false)` → today's static H.264-only gate. `job_for` is untouched (route values are unchanged; the `unreachable!` arm stays unreachable). The import call site passes `None` (the webview probe hasn't run at import).

**Tech Stack:** Rust (Tauri backend, `apps/desktop/src-tauri`), `cargo test`. No TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-01-instant-decodable-preview-design.md` (§A; the 10-bit/invariant refinement is folded into this plan and the spec).

---

## File Structure

- **Modify** `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` — add the `decodable_here` param to `decide` + `source_is_safe_to_bypass`; widen the codec/pixfmt gate under `Some(true)`; update existing tests to the 3-arg call + add the family-widening cases (Task 1).
- **Modify** `apps/desktop/src-tauri/src/jobs/mod.rs:165` — thread `None` into the `decide` call (Task 1).
- **Create** `docs/adr/0012-preview-from-probe-not-static-gate.md` — record that preview-from-original is driven by the runtime probe (not the static pixfmt gate), bypass widens to the 8-bit family, and 10-bit bridges over a kept proxy (Task 2).

All verification commands run from `apps/desktop/src-tauri/`.

---

## Task 1: Add the `decodable_here` axis + widen bypass to the 8-bit family

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs:165`
- Test: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` (inline `#[cfg(test)] mod tests`)

One atomic compile unit: changing `decide`'s arity breaks `jobs/mod.rs` and every test call, so they land together. Behavior is preserved (`None` at the only call site reproduces today's routing exactly).

- [ ] **Step 1: Replace the test module with the widened oracle**

Replace the entire `#[cfg(test)] mod tests { ... }` block at the bottom of `proxy_decision.rs` with the following. Every existing `decide(...)` call gains a third `None` arg (asserting unchanged behavior); the new `decodable_*` cases pin the widening.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{new_id, MediaKind, MediaMetadata, VideoStreamMeta};
    use chrono::Utc;

    fn video(over: impl FnOnce(&mut MediaItem)) -> MediaItem {
        let mut item = MediaItem {
            id: new_id(),
            label: None,
            path_abs: "clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width: 1920,
                    height: 1080,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                }),
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 10_000_000,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        over(&mut item);
        item
    }

    const BOTH_ORIGINAL: ProxyRoute = ProxyRoute {
        export: ExportSource::Original,
        preview: PreviewSource::Original,
    };
    const EXPORT_ORIGINAL_PREVIEW_PROXY: ProxyRoute = ProxyRoute {
        export: ExportSource::Original,
        preview: PreviewSource::Proxy,
    };
    const BOTH_PROXY: ProxyRoute = ProxyRoute {
        export: ExportSource::FullProxy,
        preview: PreviewSource::Proxy,
    };

    // --- decide(): probe-unknown (None) reproduces today's routing exactly ---

    #[test]
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(decide(&video(|_| {}), Some(0.2), None), BOTH_ORIGINAL);
    }

    #[test]
    fn long_gop_friendly_h264_previews_from_proxy() {
        assert_eq!(decide(&video(|_| {}), Some(6.0), None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn unknown_gop_previews_from_proxy() {
        assert_eq!(decide(&video(|_| {}), None, None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn four_k_h264_exports_original_previews_proxy() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(decide(&item, Some(0.2), None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn hevc_8bit_exports_original_previews_proxy_when_probe_unknown() {
        // None (import-time): conservative — bypass stays H.264-only, so an
        // 8-bit HEVC previews from a proxy even though it's short-GOP.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
        });
        assert_eq!(decide(&item, Some(0.2), None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn av1_8bit_exports_original_previews_proxy_when_probe_unknown() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
        });
        assert_eq!(decide(&item, Some(0.2), None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn non_family_codec_proxies_both() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "prores".into();
        });
        assert_eq!(decide(&item, Some(0.2), None), BOTH_PROXY);
    }

    #[test]
    fn hevc_10bit_proxies_both_when_probe_unknown() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
        });
        assert_eq!(decide(&item, Some(0.2), None), BOTH_PROXY);
    }

    #[test]
    fn non_video_routes_to_both_original() {
        let item = video(|m| {
            m.kind = MediaKind::Audio;
        });
        assert_eq!(decide(&item, Some(6.0), None), BOTH_ORIGINAL);
    }

    // --- decide(): probe-confirmed (Some(true)) widens bypass to 8-bit family ---

    #[test]
    fn short_gop_8bit_hevc_bypasses_when_decodable() {
        // The headline widening: a short-GOP 8-bit HEVC the machine can decode
        // now bypasses entirely (no proxy) — preview AND export from original.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
        });
        assert_eq!(decide(&item, Some(0.2), Some(true)), BOTH_ORIGINAL);
    }

    #[test]
    fn short_gop_8bit_av1_bypasses_when_decodable() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
        });
        assert_eq!(decide(&item, Some(0.2), Some(true)), BOTH_ORIGINAL);
    }

    #[test]
    fn short_gop_8bit_hevc_previews_proxy_when_undecodable() {
        // Some(false): probe says this machine can't decode it → conservative.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
        });
        assert_eq!(decide(&item, Some(0.2), Some(false)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn long_gop_8bit_hevc_previews_proxy_even_when_decodable() {
        // Decodable but long-GOP → NOT scrub-friendly → no bypass; the quick
        // proxy is still built. (The frontend bridge — Plan 2 — shows the
        // original meanwhile; that is NOT this function's concern.)
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
        });
        assert_eq!(decide(&item, Some(6.0), Some(true)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn hi10p_does_not_bypass_even_when_decodable() {
        // INVARIANT GUARD: a 10-bit source is export=FullProxy (static gate), so
        // bypassing it would make preview=Original while export=FullProxy — the
        // unreachable route. Bypass is gated on export_decodable_statically, so a
        // decodable short-GOP Hi10P routes BOTH_PROXY (keeps its proxy); its
        // instant preview-from-original is the frontend bridge over that proxy.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
        });
        assert_eq!(decide(&item, Some(0.2), Some(true)), BOTH_PROXY);
    }

    #[test]
    fn four_k_8bit_hevc_previews_proxy_even_when_decodable() {
        // Decodable + 8-bit but 4K (> bypass res) → no bypass; export from
        // original, preview from proxy.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(decide(&item, Some(0.2), Some(true)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn friendly_h264_bypasses_at_some_true_same_as_none() {
        // Widening must not regress H.264: probe-confirmed friendly H.264 still
        // bypasses, identically to the None path.
        assert_eq!(decide(&video(|_| {}), Some(0.2), Some(true)), BOTH_ORIGINAL);
    }

    // --- job_for(): unchanged; the bypass invariant still holds ---

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
        assert_eq!(job_for(BOTH_PROXY), ProxyJob::QuickThenFull);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error)**

Run: `cargo test proxy_decision`
Expected: FAIL — compile errors: `decide` / `source_is_safe_to_bypass` take 2 args but 3 are supplied (the new `None`/`Some(_)` calls), plus the `jobs/mod.rs` call site still passes 2.

- [ ] **Step 3: Add the `decodable_here` param to `decide`**

In `proxy_decision.rs`, replace the `decide` function (currently ~lines 63-81) with:

```rust
/// Route an imported source onto the two axes. `source_gop_secs` is the
/// source's largest keyframe interval (`probe::probe_max_keyframe_gap_secs`),
/// or `None` if unknown. `decodable_here` is the runtime WebCodecs verdict for
/// THIS machine (`probeSourceDecodable`): `None` at import (probe not run yet),
/// `Some(true/false)` once it resolves. It only widens the preview/bypass axis;
/// the export axis stays static (`export_decodable_statically`).
pub fn decide(
    media: &MediaItem,
    source_gop_secs: Option<f64>,
    decodable_here: Option<bool>,
) -> ProxyRoute {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyRoute {
            export: ExportSource::Original,
            preview: PreviewSource::Original,
        };
    }
    let export = if export_decodable_statically(media) {
        ExportSource::Original
    } else {
        ExportSource::FullProxy
    };
    let preview = if source_is_safe_to_bypass(media, source_gop_secs, decodable_here) {
        PreviewSource::Original
    } else {
        PreviewSource::Proxy
    };
    ProxyRoute { export, preview }
}
```

- [ ] **Step 4: Widen `source_is_safe_to_bypass`**

In `proxy_decision.rs`, replace `source_is_safe_to_bypass` (currently ~lines 114-134) with:

```rust
/// Whether a source may be **bypassed entirely** (no proxy: preview AND export
/// read the original). The codec/pixfmt gate has two modes:
///
/// - `decodable_here != Some(true)` (import-time / probe failed / undecodable):
///   conservative — only universally-safe static H.264 + browser-friendly
///   pixfmt.
/// - `decodable_here == Some(true)` (this machine's WebCodecs decoded it):
///   widen to the whole **8-bit** decodable family via `export_decodable_statically`.
///   That predicate already requires an 8-bit browser-friendly pixfmt + a
///   family codec, which guarantees `export == Original` — so the
///   `preview=Original ⟹ export=Original` invariant holds and **10-bit never
///   bypasses** (a 10-bit source is `export=FullProxy`; it keeps its proxy and
///   gets the frontend preview-from-original bridge instead).
///
/// The res/bitrate/GOP scrub-comfort gates apply in both modes.
fn source_is_safe_to_bypass(
    media: &MediaItem,
    source_gop_secs: Option<f64>,
    decodable_here: Option<bool>,
) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    let codec_pixfmt_ok = if decodable_here == Some(true) {
        export_decodable_statically(media)
    } else {
        codec_is_h264(&video.codec) && pix_fmt_is_browser_friendly(&video.pix_fmt)
    };
    if !codec_pixfmt_ok {
        return false;
    }
    if video.width > MAX_BYPASS_WIDTH || video.height > MAX_BYPASS_HEIGHT {
        return false;
    }
    if estimated_bitrate_bps(media) > Some(MAX_BYPASS_BITRATE_BPS) {
        return false;
    }
    if !gop_is_scrub_friendly(source_gop_secs) {
        return false;
    }
    true
}
```

- [ ] **Step 5: Thread `None` at the import call site**

In `apps/desktop/src-tauri/src/jobs/mod.rs`, line 165, change:

```rust
        let route = proxy_decision::decide(&media, source_gop_secs);
```

to:

```rust
        // Import time: the webview decodability probe has not run yet, so the
        // bypass axis stays conservative (static H.264). A later probe verdict
        // re-routes via the downgrade command (Plan 2).
        let route = proxy_decision::decide(&media, source_gop_secs, None);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test proxy_decision`
Expected: PASS — all probe-unknown cases reproduce today's routing; `short_gop_8bit_hevc_bypasses_when_decodable` / `short_gop_8bit_av1_bypasses_when_decodable` now bypass; `hi10p_does_not_bypass_even_when_decodable` asserts `BOTH_PROXY` (invariant held); `friendly_h264_bypasses_at_some_true_same_as_none` confirms no H.264 regression.

- [ ] **Step 7: Run the full crate tests**

Run: `cargo test`
Expected: PASS — no other test regresses (the only call site, `jobs/mod.rs:165`, threads `None` → behavior unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/mod.rs
git commit -m "feat(proxy): add decodable_here axis — widen bypass to the 8-bit decodable family"
```

---

## Task 2: Record the decision in an ADR

**Files:**
- Create: `docs/adr/0012-preview-from-probe-not-static-gate.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0012-preview-from-probe-not-static-gate.md`:

```markdown
---
status: accepted
---

# Preview-from-original is driven by the runtime probe, not the static pixfmt gate

`proxy_decision::decide` gains a third input, `decodable_here: Option<bool>` —
the runtime WebCodecs verdict for THIS machine (`probeSourceDecodable`). It
widens only the preview/bypass axis:

- `None` (import-time, probe not run) / `Some(false)` (probe says undecodable):
  bypass stays conservative — static H.264 + browser-friendly pixfmt.
- `Some(true)` (this machine decoded it): bypass widens to the whole 8-bit
  decodable family via `export_decodable_statically` (HEVC/AV1/VP9 8-bit).

The export axis is unchanged (`export_decodable_statically`, static).

## Why

The static `pix_fmt_is_browser_friendly` gate treated all 10-bit (and all
non-H.264 preview) as proxy-only. Empirically, this machine's WebCodecs decodes
far more than the static gate admits — including H.264 Hi10P (Chromium 148
software-decodes it). Driving the **preview** decision off the runtime probe
instead of the static gate lets a decodable + scrub-friendly 8-bit HEVC/AV1/VP9
source bypass entirely (no proxy), and underpins the frontend
preview-from-original bridge (Plan 2) for the heavier decodable sources.

## The 10-bit invariant

`ProxyRoute` keeps the invariant `preview == Original ⟹ export == Original`
(`{ FullProxy, Original }` is `unreachable!`). Bypass is therefore gated on
`export_decodable_statically`, which requires an 8-bit browser-friendly pixfmt.
So **10-bit (incl. Hi10P) never bypasses**: it stays `export = FullProxy`, keeps
its proxy, and its instant preview-from-original is the frontend bridge layered
over that kept proxy — which also means a 10-bit source always has a durable
proxy (no incapable-machine portability hole).

## Scope of this change

- Pure decision-model: `decide` arity + `source_is_safe_to_bypass` gate. The
  only call site (`jobs/mod.rs`) passes `None`, so this change is
  behavior-preserving until a later plan supplies the `Some(true)` verdict via
  the downgrade/cancel command.
- `job_for` and the persisted schema (`proxy_bypassed`, `export_uses_original`,
  `proxy_path`, `quick_proxy_path`) are untouched.
- Supersedes the "Hi10P/10-bit MUST proxy" framing for **preview** (it was
  always a static-gate artifact, not a decode limitation).
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0012-preview-from-probe-not-static-gate.md
git commit -m "docs(adr): 0012 preview-from-original driven by runtime probe, not static gate"
```

---

## Self-Review

**Spec coverage (§A):**
- `decide` gains `decodable_here` → Task 1 Step 3. ✅
- `source_is_safe_to_bypass` widened to the decodable family under `Some(true)` → Task 1 Step 4. ✅
- Invariant preserved / 10-bit never bypasses → gated on `export_decodable_statically`; `hi10p_does_not_bypass_even_when_decodable` test. ✅ (This is the refinement over the spec's looser §A wording — folded in here + the spec is updated to match.)
- Behavior-preserving at import → `jobs/mod.rs` passes `None`; all `None` oracle cases reproduce today's routing. ✅
- Export axis + `job_for` unchanged → no edits to `export_decodable_statically` / `job_for`. ✅
- Decision recorded → Task 2 ADR 0012. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; exact call-site line (`jobs/mod.rs:165`) given. ✅

**Type consistency:** `decide(media, source_gop_secs, decodable_here)` 3-arg signature used identically in Step 3 (def), Step 5 (call site), and every test call in Step 1. `source_is_safe_to_bypass(media, source_gop_secs, decodable_here)` consistent between Step 3 (caller) and Step 4 (def). `ProxyRoute`/`ProxyJob` variants unchanged. ✅

---

## Follow-on plans (sequenced; this is Plan 1 of 4)

This plan is the dependency root and ships behavior-preserving. The rest:

- **Plan 2 — preview-from-original bridge + verdict wiring + notification (frontend + 1 command).** New webview→Rust `mark_preview_original`/cancel-quick-proxy command (mirror of `ensure_full_proxy`) that re-runs `decide(.., Some(true))` and cancels the quick-proxy job; extend `previewPlaybackPathFor` to return the original until a proxy lands, gated by a session-scoped "preview-decodable" signal set from the import sweep's `probeSourceDecodable` verdict; three-state `importOptimize` classifier. Delivers the headline (instant preview for decodable sources; no-proxy for 8-bit scrub-friendly).
- **Plan 3 — overlap-swap (Compositor/`SourceDecoderPool`).** No-flash original→quick-proxy swap for the long-GOP-decodable subset (acquire 2nd handle under a temp key, repoint sprite on `onFirstFrame`, release old). Detail this plan against `Compositor.ensureClip` / `ActiveClip` in-situ.
- **Plan 4 — open-project re-probe + lazy proxy build.** On open, re-probe timeline sources; a previously-bypassed source this machine can't decode → `ensure_full_proxy` + readiness-gate wait.
