---
status: accepted
---

# Audio mixes by role, not by track

## Context

WeftCut put **eye / M / S / lock** on every track header, inheriting
Premiere's per-track audio-control model. That model fought two
established WeftCut decisions:

- The A/B-roll redesign made tracks **kind-agnostic** and introduced
  **combined-row rendering** — one track row holds a camera's picture
  and its dialogue together, half-height. Mute and Solo are audio-only
  (`mix.rs` only ever gated Audio layers), yet they rendered on rows
  that read as "video." On a combined camera row the user could not tell
  what M/S acted on. WeftCut had adopted Final Cut's *visual* model
  (audio as a sub-lane under the picture) but bolted on Premiere's
  *control* model (per-track M/S); that seam was the confusion the
  2026-06-13 integration spec (since retired) tried to paper over with
  conditional, audio-only header controls.
- Per-track mute/solo also gives no handle for the operations editors
  actually reach for — "duck **all** dialogue", "solo **the music**".
  Those cut across tracks; a per-track control cannot express them
  without the user toggling every track by hand.

The mixing engine (ADR 0019) is otherwise settled: one declarative
model, two thin renderers, gain/pan/fade envelopes folded once and read
identically by the preview and the Rust export mixer. The only open
question was the **grouping axis** for mute/solo/gain.

## Decision

**Audio mixing groups by a per-layer *role*, not by track.** Each audio
layer carries an `AudioRole` (Dialogue — the default — Music, SFX,
Voiceover), and the project holds one `RoleMixSettings { gain_db, muted,
solo }` per role in `Project.audio_roles`. A role is a mix bus; the
Mixer panel, keyed by role, owns the M/S/gain controls.

- **Track mute/solo are retired as audio gates.** The `Track.muted` and
  `Track.solo` fields stay on the struct so old projects and callers
  round-trip, but neither the export planner nor the preview reads them.
  The only whole-track gate left is `Track.enabled` (the eye — picture
  *and* audio off together).
- **v1 realizes the bus by folding.** Role gain converts to linear and
  multiplies into each member layer's gain envelope before the mix; role
  mute and the role-solo set filter which layers enter the plan (mute
  wins over solo). The per-block summing loop in `mix_block` is
  unchanged — there is no separate per-role sum or insert. A future
  per-role effect chain (`RoleMixSettings.effects`) is the named
  extension point that would turn the fold into a real processing bus;
  v1 adds no DSP.
- **Role gain is recorded; role mute/solo are not.** `set_role_gain` is
  an undoable edit; `update_role_flags` (mute/solo) is applied to every
  history snapshot and never recorded, mirroring `update_track_flags` —
  Ctrl-Z must never flip a mixer toggle.
- **No schema bump.** `audio_roles` and `AudioParams.role` are additive
  `#[serde(default)]` fields; old `.vproj` files load with an empty role
  table (every role at unity) and audio layers defaulting to Dialogue.

The live design — the skip rules, the fold, the three control levels —
lives in [`audio.md`](../audio.md); this ADR records only why the axis
is role and not track.

## Alternatives considered and rejected

- **Per-clip-only mixing** (keep `AudioParams.gain_db`/`mute`; no group
  layer): every layer is independently adjustable, but there is no
  handle for "all dialogue" or "just the music" — the editor toggles
  each clip by hand, and a category-wide trim is N edits instead of one.
- **Premiere-style two-track-stack + bus mixer** (a dedicated audio
  track type, AV clips linked across two stacks, buses assigned per
  track): this reintroduces exactly the double-lane-count the A/B-roll
  redesign exists to avoid — a 2-camera interview goes from 2 combined
  rows to 4 lanes — and unwinds the kind-agnostic track model. The
  signature workflow loses to the mixer.
- **Conditional per-track M/S** (the 2026-06-13 spec: show audio-only
  M/S only on rows that carry audio): treats the symptom, not the cause.
  The control still rides a row, still cannot express cross-track "all
  dialogue", and leaves the visual/control-model seam in place. The role
  bus dissolves the seam by moving M/S off the timeline entirely.

## Consequences

- Mute, solo, and gain now operate on a small, fixed set of buses that
  span every track; "duck all dialogue" is one toggle. The combined-row
  header sheds M/S — eye and lock are the only track-header controls —
  so a camera row no longer poses the "what does M act on?" question.
- The export planner (`audible_audio_layers`) and the preview gate
  (`roleGate.ts`) share one role predicate and one gain fold; they join
  the envelope/animation twins under the byte-for-byte cross-language
  drift discipline (no automated cross-language test enforces it).
- `Track.muted`/`solo` become dead audio inputs that still serialize and
  still accept `update_track_flags` patches — a deliberate back-compat
  cost, not a bug. A later cleanup could drop them on a schema bump.
- The Mixer panel becomes the home for audio level control, decoupled
  from the timeline; the master meter (ADR 0019) feeds it.

## References

- ADR 0019 — audio mixes in Rust over a conform PCM cache (the engine
  this grouping axis sits on; the master meter).
- [`audio.md`](../audio.md) — the evergreen description of the role
  model, the skip rules, and the fold.
- [`data-model.md`](../data-model.md) — `AudioParams.role`,
  `Project.audio_roles`, and the retained-but-dead `Track` flags.
- The 2026-06-13 audio × A/B-roll integration spec (since retired) — the
  conditional-header approach this ADR supersedes.
