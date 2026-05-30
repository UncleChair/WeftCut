# Import Decision Two-Axis Refactor — Implementation Plan (Piece A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 4-variant `ProxyPlan` with two orthogonal axes (`{ export, preview }`) plus a pure `job_for` scheduler, and flip the None-GOP default to the safe (proxy-generating) direction — without changing any persisted schema, resolver, or `DecodeCaps` behavior.

**Architecture:** `decide` returns a `ProxyRoute { export: ExportSource, preview: PreviewSource }` from two independent predicates that already exist (`decodable_directly` → export axis; `source_is_safe_to_bypass` → preview axis). A pure `job_for(route, is_small)` maps the route to the existing background-job kinds, absorbing the former `FullProxyOnly`-vs-`QuickThenFull` split as a scheduling input. The only deliberate behavior change is `gop_is_scrub_friendly(None)` flipping from `true` to `false`.

**Tech Stack:** Rust (Tauri backend, `apps/desktop/src-tauri`), `cargo test`. No TypeScript changes.

**Spec:** `docs/superpowers/specs/2026-05-30-import-decision-two-axis-design.md`

---

## File Structure

- **Modify** `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` — replace `ProxyPlan` enum + `decide` with `ExportSource`/`PreviewSource`/`ProxyRoute`/`ProxyJob` + `decide` (returns `ProxyRoute`) + `job_for`; make `is_small_source` `pub`; rewrite the test module as a behavior-snapshot oracle (Task 1). Flip `gop_is_scrub_friendly` (Task 2).
- **Modify** `apps/desktop/src-tauri/src/jobs/mod.rs:157-253` — replace the 4-arm `ProxyPlan` match in `spawn_proxy_decision` with a `job_for(decide(...), is_small_source(...))` match over `ProxyJob` (Task 1). Arm bodies are preserved verbatim.
- **Modify** `apps/desktop/src-tauri/src/jobs/quick_proxy.rs` — add one `can_remux(..., None)` test pinning the None-flip's effect on the shared helper (Task 2). No production change here; `can_remux` already calls `gop_is_scrub_friendly`.
- **Create** `docs/adr/0009-two-axis-proxy-decision.md` — record the structural decomposition + the None-GOP flip + that preview-from-original stays H.264-only (Task 3).

All verification commands run from `apps/desktop/src-tauri/`.

---

## Task 1: Decompose `decide` into two axes + pure `job_for` (behavior-preserving)

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs:157-253`
- Test: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` (inline `#[cfg(test)] mod tests`)

This task is one atomic compile unit: changing `decide`'s return type breaks `jobs/mod.rs`, so both land together. Behavior is preserved exactly (the None case still maps to bypass here; Task 2 changes it).

- [ ] **Step 1: Replace the test module with the axis + scheduler oracle**

