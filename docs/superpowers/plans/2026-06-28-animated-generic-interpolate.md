# Cashing the `Animated<T>` generic — `Interpolate` trait + `Animated<Rgba>`

> Resolved design from a grilling session. Supersedes backlog item **P1** in
> [`2026-06-22-keyframe-system-optimization.md`](./2026-06-22-keyframe-system-optimization.md)
> (rewrite that bullet to point here; see §8). Scope this round is **engine
> only** — no authoring UI, no MCP. Delete this file once executed and fold the
> residue into [`../../roadmap.md`](../../roadmap.md) (git is the archive).

## The problem (one sentence)

`Animated<T>` is generic, but the engine only evaluates `T = f64`; `Animated<Rgba>`
serializes and type-checks yet has **no `value_at`** (color "keyframes" collapse to
the first key via `trackStatic`). This is the one place the abstraction is
genuinely *wrong* (leaky generic), and it gates color keyframing + non-scalar
effect params.

## Resolved decisions

1. **Cash `Rgba` now; design Vec2-friendly.** `Vec2` is confirmed coming, so the
   abstraction must accommodate it — but only as far as a two-endpoint lerp (#2).
2. **`Interpolate` is a minimal two-endpoint contract.** `lerp(a, b, u)` where `u`
   is *already* remapped by the segment's `Interpolation`. **Spatial motion paths
   (curved 2D position) are NOT this trait** — they need the whole keyframe
   sequence + per-key spatial tangents, a separate eval layer (`eval_path`) above
   `Interpolate`, built in P5. Easing stays orthogonal to the value type.
3. **Generic `eval<T: Interpolate>`; keep `Animated<T>` generic + type-safe.**
   Rejected: a closed `ParamValue` enum (loses `Animated<f64>` vs `Animated<Rgba>`
   compile-time safety) and hand-copied per-type evaluators (the segment-search +
   Newton-Raphson bezier is the highest-drift-risk code to duplicate — exactly
   what `weftcut-eval` exists to kill).
4. **wasm ABI = per-type minimal shim, packed return.** `Rgba` gets a resident
   color buffer + `eval_rgba_packed(t) -> i32` (**RGBA8 packed into one i32** —
   stays within the "scalars only" ABI, no BigInt, no memory-read). `Vec2` **rides
   the existing scalar `eval`** as component tracks (its lerp is component-wise, so
   this is correct and free). Accept a wasm-side asymmetry (native is uniform over
   the trait; wasm special-cases color) — the golden fixture is the arbiter.
   Rejected: generalizing the ABI to vectors (C) — its only motivation was
   multi-return, which packed-i32 dissolves; it would add hot-path memory-read
   coupling for a generality nothing on the roadmap consumes (P5's `eval_path` is a
   different signature regardless).
5. **Interpolate color in OkLab.** Lerping sRGB u8 is the gamma-blending bug
   (muddy mid-tones); linear light fixes brightness but complementary hues still
   dip through grey (blue→yellow → grey). OkLab fixes both (CSS Color 4 default).
   This is a *transient* eval computation — storage stays sRGB u8, **ADR 0021 is
   untouched**.
6. **Premultiplied alpha + alpha straight-linear.** Premultiply L/a/b by alpha,
   lerp, lerp alpha straight, un-premultiply (CSS Color 4 §12.3). Prevents the
   transparent-endpoint black halo, matches the Chromium/Pixi platform. Moot when
   a key pair's alpha is constant (the common case; layer `opacity` is a separate
   track).
7. **Engine only.** `value_at` + wasm + golden. Color stopwatch (authoring UI) and
   MCP keyframe-color tools are deferred (UI in flux).
8. **Fold, don't duplicate.** `eval_f64` becomes `eval::<f64>` (or a thin wrapper);
   one algorithm, `T` parameterized. **Acceptance = the existing golden fixture
   passes byte-for-byte unchanged** (that fixture is the safety net that makes
   touching the locked engine low-risk). Keep the wasm scalar exports
   (`eval`/`set_kf`/…) and `eval_f64`'s public signature stable (audio envelope
   sampler calls `eval_kfs` + `eval_f64` directly).
9. **No schema change this round.** Spatial tangents are a *documented design
   commitment + migration plan* owned by P5, NOT a physical field now. Reasons:
   they're meaningless on the generic `Keyframe<T>` (would pollute scalar/color
   keys with a perpetual `None`); we're pre-release (schema breaks freely, zero
   migration cost today); `Keyframe<Vec2>` is its own monomorphization, so P5
   attaches them cleanly without ever touching scalar/color keys. Record in
   `data-model.md`: *"position → `Animated<Vec2>` + per-key spatial tangents is the
   P5 shape; if the keyframe format is frozen (shipped) before P5, P5 owns the
   migration."*
10. **golden-leads TDD; OkLab values from an external authority.** The fixture has
    two jobs — cross-language drift (native↔wasm, byte-identical) AND correctness
    (the values are *right*). For OkLab a wrong matrix/exponent yields
    plausible-but-wrong color that the eye won't catch, so a small set of anchored
    cases takes expected values from **CSS `color-mix(in oklab, …)`** (a real
    browser; the same authority we cite for the design) — never solely from
    dumping our own implementation's output (that焊死s our bugs into the contract).

## Concrete shapes

### Trait + generic eval (`native/eval/src/lib.rs`)

