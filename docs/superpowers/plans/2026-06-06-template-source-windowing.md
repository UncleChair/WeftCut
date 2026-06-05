# Template Source-Windowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a template layer a *window* into its intrinsic content (driven by the `seconds`/`max_duration_prop` value), exactly like a video clip windows into source media — so editing `seconds` re-renders content without resizing the layer, and dragging the layer only moves the window.

**Architecture:** Add one persisted field `TemplateParams.src_in_us` (the window's offset into the content). Content duration = `resolve_template_max_dur_us(manifest, props)` (the `seconds` cap), no new field. The renderer maps composition time → content time via `src_in_us + (t - t_start)` and passes the content duration (not layer width) as `durationSec`. Trim mirrors the existing VideoClip `src_in`/`src_out` windowing; `src_out` is always derived from layer width (never stored). Capped templates window; uncapped templates keep legacy behavior.

**Tech Stack:** Rust (Tauri actor, `imbl`, serde), TypeScript (PixiJS compositor, vitest), real-WebView2 verification via the `_hypothesi/tauri-mcp-server` bridge.

**Branch:** `feat/template-source-windowing` (already created; spec committed there).

**Spec:** `docs/superpowers/specs/2026-06-06-template-source-windowing-design.md`

**Test commands:**
- Rust: from `apps/desktop/src-tauri` → `cargo test -p weftcut <name>`
- TS: from `apps/desktop` → `npm test -- <path>` (vitest)
- Typecheck: from `apps/desktop` → `npm run typecheck`

---

## Task 1: Add `src_in_us` to the template data model

Add the field with a serde default (legacy projects deserialize to `0` = window at content start), thread it through the view + patch, and initialize all construction sites to `0`. No behavior change yet — `src_in_us` is unused by the renderer until Task 3.

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/layer.rs:174-182` (`TemplateParams`)
- Modify: `apps/desktop/src-tauri/src/state/actor.rs:165-186` (`TemplatePatch`)
- Modify: `apps/desktop/src-tauri/src/state/actor.rs:3957-4000+` (`apply_params_patch` Template arm)
- Modify: `apps/desktop/src-tauri/src/commands.rs:128-145` (`TemplateView`), `:616-624` (view mapping), `:2002-2008` (`add_template` construction)
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs:1223` (MCP `add_template` construction)
- Modify: `apps/desktop/src-tauri/src/state/actor.rs:4187-4195` (test helper `template_layer`)
- Modify: `apps/desktop/src/ipc/index.ts:107-119` (`TemplateView`), `:?` (`TemplatePatch` ~ near line 360)
- Test: `apps/desktop/src-tauri/src/state/actor.rs` (tests module, near existing template tests ~line 4197)

- [ ] **Step 1: Add the field to `TemplateParams`**

In `apps/desktop/src-tauri/src/state/layer.rs`, change the struct (lines 174-182) to:

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemplateParams {
    pub template_id: String,
    pub template_version: u32,
    /// Validated against the template manifest's `props_schema` at apply time.
    pub props: imbl::HashMap<String, Value>,
    /// Window offset (µs) into the template's intrinsic content. The window
    /// width equals the layer width (`t_end_us - t_start_us`); `src_out` is
    /// derived, never stored. Content duration is the resolved cap
    /// (`resolve_template_max_dur_us`). `0` = window starts at content frame 0.
    /// Legacy projects (no field) deserialize to `0`.
    #[serde(default)]
    pub src_in_us: TimeUs,
    pub transform: Transform,
    pub opacity: Animated<f64>,
}
```

- [ ] **Step 2: Initialize the three construction sites + the test helper to `src_in_us: 0`**

In `apps/desktop/src-tauri/src/commands.rs` (the `add_template` params build, ~lines 2002-2008), add `src_in_us: 0,`:

```rust
    let params = LayerParams::Template(TemplateParams {
        template_id: template.id().to_string(),
        template_version: template.manifest.version,
        props: props_map,
        src_in_us: 0,
        transform: Transform::default(),
        opacity: Animated::Static(1.0),
    });
```

In `apps/desktop/src-tauri/src/mcp/mod.rs` (~line 1223), add `src_in_us: 0,` to the `TemplateParams { ... }` literal (match the field order above).

In `apps/desktop/src-tauri/src/state/actor.rs` test helper (~lines 4188-4194), add `src_in_us: 0,`:

```rust
    fn template_layer(props: imbl::HashMap<String, serde_json::Value>) -> LayerParams {
        LayerParams::Template(crate::state::TemplateParams {
            template_id: "countdown".into(),
            template_version: 1,
            props,
            src_in_us: 0,
            transform: crate::state::Transform::default(),
            opacity: Animated::Static(1.0),
        })
    }
```

- [ ] **Step 3: Add `src_in_us` to `TemplatePatch` + apply it**

In `apps/desktop/src-tauri/src/state/actor.rs`, add to `TemplatePatch` (after `opacity`, before `props`, ~line 176):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src_in_us: Option<crate::state::time::TimeUs>,
```

(Use the same `TimeUs` path the file already imports — check the top of `actor.rs`; if `TimeUs` is in scope unqualified, use `Option<TimeUs>`.)

In `apply_params_patch`'s Template arm (the `(LayerParams::Template(p), LayerParamsPatch::Template(tp))` branch, ~line 4050-ish — find it after the VideoClip arm), add inside, before the `props` merge:

```rust
            if let Some(v) = tp.src_in_us {
                p.src_in_us = v;
            }
```

- [ ] **Step 4: Mirror in the TS view + patch types**

In `apps/desktop/src/ipc/index.ts`, add to `TemplateView` (lines 107-119), after `opacity`:

```ts
  /// Window offset (µs) into the template's intrinsic content. Width = layer
  /// width; src_out is derived. 0 = content frame 0.
  src_in_us: number;
```

And to `TemplatePatch` (~line 355-365), after `opacity?`:

```ts
  src_in_us?: number;
```

- [ ] **Step 5: Emit `src_in_us` in the Rust view mapping**

In `apps/desktop/src-tauri/src/commands.rs`, the `TemplateView` struct (lines 128-145) — add after `opacity`:

```rust
    pub src_in_us: i64,
```

And in `layer_params_view`'s Template arm (~lines 616-624), add `src_in_us: p.src_in_us,`:

```rust
            LayerParamsView::Template(TemplateView {
                template_id: p.template_id.clone(),
                x: static_or(&p.transform.x, 0.0),
                y: static_or(&p.transform.y, 0.0),
                scale_x: static_or(&p.transform.scale_x, 1.0),
                scale_y: static_or(&p.transform.scale_y, 1.0),
                opacity: static_or(&p.opacity, 1.0),
                src_in_us: p.src_in_us,
                props,
            })
```

- [ ] **Step 6: Write a failing test for legacy deserialize + patch apply**

In `apps/desktop/src-tauri/src/state/actor.rs` tests module (near the existing `template_params_patch_*` test ~line 4197), add:

```rust
    #[test]
    fn template_params_legacy_json_defaults_src_in_us_to_zero() {
        // A project JSON authored before src_in_us existed must deserialize
        // with src_in_us = 0 (window at content start).
        let json = r#"{
            "template_id": "countdown",
            "template_version": 1,
            "props": {},
            "transform": {"x":{"Static":0.0},"y":{"Static":0.0},"scale_x":{"Static":1.0},"scale_y":{"Static":1.0},"rotation_deg":{"Static":0.0}},
            "opacity": {"Static": 1.0}
        }"#;
        let p: crate::state::TemplateParams =
            serde_json::from_str(json).expect("legacy template params deserialize");
        assert_eq!(p.src_in_us, 0);
    }
```

NOTE: the `transform` JSON above must match the actual `Transform` serde shape. If this test fails to deserialize on `transform`, fix the JSON to match `Transform`'s fields (open `state/layer.rs` `Transform`); the assertion under test is only `src_in_us == 0`.

- [ ] **Step 7: Run the test — expect PASS (serde default)**

Run: `cargo test -p weftcut template_params_legacy_json_defaults_src_in_us_to_zero`
Expected: PASS. If it fails on `transform` shape, fix the JSON per the note and re-run.

- [ ] **Step 8: Typecheck TS + build Rust**

Run (from `apps/desktop`): `npm run typecheck`
Expected: no new errors.
Run (from `apps/desktop/src-tauri`): `cargo check`
Expected: compiles (warnings ok).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src-tauri/src/state/layer.rs apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/mcp/mod.rs apps/desktop/src/ipc/index.ts
git commit -m "feat(templates): add TemplateParams.src_in_us window offset (unused yet)"
```

---

## Task 2: TS resolver for template content duration

Add a pure helper that mirrors Rust `resolve_template_max_dur_us`: prefer the `max_duration_prop` value (seconds → µs) when finite & positive, else `max_duration_s`, else `null` (unbounded).

**Files:**
- Modify: `apps/desktop/src/render/templates/catalog.ts` (append the helper)
- Test: `apps/desktop/src/render/templates/catalog.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/render/templates/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  resolveTemplateContentDurationUs,
  type TemplateManifest,
} from "./catalog";