Replace the entire `#[cfg(test)] mod tests { ... }` block at the bottom of `proxy_decision.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode_caps::DecodeCaps;
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

    // --- decide(): the two-axis routing oracle (behavior snapshot) ---

    #[test]
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), Some(0.2)),
            BOTH_ORIGINAL
        );
    }

    #[test]
    fn long_gop_friendly_h264_previews_from_proxy() {
        // A ~6 s GOP scrubs terribly decoded directly: export still reads the
        // original (H.264 is decodable), preview gets a short-GOP scrub proxy.
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), Some(6.0)),
            EXPORT_ORIGINAL_PREVIEW_PROXY
        );
    }

    #[test]
    fn unknown_gop_preserves_bypass_in_task_1() {
        // Behavior-preserving: probe-failure (None) is still bypass-eligible
        // here. Task 2 flips this to EXPORT_ORIGINAL_PREVIEW_PROXY.
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), None),
            BOTH_ORIGINAL
        );
    }

    #[test]
    fn four_k_h264_exports_original_previews_proxy() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none(), Some(0.2)),
            EXPORT_ORIGINAL_PREVIEW_PROXY
        );
    }

    #[test]
    fn high_bitrate_h264_1080p_exports_original_previews_proxy() {
        let item = video(|m| {
            m.metadata.duration_us = Some(10_000_000);
            m.file_size = 50 * 1024 * 1024;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none(), Some(0.2)),
            EXPORT_ORIGINAL_PREVIEW_PROXY
        );
    }

    #[test]
    fn small_undecodable_source_proxies_both() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.file_size = 10_000_000;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none(), Some(0.2)),
            BOTH_PROXY
        );
    }

    #[test]
    fn large_hevc_without_caps_proxies_both() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(
            decide(&item, &DecodeCaps::none(), Some(0.2)),
            BOTH_PROXY
        );
    }

    #[test]
    fn large_hevc_with_caps_exports_original_previews_proxy() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        let caps = DecodeCaps {
            hevc: true,
            ..Default::default()
        };
        assert_eq!(decide(&item, &caps, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn small_hevc_with_caps_keeps_preview_proxy() {
        // Drift guard: a short, small, decodable HEVC must NOT widen to
        // preview-from-original. export=Original (decodable), preview=Proxy
        // (source_is_safe_to_bypass requires H.264). Without this case the
        // refactor could silently regress preview to HEVC originals.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(8_000_000); // small: <=10 s
            m.file_size = 20 * 1024 * 1024; // small: <=150 MB
        });
        let caps = DecodeCaps {
            hevc: true,
            ..Default::default()
        };
        assert_eq!(decide(&item, &caps, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn hevc_10bit_stays_proxy_even_with_caps() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        let caps = DecodeCaps {
            hevc: true,
            ..Default::default()
        };
        assert_eq!(decide(&item, &caps, Some(0.2)), BOTH_PROXY);
    }

    #[test]
    fn av1_export_axis_gated_by_caps() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, &DecodeCaps::none(), Some(0.2)), BOTH_PROXY);
        let caps = DecodeCaps {
            av1: true,
            ..Default::default()
        };
        assert_eq!(decide(&item, &caps, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn non_video_routes_to_both_original() {
        // Early return preserved: a non-video item never proxies, regardless
        // of GOP or caps.
        let item = video(|m| {
            m.kind = MediaKind::Audio;
        });
        assert_eq!(decide(&item, &DecodeCaps::none(), Some(6.0)), BOTH_ORIGINAL);
    }

    // --- job_for(): scheduling oracle (the is_small split) ---

    #[test]
    fn job_none_for_both_original() {
        assert_eq!(job_for(BOTH_ORIGINAL, false), ProxyJob::None);
        assert_eq!(job_for(BOTH_ORIGINAL, true), ProxyJob::None);
    }

    #[test]
    fn job_quick_only_for_direct_export() {
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY, false), ProxyJob::QuickOnly);
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY, true), ProxyJob::QuickOnly);
    }

    #[test]
    fn job_full_only_for_small_proxy_both() {
        assert_eq!(job_for(BOTH_PROXY, true), ProxyJob::FullOnly);
    }

    #[test]
    fn job_quick_then_full_for_large_proxy_both() {
        assert_eq!(job_for(BOTH_PROXY, false), ProxyJob::QuickThenFull);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error)**

Run: `cargo test proxy_decision`
Expected: FAIL — compile errors (`cannot find type ProxyRoute`, `ExportSource`, `PreviewSource`, `ProxyJob`, `job_for` not found; `decide` returns `ProxyPlan`).

- [ ] **Step 3: Replace the `ProxyPlan` enum + `decide` with the two-axis types, `decide`, and `job_for`**

In `proxy_decision.rs`, replace the `ProxyPlan` enum (currently lines ~23-35) and the `decide` function (currently lines ~41-55) with:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportSource {
    /// WebCodecs can decode the original on this machine; export reads it.
    Original,
    /// Original isn't directly decodable here; export reads the full proxy.
    FullProxy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreviewSource {
    /// The original scrubs acceptably; preview reads it directly.
    Original,
    /// Original is heavy / long-GOP / undecodable; preview reads a proxy (the
    /// quick scrub proxy, or the full proxy for small undecodable sources).
    Proxy,
}

/// Per-source routing: two independent axes.
///
/// Invariant: `preview == Original` implies `export == Original`. The only
/// path to preview-from-original is `source_is_safe_to_bypass`, which requires
/// H.264 + a browser-friendly pixfmt — a strict subset of the condition for
/// `decodable_directly`. Hence `{ FullProxy, Original }` is unreachable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProxyRoute {
    pub export: ExportSource,
    pub preview: PreviewSource,
}

/// Which background proxy job(s) a route implies, given whether the source is
/// small enough to skip the fast phase. Pure policy, unit-tested in isolation
/// so the `is_small` scheduling split keeps the coverage the flat `ProxyPlan`
/// used to carry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyJob {
    /// No proxy: bypass. Preview + export both read the original.
    None,
    /// Standalone quick scrub proxy; export reads the original (DirectExport).
    QuickOnly,
    /// Full proxy directly, no quick phase (small undecodable source).
    FullOnly,
    /// Quick proxy first, then the full proxy in the background.
    QuickThenFull,
}

/// Route an imported source onto the two axes. `source_gop_secs` is the
/// source's largest keyframe interval (`probe::probe_max_keyframe_gap_secs`),
/// or `None` if unknown.
pub fn decide(media: &MediaItem, caps: &DecodeCaps, source_gop_secs: Option<f64>) -> ProxyRoute {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyRoute {
            export: ExportSource::Original,
            preview: PreviewSource::Original,
        };
    }
    let export = if decodable_directly(media, caps) {
        ExportSource::Original
    } else {
        ExportSource::FullProxy
    };
    let preview = if source_is_safe_to_bypass(media, source_gop_secs) {
        PreviewSource::Original
    } else {
        PreviewSource::Proxy
    };
    ProxyRoute { export, preview }
}

/// Map a route + small-source flag to the background job to run.
pub fn job_for(route: ProxyRoute, is_small: bool) -> ProxyJob {
    match (route.export, route.preview) {
        (ExportSource::Original, PreviewSource::Original) => ProxyJob::None,
        (ExportSource::Original, PreviewSource::Proxy) => ProxyJob::QuickOnly,
        (ExportSource::FullProxy, PreviewSource::Proxy) => {
            if is_small {
                ProxyJob::FullOnly
            } else {
                ProxyJob::QuickThenFull
            }
        }
        (ExportSource::FullProxy, PreviewSource::Original) => {
            unreachable!("preview=Original implies export=Original (safe_to_bypass is a subset of decodable_directly)")
        }
    }
}
```

