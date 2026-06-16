# Audio Roles: Mix by Role, Not by Track

**Date:** 2026-06-16
**Status:** Draft (brainstorming output, pre-plan)

## Problem

The A/B-roll redesign made tracks **kind-agnostic** (the `TrackKind` enum is
gone — any layer kind lives on any track) and introduced **combined-row
rendering** (one track holding a visual + audio layer draws both in one row,
half-height). But audio mixing semantics — `Track.enabled` / `muted` / `solo`
in `mix.rs` — still hang on the **track**, which now has no audio identity.

The consequences the user hit:

- An audio layer feeds the single master mix **regardless of which track it
  sits on**, so the track has no routing meaning — "what does muting this track
  do to my mix?" depends on which layers happen to live there.
- On a combined row, per-track M/S read as if they act on the picture.
- `solo` is cross-track but `mute` is per-track — two scopes on adjacent
  buttons.
- There is **no stable identity for a kind of sound** (dialogue / music / SFX),
  so "boost all dialogue" or "denoise all dialogue" has nowhere to attach.

WeftCut adopted Final Cut's **visual** model (audio as a sub-lane under the
picture) but bolted on Premiere's **per-track control** model. That seam is the
confusion.

## Direction (settled during brainstorming)

Adopt Final Cut's **Roles** model: an audio *role* is a label on each audio
layer declaring what kind of sound it is, and each role is a **mix bus**.
Rejected alternatives: per-clip-only mixing (CapCut — no handle for "all
dialogue"); a Premiere/Fairlight two-track-stack + bus mixer (reintroduces the
double lane count the A/B-roll redesign exists to avoid).

Two load-bearing decisions, both settled:

1. **Audio M/S migrates fully from track to role.** The track header keeps only
   eye (`enabled`) + lock. This **supersedes** the 2026-06-13 conditional
   combined-row M/S work (`docs/superpowers/specs/2026-06-13-audio-track-abroll-integration-design.md`).
2. **This plan ships the model only** — roles, role buses (gain / mute / solo),
   the control migration, the UI, and MCP. **Voice amplification comes free**
   (it is just role gain). **Denoise / audio effect inserts are a separate
   plan** that rides the role buses defined here; this spec specifies the
   attachment point but adds no DSP.

## 1. The role model

```
per role bus:  Σ (its audible audio layers, each with clip gain/pan/fades)
                 → role gain → [role effect insert — future plan]
master:        Σ role buses → limiter (−1 dB, existing) → output
```

A role is one of a fixed v1 set: **Dialogue / Music / SFX / Voiceover**.
Custom roles and sub-roles are deferred. Mixing now groups by "what kind of
sound is this," independent of which track or lane the clip occupies. Tracks
return to being pure layout / z-stack; A/B-roll, combined rows, and the
kind-agnostic model are all unchanged.

## 2. Data model

**`AudioParams` gains a role.** (`state/layer.rs`)

```rust
pub struct AudioParams {
    // … existing: media, src_in_us, src_out_us, gain_db, pan,
    //   fade_in_us, fade_out_us, mute …
    #[serde(default)] // legacy audio layers → AudioRole::Dialogue
    pub role: AudioRole,
}

#[derive(Clone, Copy, …, Default)]
pub enum AudioRole {
    #[default] Dialogue,
    Music,
    Sfx,
    Voiceover,
}
```

**`Project` gains a role-bus table.** (`state/project.rs`)

```rust
#[serde(default)]
pub audio_roles: imbl::HashMap<AudioRole, RoleMixSettings>,

pub struct RoleMixSettings {
    pub gain_db: f64,   // static dB; keyframed role gain is deferred
    pub muted: bool,
    pub solo: bool,
}
```

- Absent keys resolve to `RoleMixSettings::default()` (`gain_db = 0.0`, not
  muted, not soloed) via a `Project::role_mix(role)` getter — so legacy
  projects (no `audio_roles`) behave as "all roles at unity, nothing muted."
