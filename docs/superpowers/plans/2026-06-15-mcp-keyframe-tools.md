# MCP Keyframe Authoring Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MCP agents a full keyframe authoring surface (read / set / remove / retime / re-ease / smooth / clear a param track, plus a whole-track escape hatch) on top of the existing `update_layer_param_track` write path.

**Architecture:** Port the TS pure keyframe transforms (`keyframe/edits.ts`) to a shared Rust module `state/keyframe_edits.rs`, locked to the TS by a cross-language golden fixture. MCP tool methods stay thin wrappers around testable free `async fn` helpers (`mcp/keyframes.rs`) that do snapshot → pure transform → `update_layer_param_track` — reusing the actor's existing normalization, validation, lock check, and history. All tool times are timeline-absolute (converted to layer-local inside the helper).

**Tech Stack:** Rust (Tauri actor, `rmcp` 0.1.x MCP, `imbl`, `serde`, `schemars`), TypeScript (vitest), shared JSON golden fixture.

**Spec:** `docs/superpowers/specs/2026-06-15-mcp-keyframe-tools-design.md`

**Environment note:** Building `weftcut_lib` requires the project's normal Rust build env (ffmpeg-next + LLVM — see memory `reference_ffmpeg_next_windows_setup`). Run Rust tests with `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`. Run TS tests from `apps/desktop` with `npx vitest run <path>`.

**Git note:** A parallel session may be editing this checkout (`apps/desktop/src/i18n/locales/*.ts` are already modified by it). Stage only the exact paths each commit lists — never `git add -A`.

---

## File Structure

- **Create** `apps/desktop/src-tauri/src/state/keyframe_edits.rs` — pure `Animated<f64>` transforms (port of `keyframe/edits.ts`). One responsibility: keyframe math.
- **Modify** `apps/desktop/src-tauri/src/state/mod.rs` — register `pub mod keyframe_edits;` and re-export if the file re-exports siblings.
- **Modify** `apps/desktop/src-tauri/src/state/layer.rs` — add the immutable `resolve_animated_f64` sibling of `resolve_animated_f64_mut`.
- **Create** `apps/desktop/src/keyframe/keyframeEditsGolden.fixture.json` — shared cross-language golden cases.
- **Create** `apps/desktop/src/keyframe/edits.golden.test.ts` — TS side of the golden.
- **Create** `apps/desktop/src-tauri/src/mcp/keyframes.rs` — arg structs, `KfError`, the free helper fns, error→McpError mapper, and tokio smoke tests.
- **Modify** `apps/desktop/src-tauri/src/mcp/mod.rs` — register `mod keyframes;` and add the thin `#[tool]` wrapper methods.
- **Modify** `docs/mcp.md` — document the keyframe tools (evergreen).

---

## Task 1: Pure Rust keyframe transforms

**Files:**
- Create: `apps/desktop/src-tauri/src/state/keyframe_edits.rs`
- Modify: `apps/desktop/src-tauri/src/state/mod.rs`

- [ ] **Step 1: Register the module**

In `apps/desktop/src-tauri/src/state/mod.rs`, add alongside the other `mod` declarations (e.g. near `mod animated;`):

```rust
pub mod keyframe_edits;
```

- [ ] **Step 2: Write `keyframe_edits.rs` with the transforms + unit tests**

Create `apps/desktop/src-tauri/src/state/keyframe_edits.rs`:

