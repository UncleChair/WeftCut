# Audio Roles: Mix by Role, Not by Track — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make audio mixing group by a per-layer **role** (Dialogue/Music/SFX/Voiceover) instead of by track, so "boost all dialogue" / "solo the music" have a stable handle and the track stops carrying audio semantics.

**Architecture:** Each audio layer gets an `AudioRole`. A project-level `audio_roles` table holds per-role `{gain_db, muted, solo}`. In v1 there are no per-role effects, so a role bus is realized by **folding**: role gain multiplies each member layer's gain envelope, and role mute/solo filter the audible set — so the per-block summing loop is unchanged. Mute/Solo move off the track header into a Mixer panel; the Rust mixer and the TS preview twin apply the identical fold, locked by a shared pure role-gate helper.

**Tech Stack:** Rust (Tauri actor/IPC/MCP, `imbl` persistent collections, serde), React/TypeScript (Zustand store, Web Audio preview, Base-UI Select), vitest + cargo test + the real-WebView2 conformance e2e harness.

**Spec:** `docs/superpowers/specs/2026-06-16-audio-roles-mixing-design.md`

---

## File Structure

**Rust (`apps/desktop/src-tauri/src`):**
- `state/audio_role.rs` — **new.** `AudioRole` enum + `RoleMixSettings` + `RoleFlagsPatch`. One responsibility: the role vocabulary and its mix-bus settings.
- `state/layer.rs` — add `role: AudioRole` to `AudioParams`.
- `state/project.rs` — add `audio_roles` table + `role_mix()` getter; `RoleFlagsPatch` re-export.
- `audio/envelope.rs` — add `Envelope::scale` (fold role gain).
- `audio/mix.rs` — role gating + role-gain fold in `audible_audio_layers` / `plan_for_project`.
- `state/history.rs` — `replace_role_flags_everywhere` + `apply_role_flags` (unrecorded).
- `state/actor.rs` — `AudioPatch.role`; `do_set_role_gain` (recorded) + `do_update_role_flags` (unrecorded) + Command variants + ProjectHandle methods.
- `commands.rs` — `set_role_gain` / `update_role_flags` commands; `AudioView.role`; `ProjectSummary.audio_roles`; import role heuristic.
- `mcp/mod.rs` — `set_role_gain` / `set_role_flags` MCP tools; import role heuristic.

**TypeScript (`apps/desktop/src`):**
- `ipc/index.ts` — `AudioRole` type; `AudioView.role`; `AudioPatch.role`; `RoleMixView` + `ProjectSummary.audio_roles`; `setRoleGain` / `updateRoleFlags` wrappers.
- `state/projectStore.ts` — `useAudioRoles()` selector.
- `render/audio/roleGate.ts` — **new.** Pure mirror of the Rust role logic (audible-by-role, any-solo, role-gain-linear). The parity-testable unit.
- `render/Compositor.ts` — role gating in the audio selection loop; pass role gain to the mixer.
- `render/audio/AudioMixer.ts` — `updateView` takes `roleGainLinear`, folds it into the gain envelope.
- `timeline/TrackHeader.tsx` + `timeline/geometry.ts` — remove track M/S; eye + lock always.
- `properties/PropertyPanel.tsx` — Role dropdown in `AudioFields`.
- `panels/MixerPanel.tsx` — **new.** Per-role gain + M/S; mounted in `RightPanel`.
- `panels/RightPanel.tsx` — mount `MixerPanel`.
- `i18n/locales/en-US.ts` + `zh-CN.ts` — `mixer` namespace + `property_panel.role`.

---

## Task 1: Data model — `AudioRole`, `RoleMixSettings`, `Project.audio_roles`

**Files:**
- Create: `apps/desktop/src-tauri/src/state/audio_role.rs`
- Modify: `apps/desktop/src-tauri/src/state/mod.rs` (module decl + re-export)
- Modify: `apps/desktop/src-tauri/src/state/layer.rs:192-205` (`AudioParams.role`)
- Modify: `apps/desktop/src-tauri/src/state/project.rs:51-75` (`Project.audio_roles` + getter)
- Modify all `AudioParams { … }` construction sites (compile-driven, see Step 5)

- [ ] **Step 1: Create the role module**

Create `apps/desktop/src-tauri/src/state/audio_role.rs`:

```rust
//! Audio roles — the mixing model's "what kind of sound is this" axis
//! (`docs/audio.md`). Each audio layer carries an `AudioRole`; the
//! project holds one `RoleMixSettings` per role (a mix bus). Mixing
//! groups by role, not by track. v1 has no per-role effects, so a role
//! bus is realized by folding role gain into each layer's gain envelope
//! and filtering the audible set by role mute/solo.

use serde::{Deserialize, Serialize};

/// Fixed v1 role set. Custom / sub-roles are deferred. Kebab-case on the
/// wire (matches `TrackRole`'s convention and the TS `AudioRole` union).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AudioRole {
    #[default]
    Dialogue,
    Music,
    Sfx,
    Voiceover,
}

impl AudioRole {
    /// Canonical display / iteration order. The mixer UI and the IPC view
    /// emit roles in this order regardless of map iteration order.
    pub const ALL: [AudioRole; 4] = [
        AudioRole::Dialogue,
        AudioRole::Music,
        AudioRole::Sfx,
        AudioRole::Voiceover,
    ];

    /// Kebab string used in IPC views (must match the serde wire form).
    pub fn as_str(self) -> &'static str {
        match self {
            AudioRole::Dialogue => "dialogue",
            AudioRole::Music => "music",
            AudioRole::Sfx => "sfx",
            AudioRole::Voiceover => "voiceover",
        }
    }
}

/// Per-role mix-bus settings. `gain_db` is a recorded edit; `muted`/`solo`
/// are unrecorded preferences (see `RoleFlagsPatch`). Effects insert here
/// in a later plan (`effects: Vec<AudioEffect>`); v1 adds no DSP.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoleMixSettings {
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
}

impl Default for RoleMixSettings {
    fn default() -> Self {
        Self { gain_db: 0.0, muted: false, solo: false }
    }
}

/// Patch for `update_role_flags` — the Mixer panel's M/S toggles.
/// Unrecorded (applied to every history snapshot) so Ctrl-Z never flips a
/// mute, mirroring `TrackFlagsPatch`. Only `Some(_)` fields apply.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct RoleFlagsPatch {
    pub muted: Option<bool>,
    pub solo: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_default_is_dialogue() {
        assert_eq!(AudioRole::default(), AudioRole::Dialogue);
    }

    #[test]
    fn role_serializes_kebab() {
        assert_eq!(serde_json::to_string(&AudioRole::Voiceover).unwrap(), "\"voiceover\"");
        assert_eq!(
            serde_json::from_str::<AudioRole>("\"sfx\"").unwrap(),
            AudioRole::Sfx
        );
    }

    #[test]
    fn as_str_matches_wire_form() {
        for r in AudioRole::ALL {
            let wire = serde_json::to_string(&r).unwrap();
            assert_eq!(wire, format!("\"{}\"", r.as_str()));
        }
    }
}
```