- The mixer UI iterates roles in a **fixed canonical order**
  (Dialogue, Music, SFX, Voiceover), not `HashMap` order.
- **Effect inserts attach here.** The denoise plan adds
  `effects: Vec<AudioEffect>` to `RoleMixSettings`; this spec defines no
  `AudioEffect` and no DSP. `RoleMixSettings` is the documented seam.

## 3. Mixing & routing

**v1 fold strategy (no `mix_block` change).** With no per-role effects yet, a
role bus is mathematically equivalent to folding:

- **role gain** (scalar → linear) multiplies each member layer's gain envelope
  at plan-construction time, because a scalar distributes over the sum:
  `Σ buses = Σ (layer × roleGain)`.
- **role mute / solo** filter the audible-layer set.

So the per-block summing loop (`mix_block`) is **unchanged**; only selection +
gain scaling change. The audible-layer walk replaces track mute/solo with role
mute/solo:

```
audible_audio_layers(project, window):
    any_solo = any role in project.audio_roles has solo == true
    for track in tracks:
        if !track.enabled: continue            # rule 1 (whole track off) — kept
        # track.muted / track.solo NO LONGER gate audio
        for layer in track.layers:
            if !layer.enabled || layer.locked: continue
            let Audio(p) = layer.params else continue
            if p.mute: continue                # per-clip mute — kept
            role = project.role_mix(p.role)
            if role.muted: continue            # role mute
            if any_solo && !role.solo: continue # role solo; mute wins over solo
            if out of window: continue
            yield (layer, p, role)
```

`plan_for_project` then multiplies each layer's resolved gain envelope by
`10^(role.gain_db/20)`. `conform_waiting_media` uses the same walk.

> When the denoise plan adds per-role effects, it upgrades `mix_block` to real
> per-role accumulators (an effect cannot distribute over a sum). That upgrade
> is explicitly out of scope here and is noted in §10.

**Preview parity.** `render/audio` (the Rust/TS twin) applies the identical
fold: skip layers whose role is muted / soloed-out, multiply the layer's gain
by the role's linear gain. The `audio_roles` table is already in project state
synced to the store. Parity is locked by the existing envelope golden-vector
discipline (`docs/render.md`, `docs/audio.md`).

## 4. Control migration

Three non-overlapping levels replace the ambiguous per-track audio M/S:

| Level | Control | Meaning |
|---|---|---|
| Clip | `AudioParams.mute` (exists) | silence **this one clip** |
| **Role** | **M / S** (new, in the mixer panel) | mute / solo **this kind of sound** — the mix layer |
| Track | eye (`enabled`) + lock | whole track off (picture + audio) / edit guard |

- **The track header loses M / S** (`timeline/TrackHeader.tsx`); it keeps eye +
  lock. The 2026-06-13 `hasAudio`-conditional M/S logic is removed.
- `Track.muted` / `Track.solo` stay on the struct for `.vproj`
  back-compat deserialization but **no longer gate the mix** and are no longer a
  control surface. `update_track_flags` keeps `enabled` / `locked`.
- `solo` keeps its shape, lifted to the role level: any role soloed ⇒ only
  soloed roles audible; **mute wins over solo**.

## 5. Role assignment

- **Import heuristic** (initial value): audio split from an imported video (the
  AV-pair audio) → `Dialogue`; a standalone imported audio file → `Music`.
- **Manual override**: a Role dropdown on the audio layer's property panel
  (and via MCP, §7). Right-click "set role" is a possible convenience, not
  required for v1.

## 6. UI

- **Mixer panel** — the per-role surface `docs/audio.md` parked as "mixer UI
  belongs to the UX redesign." One row per role in canonical order: name +
  gain fader (dB) + M + S. Reachable from the timeline toolbar (exact placement
  is a plan-level detail). The existing master meter (already plumbed to the
  PerfHUD / MCP) can surface here later; not required for v1.
