# Keyframe Authoring — Plan 1: Write Path + Trim/Split Transforms (Backend)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: SHIPPED — merged to local main (subagent-driven, 8 tasks).** Each task was
implemented + spec + code-quality reviewed, plus a final holistic review; cargo 572 /
vitest 527 / tsc all green; backend-only (zero UI/MCP drift). **Two additions surfaced
during implementation** (beyond the task list below): (1) the layer validator was
loosened to permit keyframe times outside `[0, duration]` — the `KeyframeOutOfRange`
check was removed — because §6's "out-of-range keys kept" rule needs it; (2) `split`
collapses an emptied half to `Static` at the clamp-boundary value (first/last-key
value) instead of leaving an empty `Keyframed` that renders as the engine fallback.
Plan 2 (authoring UI) builds on this.

**Goal:** Land the Rust + IPC foundation that lets a keyframe track be written, normalized, persisted (recorded/undoable), and kept content-anchored across trim and split — with no UI yet (dormant infra, verified by `cargo test`).

**Architecture:** A new actor op `update_layer_param_track` (+ batch `update_layer_param_tracks`) writes a whole `Animated<f64>` track to a named param on a layer, mirroring the existing `update_layer_params` wiring at every site. The actor normalizes the incoming track (sort / frame-snap / same-frame dedupe last-write-wins) and rejects empty `Keyframed` tracks, unknown params, and locked targets. A `param_key → &mut Animated<f64>` resolver (the Rust mirror of the frontend descriptor) maps `"x"/"y"/"scale_x"/"scale_y"/"opacity"/"gain_db"/"pan"` to the right field. Keyframe-preserving helpers on `Animated<T>` (`shift_keyframes`, `retain_keyframes`, `normalize_keyframes`) plus a per-kind field-walk (`for_each_animated_f64` / `_rgba`) are reused by `apply_trim_layer` (IN edge: shift all keyframes by `-Δ`) and `split_single_layer` (partition at the cut offset, rebase the right half).

**Tech Stack:** Rust (`imbl::Vector`, serde, tokio actor), `cargo test`. TS IPC wrapper (`invoke`). No new deps. This plan touches **no** UI and **no** MCP (keyframe MCP tools are out of scope per the spec).

**Spec:** `docs/superpowers/specs/2026-06-14-keyframe-authoring-design.md` (§3 write path, §6 trim/split).

---

## File Structure

- `apps/desktop/src-tauri/src/state/animated.rs` — **modify.** Add keyframe-mutation
  helpers (`shift_keyframes`, `retain_keyframes`, `normalize_keyframes`) + their unit
  tests next to the existing `value_at` tests.
- `apps/desktop/src-tauri/src/state/layer.rs` — **modify.** Add the param-walk helpers
  `for_each_animated_f64` / `for_each_animated_rgba` and the `resolve_animated_f64_mut`
  param-key resolver (the Rust mirror of the frontend descriptor) + unit tests.
- `apps/desktop/src-tauri/src/state/actor.rs` — **modify.** New `Command::UpdateLayerParamTrack`
  / `UpdateLayerParamTracks` + dispatch + `do_*` + `apply_update_layer_param_track(s)`;
  extend `apply_trim_layer` (IN edge) and `split_single_layer` to transform keyframes;
  two new `CommandError` variants; actor unit tests.
- `apps/desktop/src-tauri/src/commands.rs` — **modify.** Tauri commands
  `update_layer_param_track` / `update_layer_param_tracks` (mirror `update_layer_params`
  at line 1878).
- `apps/desktop/src-tauri/src/lib.rs` — **modify.** Register both in the `invoke_handler!`
  list (next to `commands::update_layer_params` at line 136).
- `apps/desktop/src/ipc/index.ts` — **modify.** Add `updateLayerParamTrack` /
  `updateLayerParamTracks` wrappers (mirror `updateLayerParams` at line 809).

All Rust commands run from `apps/desktop/src-tauri/`; all frontend commands from
`apps/desktop/`. Stage commits by explicit path (the checkout is edited from other
sessions concurrently); re-run `git status --short` before each commit. End commit
messages with the repo's `Co-Authored-By` trailer.

---

### Task 1: `Animated<T>` keyframe-mutation helpers

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/animated.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `mod tests` block in `apps/desktop/src-tauri/src/state/animated.rs`
(the `kf` / `keyframed` helpers already exist there):

