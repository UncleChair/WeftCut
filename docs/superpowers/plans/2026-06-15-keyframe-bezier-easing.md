# Keyframe Bézier Easing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crude quadratic eases + the Bézier linear-stub with a real cubic-Bézier easing engine, a monotone "Smooth" command (velocity-continuous through a keyframe), and a unified easing-editor popover (preset chips + draggable curve + motion preview).

**Architecture:** Keep the `Animated<T>` schema unchanged — `Bezier{p1,p2}` already *is* `cubic-bezier(x1,y1,x2,y2)`, one timing function per segment stored on the left keyframe. Add an identical WebKit-`UnitBezier` solver to BOTH interpolation engines (Rust `value_at`, TS `resolveAnimated`), locked by the shared golden-vector fixture. `EaseIn`/`EaseOut` become their true CSS cubics (zero on-disk migration). Smooth is a TS-only pure `AnimTrack` transform (it only *produces* `Bezier` data both engines already resolve). The editor replaces `KeyframeInterpMenu` at its two existing call sites.

**Tech Stack:** Rust (serde, cargo test), TypeScript/React 19 (vitest, `tsc -b`), Base-UI popover, i18next (en-US + zh-CN), wdio real-WebView2 e2e.

**Spec:** `docs/superpowers/specs/2026-06-15-keyframe-bezier-easing-design.md`

**Determinism rule (read first):** Rust `state/animated.rs::value_at` and TS `render/animated.ts::resolveAnimated` are a byte-identical engine pair. The cross-language fixture `render/animatedGolden.fixture.json` is asserted by BOTH (`animated.golden.test.ts` + Rust `golden_vectors_match_fixture`). Any change to one engine's math MUST land with the matching change to the other and the fixture, in the same task. Per `feedback_engine_source_drift` / `feedback_snap_math_drift`: diff both sides whenever touching one.

---

## File Structure

**Engine (Phase A):**
- `apps/desktop/src-tauri/src/state/animated.rs` — add `unit_bezier()`; wire it into `value_at`; update inline ease tests.
- `apps/desktop/src/render/animated.ts` — add `unitBezier()`; wire it into `resolveAnimated`.
- `apps/desktop/src/render/animatedGolden.fixture.json` — new/updated cubic golden cases.

**Smooth (Phase B):**
- `apps/desktop/src/keyframe/edits.ts` — add `smoothKeyframe()` + `smoothTrack()`.
- `apps/desktop/src/keyframe/edits.test.ts` — tests (exists already; append).

**Editor UI (Phase C):**
- `apps/desktop/src/keyframe/curve.ts` (new, pure) — preset coeff table + handle↔coefficient mapping + clamps.
- `apps/desktop/src/keyframe/curve.test.ts` (new) — pure tests.
- `apps/desktop/src/timeline/EasingCanvas.tsx` (new) — SVG unit-square curve + two draggable handles.
- `apps/desktop/src/timeline/MotionPreview.tsx` (new) — rAF dot eased by the current curve.
- `apps/desktop/src/timeline/EasingEditor.tsx` (new) — popover assembling chips + canvas + preview; computes the new track and calls `onCommit`.
- `apps/desktop/src/timeline/LayerBlock.tsx` + `apps/desktop/src/timeline/KeyframeLane.tsx` — swap `KeyframeInterpMenu` → `EasingEditor`.
- `apps/desktop/src/timeline/KeyframeInterpMenu.tsx` — delete.
- `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts` — new `keyframe.*` strings.

**Docs + e2e (Phase D):**
- `docs/data-model.md`, `docs/render.md` — interpolation semantics.
- `apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js` — extend with a custom-Bézier export assertion.

---

## Phase A — Cubic-Bézier engine

