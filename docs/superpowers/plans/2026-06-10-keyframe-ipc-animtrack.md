# Keyframe IPC: Ship `AnimTrack<T>` Through LayerSummary Views

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop flattening `Animated<T>` at the IPC boundary — `projectSummary` ships full `AnimTrack<T>` tracks for every animated property, consumers resolve per frame (render) or statically (UI), behavior stays pixel-identical for today's all-Static data.

**Architecture:** Rust `LayerParamsView` structs carry `Animated<f64>` / `Animated<Rgba>` directly (already `Serialize`, wire shape `{mode, value}` — the TS `AnimTrack<T>` mirror at `ipc/index.ts:258` already matches). A new `render/resolveView.ts` resolves raw views → scalar `Resolved*View` shapes once per frame in the Compositor (preview AND export Worker — same code), so sprites stay schema-agnostic. UI panels read via a `trackStatic` helper that mirrors the old `static_or` flatten. A cross-language golden-vector fixture locks `value_at` (Rust) ≡ `resolveAnimated` (TS) and the wire shape before anything ships.

**Tech Stack:** Rust serde + imbl, TS strict, vitest, cargo test. No new deps.

**Scope guard (YAGNI):** Field set unchanged — we unflatten exactly what views ship today (`x,y,scale_x,scale_y,opacity`, text/color `color`, audio `gain_db,pan`). NO `rotation_deg` (views never shipped it; sprite math is separate work). NO `Animated<Rgba>` interpolation (Rust has no `value_at` for Rgba — colors resolve via `trackStatic` until a Rust twin lands; the dual-engine mirror rule forbids a TS-only interpolator). NO keyframe authoring tools (next phase).

**Invariants that must hold after every task:** `npm run typecheck` green; `npm --workspace apps/desktop run test` green; `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` green (run per-task where Rust changed).

---

### Task 1: Golden-vector fixture + Rust lock

The fixture is the single source of truth both engines must reproduce. It also locks the serde wire shape (Rust deserializes the same JSON TS consumes).

**Files:**
- Create: `apps/desktop/src/render/animatedGolden.fixture.json`
- Modify: `apps/desktop/src-tauri/src/state/animated.rs` (append to `mod tests`)

- [ ] **Step 1: Write the fixture**

```json
{
  "comment": "Golden vectors for the Animated<f64> engine pair. Rust state/animated.rs::value_at and TS render/animated.ts::resolveAnimated MUST both reproduce these. Edit only with a matching change on BOTH sides.",
  "default": 99.0,
  "cases": [
    { "name": "static", "track": { "mode": "Static", "value": 7.5 },
      "samples": [ { "t_us": 0, "expect": 7.5 }, { "t_us": 999999, "expect": 7.5 } ] },
    { "name": "empty_keyframed_falls_back", "track": { "mode": "Keyframed", "value": [] },
      "samples": [ { "t_us": 0, "expect": 99.0 } ] },
    { "name": "single_kf_clamps", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 5000000, "value": 3.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 0, "expect": 3.0 }, { "t_us": 9000000, "expect": 3.0 } ] },
    { "name": "linear_lerp_and_clamp", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": -1, "expect": 0.0 }, { "t_us": 2000000, "expect": 2.0 },
                   { "t_us": 5000000, "expect": 5.0 }, { "t_us": 10000000, "expect": 10.0 },
                   { "t_us": 15000000, "expect": 10.0 } ] },
    { "name": "hold_keeps_left_until_next", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 3.0, "interp": { "kind": "Hold" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 8.0, "interp": { "kind": "Hold" } } ] },
      "samples": [ { "t_us": 5000000, "expect": 3.0 }, { "t_us": 9999999, "expect": 3.0 },
                   { "t_us": 10000000, "expect": 8.0 } ] },
    { "name": "ease_in_quadratic", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseIn" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "EaseIn" } } ] },
      "samples": [ { "t_us": 5000000, "expect": 2.5 } ] },
    { "name": "ease_out_quadratic", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseOut" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "EaseOut" } } ] },
      "samples": [ { "t_us": 5000000, "expect": 7.5 } ] },
    { "name": "bezier_stubs_to_linear", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0,
          "interp": { "kind": "Bezier", "p1": [0.4, 0.0], "p2": [0.6, 1.0] } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 5000000, "expect": 5.0 } ] },
    { "name": "multi_segment_picks_governing_left_kf", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 4000000, "value": 8.0, "interp": { "kind": "Hold" } },
        { "id": "00000000-0000-7000-8000-000000000003", "t_us": 8000000, "value": 2.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 2000000, "expect": 4.0 }, { "t_us": 6000000, "expect": 8.0 },
                   { "t_us": 8000000, "expect": 2.0 } ] }
  ]
}
```