```rust
    #[test]
    fn shift_keyframes_offsets_all_times() {
        let mut a = keyframed(vec![
            kf(1_000_000, 0.0, Interpolation::Linear),
            kf(3_000_000, 1.0, Interpolation::Linear),
        ]);
        a.shift_keyframes(-1_000_000);
        let Animated::Keyframed(kfs) = &a else { panic!("keyframed") };
        assert_eq!(kfs[0].t_us, 0);
        assert_eq!(kfs[1].t_us, 2_000_000);
    }

    #[test]
    fn shift_keyframes_noop_on_static() {
        let mut a: Animated<f64> = Animated::Static(5.0);
        a.shift_keyframes(1_000_000);
        assert!(matches!(a, Animated::Static(_)));
    }

    #[test]
    fn retain_keyframes_filters_by_time() {
        let mut a = keyframed(vec![
            kf(0, 0.0, Interpolation::Linear),
            kf(2_000_000, 1.0, Interpolation::Linear),
            kf(5_000_000, 2.0, Interpolation::Linear),
        ]);
        a.retain_keyframes(|t| t <= 2_000_000);
        let Animated::Keyframed(kfs) = &a else { panic!("keyframed") };
        assert_eq!(kfs.len(), 2);
        assert_eq!(kfs[1].t_us, 2_000_000);
    }

    #[test]
    fn normalize_sorts_snaps_and_dedupes_last_wins() {
        // Snap = round to 1_000_000 grid. Two keys land on the same snapped
        // time (900_000 and 1_100_000 -> 1_000_000); last (by input order
        // after a stable sort) wins.
        let snap = |t: TimeUs| ((t + 500_000) / 1_000_000) * 1_000_000;
        let mut a = keyframed(vec![
            kf(3_000_000, 3.0, Interpolation::Linear),
            kf(900_000, 1.0, Interpolation::Linear),
            kf(1_100_000, 2.0, Interpolation::Linear),
        ]);
        a.normalize_keyframes(snap).expect("non-empty keyframed normalizes");
        let Animated::Keyframed(kfs) = &a else { panic!("keyframed") };
        assert_eq!(kfs.len(), 2, "900k & 1100k collapse to one at 1_000_000");
        assert_eq!(kfs[0].t_us, 1_000_000);
        assert_eq!(kfs[0].value, 2.0, "last-write-wins among same-frame keys");
        assert_eq!(kfs[1].t_us, 3_000_000);
    }

    #[test]
    fn normalize_rejects_empty_keyframed() {
        let mut a: Animated<f64> = Animated::Keyframed(imbl::Vector::new());
        assert!(a.normalize_keyframes(|t| t).is_err());
    }

    #[test]
    fn normalize_noop_on_static() {
        let mut a: Animated<f64> = Animated::Static(2.0);
        assert!(a.normalize_keyframes(|t| t).is_ok());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib state::animated::tests::shift_keyframes_offsets_all_times state::animated::tests::normalize_sorts_snaps_and_dedupes_last_wins 2>&1 | tail -20`
Expected: FAIL — `no method named shift_keyframes` / `normalize_keyframes` found.

- [ ] **Step 3: Implement the helpers**

In `apps/desktop/src-tauri/src/state/animated.rs`, add an `impl<T: Clone>` block
(place it after the existing `impl<T: Clone> Animated<T>` block, before
`impl<T: Clone + PartialEq>`):

