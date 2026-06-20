---
status: accepted
---
# 0025 — Shared "WYSIWYG math" in one wasm leaf crate

## Context
A handful of small, deterministic functions decide *what the user sees and hears*, and each runs on BOTH sides of the renderer↔Rust process boundary:

- **frame snap** (`snap_frame_round`/floor/ceil): the actor snaps every timeline mutation to the frame grid; the renderer snaps drag-ghost / seek / playhead.
- **keyframe eval** (`value_at` / `resolveAnimated` + `unit_bezier`): the renderer composites every animated layer per frame (preview + export); Rust evaluates keyframed audio gain/pan for export.
- **audio envelope** (`db_to_linear`): the Rust export mixer; the renderer's audio preview.
- **role gate** (`role_audible` mute/solo decision): the Rust export mix selection; the renderer's audio-preview gating.

These were hand-mirrored Rust + TypeScript copies. Identical math in two languages drifts on edits — a change that lands on one side but not the other silently breaks the storage invariant (snap), preview-vs-export parity (keyframes), or audibility (role gate). Cross-language golden fixtures were added as a drift tripwire, but a tripwire is not a fix: it catches drift after the fact rather than preventing it.

The wasm boundary cost was measured before committing: a resident-ABI `value_at` runs ~0.59× the JS cost (wasm is *faster*), and per-frame impact is under 0.5% of the frame budget — so sharing one implementation costs nothing in the hot path.

## Decision
The math lives once, in a dependency-light Rust leaf crate **`weftcut-eval`** (`apps/desktop/native/eval/`), compiled two ways:

- **Natively** as an `rlib` the `weftcut` napi crate links: `state/time.rs`, `state/animated.rs`, `audio/envelope.rs`, and `audio/mix.rs` delegate to it (behavior byte-identical).
- **To `wasm32`** as a `cdylib`: a build script (`scripts/build-eval-wasm.mjs`) compiles it and base64-embeds the bytes into a generated TS module; the renderer loads it once via `initEval()` (awaited before the first composite) and calls it in place of the deleted TS twins. The four cross-language goldens become single-source regression + wasm-smoke tests.

Design constraints that keep the leaf small and the boundary cheap:

- **Resident scalar ABI.** Keyframes cross into wasm once (cached by a handle keyed on the IPC-materialized array reference); per call only scalars cross. Times are `f64` µs and rates are `i32` num/den — **never i64**, to avoid BigInt marshaling.
- **Leaf dependency budget.** `core`/`std` (`no_std` only on wasm32, so the native build needs no hand-rolled panic handler), plus `libm` for `10^(db/20)` and `serde` behind a feature. Forbidden: `imbl`, `uuid`, `napi`, `tokio`, `ts-rs`, `schemars`.
- **`Rational` stays in the napi crate.** It is used inside a `#[derive(JsonSchema)]` type and the leaf forbids schemars, so the leaf snap functions take primitive `(num, den)` instead — which also matches the wasm/TS ABI. `Interpolation` (serde, no schemars) does move into the leaf.
- **Gains are `f32`.** `db_to_linear -> f32`, matching `Envelope::scale` and the gain Web Audio quantizes to; both cross-language sides assert the role-gain golden at f32 width.

One intentional JS copy of `unit_bezier` remains in `render/animated.ts` — used only by the curve-graph editor overlay, a UI path with no Rust hot-path twin.

## Consequences
- **+** One source of truth for the WYSIWYG math: the renderer and the Rust actor/export run the same compiled function, so preview, export, and committed state cannot drift. The goldens now prove the wasm reproduces the fixtures rather than that two copies happen to agree.
- **+** No measurable hot-path cost (resident eval ≈ JS, often faster); the renderer mounts behind a one-time `initEval()`.
- **−** A build step: the renderer now depends on a generated, gitignored wasm module, wired into `predev`/`prebuild`/`pretest` (so a Rust toolchain with the `wasm32-unknown-unknown` target is required to build or test the renderer).
- **−** The Rust + TS engines were unified by moving the renderer onto wasm; the leaf's `no_std` discipline is enforced by the per-build wasm compile, not by review.
- **−** The wasm resident buffer is a fixed 256 keyframes **per animated property** (no heap in the no_std build); beyond that the preview truncates while native export evaluates all keyframes, so they would diverge. Unreachable in manual authoring (a backstop, not a product limit); `loadTrack` warns once if hit. Revisit (an upstream per-property cap, or a linear-memory upload path) only if dense/programmatic keyframes are introduced.
