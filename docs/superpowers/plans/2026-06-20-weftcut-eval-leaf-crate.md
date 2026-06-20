# weftcut-eval Leaf Crate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the cross-language "WYSIWYG math" twins (frame snap, keyframe eval, audio envelope, role gate) into one dependency-light Rust crate `weftcut-eval`, compiled both natively (for the actor + export) and to wasm32 (for the renderer) — so there is ONE source of truth instead of hand-mirrored Rust+TS copies.

**Architecture:** A new leaf crate holds the pure math as primitive-typed functions (no `imbl`/`uuid`/`napi`/`tokio`). The existing `weftcut` napi crate depends on it via a path dependency and delegates (re-exports) to it — behavior byte-identical. A `#[cfg(target_arch = "wasm32")]` shim layer exports a resident-ABI surface; a build script compiles it to wasm32, base64-embeds the bytes into a generated TS module, and the renderer loads it once at startup and calls it in place of the deleted TS twins. The four cross-language goldens added on 2026-06-20 are the safety net during migration, then convert to single-source regression + wasm-smoke tests.

**Tech Stack:** Rust (rustc 1.95, `wasm32-unknown-unknown` target — already installed), napi-rs, Node v22.20.0 (managed by fnm — do NOT bump), Vitest, raw `WebAssembly` (no wasm-bindgen, no wasm-pack).

## Global Constraints

- **Determinism is the whole point.** Every step is behavior-preserving until the renderer-swap phase, and even then byte-identical. The four goldens (`snapFrameGolden.fixture.json`, `animatedGolden.fixture.json`, `audioEnvelopeGolden.fixture.json`, `roleGateGolden.fixture.json`) MUST stay green at every commit. Never edit a fixture's expected values in this project.
- **Resident ABI only.** Keyframes/track data cross into wasm once (on change), cached by version; per-call you pass ONLY scalars and read a scalar/small packed result. Never marshal a keyframe array per eval call (measured: doubles cost).
- **No i64 across the wasm boundary.** Use `f64` for µs (safe < 2^53) and `i32` for fps num/den, to avoid BigInt marshaling. Internally Rust may use i64/i128.
- **Leaf crate dependency budget:** allowed: `core`/`std`, and `serde` *behind a `serde` feature only*. FORBIDDEN in the leaf: `imbl`, `uuid`, `napi`, `tokio`, `ts-rs`, `schemars`. The wasm build enables NO default features.
- **Gains are `f32`** (`db_to_linear(db: f64) -> f32`) to match `Envelope::scale(f32)`. Do not widen to f64.
- **Crate name / paths:** crate `weftcut-eval` at `apps/desktop/native/eval/`. The napi crate stays `weftcut` at `apps/desktop/native/`.
- **Parallel git sessions:** the user edits this checkout from other sessions. Stage by EXPLICIT path only, re-run `git status` before every commit, never `git add -A`.
- **Commits:** commit after each task. End every commit message body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Verification commands (memorize):**
  - Rust default features: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib -- state::time state::animated`
  - Rust audio (needs feature): `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib --features export -- audio::mix audio::envelope`
  - Leaf crate: `cargo test -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml`
  - TS goldens: `cd apps/desktop && npx vitest run src/renderer/frames.golden.test.ts src/renderer/render/animated.golden.test.ts src/renderer/render/audio/envelope.golden.test.ts src/renderer/render/audio/roleGate.golden.test.ts`
  - wasm build: `cargo build -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml --target wasm32-unknown-unknown --release`
  - napi build sanity (after workspace change): `cd apps/desktop && npm run build:native` (or the project's existing native-build script — confirm the exact name in `apps/desktop/package.json` before running)

## Background: why these four (context for the implementer)

Each function's result drives behavior on BOTH sides of the renderer↔Rust process boundary, which is why they're duplicated today:
- **snap** (`snap_frame_round`): Rust actor snaps every timeline mutation to the frame grid (storage invariant, `state/actor/mutations.rs`); the renderer snaps drag-ghost/seek/playhead (`useLayerDrag.ts`, `clock.ts`, `Timeline.tsx`, keyframe widgets).
- **keyframe eval** (`value_at`/`resolveAnimated` + `unit_bezier`): the renderer composites every animated layer's x/y/scale/opacity per frame for BOTH preview and export (`render/resolveView.ts`, `render/Compositor.ts`); Rust uses it for export AUDIO (keyframed gain/pan, `audio/envelope.rs`).
- **envelope** (`db_to_linear`/`sample_gain`/`pan`): Rust export mixer (`audio/mix.rs`); renderer audio preview (`render/audio/envelope.ts`).
- **role gate** (`any_role_solo`/`role_audible`/`role_gain_linear`): Rust export mix selection + readiness (`audio/mix.rs`); renderer audio-preview gating (`render/Compositor.ts`).

## File Structure

**New (leaf crate):**
- `apps/desktop/native/eval/Cargo.toml` — leaf crate manifest, `serde` feature, `cdylib`+`rlib`.
- `apps/desktop/native/eval/src/lib.rs` — pure math: `Rational`, `snap_*`, `Interpolation`, `Kf`, `unit_bezier`, `eval_f64`, `db_to_linear`, `any_role_solo`/`role_audible`/`role_gain_linear`.
- `apps/desktop/native/eval/src/wasm.rs` — `#[cfg(target_arch="wasm32")]` resident-ABI `extern "C"` exports.

**Modified (native delegation):**
- `apps/desktop/native/Cargo.toml` — add `[workspace]` + `weftcut-eval` path dep.
- `apps/desktop/native/src/state/time.rs` — re-export snap from leaf; move snap golden test to leaf.
- `apps/desktop/native/src/state/animated.rs` — re-export `Interpolation`/`unit_bezier`; `value_at` delegates to `eval_f64`.
- `apps/desktop/native/src/audio/envelope.rs` — re-export `db_to_linear`; `sample_gain`/`sample_pan` collect keyframes once then call `eval_f64`.
- `apps/desktop/native/src/audio/mix.rs` — role helpers delegate to leaf primitives.

**New (renderer wasm integration):**
- `apps/desktop/scripts/build-eval-wasm.mjs` — build wasm + base64-embed into a generated TS module.
- `apps/desktop/src/renderer/eval/evalWasm.generated.ts` — GENERATED (gitignored) base64 of the wasm bytes.
- `apps/desktop/src/renderer/eval/index.ts` — async `initEval()` + typed wrappers.
- `apps/desktop/package.json` — `build:wasm` script + `prebuild`/`predev` wiring + `.gitignore` entry.