const base: TemplateManifest = {
  id: "countdown",
  name: "Countdown",
  version: 1,
  size: [480, 480],
  default_duration_s: 5,
  max_duration_s: 5,
  max_duration_prop: "seconds",
  props_schema: { seconds: { type: "number", default: 5, min: 1, max: 60 } },
};

describe("resolveTemplateContentDurationUs", () => {
  it("uses the live prop value when present", () => {
    expect(resolveTemplateContentDurationUs(base, { seconds: 6 })).toBe(6_000_000);
  });
  it("falls back to max_duration_s when the prop is missing/invalid", () => {
    expect(resolveTemplateContentDurationUs(base, {})).toBe(5_000_000);
    expect(resolveTemplateContentDurationUs(base, { seconds: -3 })).toBe(5_000_000);
    expect(resolveTemplateContentDurationUs(base, { seconds: "x" })).toBe(5_000_000);
  });
  it("returns null when fully unbounded", () => {
    const unbounded = { ...base, max_duration_s: undefined, max_duration_prop: undefined };
    expect(resolveTemplateContentDurationUs(unbounded, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (export missing)**

Run (from `apps/desktop`): `npm test -- src/render/templates/catalog.test.ts`
Expected: FAIL — `resolveTemplateContentDurationUs` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `apps/desktop/src/render/templates/catalog.ts`:

```ts
/// Resolve a template's intrinsic content duration (µs) from its manifest +
/// the instance props. Mirrors Rust `resolve_template_max_dur_us`: prefer the
/// `max_duration_prop` value (seconds, when finite & > 0), else `max_duration_s`,
/// else `null` (unbounded — no windowing, legacy "animate over layer width").
export function resolveTemplateContentDurationUs(
  manifest: TemplateManifest,
  props: Record<string, unknown>,
): number | null {
  const propName = manifest.max_duration_prop;
  if (propName) {
    const raw = props[propName];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n * 1_000_000);
    }
  }
  if (typeof manifest.max_duration_s === "number" && manifest.max_duration_s > 0) {
    return Math.round(manifest.max_duration_s * 1_000_000);
  }
  return null;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run (from `apps/desktop`): `npm test -- src/render/templates/catalog.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/catalog.ts apps/desktop/src/render/templates/catalog.test.ts
git commit -m "feat(templates): TS resolver for intrinsic content duration"
```

---

## Task 3: Renderer preview path — content time/duration instead of layer width

Make `TemplateSprite.update`'s preview (non-injected) path render the **content** window: `tSec = (src_in_us + tInLayerUs)/1e6`, `durationSec = contentDuration`, frame = absolute content frame, cache key keyed on content-duration-frames. Uncapped templates keep legacy behavior. The injected (export) branch is untouched here (Task 4 handles bake content).

**Files:**
- Modify: `apps/desktop/src/render/sprite/TemplateSprite.ts` (imports + the preview path, lines ~197-245; cache-key input field)
- Test: `apps/desktop/src/render/sprite/TemplateSprite.test.ts` (create — pure frame-selection math)

- [ ] **Step 1: Import the resolver**

In `apps/desktop/src/render/sprite/TemplateSprite.ts`, add to the catalog import (line 23):

```ts
import { getTemplate, resolveTemplateContentDurationUs, type Template } from "../templates/catalog";
```

- [ ] **Step 2: Add a pure exported helper for the content frame + duration, with a failing test**

Add this exported helper to `TemplateSprite.ts` (near `frameTimeSec`, ~line 52):

```ts
/// Compute the content-frame selection for the preview path. `contentDurationUs`
/// is the resolved intrinsic content duration (or the layer width for uncapped
/// templates); `srcInUs` is the window offset (0 for uncapped). Returns the
/// absolute content frame to render and the total content-duration frame count
/// (for the cache key). Exported for unit testing.
export function templateContentFrame(
  tInLayerUs: number,
  srcInUs: number,
  contentDurationUs: number,
  fpsNum: number,
  fpsDen: number,
): { frame: number; contentDurationFrames: number } {
  const contentDurationFrames = templateDurationFrames(contentDurationUs, fpsNum, fpsDen);
  const contentTimeUs = srcInUs + Math.max(0, tInLayerUs);
  const frame = Math.min(
    contentDurationFrames - 1,
    frameIndexInLayer(contentTimeUs, fpsNum, fpsDen),
  );
  return { frame, contentDurationFrames };
}
```

Create `apps/desktop/src/render/sprite/TemplateSprite.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { templateContentFrame } from "./TemplateSprite";

describe("templateContentFrame", () => {
  // 6s content @30fps = 180 frames (0..179).
  it("window [0,5s] into 6s content shows content frames 0..149 (6 down to 2)", () => {
    const at0 = templateContentFrame(0, 0, 6_000_000, 30, 1);
    expect(at0.contentDurationFrames).toBe(180);
    expect(at0.frame).toBe(0); // content t=0 → "6"
    const atEnd = templateContentFrame(5_000_000 - 1, 0, 6_000_000, 30, 1);
    expect(atEnd.frame).toBe(149); // ~content t=5s → "2"
  });
  it("src_in scrubs into content: window [1s,..] starts at content frame 30 (=5)", () => {
    const at0 = templateContentFrame(0, 1_000_000, 6_000_000, 30, 1);
    expect(at0.frame).toBe(30);
  });
  it("clamps to the last content frame", () => {
    const past = templateContentFrame(10_000_000, 0, 6_000_000, 30, 1);
    expect(past.frame).toBe(179);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL (export missing)**

Run (from `apps/desktop`): `npm test -- src/render/sprite/TemplateSprite.test.ts`
Expected: FAIL — `templateContentFrame` not exported.

- [ ] **Step 4: Implement — wire the preview path through the helper**

In `TemplateSprite.ts`, replace the preview-path block (currently lines ~209-245, from `const durationFrames = templateDurationFrames(durationUs, ...)` through the `void this.captureAndBind(...)` call) with:

```ts
    // Content-window model: a capped template (e.g. countdown) renders its
    // INTRINSIC content (driven by the cap/`seconds` prop), and the layer is a
    // window into it. Uncapped templates fall back to "animate over layer
    // width" (contentDuration = layer width, srcIn = 0) — legacy behavior.
    const cap = resolveTemplateContentDurationUs(this.template.manifest, view.props);
    const contentDurationUs = cap ?? durationUs;
    const srcInUs = cap == null ? 0 : view.src_in_us;
    const { frame, contentDurationFrames } = templateContentFrame(
      tInLayerUs,
      srcInUs,
      contentDurationUs,
      this.fpsNum,
      this.fpsDen,
    );

    // v1: raster at the template's natural size. The frame is the ABSOLUTE
    // content frame, and the key carries contentDurationFrames — so two windows
    // into the same template+props reuse overlapping cached frames and never
    // collide on (key, frame).
    const [renderW, renderH] = this.template.manifest.size;
    const cacheKey = templateFrameCacheKey({
      templateId: this.template.manifest.id,
      version: this.template.manifest.version,
      canonicalProps: canonical,
      renderW,
      renderH,
      fpsNum: this.fpsNum,
      fpsDen: this.fpsDen,
      durationFrames: contentDurationFrames,
    });

    // Same (key, frame) already bound/in-flight → nothing to do.
    if (cacheKey === this.targetCacheKey && frame === this.targetFrame) return;
    this.targetCacheKey = cacheKey;
    this.targetFrame = frame;

    const cached = sharedTemplateFrameCache.getFrame(cacheKey, frame);
    if (cached) {
      this.bindBitmap(cached);
      return;
    }

    const tSec = frameTimeSec(frame, this.fpsNum, this.fpsDen);
    const durationSec = contentDurationUs / US_PER_SEC;
    void this.captureAndBind(cacheKey, frame, tSec, durationSec, canonical);
```

Leave the injected-frames branch (lines ~171-195) and the `TemplateFrameCacheKeyInput` interface UNCHANGED (the `durationFrames` field name stays; it now receives the content value).

- [ ] **Step 5: Run the unit test — expect PASS**

Run (from `apps/desktop`): `npm test -- src/render/sprite/TemplateSprite.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run (from `apps/desktop`): `npm run typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/sprite/TemplateSprite.ts apps/desktop/src/render/sprite/TemplateSprite.test.ts
git commit -m "feat(templates): preview renders content window (src_in + content duration)"
```

---

## Task 4: Export bake renders content frames

The export bake fills a per-layer `ImageBitmap[]` indexed by **layer-local** comp-frame; the Worker's injected path binds by that same layer-local index. Keep the indexing, but render each slot at its **content** time (`src_in` offset + content duration) so export matches preview.

**Files:**
- Modify: `apps/desktop/src/render/exportBake.ts` (imports + `exportBakeTemplates` per-frame `tSec`/`durationSec`)

- [ ] **Step 1: Import the resolver + frame index helper**

In `apps/desktop/src/render/exportBake.ts`, update imports:

```ts
import { frameIndexInLayer, snapFrameFloor } from "../frames";
import { getTemplate, resolveTemplateContentDurationUs, type Template } from "./templates/catalog";
```

- [ ] **Step 2: Render each baked frame at content time**

In `exportBakeTemplates`, inside the `for (const spec of specs)` loop, replace the `const durationSec = spec.durationUs / US_PER_SEC;` line and the inner raster loop's `tSec` with content-aware values. Specifically, after `const canonical = ...`:

```ts
      // Content-window model: bake the INTRINSIC content. Uncapped templates
      // fall back to layer-width content with src_in=0 (legacy).
      const cap = resolveTemplateContentDurationUs(spec.template.manifest, spec.view.props);
      const contentDurationUs = cap ?? spec.durationUs;
      const srcInUs = cap == null ? 0 : spec.view.src_in_us;
      const durationSec = contentDurationUs / US_PER_SEC;
      // Layer-local frame `f` maps to content frame (srcInFrame + f); srcInUs is
      // frame-snapped (storage invariant) so srcInFrame is exact.
      const srcInFrame = frameIndexInLayer(srcInUs, fpsNum, fpsDen);
```

Then in the raster loop, change the `tSec` line from `frameTimeSec(frame, ...)` to:

```ts
        const tSec = frameTimeSec(srcInFrame + frame, fpsNum, fpsDen);
```

(The array index stays `frames[frame]` — layer-local — so `TemplateSprite`'s injected branch binds it unchanged.)

- [ ] **Step 3: Typecheck**

Run (from `apps/desktop`): `npm run typecheck`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render/exportBake.ts
git commit -m "feat(templates): export bake renders content window frames"
```

---

## Task 5: Trim mirrors VideoClip windowing for capped templates

Replace the template length-cap trim logic with true windowing: IN edge moves `t_start` AND `src_in` (scrub into content, floored at content 0); OUT edge moves `t_end` (derived `src_out` capped at content end). Uncapped templates stay freely trimmable.

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` — `apply_trim_layer` apply loop (~lines 3772-3801), `trim_delta_bounds` (~lines 3855-3945)
- Test: `apps/desktop/src-tauri/src/state/actor.rs` tests module

- [ ] **Step 1: Write failing tests for the window bounds**

Add to the tests module in `actor.rs` (near the trim tests; if helpers like `project_with_video_track` / `template_layer` are used elsewhere in the module, reuse them). These assume countdown's cap is the `seconds` prop:

```rust
    #[tokio::test]
    async fn template_out_trim_cannot_extend_past_content() {
        // countdown seconds=5 → content cap 5s. A 5s layer cannot OUT-extend.
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(5));
        let (mut project, track_id) = project_with_video_track();
        let id = apply_add_layer(
            &mut project, track_id, template_layer(props), 0, 5_000_000,
        ).unwrap();
        // Try to drag OUT to 8s — must be rejected (clamped to no-op).
        let err = apply_trim_layer(&mut project, id, LayerEdge::Out, 8_000_000, false);
        assert!(err.is_err(), "OUT past content cap must be rejected");
    }

    #[tokio::test]
    async fn template_in_trim_scrubs_src_in() {
        // countdown seconds=6 → content cap 6s. Place a full 6s window, then
        // drag IN +1s: t_start→1s, src_in→1s (scrub into content).
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(6));
        let (mut project, track_id) = project_with_video_track();
        let id = apply_add_layer(
            &mut project, track_id, template_layer(props), 0, 6_000_000,
        ).unwrap();
        apply_trim_layer(&mut project, id, LayerEdge::In, 1_000_000, false).unwrap();
        let (ti, li) = locate_layer(&project, id).unwrap();
        let l = &project.tracks[ti].layers[li];
        assert_eq!(l.t_start_us, 1_000_000);
        if let LayerParams::Template(p) = &l.params {
            assert_eq!(p.src_in_us, 1_000_000, "IN trim must advance src_in");
        } else {
            panic!("not a template");
        }
    }

    #[tokio::test]
    async fn template_in_trim_cannot_scrub_before_content_zero() {
        // A window at src_in=0 cannot IN-extend earlier (no content before 0).
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(6));
        let (mut project, track_id) = project_with_video_track();
        // Place the layer at t_start=2s so there's timeline room to the left.
        let id = apply_add_layer(
            &mut project, track_id, template_layer(props), 2_000_000, 5_000_000,
        ).unwrap();
        // src_in is 0; dragging IN earlier to 1s must be rejected.
        let err = apply_trim_layer(&mut project, id, LayerEdge::In, 1_000_000, false);
        assert!(err.is_err(), "IN earlier than content 0 must be rejected");
    }
```

NOTE: match `project_with_video_track`'s real signature/return — open the tests module and adapt the binding (it may return `(Project, TrackId)` or similar). `apply_add_layer` / `apply_trim_layer` / `locate_layer` / `LayerEdge` / `LayerParams` are all in this module's scope.

- [ ] **Step 2: Run them — expect FAIL**

Run: `cargo test -p weftcut template_out_trim_cannot_extend_past_content template_in_trim_scrubs_src_in template_in_trim_cannot_scrub_before_content_zero`
Expected: FAIL — IN trim doesn't update `src_in` yet, and bounds don't account for the window.

- [ ] **Step 3: Update the apply loop to move `src_in` on IN trims**

In `apply_trim_layer`, the IN-edge `match &mut m.params` (~lines 3778-3786), add a Template arm:

```rust
                match &mut m.params {
                    LayerParams::VideoClip(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    LayerParams::Audio(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    LayerParams::Template(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    _ => {}
                }
```

The OUT-edge match needs NO template arm (`src_out` is derived from layer width).

- [ ] **Step 4: Generalize `trim_delta_bounds` for the template window**

In `trim_delta_bounds`, extract the template's `src_in` once after `template_cap` is computed (~line 3868):

```rust
    // The window start for a capped template (0 for non-template / uncapped).
    let template_src_in = match (&layer.params, template_cap) {
        (LayerParams::Template(p), Some(_)) => p.src_in_us,
        _ => 0,
    };
```

In the **IN** arm, add a Template source-floor so the window can't scrub before content 0. Change the `(src_min, src_max)` match to include:

```rust
            let (src_min, src_max) = match &layer.params {
                LayerParams::VideoClip(p) => (-p.src_in_us, p.src_out_us - p.src_in_us - 1),
                LayerParams::Audio(p) => (-p.src_in_us, p.src_out_us - p.src_in_us - 1),
                LayerParams::Template(_) if template_cap.is_some() => (-template_src_in, inf),
                _ => (-inf, inf),
            };
```

(The existing `cap_min` block stays; it's a looser-or-equal bound and harmless — `src_min` binds when `src_in` is the tighter limit.)

In the **OUT** arm, change the cap edge to subtract `src_in` so the derived `src_out` can't pass content end. In the `cap_max` block, change the `capped_end` line from `layer.t_start_us.saturating_add(cap)` to:

```rust
                    let capped_end = snap_frame_round(
                        snap_frame_floor(
                            layer
                                .t_start_us
                                .saturating_add(cap.saturating_sub(template_src_in)),
                            fps,
                        ),
                        fps,
                    );
```

(For `src_in = 0` this is byte-identical to today, so uncapped/legacy and full-window templates are unchanged.)

- [ ] **Step 5: Run the tests — expect PASS**

Run: `cargo test -p weftcut template_out_trim_cannot_extend_past_content template_in_trim_scrubs_src_in template_in_trim_cannot_scrub_before_content_zero`
Expected: PASS.

- [ ] **Step 6: Run the full template + trim test set (no regressions)**

Run: `cargo test -p weftcut template && cargo test -p weftcut trim`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(templates): trim windows content (IN scrubs src_in, OUT caps at content end)"
```

---

## Task 6: Editing `seconds` re-renders content; shrink-below-window clamps the layer

Replace the current auto-extend block in `apply_update_layer_params` (the prior fix) with: on a Template patch, grow = no geometry change; shrink-below-window = clamp `src_in` + `t_end` into the new content; then autofit.

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` — `apply_update_layer_params` (~lines 3239-3322, the block added by the prior fix)
- Test: `apps/desktop/src-tauri/src/state/actor.rs` tests module

- [ ] **Step 1: Write failing tests**

```rust
    #[tokio::test]
    async fn seconds_grow_does_not_resize_layer() {
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(5));
        let (mut project, track_id) = project_with_video_track();
        let id = apply_add_layer(
            &mut project, track_id, template_layer(props), 0, 5_000_000,
        ).unwrap();
        let mut patch_props = std::collections::HashMap::new();
        patch_props.insert("seconds".to_string(), serde_json::json!(6));
        apply_update_layer_params(
            &mut project, id,
            &LayerParamsPatch::Template(TemplatePatch {
                props: Some(patch_props),
                ..Default::default()
            }),
        ).unwrap();
        let (ti, li) = locate_layer(&project, id).unwrap();
        let l = &project.tracks[ti].layers[li];
        assert_eq!(l.t_end_us, 5_000_000, "grow must NOT resize the layer");
        if let LayerParams::Template(p) = &l.params {
            assert_eq!(p.src_in_us, 0);
        }
    }

    #[tokio::test]
    async fn seconds_shrink_below_window_clamps_layer() {
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(6));
        let (mut project, track_id) = project_with_video_track();
        let id = apply_add_layer(
            &mut project, track_id, template_layer(props), 0, 6_000_000,
        ).unwrap();
        let mut patch_props = std::collections::HashMap::new();
        patch_props.insert("seconds".to_string(), serde_json::json!(3));
        apply_update_layer_params(
            &mut project, id,
            &LayerParamsPatch::Template(TemplatePatch {
                props: Some(patch_props),
                ..Default::default()
            }),
        ).unwrap();
        let (ti, li) = locate_layer(&project, id).unwrap();
        let l = &project.tracks[ti].layers[li];
        assert_eq!(l.t_end_us, 3_000_000, "shrink-below-window clamps t_end to content");
    }
```

- [ ] **Step 2: Run them — expect FAIL**

Run: `cargo test -p weftcut seconds_grow_does_not_resize_layer seconds_shrink_below_window_clamps_layer`
Expected: FAIL (the current fix auto-EXTENDS on grow → first test fails; shrink path differs).

- [ ] **Step 3: Replace the post-patch Template block**

In `apply_update_layer_params` (`actor.rs` ~3239-3322), replace the entire block from `let mut cap_changed = false;` through the closing of the `if let Some(old_cap) = old_cap_us { ... }` (i.e. the prior fix's grow/shrink computation) with the shrink-only clamp below. Keep the `old_cap_us` snapshot, the `apply_params_patch` call, and the final `apply_duration_autofit` gating:

```rust
    // Content-window model: editing the cap-driving prop (`seconds`) changes the
    // intrinsic content, NOT the layer geometry — EXCEPT when the content shrinks
    // below the current window, where we clamp src_in + t_end into the new
    // content (the longer content no longer exists). Growing never resizes.
    let mut geom_changed = false;
    {
        let layer = &mut project.tracks[ti].layers[li];
        let t_start = layer.t_start_us;
        let t_end = layer.t_end_us;

        let clamp: Option<(i64, i64)> = if let LayerParams::Template(ref tp) = layer.params {
            let catalog = crate::templates::builtins();
            catalog
                .iter()
                .find(|t| t.id() == tp.template_id)
                .and_then(|t| {
                    crate::templates::resolve_template_max_dur_us(&t.manifest, &tp.props)
                })
                .and_then(|content_dur| {
                    let src_in = tp.src_in_us;
                    let width = t_end - t_start;
                    // src_out (derived) must fit in [0, content_dur].
                    if src_in + width <= content_dur {
                        return None; // grow / within content → no geometry change
                    }
                    // Clamp the window start into content (keep >= 0, < content_dur).
                    let max_src_in = (content_dur - 1).max(0);
                    let new_src_in = crate::state::time::snap_frame_round(
                        src_in.min(max_src_in),
                        fps,
                    );
                    // Largest grid t_end whose derived src_out stays <= content_dur.
                    let capped_end = crate::state::time::snap_frame_round(
                        crate::state::time::snap_frame_floor(
                            t_start.saturating_add(content_dur.saturating_sub(new_src_in)),
                            fps,
                        ),
                        fps,
                    );
                    // Never collapse below a single frame.
                    let frame_dur = crate::state::time::frame_dur_us(fps);
                    let new_t_end = capped_end.max(t_start.saturating_add(frame_dur));
                    Some((new_src_in, new_t_end))
                })
        } else {
            None
        };

        if let Some((new_src_in, new_t_end)) = clamp {
            if let LayerParams::Template(ref mut tp) = layer.params {
                tp.src_in_us = new_src_in;
            }
            layer.t_end_us = new_t_end;
            geom_changed = true;
        }
    }

    if geom_changed {
        apply_duration_autofit(project);
    }
    Ok(())
```

NOTE: confirm a `frame_dur_us(fps)` helper exists in `crate::state::time` (the codebase computes frame duration there). If the helper has a different name/signature, use the existing one (e.g. compute from `fps` the same way `snap_frame_*` do). If none exists, use `1` µs as the floor instead of `frame_dur` (the `snap_frame_round` of `capped_end` already guarantees grid alignment; the `.max` only guards the degenerate `content_dur <= 0` case).

Also DELETE the now-unused `old_cap_us` snapshot if the new block doesn't reference it (it doesn't — it re-resolves from the patched props). Remove the snapshot `let old_cap_us ...` and its surrounding code from the prior fix to avoid an unused-variable warning. Keep the index lookup `(ti, li)`, the `fps` binding, and the `apply_params_patch(&mut project.tracks[ti].layers[li], patch, id)?;` call.

- [ ] **Step 4: Run the tests — expect PASS**

Run: `cargo test -p weftcut seconds_grow_does_not_resize_layer seconds_shrink_below_window_clamps_layer`
Expected: PASS.

- [ ] **Step 5: Run the full param-update + template suite**

Run: `cargo test -p weftcut template && cargo test -p weftcut params`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(templates): editing seconds re-renders content; shrink clamps layer to content"
```

---

## Task 7: Split carries `src_in` for templates

A split must give the right half the correct window offset (`src_in + split_offset`), mirroring VideoClip. The left half needs no change (derived `src_out`).

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` — `split_single_layer` (~lines 3633-3641)
- Test: `apps/desktop/src-tauri/src/state/actor.rs` tests module

- [ ] **Step 1: Write a failing test**

```rust
    #[tokio::test]
    async fn split_template_advances_right_half_src_in() {
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(6));
        let (mut project, track_id) = project_with_video_track();
        let id = apply_add_layer(
            &mut project, track_id, template_layer(props), 0, 6_000_000,
        ).unwrap();
        // Split at 2s.
        let (_left, right) = split_single_layer(&mut project, id, 2_000_000).unwrap();
        let (ti, li) = locate_layer(&project, right).unwrap();
        if let LayerParams::Template(p) = &project.tracks[ti].layers[li].params {
            assert_eq!(p.src_in_us, 2_000_000, "right half scrubs src_in by split offset");
        } else {
            panic!("not a template");
        }
    }
```

(`split_single_layer` is module-private; the test is in the same module so it's reachable.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `cargo test -p weftcut split_template_advances_right_half_src_in`
Expected: FAIL — right half keeps `src_in = 0`.

- [ ] **Step 3: Add the Template arm to the right-half match**

In `split_single_layer`, the `match &mut right.params` (~lines 3633-3641), add:

```rust
    match &mut right.params {
        LayerParams::VideoClip(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        LayerParams::Audio(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        LayerParams::Template(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        _ => {}
    }
```

The `left.params` match (sets `src_out_us` for media kinds) needs NO template arm — template `src_out` is derived from `left.t_end_us`.

- [ ] **Step 4: Run it — expect PASS**

Run: `cargo test -p weftcut split_template_advances_right_half_src_in`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(templates): split advances right-half src_in (window offset)"
```

---

## Task 8: Full Rust + TS suite + typecheck (regression gate)

- [ ] **Step 1: Rust suite**

Run (from `apps/desktop/src-tauri`): `cargo test -p weftcut`
Expected: all PASS.

- [ ] **Step 2: TS suite**

Run (from `apps/desktop`): `npm test`
Expected: all PASS.

- [ ] **Step 3: Typecheck**

Run (from `apps/desktop`): `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit (only if any fixups were needed)**

```bash
git add -A
git commit -m "test(templates): green full suite for source-windowing"
```

---

## Task 9: End-to-end verification in real WebView2

The project's established verification path (not unit tests). Drive the live app via the `_hypothesi/tauri-mcp-server` bridge. Requires `tauri:dev` running and a driver session.

- [ ] **Step 1: Launch + connect**

Run (from `apps/desktop`): `npm run tauri:dev` (background). Then start a driver session on port 9223 and confirm `ipc_get_backend_state` returns `dev.weftcut.desktop`.

- [ ] **Step 2: Drive the scenarios (via `webview_execute_js` + screenshots)**

For each, invoke commands through `window.__TAURI__.core.invoke` and read back `project_summary`, plus screenshot the timeline + preview:

1. `add_template` countdown `{seconds:5}` → layer `t_end_us == 5_000_000`; preview shows 5→1 across the block.
2. `update_layer_params` `{kind:'Template', props:{seconds:6}}` → `t_end_us` UNCHANGED (5_000_000); preview at layer start shows **6**; preview near layer end shows **2** (the "1" is past the right edge).
3. `trim_layer` OUT to 6_000_000 → succeeds, `t_end_us == 6_000_000`; preview end now shows **1**.
4. `trim_layer` IN to 1_000_000 → `t_start_us == 1_000_000`, `src_in_us == 1_000_000`; preview at the new start shows **5** (scrubbed past the "6").
5. From a full 6s window, `update_layer_params` `{props:{seconds:3}}` → `t_end_us` clamps to `t_start + 3s`; preview shows 3→1.
6. `update_layer_params` `{props:{color:'#00ff00'}}` → geometry UNCHANGED; arc color changes.

- [ ] **Step 3: Capture evidence**

Screenshot each step's timeline + preview. Record the `project_summary` `t_start_us`/`t_end_us`/`src_in_us`/`props` after each mutation.

- [ ] **Step 4: Update product docs (evergreen — no dates/phases)**

If `docs/templates.md` documents the old "animates over its placed duration" semantic, update it to describe the source-window model (`seconds` = content duration; layer = window; trim windows; editing seconds re-renders). Keep it evergreen per the project convention (no dates, no "changed from" history).

```bash
git add docs/templates.md
git commit -m "docs(templates): describe source-window model"
```

- [ ] **Step 5: Finish the branch**

Invoke `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

**Spec coverage:**
- `seconds` = content duration (no new field): Task 2 (TS resolver) + reuse of `resolve_template_max_dur_us` in Tasks 5/6. ✓
- New field `src_in_us` only: Task 1. ✓
- Render decouple (`durationSec = seconds`, content frame, cache key): Task 3 + Task 4 (export). ✓
- Trim mirrors VideoClip (IN moves t_start+src_in; OUT caps at content end): Task 5. ✓
- Editing seconds: grow no-resize, shrink clamps: Task 6. ✓
- Creation src_in=0 + MCP: Task 1. ✓
- Unbounded fallback: Task 3 (`cap == null` branch) + Task 4 + Task 5 (`template_cap.is_some()` guards). ✓
- Split carries src_in: Task 7. ✓
- Verification incl. all six scenarios: Task 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Two NOTES flag where the engineer must match an existing signature (`project_with_video_track`, `Transform` JSON shape, `frame_dur_us`) — these are explicit "confirm against the file" instructions, not placeholders.

**Type consistency:** `src_in_us` is `TimeUs`/`i64` (Rust) and `number` (TS) throughout. `resolveTemplateContentDurationUs` returns `number | null`; consumers handle `null` via `?? durationUs` + `src_in = 0`. `templateContentFrame` returns `{ frame, contentDurationFrames }`, consumed in Task 3. Cache-key field name `durationFrames` is intentionally retained (now fed the content value) to avoid touching the interface.