- [ ] **Step 2: Wire the module + run its tests (verify they pass)**

In `apps/desktop/src-tauri/src/state/mod.rs`, add alongside the other `pub mod` lines:

```rust
pub mod audio_role;
```

Run: `cd apps/desktop/src-tauri && cargo test --lib state::audio_role`
Expected: PASS (3 tests).

- [ ] **Step 3: Add `role` to `AudioParams`**

In `apps/desktop/src-tauri/src/state/layer.rs`, add the import near the top (after the existing `use super::...` lines):

```rust
use super::audio_role::AudioRole;
```

Then add the field to `AudioParams` (currently `state/layer.rs:192-205`):

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioParams {
    pub media: MediaId,
    pub src_in_us: TimeUs,
    pub src_out_us: TimeUs,
    pub gain_db: Animated<f64>,
    /// -1.0 left .. 1.0 right.
    pub pan: Animated<f64>,
    #[serde(default)]
    pub fade_in_us: u64,
    #[serde(default)]
    pub fade_out_us: u64,
    #[serde(default)]
    pub mute: bool,
    /// Mixing role (`docs/audio.md`). Legacy `.vproj` audio layers (no
    /// field) deserialize to `Dialogue`. The mixer groups by this, not by
    /// track.
    #[serde(default)]
    pub role: AudioRole,
}
```

- [ ] **Step 4: Add `audio_roles` to `Project` + the getter; write back-compat tests**

In `apps/desktop/src-tauri/src/state/project.rs`, add to the imports (line ~13):

```rust
use super::audio_role::{AudioRole, RoleMixSettings};
```

Add the field to `Project` (after `groups`, before `settings`, ~line 73):

```rust
    /// Per-role mix-bus settings (`docs/audio.md`). Absent keys resolve to
    /// `RoleMixSettings::default()` via `role_mix`. `#[serde(default)]`
    /// makes pre-roles `.vproj` files load with every role at unity.
    #[serde(default)]
    pub audio_roles: imbl::HashMap<AudioRole, RoleMixSettings>,
```

Initialise it in `new_blank` (the `Self { … }` literal, ~line 104) — add after `groups: imbl::Vector::new(),`:

```rust
            audio_roles: imbl::HashMap::new(),
```

Add the getter in the `impl Project` block (after `new_blank`):

```rust
    /// Mix settings for a role, defaulted when the table has no entry.
    pub fn role_mix(&self, role: AudioRole) -> RoleMixSettings {
        self.audio_roles.get(&role).cloned().unwrap_or_default()
    }
```

Add tests at the bottom of `project.rs` (create a `#[cfg(test)] mod tests` if none exists):

```rust
#[cfg(test)]
mod role_tests {
    use super::*;

    #[test]
    fn legacy_project_without_audio_roles_defaults_to_unity() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v.as_object_mut().unwrap().remove("audio_roles");
        let back: Project = serde_json::from_value(v).unwrap();
        assert!(back.audio_roles.is_empty());
        let m = back.role_mix(AudioRole::Music);
        assert_eq!(m.gain_db, 0.0);
        assert!(!m.muted && !m.solo);
    }

    #[test]
    fn role_mix_reads_table_entry() {
        let mut p = Project::new_blank("t");
        p.audio_roles.insert(
            AudioRole::Dialogue,
            RoleMixSettings { gain_db: 6.0, muted: false, solo: true },
        );
        let m = p.role_mix(AudioRole::Dialogue);
        assert_eq!(m.gain_db, 6.0);
        assert!(m.solo);
    }
}
```

- [ ] **Step 5: Make it compile — add `role` to every `AudioParams` literal**

`AudioParams` is constructed as a struct literal in many places; serde-default only covers deserialization, so each literal needs the field. Add `role: AudioRole::Dialogue,` (importing `AudioRole` where needed) to every site below. Production import paths get their heuristic role in Task 4 — for now all are `Dialogue` so this step only restores compilation.

Sites (from grep `AudioParams {`):
- `commands.rs:798` (standalone import), `:859` (auto-pair), `:1831` (agent standalone), `:1892` (agent auto-pair)
- `mcp/mod.rs:454` (auto-pair), `:878` (synthesize_speech), `:3754` (test helper)
- `state/actor.rs:7012`, `:8372`, `:8436` (tests)
- `export/mod.rs:583` (test), `audio/mix.rs:381` (test — but Task 2 rewrites this fixture; add the field there too for now)
- `state/layer.rs:428` (test factory), `state/validate.rs:679`, `:715` (tests)

- [ ] **Step 6: Run the full lib build + the new tests**

Run: `cd apps/desktop/src-tauri && cargo test --lib state::`
Expected: PASS, including `role_tests::*` and `audio_role::tests::*`. No compile errors from missing `role` fields.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/state/audio_role.rs apps/desktop/src-tauri/src/state/mod.rs apps/desktop/src-tauri/src/state/layer.rs apps/desktop/src-tauri/src/state/project.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/mcp/mod.rs apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src-tauri/src/export/mod.rs apps/desktop/src-tauri/src/audio/mix.rs apps/desktop/src-tauri/src/state/validate.rs
git commit -m "feat(audio): AudioRole + RoleMixSettings + Project.audio_roles"
```

---

## Task 2: Mixer — role gating + role-gain fold (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/audio/envelope.rs` (add `Envelope::scale`)
- Modify: `apps/desktop/src-tauri/src/audio/mix.rs:70-149` (`audible_audio_layers`, `plan_for_project`) + tests

- [ ] **Step 1: Add `Envelope::scale` + test (write failing test first)**

In `apps/desktop/src-tauri/src/audio/envelope.rs`, add a test in the `tests` module:

```rust
    #[test]
    fn scale_multiplies_every_point() {
        let mut e = sample_gain(&Animated::Static(0.0), 0, 0, 1_000_000); // unity, 1 point
        e.scale(0.5);
        assert!((e.eval(0) - 0.5).abs() < 1e-6);
        let mut k = sample_gain(&Animated::Static(0.0), 1_000_000, 0, 1_000_000); // fade-in ramp
        k.scale(2.0);
        assert!((k.eval(1_000_000) - 2.0).abs() < 1e-3);
    }
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib audio::envelope::tests::scale_multiplies_every_point`
Expected: FAIL — `no method named scale found`.

- [ ] **Step 3: Implement `Envelope::scale`**

In `envelope.rs`, inside `impl Envelope` (after `eval`):

```rust
    /// Multiply every control point by `factor`. Used to fold a role's
    /// linear gain into a layer's gain envelope (v1 role-bus realization).
    pub fn scale(&mut self, factor: f32) {
        for v in self.values.iter_mut() {
            *v *= factor;
        }
    }
```

- [ ] **Step 4: Run the test (verify pass)**

Run: `cd apps/desktop/src-tauri && cargo test --lib audio::envelope::tests::scale_multiplies_every_point`
Expected: PASS.

- [ ] **Step 5: Rewrite the mix test fixture so its two layers carry different roles**

In `audio/mix.rs`, the `two_audio_tracks_project` helper (~line 328) builds two audio tracks. Change it so track A's layer is `Dialogue` and track B's layer is `Music`, and remove reliance on track muted/solo. Update `make_audio_layer` to take a role:

```rust
        let make_audio_layer = |media_id: uuid::Uuid, role: crate::state::audio_role::AudioRole| -> Layer {
            Layer {
                id: uuid::Uuid::new_v4(),
                label: None,
                t_start_us: 0,
                t_end_us: 1_000_000,
                enabled: true,
                locked: false,
                metadata: imbl::HashMap::new(),
                params: LayerParams::Audio(AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                    role,
                }),
            }
        };
```

and at the two `layers: imbl::vector![make_audio_layer(media_id_a)]` sites use:

```rust
            layers: imbl::vector![make_audio_layer(media_id_a, crate::state::audio_role::AudioRole::Dialogue)],
```
```rust
            layers: imbl::vector![make_audio_layer(media_id_b, crate::state::audio_role::AudioRole::Music)],
```

- [ ] **Step 6: Replace the track-mute/solo tests with role-mute/solo tests (write the new tests)**

Delete the four track-flag tests (`muted_track_is_skipped`, `solo_silences_non_solo_tracks`, `disabled_track_solo_does_not_gate`, `mute_wins_over_solo`) and the body of `waiting_skips_out_of_window_and_gated_layers` that sets `tracks[..].muted/solo`. Add role-based replacements:

```rust
    use crate::state::audio_role::{AudioRole, RoleMixSettings};

    fn set_role(p: &mut Project, role: AudioRole, s: RoleMixSettings) {
        p.audio_roles.insert(role, s);
    }

    #[test]
    fn muted_role_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: true, solo: false });
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "Dialogue role muted ⇒ only Music plays");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("b.conform"));
    }

    #[test]
    fn solo_silences_non_solo_roles() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: false, solo: true });
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 1, "only soloed Dialogue plays");
        assert_eq!(plan.layers[0].conform_path, tmp.path().join("a.conform"));
    }

    #[test]
    fn role_mute_wins_over_solo() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 0.0, muted: true, solo: true });
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 0, "mute wins; Music silenced by the solo set");
    }

    #[test]
    fn role_gain_scales_output() {
        let tmp = TempDir::new().unwrap();
        let mut project = two_audio_tracks_project(tmp.path());
        // +6.0206 dB ≈ ×2 on Dialogue only.
        set_role(&mut project, AudioRole::Dialogue, RoleMixSettings { gain_db: 6.0206, muted: false, solo: false });
        let plan = plan_for_project(&project, None).unwrap();
        let dialogue = plan.layers.iter().find(|l| l.conform_path == tmp.path().join("a.conform")).unwrap();
        assert!((dialogue.gain.eval(0) - 2.0).abs() < 1e-2, "Dialogue folded ×2");
        let music = plan.layers.iter().find(|l| l.conform_path == tmp.path().join("b.conform")).unwrap();
        assert!((music.gain.eval(0) - 1.0).abs() < 1e-3, "Music unchanged");
    }

    #[test]
    fn legacy_no_audio_roles_plays_both_at_unity() {
        let tmp = TempDir::new().unwrap();
        let project = two_audio_tracks_project(tmp.path()); // empty audio_roles
        let plan = plan_for_project(&project, None).unwrap();
        assert_eq!(plan.layers.len(), 2);
        for l in &plan.layers {
            assert!((l.gain.eval(0) - 1.0).abs() < 1e-3);
        }
    }
```

Also fix `waiting_skips_out_of_window_and_gated_layers`: replace its `project.tracks[1].muted = true;` / `project.tracks[0].solo = true;` lines with role-table equivalents on track B's role (Music) and track A's role (Dialogue) respectively, e.g. `set_role(&mut project, AudioRole::Music, RoleMixSettings { gain_db: 0.0, muted: true, solo: false });`.

- [ ] **Step 7: Run the new tests to confirm they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib audio::mix`
Expected: FAIL — role mute/solo not yet honored; role gain not folded.

- [ ] **Step 8: Implement role gating in `audible_audio_layers`**

Replace the track-gate + push loop in `audible_audio_layers` (`mix.rs:70-104`). New body:

```rust
fn audible_audio_layers<'a>(
    project: &'a Project,
    w_start_us: i64,
    w_end_us: i64,
) -> Vec<(&'a Layer, &'a AudioParams)> {
    // Role-level solo (docs/audio.md): when any role is soloed, only
    // soloed roles are audible. Mute wins over solo.
    let any_role_solo = project.audio_roles.values().any(|r| r.solo);
    let mut out = Vec::new();
    for track in project.tracks.iter() {
        // Whole-track disable still gates (rule 1). Track mute/solo no
        // longer gate audio — that moved to roles.
        if !track.enabled {
            continue;
        }
        for layer in track.layers.iter() {
            if !layer.enabled || layer.locked {
                continue;
            }
            let LayerParams::Audio(p) = &layer.params else {
                continue;
            };
            if p.mute {
                continue;
            }
            let role = project.role_mix(p.role);
            if role.muted || (any_role_solo && !role.solo) {
                continue;
            }
            if layer.t_end_us <= w_start_us || layer.t_start_us >= w_end_us {
                continue;
            }
            out.push((layer, p));
        }
    }
    out
}
```

- [ ] **Step 9: Fold role gain in `plan_for_project`**

In `plan_for_project` (`mix.rs:108-149`), after computing `gain: sample_gain(...)` build a scaled envelope. Replace the `layers.push(MixLayer { … })` block so it scales gain by the role's linear gain:

```rust
    for (layer, p) in audible_audio_layers(project, w_start_us, w_end_us) {
        let media = project
            .media_pool
            .get(&p.media)
            .ok_or_else(|| PlanError::MissingMedia(p.media.to_string()))?;
        let label = media
            .label
            .clone()
            .unwrap_or_else(|| media.path_abs.display().to_string());
        let conform_path = media
            .conform_path
            .clone()
            .filter(|c| crate::cache::cached_ok(c))
            .ok_or_else(|| PlanError::ConformMissing(label.clone()))?;
        let span_us = p.src_out_us - p.src_in_us;
        let role_gain = crate::audio::envelope::db_to_linear(project.role_mix(p.role).gain_db);
        let mut gain = sample_gain(&p.gain_db, p.fade_in_us as i64, p.fade_out_us as i64, span_us);
        gain.scale(role_gain);
        layers.push(MixLayer {
            label,
            conform_path,
            start_frame: us_to_frame(layer.t_start_us),
            src_in_frame: us_to_frame(p.src_in_us),
            src_out_frame: us_to_frame(p.src_out_us),
            gain,
            pan: sample_pan(&p.pan, span_us),
        });
    }
```

- [ ] **Step 10: Run mix + envelope tests (verify pass)**

Run: `cd apps/desktop/src-tauri && cargo test --lib audio::`
Expected: PASS — all role mute/solo/gain tests + the envelope scale test + the existing summing/placement tests.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src-tauri/src/audio/envelope.rs apps/desktop/src-tauri/src/audio/mix.rs
git commit -m "feat(audio): mix by role — role mute/solo gating + role-gain fold"
```