**Modified (renderer swap — delete TS twins, call wasm):**
- `apps/desktop/src/renderer/frames.ts`, `render/animated.ts`, `render/audio/envelope.ts`, `render/audio/roleGate.ts` — bodies replaced by wasm calls (eventually deleted where possible).
- the renderer bootstrap (entry that mounts the app) — `await initEval()` before first composite.

**Modified (final docs):**
- `docs/adr/` — new ADR recording the single-source-via-wasm decision.
- `docs/architecture.md` — note the leaf crate.

---

## Task 1: Create the `weftcut-eval` leaf crate + workspace wiring

**Files:**
- Create: `apps/desktop/native/eval/Cargo.toml`
- Create: `apps/desktop/native/eval/src/lib.rs`
- Modify: `apps/desktop/native/Cargo.toml` (add `[workspace]` and the path dep)

**Interfaces:**
- Produces: crate `weftcut-eval` with feature `serde` (off by default). Empty for now except a smoke const. `weftcut` depends on it via `weftcut-eval = { path = "eval" }`.

- [ ] **Step 1: Create the leaf manifest**

`apps/desktop/native/eval/Cargo.toml`:
```toml
[package]
name = "weftcut-eval"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[features]
default = []
serde = ["dep:serde"]

[dependencies]
serde = { version = "1", features = ["derive"], optional = true }
```

- [ ] **Step 2: Create a placeholder lib so it compiles**

`apps/desktop/native/eval/src/lib.rs`:
```rust
//! weftcut-eval: the pure, dependency-light "WYSIWYG math" shared by the
//! actor + export (native build) and the renderer (wasm32 build). No imbl /
//! uuid / napi / tokio. See docs/superpowers/plans/2026-06-20-weftcut-eval-leaf-crate.md
#![no_std]

#[cfg(test)]
extern crate std;

/// Temporary smoke symbol; removed once real functions land.
pub const CRATE_OK: bool = true;
```

- [ ] **Step 3: Wire the workspace + path dep into the napi crate**

In `apps/desktop/native/Cargo.toml`, add a `[workspace]` table (a manifest may be both a package and a workspace root) above `[dependencies]`, and add the path dep inside `[dependencies]`:
```toml
[workspace]
members = ["eval"]

# ... existing [package], [lib], [build-dependencies] stay ...

[dependencies]
weftcut-eval = { path = "eval" }
# ... existing deps stay ...
```

- [ ] **Step 4: Verify both crates build**

Run: `cargo build --manifest-path apps/desktop/native/Cargo.toml --lib`
Expected: compiles (warnings ok). Then run: `cargo build -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml --target wasm32-unknown-unknown --release`
Expected: produces `apps/desktop/native/target/wasm32-unknown-unknown/release/weftcut_eval.wasm`.

- [ ] **Step 5: Confirm the napi build still works (workspace can break it)**

Open `apps/desktop/package.json`, find the native build script (look for `napi build`). Run it (e.g. `cd apps/desktop && npm run build:native`).
Expected: `@weftcut/core` builds as before. If it fails referencing the workspace, ensure the napi crate is the workspace ROOT (the `[workspace]` lives in `apps/desktop/native/Cargo.toml`, not a new repo-root file).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/eval/Cargo.toml apps/desktop/native/eval/src/lib.rs apps/desktop/native/Cargo.toml
git commit -F - <<'EOF'
build(eval): scaffold weftcut-eval leaf crate + workspace

Empty dependency-light crate (no imbl/uuid/napi), wired as a path dep of the
napi crate and buildable for wasm32. Functions move in over the next tasks.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Move frame snap into the leaf (native delegation)

**Files:**
- Modify: `apps/desktop/native/eval/src/lib.rs` (add `Rational`, snap fns + snap golden test)
- Modify: `apps/desktop/native/src/state/time.rs` (re-export from leaf, drop the moved bodies + the snap golden test)
- Modify: `apps/desktop/native/src/state/mod.rs` (its `pub use time::{... snap_frame_ceil, snap_frame_floor}` must keep resolving)

**Interfaces:**
- Produces: `weftcut_eval::{Rational, snap_frame_round, snap_frame_floor, snap_frame_ceil}` with identical signatures (`fn(t_us: i64, fps: Rational) -> i64`, `Rational::new(num: u32, den: u32)`, `Rational::FPS_*`).
- Consumes: `state/actor/mutations.rs` calls `crate::state::time::snap_frame_round(...)` — must keep working via re-export.

- [ ] **Step 1: Add snap to the leaf**

Append to `apps/desktop/native/eval/src/lib.rs` the `Rational` struct and the three snap fns. Copy the CURRENT bodies verbatim from `apps/desktop/native/src/state/time.rs` (lines for `Rational`, `snap_frame_floor`, `snap_frame_ceil`, `snap_frame_round`, and the `US_PER_SEC`/`US_PER_MS` consts). Gate the serde derive on `Rational`:
```rust
pub const US_PER_SEC: i64 = 1_000_000;
pub const US_PER_MS: i64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Rational { pub num: u32, pub den: u32 }
// ... Rational::new / as_f64 / FPS_* consts verbatim ...
// ... snap_frame_floor / snap_frame_ceil / snap_frame_round verbatim ...
```
(Note: the leaf is `#![no_std]`; snap uses only integer ops + `i128`, no std needed. `as_f64` uses `as f64` only.)

- [ ] **Step 2: Move the snap golden test into the leaf**

Cut `golden_vectors_match_fixture` (the snap one) from `time.rs`'s test module into a `#[cfg(test)] mod tests` in `eval/src/lib.rs`. The `include_str!` path is unchanged (`"../../../src/renderer/snapFrameGolden.fixture.json"` resolves the same from `eval/src/lib.rs`). Also move the existing `snap_*` unit tests from time.rs into the leaf (they test leaf functions now).

- [ ] **Step 3: Replace time.rs bodies with re-exports**