```rust
//! Pure `Animated<f64>` keyframe transforms for the authoring surface.
//!
//! Behavioral mirror of `apps/desktop/src/keyframe/edits.ts`. Times are
//! LAYER-LOCAL microseconds (the keyframe `t_us` base). Each fn returns a NEW
//! track; the actor re-normalizes (snap/sort/dedupe) on write, so these need
//! only stay self-consistent.
//!
//! Cross-language parity is locked by `keyframeEditsGolden.fixture.json`
//! (asserted by `golden_vectors_match_fixture` here AND by
//! `keyframe/edits.golden.test.ts`). Any edit here MUST be mirrored in the TS
//! and reflected in the fixture — there is no other enforcing test (see memory
//! `feedback_engine_source_drift`, `feedback_snap_math_drift`).

use crate::state::animated::{Animated, Interpolation, Keyframe};
use crate::state::ids::{KeyframeId, new_id};

const DEFAULT_INTERP: Interpolation = Interpolation::Linear;

/// Insert-or-update a key at `t_us` (layer-local). A `Static` track is lifted
/// (the new key is the only key). An existing key at exactly `t_us` is updated
/// in place — value always; interp only when `interp` is `Some`. Otherwise a new
/// key is inserted with `interp` when `Some`, else the preceding key's interp,
/// else `Linear`.
pub fn upsert(
    track: &Animated<f64>,
    t_us: i64,
    value: f64,
    interp: Option<Interpolation>,
) -> Animated<f64> {
    let kfs = match track {
        Animated::Static(_) => {
            return Animated::Keyframed(
                std::iter::once(Keyframe {
                    id: new_id(),
                    t_us,
                    value,
                    interp: interp.unwrap_or(DEFAULT_INTERP),
                })
                .collect(),
            );
        }
        Animated::Keyframed(kfs) => kfs,
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    if let Some(at) = keys.iter().position(|k| k.t_us == t_us) {
        keys[at].value = value;
        if let Some(i) = interp {
            keys[at].interp = i;
        }
        return Animated::Keyframed(keys.into_iter().collect());
    }
    let inherited = keys
        .iter()
        .filter(|k| k.t_us < t_us)
        .next_back()
        .map(|k| k.interp)
        .unwrap_or(DEFAULT_INTERP);
    keys.push(Keyframe {
        id: new_id(),
        t_us,
        value,
        interp: interp.unwrap_or(inherited),
    });
    keys.sort_by_key(|k| k.t_us);
    Animated::Keyframed(keys.into_iter().collect())
}

/// Remove a key by id. When it was the last key, collapse to a `Static` holding
/// that key's value (so the property keeps its on-screen value). `fallback` is
/// used only if `id` is absent (callers pre-check existence).
pub fn remove(track: &Animated<f64>, id: KeyframeId, fallback: f64) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let remaining: Vec<Keyframe<f64>> = kfs.iter().filter(|k| k.id != id).cloned().collect();
    if remaining.is_empty() {
        let removed = kfs.iter().find(|k| k.id == id).map(|k| k.value);
        return Animated::Static(removed.unwrap_or(fallback));
    }
    Animated::Keyframed(remaining.into_iter().collect())
}

/// Move one key to `new_t_us` (layer-local) and re-sort.
pub fn retime(track: &Animated<f64>, id: KeyframeId, new_t_us: i64) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs
        .iter()
        .map(|k| {
            if k.id == id {
                Keyframe { t_us: new_t_us, ..k.clone() }
            } else {
                k.clone()
            }
        })
        .collect();
    keys.sort_by_key(|k| k.t_us);
    Animated::Keyframed(keys.into_iter().collect())
}

/// Set the easing of the segment leaving key `id`.
pub fn set_interp(track: &Animated<f64>, id: KeyframeId, interp: Interpolation) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    Animated::Keyframed(
        kfs.iter()
            .map(|k| if k.id == id { Keyframe { interp, ..k.clone() } } else { k.clone() })
            .collect(),
    )
}

/// Port of `keyframe/curve.ts::interpToCoeffs`: interp → cubic-bezier control
/// coords. Linear / Hold map to the identity diagonal.
fn interp_to_coeffs(interp: Interpolation) -> [f64; 4] {
    match interp {
        Interpolation::Bezier { p1, p2 } => [p1.0, p1.1, p2.0, p2.1],
        Interpolation::EaseIn => [0.42, 0.0, 1.0, 1.0],
        Interpolation::EaseOut => [0.0, 0.0, 0.58, 1.0],
        _ => [0.0, 0.0, 1.0, 1.0],
    }
}

fn clamp01(v: f64) -> f64 {
    if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v }
}

/// Monotone-clamped tangent (value per microsecond) at interior key `i`; 0 at a
/// local extremum, an endpoint, or when a neighbour delta is 0.
fn tangent_at(keys: &[Keyframe<f64>], i: usize) -> f64 {
    if i == 0 || i + 1 >= keys.len() {
        return 0.0;
    }
    let d_prev = keys[i].value - keys[i - 1].value;
    let d_next = keys[i + 1].value - keys[i].value;
    if d_prev == 0.0 || d_next == 0.0 || d_prev.signum() != d_next.signum() {
        return 0.0;
    }
    let dt = (keys[i + 1].t_us - keys[i - 1].t_us) as f64;
    if dt <= 0.0 {
        return 0.0;
    }
    (keys[i + 1].value - keys[i - 1].value) / dt
}

/// Bake monotone (no-overshoot) C1 tangents at key `id` into the outgoing
/// segment (this key's p1) and the incoming segment (previous key's p2).
pub fn smooth_one(track: &Animated<f64>, id: KeyframeId) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let Some(i) = keys.iter().position(|k| k.id == id) else {
        return track.clone();
    };
    let m = tangent_at(&keys, i);
    let mut out = keys.clone();

    if i < keys.len() - 1 {
        let dt = (keys[i + 1].t_us - keys[i].t_us) as f64;
        let dv = keys[i + 1].value - keys[i].value;
        if dv == 0.0 || dt <= 0.0 {
            out[i].interp = Interpolation::Linear;
        } else {
            let [_, _, x2, y2] = interp_to_coeffs(keys[i].interp);
            let y1 = clamp01((m * dt) / (3.0 * dv));
            out[i].interp = Interpolation::Bezier { p1: (1.0 / 3.0, y1), p2: (x2, y2) };
        }
    }

    if i > 0 {
        let dt = (keys[i].t_us - keys[i - 1].t_us) as f64;
        let dv = keys[i].value - keys[i - 1].value;
        if dv == 0.0 || dt <= 0.0 {
            out[i - 1].interp = Interpolation::Linear;
        } else {
            let [x1, y1, _, _] = interp_to_coeffs(out[i - 1].interp);
            let y2 = clamp01(1.0 - (m * dt) / (3.0 * dv));
            out[i - 1].interp = Interpolation::Bezier { p1: (x1, y1), p2: (2.0 / 3.0, y2) };
        }
    }

    Animated::Keyframed(out.into_iter().collect())
}

/// Smooth every key (one whole-track result).
pub fn smooth_all(track: &Animated<f64>) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let ids: Vec<KeyframeId> = kfs.iter().map(|k| k.id).collect();
    let mut acc = track.clone();
    for id in ids {
        acc = smooth_one(&acc, id);
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(id: u128, t_us: i64, value: f64, interp: Interpolation) -> Keyframe<f64> {
        Keyframe { id: uuid::Uuid::from_u128(id), t_us, value, interp }
    }
    fn keyframed(kfs: Vec<Keyframe<f64>>) -> Animated<f64> {
        Animated::Keyframed(kfs.into_iter().collect())
    }
    fn ids(track: &Animated<f64>) -> Vec<KeyframeId> {
        match track {
            Animated::Keyframed(k) => k.iter().map(|x| x.id).collect(),
            Animated::Static(_) => vec![],
        }
    }

    #[test]
    fn upsert_lifts_static() {
        let out = upsert(&Animated::Static(0.5), 1_000_000, 0.9, None);
        let Animated::Keyframed(kfs) = &out else { panic!("lifted") };
        assert_eq!(kfs.len(), 1);
        assert_eq!(kfs[0].t_us, 1_000_000);
        assert!((kfs[0].value - 0.9).abs() < 1e-9);
        assert!(matches!(kfs[0].interp, Interpolation::Linear));
    }

    #[test]
    fn upsert_updates_existing_preserves_id_and_interp() {
        let tr = keyframed(vec![kf(1, 0, 0.0, Interpolation::EaseIn)]);
        let id_before = ids(&tr);
        let out = upsert(&tr, 0, 0.7, None);
        assert_eq!(ids(&out), id_before, "id preserved on in-place update");
        let Animated::Keyframed(kfs) = &out else { panic!() };
        assert!((kfs[0].value - 0.7).abs() < 1e-9);
        assert!(matches!(kfs[0].interp, Interpolation::EaseIn), "interp preserved when None");
    }

    #[test]
    fn upsert_insert_inherits_preceding_interp() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Interpolation::EaseIn),
            kf(2, 2_000_000, 1.0, Interpolation::Linear),
        ]);
        let out = upsert(&tr, 1_000_000, 0.5, None);
        let Animated::Keyframed(kfs) = &out else { panic!() };
        assert_eq!(kfs.len(), 3);
        assert_eq!(kfs[1].t_us, 1_000_000);
        assert!(matches!(kfs[1].interp, Interpolation::EaseIn), "inherits preceding key interp");
    }

    #[test]
    fn remove_last_collapses_to_removed_value() {
        let tr = keyframed(vec![kf(1, 0, 0.33, Interpolation::Linear)]);
        let out = remove(&tr, uuid::Uuid::from_u128(1), 999.0);
        assert!(matches!(out, Animated::Static(v) if (v - 0.33).abs() < 1e-9));
    }

    #[test]
    fn retime_resorts() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Interpolation::Linear),
            kf(2, 2_000_000, 1.0, Interpolation::Linear),
        ]);
        let out = retime(&tr, uuid::Uuid::from_u128(1), 3_000_000);
        let Animated::Keyframed(kfs) = &out else { panic!() };
        assert_eq!(kfs.iter().map(|k| k.t_us).collect::<Vec<_>>(), vec![2_000_000, 3_000_000]);
        assert!((kfs[1].value - 0.0).abs() < 1e-9, "moved key keeps its value");
    }

    #[test]
    fn smooth_all_equals_fold_of_smooth_one() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Interpolation::Linear),
            kf(2, 1_000_000, 1.0, Interpolation::Linear),
            kf(3, 2_000_000, 0.0, Interpolation::Linear),
        ]);
        let folded = {
            let mut acc = tr.clone();
            for id in ids(&tr) {
                acc = smooth_one(&acc, id);
            }
            acc
        };
        let all = smooth_all(&tr);
        let (Animated::Keyframed(a), Animated::Keyframed(b)) = (&all, &folded) else { panic!() };
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.interp, y.interp);
        }
    }
}
```