```rust
impl<T: Clone> Animated<T> {
    /// Shift every keyframe's `t_us` by `delta_us` (no-op on `Static`).
    /// Used by IN-edge trim and split to keep keyframes glued to content.
    pub fn shift_keyframes(&mut self, delta_us: TimeUs) {
        if let Animated::Keyframed(kfs) = self {
            *kfs = kfs
                .iter()
                .map(|k| Keyframe {
                    id: k.id,
                    t_us: k.t_us + delta_us,
                    value: k.value.clone(),
                    interp: k.interp,
                })
                .collect();
        }
    }

    /// Keep only keyframes whose `t_us` satisfies `keep` (no-op on `Static`).
    /// Used by split to partition keyframes between the two halves.
    pub fn retain_keyframes(&mut self, keep: impl Fn(TimeUs) -> bool) {
        if let Animated::Keyframed(kfs) = self {
            *kfs = kfs.iter().filter(|k| keep(k.t_us)).cloned().collect();
        }
    }

    /// Canonicalize a `Keyframed` track for storage: snap each `t_us` via
    /// `snap`, stable-sort by `t_us`, and dedupe same-time keys keeping the
    /// LAST (write order is preserved by the stable sort, so the later input
    /// keyframe wins). Returns `Err(())` for an empty `Keyframed` track (a
    /// keyframed property must hold at least one key — the caller turns this
    /// into a `CommandError`). `Static` is unchanged and always `Ok`.
    pub fn normalize_keyframes(
        &mut self,
        snap: impl Fn(TimeUs) -> TimeUs,
    ) -> Result<(), ()> {
        if let Animated::Keyframed(kfs) = self {
            if kfs.is_empty() {
                return Err(());
            }
            let mut v: Vec<Keyframe<T>> = kfs
                .iter()
                .map(|k| Keyframe {
                    id: k.id,
                    t_us: snap(k.t_us),
                    value: k.value.clone(),
                    interp: k.interp,
                })
                .collect();
            v.sort_by_key(|k| k.t_us); // stable
            let mut out: Vec<Keyframe<T>> = Vec::with_capacity(v.len());
            for k in v {
                match out.last_mut() {
                    Some(last) if last.t_us == k.t_us => *last = k,
                    _ => out.push(k),
                }
            }
            *kfs = out.into_iter().collect();
        }
        Ok(())
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib state::animated 2>&1 | tail -20`
Expected: PASS (the six new tests plus all existing `animated` tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/animated.rs
git commit -m "feat(state): Animated<T> keyframe-mutation helpers (shift/retain/normalize)"
```

---

### Task 2: Per-kind animated-field walk + `param_key` resolver

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/layer.rs`

The frontend descriptor (`animatableParams(kind)`) is mirrored on the Rust side here:
which `Animated<f64>` fields a kind has, and how a `param_key` string maps to the field.

- [ ] **Step 1: Write the failing tests**

Add a `#[cfg(test)] mod kf_fields_tests` block at the END of
`apps/desktop/src-tauri/src/state/layer.rs`:

```rust
#[cfg(test)]
mod kf_fields_tests {
    use super::*;
    use crate::state::animated::Animated;

    fn videoclip() -> LayerParams {
        LayerParams::VideoClip(VideoClipParams {
            media: crate::state::ids::new_id(),
            src_in_us: 0,
            src_out_us: 1_000_000,
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
            crop: None,
            flip_h: false,
            flip_v: false,
            blend_mode: BlendMode::default(),
            speed: 1.0,
            fade_in_us: 0,
            fade_out_us: 0,
        })
    }

    #[test]
    fn resolve_known_f64_keys_for_videoclip() {
        let mut p = videoclip();
        for key in ["x", "y", "scale_x", "scale_y", "opacity"] {
            assert!(
                resolve_animated_f64_mut(&mut p, key).is_some(),
                "videoclip should resolve {key}"
            );
        }
        assert!(resolve_animated_f64_mut(&mut p, "gain_db").is_none());
        assert!(resolve_animated_f64_mut(&mut p, "bogus").is_none());
    }

    #[test]
    fn for_each_animated_f64_visits_five_videoclip_fields() {
        let mut p = videoclip();
        let mut n = 0;
        for_each_animated_f64(&mut p, |_| n += 1);
        // transform x/y/scale_x/scale_y/rotation_deg (5) + opacity (1) = 6.
        assert_eq!(n, 6);
    }

    #[test]
    fn resolve_writes_through_to_the_field() {
        let mut p = videoclip();
        if let Some(track) = resolve_animated_f64_mut(&mut p, "opacity") {
            *track = Animated::Static(0.25);
        }
        let LayerParams::VideoClip(v) = &p else { panic!() };
        assert!(matches!(v.opacity, Animated::Static(x) if (x - 0.25).abs() < 1e-9));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib state::layer::kf_fields_tests 2>&1 | tail -20`
Expected: FAIL — `cannot find function resolve_animated_f64_mut` / `for_each_animated_f64`.

- [ ] **Step 3: Implement the walk + resolver**

In `apps/desktop/src-tauri/src/state/layer.rs`, add at module scope (after the
`LayerParams` enum / param structs, before the test module). Note: `x/y/scale_x/
scale_y/rotation_deg` live on `params.transform`; `opacity` is top-level on the
visual kinds; `gain_db/pan` are top-level on `AudioParams`.

```rust
use crate::state::animated::Animated;
use crate::state::color::Rgba;

/// Apply `f` to every `Animated<f64>` track on these params (transform x/y/
/// scale_x/scale_y/rotation_deg + opacity for visual kinds; gain_db/pan for
/// Audio). The Rust mirror of the frontend `animatableParams(kind)` descriptor.
/// Used by trim/split keyframe transforms. Color/Subtitles have no f64 track.
pub(crate) fn for_each_animated_f64(
    params: &mut LayerParams,
    mut f: impl FnMut(&mut Animated<f64>),
) {
    match params {
        LayerParams::VideoClip(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::ImageOverlay(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::Text(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::Motif(p) => {
            visit_transform_f64(&mut p.transform, &mut f);
            f(&mut p.opacity);
        }
        LayerParams::Audio(p) => {
            f(&mut p.gain_db);
            f(&mut p.pan);
        }
        LayerParams::Subtitles(_) | LayerParams::Color(_) => {}
    }
}

fn visit_transform_f64(t: &mut Transform, f: &mut impl FnMut(&mut Animated<f64>)) {
    f(&mut t.x);
    f(&mut t.y);
    f(&mut t.scale_x);
    f(&mut t.scale_y);
    f(&mut t.rotation_deg);
}

/// Apply `f` to every `Animated<Rgba>` track on these params (Text color,
/// Color color). Separate from the f64 walk because the inner type differs.
/// v1 has no Rgba authoring UI, but trim/split must still carry color
/// keyframes if any exist.
pub(crate) fn for_each_animated_rgba(
    params: &mut LayerParams,
    mut f: impl FnMut(&mut Animated<Rgba>),
) {
    match params {
        LayerParams::Text(p) => f(&mut p.color),
        LayerParams::Color(p) => f(&mut p.color),
        _ => {}
    }
}

/// Resolve a `param_key` string to its `Animated<f64>` field for writing.
/// `None` for an unknown key or a key not valid on this kind. The animatable
/// set per kind matches the spec §1 / the frontend descriptor.
pub(crate) fn resolve_animated_f64_mut<'a>(
    params: &'a mut LayerParams,
    key: &str,
) -> Option<&'a mut Animated<f64>> {
    match params {
        LayerParams::VideoClip(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::ImageOverlay(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::Text(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::Motif(p) => transform_or_opacity(&mut p.transform, &mut p.opacity, key),
        LayerParams::Audio(p) => match key {
            "gain_db" => Some(&mut p.gain_db),
            "pan" => Some(&mut p.pan),
            _ => None,
        },
        LayerParams::Subtitles(_) | LayerParams::Color(_) => None,
    }
}

fn transform_or_opacity<'a>(
    t: &'a mut Transform,
    opacity: &'a mut Animated<f64>,
    key: &str,
) -> Option<&'a mut Animated<f64>> {
    match key {
        "x" => Some(&mut t.x),
        "y" => Some(&mut t.y),
        "scale_x" => Some(&mut t.scale_x),
        "scale_y" => Some(&mut t.scale_y),
        "rotation_deg" => Some(&mut t.rotation_deg),
        "opacity" => Some(opacity),
        _ => None,
    }
}
```

(If `crate::state::color::Rgba` is already imported at the top of `layer.rs`,
drop the duplicate `use`; `cargo` will warn on a redundant import. Confirm the
existing import path for `Rgba` — `TextParams.color: Animated<Rgba>` already
references it, so the type is in scope under some path; reuse that path.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib state::layer::kf_fields_tests 2>&1 | tail -20`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/layer.rs
git commit -m "feat(state): per-kind animated-field walk + param_key resolver"
```

---

### Task 3: `CommandError` variants for keyframe writes

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (the `CommandError` enum)

- [ ] **Step 1: Add the variants**

Find the `pub enum CommandError` definition in `apps/desktop/src-tauri/src/state/actor.rs`
(it already holds `LayerNotFound`, `TrackLocked`, `SplitOutsideLayer`,
`TrimEdgeOutOfRange`, etc.). Add two variants, matching the existing `#[error(...)]`
`thiserror` style used by its siblings:

```rust
    #[error("keyframe track on layer {layer} param `{param_key}` is empty")]
    EmptyKeyframeTrack { layer: LayerId, param_key: String },

    #[error("param `{param_key}` is not animatable on layer {layer}")]
    UnknownKeyframeParam { layer: LayerId, param_key: String },
```

- [ ] **Step 2: Typecheck (compile)**

Run: `cargo check --lib 2>&1 | tail -20`
Expected: PASS (the enum compiles; no consumer yet). If `CommandError` is matched
exhaustively anywhere without a wildcard arm, the compiler will name the file —
add the two arms there mapping to a sensible existing branch (these are
validation errors, treat like `TrackLocked`: surfaced to the caller as a string).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(state): CommandError variants for keyframe-track writes"
```

---

### Task 4: `apply_update_layer_param_track` + actor op wiring

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

Mirror the `update_layer_params` wiring at every site. The new op carries a
`param_key: String` and a `track: Animated<f64>`.

- [ ] **Step 1: Write the failing actor test**

Add to the actor `#[cfg(test)] mod tests` in `actor.rs` (these tests build a project
via the same helpers the existing actor tests use — find an existing test like
`update_layer_params_seconds_grow_does_not_resize_layer` near line 8972 and copy its
project/layer setup boilerplate for the fixture):

```rust
    #[tokio::test]
    async fn update_layer_param_track_writes_and_normalizes() {
        // Build a project with one VideoClip layer (reuse the existing test
        // fixture helper used by update_layer_params_* tests).
        let (handle, layer_id) = single_videoclip_project().await;

        // A keyframed opacity track with out-of-order, same-frame keys.
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: new_id(), t_us: 2_000_000, value: 1.0, interp: Interpolation::Linear },
                Keyframe { id: new_id(), t_us: 0, value: 0.0, interp: Interpolation::Linear },
            ]
            .into_iter()
            .collect(),
        );
        handle
            .update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await
            .expect("write opacity track");

        let summary = handle.project_summary();
        let layer = find_layer(&summary, layer_id);
        // Round-trips as Keyframed, sorted ascending.
        // (Assert via the summary's AnimTrack for opacity — sorted [0, 2_000_000].)
        assert_keyframed_sorted(&layer, "opacity", &[0, 2_000_000]);
    }

    #[tokio::test]
    async fn update_layer_param_track_rejects_empty_keyframed() {
        let (handle, layer_id) = single_videoclip_project().await;
        let empty = Animated::Keyframed(imbl::Vector::new());
        let res = handle
            .update_layer_param_track(Actor::User, layer_id, "opacity".into(), empty)
            .await;
        assert!(matches!(res, Err(CommandError::EmptyKeyframeTrack { .. })));
    }

    #[tokio::test]
    async fn update_layer_param_track_rejects_unknown_param() {
        let (handle, layer_id) = single_videoclip_project().await;
        let res = handle
            .update_layer_param_track(Actor::User, layer_id, "bogus".into(), Animated::Static(1.0))
            .await;
        assert!(matches!(res, Err(CommandError::UnknownKeyframeParam { .. })));
    }
```

> **Fixture note:** if `single_videoclip_project()`, `find_layer()`, and
> `assert_keyframed_sorted()` helpers don't already exist in the test module,
> add them as small local helpers. `single_videoclip_project` builds an
> `Actor`-handle project containing one track + one VideoClip layer (mirror the
> setup inside `update_layer_params_seconds_grow_does_not_resize_layer`).
> `assert_keyframed_sorted` reads the layer's `params` opacity `AnimTrack` and
> asserts `mode == Keyframed` with the given ascending `t_us` list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib state::actor::tests::update_layer_param_track 2>&1 | tail -20`
Expected: FAIL — `no method named update_layer_param_track`.

- [ ] **Step 3: Wire the op (mirror `update_layer_params`)**

In `apps/desktop/src-tauri/src/state/actor.rs`:

(a) `Command` enum (near line 493, where `UpdateLayerParams { … }` lives) — add:

```rust
    UpdateLayerParamTrack {
        id: LayerId,
        param_key: String,
        track: Animated<f64>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateLayerParamTracks {
        id: LayerId,
        entries: Vec<(String, Animated<f64>)>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
```

(match the exact field shape of the neighbouring `UpdateLayerParams` variant —
`reply` channel type, `actor` placement; copy it and swap the payload).

(b) Public actor-handle methods (near line 1053, beside `pub async fn update_layer_params`):

```rust
    pub async fn update_layer_param_track(
        &self,
        actor: Actor,
        id: LayerId,
        param_key: String,
        track: Animated<f64>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateLayerParamTrack { id, param_key, track, actor, reply })
            .await
            .map_err(|_| CommandError::ActorGone)?;
        rx.await.map_err(|_| CommandError::ActorGone)?
    }

    pub async fn update_layer_param_tracks(
        &self,
        actor: Actor,
        id: LayerId,
        entries: Vec<(String, Animated<f64>)>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateLayerParamTracks { id, entries, actor, reply })
            .await
            .map_err(|_| CommandError::ActorGone)?;
        rx.await.map_err(|_| CommandError::ActorGone)?
    }
```

(Use the exact error/`send`/`await` idiom of the neighbouring `update_layer_params`
method — `CommandError::ActorGone` is illustrative; copy whatever the sibling uses.)

(c) Run-loop dispatch (near line 1665, beside the `Command::UpdateLayerParams` arm):

```rust
            Command::UpdateLayerParamTrack { id, param_key, track, actor, reply } => {
                let result = self.do_update_layer_param_track(id, param_key, track, actor);
                let _ = reply.send(result);
            }
            Command::UpdateLayerParamTracks { id, entries, actor, reply } => {
                let result = self.do_update_layer_param_tracks(id, entries, actor);
                let _ = reply.send(result);
            }
```

(d) `do_*` methods (beside `do_update_layer_params` near line 2197):

```rust
    fn do_update_layer_param_track(
        &mut self,
        id: LayerId,
        param_key: String,
        track: Animated<f64>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        apply_update_layer_param_track(&mut next, id, &param_key, track)?;
        self.commit(
            next,
            actor,
            format!("Keyframed layer {id} param {param_key}"),
            vec![EntityRef::Layer(id)],
            DiffHint::Layer(id),
        )?;
        Ok(())
    }

    fn do_update_layer_param_tracks(
        &mut self,
        id: LayerId,
        entries: Vec<(String, Animated<f64>)>,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        for (param_key, track) in &entries {
            apply_update_layer_param_track(&mut next, id, param_key, track.clone())?;
        }
        self.commit(
            next,
            actor,
            format!("Keyframed layer {id} ({} params)", entries.len()),
            vec![EntityRef::Layer(id)],
            DiffHint::Layer(id),
        )?;
        Ok(())
    }
```

(e) The `apply_*` function (free fn, beside `apply_update_layer_params` near line 3509):

```rust
/// Write a whole `Animated<f64>` track to a named param on a layer. Normalizes
/// the track (snap each keyframe to the composition frame grid, sort, dedupe
/// same-frame keeping last). Rejects: locked track, unknown/non-animatable
/// param, empty `Keyframed` track. Recorded by the caller.
pub(crate) fn apply_update_layer_param_track(
    project: &mut Project,
    id: LayerId,
    param_key: &str,
    mut track: Animated<f64>,
) -> Result<(), CommandError> {
    check_track_lock(project, id)?;
    let fps = project.composition.fps;
    track
        .normalize_keyframes(|t| crate::state::time::snap_frame_round(t, fps))
        .map_err(|()| CommandError::EmptyKeyframeTrack {
            layer: id,
            param_key: param_key.to_string(),
        })?;
    let (ti, li) = project
        .tracks
        .iter()
        .enumerate()
        .find_map(|(ti, t)| t.layers.iter().position(|l| l.id == id).map(|li| (ti, li)))
        .ok_or(CommandError::LayerNotFound { layer: id })?;
    let slot = crate::state::layer::resolve_animated_f64_mut(
        &mut project.tracks[ti].layers[li].params,
        param_key,
    )
    .ok_or_else(|| CommandError::UnknownKeyframeParam {
        layer: id,
        param_key: param_key.to_string(),
    })?;
    *slot = track;
    apply_duration_autofit(project);
    Ok(())
}
```

(`check_track_lock`, `apply_duration_autofit`, `EntityRef`, `DiffHint`,
`snap_frame_round` are all already used by the neighbouring code — same imports.)

In `apps/desktop/src-tauri/src/commands.rs` (mirror `update_layer_params` at line 1878):

```rust
#[tauri::command]
pub async fn update_layer_param_track(
    state: tauri::State<'_, AppState>,
    layer_id: String,
    param_key: String,
    track: crate::state::animated::Animated<f64>,
) -> Result<(), String> {
    let id = parse_layer_id(&layer_id)?;
    state
        .actor
        .update_layer_param_track(Actor::User, id, param_key, track)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_layer_param_tracks(
    state: tauri::State<'_, AppState>,
    layer_id: String,
    entries: Vec<(String, crate::state::animated::Animated<f64>)>,
) -> Result<(), String> {
    let id = parse_layer_id(&layer_id)?;
    state
        .actor
        .update_layer_param_tracks(Actor::User, id, entries)
        .await
        .map_err(|e| e.to_string())
}
```

(Use the exact `State` type, `parse_layer_id` helper, and `Actor::User` form of the
neighbouring `update_layer_params` command — copy its signature shell.)

In `apps/desktop/src-tauri/src/lib.rs` (line 136 area, the `tauri::generate_handler!`
list), add both:

```rust
            commands::update_layer_param_track,
            commands::update_layer_param_tracks,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib state::actor::tests::update_layer_param_track 2>&1 | tail -30`
Expected: PASS (write+normalize, empty-reject, unknown-param-reject).

- [ ] **Step 5: Full Rust build + clippy**

Run: `cargo check --lib && cargo test --lib 2>&1 | tail -15`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(state): update_layer_param_track(s) actor op + tauri commands"
```

---

### Task 5: Trim IN-edge keeps keyframes content-anchored

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (`apply_trim_layer`, IN-edge arm ~line 4080)

- [ ] **Step 1: Write the failing test**

Add to the actor `mod tests` (reuse the `single_videoclip_project` helper from Task 4;
the project's composition fps is whatever that helper sets — assert in frame-grid-safe
microsecond values):

```rust
    #[tokio::test]
    async fn trim_in_shifts_keyframes_to_stay_on_content() {
        // VideoClip layer at t_start=0, with opacity keyframes at 0 and
        // 2_000_000 (layer-relative).
        let (handle, layer_id) = single_videoclip_project().await;
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: new_id(), t_us: 0, value: 0.0, interp: Interpolation::Linear },
                Keyframe { id: new_id(), t_us: 2_000_000, value: 1.0, interp: Interpolation::Linear },
            ]
            .into_iter()
            .collect(),
        );
        handle.update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await.expect("seed keyframes");

        // Trim the IN edge to t=1_000_000 (head trimmed inward by 1s).
        handle.trim_layer(Actor::User, layer_id, LayerEdge::In, 1_000_000, false)
            .await.expect("trim in");

        // The key that was at t_us=2_000_000 is now at 1_000_000 (shifted -1s);
        // the key at 0 is now at -1_000_000 (out-of-range, KEPT in data).
        let summary = handle.project_summary();
        let layer = find_layer(&summary, layer_id);
        assert_keyframe_times(&layer, "opacity", &[-1_000_000, 1_000_000]);
    }
```

(`assert_keyframe_times` is a local helper like `assert_keyframed_sorted` but
asserts the exact ordered `t_us` list including negatives. `LayerEdge` is already
in scope in this module.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib state::actor::tests::trim_in_shifts_keyframes 2>&1 | tail -20`
Expected: FAIL — keys still at `[0, 2_000_000]` (no shift applied yet).

- [ ] **Step 3: Implement the shift**

In `apply_trim_layer`, inside the `for &mid in aligned.iter()` loop, in the
`LayerEdge::In` arm, AFTER `m.t_start_us += clamped_delta;` and the existing
`src_in` updates (right after the `match &mut m.params { … }` block closes for the
In arm, ~line 4101), add the keyframe shift for the SAME member:

```rust
                // Keep keyframes glued to content: the IN edge moved by
                // `clamped_delta`, so every keyframe (layer-relative) shifts by
                // the opposite amount. Keys that fall before the new start go
                // negative and are kept in data (rendered out-of-range / hidden
                // by the UI), so trimming is non-destructive and reversible.
                crate::state::layer::for_each_animated_f64(&mut m.params, |a| {
                    a.shift_keyframes(-clamped_delta);
                });
                crate::state::layer::for_each_animated_rgba(&mut m.params, |a| {
                    a.shift_keyframes(-clamped_delta);
                });
```

The `LayerEdge::Out` arm needs **no** change — keyframes keep their `t_us`; keys
beyond the new (shorter) duration are simply out-of-range and clamp/hide.

> Borrow note: `m` is `&mut project.tracks[mti].layers[mli]`. `m.params` is the
> field passed to the walk helpers. Apply the shift after the existing
> `match &mut m.params` block so there's no overlapping mutable borrow.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib state::actor::tests::trim_in_shifts_keyframes 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Regression — full actor suite**

Run: `cargo test --lib state::actor 2>&1 | tail -15`
Expected: PASS (existing trim/group/move tests unaffected — keyframeless tracks are
no-ops under `shift_keyframes`).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(state): IN-edge trim keeps keyframes content-anchored"
```

---

### Task 6: Split partitions keyframes at the cut, rebases the right half

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (`split_single_layer` ~line 3906)

- [ ] **Step 1: Write the failing test**

Add to the actor `mod tests`:

```rust
    #[tokio::test]
    async fn split_partitions_keyframes_and_rebases_right() {
        // VideoClip [0, 4_000_000] with opacity keys at 0, 2_000_000, 3_000_000.
        let (handle, layer_id) = single_videoclip_project_dur(4_000_000).await;
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: new_id(), t_us: 0, value: 0.0, interp: Interpolation::Linear },
                Keyframe { id: new_id(), t_us: 2_000_000, value: 0.5, interp: Interpolation::Linear },
                Keyframe { id: new_id(), t_us: 3_000_000, value: 1.0, interp: Interpolation::Linear },
            ]
            .into_iter()
            .collect(),
        );
        handle.update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await.expect("seed keyframes");

        // Split at composition t=2_500_000 (clip-local offset = 2_500_000).
        let (left_id, right_id) = handle
            .split_layer(Actor::User, layer_id, 2_500_000, false)
            .await
            .expect("split");

        let summary = handle.project_summary();
        // Left keeps keys with t_us <= 2_500_000 -> [0, 2_000_000].
        assert_keyframe_times(&find_layer(&summary, left_id), "opacity", &[0, 2_000_000]);
        // Right gets keys with t_us > 2_500_000, rebased by -2_500_000 -> [500_000].
        assert_keyframe_times(&find_layer(&summary, right_id), "opacity", &[500_000]);
    }
```

(`single_videoclip_project_dur(dur)` = the Task-4 fixture parameterized by layer
duration. `split_layer` returns `(left_id, right_id)`; left reuses the original id.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib state::actor::tests::split_partitions_keyframes 2>&1 | tail -20`
Expected: FAIL — both halves still carry all three keys (split clones params verbatim).

- [ ] **Step 3: Implement the partition**

In `split_single_layer`, `split_offset` is already computed
(`let split_offset = at_t_us - original.t_start_us;`). After building `right`
(the `match &mut right.params { … }` for src_in, ~line 3942) and before/while
building `left`, transform each half's keyframes. Add right after the `right`
src_in match block:

```rust
    // Partition keyframes at the cut (layer-relative `split_offset`):
    //  - right half (new t_start = at_t_us): keep keys with t_us > split_offset,
    //    rebased by -split_offset so they stay glued to content.
    crate::state::layer::for_each_animated_f64(&mut right.params, |a| {
        a.retain_keyframes(|t| t > split_offset);
        a.shift_keyframes(-split_offset);
    });
    crate::state::layer::for_each_animated_rgba(&mut right.params, |a| {
        a.retain_keyframes(|t| t > split_offset);
        a.shift_keyframes(-split_offset);
    });
```

Then, after `let mut left = original.clone();` and its `src_out` match block
(~line 3954), before `track.layers[li] = left;`, add:

```rust
    // Left half (keeps original t_start): keep keys with t_us <= split_offset.
    crate::state::layer::for_each_animated_f64(&mut left.params, |a| {
        a.retain_keyframes(|t| t <= split_offset);
    });
    crate::state::layer::for_each_animated_rgba(&mut left.params, |a| {
        a.retain_keyframes(|t| t <= split_offset);
    });
```

Every key lands on exactly one half (partition by `split_offset`), so no key is
lost or duplicated; pre-existing out-of-range keys route by the same rule.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib state::actor::tests::split_partitions_keyframes 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Regression — full actor + split suites**

Run: `cargo test --lib state::actor 2>&1 | tail -15`
Expected: PASS (existing split/group tests unaffected — keyframeless params are
no-ops under retain/shift).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(state): split partitions keyframes at the cut + rebases right half"
```

---

### Task 7: TS IPC wrappers

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts`

No new TS types needed — `AnimTrack<T>` and `Keyframe<T>` already exist
(lines 250–261). The wrappers mirror `updateLayerParams` (line 809).

- [ ] **Step 1: Add the wrappers**

After `updateLayerParams` (line 814) in `apps/desktop/src/ipc/index.ts`:

```ts
/// Write a whole keyframe track to a named animatable param on a layer.
/// `param_key` is one of the layer kind's animatable f64 fields
/// (x/y/scale_x/scale_y/opacity for visual kinds; gain_db/pan for audio).
/// The actor normalizes (snap/sort/dedupe) and records the edit (one undo step).
export async function updateLayerParamTrack(
  layerId: string,
  paramKey: string,
  track: AnimTrack<number>,
): Promise<void> {
  return invoke<void>("update_layer_param_track", { layerId, paramKey, track });
}

/// Batch form — write several param tracks on one layer as a single undo step
/// (used by multi-keyframe gestures like dragging a cross-property selection).
export async function updateLayerParamTracks(
  layerId: string,
  entries: [string, AnimTrack<number>][],
): Promise<void> {
  return invoke<void>("update_layer_param_tracks", { layerId, entries });
}
```

- [ ] **Step 2: Typecheck**

Run (from `apps/desktop/`): `npm run typecheck`
Expected: PASS. (`AnimTrack` is already imported/declared in this file.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/ipc/index.ts
git commit -m "feat(ipc): updateLayerParamTrack(s) wrappers"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Rust — build + full unit suite**

Run (from `apps/desktop/src-tauri/`): `cargo test --lib 2>&1 | tail -20`
Expected: all pass, including the new `animated`, `layer::kf_fields_tests`, and
actor keyframe/trim/split tests.

- [ ] **Step 2: Frontend — typecheck + unit suite**

Run (from `apps/desktop/`): `npm run typecheck && npx vitest run 2>&1 | tail -15`
Expected: typecheck clean; vitest green (no frontend behavior changed — wrappers only).

- [ ] **Step 3: Confirm no MCP / no UI drift**

Run: `git diff --stat main -- apps/desktop/src-tauri/src/mcp apps/desktop/src/properties apps/desktop/src/timeline`
Expected: EMPTY — this plan touches none of those (MCP keyframe tools and the
authoring UI are Plan 2 / out of scope).

---

## Self-Review notes

- **Spec coverage (this plan = §3 + §6):** write path `update_layer_param_track(s)` +
  normalize (sort/snap/dedupe) + reject empty/locked/unknown → Tasks 1,3,4; the
  `param_key` resolver (Rust mirror of the descriptor) → Task 2; content-anchored
  trim (IN shift, OUT no-op) → Task 5; split partition + rebase → Task 6; TS boundary
  → Task 7. The stopwatch, `<AnimatableField>`, collapsed diamonds, focus store,
  interp menu, and e2e are **Plan 2** (frontend) — deliberately not here.
- **Out of scope (honored):** no `Animated<Rgba>` authoring (the Rgba walk exists only
  so trim/split carry any existing color keys — no command writes them); no MCP tools;
  no Bezier authoring; no UI.
- **Type consistency:** `Animated<f64>` over the wire = the existing `AnimTrack<number>`
  TS mirror; `update_layer_param_track(id, param_key, track)` arg order is identical in
  the Command variant, public method, `do_*`, tauri command, and TS wrapper; the
  `param_key` strings (`x/y/scale_x/scale_y/rotation_deg/opacity/gain_db/pan`) match
  between `resolve_animated_f64_mut` (Task 2) and the descriptor Plan 2 will build.
- **Engine-pair safety:** `shift_keyframes`/`retain_keyframes`/`normalize_keyframes` are
  pure data transforms on the keyframe vector — they do NOT touch interpolation, so the
  `value_at` ≡ `resolveAnimated` golden-vector lock is unaffected.