---

## Task 3: Actor — `AudioPatch.role`, recorded `set_role_gain`, unrecorded `update_role_flags`

**Files:**
- Modify: `apps/desktop/src-tauri/src/state/actor.rs` (`AudioPatch`, apply arm, Command, handlers, ProjectHandle)
- Modify: `apps/desktop/src-tauri/src/state/history.rs` (`replace_role_flags_everywhere` + `apply_role_flags`)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`set_role_gain`, `update_role_flags` commands)

- [ ] **Step 1: Add `role` to `AudioPatch` + its apply arm**

In `state/actor.rs`, add the import if not present (top): `use crate::state::audio_role::{AudioRole, RoleFlagsPatch};`

Add to `AudioPatch` (`actor.rs:223-238`), after `mute`:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<AudioRole>,
```

Add to the Audio apply arm (`actor.rs:4629-4651`), after the `mute` handling:

```rust
    if let Some(r) = ap.role {
        p.role = r;
    }
```

- [ ] **Step 2: History — `apply_role_flags` + `replace_role_flags_everywhere` (write failing test first)**

In `state/history.rs` add a test (mirror the track-flags test if one exists; otherwise add a new `#[cfg(test)]` case):

```rust
    #[test]
    fn role_flags_apply_to_every_snapshot() {
        use crate::state::audio_role::{AudioRole, RoleFlagsPatch};
        let mut h = History::new(crate::state::project::Project::new_blank("t"), 10);
        // record a second snapshot so there is history to sweep
        let p2 = (*h.current()).clone();
        h.record(test_entry(p2));
        h.replace_role_flags_everywhere(AudioRole::Music, &RoleFlagsPatch { muted: Some(true), solo: None });
        assert!(h.current().role_mix(AudioRole::Music).muted);
    }
```