- [ ] **Step 3: Run the unit tests, verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml keyframe_edits::tests`
Expected: PASS (all 6 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/state/keyframe_edits.rs apps/desktop/src-tauri/src/state/mod.rs
git commit -m "$(cat <<'EOF'
feat(keyframe): port pure keyframe transforms to Rust

Mirror of keyframe/edits.ts (upsert/remove/retime/set_interp/smooth)
for the MCP keyframe surface. Layer-local times; actor re-normalizes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Cross-language golden fixture

**Files:**
- Create: `apps/desktop/src/keyframe/keyframeEditsGolden.fixture.json`
- Create: `apps/desktop/src/keyframe/edits.golden.test.ts`
- Modify: `apps/desktop/src-tauri/src/state/keyframe_edits.rs` (add the golden test)

The fixture covers the deterministic ops. Comparison **ignores keyframe ids** (so upsert-of-a-new-key's fresh id doesn't break it); id-preservation is covered by Task 1's unit tests. Coords/values compare with 1e-9 tolerance. The `smooth_one` case uses a symmetric peak (m=0), so its bezier coords are clean (`1/3`, `2/3`, `0`, `1`).

- [ ] **Step 1: Write the fixture**

Create `apps/desktop/src/keyframe/keyframeEditsGolden.fixture.json`:

```json
{
  "cases": [
    {
      "name": "upsert_insert_inherits_preceding",
      "op": "upsert",
      "args": { "t_us": 1000000, "value": 0.5 },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseIn" } },
        { "id": "00000000-0000-0000-0000-000000000002", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Keyframed", "value": [
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseIn" } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 1000000, "value": 0.5, "interp": { "kind": "EaseIn" } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] }
    },
    {
      "name": "upsert_update_existing",
      "op": "upsert",
      "args": { "t_us": 0, "value": 0.7 },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000002", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Keyframed", "value": [
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 0, "value": 0.7, "interp": { "kind": "Linear" } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] }
    },
    {
      "name": "remove_middle",
      "op": "remove",
      "args": { "id": "00000000-0000-0000-0000-000000000002", "fallback": 0.0 },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000002", "t_us": 1000000, "value": 0.5, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000003", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Keyframed", "value": [
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] }
    },
    {
      "name": "remove_last_collapses_to_static",
      "op": "remove",
      "args": { "id": "00000000-0000-0000-0000-000000000001", "fallback": 9.0 },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.33, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Static", "value": 0.33 }
    },
    {
      "name": "retime_resorts",
      "op": "retime",
      "args": { "id": "00000000-0000-0000-0000-000000000001", "new_t_us": 3000000 },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000002", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Keyframed", "value": [
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 3000000, "value": 0.0, "interp": { "kind": "Linear" } }
      ] }
    },
    {
      "name": "set_interp_ease_in",
      "op": "set_interp",
      "args": { "id": "00000000-0000-0000-0000-000000000001", "interp": { "kind": "EaseIn" } },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000002", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Keyframed", "value": [
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 0, "value": 0.0, "interp": { "kind": "EaseIn" } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 2000000, "value": 1.0, "interp": { "kind": "Linear" } }
      ] }
    },
    {
      "name": "smooth_one_peak",
      "op": "smooth_one",
      "args": { "id": "00000000-0000-0000-0000-000000000002" },
      "input": { "mode": "Keyframed", "value": [
        { "id": "00000000-0000-0000-0000-000000000001", "t_us": 0, "value": 0.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000002", "t_us": 1000000, "value": 1.0, "interp": { "kind": "Linear" } },
        { "id": "00000000-0000-0000-0000-000000000003", "t_us": 2000000, "value": 0.0, "interp": { "kind": "Linear" } }
      ] },
      "expect": { "mode": "Keyframed", "value": [
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 0, "value": 0.0, "interp": { "kind": "Bezier", "p1": [0.0, 0.0], "p2": [0.6666666666666666, 1.0] } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 1000000, "value": 1.0, "interp": { "kind": "Bezier", "p1": [0.3333333333333333, 0.0], "p2": [1.0, 1.0] } },
        { "id": "ffffffff-ffff-ffff-ffff-ffffffffffff", "t_us": 2000000, "value": 0.0, "interp": { "kind": "Linear" } }
      ] }
    }
  ]
}
```

- [ ] **Step 2: Write the TS golden test**

Create `apps/desktop/src/keyframe/edits.golden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import {
  upsertKeyframe,
  removeKeyframe,
  retimeKeyframe,
  setKeyframeInterp,
  smoothKeyframe,
} from "./edits";
import fixture from "./keyframeEditsGolden.fixture.json";

type Track = AnimTrack<number>;
interface Case {
  name: string;
  op: string;
  args: Record<string, unknown>;
  input: Track;
  expect: Track;
}

