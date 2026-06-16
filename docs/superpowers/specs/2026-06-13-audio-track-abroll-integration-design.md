# Audio Tracks × A/B-Roll: Clarifying Mute/Solo Without a Second Track Stack

> **Superseded** by the role-based mixing model ([ADR 0023](../../adr/0023-audio-mixes-by-role-not-track.md),
> [`docs/audio.md`](../../audio.md)). The conditional combined-row Mute/Solo this
> spec introduced has been replaced: audio mute/solo left the track header
> entirely and now live in a Mixer panel keyed by mixing **role**, not by track.
> The problem framing below (the Final-Cut-visual / Premiere-control seam) still
> reads true, but its resolution is the per-role mix bus, not row-conditional
> track controls. Retained for context only.

**Date:** 2026-06-13
**Status:** Implemented and merged to main. Plan:
`docs/superpowers/plans/2026-06-13-audio-track-abroll-integration.md` (all 6
tasks shipped — `trackHeaderControls` in `timeline/geometry.ts`, conditional
header + audio glyph in `TrackHeader.tsx`, `panels/peek.ts`
category/grouping, the `RightPanel.tsx` filter chips + sections, both
locales). Out-of-scope items below remain deferred.

## Problem

The A/B-roll redesign (V.2) made tracks **kind-agnostic** and introduced
**combined-row rendering** (V.6): a track holding a visual layer and an audio
layer that overlap in time draws both in one row, half-height — top = picture,
bottom = audio. The timeline redesign (Phase 1, merged) then put **eye / M / S /
lock** on *every* track header unconditionally.

The mismatch: Mute and Solo are audio-only semantics (`mix.rs` gates only Audio
layers; `Track.enabled`/`muted`/`solo` never touch video), but they render on
rows that read as "video." On a combined camera row the user can't tell what M/S
act on. Stated differently — WeftCut adopted Final Cut's **visual** model
(audio shown as a sub-lane under the picture in one row) but bolted on Premiere's
**control** model (per-track M/S). That seam is the confusion.

## Direction (chosen during brainstorming)

A **hybrid / CapCut-style** integration, *not* a Premiere two-stack split. A
full split (dedicated audio track type, AV clips linked across two stacks) was
rejected: it unwinds the kind-agnostic redesign and turns a 2-camera interview
from 2 combined rows into 4 lanes, defeating the workflow A/B-roll exists for.

Two further constraints from the product owner:

- **A/B-roll is the product's signature; audio must integrate *with* it.** In AB
  mode, add **as few persistent track rows as possible** — ideally zero new ones.
- The right-panel peek list ("top-right") should gain **categorization + a
  filter** so audio is fast to find among hidden-track content.

## Settled decisions

1. **Audio-lane identity is derived, not stored.** No new `Track` field, no
   schema bump. An audio-only track already renders full-height
   (`computeLayerSlices` returns `"full"` for single-class layers); we lean on
   that plus per-track content inspection. Continuous with the kind-agnostic
   model.
2. **Audio tracks stay `role`-null (additional).** They are therefore hidden by
   the AB role filter like any additional track — **AB mode gains no new
   persistent rows**. In Show-All they render as full-height audio lanes.
3. **Combined rows keep track-level M/S, but only when the row carries audio**,
   and those controls mean "this row's embedded audio." Preserves one-click
   solo/mute of a camera's dialogue. (`solo` remains cross-track — soloing camera
   A still ducks a Music lane; `mix.rs` `any_solo` already spans all enabled
   tracks, unchanged.)
4. **Eye stays "disable whole track" (picture + audio), unchanged from today.**
   We do **not** decouple eye into a picture-only toggle in v1 — that would mean
   changing `mix.rs` skip-rule 1 and could surprise (eye off → picture gone but
   dialogue still playing). Listed as a possible future refinement only.
5. **AB-mode audio M/S is reached via the existing R.7 inline-reveal**, not new
   peek chrome: click a peek item → the audio lane is temporarily injected into
   the timeline → use its header M/S. Peek gains zero buttons.

## 1. Control matrix — conditional header controls (the core fix)

`TrackHeader.tsx` today renders eye/M/S/lock unconditionally. Change it to derive
visibility from the track's own layers (`track.layers[].params.kind`):

| Track content | 👁 eye | M | S | 🔒 lock |
|---|:---:|:---:|:---:|:---:|
| Pure visual (no audio layer) | shown | — | — | shown |
| Combined (visual + audio) | shown | shown | shown | shown |
| Pure audio lane | — | shown | shown | shown |
| Empty | shown | — | — | shown |

- `hasAudio = track.layers.some(l => l.params.kind === "Audio")`
- `hasVisual = track.layers.some(l => isVisualKind(l.params.kind))` where the
  visual set = `VideoClip | ImageOverlay | Color | Text | Subtitles | Motif`.
- **M/S render only when `hasAudio`** — removes the "what do M/S act on" ambiguity
  on visual-only rows.