```rust
/// Two-endpoint blend at eased progress `u` ∈ [0,1]. `u` is ALREADY remapped by
/// the segment's `Interpolation`, so easing is orthogonal to the value type.
/// Spatial motion paths are NOT this trait (see plan §2 / P5).
pub trait Interpolate: Copy {
    fn lerp(a: Self, b: Self, u: f64) -> Self;
}

impl Interpolate for f64 {
    #[inline]
    fn lerp(a: f64, b: f64, u: f64) -> f64 { a + (b - a) * u }
}

// `Kf` becomes generic over the value type.
#[derive(Clone, Copy, Debug)]
pub struct Kf<T> { pub t_us: i64, pub value: T, pub interp: Interpolation }

/// Segment-search / clamp / Hold-takes-left are identical to today; the ONLY
/// T-specific op is `T::lerp` at the tail.
pub fn eval<T: Interpolate>(kfs: &[Kf<T>], t_us: i64, default: T) -> T { /* … */ }

/// Thin wrapper — existing callers (audio envelope) keep this signature.
pub fn eval_f64(kfs: &[Kf<f64>], t_us: i64, default: f64) -> f64 { eval(kfs, t_us, default) }
```

### Color lerp (`Rgba: Interpolate`)

Lives wherever `Rgba` can be reached from the leaf math (move the primitive into
`weftcut-eval`, or impl the trait in the napi crate over the leaf's helpers).
Body: sRGB u8 → linear (`libm::pow`) → OkLab (matrix + `libm::cbrt`) → premultiply
L/a/b by alpha → lerp + straight-lerp alpha → un-premultiply (divide by lerped
alpha, guard 0) → OkLab → linear → sRGB u8. Convert **only the two bracketing
keys, per eval** (native stores `Rgba`, wasm stores packed `u32` — both do the
identical work, the bit-identity requirement).

### wasm ABI additions (`native/eval/src/wasm.rs`)

```rust
// Parallel resident color buffer (the scalar T/V/IT/N stay as-is).
static mut TC: [i64; MAXKF]; static mut VC: [u32; MAXKF];   // VC = packed RGBA8
static mut ITC: [Interpolation; MAXKF]; static mut NC: usize;

set_n_rgba(n: i32);
set_kf_rgba(i, t_us: f64, packed_rgba: i32, interp, p1x..p2y);   // value = 1 i32
eval_rgba_packed(t_us: f64, default_packed: i32) -> i32;          // returns 1 i32
```

Update the `wasm.rs` header's "SCALARS ONLY" note with the packed-color carve-out.

### Renderer (`src/renderer/render/animated.ts`, `resolveView.ts`)

`resolveAnimatedColor(track, tUs, default) -> Rgba` (pack each key → u32 via
`loadColorTrack`, call `evalRgbaPacked`, unpack). In `resolveView.ts` switch
`resolveTextView.color` and `resolveColorView.color` from `trackStatic(…)` to
`resolveAnimatedColor(…)`.

## Execution order (each step red→green before the next)

1. **Fold, no behavior change.** Introduce `Interpolate` + generic `eval<T>`,
   make `eval_f64` a wrapper, genericize `Kf`. Gate: existing scalar golden
   fixture green, byte-unchanged.
2. **native `Rgba: Interpolate`** (OkLab + premult; `libm` not `std`). Add
   `Animated<Rgba>::value_at`.
3. **Extend the golden fixture** with color samples — 3–5 externally-anchored
   cases (red→green brightness, blue→yellow no-grey-dip, transparent fade no-halo,
   grey self-interp) from CSS `color-mix(in oklab)`; plus type-agnostic edge cases
   (clamp / Hold-left / single-key) self-produced.
4. **wasm shim** (`set_kf_rgba` / `eval_rgba_packed`); fixture asserted from the
   wasm side too (native↔wasm byte-identical).
5. **Renderer** `resolveAnimatedColor` + wire `resolveView` color paths.

## Determinism landmines (PROTECTED — do not "simplify" away)

- **`libm::cbrt` / `libm::pow`, never `f64::cbrt`/`powf`.** std is unavailable in
  the no_std wasm build AND would break native↔wasm bit-identity. Same discipline
  as `db_to_linear` / `pan_coeffs`.
- **Convert color per-eval on the two bracketing keys**, identically on both
  sides — do not pre-convert on one side and per-eval on the other (rounding
  diverges, golden goes red).
- **Premultiply matches CSS §12.3** — when sampling `color-mix(in oklab)` for
  golden values, confirm the browser is using *premultiplied* interpolation, not
  the un-premultiplied variant.
- **Golden values are externally anchored**, never solely a dump of our own
  output (correctness job, not just the drift job).

## Out of scope (this round)

- Color stopwatch / authoring UI, MCP keyframe-color tools (#7).
- `Vec2` *value* eval beyond riding the scalar path; spatial motion paths,
  `eval_path`, per-key spatial tangents, the viewport path editor (P5).
- Any schema change (#9).
- `Animated<Rgba>` for effect params beyond what `resolveView` already surfaces.

## What changes in the backlog

Rewrite P1 in `2026-06-22-keyframe-system-optimization.md` to a one-liner pointing
here: *"P1 — Make the generic real: see
[`2026-06-28-animated-generic-interpolate.md`](./2026-06-28-animated-generic-interpolate.md).
Resolved: `Interpolate` trait, OkLab + premultiplied color, packed-i32 wasm ABI,
fold the scalar engine, engine-only."* Leave P2–P5 + Minor untouched.