function applyOp(track: Track, op: string, args: Record<string, unknown>): Track {
  switch (op) {
    case "upsert":
      return upsertKeyframe(track, args.t_us as number, args.value as number);
    case "remove":
      return removeKeyframe(track, args.id as string, args.fallback as number);
    case "retime":
      return retimeKeyframe(track, args.id as string, args.new_t_us as number);
    case "set_interp":
      return setKeyframeInterp(track, args.id as string, args.interp as Interpolation);
    case "smooth_one":
      return smoothKeyframe(track, args.id as string);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const NEAR = 1e-9;
function interpEq(a: Interpolation, b: Interpolation) {
  expect(a.kind).toBe(b.kind);
  if (a.kind === "Bezier" && b.kind === "Bezier") {
    expect(Math.abs(a.p1[0] - b.p1[0])).toBeLessThan(NEAR);
    expect(Math.abs(a.p1[1] - b.p1[1])).toBeLessThan(NEAR);
    expect(Math.abs(a.p2[0] - b.p2[0])).toBeLessThan(NEAR);
    expect(Math.abs(a.p2[1] - b.p2[1])).toBeLessThan(NEAR);
  }
}

function assertTrackEqIgnoringIds(got: Track, want: Track) {
  expect(got.mode).toBe(want.mode);
  if (got.mode === "Static" && want.mode === "Static") {
    expect(Math.abs(got.value - want.value)).toBeLessThan(NEAR);
    return;
  }
  if (got.mode === "Keyframed" && want.mode === "Keyframed") {
    expect(got.value.length).toBe(want.value.length);
    got.value.forEach((g: Keyframe<number>, i: number) => {
      const w = want.value[i]!;
      expect(g.t_us).toBe(w.t_us);
      expect(Math.abs(g.value - w.value)).toBeLessThan(NEAR);
      interpEq(g.interp, w.interp);
    });
    return;
  }
  throw new Error("mode mismatch");
}

describe("keyframe edits golden", () => {
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const got = applyOp(c.input, c.op, c.args);
      assertTrackEqIgnoringIds(got, c.expect);
    });
  }
});
```

- [ ] **Step 3: Run the TS golden test, verify it passes**

Run: `cd apps/desktop && npx vitest run src/keyframe/edits.golden.test.ts`
Expected: PASS (7 cases). If a smoothing case fails on BOTH languages, the fixture's hand-authored expect is wrong — recompute and fix the fixture.

- [ ] **Step 4: Add the Rust golden test**

Append to `apps/desktop/src-tauri/src/state/keyframe_edits.rs` inside `mod tests`:

```rust
    use crate::state::animated::Interpolation as I;

    #[derive(serde::Deserialize)]
    struct GoldenArgs {
        t_us: Option<i64>,
        value: Option<f64>,
        id: Option<String>,
        fallback: Option<f64>,
        new_t_us: Option<i64>,
        interp: Option<Interpolation>,
    }
    #[derive(serde::Deserialize)]
    struct GoldenCase {
        name: String,
        op: String,
        args: GoldenArgs,
        input: Animated<f64>,
        expect: Animated<f64>,
    }
    #[derive(serde::Deserialize)]
    struct GoldenFixture {
        cases: Vec<GoldenCase>,
    }

    fn apply_op(track: &Animated<f64>, op: &str, args: &GoldenArgs) -> Animated<f64> {
        let id = || uuid::Uuid::parse_str(args.id.as_ref().unwrap()).unwrap();
        match op {
            "upsert" => upsert(track, args.t_us.unwrap(), args.value.unwrap(), None),
            "remove" => remove(track, id(), args.fallback.unwrap()),
            "retime" => retime(track, id(), args.new_t_us.unwrap()),
            "set_interp" => set_interp(track, id(), args.interp.unwrap()),
            "smooth_one" => smooth_one(track, id()),
            other => panic!("unknown op {other}"),
        }
    }

    fn interp_eq(a: Interpolation, b: Interpolation) -> bool {
        match (a, b) {
            (I::Bezier { p1: a1, p2: a2 }, I::Bezier { p1: b1, p2: b2 }) => {
                (a1.0 - b1.0).abs() < 1e-9
                    && (a1.1 - b1.1).abs() < 1e-9
                    && (a2.0 - b2.0).abs() < 1e-9
                    && (a2.1 - b2.1).abs() < 1e-9
            }
            (x, y) => std::mem::discriminant(&x) == std::mem::discriminant(&y),
        }
    }

    /// Same fixture as `keyframe/edits.golden.test.ts`; a change that passes one
    /// language and fails the other is a Rust↔TS drift, which is what this catches.
    #[test]
    fn golden_vectors_match_fixture() {
        let fixture: GoldenFixture = serde_json::from_str(include_str!(
            "../../../src/keyframe/keyframeEditsGolden.fixture.json"
        ))
        .expect("fixture parses");
        assert!(!fixture.cases.is_empty());
        for c in &fixture.cases {
            let got = apply_op(&c.input, &c.op, &c.args);
            match (&got, &c.expect) {
                (Animated::Static(g), Animated::Static(w)) => {
                    assert!((g - w).abs() < 1e-9, "case `{}` static value", c.name);
                }
                (Animated::Keyframed(g), Animated::Keyframed(w)) => {
                    assert_eq!(g.len(), w.len(), "case `{}` key count", c.name);
                    for (gk, wk) in g.iter().zip(w.iter()) {
                        assert_eq!(gk.t_us, wk.t_us, "case `{}` t_us", c.name);
                        assert!((gk.value - wk.value).abs() < 1e-9, "case `{}` value", c.name);
                        assert!(interp_eq(gk.interp, wk.interp), "case `{}` interp", c.name);
                    }
                }
                _ => panic!("case `{}` mode mismatch", c.name),
            }
        }
    }
```

- [ ] **Step 5: Run the Rust golden test, verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml golden_vectors_match_fixture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/keyframe/keyframeEditsGolden.fixture.json apps/desktop/src/keyframe/edits.golden.test.ts apps/desktop/src-tauri/src/state/keyframe_edits.rs
git commit -m "$(cat <<'EOF'
test(keyframe): cross-language golden fixture for keyframe edits

Locks Rust state/keyframe_edits.rs to TS keyframe/edits.ts: shared
fixture asserted by both languages, ids ignored, coords 1e-9 tolerance.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Immutable param resolver

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/layer.rs`