(If `History::new` / `test_entry` helpers differ, match the existing track-flags test's setup in this file.)

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd apps/desktop/src-tauri && cargo test --lib state::history::`
Expected: FAIL — `no method replace_role_flags_everywhere`.

- [ ] **Step 4: Implement the history sweep**

In `state/history.rs`, add (mirroring `replace_track_flags_everywhere` at line 281 and `apply_track_flags` at 322):

```rust
    pub fn replace_role_flags_everywhere(
        &mut self,
        role: crate::state::audio_role::AudioRole,
        patch: &crate::state::audio_role::RoleFlagsPatch,
    ) {
        for entry in self.snapshots.iter_mut() {
            entry.snapshot = Arc::new(apply_role_flags(&entry.snapshot, role, patch));
        }
        for cp in self.checkpoints.values_mut() {
            cp.snapshot = Arc::new(apply_role_flags(&cp.snapshot, role, patch));
        }
    }
```

and the free helper near `apply_track_flags`:

```rust
fn apply_role_flags(
    snapshot: &Arc<Project>,
    role: crate::state::audio_role::AudioRole,
    patch: &crate::state::audio_role::RoleFlagsPatch,
) -> Project {
    let mut p = (**snapshot).clone();
    let mut s = p.role_mix(role);
    if let Some(v) = patch.muted {
        s.muted = v;
    }
    if let Some(v) = patch.solo {
        s.solo = v;
    }
    p.audio_roles.insert(role, s);
    p
}
```

Run: `cd apps/desktop/src-tauri && cargo test --lib state::history::role_flags_apply_to_every_snapshot`
Expected: PASS.

- [ ] **Step 5: Add Command variants + ProjectHandle methods + actor handlers**

In `state/actor.rs`, add to the `Command` enum (near `UpdateTrackFlags`):

```rust
    SetRoleGain {
        role: AudioRole,
        gain_db: f64,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
    UpdateRoleFlags {
        role: AudioRole,
        patch: RoleFlagsPatch,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
```

Add the dispatch arms wherever the actor loop matches `Command` (mirror `Command::UpdateTrackFlags { … } => { let r = self.do_update_track_flags(…); let _ = reply.send(r); }`):

```rust
            Command::SetRoleGain { role, gain_db, actor, reply } => {
                let r = self.do_set_role_gain(role, gain_db, actor);
                let _ = reply.send(r);
            }
            Command::UpdateRoleFlags { role, patch, actor, reply } => {
                let r = self.do_update_role_flags(role, patch, actor);
                let _ = reply.send(r);
            }
```

Add the handlers (mirror `do_update_track_flags` at 3106 for the unrecorded one; `do_update_layer_params` at 2273 for the recorded one):

```rust
    fn do_set_role_gain(
        &mut self,
        role: AudioRole,
        gain_db: f64,
        actor: Actor,
    ) -> Result<(), CommandError> {
        let mut next: Project = (*self.history.current()).clone();
        let mut s = next.role_mix(role);
        s.gain_db = gain_db;
        next.audio_roles.insert(role, s);
        self.commit(
            next,
            actor,
            format!("Set {} role gain to {gain_db} dB", role.as_str()),
            vec![],
            DiffHint::Audio,
        )?;
        Ok(())
    }

    fn do_update_role_flags(
        &mut self,
        role: AudioRole,
        patch: RoleFlagsPatch,
        actor: Actor,
    ) -> Result<(), CommandError> {
        self.history.replace_role_flags_everywhere(role, &patch);
        let snapshot = self.history.current();
        self.broadcast_unrecorded(actor, format!("Updated {} role flags", role.as_str()), snapshot);
        Ok(())
    }
```

> `DiffHint::Audio` may not exist. If the `DiffHint` enum has no audio-wide variant, use the same fallback variant `do_update_track_flags`/the project-wide mutations use (grep `enum DiffHint`; e.g. `DiffHint::Project` or `DiffHint::None`). Pick the existing project-wide variant — do not invent one.

Add the ProjectHandle methods (mirror `update_track_flags` at 1234):

```rust
    pub async fn set_role_gain(
        &self,
        actor: Actor,
        role: AudioRole,
        gain_db: f64,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::SetRoleGain { role, gain_db, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }

    pub async fn update_role_flags(
        &self,
        actor: Actor,
        role: AudioRole,
        patch: RoleFlagsPatch,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::UpdateRoleFlags { role, patch, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }
```

- [ ] **Step 6: Actor behavior tests (write + run, expect pass after impl)**

Add to the actor test module (mirroring existing `ProjectHandle` async tests; they typically use `#[tokio::test]` and a spawned handle — match the file's existing pattern):

```rust
    #[tokio::test]
    async fn set_role_gain_is_recorded_and_undoable() {
        let h = test_handle(Project::new_blank("t"));
        h.set_role_gain(Actor::User, AudioRole::Dialogue, 6.0).await.unwrap();
        assert_eq!(h.snapshot().await.role_mix(AudioRole::Dialogue).gain_db, 6.0);
        h.undo(Actor::User).await.unwrap();
        assert_eq!(h.snapshot().await.role_mix(AudioRole::Dialogue).gain_db, 0.0);
    }

    #[tokio::test]
    async fn update_role_flags_is_unrecorded() {
        let h = test_handle(Project::new_blank("t"));
        // create an undo step, then flip a flag, then undo: the flag must survive
        h.set_role_gain(Actor::User, AudioRole::Music, 3.0).await.unwrap();
        h.update_role_flags(Actor::User, AudioRole::Music, RoleFlagsPatch { muted: Some(true), solo: None }).await.unwrap();
        h.undo(Actor::User).await.unwrap();
        assert!(h.snapshot().await.role_mix(AudioRole::Music).muted, "unrecorded flag survives undo");
    }
```

(Use the file's actual test handle/undo/snapshot helpers — grep `fn test_handle` / existing `update_track_flags` async test and copy its shape exactly.)

Run: `cd apps/desktop/src-tauri && cargo test --lib state::actor`
Expected: PASS.

- [ ] **Step 7: Tauri commands**

In `commands.rs`, add (mirror `update_track_flags` at 2408) — and remember to register both in the `tauri::generate_handler![…]` list (grep `update_track_flags` in `lib.rs`/`main.rs` and add the two new names beside it):

```rust
#[tauri::command]
pub async fn set_role_gain(
    handle: State<'_, ProjectHandle>,
    role: crate::state::audio_role::AudioRole,
    gain_db: f64,
) -> Result<(), String> {
    handle
        .set_role_gain(Actor::User, role, gain_db)
        .await
        .map_err(|e: CommandError| e.to_string())
}

#[tauri::command]
pub async fn update_role_flags(
    handle: State<'_, ProjectHandle>,
    role: crate::state::audio_role::AudioRole,
    patch: crate::state::audio_role::RoleFlagsPatch,
) -> Result<(), String> {
    handle
        .update_role_flags(Actor::User, role, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}
```

- [ ] **Step 8: Build + commit**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: clean build.

```bash
git add apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src-tauri/src/state/history.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(audio): actor + commands for role gain (recorded) and role M/S (unrecorded)"
```

---

## Task 4: IPC views + import role heuristic (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`AudioView`, `layer_params_view`, `ProjectSummary`, `project_summary` builder, import sites)
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (import sites)

- [ ] **Step 1: Add `role` to `AudioView`**

`commands.rs:206-217`, add after `mute`:

```rust
    pub role: String, // "dialogue" | "music" | "sfx" | "voiceover"
```

`commands.rs:598-608` (the `LayerParams::Audio` arm of `layer_params_view`), add after `mute: p.mute,`:

```rust
    role: p.role.as_str().to_string(),
```

- [ ] **Step 2: Add `audio_roles` to `ProjectSummary`**

Define a view struct near `AudioView`:

```rust
#[derive(Serialize, Clone)]
pub struct RoleMixView {
    pub role: String,
    pub gain_db: f64,
    pub muted: bool,
    pub solo: bool,
}
```

Add to the `ProjectSummary` struct:

```rust
    pub audio_roles: Vec<RoleMixView>,
```

In the `project_summary` builder (`commands.rs:394+`), build it from all four roles in canonical order so the UI always has every role:

```rust
    let audio_roles: Vec<RoleMixView> = crate::state::audio_role::AudioRole::ALL
        .iter()
        .map(|&r| {
            let s = snap.role_mix(r);
            RoleMixView { role: r.as_str().to_string(), gain_db: s.gain_db, muted: s.muted, solo: s.solo }
        })
        .collect();
```

and add `audio_roles,` to the returned `ProjectSummary { … }` literal.

- [ ] **Step 3: Import role heuristic**

Set the role at the four production construction sites (Task 1 left them `Dialogue`):
- `commands.rs:798` (standalone import) → `role: AudioRole::Music,`
- `commands.rs:859` (auto-pair audio from video) → `role: AudioRole::Dialogue,` (keep)
- `commands.rs:1831` (agent standalone) → `role: AudioRole::Music,`
- `commands.rs:1892` (agent auto-pair) → `role: AudioRole::Dialogue,` (keep)
- `mcp/mod.rs:454` (auto-pair) → `role: AudioRole::Dialogue,` (keep)
- `mcp/mod.rs:878` (`synthesize_speech` — TTS) → `role: AudioRole::Voiceover,`

Ensure `use crate::state::audio_role::AudioRole;` is in scope in both files.

- [ ] **Step 4: Build + a focused summary test**

Add a test (in `commands.rs` tests, or assert through an existing summary test) confirming `project_summary` emits four roles in canonical order:

```rust
    #[test]
    fn project_summary_emits_four_roles_in_canonical_order() {
        let p = crate::state::project::Project::new_blank("t");
        let summary = build_project_summary(&p); // use the real builder fn name
        let roles: Vec<&str> = summary.audio_roles.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["dialogue", "music", "sfx", "voiceover"]);
    }
```

(Use the actual builder function name; if `project_summary` is only the command wrapper, factor the body into a `build_project_summary(&Project)` helper and call that — keeping the command a thin wrapper.)

Run: `cd apps/desktop/src-tauri && cargo test --lib commands`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(audio): role in AudioView + audio_roles in ProjectSummary + import heuristic"
```

---

## Task 5: MCP role tools (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (two tools + `update_layer_params` doc)

- [ ] **Step 1: Add the role tool argument structs + tools**

In `mcp/mod.rs`, near the other `#[tool]` methods (e.g. after `update_layer_params` at 924), add arg structs and tools (match the crate's rmcp `#[tool]` signature + the `ok_void`/`ok_json` helpers; per `feedback_rmcp_tool_returns` they return `Result<CallToolResult, McpError>`):

```rust
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetRoleGainArgs {
    /// "dialogue" | "music" | "sfx" | "voiceover"
    pub role: AudioRole,
    pub gain_db: f64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetRoleFlagsArgs {
    pub role: AudioRole,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub solo: Option<bool>,
}
```

```rust
    /// Set an audio role's mix gain in dB (recorded — undoable). Roles:
    /// dialogue, music, sfx, voiceover. Boosting dialogue raises every
    /// dialogue-role layer at once.
    #[tool(description = "Set an audio role's mix gain (dB). role ∈ {dialogue,music,sfx,voiceover}.")]
    async fn set_role_gain(
        &self,
        #[tool(aggr)] args: SetRoleGainArgs,
    ) -> Result<CallToolResult, McpError> {
        self.project
            .set_role_gain(agent_actor(), args.role, args.gain_db)
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }

    /// Mute / solo an audio role (unrecorded — not undoable). Mute wins
    /// over solo; when any role is soloed only soloed roles are audible.
    #[tool(description = "Mute/solo an audio role. role ∈ {dialogue,music,sfx,voiceover}.")]
    async fn set_role_flags(
        &self,
        #[tool(aggr)] args: SetRoleFlagsArgs,
    ) -> Result<CallToolResult, McpError> {
        self.project
            .update_role_flags(
                agent_actor(),
                args.role,
                crate::state::audio_role::RoleFlagsPatch { muted: args.muted, solo: args.solo },
            )
            .await
            .map_err(map_command_error)?;
        Ok(ok_void())
    }
```

Update the `update_layer_params` tool description to note that an Audio patch may carry `role` (so agents know it exists).

- [ ] **Step 2: MCP smoke test (per `feedback_emit_smoke_tests` — invoke the tool, assert effect)**

Add to the mcp test module (match the existing tool-smoke pattern, e.g. the helper `project_with_audio_layer` at 3754):

```rust
    #[tokio::test]
    async fn set_role_gain_tool_changes_project() {
        let server = test_server(/* project with an audio layer */);
        server.set_role_gain(SetRoleGainArgs { role: AudioRole::Dialogue, gain_db: 6.0 }).await.unwrap();
        assert_eq!(server.project.snapshot().await.role_mix(AudioRole::Dialogue).gain_db, 6.0);
    }
```

(Use the real test-server constructor + snapshot accessor this file already uses.)

Run: `cd apps/desktop/src-tauri && cargo test --lib mcp`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(audio): MCP set_role_gain + set_role_flags tools"
```

---

## Task 6: TS types + store selector

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts` (types + wrappers)
- Modify: `apps/desktop/src/state/projectStore.ts` (selector)

- [ ] **Step 1: Types**

In `ipc/index.ts`:

```typescript
export type AudioRole = "dialogue" | "music" | "sfx" | "voiceover";

export const AUDIO_ROLES: AudioRole[] = ["dialogue", "music", "sfx", "voiceover"];

export interface RoleMixView {
  role: AudioRole;
  gain_db: number;
  muted: boolean;
  solo: boolean;
}
```

Add `role: AudioRole;` to `AudioView` (after `mute`, ~line 176).
Add `audio_roles: RoleMixView[];` to `ProjectSummary` (after `groups`, ~line 233).
Add `role?: AudioRole;` to the Audio variant of `LayerParamsPatch` (the audio patch shape, ~line 355-363).

- [ ] **Step 2: IPC wrappers**

```typescript
export async function setRoleGain(role: AudioRole, gainDb: number): Promise<void> {
  return invoke<void>("set_role_gain", { role, gainDb });
}

export async function updateRoleFlags(
  role: AudioRole,
  patch: { muted?: boolean; solo?: boolean },
): Promise<void> {
  return invoke<void>("update_role_flags", { role, patch });
}
```

- [ ] **Step 3: Store selector**

In `state/projectStore.ts`, add near the other selectors (~line 134) — with a stable empty fallback to avoid re-renders:

```typescript
const EMPTY_ROLES: RoleMixView[] = [];

export const useAudioRoles = (): RoleMixView[] =>
  useProjectStore((s) => s.summary?.audio_roles ?? EMPTY_ROLES);
```

(Import `RoleMixView` from `ipc`.)

- [ ] **Step 4: Typecheck + commit**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean (no type errors).

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/state/projectStore.ts
git commit -m "feat(audio): TS types for AudioRole + audio_roles + role IPC wrappers"
```

---

## Task 7: TS preview parity — role gating + role-gain fold

**Files:**
- Create: `apps/desktop/src/render/audio/roleGate.ts` + `roleGate.test.ts`
- Modify: `apps/desktop/src/render/Compositor.ts:670-707` (audio selection loop)
- Modify: `apps/desktop/src/render/audio/AudioMixer.ts:120-139` (`updateView` + `deriveFromView`)

- [ ] **Step 1: Write the pure role-gate helper test (failing first)**

Create `apps/desktop/src/render/audio/roleGate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { anyRoleSolo, roleAudible, roleGainLinear } from "./roleGate";
import type { RoleMixView } from "../../ipc";

const roles: RoleMixView[] = [
  { role: "dialogue", gain_db: 6.0206, muted: false, solo: false },
  { role: "music", gain_db: 0, muted: true, solo: false },
  { role: "sfx", gain_db: 0, muted: false, solo: false },
  { role: "voiceover", gain_db: 0, muted: false, solo: false },
];

describe("roleGate", () => {
  it("muted role is not audible", () => {
    expect(roleAudible("music", roles, anyRoleSolo(roles))).toBe(false);
    expect(roleAudible("dialogue", roles, anyRoleSolo(roles))).toBe(true);
  });

  it("solo silences non-soloed roles; mute wins over solo", () => {
    const soloed: RoleMixView[] = [
      { role: "dialogue", gain_db: 0, muted: false, solo: true },
      { role: "music", gain_db: 0, muted: true, solo: true },
      { role: "sfx", gain_db: 0, muted: false, solo: false },
      { role: "voiceover", gain_db: 0, muted: false, solo: false },
    ];
    const any = anyRoleSolo(soloed);
    expect(any).toBe(true);
    expect(roleAudible("dialogue", soloed, any)).toBe(true);
    expect(roleAudible("sfx", soloed, any)).toBe(false);
    expect(roleAudible("music", soloed, any)).toBe(false); // mute wins
  });

  it("role gain linear matches dB; defaults to unity when absent", () => {
    expect(roleGainLinear("dialogue", roles)).toBeCloseTo(2.0, 2);
    expect(roleGainLinear("sfx", roles)).toBeCloseTo(1.0, 6);
    expect(roleGainLinear("dialogue", [])).toBeCloseTo(1.0, 6);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/desktop && npx vitest run src/render/audio/roleGate.test.ts`
Expected: FAIL — module `./roleGate` not found.

- [ ] **Step 3: Implement `roleGate.ts` (mirror of the Rust role logic)**

Create `apps/desktop/src/render/audio/roleGate.ts`:

```typescript
// Pure mirror of the Rust role gating in `audio/mix.rs::audible_audio_layers`
// + the role-gain fold in `plan_for_project`. Keep BYTE-FOR-BYTE in step with
// that logic — there is no cross-language test enforcing it (same discipline
// as the envelope/animation twins).
import type { AudioRole, RoleMixView } from "../../ipc";

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function anyRoleSolo(roles: RoleMixView[]): boolean {
  return roles.some((r) => r.solo);
}

/// A role is audible unless it is muted, or a solo set exists and it is not
/// soloed. Mute wins over solo. Absent role → audible (unity, unmuted).
export function roleAudible(
  role: AudioRole,
  roles: RoleMixView[],
  anySolo: boolean,
): boolean {
  const r = roles.find((x) => x.role === role);
  if (!r) return !anySolo; // absent ⇒ default (unmuted, not soloed)
  if (r.muted) return false;
  if (anySolo && !r.solo) return false;
  return true;
}

export function roleGainLinear(role: AudioRole, roles: RoleMixView[]): number {
  const r = roles.find((x) => x.role === role);
  return dbToLinear(r ? r.gain_db : 0);
}
```

Run: `cd apps/desktop && npx vitest run src/render/audio/roleGate.test.ts`
Expected: PASS.

- [ ] **Step 4: Fold role gain into the mixer**

In `render/audio/AudioMixer.ts`, give `updateView` a role-gain parameter and apply it in `deriveFromView`. Change the `updateView` signature to accept `roleGainLinear: number`, store it (`this.roleGainLinear = roleGainLinear`), and in `deriveFromView` (lines 120-139) scale the gain envelope after `sampleGain`:

```typescript
  this.gainEnv = sampleGain(
    this.view.gain_db,
    this.view.fade_in_us,
    this.view.fade_out_us,
    spanUs,
  );
  // Fold the role bus gain (v1 role-bus realization — see roleGate.ts).
  if (this.roleGainLinear !== 1) {
    for (let i = 0; i < this.gainEnv.values.length; i++) {
      this.gainEnv.values[i]! *= this.roleGainLinear;
    }
  }
```

(Add `private roleGainLinear = 1;` as a field; the constant fast path at line 131 `this.gainNode.gain.value = this.gainEnv.values[0]!` already picks up the scaled value.)

- [ ] **Step 5: Role gating + role gain in the Compositor selection loop**

In `render/Compositor.ts` (lines 670-707), replace the track mute/solo gate with role gating. Import the helper at the top:

```typescript
import { anyRoleSolo, roleAudible, roleGainLinear } from "./audio/roleGate";
```

Change the loop:

```typescript
const roles = this.projectSummary.audio_roles ?? [];
const anySolo = anyRoleSolo(roles);
const tickedAudio = new Set<string>();
for (const track of this.projectSummary.tracks) {
  if (!track.enabled) continue; // whole-track disable still gates
  for (const layer of track.layers) {
    if (!layer.enabled) continue;
    if (layer.params.kind === "Audio") {
      // Role gating moved off the track (M/S → roles).
      if (!roleAudible(layer.params.role, roles, anySolo)) continue;
      const audio = this.ensureAudio(layer);
      if (audio) {
        const rGain = roleGainLinear(layer.params.role, roles);
        if (audio.lastParamsRef !== layer.params || audio.lastRoleGain !== rGain) {
          const json =
            JSON.stringify(layer.params) +
            `|${layer.t_start_us}|${layer.t_end_us}|${rGain}`;
          if (json !== audio.lastParamsJson) {
            audio.mixer.updateView(
              layer.params,
              layer.t_start_us,
              layer.t_end_us,
              rGain,
            );
            audio.lastParamsJson = json;
          }
          audio.lastParamsRef = layer.params;
          audio.lastRoleGain = rGain;
        }
        tickedAudio.add(layer.id);
        audio.mixer.tick(tUsSnapped, this.playing, layer.t_end_us, this.clockAnchor);
      }
    }
  }
}
```

(Add a `lastRoleGain?: number` field to the per-layer audio record type next to `lastParamsRef`/`lastParamsJson` — grep its interface in `Compositor.ts`. The gated-out sweep loop below stays unchanged: layers skipped by role still get the pause-tick, since they're absent from `tickedAudio`.)

- [ ] **Step 6: Typecheck + run the audio unit tests**

Run: `cd apps/desktop && npx tsc -b && npx vitest run src/render/audio`
Expected: clean tsc; roleGate + existing envelope golden tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/audio/roleGate.ts apps/desktop/src/render/audio/roleGate.test.ts apps/desktop/src/render/audio/AudioMixer.ts apps/desktop/src/render/Compositor.ts
git commit -m "feat(audio): preview twin mixes by role (gate + gain fold)"
```

---

## Task 8: UI — remove track M/S, role dropdown, Mixer panel, i18n

**Files:**
- Modify: `apps/desktop/src/timeline/TrackHeader.tsx` + `timeline/geometry.ts`
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx` (`AudioFields`)
- Create: `apps/desktop/src/panels/MixerPanel.tsx`
- Modify: `apps/desktop/src/panels/RightPanel.tsx`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts`

- [ ] **Step 1: Remove M/S from the track header**

In `timeline/geometry.ts`, simplify `trackHeaderControls` (lines 54-76) — eye and lock are now unconditional (M/S left the header), so the helper collapses. Replace the interface + function with:

```typescript
// Track headers show eye (whole-track enable) + lock only. Mute/Solo moved
// to the Mixer panel (roles), removing the "what do M/S act on" ambiguity.
export function trackShowsEye(_track: TrackSummary): boolean {
  return true;
}
```

In `timeline/TrackHeader.tsx`, delete the two `{controls.showMute && (…)}` and `{controls.showSolo && (…)}` `FlagButton` blocks (the M and S buttons). Remove the now-unused `controls` derivation and replace any `controls.showEye` check with `trackShowsEye(track)` (or render the eye unconditionally). Keep the eye and lock buttons.

- [ ] **Step 2: Role dropdown in the audio property panel**

In `properties/PropertyPanel.tsx`, `AudioFields` (lines 987-1020), add a Role field above the Mute switch. Import `AppSelect` and the role constants:

```typescript
import { AUDIO_ROLES, type AudioRole } from "../ipc";
import { AppSelect } from "../components/AppSelect";
```

Inside the `<section>`, before the Mute `<Field>`:

```tsx
<Field label={t("property_panel.role")}>
  <AppSelect
    value={v.role}
    ariaLabel={t("property_panel.role")}
    onValueChange={(next) => commit({ kind: "Audio", role: next as AudioRole })}
    options={AUDIO_ROLES.map((r) => ({ value: r, label: t(`audio_roles.${r}`) }))}
  />
</Field>
```

(The `commit` helper already builds an Audio `LayerParamsPatch`; `role` now flows through Task 6's patch type → Task 3's apply arm.)

- [ ] **Step 3: Mixer panel**

Create `apps/desktop/src/panels/MixerPanel.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { AUDIO_ROLES, setRoleGain, updateRoleFlags, type AudioRole } from "../ipc";
import { useAudioRoles } from "../state/projectStore";
import { AppNumberField } from "../components/AppNumberField"; // grep for the project's number input; fall back to <input type=number> if absent

export function MixerPanel({ onMutated }: { onMutated: () => Promise<void> }) {
  const { t } = useTranslation();
  const roles = useAudioRoles();
  const byRole = new Map(roles.map((r) => [r.role, r]));

  return (
    <section className="mixer-panel" aria-label={t("mixer.title")}>
      <h3>{t("mixer.title")}</h3>
      {AUDIO_ROLES.map((role: AudioRole) => {
        const r = byRole.get(role) ?? { role, gain_db: 0, muted: false, solo: false };
        return (
          <div className="mixer-row" key={role}>
            <span className="mixer-role-name">{t(`audio_roles.${role}`)}</span>
            <AppNumberField
              value={r.gain_db}
              step={0.5}
              min={-30}
              max={20}
              ariaLabel={t("mixer.gain_db", { role: t(`audio_roles.${role}`) })}
              onCommit={(v) => setRoleGain(role, v).then(onMutated)}
            />
            <button
              className={r.muted ? "flag-btn active" : "flag-btn"}
              aria-pressed={r.muted}
              title={t("mixer.mute_hint")}
              onClick={() => updateRoleFlags(role, { muted: !r.muted }).then(onMutated)}
            >
              M
            </button>
            <button
              className={r.solo ? "flag-btn active" : "flag-btn"}
              aria-pressed={r.solo}
              title={t("mixer.solo_hint")}
              onClick={() => updateRoleFlags(role, { solo: !r.solo }).then(onMutated)}
            >
              S
            </button>
          </div>
        );
      })}
    </section>
  );
}
```

(If `AppNumberField` doesn't exist under that name, grep `components/` for the existing numeric input the property panel uses and match its prop names; the gain step/min/max mirror `GAIN_DB` from `keyframe/descriptors.ts`.)

- [ ] **Step 4: Mount the Mixer panel**

In `panels/RightPanel.tsx`, mount `MixerPanel` as a section inside `<aside className="right-panel">` (e.g. above the inspector section). Import it and pass `onMutated`:

```tsx
import { MixerPanel } from "./MixerPanel";
```
```tsx
      <MixerPanel onMutated={onMutated} />
      <section className="right-panel-inspector">
        {/* existing PropertyPanel */}
      </section>
```

- [ ] **Step 5: i18n**

In `i18n/locales/en-US.ts` add a top-level `audio_roles` block and a `mixer` block, and a `role` key under `property_panel`:

```typescript
  audio_roles: {
    dialogue: "Dialogue",
    music: "Music",
    sfx: "SFX",
    voiceover: "Voiceover",
  },
  mixer: {
    title: "Mixer",
    gain_db: "{{role}} gain (dB)",
    mute_hint: "Mute this role everywhere",
    solo_hint: "Solo this role (mutes the others)",
  },
```
```typescript
    role: "Role", // inside property_panel
```

In `zh-CN.ts` add the parallel keys:

```typescript
  audio_roles: {
    dialogue: "对白",
    music: "音乐",
    sfx: "音效",
    voiceover: "旁白",
  },
  mixer: {
    title: "混音",
    gain_db: "{{role}} 增益 (dB)",
    mute_hint: "静音此角色（全局）",
    solo_hint: "独奏此角色（静音其余）",
  },
```
```typescript
    role: "角色", // inside property_panel
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

```bash
git add apps/desktop/src/timeline/TrackHeader.tsx apps/desktop/src/timeline/geometry.ts apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/panels/MixerPanel.tsx apps/desktop/src/panels/RightPanel.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(audio): mixer panel + role dropdown; remove track M/S from header"
```

- [ ] **Step 7: Manual smoke (real WebView2)**

Run `npm run tauri:dev` from `apps/desktop`. Verify: (1) track headers show only eye + lock; (2) selecting an audio layer shows a Role dropdown; (3) the Mixer panel lists Dialogue/Music/SFX/Voiceover with gain + M/S; (4) importing a video creates a Dialogue-role audio layer, importing a standalone audio file creates a Music-role layer; (5) muting the Music role silences music in preview; raising Dialogue gain audibly boosts dialogue. Note any deviation before proceeding.

---

## Task 9: Conformance e2e + documentation

**Files:**
- Modify: the audio conformance e2e (pattern: `apps/desktop/e2e/.../audio_envelope.e2e.js` — grep the e2e dir) + any e2e that set track mute/solo
- Modify: `docs/audio.md`, `docs/data-model.md`
- Create: `docs/adr/0023-audio-mixes-by-role-not-track.md`
- Modify: `docs/superpowers/specs/2026-06-13-audio-track-abroll-integration-design.md` (status → superseded)

- [ ] **Step 1: Two-role conformance scenario**

Extend the audio conformance e2e (copy the structure of the existing `audio_envelope` scenario). Build a project with two audio layers: one assigned `dialogue`, one `music`. Drive via the role MCP/IPC tools: mute the `music` role (`set_role_flags`), export the window, and assert with the analyzer's `--audio-envelope` mode that music-band energy is gone while dialogue remains; then unmute, set `dialogue` role gain +6 dB (`set_role_gain`), export, and assert dialogue RMS rises by the analytic factor (~×2). Use the exact harness helpers + analyzer invocation from the existing audio e2e file (do not invent new harness API).

Also update any existing e2e/spec that sets `track.muted`/`track.solo` to silence audio — switch it to the role table (those track flags no longer gate audio).

- [ ] **Step 2: Run the e2e (real WebView2)**

Run the audio e2e per the project's e2e runner (per `feedback_wdio_spec_filter_windows`, invoke the wdio binary directly with `--spec` and confirm "Execution of 1 workers"; ensure `WEFTCUT_TEST_MEDIA` is set and `msedgedriver` matches WebView2; kill stray `weftcut`/`msedgedriver`/`tauri-driver` processes first so wdio doesn't run a stale binary).
Expected: the two-role scenario PASSES; existing audio suites stay green.

- [ ] **Step 3: Documentation**

- `docs/audio.md`: rewrite skip rules 1–6 — track `enabled` still gates (rule 1); **delete track muted/solo as audio gates**; add **role mute/solo** gates and **role gain fold**. Add a "Roles" subsection (the bus model + the v1 fold + the deferred per-role effects insert point). Update the "Out of scope" line that parked "track-level gain / buses / mixer UI" to point at this (now done for roles).
- `docs/data-model.md`: add `AudioParams.role` and `Project.audio_roles`; document the three control levels (clip mute / role M-S / track enable) and that track `muted`/`solo` are retained for back-compat but no longer gate.
- Create `docs/adr/0023-audio-mixes-by-role-not-track.md` recording the decision, the rejected alternatives (per-clip-only, two-stack), and the v1 fold realization.
- In `docs/superpowers/specs/2026-06-13-audio-track-abroll-integration-design.md`, set status to **Superseded** by this work (M/S left the track header), with a one-line pointer.

- [ ] **Step 4: Final gates + commit**

Run: `cd apps/desktop/src-tauri && cargo test` then `cd apps/desktop && npx tsc -b && npx vitest run`
Expected: all green.

```bash
git add docs/ apps/desktop/e2e
git commit -m "test(audio): two-role conformance e2e + docs (audio.md, data-model.md, ADR 0023)"
```

---

## Self-Review Notes

- **Spec coverage:** §1 role model → Tasks 1-2,7; §2 data model → Task 1; §3 mixing/routing + preview parity → Tasks 2,7; §4 control migration → Tasks 2 (gating), 8 (header); §5 role assignment → Tasks 4 (heuristic), 8 (dropdown); §6 UI → Task 8; §7 MCP → Tasks 3,5; §8 persistence/undo/back-compat → Tasks 1 (deser), 3 (recorded/unrecorded); §9 testing → Tasks 2,3,5,7,9. No migration (per decision) — intentionally absent. ✓
- **Type consistency:** `AudioRole` (Rust enum / TS union "dialogue"|…); `RoleMixSettings` (Rust) ↔ `RoleMixView` (IPC, with `role: String`/`AudioRole`); `RoleFlagsPatch { muted, solo }` used by history + actor + MCP + `updateRoleFlags`; `set_role_gain`/`update_role_flags` command names match the TS `setRoleGain`/`updateRoleFlags` invoke targets; `Project.role_mix()` used in mix.rs, actor, history, commands view; `Envelope::scale` defined Task 2 / used Task 2. ✓
- **Open names to confirm against the codebase during execution (flagged inline, not invented):** `DiffHint` variant for project-wide audio mutations; the actor test handle/undo/snapshot helper names; the `project_summary` builder factoring; the rmcp `#[tool]` macro form; `AppNumberField` (or the project's numeric input); the e2e harness file path + analyzer invocation. Each step says to grep the existing sibling and match it.