- **Pure audio lanes hide the eye.** For a track with no visual output, `enabled`
  (whole-track disable) and `muted` produce the same audible result, so M is the
  single audio on/off; eye is redundant and is dropped from the header.
- **No backend change.** `mix.rs` gating (`enabled`/`muted`/`solo`, mute-wins-
  over-solo, disabled-track-solo-doesn't-gate) is already correct and stays
  byte-for-byte. The track stays `enabled = true` on an audio lane; audio is
  gated by `muted`. This is purely which controls the header *renders*.

This refines — does not contradict — the timeline-redesign decision "all four on
every track": the four controls still exist on the model; we stop rendering the
ones that have no meaning for a track's current content.

## 2. Show-All: audio lane presentation

Audio-only (`role`-null, audio-bearing) tracks already render full-height audio
blocks via the existing slice logic. v1 adds only a **light visual distinction**
so a lane reads as "audio" at a glance (subtle tint and/or a music glyph in the
header). **Waveform rendering is out of scope** (a larger feature; the peek list
still falls back to a `♪` glyph today).

No change to track ordering: audio lanes appear wherever they were created.
"Audio gravitates to the bottom" sorting is **explicitly deferred** (see Out of
scope) — it risks conflicting with reverse-data-model ordering and the reserved
A-roll/B-roll skeleton, and the product owner ranked it secondary.

## 3. AB mode: peek enhancement (`RightPanel.tsx`)

The peek list shows layers on `role`-null tracks within ±Δ of the playhead,
today as a flat, all-kinds, time-sorted list. Enhance it:

- **Filter chips** at the top of the peek section: `All / Video / Audio / Text`.
  Selecting one shows only that category.
- **Sectioned-by-kind when "All" is selected**: group items under category
  headers (Video / Audio / Text), LIVE-first then by `t_start` within each
  section. A single active filter collapses to that one section.
- **Categorize by layer kind** (`item.layer.params.kind`), not the track-level
  `trackKind`, since a peek item is a layer and additional tracks are kind-
  agnostic. Mapping:
  - **Video:** `VideoClip | ImageOverlay | Color | Motif`
  - **Audio:** `Audio`
  - **Text:** `Text | Subtitles`
- **Filter state is session-ephemeral** (local component state), not persisted to
  `app_settings.json`. (Δ-window and display-mode persistence are unaffected.)
- **No M/S in peek rows.** Audio control in AB mode goes through inline-reveal
  (decision 5): the existing `onRevealTrack(trackId, layerId)` path already
  injects the clicked track's row, which renders a normal header with M/S.

```
Near playhead (5)   [All][Video][Audio][Text]
┌─ Video ───────────────┐   ← filter = All
│ 🎞 B-roll street  +0:02 │
├─ Audio ───────────────┤
│ 🎵 BGM_main       LIVE │
│ 🎵 VO_01          +0:01 │
├─ Text ────────────────┤
│ T  Caption 12     LIVE │
└────────────────────────┘
Selecting "Audio" collapses to the Audio section only.
```

## 4. Change surface

Frontend-only, no schema / `mix.rs` / IPC contract change:

- **`apps/desktop/src/timeline/TrackHeader.tsx`** — derive `hasAudio` /
  `hasVisual` from `track.layers`; conditionally render eye/M/S per the matrix.
- **`apps/desktop/src/timeline/TrackLane.tsx`** — optional light audio-lane visual
  treatment (tint / glyph) for full-height audio-only lanes.
- **`apps/desktop/src/panels/RightPanel.tsx`** — filter chips + kind sections in
  the peek list; category derived from `layer.params.kind`.
- **i18n** — strings for the filter chips and section headers (en-US + zh-CN).

Unchanged: `mix.rs`, `commands.rs` (`TrackSummary` already carries the layer list
needed to derive content), the Rust `Track` model, drop/placement/"Separate
audio" routing, undo history.

## Out of scope (v1) / future

- **Audio waveform rendering** in lanes and peek thumbnails.
- **"Audio gravitates to bottom" sorting** of audio-only tracks in Show-All.
- **Eye → picture-only decoupling** (would change `mix.rs` skip-rule 1).
- **Filter persistence** to `app_settings.json`.
- **Inline mute on peek rows** (quick-duck without reveal).
- **Stored audio track type / persistent named Music/VO/SFX lanes** (the
  rejected stored-identity branch — revisit only if the derived approach proves
  insufficient).
- **Auto-routing** of dragged pure-audio media / "Separate audio" to a dedicated
  bottom audio zone.

## Related

- `docs/superpowers/specs/2026-06-11-timeline-redesign-design.md` — the eye/M/S/
  lock header this refines.
- A/B-roll redesign (V.2): kind-agnostic tracks, combined rows, role filter, peek
  list, inline-reveal (R.7), Separate audio (V.7).
- `docs/audio.md` — the layer skip rules (1–7) that M/S/enabled drive; unchanged
  by this design.
- `docs/groups.md` — overlap invariant (visual class vs audio class coexist on
  one track), which combined rows depend on.