The MCP read path needs `&Animated<f64>` from `&LayerParams`. Today only the `_mut` sibling exists.

- [ ] **Step 1: Add the immutable resolver**

In `apps/desktop/src-tauri/src/state/layer.rs`, directly above `pub(crate) fn resolve_animated_f64_mut`, add:

```rust
/// Immutable sibling of `resolve_animated_f64_mut` — read a param's
/// `Animated<f64>` for the MCP keyframe read path. Same key vocabulary.
pub(crate) fn resolve_animated_f64<'a>(
    params: &'a LayerParams,
    key: &str,
) -> Option<&'a Animated<f64>> {
    match params {
        LayerParams::VideoClip(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::ImageOverlay(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::Text(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::Motif(p) => transform_or_opacity_ref(&p.transform, &p.opacity, key),
        LayerParams::Audio(p) => match key {
            "gain_db" => Some(&p.gain_db),
            "pan" => Some(&p.pan),
            _ => None,
        },
        LayerParams::Subtitles(_) | LayerParams::Color(_) => None,
    }
}

fn transform_or_opacity_ref<'a>(
    t: &'a Transform,
    opacity: &'a Animated<f64>,
    key: &str,
) -> Option<&'a Animated<f64>> {
    match key {
        "x" => Some(&t.x),
        "y" => Some(&t.y),
        "scale_x" => Some(&t.scale_x),
        "scale_y" => Some(&t.scale_y),
        "rotation_deg" => Some(&t.rotation_deg),
        "opacity" => Some(opacity),
        _ => None,
    }
}
```

- [ ] **Step 2: Add a unit test**

In `apps/desktop/src-tauri/src/state/layer.rs`, inside the existing `mod kf_fields_tests`, add:

```rust
    #[test]
    fn immutable_resolver_matches_mut_keys() {
        let p = videoclip();
        for key in ["x", "y", "scale_x", "scale_y", "rotation_deg", "opacity"] {
            assert!(resolve_animated_f64(&p, key).is_some(), "videoclip ref should resolve {key}");
        }
        assert!(resolve_animated_f64(&p, "gain_db").is_none());
        assert!(resolve_animated_f64(&p, "bogus").is_none());
    }
```

- [ ] **Step 3: Run the test, verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml immutable_resolver_matches_mut_keys`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/state/layer.rs
git commit -m "$(cat <<'EOF'
feat(state): add immutable resolve_animated_f64 for the MCP read path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: MCP keyframe helper module

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/keyframes.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (register `mod keyframes;` only)

The free `async fn` helpers hold the testable core: snapshot → timeline→local conversion → pure transform → `update_layer_param_track`. They take `actor: Actor` (the tool wrappers pass `agent_actor()`; tests pass `Actor::User`).

- [ ] **Step 1: Register the submodule**

In `apps/desktop/src-tauri/src/mcp/mod.rs`, next to `mod events;` / `mod prompts;` (around line 57), add:

```rust
mod keyframes;
```

- [ ] **Step 2: Write `mcp/keyframes.rs` (args, error, helpers)**

Create `apps/desktop/src-tauri/src/mcp/keyframes.rs`:

```rust
//! MCP keyframe authoring: arg structs + testable free helpers. The `#[tool]`
//! wrapper methods live in `mcp/mod.rs` (the `#[tool(tool_box)]` macro requires
//! them inside the `WeftCutServer` impl); they parse args and call these.
//!
//! All times are TIMELINE-ABSOLUTE microseconds; helpers convert to layer-local
//! (`t - layer.t_start_us`) before the write. Each helper does snapshot → pure
//! transform (`state::keyframe_edits`) → `update_layer_param_track`, reusing the
//! actor's normalization / validation / lock check / history. Not atomic against
//! a concurrent UI edit — acceptable (every MCP edit tool is the same, and
//! agent-mode puts the human UI in record-only).

use rmcp::Error as McpError;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::state::animated::{Animated, Keyframe};
use crate::state::ids::KeyframeId;
use crate::state::keyframe_edits;
use crate::state::layer::resolve_animated_f64;
use crate::state::{Actor, CommandError, LayerId, ProjectHandle};