In `apps/desktop/native/src/state/time.rs`, delete the moved items and re-export:
```rust
pub use weftcut_eval::{Rational, US_PER_MS, US_PER_SEC, snap_frame_ceil, snap_frame_floor, snap_frame_round};
pub type TimeUs = i64;
```
Keep `TimeUs` here (it's a local alias). Leave any time-only helpers that did NOT move. Ensure `state/mod.rs`'s `pub use time::{...}` still names exist (they now come through the re-export).

- [ ] **Step 4: Run leaf + native snap tests**

Run: `cargo test -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml`
Expected: PASS (incl. `golden_vectors_match_fixture`).
Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib -- state::actor`
Expected: PASS (mutations still snap correctly through the re-export).

- [ ] **Step 5: Run the TS snap golden (must still be green — unchanged)**

Run: `cd apps/desktop && npx vitest run src/renderer/frames.golden.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/eval/src/lib.rs apps/desktop/native/src/state/time.rs apps/desktop/native/src/state/mod.rs
git commit -F - <<'EOF'
refactor(eval): move frame snap into weftcut-eval

snap_frame_round/floor/ceil + Rational now live in the leaf; time.rs
re-exports. Behavior identical (snap golden + actor tests green).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Move keyframe eval into the leaf (slice ABI)

**Files:**
- Modify: `apps/desktop/native/eval/src/lib.rs` (add `Interpolation`, `Kf`, `unit_bezier`, `eval_f64`)
- Modify: `apps/desktop/native/src/state/animated.rs` (re-export `Interpolation`/`unit_bezier`; `value_at` + new `eval_kfs` delegate to leaf)

**Interfaces:**
- Produces:
  - `weftcut_eval::Interpolation` (enum: `Hold`, `Linear`, `EaseIn`, `EaseOut`, `Bezier { p1: (f64,f64), p2: (f64,f64) }`, `Default = Linear`).
  - `weftcut_eval::Kf { pub t_us: i64, pub value: f64, pub interp: Interpolation }`.
  - `weftcut_eval::unit_bezier(x1,y1,x2,y2,x: f64) -> f64`.
  - `weftcut_eval::eval_f64(kfs: &[Kf], t_us: i64, default: f64) -> f64`.
- Consumes: `state/animated.rs::Keyframe<T>` keeps its `id: KeyframeId` + `interp: Interpolation` (now the leaf's). `Animated<f64>::value_at` delegates.

- [ ] **Step 1: Add `Interpolation`, `Kf`, `unit_bezier`, `eval_f64` to the leaf**

Append to `eval/src/lib.rs`. Copy `unit_bezier` verbatim from `animated.rs` (it's pure f64, no std — but it uses `.abs()`; in `no_std` use a manual abs helper):
```rust
#[derive(Clone, Copy, Debug, PartialEq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "kind"))]
pub enum Interpolation {
    Hold,
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    Bezier { p1: (f64, f64), p2: (f64, f64) },
}

#[derive(Clone, Copy, Debug)]
pub struct Kf { pub t_us: i64, pub value: f64, pub interp: Interpolation }

#[inline]
fn fabs(x: f64) -> f64 { if x < 0.0 { -x } else { x } }

// unit_bezier: copy the body from animated.rs but replace every `.abs()`
// with `fabs(...)`. Logic otherwise identical (WebKit UnitBezier).
pub fn unit_bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 { /* ...verbatim with fabs... */ }

/// Slice form of `Animated<f64>::value_at`. Empty slice ⇒ `default`.
pub fn eval_f64(kfs: &[Kf], t_us: i64, default: f64) -> f64 {
    if kfs.is_empty() { return default; }
    if kfs.len() == 1 { return kfs[0].value; }
    let first = &kfs[0];
    let last = &kfs[kfs.len() - 1];
    if t_us <= first.t_us { return first.value; }
    if t_us >= last.t_us { return last.value; }
    let mut i = 0;
    while i < kfs.len() - 1 && kfs[i + 1].t_us <= t_us { i += 1; }
    let a = &kfs[i];
    let b = &kfs[i + 1];
    let span = (b.t_us - a.t_us) as f64;
    if span <= 0.0 { return b.value; }
    let mut u = (t_us - a.t_us) as f64 / span;
    match a.interp {
        Interpolation::Hold => return a.value,
        Interpolation::Linear => {}
        Interpolation::EaseIn => u = unit_bezier(0.42, 0.0, 1.0, 1.0, u),
        Interpolation::EaseOut => u = unit_bezier(0.0, 0.0, 0.58, 1.0, u),
        Interpolation::Bezier { p1, p2 } => u = unit_bezier(p1.0, p1.1, p2.0, p2.1, u),
    }
    a.value + (b.value - a.value) * u
}
```

- [ ] **Step 2: Add leaf unit tests for `eval_f64`**

In the leaf `mod tests`, add direct tests over hand-built `&[Kf]` covering: empty→default, single→value, before-first/after-last clamp, linear midpoint, Hold left-stick, EaseIn matches `unit_bezier(0.42,0,1,1,0.5)*v`. (Port the assertions from `animated.rs`'s existing `value_at_*` tests, expressed as slices.)

- [ ] **Step 3: Delegate from `animated.rs`**

In `apps/desktop/native/src/state/animated.rs`:
- Replace the local `Interpolation` enum + `unit_bezier` with re-exports:
```rust
pub use weftcut_eval::{Interpolation, unit_bezier};
```
- `Keyframe<T>`'s `interp: Interpolation` now refers to the re-exported type (no change at use sites).
- Replace `impl Animated<f64> { fn value_at }` body with an adapter + a hoistable collector:
```rust
impl Animated<f64> {
    /// Materialize keyframes as POD eval input (empty for Static). HOIST this
    /// out of per-sample loops and call `weftcut_eval::eval_f64` on the slice.
    pub fn eval_kfs(&self) -> alloc::vec::Vec<weftcut_eval::Kf> {
        match self {
            Animated::Static(_) => alloc::vec::Vec::new(),
            Animated::Keyframed(kfs) => kfs
                .iter()
                .map(|k| weftcut_eval::Kf { t_us: k.t_us, value: k.value, interp: k.interp })
                .collect(),
        }
    }

    pub fn value_at(&self, t_us: TimeUs, default: f64) -> f64 {
        match self {
            Animated::Static(v) => *v,
            Animated::Keyframed(_) => weftcut_eval::eval_f64(&self.eval_kfs(), t_us, default),
        }
    }
}
```
(`animated.rs` is in `std` land; use `Vec` directly, not `alloc::vec::Vec` — adjust the snippet to the file's existing imports.)

- [ ] **Step 4: Run the animated golden + leaf tests**

Run: `cargo test -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml`
Expected: PASS (new eval_f64 tests).
Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib -- state::animated`
Expected: PASS (the existing `golden_vectors_match_fixture` in animated.rs still passes through the delegated `value_at`).

- [ ] **Step 5: TS animated golden unchanged — verify green**

Run: `cd apps/desktop && npx vitest run src/renderer/render/animated.golden.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/eval/src/lib.rs apps/desktop/native/src/state/animated.rs
git commit -F - <<'EOF'
refactor(eval): move keyframe eval into weftcut-eval (slice ABI)

Interpolation/unit_bezier/eval_f64 live in the leaf; Animated<f64>::value_at
delegates via a POD Kf slice (eval_kfs hoistable out of loops). imbl stays in
the main crate. Animated golden green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Move db_to_linear + role-gate primitives into the leaf

**Files:**
- Modify: `apps/desktop/native/eval/src/lib.rs` (add `db_to_linear`, `any_role_solo`, `role_audible`, `role_gain_linear`)
- Modify: `apps/desktop/native/src/audio/envelope.rs` (re-export `db_to_linear`; hoist eval_kfs in `sample_gain`/`sample_pan`)
- Modify: `apps/desktop/native/src/audio/mix.rs` (role helpers delegate to leaf primitives)

**Interfaces:**
- Produces (leaf, primitive-typed — no `RoleMixSettings` in the leaf):
  - `weftcut_eval::db_to_linear(db: f64) -> f32`
  - `weftcut_eval::any_role_solo(solos: impl IntoIterator<Item = bool>) -> bool`
  - `weftcut_eval::role_audible(muted: bool, solo: bool, any_solo: bool) -> bool`
  - `weftcut_eval::role_gain_linear(gain_db: f64) -> f32`
- Consumes: `mix.rs`'s existing `any_role_solo(&RoleMixSettings iter)` / `role_audible(&RoleMixSettings, bool)` / `role_gain_linear(&RoleMixSettings)` wrappers (added 2026-06-20) now forward to the leaf primitives. `RoleMixSettings` STAYS in `state/audio_role.rs`.

- [ ] **Step 1: Add the primitives to the leaf**

Append to `eval/src/lib.rs`. `db_to_linear` uses `powf` (std float) — the leaf is `no_std`, and `f64::powf` is NOT in `core`. Use the identity `10^(db/20) = exp2((db/20) * log2(10))`... but `exp2`/`log2` are also std. SIMPLEST: add `libm` to the leaf for the wasm/no_std float math:
```toml
# eval/Cargo.toml [dependencies]
libm = "0.2"
```
```rust
pub fn db_to_linear(db: f64) -> f32 {
    libm::pow(10.0, db / 20.0) as f32
}
pub fn any_role_solo(solos: impl IntoIterator<Item = bool>) -> bool {
    solos.into_iter().any(|s| s)
}
pub fn role_audible(muted: bool, solo: bool, any_solo: bool) -> bool {
    if muted { return false; }
    if any_solo && !solo { return false; }
    true
}
pub fn role_gain_linear(gain_db: f64) -> f32 { db_to_linear(gain_db) }
```
(`libm` is `no_std`, wasm-friendly, ~tiny. Verify the existing `db_to_linear` used `10f64.powf` — `libm::pow(10.0, x)` is bit-identical for these inputs; the envelope golden will confirm.)

- [ ] **Step 2: Add leaf unit tests**

In `mod tests`: `db_to_linear(0.0) ≈ 1.0`, `db_to_linear(6.0206) ≈ 2.0` (abs < 1e-4), `role_audible(true, true, true) == false` (mute wins), `role_audible(false, false, true) == false` (not soloed), `any_role_solo([false,true,false]) == true`.

- [ ] **Step 3: Delegate db_to_linear from envelope.rs + hoist eval_kfs**

In `apps/desktop/native/src/audio/envelope.rs`:
- Replace `pub fn db_to_linear` with `pub use weftcut_eval::db_to_linear;`.
- Rewrite `sample_gain` so the keyframe collection happens ONCE (not per sample). Replace the body with:
```rust
pub fn sample_gain(gain_db: &Animated<f64>, fade_in_us: i64, fade_out_us: i64, span_us: i64) -> Envelope {
    let animated = gain_db.is_animated();
    if !animated && fade_in_us == 0 && fade_out_us == 0 {
        return Envelope::constant(db_to_linear(gain_db.value_at(0, 0.0)), span_us);
    }
    let kfs = gain_db.eval_kfs(); // empty ⇒ static
    let static_v = if let Animated::Static(v) = gain_db { Some(*v) } else { None };
    let base = |t: i64| -> f64 {
        match static_v { Some(v) => v, None => weftcut_eval::eval_f64(&kfs, t, 0.0) }
    };
    let mut values = Vec::with_capacity((span_us / ENVELOPE_STEP_US) as usize + 2);
    let mut k = 0i64;
    loop {
        let t = (k * ENVELOPE_STEP_US).min(span_us);
        let g = db_to_linear(base(t)) * fade_multiplier(t, span_us, fade_in_us, fade_out_us) as f32;
        values.push(g);
        if t >= span_us { break; }
        k += 1;
    }
    Envelope { step_us: ENVELOPE_STEP_US, span_us, values }
}
```
- Rewrite `sample_pan` the same way (collect `pan.eval_kfs()` once, `base(t)` closure, clamp to [-1,1]).

- [ ] **Step 4: Delegate role helpers from mix.rs**

In `apps/desktop/native/src/audio/mix.rs`, change the three helpers (added 2026-06-20) to forward to the leaf, keeping their `&RoleMixSettings`/iterator signatures so callers are untouched:
```rust
pub fn any_role_solo<'a>(roles: impl IntoIterator<Item = &'a RoleMixSettings>) -> bool {
    weftcut_eval::any_role_solo(roles.into_iter().map(|r| r.solo))
}
pub fn role_audible(role: &RoleMixSettings, any_solo: bool) -> bool {
    weftcut_eval::role_audible(role.muted, role.solo, any_solo)
}
pub fn role_gain_linear(role: &RoleMixSettings) -> f32 {
    weftcut_eval::role_gain_linear(role.gain_db)
}
```

- [ ] **Step 5: Run audio tests + goldens**

Run: `cargo test -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml`
Expected: PASS.
Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib --features export -- audio::mix audio::envelope`
Expected: PASS (incl. both `golden_vectors_match_fixture` in mix.rs + envelope.rs, and the mix mute/solo/gain tests).

- [ ] **Step 6: TS envelope + roleGate goldens unchanged — verify green**

Run: `cd apps/desktop && npx vitest run src/renderer/render/audio/envelope.golden.test.ts src/renderer/render/audio/roleGate.golden.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/native/eval/Cargo.toml apps/desktop/native/eval/src/lib.rs apps/desktop/native/src/audio/envelope.rs apps/desktop/native/src/audio/mix.rs
git commit -F - <<'EOF'
refactor(eval): move db_to_linear + role-gate math into weftcut-eval

Leaf gains libm for no_std 10^(db/20). envelope.rs hoists keyframe collection
out of the per-sample loop; mix.rs role helpers forward to leaf primitives.
All audio goldens + mix tests green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

**END OF PHASE 1.** At this point the native side is fully consolidated onto the leaf, behavior-identical, all Rust tests + all four goldens green, and the renderer is untouched (still using its TS twins). This is a safe stopping/merging point.

---

## Task 5: wasm resident-ABI exports + build script + loader

**Files:**
- Create: `apps/desktop/native/eval/src/wasm.rs`
- Modify: `apps/desktop/native/eval/src/lib.rs` (`#[cfg(target_arch="wasm32")] mod wasm;`)
- Create: `apps/desktop/scripts/build-eval-wasm.mjs`
- Create: `apps/desktop/src/renderer/eval/index.ts`
- Modify: `apps/desktop/package.json` (scripts) and `apps/desktop/.gitignore`

**Interfaces:**
- Produces (wasm `extern "C"` exports): `noop()`, `snap_round(t_us: f64, num: i32, den: i32) -> f64`, `set_n(n: i32)`, `set_kf(i, t_us, value, interp, p1x, p1y, p2x, p2y: f64)`, `eval(t_us, default: f64) -> f64`, `db_to_linear(db: f64) -> f32`, `role_audible(muted, solo, any_solo: i32) -> i32`.
- Produces (TS): `initEval(): Promise<void>`, and `Eval` object with `snapFrameRound(tUs,num,den)`, `loadTrack(handle, kfs)`, `evalTrack(handle, tUs, default)`, `dbToLinear(db)`, `roleAudible(muted,solo,anySolo)`. (Handle-based resident cache lives in TS.)

- [ ] **Step 1: Write the wasm shim (native build excludes it)**

`apps/desktop/native/eval/src/wasm.rs`:
```rust
//! Resident-ABI wasm exports. Scalars only across the boundary; the active
//! track lives in static buffers, uploaded once via set_kf/set_n and evaluated
//! per call. Built only for wasm32. f64 µs (no i64 ⇒ no BigInt at the boundary).
use crate::{eval_f64, role_audible as ra, snap_frame_round, Interpolation, Kf, Rational};

const MAXKF: usize = 256;
static mut T: [i64; MAXKF] = [0; MAXKF];
static mut V: [f64; MAXKF] = [0.0; MAXKF];
static mut IT: [Interpolation; MAXKF] = [Interpolation::Linear; MAXKF];
static mut N: usize = 0;

#[no_mangle]
pub extern "C" fn snap_round(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_round(t_us as i64, Rational::new(num as u32, den as u32)) as f64
}

#[no_mangle]
pub extern "C" fn set_n(n: i32) { unsafe { N = n as usize } }

#[no_mangle]
pub extern "C" fn set_kf(i: i32, t_us: f64, value: f64, interp: i32, p1x: f64, p1y: f64, p2x: f64, p2y: f64) {
    let it = match interp {
        0 => Interpolation::Hold,
        1 => Interpolation::Linear,
        2 => Interpolation::EaseIn,
        3 => Interpolation::EaseOut,
        _ => Interpolation::Bezier { p1: (p1x, p1y), p2: (p2x, p2y) },
    };
    unsafe { let i = i as usize; T[i] = t_us as i64; V[i] = value; IT[i] = it; }
}

#[no_mangle]
pub extern "C" fn eval(t_us: f64, default: f64) -> f64 {
    unsafe {
        let mut buf: [Kf; MAXKF] = [Kf { t_us: 0, value: 0.0, interp: Interpolation::Linear }; MAXKF];
        for i in 0..N { buf[i] = Kf { t_us: T[i], value: V[i], interp: IT[i] }; }
        eval_f64(&buf[..N], t_us as i64, default)
    }
}

#[no_mangle]
pub extern "C" fn db_to_linear(db: f64) -> f32 { crate::db_to_linear(db) }

#[no_mangle]
pub extern "C" fn role_audible(muted: i32, solo: i32, any_solo: i32) -> i32 {
    ra(muted != 0, solo != 0, any_solo != 0) as i32
}

#[no_mangle]
pub extern "C" fn noop() {}
```
Add to `eval/src/lib.rs`: `#[cfg(target_arch = "wasm32")] mod wasm;` and a `#[cfg(target_arch="wasm32")] #[panic_handler] fn ph(_: &core::panic::PanicInfo) -> ! { loop {} }`.
(`Kf` needs `Copy` for the `[Kf; MAXKF]` init — add `#[derive(Clone, Copy, ...)]` to `Kf` in lib.rs if not already.)

- [ ] **Step 2: Verify the wasm builds**

Run: `cargo build -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml --target wasm32-unknown-unknown --release`
Expected: produces `weftcut_eval.wasm` under `target/wasm32-unknown-unknown/release/`. Native build must STILL compile (the `wasm` mod is cfg'd out): `cargo build --manifest-path apps/desktop/native/Cargo.toml --lib` → PASS.

- [ ] **Step 3: Write the base64-embed build script**

`apps/desktop/scripts/build-eval-wasm.mjs`:
```js
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')           // apps/desktop
const manifest = resolve(root, 'native/Cargo.toml')
execFileSync('cargo', ['build', '-p', 'weftcut-eval', '--manifest-path', manifest,
  '--target', 'wasm32-unknown-unknown', '--release'], { stdio: 'inherit' })
const wasm = resolve(root, 'native/target/wasm32-unknown-unknown/release/weftcut_eval.wasm')
const b64 = readFileSync(wasm).toString('base64')
const out = resolve(root, 'src/renderer/eval/evalWasm.generated.ts')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `// GENERATED by scripts/build-eval-wasm.mjs — do not edit.\nexport const EVAL_WASM_BASE64 = ${JSON.stringify(b64)}\n`)
console.log(`wrote ${out} (${b64.length} base64 chars)`)
```

- [ ] **Step 4: Wire scripts + gitignore**

In `apps/desktop/package.json` `"scripts"`, add `"build:wasm": "node scripts/build-eval-wasm.mjs"` and prepend it to dev/build via `"predev": "npm run build:wasm"` and `"prebuild": "npm run build:wasm"` (adapt to the project's actual dev/build script names). Append to `apps/desktop/.gitignore`: `src/renderer/eval/evalWasm.generated.ts`.
Run: `cd apps/desktop && npm run build:wasm`
Expected: writes `src/renderer/eval/evalWasm.generated.ts`.

- [ ] **Step 5: Write the loader + typed wrappers**

`apps/desktop/src/renderer/eval/index.ts`:
```ts
// Single source of truth for the WYSIWYG math: thin typed wrappers over the
// weftcut-eval wasm module (compiled from native/eval). Tracks are uploaded
// once per (handle, version) and evaluated per-frame with scalar calls only.
import { EVAL_WASM_BASE64 } from './evalWasm.generated'

interface Exports {
  snap_round(tUs: number, num: number, den: number): number
  set_n(n: number): void
  set_kf(i: number, tUs: number, value: number, interp: number, p1x: number, p1y: number, p2x: number, p2y: number): void
  eval(tUs: number, def: number): number
  db_to_linear(db: number): number
  role_audible(muted: number, solo: number, anySolo: number): number
}

let ex: Exports | null = null
const interpCode: Record<string, number> = { Hold: 0, Linear: 1, EaseIn: 2, EaseOut: 3, Bezier: 4 }

export async function initEval(): Promise<void> {
  if (ex) return
  const bytes = Uint8Array.from(atob(EVAL_WASM_BASE64), (c) => c.charCodeAt(0))
  const { instance } = await WebAssembly.instantiate(bytes, {})
  ex = instance.exports as unknown as Exports
}

function E(): Exports {
  if (!ex) throw new Error('initEval() not awaited before eval use')
  return ex
}

export function snapFrameRound(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_round(tUs, num, den)
}

// Keyframe shape from the IPC AnimTrack (renderer/render/animated.ts type).
interface Kf { t_us: number; value: number; interp: { kind: string; p1?: [number, number]; p2?: [number, number] } }

let loadedHandle = -1
/** Upload a track's keyframes into wasm once; cache by a monotonically-bumped handle. */
export function loadTrack(handle: number, kfs: Kf[]): void {
  if (handle === loadedHandle) return
  const e = E()
  for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i]!
    const c = interpCode[k.interp.kind] ?? 1
    const p1 = k.interp.p1 ?? [0, 0]
    const p2 = k.interp.p2 ?? [0, 0]
    e.set_kf(i, k.t_us, k.value, c, p1[0], p1[1], p2[0], p2[1])
  }
  e.set_n(kfs.length)
  loadedHandle = handle
}
export function evalTrack(tUs: number, def: number): number { return E().eval(tUs, def) }
export function dbToLinear(db: number): number { return E().db_to_linear(db) }
export function roleAudible(muted: boolean, solo: boolean, anySolo: boolean): boolean {
  return E().role_audible(muted ? 1 : 0, solo ? 1 : 0, anySolo ? 1 : 0) !== 0
}
```

- [ ] **Step 6: Write a vitest wasm smoke test (NEW behavior — real test first)**

Create `apps/desktop/src/renderer/eval/eval.smoke.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { initEval, snapFrameRound, dbToLinear, roleAudible, loadTrack, evalTrack } from './index'
import snap from '../snapFrameGolden.fixture.json'

beforeAll(async () => { await initEval() })

describe('eval wasm smoke', () => {
  it('snap matches the snap golden', () => {
    for (const c of (snap as { cases: { fps_num: number; fps_den: number; samples: { t_us: number; expect: number }[] }[] }).cases)
      for (const s of c.samples) expect(snapFrameRound(s.t_us, c.fps_num, c.fps_den)).toBe(s.expect)
  })
  it('dbToLinear ~ 2.0 at +6.0206 dB', () => { expect(dbToLinear(6.0206)).toBeCloseTo(2.0, 4) })
  it('mute wins over solo', () => { expect(roleAudible(true, true, true)).toBe(false) })
  it('evalTrack linear midpoint', () => {
    loadTrack(1, [{ t_us: 0, value: 0, interp: { kind: 'Linear' } }, { t_us: 1_000_000, value: 100, interp: { kind: 'Linear' } }])
    expect(evalTrack(500_000, 0)).toBeCloseTo(50, 6)
  })
})
```

- [ ] **Step 7: Run the smoke test**

Run: `cd apps/desktop && npm run build:wasm && npx vitest run src/renderer/eval/eval.smoke.test.ts`
Expected: PASS. (If `atob` is undefined under the vitest env, switch the decode to `Buffer.from(EVAL_WASM_BASE64, 'base64')` guarded by a typeof check.)

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/native/eval/src/wasm.rs apps/desktop/native/eval/src/lib.rs apps/desktop/scripts/build-eval-wasm.mjs apps/desktop/src/renderer/eval/index.ts apps/desktop/src/renderer/eval/eval.smoke.test.ts apps/desktop/package.json apps/desktop/.gitignore
git commit -F - <<'EOF'
feat(eval): wasm resident-ABI exports + loader + build script

weftcut-eval compiles to wasm32 with scalar-only exports; renderer loads it
via a base64-embedded module and initEval(). Smoke test asserts snap/db/role/
eval against the shared fixtures. No TS twin replaced yet.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Initialize wasm at renderer startup

**Files:**
- Modify: the renderer entry that mounts the app (find it: `apps/desktop/src/renderer/main.tsx` or `index.tsx` — grep for `createRoot` / `ReactDOM`).

**Interfaces:**
- Consumes: `initEval` from `./eval`.
- Produces: a guarantee that `initEval()` resolves before the first composite/preview frame.

- [ ] **Step 1: Await initEval before mount**

In the renderer entry, wrap the mount so wasm is ready first:
```ts
import { initEval } from './eval'
await initEval()           // top-level await OR:
// initEval().then(() => { /* existing createRoot(...).render(...) */ })
```
Prefer the `.then(...)` form to dodge the Vite production top-level-await gotcha noted in the project's bundler config. Confirm the renderer still boots (`cd apps/desktop && npm run dev`, open the app, no console error).

- [ ] **Step 2: Commit**

```bash
git add <renderer entry file>
git commit -F - <<'EOF'
feat(eval): await initEval() before first composite

Wasm eval module is ready before any preview frame; avoids top-level-await in
the production bundle by chaining off initEval().

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Swap snap to wasm in the renderer

**Files:**
- Modify: `apps/desktop/src/renderer/frames.ts` (`snapFrameRound` becomes a wasm call)

**Interfaces:**
- Consumes: `snapFrameRound` from `./eval`.
- Produces: same `snapFrameRound(tUs, fpsNum, fpsDen)` signature, now wasm-backed; the degenerate-fps guard stays.

- [ ] **Step 1: Replace the body**

In `frames.ts`, re-export the wasm wrapper, keeping the public name + degenerate guard:
```ts
export { snapFrameRound } from './eval'
```
(The `./eval` wrapper already returns `tUs` on degenerate fps.) Leave `snapFrameFloor`/`lastFrameAnchorUs`/`formatTimecode`/etc. untouched — they are TS-only (no Rust twin), so they stay in `frames.ts`.

- [ ] **Step 2: Convert the cross-language golden to a wasm-smoke**

`frames.golden.test.ts` already imports `snapFrameRound` from `./frames`, which now resolves to wasm. Add `import { initEval } from './eval'` + `beforeAll(async () => { await initEval() })` at the top so the wasm is loaded for the test. The fixture + assertions stay — it now verifies the wasm reproduces the golden (single source, not drift).

- [ ] **Step 3: Run**

Run: `cd apps/desktop && npm run build:wasm && npx vitest run src/renderer/frames.golden.test.ts src/renderer/frames.test.ts`
Expected: PASS.

- [ ] **Step 4: Smoke the app (drag a clip, scrub)**

Run the app, drag a layer + scrub the playhead. Expected: snapping behaves exactly as before (ghost lands on the frame grid, no half-frame jump on release).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/frames.ts apps/desktop/src/renderer/frames.golden.test.ts
git commit -F - <<'EOF'
refactor(eval): renderer snap_frame_round now calls wasm (single source)

frames.ts re-exports the wasm wrapper; the hand-mirrored TS snap is gone. The
cross-language golden becomes a wasm-smoke against the shared fixture.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Swap keyframe eval to wasm in the renderer

**Files:**
- Modify: `apps/desktop/src/renderer/render/animated.ts` (`resolveAnimated`/`unitBezier` → wasm, with a per-track resident cache)
- Modify: `apps/desktop/src/renderer/render/animated.golden.test.ts` (init wasm)

**Interfaces:**
- Consumes: `loadTrack`, `evalTrack` from `../../eval`.
- Produces: `resolveAnimated(track, tUs, default)` with the SAME signature, wasm-backed. A track→handle/version map drives the resident cache.

- [ ] **Step 1: Add a stable handle to the resident cache**

The resident cache (`loadTrack(handle, kfs)`) needs a per-track identity. Use a `WeakMap<object, number>` keyed by the track's keyframe array reference (it's a fresh array only when the project changes), assigning incrementing handles:
```ts
import { loadTrack, evalTrack } from '../../eval'
const handles = new WeakMap<object, number>()
let nextHandle = 1
function handleFor(kfs: object): number {
  let h = handles.get(kfs)
  if (h === undefined) { h = nextHandle++; handles.set(kfs, h) }
  return h
}
```
(Rationale: IPC delivers a new `value` array when keyframes change, so identity changes exactly when the data does — correct cache invalidation for free. `loadTrack` re-uploads only when the handle differs from the last-loaded.)

- [ ] **Step 2: Rewrite resolveAnimated to use wasm**

Replace the body (keep Static/empty/single fast paths in JS to avoid a wasm call for the common case):
```ts
export function resolveAnimated<T extends number>(track: AnimTrack<T> | null | undefined, tCompUs: number, defaultValue: T): T {
  if (!track) return defaultValue
  if (track.mode === 'Static') return track.value
  const kfs = track.value
  if (!kfs || kfs.length === 0) return defaultValue
  if (kfs.length === 1) return kfs[0]!.value
  loadTrack(handleFor(kfs), kfs as unknown as { t_us: number; value: number; interp: { kind: string; p1?: [number, number]; p2?: [number, number] } }[])
  return evalTrack(tCompUs, 0) as T
}
```
Delete the TS `unitBezier`'s consumers that can move to wasm — BUT `unitBezier` is also used directly by `keyframe/curveGraph.ts`. Keep `unitBezier` exported from `animated.ts` for the curve graph (it's a UI-only renderer-side use with no Rust hot-path twin; leaving one JS copy of the cheap bezier for the curve editor is acceptable, OR add a `bezier(x1..x,x)` wasm export and route curveGraph through it). DECISION: keep the JS `unitBezier` for the curve graph only; the eval path uses wasm. Note this in the ADR (one small intentional JS copy remains for the editor overlay).

- [ ] **Step 3: Init wasm in the golden test**

Add `import { initEval } from '../../eval'` + `beforeAll(async () => { await initEval() })` to `animated.golden.test.ts`. Fixture + assertions stay (now a wasm-smoke).

- [ ] **Step 4: Run + smoke**

Run: `cd apps/desktop && npm run build:wasm && npx vitest run src/renderer/render/animated.golden.test.ts`
Expected: PASS.
Smoke: open the app, add keyframes to a layer's position/opacity, scrub — animation matches preview as before, and matches export (render a short clip with a keyframed move; compare).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/animated.ts apps/desktop/src/renderer/render/animated.golden.test.ts
git commit -F - <<'EOF'
refactor(eval): renderer keyframe eval now calls wasm (single source)

resolveAnimated uploads keyframes once (WeakMap-keyed resident cache) and
evaluates via wasm; Static/empty/single stay in JS. unitBezier kept in JS only
for the curve-graph editor overlay. Animated golden becomes a wasm-smoke.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Swap envelope + role gate to wasm in the renderer

**Files:**
- Modify: `apps/desktop/src/renderer/render/audio/envelope.ts` (`dbToLinear` → wasm; `sampleGain`/`pan` keep using `resolveAnimated`, now wasm-backed)
- Modify: `apps/desktop/src/renderer/render/audio/roleGate.ts` (`roleAudible` → wasm; `anyRoleSolo`/`roleGainLinear` thin)
- Modify: `envelope.golden.test.ts`, `roleGate.golden.test.ts` (init wasm)

**Interfaces:**
- Consumes: `dbToLinear`, `roleAudible` from the eval module.
- Produces: same exported names/signatures in `envelope.ts`/`roleGate.ts`.

- [ ] **Step 1: Route dbToLinear through wasm**

In `envelope.ts`, replace the local `dbToLinear` with `import { dbToLinear } from '../../../eval'` (adjust relative depth). `sampleGain`/`samplePan` already call `resolveAnimated` (now wasm-backed) — no other change.

- [ ] **Step 2: Route roleAudible through wasm**

In `roleGate.ts`:
```ts
import { roleAudible as wasmRoleAudible, dbToLinear } from '../../../eval'
export function anyRoleSolo(roles: RoleMixView[]): boolean { return roles.some((r) => r.solo) }
export function roleAudible(role: AudioRole, roles: RoleMixView[], anySolo: boolean): boolean {
  const r = roles.find((x) => x.role === role)
  if (!r) return !anySolo
  return wasmRoleAudible(r.muted, r.solo, anySolo)
}
export function roleGainLinear(role: AudioRole, roles: RoleMixView[]): number {
  const r = roles.find((x) => x.role === role)
  return dbToLinear(r ? r.gain_db : 0)
}
```
(`anyRoleSolo` is a trivial JS `.some` over a JS array — leave in JS; it's not a math twin worth a wasm call. The mute/solo DECISION and dB conversion go to wasm.)

- [ ] **Step 3: Init wasm in both goldens; run**

Add `beforeAll(async () => { await initEval() })` to `envelope.golden.test.ts` and `roleGate.golden.test.ts`.
Run: `cd apps/desktop && npm run build:wasm && npx vitest run src/renderer/render/audio/envelope.golden.test.ts src/renderer/render/audio/roleGate.golden.test.ts src/renderer/render/audio/roleGate.test.ts`
Expected: PASS.
Smoke: in the Mixer panel, mute/solo roles + change a role gain; preview audibility + loudness match expectations.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/render/audio/envelope.ts apps/desktop/src/renderer/render/audio/roleGate.ts apps/desktop/src/renderer/render/audio/envelope.golden.test.ts apps/desktop/src/renderer/render/audio/roleGate.golden.test.ts
git commit -F - <<'EOF'
refactor(eval): renderer envelope + role gate now call wasm (single source)

dbToLinear + the mute/solo decision come from wasm; the four cross-language
goldens are now wasm-smoke tests. The hand-mirrored TS math is gone.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10: Full regression sweep + docs + memory

**Files:**
- Create: `docs/adr/NNNN-shared-eval-wasm-leaf-crate.md` (next ADR number — check `docs/adr/` for the highest existing)
- Modify: `docs/architecture.md`
- (Memory updates are done by the planning session; this task only confirms they match reality.)

**Interfaces:** none (docs + verification only).

- [ ] **Step 1: Full Rust suite**

Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --lib --features export`
Expected: PASS (all modules). Then leaf: `cargo test -p weftcut-eval --manifest-path apps/desktop/native/Cargo.toml` → PASS.

- [ ] **Step 2: Full TS suite**

Run: `cd apps/desktop && npm run build:wasm && npm test`
Expected: PASS (goldens now wasm-smoke; everything green).

- [ ] **Step 3: Build the app end to end**

Run: `cd apps/desktop && npm run build` (triggers `prebuild` → `build:wasm`).
Expected: production build succeeds with the wasm embedded (no top-level-await error).

- [ ] **Step 4: Write the ADR**

Create `docs/adr/NNNN-shared-eval-wasm-leaf-crate.md` with `status: accepted` frontmatter (match the repo's ADR frontmatter convention). Content: the WYSIWYG-math twins were hand-mirrored Rust+TS with drift risk; `weftcut-eval` is now the single source, compiled natively for actor/export and to wasm32 for the renderer (resident scalar ABI); boundary cost measured negligible (resident eval ~36ns/call, faster than the prior JS); one intentional JS copy of `unitBezier` remains for the curve-graph editor overlay. Keep it evergreen (no phase/date banners in the body; the decision, not the history).

- [ ] **Step 5: Update architecture.md**

Add a short subsection: `apps/desktop/native/eval` (`weftcut-eval`) holds the pure deterministic "what-you-see/hear" math (snap, keyframe eval, envelope, role gate), consumed natively by the actor + export and as wasm by the renderer. Link the ADR.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/NNNN-shared-eval-wasm-leaf-crate.md docs/architecture.md
git commit -F - <<'EOF'
docs(eval): ADR + architecture note for the weftcut-eval single source

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: Finish the branch**

Use superpowers:finishing-a-development-branch to merge/PR.

---

## Self-Review notes (for the implementer)

- **If the napi build breaks after Task 1:** the `[workspace]` must be in `apps/desktop/native/Cargo.toml` (the napi crate IS the workspace root); do not create a repo-root `Cargo.toml`.
- **libm bit-identity (Task 4):** the envelope golden compares at 5 decimals; if `libm::pow(10.0, db/20.0)` ever disagrees with the fixture, that's the only place to investigate — do NOT edit the fixture.
- **Resident-cache correctness (Task 8):** the WeakMap is keyed by the keyframe ARRAY reference. If the renderer ever mutates a keyframe array in place (instead of replacing it on edit), the cache would go stale — verify edits replace the array (they do, IPC re-materializes). If not, bump to a `(array, length, version)` key.
- **`atob` availability:** if the vitest/Electron environment lacks `atob`, use `Buffer.from(b64,'base64')` under a `typeof atob === 'undefined'` guard in `initEval`.
- **Keep `frames.ts` non-snap helpers, `animated.ts` `unitBezier`, `roleGate.ts` `anyRoleSolo`:** these are intentionally NOT moved (TS-only or trivial). Deleting them is a regression.