- [ ] **Step 4: Make `is_small_source` public**

In `proxy_decision.rs`, change the signature of `is_small_source` (currently line ~117) from `fn is_small_source` to:

```rust
pub fn is_small_source(media: &MediaItem) -> bool {
```

(Body unchanged.)

- [ ] **Step 5: Rewrite the `spawn_proxy_decision` match in `jobs/mod.rs`**

In `apps/desktop/src-tauri/src/jobs/mod.rs`, replace the `match proxy_decision::decide(&media, &caps, source_gop_secs) { ... }` block (lines 157-253) with the following. The `ProxyJob::None` and `ProxyJob::QuickOnly` bodies are the current `DirectBoth` and `DirectExportQuickPreview` arm bodies, moved verbatim:

```rust
        let route = proxy_decision::decide(&media, &caps, source_gop_secs);
        let is_small = proxy_decision::is_small_source(&media);
        match proxy_decision::job_for(route, is_small) {
            proxy_decision::ProxyJob::None => {
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
                    quick_proxy_path: Some(None),
                    proxy_bypassed: Some(true),
                    ..Default::default()
                };
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
                    warn!("proxy bypass commit failed for {media_id}: {e}");
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
                info!("proxy bypass accepted for {media_id}");
                emit(
                    &app,
                    EVENT_COMPLETE,
                    &JobComplete {
                        media_id: media_id.to_string(),
                        kind: JobKind::ProxyBypass,
                        path: Some(media.path_abs.display().to_string()),
                    },
                );
                spawn_decorations(app, cache, project, media);
            }
            proxy_decision::ProxyJob::QuickOnly => {
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
                spawn_quick_proxy(app, cache, project, media, false, source_gop_secs);
            }
            proxy_decision::ProxyJob::FullOnly => {
                spawn_proxy(app, cache, project, media);
            }
            proxy_decision::ProxyJob::QuickThenFull => {
                spawn_quick_proxy(app, cache, project, media, true, source_gop_secs);
            }
        }
```

- [ ] **Step 6: Run the full crate tests to verify green + behavior preserved**