Note `t_us: -1` exercises the `t <= first` clamp; UUIDs are syntactically-valid v7 placeholders (Rust `KeyframeId` deserializes them).

- [ ] **Step 2: Write the failing Rust test** (append inside `mod tests` in `state/animated.rs`)

```rust
    /// Cross-language golden vectors. The SAME fixture is asserted by
    /// `render/animated.golden.test.ts` against the TS `resolveAnimated`;
    /// a change that passes one side and fails the other is an engine
    /// drift, which is exactly what this test exists to catch. Also
    /// locks the serde wire shape (`mode`/`value`, `interp.kind`).
    #[test]
    fn golden_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample { t_us: TimeUs, expect: f64 }
        #[derive(serde::Deserialize)]
        struct Case { name: String, track: Animated<f64>, samples: Vec<Sample> }
        #[derive(serde::Deserialize)]
        struct Fixture { default: f64, cases: Vec<Case> }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../src/render/animatedGolden.fixture.json"
        ))
        .expect("fixture parses as Animated<f64> wire shape");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            for s in &case.samples {
                let got = case.track.value_at(s.t_us, fixture.default);
                assert!(
                    (got - s.expect).abs() < 1e-6,
                    "case `{}` t_us={}: got {got}, expect {}",
                    case.name, s.t_us, s.expect
                );
            }
        }
    }
```

- [ ] **Step 3: Run it — must PASS against the existing engine** (this is a characterization lock, not a red-green test; a failure here means the fixture is wrong — fix the fixture, never the engine)

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml golden_vectors_match_fixture`
Expected: `test state::animated::tests::golden_vectors_match_fixture ... ok`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render/animatedGolden.fixture.json apps/desktop/src-tauri/src/state/animated.rs
git commit -m "test(state): golden-vector fixture locks the Animated<f64> engine + wire shape"
```

---

### Task 2: TS golden lock for `resolveAnimated`

**Files:**
- Create: `apps/desktop/src/render/animated.golden.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import type { AnimTrack } from "../ipc";
import { resolveAnimated } from "./animated";
import fixture from "./animatedGolden.fixture.json";

interface Sample { t_us: number; expect: number }
interface Case { name: string; track: AnimTrack<number>; samples: Sample[] }

// Same fixture is asserted by `state/animated.rs::golden_vectors_match_fixture`
// against the Rust engine. Both sides green = no engine drift.
describe("resolveAnimated golden vectors", () => {
  const cases = fixture.cases as unknown as Case[];
  it("has cases", () => expect(cases.length).toBeGreaterThan(0));
  for (const c of cases) {
    it(c.name, () => {
      for (const s of c.samples) {
        expect(resolveAnimated(c.track, s.t_us, fixture.default), `t_us=${s.t_us}`)
          .toBeCloseTo(s.expect, 6);
      }
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npm --workspace apps/desktop run test -- animated.golden`
Expected: all cases PASS. If a case fails, the TS engine drifted from Rust — fix `render/animated.ts` to match `value_at` (never the fixture). If the JSON import trips the build, add `"resolveJsonModule": true` to the desktop tsconfig (check first — vitest usually handles JSON natively).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/animated.golden.test.ts
git commit -m "test(render): TS side of the cross-language golden-vector lock"
```

---

### Task 3: Rust views carry `Animated<T>` (TDD)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` — view structs (~L128-206), `layer_params_view()` (~L516-629), and any unit tests in the file that assert flattened view fields