- **Role dropdown** on the audio-layer property panel.
- Combined-row rendering is unchanged; the audio half simply no longer carries
  M/S (those live in the mixer).
- i18n strings (en-US + zh-CN) for role names, the mixer panel, and the
  dropdown.

## 7. MCP surface

- **Assign role**: extend the audio layer's `update_layer_params` to accept
  `role` (preferred — one tool), or a dedicated `set_audio_role(layer, role)`.
- **Role mix**: `set_role_gain(role, gain_db)` (recorded — undoable, like clip
  `gain_db`) and `set_role_flags(role, { muted?, solo? })` (**unrecorded**,
  mirroring `update_track_flags` so undo never flips a mute).
- The `composition://compiled` MixPlan summary and any role/meter resource
  reflect roles so agents can reason about the mix.

## 8. Persistence, undo, back-compat

- **Recorded vs unrecorded**: role **gain** is a recorded edit (undoable); role
  **mute / solo** are unrecorded (mixer preferences), matching the established
  clip-gain-recorded / track-flags-unrecorded split
  (`project_settings_patch_convention`).
- **Schema**: `AudioParams.role` and `Project.audio_roles` are both
  `#[serde(default)]`, so old `.vproj` files load without migration — every
  audio layer becomes `Dialogue`, every role unity/unmuted.
- **Behavior change on load**: a legacy project that relied on a **muted track**
  to silence audio will now play that audio (track mute no longer gates). The
  app is pre-release, so this is acceptable; an optional one-time load migration
  (muted track → set its audio layers' clip `mute`) is available if we want
  zero behavioral drift. **Default: no migration** unless the user asks.

## 9. Testing

- **Rust mixer unit tests** (extend `audio/mix.rs`): role mute skips the role's
  layers; role solo silences non-soloed roles; mute-wins-over-solo at role
  level; role gain scales the summed output by the expected linear factor;
  legacy project (no `audio_roles`) mixes at unity.
- **Cross-language parity**: the role fold (gain multiply + role gate) asserted
  on both the Rust and TS sides, consistent with the envelope golden discipline.
- **Conformance E2E** (extends `docs/conformance.md`): a two-role fixture
  (dialogue + music) — mute Music ⇒ only dialogue energy; set Dialogue role
  gain ⇒ measured RMS shift matches the analytic factor.
- **Back-compat deserialization**: audio layer JSON without `role` → `Dialogue`;
  project JSON without `audio_roles` → defaults.

## 10. Scope

**In v1 (this plan):**

- `AudioRole` on audio layers + `Project.audio_roles` role-bus table.
- Role-grouped mixing (gain fold + role mute/solo gating) in `mix.rs` and the
  preview twin.
- Track M/S → role M/S migration (track header keeps eye + lock).
- Import heuristic + manual role assignment.
- Mixer panel (gain + M/S per role) + role dropdown + i18n.
- MCP role assignment + role mix tools.
- Tests above.

**Deferred (separate plans):**

- **Audio effect inserts + Denoise** — `RoleMixSettings.effects: Vec<AudioEffect>`
  + a DeepFilterNet-class **offline job producing a processed conform sibling**
  (per `docs/audio.md`); the role bus is the attachment point. Upgrades
  `mix_block` to real per-role accumulators.
- **Keyframed role gain** (v1 role gain is static).
- **Custom roles / sub-roles.**
- **Retime / speed** and **music Remix-to-duration** — independent of this
  model; tracked separately.

## Related

- `docs/audio.md` — the envelope contract, skip rules, and the parked
  "track-level gain / buses / mixer UI" this realizes; will need a §update when
  shipped.
- `docs/data-model.md` — `Track` flags and the kind-agnostic track model; the
  role field + role-bus table land here.
- `docs/superpowers/specs/2026-06-13-audio-track-abroll-integration-design.md` —
  the conditional combined-row M/S this supersedes.
- A new ADR ("audio mixes by role, not by track") should record this shift; the
  implementation plan writes it.