Run: `cargo test`
Expected: PASS — all `proxy_decision` oracle tests pass; the crate compiles (no remaining `ProxyPlan` references); no other test regresses.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/mod.rs
git commit -m "refactor(proxy): decompose ProxyPlan into export/preview axes + pure job_for"
```

---

## Task 2: Flip the None-GOP default to the safe direction

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` (`gop_is_scrub_friendly` + its None test)
- Test: `apps/desktop/src-tauri/src/jobs/quick_proxy.rs` (new `can_remux(..., None)` test)

The one deliberate behavior change: an unknown GOP becomes "not scrub-friendly," so a probe-hiccup on a friendly H.264 routes to `{ Original, Proxy }` (a wasted quick proxy) instead of `{ Original, Original }` (no proxy, permanent freeze if the source is actually long-GOP). The shared `can_remux` flips in the same safe direction.

- [ ] **Step 1: Update the failing tests**

In `proxy_decision.rs`, replace the `unknown_gop_preserves_bypass_in_task_1` test with:

```rust
    #[test]
    fn unknown_gop_previews_from_proxy() {
        // Probe-failure (None): treat as NOT scrub-friendly. A mis-bypassed
        // long-GOP original freezes on backward scrub with no recovery, so the
        // graceful direction is to generate a scrub proxy. Export still reads
        // the original (H.264 is decodable).
        assert_eq!(
            decide(&video(|_| {}), &DecodeCaps::none(), None),
            EXPORT_ORIGINAL_PREVIEW_PROXY
        );
    }
```

In `quick_proxy.rs`, add this test inside the existing `#[cfg(test)] mod tests` block (next to the other `can_remux` tests):

```rust
    #[test]
    fn unknown_gop_does_not_remux() {
        // Probe-failure: don't remux (would carry an unknown, possibly long
        // GOP through); transcode to a short GOP instead. Mirrors the
        // None-GOP flip in proxy_decision.
        assert!(!can_remux(
            &video("h264", "yuv420p", 1920, 1080, 30, 1),
            None
        ));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test proxy_decision quick_proxy`
Expected: FAIL — `unknown_gop_previews_from_proxy` asserts `EXPORT_ORIGINAL_PREVIEW_PROXY` but gets `BOTH_ORIGINAL`; `unknown_gop_does_not_remux` asserts `!can_remux` but `can_remux` returns `true` (both because `gop_is_scrub_friendly(None)` is still `true`).

- [ ] **Step 3: Flip `gop_is_scrub_friendly` and update its doc comment**

In `proxy_decision.rs`, replace the `gop_is_scrub_friendly` doc comment + body (currently lines ~108-115) with:

```rust
/// True when a source's GOP is KNOWN to be short enough to scrub directly.
/// `None` (probe failed) is treated as NOT friendly: an unknown GOP may be
/// long, and a mis-bypassed long-GOP original freezes on backward scrub with
/// no recovery (preview reads the original; no proxy is ever generated). The
/// graceful failure is to generate a scrub proxy on a probe hiccup. Shared
/// with `quick_proxy::can_remux`, where the same flip means an unknown-GOP
/// source is transcoded to a short GOP rather than remuxed (remux would carry
/// the unknown GOP through).
pub fn gop_is_scrub_friendly(source_gop_secs: Option<f64>) -> bool {
    source_gop_secs.map_or(false, |g| g <= MAX_BYPASS_GOP_SECONDS)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test proxy_decision quick_proxy`
Expected: PASS — `unknown_gop_previews_from_proxy` and `unknown_gop_does_not_remux` now pass; the explicit-GOP `can_remux` tests (`Some(0.2)`, `Some(6.0)`) are unaffected.

- [ ] **Step 5: Run the full crate tests**

Run: `cargo test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/quick_proxy.rs
git commit -m "fix(proxy): unknown GOP routes to a scrub proxy, not a silent bypass"
```

---

## Task 3: Record the decision in an ADR

**Files:**
- Create: `docs/adr/0009-two-axis-proxy-decision.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0009-two-axis-proxy-decision.md`:

```markdown
---
status: accepted
---

# Two-axis proxy decision (export source × preview source)

`jobs::proxy_decision::decide` returns a `ProxyRoute { export, preview }`
instead of a flat plan enum. The two axes are independent:

- **Export source** (`ExportSource::Original | FullProxy`) — driven by
  `decodable_directly`: can WebCodecs decode this codec/profile/bit-depth on
  this machine (H.264 always; HEVC/AV1/VP9 gated by the `DecodeCaps` probe;
  8-bit browser-friendly pixfmt required)?
- **Preview source** (`PreviewSource::Original | Proxy`) — driven by
  `source_is_safe_to_bypass`: is the original pleasant to scrub directly
  (H.264, <=1080p, <=25 Mbps, browser-friendly pixfmt, short GOP)?

Invariant: `preview == Original` implies `export == Original`, because
`source_is_safe_to_bypass` is a strict subset of `decodable_directly`. So
`{ FullProxy, Original }` is unreachable. A pure `job_for(route, is_small)`
maps the route to the background job, absorbing the small-source
"skip the quick phase" choice that the prior flat enum encoded as a peer
variant.

## Why

The prior `ProxyPlan` (`DirectBoth` / `DirectExportQuickPreview` /
`FullProxyOnly` / `QuickThenFull`) was the cross-product of these two axes
flattened into one enum, which interleaved the export and preview decisions
inside one function and let the GOP signal — which only concerns scrub
comfort — decide "no proxy at all." That produced a footgun: a long-GOP
source whose GOP probe failed was bypassed with no proxy and froze on
backward scrub. The decomposition isolates each axis and is the primary fix
for that freeze regression: heavy / long-GOP footage is now guaranteed a
short-GOP scrub proxy on the preview axis.

## Unknown-GOP direction

`gop_is_scrub_friendly(None)` is `false`: an unknown GOP is treated as not
scrub-friendly, so a probe hiccup generates a scrub proxy (a small waste)
rather than a silent permanent freeze. The same helper governs
`quick_proxy::can_remux`, so an unknown-GOP source is transcoded to a short
GOP rather than remuxed.

## Preserved behavior / non-goals

- Preview-from-original stays **H.264-only**. A decodable HEVC (even short
  and small, with `caps.hevc`) routes to `{ Original, Proxy }`
  (export from original, preview from proxy), not to bypass. Widening
  preview-from-original beyond H.264 is a separate future decision.
- No persisted-schema change: `proxy_bypassed`, `export_uses_original`,
  `proxy_path`, `quick_proxy_path` and the TS resolvers are untouched. The
  `DecodeCaps` oracle is unchanged. (Both are revisited in the later
  oracle-removal work.)
- Existing `proxy_bypassed` imports are not re-routed on open
  (`enqueue_for_media` short-circuits them); pre-release, a stale frozen
  import is resolved by re-import or cache wipe.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0009-two-axis-proxy-decision.md
git commit -m "docs(adr): 0009 two-axis proxy decision"
```

---

## Self-Review

**Spec coverage:**
- Two axes + `ProxyRoute` + faithful predicates → Task 1 Step 3. ✅
- `FullProxyOnly` demoted to a scheduling input → `job_for` (`is_small`) Task 1 Step 3 + tests Step 1. ✅
- `{ FullProxy, Original }` unreachable → `job_for` `unreachable!` + invariant doc. ✅
- Non-video early return preserved → `decide` guard + `non_video_routes_to_both_original` test. ✅
- Characterization oracle (every prior case mapped + new short-small-HEVC-with-caps + None case) → Task 1 Step 1. ✅
- None-GOP flip as the one deliberate change → Task 2. ✅
- Shared `can_remux` flips with it → Task 2 `unknown_gop_does_not_remux`. ✅
- No persisted-schema / resolver / `DecodeCaps` change → no such files in any task. ✅
- ADR records the decision → Task 3. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; verbatim arm bodies reproduced in Task 1 Step 5. ✅

**Type consistency:** `ExportSource`/`PreviewSource`/`ProxyRoute`/`ProxyJob`/`decide`/`job_for`/`is_small_source` names used identically across Task 1 (definition), Task 1 Step 5 (consumer), and the tests. `ProxyJob` variants (`None`/`QuickOnly`/`FullOnly`/`QuickThenFull`) match between `job_for`, the consumer match, and the `job_for` tests. ✅