- [ ] **Step 1: Write the failing serialization test** (append to the `#[cfg(test)]` module in `commands.rs`; reuse the file's existing test helpers for building a project/layer if present — search `mod tests` there first)

```rust
    #[test]
    fn layer_params_view_ships_full_animated_tracks() {
        use crate::state::{Animated, Interpolation, Keyframe};
        let mut p = crate::state::VideoClipParams::default_for_test(); // if no such helper exists, construct inline like the file's other tests do
        p.opacity = Animated::Keyframed(imbl::vector![Keyframe {
            id: crate::state::ids::new_id(),
            t_us: 0,
            value: 0.25,
            interp: Interpolation::Linear,
        }]);
        let view = layer_params_view(&LayerParams::VideoClip(p), &imbl::HashMap::new());
        let json = serde_json::to_value(&view).unwrap();
        // Animated fields ship as tagged tracks, not flattened scalars.
        assert_eq!(json["opacity"]["mode"], "Keyframed");
        assert_eq!(json["opacity"]["value"][0]["value"], 0.25);
        assert_eq!(json["x"]["mode"], "Static");
    }
```

- [ ] **Step 2: Run it — expect FAIL** (`json["opacity"]` is a bare number today)

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml layer_params_view_ships_full`
Expected: FAIL on the `["mode"]` assertion.

- [ ] **Step 3: Change the view structs** — animated fields become tracks; everything else unchanged:

```rust
pub struct MotifView {
    pub motif_id: String,
    pub x: Animated<f64>,
    pub y: Animated<f64>,
    pub scale_x: Animated<f64>,
    pub scale_y: Animated<f64>,
    pub opacity: Animated<f64>,
    pub src_in_us: i64,
    pub props: serde_json::Map<String, serde_json::Value>,
}
```

Same change in `VideoClipView` (`x,y,scale_x,scale_y,opacity`), `ImageOverlayView` (same five), `TextView` (`color: Animated<Rgba>`, `x`, `y`, `opacity`), `ColorView` (`color: Animated<Rgba>`), `AudioView` (`gain_db`, `pan`). `SubtitlesView` untouched. Add `use crate::state::Animated;` at the struct site if not in scope.

- [ ] **Step 4: Builder clones tracks instead of flattening** — in `layer_params_view()` delete the `static_or` / `static_or_rgba` closures and replace every call site with a clone of the track, e.g. for VideoClip:

```rust
            x: p.transform.x.clone(),
            y: p.transform.y.clone(),
            scale_x: p.transform.scale_x.clone(),
            scale_y: p.transform.scale_y.clone(),
            opacity: p.opacity.clone(),
```

(text/color: `color: p.color.clone()`; audio: `gain_db: p.gain_db.clone(), pan: p.pan.clone()`.)

- [ ] **Step 5: Fix compile fallout inside src-tauri** — `cargo build` will surface any other Rust code reading the flattened view fields (e2e hooks, tests). Update them to construct/assert `Animated::Static(...)`. Do NOT touch semantics anywhere else.

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: all green, including the new test.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(ipc): LayerParamsView ships full Animated<T> tracks instead of flattened scalars"
```

---

### Task 4: TS wire types + `trackStatic` helper

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts` (views ~L104-178; `AnimTrack` already at ~L258 — move it ABOVE the views since they now reference it)
- Create: `apps/desktop/src/ipc/tracks.test.ts`

- [ ] **Step 1: Write the failing helper test**

```ts
import { describe, expect, it } from "vitest";
import { trackStatic, type AnimTrack } from "./index";

describe("trackStatic", () => {
  it("returns the static value", () => {
    expect(trackStatic({ mode: "Static", value: 0.5 }, 1)).toBe(0.5);
  });
  it("returns the first keyframe value (mirror of the old Rust static_or)", () => {
    const t: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "k1", t_us: 5, value: 0.25, interp: { kind: "Linear" } },
      { id: "k2", t_us: 9, value: 0.75, interp: { kind: "Linear" } },
    ] };
    expect(trackStatic(t, 1)).toBe(0.25);
  });
  it("falls back on empty keyframes", () => {
    expect(trackStatic({ mode: "Keyframed", value: [] }, 1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`trackStatic` not exported)

Run: `npm --workspace apps/desktop run test -- ipc/tracks`

- [ ] **Step 3: Implement in `ipc/index.ts`** (next to the `AnimTrack` type):

```ts
/// Static read of a track — the editing-surface view of "the value".
/// Mirrors the semantics the Rust flattener used to apply at the IPC
/// boundary (Static → value; Keyframed → first keyframe, else fallback).
/// UI panels read through this; the RENDER path must use
/// `resolveAnimated` (time-aware) instead.
export function trackStatic<T>(track: AnimTrack<T>, fallback: T): T {
  if (track.mode === "Static") return track.value;
  return track.value.length > 0 ? track.value[0]!.value : fallback;
}
```

- [ ] **Step 4: Change the view interfaces** — same field set as Rust (Task 3):

```ts
export interface VideoClipView {
  media_id: string;
  media_label: string;
  src_in_us: number;
  src_out_us: number;
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scale_x: AnimTrack<number>;
  scale_y: AnimTrack<number>;
  opacity: AnimTrack<number>;
  speed: number;
  flip_h: boolean;
  flip_v: boolean;
  fade_in_us: number;
  fade_out_us: number;
}
```

(`ImageOverlayView`/`MotifView`: same five → `AnimTrack<number>`; `TextView`: `color: AnimTrack<Rgba>`, `x`/`y`/`opacity` → `AnimTrack<number>`; `ColorView`: `color: AnimTrack<Rgba>`; `AudioView`: `gain_db`/`pan` → `AnimTrack<number>`.)

- [ ] **Step 5: Run helper test (passes); run typecheck and CAPTURE the error list** — this is the authoritative consumer worklist for Tasks 5–7. Do not fix anything yet.

Run: `npm --workspace apps/desktop run test -- ipc/tracks` → PASS
Run: `npm run typecheck` → FAILS across render/ + properties/ + testhook/ (expected; record the file list)

- [ ] **Step 6: Commit** (types + helper only — the tree is intentionally red on typecheck until Task 7; if your hooks run typecheck on commit, commit Tasks 4–7 together instead)

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/ipc/tracks.test.ts
git commit -m "feat(ipc): view types carry AnimTrack<T>; trackStatic static-read helper"
```

---

### Task 5: `render/resolveView.ts` — raw view → per-frame scalar view

**Files:**
- Create: `apps/desktop/src/render/resolveView.ts`
- Create: `apps/desktop/src/render/resolveView.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { AnimTrack, Rgba } from "../ipc";
import { resolveVideoClipView, resolveTextView } from "./resolveView";

const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });
const ramp: AnimTrack<number> = { mode: "Keyframed", value: [
  { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
  { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
] };
const white: Rgba = { r: 255, g: 255, b: 255, a: 255 };

describe("resolveView", () => {
  it("static tracks resolve to their value at any time", () => {
    const raw = { media_id: "m", media_label: "m", src_in_us: 0, src_out_us: 1,
      x: stat(10), y: stat(20), scale_x: stat(1), scale_y: stat(2), opacity: stat(0.5),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0 };
    const r = resolveVideoClipView(raw, 123_456);
    expect(r).toMatchObject({ x: 10, y: 20, scale_x: 1, scale_y: 2, opacity: 0.5, speed: 1 });
  });
  it("keyframed numeric tracks resolve time-aware (value_at semantics)", () => {
    const raw = { media_id: "m", media_label: "m", src_in_us: 0, src_out_us: 1,
      x: ramp, y: stat(0), scale_x: stat(1), scale_y: stat(1), opacity: ramp,
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0 };
    expect(resolveVideoClipView(raw, 500_000).x).toBeCloseTo(0.5, 9);
    expect(resolveVideoClipView(raw, 500_000).opacity).toBeCloseTo(0.5, 9);
  });
  it("text color resolves statically until the Rgba engine twin exists", () => {
    const raw = { content: "hi", font_family: "Arial", font_size_px: 16,
      color: { mode: "Static", value: white } as AnimTrack<Rgba>,
      x: stat(0), y: stat(0), opacity: stat(1) };
    expect(resolveTextView(raw, 0).color).toEqual(white);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

Run: `npm --workspace apps/desktop run test -- resolveView`

- [ ] **Step 3: Implement**

```ts
// Raw IPC views carry AnimTrack<T>; sprites consume plain scalars. The
// Compositor calls these once per layer per frame with the layer-LOCAL
// time (keyframe t_us is relative to the layer's t_start_us). One
// resolution point — preview and the export Worker share it, so
// keyframed properties hold preview==export by construction.
//
// Rgba tracks resolve via trackStatic: Rust has no Animated<Rgba>::value_at
// yet, and the engine-pair rule (state/animated.rs <-> render/animated.ts)
// forbids a TS-only interpolator. Wire the Rust twin first, then upgrade.
import type {
  AudioView, ColorView, ImageOverlayView, MotifView, Rgba, TextView, VideoClipView,
} from "../ipc";
import { trackStatic } from "../ipc";
import { resolveAnimated } from "./animated";

export interface ResolvedVideoClipView extends Omit<VideoClipView, "x" | "y" | "scale_x" | "scale_y" | "opacity"> {
  x: number; y: number; scale_x: number; scale_y: number; opacity: number;
}
export interface ResolvedImageOverlayView extends Omit<ImageOverlayView, "x" | "y" | "scale_x" | "scale_y" | "opacity"> {
  x: number; y: number; scale_x: number; scale_y: number; opacity: number;
}
export interface ResolvedTextView extends Omit<TextView, "color" | "x" | "y" | "opacity"> {
  color: Rgba; x: number; y: number; opacity: number;
}
export interface ResolvedColorView extends Omit<ColorView, "color"> { color: Rgba }
export interface ResolvedAudioView extends Omit<AudioView, "gain_db" | "pan"> { gain_db: number; pan: number }
export interface ResolvedMotifView extends Omit<MotifView, "x" | "y" | "scale_x" | "scale_y" | "opacity"> {
  x: number; y: number; scale_x: number; scale_y: number; opacity: number;
}

export function resolveVideoClipView(v: VideoClipView, tInLayerUs: number): ResolvedVideoClipView {
  return { ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}
export function resolveImageOverlayView(v: ImageOverlayView, tInLayerUs: number): ResolvedImageOverlayView {
  return { ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}
export function resolveTextView(v: TextView, tInLayerUs: number): ResolvedTextView {
  return { ...v,
    color: trackStatic(v.color, { r: 255, g: 255, b: 255, a: 255 }),
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}
export function resolveColorView(v: ColorView): ResolvedColorView {
  return { ...v, color: trackStatic(v.color, { r: 0, g: 0, b: 0, a: 255 }) };
}
export function resolveAudioView(v: AudioView, tInLayerUs: number): ResolvedAudioView {
  return { ...v,
    gain_db: resolveAnimated(v.gain_db, tInLayerUs, 0),
    pan: resolveAnimated(v.pan, tInLayerUs, 0),
  };
}
export function resolveMotifView(v: MotifView, tInLayerUs: number): ResolvedMotifView {
  return { ...v,
    x: resolveAnimated(v.x, tInLayerUs, 0),
    y: resolveAnimated(v.y, tInLayerUs, 0),
    scale_x: resolveAnimated(v.scale_x, tInLayerUs, 1),
    scale_y: resolveAnimated(v.scale_y, tInLayerUs, 1),
    opacity: resolveAnimated(v.opacity, tInLayerUs, 1),
  };
}
```

Fallback constants mirror the Rust builder's old `static_or` fallbacks (x/y→0, scale→1, opacity→1, gain/pan→0, text→WHITE, color→BLACK).

- [ ] **Step 4: Run — PASS**, then commit

```bash
git add apps/desktop/src/render/resolveView.ts apps/desktop/src/render/resolveView.test.ts
git commit -m "feat(render): per-frame raw-view -> scalar-view resolution (Compositor pre-eval point)"
```

---

### Task 6: Wire the render path

**Files (work down the Task-4 typecheck list; this is the expected set):**
- Modify: `apps/desktop/src/render/Compositor.ts` — `updateClip` (~L1378), `updateImage` (~L1464), `updateText` (~L1516), `updateColor` (~L1494), `updateMotif` (~L1555), `updateAudio` / AudioMixer handoff (~L610-627)
- Modify: `apps/desktop/src/render/sprite/ImageOverlaySprite.ts`, `TextSprite.ts`, `ColorSprite.ts`, `MotifSprite.ts` — `update()` signatures take the `Resolved*` types (bodies unchanged)
- Modify: `apps/desktop/src/render/audio/AudioMixer.ts` — gain/pan inputs become resolved numbers (check its current param type; it may already take scalars from the Compositor)
- Modify: `apps/desktop/src/render/exportBake.ts` + `apps/desktop/src/render/motifs/motifFrameDescriptor.ts` — Motif transform/opacity reads: if the value feeds the CAPTURE CACHE KEY or render size, resolve with `trackStatic` (cache keys must not vary per frame); if it feeds sprite placement, it already flows through `resolveMotifView`
- Modify: `apps/desktop/src/testhook/e2eHook.ts` — fixture summaries wrap values as `{ mode: "Static", value: ... }`
- Modify: affected unit tests (`Compositor`-adjacent, `MotifSprite.test.ts`, `exportBake.test.ts`) — same Static-wrapping, via a tiny local helper `const stat = (v) => ({ mode: "Static", value: v })`

- [ ] **Step 1: Compositor resolves once per layer per frame.** In each `update*`, compute layer-local time and resolve BEFORE touching the sprite. `updateClip` body becomes:

```ts
    const tInLayerUs = tUsSnapped - layer.t_start_us;
    const params = resolveVideoClipView(rawParams, tInLayerUs);
    // ... existing body unchanged below this line (params.* are scalars again)
```

Apply the same two-line pattern in `updateImage`, `updateText`, `updateColor` (no time arg), `updateMotif`, and resolve `AudioView` before the mixer handoff. `updateText`/`updateColor` currently don't receive a time — thread `tUsSnapped` through from `compositeFrame`'s call sites (mechanical signature change inside one file).

- [ ] **Step 2: Sprite signatures switch to `Resolved*` imports.** Bodies stay byte-identical — they already consume scalars. TextSprite's `appliedSig` keeps working: with all-Static data the resolved values are constant, so the signature is stable; a keyframed text property re-rasterizing per frame is the documented cost until the tint optimization (next phase, see roadmap).

- [ ] **Step 3: Run the suite; fix the remaining typecheck list** (tests + e2eHook fixtures get `stat()` wrappers).

Run: `npm run typecheck` → green
Run: `npm --workspace apps/desktop run test` → green (388 + new)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render apps/desktop/src/testhook
git commit -m "feat(render): Compositor resolves AnimTrack views per frame; sprites stay scalar"
```

---

### Task 7: UI panel reads via `trackStatic`

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` — Text (~L240-251), VideoClip (~L353-364), ImageOverlay (~L501-507), Motif (~L614-622), Color (~L1153-1155), Audio (~L1200, ~L1215)

- [ ] **Step 1: Replace direct field reads with `trackStatic`.** Pattern (VideoClip section):

```tsx
  const [opacity, setOpacity] = useState(trackStatic(v.opacity, 1));
  const [scaleX, setScaleX] = useState(trackStatic(v.scale_x, 1));
  const [scaleY, setScaleY] = useState(trackStatic(v.scale_y, 1));
  // ...sync effect:
    setOpacity(trackStatic(v.opacity, 1));
```

Color hex field: `rgbaToHex(trackStatic(v.color, BLACK))` and the alpha-preserving commit reads `trackStatic(v.color, BLACK).a`. Audio: `trackStatic(v.gain_db, 0)` / `trackStatic(v.pan, 0)`. The COMMIT path is untouched — panels keep writing scalars; the actor wraps them `Animated::Static` (state/actor.rs ~L4129) exactly as today.

- [ ] **Step 2: Verify**

Run: `npm run typecheck` → green
Run: `npm --workspace apps/desktop run test` → green

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx
git commit -m "feat(properties): panels read tracks via trackStatic; commit path stays scalar"
```

---

### Task 8: Full-pipeline verification

- [ ] **Step 1: Full gates**

Run: `npm run typecheck` → green
Run: `npm --workspace apps/desktop run test` → all green
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → all green

- [ ] **Step 2: Live keyframe smoke (proves the transport actually animates).** Launch `npm run dev`; in the app open/create a project with a video or color layer. Inject a keyframed opacity via the dev MCP bridge / devtools against the running actor — e.g. call `update_layer_params` with a raw `Animated` JSON `{"mode":"Keyframed","value":[{"id":"<uuid>","t_us":0,"value":0,"interp":{"kind":"Linear"}},{"id":"<uuid>","t_us":3000000,"value":1,"interp":{"kind":"Linear"}}]}` if the patch surface accepts it; if the patch surface only accepts scalars (actor.rs wraps `Static`), instead hand-edit the saved `project.json`'s layer `opacity` to the same Keyframed shape and reopen the project. Expected: the layer fades in over 3 s during playback, scrubbing lands deterministic intermediate opacities, and the property panel shows the first keyframe's value (0).
- [ ] **Step 3: Behavior-parity smoke on an untouched project:** open an existing all-Static project — identical preview, identical property panel values, export completes. (The conformance E2E gate covers export pixels; run it here only if media fixtures are already set up in this environment: `WEFTCUT_TEST_MEDIA` + msedgedriver per `docs/conformance.md`.)
- [ ] **Step 4: Update `docs/render.md`** — the sentence "Sprites resolve `Animated<T>` values via the shared `engine.ts` helpers" (~L78) is now half-true and points at the wrong module; rewrite to name the real seam:

```markdown
`render(tUs)` walks the mounted sprites in z-order. For each layer the
Compositor first resolves the view's `AnimTrack<T>` properties at the
layer-local time via `render/resolveView.ts` (numeric tracks through
`render/animated.ts`'s `resolveAnimated`, the byte-for-byte mirror of
Rust `state/animated.rs::value_at`; color tracks statically until the
Rgba engine twin lands), then hands the resolved scalar view to the
sprite. A shared golden-vector fixture
(`render/animatedGolden.fixture.json`) locks the two engines together.
```

- [ ] **Step 5: Commit + report.** Use superpowers:finishing-a-development-branch — present merge/PR options to the user (origin/main is shared with concurrent sessions; do NOT merge without the user's call).

```bash
git add docs/render.md
git commit -m "docs(render): per-frame AnimTrack resolution seam replaces the aspirational engine.ts claim"
```

---

## Self-review notes

- **Spec coverage:** roadmap link 1 ("ship `AnimTrack<T>` through the LayerSummary views") = Tasks 3-4; "pre-resolve per frame in the Compositor (sprites stay schema-agnostic)" = Tasks 5-6; "golden-vector test over the engine copies before enabling" = Tasks 1-2 (deliberately FIRST); UI parity = Task 7. Out of scope per the scope guard: signature-cache exemption + text tint, keyframe MCP/actor tools, trim validation, Rgba interpolation — all later roadmap links.
- **Type consistency:** `trackStatic` lives in `ipc/index.ts` (Tasks 4, 5, 7 all import from there); `Resolved*View` names used identically in Tasks 5 and 6; fixture filename `animatedGolden.fixture.json` identical in Tasks 1, 2, 8.
- **Known risk:** Task 6 is the widest blast radius (the Task-4 typecheck error list is its worklist — trust the compiler, not this plan's file enumeration). Worker boundary needs no change: `ProjectSummary` is `structuredClone`d, and AnimTrack objects clone fine.