### Task 1: Rust `unit_bezier` solver

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/animated.rs` (add free fn near top of module, after the `use` block; add tests in the existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block (anywhere among the existing tests):

```rust
    #[test]
    fn unit_bezier_identity_when_coords_equal() {
        // cubic-bezier(0,0,1,1): x and y control coords equal → y(x) = x.
        for &x in &[0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
            assert!((super::unit_bezier(0.0, 0.0, 1.0, 1.0, x) - x).abs() < 1e-6);
        }
    }

    #[test]
    fn unit_bezier_endpoints() {
        assert!((super::unit_bezier(0.42, 0.0, 0.58, 1.0, 0.0) - 0.0).abs() < 1e-9);
        assert!((super::unit_bezier(0.42, 0.0, 0.58, 1.0, 1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn unit_bezier_symmetric_ease_in_out_midpoint_is_half() {
        // cubic-bezier(0.42,0,0.58,1) is point-symmetric about (0.5,0.5).
        assert!((super::unit_bezier(0.42, 0.0, 0.58, 1.0, 0.5) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn unit_bezier_ease_in_is_slow_at_start() {
        // Ease-in (0.42,0,1,1): below the diagonal early, above late.
        assert!(super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.25) < 0.25);
        assert!(super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.75) < 0.75);
        assert!(super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.5) < 0.5);
    }
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib state::animated::tests::unit_bezier`
Expected: FAIL — `cannot find function unit_bezier`.

- [ ] **Step 3: Implement the solver**

Insert after the `use super::time::TimeUs;` line (module top-level, before `pub enum Animated`):

```rust
/// Evaluate a `cubic-bezier(x1,y1,x2,y2)` timing function at normalized
/// progress `x` ∈ [0,1]. Control points are (0,0),(x1,y1),(x2,y2),(1,1):
/// solve `X(s)=x` for the Bézier parameter `s` (Newton-Raphson, ≤8 iters,
/// bisection fallback), then return `Y(s)`. `x1,x2` are assumed in [0,1]
/// (enforced at authoring) so `X` is monotone and the solve single-valued.
///
/// MIRRORS `render/animated.ts::unitBezier` byte-for-byte (WebKit UnitBezier).
/// Any edit here MUST be mirrored there + reflected in the golden fixture.
pub fn unit_bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    const EPS: f64 = 1e-7;
    // Bézier → power-basis coefficients.
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;
    let sample_x = |t: f64| ((ax * t + bx) * t + cx) * t;
    let sample_y = |t: f64| ((ay * t + by) * t + cy) * t;
    let sample_dx = |t: f64| (3.0 * ax * t + 2.0 * bx) * t + cx;

    // Newton-Raphson.
    let mut t = x;
    for _ in 0..8 {
        let xt = sample_x(t) - x;
        if xt.abs() < EPS {
            return sample_y(t);
        }
        let d = sample_dx(t);
        if d.abs() < 1e-6 {
            break;
        }
        t -= xt / d;
    }
    // Bisection fallback.
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    t = x;
    if t < lo {
        return sample_y(lo);
    }
    if t > hi {
        return sample_y(hi);
    }
    while lo < hi {
        let xt = sample_x(t);
        if (xt - x).abs() < EPS {
            return sample_y(t);
        }
        if x > xt {
            lo = t;
        } else {
            hi = t;
        }
        t = (hi - lo) * 0.5 + lo;
    }
    sample_y(t)
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib state::animated::tests::unit_bezier`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/animated.rs
git commit -m "feat(animated): add cubic-bezier UnitBezier solver (Rust)"
```

---

### Task 2: TS `unitBezier` solver (mirror)

**Files:**
- Modify: `apps/desktop/src/render/animated.ts` (add exported fn above `resolveAnimated`)
- Create: `apps/desktop/src/render/unitBezier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/render/unitBezier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unitBezier } from "./animated";

describe("unitBezier", () => {
  it("is identity when x/y coords are equal (linear)", () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(unitBezier(0, 0, 1, 1, x)).toBeCloseTo(x, 6);
    }
  });
  it("hits endpoints", () => {
    expect(unitBezier(0.42, 0, 0.58, 1, 0)).toBeCloseTo(0, 9);
    expect(unitBezier(0.42, 0, 0.58, 1, 1)).toBeCloseTo(1, 9);
  });
  it("symmetric ease-in-out midpoint is 0.5", () => {
    expect(unitBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("ease-in is slow at the start", () => {
    expect(unitBezier(0.42, 0, 1, 1, 0.25)).toBeLessThan(0.25);
    expect(unitBezier(0.42, 0, 1, 1, 0.5)).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/unitBezier.test.ts`
Expected: FAIL — `unitBezier` is not exported.

- [ ] **Step 3: Implement the mirror**

In `apps/desktop/src/render/animated.ts`, add above `resolveAnimated` (after the `Interpolation` type / `AnimTrack` type):

```ts
/// Evaluate `cubic-bezier(x1,y1,x2,y2)` at normalized progress `x` ∈ [0,1].
/// MIRRORS Rust `state/animated.rs::unit_bezier` byte-for-byte (WebKit
/// UnitBezier). Edit both sides + the golden fixture together.
export function unitBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
): number {
  const EPS = 1e-7;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xt = sampleX(t) - x;
    if (Math.abs(xt) < EPS) return sampleY(t);
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= xt / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  if (t < lo) return sampleY(lo);
  if (t > hi) return sampleY(hi);
  while (lo < hi) {
    const xt = sampleX(t);
    if (Math.abs(xt - x) < EPS) return sampleY(t);
    if (x > xt) lo = t;
    else hi = t;
    t = (hi - lo) * 0.5 + lo;
  }
  return sampleY(t);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/desktop && npx vitest run src/render/unitBezier.test.ts && npx tsc -b`
Expected: PASS (4 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/animated.ts apps/desktop/src/render/unitBezier.test.ts
git commit -m "feat(animated): add cubic-bezier unitBezier solver (TS mirror)"
```

---

### Task 3: Wire both engines + update golden fixture (atomic, both green)

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/animated.rs:226-272` (`value_at` interp match + the doc comment) and the inline `value_at_ease_in_quadratic`/`value_at_ease_out` tests
- Modify: `apps/desktop/src/render/animated.ts` (`resolveAnimated` interp branch + doc comment)
- Modify: `apps/desktop/src/render/animatedGolden.fixture.json`

This is one logical change (the engine pair + its contract). The fixture is the cross-language gate, so both sides flip together.

- [ ] **Step 1: Wire the Rust engine**

In `value_at`, replace the interp `match` (lines ~260-268) with:

```rust
                match a.interp {
                    Interpolation::Hold => return a.value,
                    Interpolation::Linear => {}
                    Interpolation::EaseIn => u = unit_bezier(0.42, 0.0, 1.0, 1.0, u),
                    Interpolation::EaseOut => u = unit_bezier(0.0, 0.0, 0.58, 1.0, u),
                    Interpolation::Bezier { p1, p2 } => {
                        u = unit_bezier(p1.0, p1.1, p2.0, p2.1, u);
                    }
                }
```

And update the doc comment (lines ~226-230) to:

```rust
    ///   and apply `kf[i].interp` (Hold → `a.value`; Linear → lerp;
    ///   EaseIn/EaseOut → CSS cubic eases via `unit_bezier`; Bezier →
    ///   `unit_bezier(p1,p2)`), then `a.value + (b.value-a.value) * u`.
```

- [ ] **Step 2: Fix the inline Rust ease tests (now cubic, not quadratic)**

Replace `value_at_ease_in_quadratic` (asserts `2.5`) and its sibling. Compare against the solver so there is no magic number:

```rust
    #[test]
    fn value_at_ease_in_uses_cubic_bezier() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::EaseIn),
            kf(10_000_000, 10.0, Interpolation::EaseIn),
        ]);
        let expected = super::unit_bezier(0.42, 0.0, 1.0, 1.0, 0.5) * 10.0;
        assert!((a.value_at(5_000_000, 0.0) - expected).abs() < 1e-9);
    }

    #[test]
    fn value_at_ease_out_uses_cubic_bezier() {
        let a = keyframed(vec![
            kf(0, 0.0, Interpolation::EaseOut),
            kf(10_000_000, 10.0, Interpolation::EaseOut),
        ]);
        let expected = super::unit_bezier(0.0, 0.0, 0.58, 1.0, 0.5) * 10.0;
        assert!((a.value_at(5_000_000, 0.0) - expected).abs() < 1e-9);
    }
```

(If only `value_at_ease_in_quadratic` exists, replace it and add the ease-out one. Delete any test still asserting the `u*u` quadratic value.)

- [ ] **Step 3: Wire the TS engine**

In `apps/desktop/src/render/animated.ts` `resolveAnimated`, replace the easing branch (the `if (kind === "EaseIn") … Bezier: linear stub` region, lines ~52-60) with:

```ts
  const kind = a.interp?.kind;
  if (kind === "Hold") return a.value;
  if (kind === "EaseIn") u = unitBezier(0.42, 0, 1, 1, u);
  else if (kind === "EaseOut") u = unitBezier(0, 0, 0.58, 1, u);
  else if (kind === "Bezier") u = unitBezier(a.interp.p1[0], a.interp.p1[1], a.interp.p2[0], a.interp.p2[1], u);
  // Linear: u unchanged.
  return (a.value + (b.value - a.value) * u) as T;
```

Update the `resolveAnimated` doc comment line about "Bezier (treated as Linear in v1…)" to "EaseIn/EaseOut/Bezier resolve via `unitBezier` (cubic)".

- [ ] **Step 4: Rewrite the golden fixture's interpolation cases**

In `animatedGolden.fixture.json`, replace the `ease_in_quadratic`, `ease_out_quadratic`, and `bezier_stubs_to_linear` cases with the cubic cases below. The exact-value cases (symmetric ease-in-out → 5.0; bezier endpoints → 0/10) need no generation. The ease-in/ease-out/custom interior values are GENERATED in Step 5 (placeholder `0.0` for now):

```json
    { "name": "ease_in_out_symmetric_midpoint", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0,
          "interp": { "kind": "Bezier", "p1": [0.42, 0.0], "p2": [0.58, 1.0] } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 5000000, "expect": 5.0 } ] },
    { "name": "bezier_endpoints_exact", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0,
          "interp": { "kind": "Bezier", "p1": [0.25, 0.1], "p2": [0.25, 1.0] } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 0, "expect": 0.0 }, { "t_us": 10000000, "expect": 10.0 } ] },
    { "name": "ease_in_cubic", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseIn" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 2500000, "expect": 0.0 }, { "t_us": 5000000, "expect": 0.0 } ] },
    { "name": "ease_out_cubic", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseOut" } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 5000000, "expect": 0.0 }, { "t_us": 7500000, "expect": 0.0 } ] },
    { "name": "custom_bezier_interior", "track": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-7000-8000-000000000001", "t_us": 0, "value": 0.0,
          "interp": { "kind": "Bezier", "p1": [0.2, 0.8], "p2": [0.8, 0.2] } },
        { "id": "00000000-0000-7000-8000-000000000002", "t_us": 10000000, "value": 10.0, "interp": { "kind": "Linear" } } ] },
      "samples": [ { "t_us": 2500000, "expect": 0.0 }, { "t_us": 5000000, "expect": 5.0 }, { "t_us": 7500000, "expect": 0.0 } ] }
```

(Keep the existing `static`, `empty_keyframed_falls_back`, `single_kf_clamps`, `linear_lerp_and_clamp`, `hold_keeps_left_until_next`, `multi_segment_picks_governing_left_kf` cases unchanged. Note `custom_bezier(0.2,0.8,0.8,0.2)` is point-symmetric → its `t=5s` value is exactly `5.0`; only the `2.5s`/`7.5s` samples need generation.)

- [ ] **Step 5: Generate the interior expected values**

Run the TS golden test — vitest prints `received` vs `expected` for each failing `toBeCloseTo`:

Run: `cd apps/desktop && npx vitest run src/render/animated.golden.test.ts`
Expected: FAIL on `ease_in_cubic`, `ease_out_cubic`, `custom_bezier_interior` (the `0.0` placeholders). For each failing sample, read the `received` number from the diff and paste it (rounded to 6 dp) into the fixture's `expect`. Re-run until green. (These values are produced by the just-written `unitBezier`, so Rust independently reproduces them to <1e-6.)

- [ ] **Step 6: Run BOTH golden suites + full quick gates**

Run: `cd apps/desktop && npx vitest run src/render/animated.golden.test.ts && npx tsc -b`
Run: `cd apps/desktop/src-tauri && cargo test --lib state::animated`
Expected: TS golden PASS; tsc clean; Rust `golden_vectors_match_fixture` + the two new ease tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/state/animated.rs apps/desktop/src/render/animated.ts apps/desktop/src/render/animatedGolden.fixture.json
git commit -m "feat(animated): resolve EaseIn/EaseOut/Bezier via cubic solver in both engines

EaseIn/EaseOut are now their true CSS cubics (was u^2 / 1-(1-u)^2); Bezier
is no longer a linear stub. Golden fixture updated; engine pair stays locked."
```

---

## Phase B — Smooth command

### Task 4: `smoothKeyframe` + `smoothTrack` (TS-only pure transform)

**Files:**
- Modify: `apps/desktop/src/keyframe/edits.ts`
- Modify: `apps/desktop/src/keyframe/edits.test.ts`

Math: monotone, no-overshoot. Tangent at interior key `i` = neighbour secant `m = (v[i+1]-v[i-1])/(t[i+1]-t[i-1])`, clamped to `0` at a local extremum. Convert to control-point y with fixed x-handles `1/3`/`2/3`: outgoing segment `i` gets `p1=(1/3, clamp01(m·Δt_i/(3·Δv_i)))`; incoming segment `i-1` gets `p2=(2/3, clamp01(1 − m·Δt_{i-1}/(3·Δv_{i-1})))`. Clamping y to `[0,1]` is the no-overshoot guard. `Δv≈0` → that segment stays `Linear`. The OTHER control point of each touched segment is preserved (from its current interp's coefficients).

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/keyframe/edits.test.ts` (add `smoothKeyframe`, `smoothTrack`, and `resolveAnimated` to the existing imports from `./edits` / `../render/animated`):

```ts
import { smoothKeyframe, smoothTrack } from "./edits";
import { resolveAnimated } from "../render/animated";

function kf(id: string, t_us: number, value: number) {
  return { id, t_us, value, interp: { kind: "Linear" as const } };
}

describe("smoothKeyframe", () => {
  it("is a no-op on Static", () => {
    const s = { mode: "Static" as const, value: 3 };
    expect(smoothKeyframe(s, "x")).toBe(s);
  });

  it("does not overshoot at a peak (extremum → flat tangent)", () => {
    // values 0, 10, 0 — middle is a local max; smoothed curve must never exceed 10.
    const track = {
      mode: "Keyframed" as const,
      value: [kf("a", 0, 0), kf("b", 1_000_000, 10), kf("c", 2_000_000, 0)],
    };
    const out = smoothTrack(track);
    for (let t = 0; t <= 2_000_000; t += 50_000) {
      expect(resolveAnimated(out, t, 0)).toBeLessThanOrEqual(10 + 1e-6);
      expect(resolveAnimated(out, t, 0)).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("keeps a flat (equal-value) segment Linear", () => {
    const track = {
      mode: "Keyframed" as const,
      value: [kf("a", 0, 5), kf("b", 1_000_000, 5), kf("c", 2_000_000, 9)],
    };
    const out = smoothKeyframe(track, "a");
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    expect(out.value[0]!.interp.kind).toBe("Linear"); // a→b is flat (Δv=0)
  });

  it("produces in-range control-point y on a monotone ramp", () => {
    const track = {
      mode: "Keyframed" as const,
      value: [kf("a", 0, 0), kf("b", 1_000_000, 5), kf("c", 2_000_000, 10)],
    };
    const out = smoothKeyframe(track, "b");
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    const seg = out.value[1]!.interp; // outgoing segment of b
    if (seg.kind !== "Bezier") throw new Error("expected bezier");
    expect(seg.p1[1]).toBeGreaterThanOrEqual(0);
    expect(seg.p1[1]).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/desktop && npx vitest run src/keyframe/edits.test.ts`
Expected: FAIL — `smoothKeyframe`/`smoothTrack` not exported.

- [ ] **Step 3: Implement**

Append to `apps/desktop/src/keyframe/edits.ts`:

```ts
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// Current interp as cubic-bezier control coords [x1,y1,x2,y2]. Linear/Hold
/// map to the identity diagonal so a single-sided smooth keeps the other side
/// linear-ish. (Hold becomes a curve when smoothed — intended.)
function toBezierCoeffs(interp: Interpolation): [number, number, number, number] {
  switch (interp.kind) {
    case "Bezier":
      return [interp.p1[0], interp.p1[1], interp.p2[0], interp.p2[1]];
    case "EaseIn":
      return [0.42, 0, 1, 1];
    case "EaseOut":
      return [0, 0, 0.58, 1];
    default:
      return [0, 0, 1, 1]; // Linear / Hold → identity diagonal
  }
}

/// Monotone-clamped tangent (value per microsecond) at interior key `i`.
/// 0 at a local extremum (or when a neighbour delta is 0).
function tangentAt(keys: Keyframe<number>[], i: number): number {
  const prev = keys[i - 1];
  const next = keys[i + 1];
  if (!prev || !next) return 0; // endpoints → flat
  const dPrev = keys[i]!.value - prev.value;
  const dNext = next.value - keys[i]!.value;
  if (dPrev === 0 || dNext === 0 || Math.sign(dPrev) !== Math.sign(dNext)) return 0;
  const dt = next.t_us - prev.t_us;
  if (dt <= 0) return 0;
  return (next.value - prev.value) / dt;
}

/// Bake monotone (no-overshoot) tangents at key `id` into the outgoing segment
/// (this key's interp.p1) and the incoming segment (previous key's interp.p2),
/// giving C1-continuous velocity through the key. Returns a NEW track.
export function smoothKeyframe(track: AnimTrack<number>, id: string): AnimTrack<number> {
  if (track.mode === "Static") return track;
  const keys = track.value;
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) return track;
  const m = tangentAt(keys, i);
  const out = keys.slice();

  // Outgoing segment i → i+1: set this key's p1 from m.
  if (i < keys.length - 1) {
    const dt = keys[i + 1]!.t_us - keys[i]!.t_us;
    const dv = keys[i + 1]!.value - keys[i]!.value;
    if (dv === 0 || dt <= 0) {
      out[i] = { ...keys[i]!, interp: { kind: "Linear" } };
    } else {
      const [, , x2, y2] = toBezierCoeffs(keys[i]!.interp);
      const y1 = clamp01((m * dt) / (3 * dv));
      out[i] = { ...keys[i]!, interp: { kind: "Bezier", p1: [1 / 3, y1], p2: [x2, y2] } };
    }
  }

  // Incoming segment i-1 → i: set previous key's p2 from m.
  if (i > 0) {
    const dt = keys[i]!.t_us - keys[i - 1]!.t_us;
    const dv = keys[i]!.value - keys[i - 1]!.value;
    if (dv === 0 || dt <= 0) {
      out[i - 1] = { ...keys[i - 1]!, interp: { kind: "Linear" } };
    } else {
      const [x1, y1] = toBezierCoeffs(out[i - 1]!.interp);
      const y2 = clamp01(1 - (m * dt) / (3 * dv));
      out[i - 1] = { ...out[i - 1]!, interp: { kind: "Bezier", p1: [x1, y1], p2: [2 / 3, y2] } };
    }
  }

  return { mode: "Keyframed", value: out };
}

/// Smooth every interior keyframe (one whole-track result → one undo step).
export function smoothTrack(track: AnimTrack<number>): AnimTrack<number> {
  if (track.mode === "Static") return track;
  let t = track;
  for (const k of track.value) t = smoothKeyframe(t, k.id);
  return t;
}
```

Ensure `Interpolation` and `Keyframe` are imported at the top of `edits.ts` (currently it imports `AnimTrack, Interpolation, Keyframe`). Add `Interpolation`/`Keyframe` to the import if missing.

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/desktop && npx vitest run src/keyframe/edits.test.ts && npx tsc -b`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/edits.ts apps/desktop/src/keyframe/edits.test.ts
git commit -m "feat(keyframe): smoothKeyframe/smoothTrack — monotone no-overshoot auto-tangents"
```

---

## Phase C — Easing editor UI

### Task 5: i18n strings

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` (the `keyframe:` block, ~line 9-18)
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts` (the `keyframe:` block, ~line 11-20)

- [ ] **Step 1: Add keys (en-US)**

Inside the `keyframe: { … }` object in `en-US.ts`, after `interp_ease_out`:

```ts
    interp_ease: "Ease",
    interp_ease_in_out: "Ease In-Out",
    easing_title: "Easing",
    smooth: "Smooth",
    smooth_all: "Smooth all",
    custom: "Custom",
    motion_preview: "Motion preview",
```

- [ ] **Step 2: Add keys (zh-CN)**

Inside the `keyframe: { … }` object in `zh-CN.ts`, after `interp_ease_out`:

```ts
    interp_ease: "缓动",
    interp_ease_in_out: "缓入缓出",
    easing_title: "缓动",
    smooth: "平滑",
    smooth_all: "全部平滑",
    custom: "自定义",
    motion_preview: "动效预览",
```

- [ ] **Step 3: Verify tsc + commit**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n(keyframe): easing-editor strings (en-US + zh-CN)"
```

---

### Task 6: `keyframe/curve.ts` — preset table + handle↔coeff mapping (pure)

**Files:**
- Create: `apps/desktop/src/keyframe/curve.ts`
- Create: `apps/desktop/src/keyframe/curve.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/keyframe/curve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRESETS, interpToCoeffs, handleToCoeff, coeffToHandle } from "./curve";

describe("curve presets", () => {
  it("has the expected preset ids", () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      "linear", "ease", "ease_in", "ease_out", "ease_in_out", "hold",
    ]);
  });
});

describe("interpToCoeffs", () => {
  it("maps named eases to CSS cubics", () => {
    expect(interpToCoeffs({ kind: "EaseIn" })).toEqual([0.42, 0, 1, 1]);
    expect(interpToCoeffs({ kind: "EaseOut" })).toEqual([0, 0, 0.58, 1]);
    expect(interpToCoeffs({ kind: "Linear" })).toEqual([0, 0, 1, 1]);
  });
  it("passes Bezier through", () => {
    expect(interpToCoeffs({ kind: "Bezier", p1: [0.2, 0.3], p2: [0.7, 0.9] }))
      .toEqual([0.2, 0.3, 0.7, 0.9]);
  });
});

describe("handle↔coeff (unit square, y inverted, px box of size 100)", () => {
  it("clamps handle x into [0,1] but leaves y free", () => {
    // a handle dragged past the right edge clamps x=1; above the top → y>1
    expect(handleToCoeff(150, -20, 100)).toEqual([1, 1.2]);
    expect(handleToCoeff(-30, 50, 100)).toEqual([0, 0.5]);
  });
  it("round-trips through coeffToHandle", () => {
    const [hx, hy] = coeffToHandle(0.42, 0, 100);
    expect(handleToCoeff(hx, hy, 100)).toEqual([0.42, 0]);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/desktop && npx vitest run src/keyframe/curve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/keyframe/curve.ts`:

```ts
// Pure helpers for the easing editor: the named-preset table, interp→coeff
// mapping, and pixel-handle ↔ normalized-coefficient conversion for the curve
// canvas. The canvas is a `size`×`size` px box; x maps left→right [0,1]; y is
// inverted (top = 1, bottom = 0) and NOT clamped (overshoot allowed). Handle x
// IS clamped to [0,1] so the bezier X stays monotone (solver single-valued).
import type { Interpolation } from "../ipc";

export interface Preset {
  id: "linear" | "ease" | "ease_in" | "ease_out" | "ease_in_out" | "hold";
  labelKey: string;
  interp: Interpolation;
}

export const PRESETS: Preset[] = [
  { id: "linear", labelKey: "keyframe.interp_linear", interp: { kind: "Linear" } },
  { id: "ease", labelKey: "keyframe.interp_ease", interp: { kind: "Bezier", p1: [0.25, 0.1], p2: [0.25, 1] } },
  { id: "ease_in", labelKey: "keyframe.interp_ease_in", interp: { kind: "EaseIn" } },
  { id: "ease_out", labelKey: "keyframe.interp_ease_out", interp: { kind: "EaseOut" } },
  { id: "ease_in_out", labelKey: "keyframe.interp_ease_in_out", interp: { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] } },
  { id: "hold", labelKey: "keyframe.interp_hold", interp: { kind: "Hold" } },
];

export function interpToCoeffs(interp: Interpolation): [number, number, number, number] {
  switch (interp.kind) {
    case "Bezier":
      return [interp.p1[0], interp.p1[1], interp.p2[0], interp.p2[1]];
    case "EaseIn":
      return [0.42, 0, 1, 1];
    case "EaseOut":
      return [0, 0, 0.58, 1];
    default:
      return [0, 0, 1, 1]; // Linear / Hold → diagonal (Hold canvas is disabled)
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// px (origin top-left, y down) → normalized coeff (x∈[0,1] clamped, y free, up=+).
export function handleToCoeff(px: number, py: number, size: number): [number, number] {
  return [clamp01(px / size), 1 - py / size];
}

/// normalized coeff → px (origin top-left).
export function coeffToHandle(cx: number, cy: number, size: number): [number, number] {
  return [cx * size, (1 - cy) * size];
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/desktop && npx vitest run src/keyframe/curve.test.ts && npx tsc -b`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/keyframe/curve.ts apps/desktop/src/keyframe/curve.test.ts
git commit -m "feat(keyframe): curve.ts — preset table + handle/coeff mapping"
```

---

### Task 7: `EasingCanvas.tsx` — SVG curve + draggable handles

**Files:**
- Create: `apps/desktop/src/timeline/EasingCanvas.tsx`

No unit test (SVG + pointer drag — covered by tsc, the editor wiring, and e2e). Build the component, verify it type-checks.

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/timeline/EasingCanvas.tsx`:

```tsx
import { useRef } from "react";
import { unitBezier } from "../render/animated";
import { handleToCoeff, coeffToHandle } from "../keyframe/curve";

const SIZE = 160; // px unit square

/// Editable cubic-bezier curve. `coeffs` = [x1,y1,x2,y2]; emits new coeffs on
/// drag. Handle x is clamped to [0,1] (monotone time); y is free (overshoot).
export function EasingCanvas({
  coeffs,
  onChange,
  disabled,
}: {
  coeffs: [number, number, number, number];
  onChange: (next: [number, number, number, number]) => void;
  disabled?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [x1, y1, x2, y2] = coeffs;

  // Curve path: 40 sampled points through unitBezier (visualizes overshoot too).
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    const y = unitBezier(x1, y1, x2, y2, x);
    pts.push(`${x * SIZE},${(1 - y) * SIZE}`);
  }

  const [h1x, h1y] = coeffToHandle(x1, y1, SIZE);
  const [h2x, h2y] = coeffToHandle(x2, y2, SIZE);

  function dragHandle(which: 1 | 2, e: React.PointerEvent) {
    if (disabled) return;
    e.stopPropagation();
    const rect = svgRef.current!.getBoundingClientRect();
    const move = (me: PointerEvent) => {
      const [cx, cy] = handleToCoeff(me.clientX - rect.left, me.clientY - rect.top, SIZE);
      onChange(which === 1 ? [cx, cy, x2, y2] : [x1, y1, cx, cy]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={disabled ? "opacity-40" : ""}
      data-testid="easing-canvas"
    >
      <rect x="0" y="0" width={SIZE} height={SIZE} fill="var(--surface-2, #1b1b21)" stroke="var(--border-soft, #3a3a42)" />
      <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="var(--border-soft, #3a3a42)" strokeDasharray="3 3" opacity="0.4" />
      {!disabled && (
        <>
          <line x1="0" y1={SIZE} x2={h1x} y2={h1y} stroke="var(--ring, #6b6bff)" strokeWidth="1.5" />
          <line x1={SIZE} y1="0" x2={h2x} y2={h2y} stroke="var(--ring, #6b6bff)" strokeWidth="1.5" />
        </>
      )}
      <polyline points={pts.join(" ")} fill="none" stroke="var(--ring, #9a9aff)" strokeWidth="2" />
      {!disabled && (
        <>
          <circle cx={h1x} cy={h1y} r="6" fill="var(--ring, #6b6bff)" style={{ cursor: "grab" }}
            onPointerDown={(e) => dragHandle(1, e)} data-testid="easing-handle-1" />
          <circle cx={h2x} cy={h2y} r="6" fill="var(--ring, #6b6bff)" style={{ cursor: "grab" }}
            onPointerDown={(e) => dragHandle(2, e)} data-testid="easing-handle-2" />
        </>
      )}
    </svg>
  );
}
```

- [ ] **Step 2: Verify tsc**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/timeline/EasingCanvas.tsx
git commit -m "feat(timeline): EasingCanvas — draggable cubic-bezier curve"
```

---

### Task 8: `MotionPreview.tsx` — looping dot

**Files:**
- Create: `apps/desktop/src/timeline/MotionPreview.tsx`

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/timeline/MotionPreview.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { unitBezier } from "../render/animated";

const DUR_MS = 1200;

/// A dot that travels a mini track on a loop, eased by the current curve.
/// `coeffs` = [x1,y1,x2,y2]. Uses requestAnimationFrame; pure visual.
export function MotionPreview({ coeffs }: { coeffs: [number, number, number, number] }) {
  const dotRef = useRef<HTMLDivElement>(null);
  const coeffsRef = useRef(coeffs);
  coeffsRef.current = coeffs;

  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const u = ((ts - start) % DUR_MS) / DUR_MS;
      const [x1, y1, x2, y2] = coeffsRef.current;
      const eased = unitBezier(x1, y1, x2, y2, u);
      if (dotRef.current) dotRef.current.style.left = `${eased * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative h-2 rounded-full bg-surface-2" data-testid="motion-preview">
      <div
        ref={dotRef}
        className="absolute -top-1 size-4 -translate-x-1/2 rounded-full bg-accent"
        style={{ left: "0%" }}
      />
    </div>
  );
}
```

(If `bg-surface-2`/`bg-accent` tokens don't exist, substitute the project's neutral-surface and accent classes — grep an existing timeline component for the in-use token names.)

- [ ] **Step 2: Verify tsc + commit**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

```bash
git add apps/desktop/src/timeline/MotionPreview.tsx
git commit -m "feat(timeline): MotionPreview — eased looping dot"
```

---

### Task 9: `EasingEditor.tsx` — popover assembling chips + canvas + preview

**Files:**
- Create: `apps/desktop/src/timeline/EasingEditor.tsx`

Drop-in for `KeyframeInterpMenu` but takes the whole `track` + `kfId` + an `onCommit(track)` callback (Smooth needs to rewrite two keyframes, so the editor owns the track transform).

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/timeline/EasingEditor.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack, Interpolation } from "../ipc";
import { PRESETS, interpToCoeffs } from "../keyframe/curve";
import { setKeyframeInterp, smoothKeyframe } from "../keyframe/edits";
import { EasingCanvas } from "./EasingCanvas";
import { MotionPreview } from "./MotionPreview";

export function EasingEditor({
  x,
  y,
  track,
  kfId,
  onCommit,
  onClose,
}: {
  x: number;
  y: number;
  track: AnimTrack<number>;
  kfId: string;
  onCommit: (next: AnimTrack<number>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const current: Interpolation =
    track.mode === "Keyframed"
      ? (track.value.find((k) => k.id === kfId)?.interp ?? { kind: "Linear" })
      : { kind: "Linear" };
  const [coeffs, setCoeffs] = useState<[number, number, number, number]>(() => interpToCoeffs(current));
  const isHold = current.kind === "Hold";

  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
    }),
    [x, y],
  );

  const pickPreset = (interp: Interpolation) => {
    setCoeffs(interpToCoeffs(interp));
    onCommit(setKeyframeInterp(track, kfId, interp));
  };
  const onCurveChange = (next: [number, number, number, number]) => {
    setCoeffs(next);
    onCommit(setKeyframeInterp(track, kfId, { kind: "Bezier", p1: [next[0], next[1]], p2: [next[2], next[3]] }));
  };
  const doSmooth = () => onCommit(smoothKeyframe(track, kfId));

  return (
    <PopoverPrimitive.Root open modal={false} onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="z-50">
          <PopoverPrimitive.Popup className="menu-list p-3 w-[200px] flex flex-col gap-2">
            <div className="text-xs text-muted">{t("keyframe.easing_title")}</div>
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button key={p.id} className="text-[11px] px-2 py-1 rounded bg-surface-2 hover:bg-surface-3"
                  onClick={() => pickPreset(p.interp)}>
                  {t(p.labelKey)}
                </button>
              ))}
              <button className="text-[11px] px-2 py-1 rounded bg-surface-2 hover:bg-surface-3"
                onClick={doSmooth} data-testid="easing-smooth">
                {t("keyframe.smooth")}
              </button>
            </div>
            <EasingCanvas coeffs={coeffs} onChange={onCurveChange} disabled={isHold} />
            <div className="font-mono text-[10px] text-muted">
              cubic-bezier({coeffs.map((c) => c.toFixed(2)).join(", ")})
            </div>
            <MotionPreview coeffs={coeffs} />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
```

(Match the actual Base-UI import path + className tokens used elsewhere — `KeyframeInterpMenu.tsx` imports `Menu` from `@base-ui/react/menu` and uses `menu-list`/`menu-item`; confirm the `Popover` export path against another popover in the codebase, or reuse the `Menu` primitive with a custom popup if no `Popover` is in use. Substitute `bg-surface-2/3`, `text-muted` with the project's in-use tokens — grep a sibling timeline component.)

- [ ] **Step 2: Verify tsc**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean (fix import paths / token names until it is).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/timeline/EasingEditor.tsx
git commit -m "feat(timeline): EasingEditor popover — chips + curve + motion preview"
```

---

### Task 10: Rewire call sites; delete `KeyframeInterpMenu`

**Files:**
- Modify: `apps/desktop/src/timeline/LayerBlock.tsx:551-563` (+ import line 19)
- Modify: `apps/desktop/src/timeline/KeyframeLane.tsx:139-156` (+ import line 15)
- Delete: `apps/desktop/src/timeline/KeyframeInterpMenu.tsx`

- [ ] **Step 1: Rewire `LayerBlock.tsx`**

Replace the import (line 19) `import { KeyframeInterpMenu } from "./KeyframeInterpMenu";` with `import { EasingEditor } from "./EasingEditor";`. Replace the `{interpMenu && focusedParam && ( <KeyframeInterpMenu … /> )}` block (lines 551-563) with:

```tsx
      {interpMenu && focusedParam && (() => {
        const track = readParamTrack(layer.params, focusedParam);
        if (!track || track.mode !== "Keyframed") return null;
        return (
          <EasingEditor
            x={interpMenu.x}
            y={interpMenu.y}
            track={track}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onCommit={(next) => onCommitParamTrack(layer.id, focusedParam, next)}
          />
        );
      })()}
```

- [ ] **Step 2: Rewire `KeyframeLane.tsx`**

Replace the import (line 15) with `import { EasingEditor } from "./EasingEditor";`. Replace the `{interpMenu && ( <KeyframeInterpMenu … /> )}` block (lines 139-156) with:

```tsx
      {interpMenu && (() => {
        const layer = track.layers.find((l) => l.id === interpMenu.layerId);
        if (!layer) return null;
        const trk = readParamTrack(layer.params, interpMenu.paramKey);
        if (!trk || trk.mode !== "Keyframed") return null;
        return (
          <EasingEditor
            x={interpMenu.x}
            y={interpMenu.y}
            track={trk}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onCommit={(next) => onCommitParamTrack(interpMenu.layerId, interpMenu.paramKey, next)}
          />
        );
      })()}
```

Remove the now-unused `setKeyframeInterp` import in both files if it is no longer referenced (the editor owns the transform). Leave `readParamTrack`/`onCommitParamTrack` as-is.

- [ ] **Step 3: Delete the old menu**

```bash
git rm apps/desktop/src/timeline/KeyframeInterpMenu.tsx
```

- [ ] **Step 4: Verify tsc + vitest + cargo**

Run: `cd apps/desktop && npx tsc -b && npx vitest run`
Run: `cd apps/desktop/src-tauri && cargo test --lib`
Expected: tsc clean; vitest all green; cargo green. (Grep `KeyframeInterpMenu` repo-wide → only docs hits remain.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeline/LayerBlock.tsx apps/desktop/src/timeline/KeyframeLane.tsx
git commit -m "feat(timeline): open EasingEditor from keyframe diamonds; drop KeyframeInterpMenu"
```

---

## Phase D — Docs + e2e

### Task 11: Docs

**Files:**
- Modify: `docs/data-model.md` (the `Interpolation` / keyframe section)
- Modify: `docs/render.md` (the engine-pair resolve section, ~lines 86-87)

Evergreen tone — no dates / phase numbers / commit hashes (per `feedback_evergreen_docs`).

- [ ] **Step 1: Update `docs/data-model.md`**

Find the `Interpolation` description and ensure it reads:

```markdown
`Interpolation` is per-segment, stored on the segment's left keyframe
(`kf[i].interp` governs `kf[i] → kf[i+1]`): `Hold` (left-stick step), `Linear`,
`EaseIn`/`EaseOut` (the CSS cubics `cubic-bezier(.42,0,1,1)` / `(0,0,.58,1)`),
and `Bezier{p1,p2}` — an arbitrary `cubic-bezier(x1,y1,x2,y2)` timing function.
There are no per-keyframe in/out handles; velocity continuity through a keyframe
is produced by the authoring-side Smooth command, which bakes matching tangents
into the two adjacent segments.
```

- [ ] **Step 2: Update `docs/render.md`**

Where it describes `resolveAnimated` ≡ `value_at`, append that both resolve `EaseIn`/`EaseOut`/`Bezier` through an identical WebKit-`UnitBezier` cubic solver, locked by `animatedGolden.fixture.json`.

- [ ] **Step 3: Commit**

```bash
git add docs/data-model.md docs/render.md
git commit -m "docs: cubic-bezier interpolation semantics + engine-pair solver"
```

---

### Task 12: e2e — custom Bézier reaches export

**Files:**
- Modify: `apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js`

Prereqs (per `weftcut-media-conformance-harness` / `feedback_wdio_spec_filter_windows`): close any running `weftcut.exe` first; `msedgedriver` must match the WebView2 runtime; run a single spec via `node node_modules\@wdio\cli\bin\wdio.js run <conf> --spec <file>` and confirm "Execution of 1 workers".

- [ ] **Step 1: Read the existing spec**

Open `apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js`. It already: creates a project, adds a layer, lights a stopwatch, writes a 0→1 opacity track, exports, and self-SSIMs frame 3 vs 87. Reuse its helpers (`newProject`, `driveExport`, the webview JS injection pattern).

- [ ] **Step 2: Add a custom-bezier assertion**

After the existing opacity-track authoring, before export, inject an extreme custom Bézier on the track's first keyframe and assert the eased value differs from linear at an interior frame. Append a step that, via the MCP/webview bridge the spec already uses, sets the first keyframe's interp to `{kind:"Bezier", p1:[0.9,0], p2:[1,0.1]}` (a steep late-rise) on the opacity track, exports, and asserts a sampled mid-clip frame's luma is closer to the start value than a linear interpolation would give (i.e., the curve held low then rose). Model the assertion on the existing self-SSIM frame sampling — pick two frames where linear vs this bezier diverge most (early-mid) and assert their SSIM-to-start ordering.

```js
// after authoring the 0→1 opacity track, before export:
await setFirstKeyframeBezier(/* opacity track */ { p1: [0.9, 0], p2: [1, 0.1] });
// export, then: a frame at ~25% of the clip should still be near the START
// frame (curve holds low), unlike linear which would be ~25% blended.
const early = await ssim(frameAt(0.25), startFrame);
const linearEarly = 0.75; // linear would be ~25% toward end → ~0.75 sim-to-start
expect(early).toBeGreaterThan(linearEarly); // bezier held low → closer to start
```

(Implement `setFirstKeyframeBezier` with the spec's existing track-write bridge — it already composes an `AnimTrack` and calls `updateLayerParamTrack`; just set the first key's `interp`. Reuse the spec's frame-extraction + SSIM helpers; do not introduce new ones.)

- [ ] **Step 3: Run the spec**

Run (PowerShell, from `apps/desktop/e2e`, after killing weftcut.exe):
`node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.js --spec specs/ui/keyframe_authoring.e2e.js`
Expected: "Execution of 1 workers" → spec PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/specs/ui/keyframe_authoring.e2e.js
git commit -m "test(e2e): custom cubic-bezier easing reaches exported frames"
```

---

## Final verification

- [ ] `cd apps/desktop && npx tsc -b` — clean
- [ ] `cd apps/desktop && npx vitest run` — all green (incl. unitBezier, curve, edits, golden)
- [ ] `cd apps/desktop/src-tauri && cargo test --lib` — all green (incl. `unit_bezier_*`, `golden_vectors_match_fixture`, the two new ease tests)
- [ ] Diff `unit_bezier` (Rust) vs `unitBezier` (TS) by eye — identical structure (engine-pair rule)
- [ ] e2e keyframe spec PASS in real WebView2
- [ ] Manual real-app pass: right-click a keyframe diamond → editor opens → preset chips switch the curve → drag a handle → motion preview animates → Smooth rounds a peak without overshoot → exported video reflects the curve

---

## Self-Review Notes (filled by plan author)

- **Spec coverage:** §1 data model → Task 3 (EaseIn/EaseOut redefine, no schema change). §2 engine/solver/golden → Tasks 1–3. §3 Smooth → Task 4. §4 editor (chips+canvas+preview, replaces KeyframeInterpMenu) → Tasks 5–10. §5 determinism/export → Task 3 (shared resolve) + final verify. §6 migration/docs/testing → Tasks 11–12 + each task's tests. Out-of-scope items (model A, Rgba, rotation row, MCP) → not in any task, by design.
- **Smooth in Rust?** Spec left this to the plan: TS-only (Task 4). Rationale: Smooth only *produces* `Bezier` data, which both engines already resolve identically after Task 3 — no third math mirror needed.
- **Type consistency:** `unitBezier`/`unit_bezier` (x1,y1,x2,y2,x)→y both sides; `smoothKeyframe(track,id)` / `smoothTrack(track)`; `interpToCoeffs`/`handleToCoeff`/`coeffToHandle` (curve.ts) consistent across Tasks 6/7/8/9; `EasingEditor` prop shape (`x,y,track,kfId,onCommit,onClose`) matches both call-site rewires in Task 10.
- **Known soft spots for the implementer:** Base-UI `Popover` import path + Tailwind token names in Tasks 8–9 (grep a sibling); the e2e bridge helper names in Task 12 (reuse what the spec already has).