// ---- arg structs ----------------------------------------------------------
// `interp` / `track` are `serde_json::Value` because `Interpolation` and
// `Animated<f64>` don't derive `JsonSchema` (imbl::Vector has no impl); the
// wrapper deserializes them into typed values before calling the helpers.

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct GetParamTrackArgs {
    pub layer_id: String,
    pub param_key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetKeyframeArgs {
    pub layer_id: String,
    pub param_key: String,
    pub t_us: i64,
    pub value: f64,
    pub interp: Option<Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RemoveKeyframeArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RetimeKeyframeArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: String,
    pub t_us: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetKeyframeEasingArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: String,
    pub interp: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SmoothKeyframesArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ClearKeyframesArgs {
    pub layer_id: String,
    pub param_key: String,
    pub value: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetParamTrackArgs {
    pub layer_id: String,
    pub param_key: String,
    pub track: Value,
}

// ---- errors ---------------------------------------------------------------

#[derive(Debug)]
pub(super) enum KfError {
    Command(CommandError),
    KeyframeNotFound { layer: LayerId, param: String, keyframe_id: KeyframeId },
}

impl From<CommandError> for KfError {
    fn from(e: CommandError) -> Self {
        KfError::Command(e)
    }
}

pub(super) fn kf_error_to_mcp(e: KfError) -> McpError {
    match e {
        KfError::Command(c) => super::map_command_error(c),
        KfError::KeyframeNotFound { layer, param, keyframe_id } => McpError::invalid_params(
            format!("keyframe {keyframe_id} not found on layer {layer} param '{param}'"),
            None,
        ),
    }
}

// ---- shared read step -----------------------------------------------------

/// Read `(layer.t_start_us, current track clone)` for `(layer, param_key)` from
/// a fresh snapshot, or a CommandError-flavored `KfError` if the layer is
/// missing / the param isn't animatable.
async fn read_track(
    project: &ProjectHandle,
    layer_id: LayerId,
    param_key: &str,
) -> Result<(i64, Animated<f64>), KfError> {
    let snap = project.snapshot().await;
    let layer = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .find(|l| l.id == layer_id)
        .ok_or(KfError::Command(CommandError::LayerNotFound { layer: layer_id }))?;
    let track = resolve_animated_f64(&layer.params, param_key)
        .ok_or_else(|| {
            KfError::Command(CommandError::UnknownKeyframeParam {
                layer: layer_id,
                param_key: param_key.to_string(),
            })
        })?
        .clone();
    Ok((layer.t_start_us, track))
}

fn require_key(
    track: &Animated<f64>,
    layer: LayerId,
    param: &str,
    id: KeyframeId,
) -> Result<(), KfError> {
    let present = matches!(track, Animated::Keyframed(kfs) if kfs.iter().any(|k| k.id == id));
    if present {
        Ok(())
    } else {
        Err(KfError::KeyframeNotFound { layer, param: param.to_string(), keyframe_id: id })
    }
}

// ---- helpers --------------------------------------------------------------

pub(super) async fn get_param_track(
    project: &ProjectHandle,
    layer_id: LayerId,
    param_key: &str,
) -> Result<Value, KfError> {
    let (t_start_us, track) = read_track(project, layer_id, param_key).await?;
    Ok(match track {
        Animated::Static(v) => json!({ "mode": "Static", "value": v }),
        Animated::Keyframed(kfs) => {
            let keyframes: Vec<Value> = kfs
                .iter()
                .map(|k| {
                    json!({
                        "id": k.id.to_string(),
                        "t_us": k.t_us + t_start_us,
                        "t_local_us": k.t_us,
                        "value": k.value,
                        "interp": k.interp,
                    })
                })
                .collect();
            json!({ "mode": "Keyframed", "keyframes": keyframes })
        }
    })
}

pub(super) async fn set_keyframe(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    t_us: i64,
    value: f64,
    interp: Option<crate::state::animated::Interpolation>,
) -> Result<(), KfError> {
    let (t_start_us, track) = read_track(project, layer_id, param_key).await?;
    let new = keyframe_edits::upsert(&track, t_us - t_start_us, value, interp);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn remove_keyframe(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: KeyframeId,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    require_key(&track, layer_id, param_key, keyframe_id)?;
    let new = keyframe_edits::remove(&track, keyframe_id, 0.0);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn retime_keyframe(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: KeyframeId,
    t_us: i64,
) -> Result<(), KfError> {
    let (t_start, track) = read_track(project, layer_id, param_key).await?;
    require_key(&track, layer_id, param_key, keyframe_id)?;
    let new = keyframe_edits::retime(&track, keyframe_id, t_us - t_start);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn set_keyframe_easing(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: KeyframeId,
    interp: crate::state::animated::Interpolation,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    require_key(&track, layer_id, param_key, keyframe_id)?;
    let new = keyframe_edits::set_interp(&track, keyframe_id, interp);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn smooth_keyframes(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: Option<KeyframeId>,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    let new = match keyframe_id {
        Some(id) => {
            require_key(&track, layer_id, param_key, id)?;
            keyframe_edits::smooth_one(&track, id)
        }
        None => keyframe_edits::smooth_all(&track),
    };
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn clear_keyframes(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    value: Option<f64>,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    let new = match (&track, value) {
        (Animated::Static(_), _) => return Ok(()), // already static — no-op
        (Animated::Keyframed(_), Some(v)) => Animated::Static(v),
        (Animated::Keyframed(kfs), None) => {
            Animated::Static(kfs.front().map(|k| k.value).unwrap_or(0.0))
        }
    };
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn set_param_track(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    mut track: Animated<f64>,
) -> Result<(), KfError> {
    // Validate the param + get t_start, then convert incoming (timeline-absolute)
    // keyframe times to layer-local.
    let (t_start, _current) = read_track(project, layer_id, param_key).await?;
    if let Animated::Keyframed(kfs) = &mut track {
        *kfs = kfs
            .iter()
            .map(|k| Keyframe { t_us: k.t_us - t_start, ..k.clone() })
            .collect();
    }
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), track)
        .await?;
    Ok(())
}
```

- [ ] **Step 3: Add the tokio smoke tests at the bottom of `mcp/keyframes.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::actor::spawn;
    use crate::state::ids::new_id;
    use crate::state::{LayerParams, MotifParams, Project, Transform};

    /// A blank project with one Motif layer (opacity is animatable) at
    /// t_start = 2_000_000. Returns the handle + layer id.
    async fn motif_project() -> (ProjectHandle, LayerId) {
        let handle = spawn(Project::new_blank("kf-test"));
        let track_id = handle
            .add_track(Actor::User, Some("kf".into()))
            .await
            .expect("add_track");
        let params = LayerParams::Motif(MotifParams {
            motif_id: "countdown".into(),
            motif_version: 1,
            props: imbl::HashMap::new(),
            src_in_us: 0,
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
        });
        let layer_id = handle
            .add_layer(Actor::User, track_id, params, 2_000_000, 7_000_000)
            .await
            .expect("add_layer");
        (handle, layer_id)
    }

    #[tokio::test]
    async fn set_get_remove_roundtrip_with_timeline_absolute_times() {
        let (handle, layer_id) = motif_project().await;
        set_keyframe(&handle, Actor::User, layer_id, "opacity", 2_000_000, 0.0, None)
            .await
            .unwrap();
        set_keyframe(&handle, Actor::User, layer_id, "opacity", 4_000_000, 1.0, None)
            .await
            .unwrap();

        let v = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        assert_eq!(v["mode"], "Keyframed");
        let kfs = v["keyframes"].as_array().unwrap();
        assert_eq!(kfs.len(), 2);
        // Timeline-absolute in, timeline-absolute out; layer-local is t - t_start.
        assert_eq!(kfs[0]["t_us"], 2_000_000);
        assert_eq!(kfs[0]["t_local_us"], 0);
        assert_eq!(kfs[1]["t_us"], 4_000_000);
        assert_eq!(kfs[1]["t_local_us"], 2_000_000);

        // Remove the first key by id → one key left.
        let id0: KeyframeId = kfs[0]["id"].as_str().unwrap().parse().unwrap();
        remove_keyframe(&handle, Actor::User, layer_id, "opacity", id0)
            .await
            .unwrap();
        let v2 = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        let kfs2 = v2["keyframes"].as_array().unwrap();
        assert_eq!(kfs2.len(), 1);

        // Remove the last key → collapses to Static holding its value (1.0).
        let id1: KeyframeId = kfs2[0]["id"].as_str().unwrap().parse().unwrap();
        remove_keyframe(&handle, Actor::User, layer_id, "opacity", id1)
            .await
            .unwrap();
        let v3 = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        assert_eq!(v3["mode"], "Static");
        assert_eq!(v3["value"], 1.0);
    }

    #[tokio::test]
    async fn remove_unknown_keyframe_errors() {
        let (handle, layer_id) = motif_project().await;
        set_keyframe(&handle, Actor::User, layer_id, "opacity", 2_000_000, 0.0, None)
            .await
            .unwrap();
        let res = remove_keyframe(&handle, Actor::User, layer_id, "opacity", new_id()).await;
        assert!(matches!(res, Err(KfError::KeyframeNotFound { .. })));
    }

    #[tokio::test]
    async fn keyframe_on_non_animatable_param_errors() {
        let (handle, layer_id) = motif_project().await;
        // Motif has no gain_db.
        let res = set_keyframe(&handle, Actor::User, layer_id, "gain_db", 0, 0.0, None).await;
        assert!(matches!(
            res,
            Err(KfError::Command(CommandError::UnknownKeyframeParam { .. }))
        ));
    }
}
```

- [ ] **Step 4: Build + run the smoke tests, verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml mcp::keyframes::tests`
Expected: PASS (3 tests). If `Project::new_blank` is not visible from this module, use the same constructor the actor tests use; it is `pub(crate)` in the same crate so it resolves.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/keyframes.rs apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "$(cat <<'EOF'
feat(mcp): keyframe helper module (args, errors, read-modify-write)

Testable free async fns over update_layer_param_track; timeline-absolute
times; KeyframeNotFound + CommandError mapping. Tool wrappers next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire the `#[tool]` methods

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs`

Add eight thin wrappers inside the `#[tool(tool_box)] impl WeftCutServer` block (e.g. after `duplicate_layer`, around line 1176). They parse args, deserialize `Value` fields into typed values, call the helper, and map errors.

- [ ] **Step 1: Add the keyframe tool methods**

In `apps/desktop/src-tauri/src/mcp/mod.rs`, inside the impl block, add:

```rust
    // ============================================================
    // Keyframe tools — author Animated<f64> params for an agent.
    // Times are TIMELINE-ABSOLUTE microseconds. Valid param_key per kind:
    //   VideoClip/Motif: x, y, scale_x, scale_y, rotation_deg, opacity
    //   ImageOverlay/Text: x, y, rotation_deg, opacity
    //   Audio: gain_db, pan
    // ============================================================

    #[tool(description = "Read a layer param's animation track, flattened for editing. Returns \
                          {\"mode\":\"Static\",\"value\":n} or {\"mode\":\"Keyframed\",\"keyframes\":[{id, \
                          t_us, t_local_us, value, interp}]}. `t_us` is timeline-absolute; `t_local_us` is \
                          layer-local (the stored base). Use this to discover keyframe ids before editing.")]
    async fn get_param_track(
        &self,
        #[tool(aggr)] args: keyframes::GetParamTrackArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let value = keyframes::get_param_track(&self.project, layer_id, &args.param_key)
            .await
            .map_err(keyframes::kf_error_to_mcp)?;
        ok_json(&value)
    }

    #[tool(description = "Insert or update a keyframe on a layer param. `t_us` is timeline-absolute. \
                          A Static track is lifted to Keyframed. An existing key at the same frame is \
                          updated in place. `interp` (optional) sets the easing for the segment leaving \
                          this key (e.g. {\"kind\":\"Linear\"}, {\"kind\":\"EaseIn\"}, \
                          {\"kind\":\"Bezier\",\"p1\":[x,y],\"p2\":[x,y]}); omit to inherit the preceding \
                          key's easing (or Linear).")]
    async fn set_keyframe(
        &self,
        #[tool(aggr)] args: keyframes::SetKeyframeArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let interp = match args.interp {
            Some(v) => Some(
                serde_json::from_value::<crate::state::animated::Interpolation>(v)
                    .map_err(|e| McpError::invalid_params(format!("invalid interp: {e}"), None))?,
            ),
            None => None,
        };
        keyframes::set_keyframe(
            &self.project,
            agent_actor(),
            layer_id,
            &args.param_key,
            args.t_us,
            args.value,
            interp,
        )
        .await
        .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }

    #[tool(description = "Remove a keyframe by id from a layer param. Get the id from get_param_track. \
                          When it was the last key, the track collapses to Static holding that key's value.")]
    async fn remove_keyframe(
        &self,
        #[tool(aggr)] args: keyframes::RemoveKeyframeArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let keyframe_id = parse_uuid(&args.keyframe_id, "keyframe_id")?;
        keyframes::remove_keyframe(&self.project, agent_actor(), layer_id, &args.param_key, keyframe_id)
            .await
            .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }

    #[tool(description = "Move a keyframe to a new timeline-absolute time. The track re-sorts.")]
    async fn retime_keyframe(
        &self,
        #[tool(aggr)] args: keyframes::RetimeKeyframeArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let keyframe_id = parse_uuid(&args.keyframe_id, "keyframe_id")?;
        keyframes::retime_keyframe(
            &self.project,
            agent_actor(),
            layer_id,
            &args.param_key,
            keyframe_id,
            args.t_us,
        )
        .await
        .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }

    #[tool(description = "Set the easing of the segment leaving a keyframe. `interp`: {\"kind\":\"Hold\"} | \
                          {\"kind\":\"Linear\"} | {\"kind\":\"EaseIn\"} | {\"kind\":\"EaseOut\"} | \
                          {\"kind\":\"Bezier\",\"p1\":[x,y],\"p2\":[x,y]}.")]
    async fn set_keyframe_easing(
        &self,
        #[tool(aggr)] args: keyframes::SetKeyframeEasingArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let keyframe_id = parse_uuid(&args.keyframe_id, "keyframe_id")?;
        let interp = serde_json::from_value::<crate::state::animated::Interpolation>(args.interp)
            .map_err(|e| McpError::invalid_params(format!("invalid interp: {e}"), None))?;
        keyframes::set_keyframe_easing(
            &self.project,
            agent_actor(),
            layer_id,
            &args.param_key,
            keyframe_id,
            interp,
        )
        .await
        .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }

    #[tool(description = "Bake monotone (no-overshoot) smooth tangents. With `keyframe_id`, smooths that \
                          one key; without it, smooths the whole track.")]
    async fn smooth_keyframes(
        &self,
        #[tool(aggr)] args: keyframes::SmoothKeyframesArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let keyframe_id = match args.keyframe_id.as_deref() {
            Some(s) => Some(parse_uuid(s, "keyframe_id")?),
            None => None,
        };
        keyframes::smooth_keyframes(&self.project, agent_actor(), layer_id, &args.param_key, keyframe_id)
            .await
            .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }

    #[tool(description = "Collapse a param's animation back to a single Static value. `value` (optional) \
                          is the value to hold; when omitted, defaults to the first keyframe's value. \
                          No-op on an already-Static track.")]
    async fn clear_keyframes(
        &self,
        #[tool(aggr)] args: keyframes::ClearKeyframesArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        keyframes::clear_keyframes(&self.project, agent_actor(), layer_id, &args.param_key, args.value)
            .await
            .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }

    #[tool(description = "Low-level: replace a layer param's whole animation track. `track` is an \
                          AnimTrack<f64>: {\"mode\":\"Static\",\"value\":n} or \
                          {\"mode\":\"Keyframed\",\"value\":[{id, t_us, value, interp}]} with keyframe \
                          `t_us` timeline-absolute. Use the granular tools (set_keyframe etc.) unless you \
                          need bulk authoring.")]
    async fn set_param_track(
        &self,
        #[tool(aggr)] args: keyframes::SetParamTrackArgs,
    ) -> Result<CallToolResult, McpError> {
        let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
        let track = serde_json::from_value::<Animated<f64>>(args.track)
            .map_err(|e| McpError::invalid_params(format!("invalid track: {e}"), None))?;
        keyframes::set_param_track(&self.project, agent_actor(), layer_id, &args.param_key, track)
            .await
            .map_err(keyframes::kf_error_to_mcp)?;
        Ok(ok_void())
    }
```

- [ ] **Step 2: Build the crate, verify it compiles**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: builds clean. If `keyframes::map_command_error`-style visibility errors appear, confirm `map_command_error` and `agent_actor` are module-level `fn`s in `mcp/mod.rs` (they are) — `super::` resolves them from `keyframes.rs`.

- [ ] **Step 3: Run the full keyframe + mcp test set, verify pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml keyframe`
Expected: PASS (keyframe_edits unit tests + golden + mcp::keyframes smoke tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "$(cat <<'EOF'
feat(mcp): expose keyframe tools (get/set/remove/retime/ease/smooth/clear + set_param_track)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Document the keyframe tools

**Files:**
- Modify: `docs/mcp.md`

- [ ] **Step 1: Add the keyframe subsection**

In `docs/mcp.md`, immediately after the `Layers:` list (after the `duplicate_layer` line, before `Groups (see ...)`), insert:

```markdown
Keyframes (animate `Animated<f64>` params; times are timeline-absolute µs):
- `get_param_track { layer_id, param_key }` → `{ mode, value }` (Static) or `{ mode, keyframes: [{ id, t_us, t_local_us, value, interp }] }` (Keyframed). Read this to discover keyframe ids before editing.
- `set_keyframe { layer_id, param_key, t_us, value, interp? }` — insert-or-update. Lifts a Static track; updates in place at the same frame; `interp` omitted inherits the preceding key's easing (or Linear).
- `remove_keyframe { layer_id, param_key, keyframe_id }` — last key collapses to Static holding its value.
- `retime_keyframe { layer_id, param_key, keyframe_id, t_us }` — move a key; re-sorts.
- `set_keyframe_easing { layer_id, param_key, keyframe_id, interp }` — `interp` ∈ `Hold | Linear | EaseIn | EaseOut | Bezier{p1,p2}`.
- `smooth_keyframes { layer_id, param_key, keyframe_id? }` — monotone auto-smooth one key, or the whole track when `keyframe_id` is omitted.
- `clear_keyframes { layer_id, param_key, value? }` — collapse to Static (defaults to the first keyframe's value).
- `set_param_track { layer_id, param_key, track }` — low-level: replace the whole `AnimTrack<f64>` (keyframe `t_us` timeline-absolute).

Valid `param_key`: VideoClip/Motif → `x, y, scale_x, scale_y, rotation_deg, opacity`; ImageOverlay/Text → `x, y, rotation_deg, opacity`; Audio → `gain_db, pan`. Each write routes through the actor's `update_layer_param_track` (snap-to-frame, sort, dedupe, lock check). Unlike `update_layer_params`, these preserve/produce keyframes rather than wiping them.
```

- [ ] **Step 2: Verify the doc has no stray dates/phase markers**

Confirm the inserted text is evergreen (no dates, phase numbers, commit hashes) per memory `feedback_evergreen_docs`.

- [ ] **Step 3: Commit**

```bash
git add docs/mcp.md
git commit -m "$(cat <<'EOF'
docs(mcp): document the keyframe authoring tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Rust:** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml keyframe` → all green (transforms + golden + mcp smoke).
- [ ] **TS golden:** `cd apps/desktop && npx vitest run src/keyframe/edits.golden.test.ts` → 7 cases green.
- [ ] **TS typecheck:** `cd apps/desktop && npx tsc -b` → clean (the new test file typechecks against `../ipc`).
- [ ] **Manual MCP smoke (optional, real WebView2 via the dev mcp-bridge):** `set_keyframe` opacity 0→1 over a clip, `get_param_track` shows two keys, scrub the preview and confirm the fade renders — proves the actor write reaches the renderer.
- [ ] Confirm only intended paths were committed across all tasks (the parallel session owns `apps/desktop/src/i18n/locales/*.ts` — never staged here).

## Self-review notes (for the implementer)

- **Spec coverage:** §1 tools → Tasks 4+5; §2 architecture → Tasks 1,3,4,5; §4 drift fixture → Task 2; §6 testing → Tasks 1,2,4 + Final; §7 docs → Task 6. Out-of-scope items (Color/Rgba, atomic actor command, rotation_deg UI sub-lane, batch tool) are intentionally absent.
- **`rotation_deg`** is exposed via MCP though the timeline UI has no sub-lane for it (the renderer evaluates it). This is intentional per spec §1.
- **Time base:** every tool arg/output `t_us` is timeline-absolute; the helper converts (`t - layer.t_start_us`). The pure transforms and the golden fixture are purely layer-local — the conversion lives only in `mcp/keyframes.rs`.
- **No atomicity / generic undo labels:** accepted tradeoff (spec §3); do not add an `EditKeyframe` actor command in this plan.
