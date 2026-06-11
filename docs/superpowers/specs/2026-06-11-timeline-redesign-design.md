# Timeline Redesign: Keyframes, Track Header, Visual Refresh

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan

## Goal

Redesign the timeline UI to (1) display and edit keyframes (the `AnimTrack<T>` data
model and the cross-engine interpolation path already ship; no UI reads them), (2) add
track-header controls (visibility / mute / solo / lock), and (3) refresh the visual
style to the app's neutral-gray Tailwind v4 + shadcn token system. Clip info density
(thumbnails, waveforms, badges) is explicitly **out of scope** for this round.

## Decisions (settled during brainstorming)

- **Keyframe paradigm — hybrid C+A.** Collapsed (default): the clip body shows
  diamonds for the *focused property only* (CapCut-like). Expanded (track twirl):
  AE-style per-property sub-lanes. When a track is expanded, its clips **stop**
  rendering collapsed-mode diamonds — no double display.
- **Focused property** follows property-panel focus: the field the user last
  focused/edited broadcasts `{ layerId, paramKey }`. Fallback: the layer's first
  keyframed property in panel order; none → no diamonds.
- **Keyframe creation — per-property stopwatch + auto-key** (AE model). No global
  record mode, no manual-only diamond button.
- **Track controls:** eye (visibility), M (mute), S (solo), lock — all four on every
  track (tracks are kind-agnostic; combined rows can hold visual + audio layers).
- **Visual direction — neutral gray.** Drop per-kind lane tints; track identity comes
  from clip colors. All values from the app.css theme tokens.
- **Implementation route — decompose first.** Split the ~1930-line `Timeline.tsx`
  into a module directory, translating legacy CSS to Tailwind in the same touch, then
  build keyframe UI on the clean base. Three independently mergeable phases.

## 1. Layout & module decomposition

### Two-column layout

Introduce a real track-header column (today track labels float over the lanes):

```
+----------------+-------------------------------------+
|  (corner)      |  Ruler (SMPTE / adaptive ticks)     |
+----------------+-------------------------------------+
| v V1 . A-Roll  |  [clip----*----*--]                 |
|   eye M S lock |                                     |
|     opacity    |  --*----*--------     <- sub-lane   |
|     scale      |  --*------*------     <- sub-lane   |
+----------------+-------------------------------------+
| > A2 . Audio   |       [clip--------]                |
|   eye M S lock |                                     |
+----------------+-------------------------------------+
```

Header column: fixed 160 px, sticky against horizontal scroll; ruler origin shifts
right accordingly. Sub-lane headers (property name) live in the same column, row-aligned
with their diamond lanes.

### Module split

`Timeline.tsx` (~1930 lines) becomes:

```
timeline/
  Timeline.tsx        orchestrator: scroll/zoom container, playhead, store wiring (target <= 400 lines)
  TimelineRuler.tsx   existing ruler, moved as-is
  TrackHeader.tsx     NEW: twirl, name, eye/M/S/lock
  TrackLane.tsx       lane rendering + drop zone + height drag (moved)
  LayerBlock.tsx      clip rendering + collapsed-mode diamonds (moved + extended)
  KeyframeLane.tsx    NEW: expanded property sub-lanes (phase 3)
  hooks/useTimelineZoom.ts, useLayerDrag.ts, useHeightDrag.ts
  geometry.ts         time<->px conversion, snap wiring (pure functions, unit-testable)
  contextMenu.tsx     existing context menu, moved
```

Decomposition rule: **move verbatim first** — zero behavior change, validated by
existing e2e suites plus a manual interaction checklist. Styling translates to Tailwind
in the same touch; interaction logic is NOT rewritten opportunistically.

Expansion state (which tracks are expanded) is **view state**: persisted via the
existing `viewStateSet` path alongside track heights. Not project data, not in undo.

## 2. Visual system (neutral-gray direction)

All hardcoded hexes are replaced with app.css Tailwind v4 theme tokens (same system as
the shadcn panels/dialogs):

| Area | Treatment |
|---|---|
| timeline background | deepest `--background` tier |
| track-header column | one tier lighter than lanes; 1 px `--border` on the right |
| lane background | uniform gray for all tracks (kind tints removed); optional faint odd/even striping |
| ruler | header-column tier; `--muted-foreground` text |
| property sub-lanes | one tier darker than lanes ("recessed" = subordinate) |

**Clips:** subtle vertical gradient + 1 px lightened border; `color_hint` remains the
clip's color source. Selected state: `--ring` token outline + slight brighten
(replaces the 2 px white outline), matching the app-wide focus-ring language. The 2 px
group-hue left border rule is unchanged.

**Keyframe glyph:** 45deg-rotated square. Collapsed (on clip): white, 7 px. Sub-lanes:
amber (tokenized `#facc15` family), 9 px. Selected: `--ring` outline. Interpolation
type is NOT encoded in glyph shape in v1 (right-click menu shows/sets it; shape
variants are later polish).

**Icons:** eye/M/S/lock/stopwatch/twirl all from lucide-react (ADR 0020 — the only
icon source). The custom blade-cursor SVG stays.

**CSS migration:** the timeline block in `styles.css` (~lines 431–1500) is translated
block-by-block as components move, then deleted. `MiniTimeline` uses separate
`.mini-timeline*` classes — untouched.

## 3. Track-header controls

Every track shows the same four controls (tracks are kind-agnostic):

| Control | Semantics | Data | Render-side change |
|---|---|---|---|
| eye | whole track off (video + audio) | `Track.enabled` (exists) | none — Compositor and `mix.rs` track loop already respect it |
| M | silence this track's audio layers only | `Track.muted: bool` (NEW) | one skip in the `mix.rs` track loop |
| S | solo: when any track is soloed, only soloed tracks are audible; mute wins over solo | `Track.solo: bool` (NEW) | collect solo set before the loop; skip non-solo tracks |
| lock | all layers on the track unselectable/undraggable/untrimmable/unbladeable | `Track.locked` (exists) | UI-side interception + actor-side rejection (same convention as locked group members) |

**Undo:** all four toggles go through an **unrecorded** patch path (the
`replace_settings_everywhere` convention) — undo never flips mute/solo back. New actor
op `update_track_flags` (unrecorded) carries all four booleans. The existing
`project:changed` bridge refreshes the UI.

**Export:** eye and M/S affect export (export shares `mix.rs` and the compositor).
Tooltips state this. No export-time interception in v1 (a soft warning when soloed is
possible later polish).

**Visual feedback:** eye off → lane clips at 40% opacity. M lit → red-family token.
S lit → yellow-family token. Locked track → existing layer-locked styling (dashed
outline + not-allowed cursor) applied lane-wide.

## 4. Collapsed-mode keyframes, stopwatch, write path

### Write path (currently missing entirely)

New actor op + IPC command, with a batch form:

```
update_layer_param_track  { layer_id, param_key, track: AnimTrack<f64> }
update_layer_param_tracks { entries: Vec<...> }   // one history step for multi-drag
```

Whole-track replacement: the frontend composes the full `AnimTrack` after any
add/delete/move/interp edit and sends it. Actor-side handling **normalizes rather than
rejects**: sort by `t_us`, snap times to the composition frame grid (actor-side snap
storage invariant), dedupe same-frame keys (last write wins). Hard rejections only for:
`Keyframed` with an empty array, and writes to locked tracks/layers. Recorded in
history; one gesture = one commit = one undo step.

v1 covers all `Animated<f64>` fields: `opacity, x, y, scale_x, scale_y, gain_db, pan`.
`Animated<Rgba>` has no interpolation engine yet — color fields get no stopwatch.

### Property panel: stopwatch

Each animatable field gets a lucide stopwatch icon on its left:

- **Light up** (Static → Keyframed): creates the first keyframe at the playhead with
  the current value.
- **Turn off** (Keyframed → Static): collapses to Static using the value evaluated at
  the playhead; discards all keyframes. Destructive but undoable; no confirm dialog.
- **Edit value while lit**: upserts a keyframe at the playhead's layer-relative time
  (playhead exactly on an existing key → update it; otherwise insert). This is
  auto-key.
- **Edit value while off**: writes Static, as today.

Field display upgrades from "read Static" to "evaluate via `resolveAnimated` at the
current playhead" — values track the playhead for keyframed fields. (Both engines are
golden-vector locked; preview rendering needs zero changes.)

### Focus broadcast

A small zustand store (`keyframeFocusStore`): `{ layerId, paramKey }`, written when a
panel field gains focus or its stopwatch is clicked. The collapsed clip renders that
param's diamonds if it matches `layerId` and the param is Keyframed. Fallback: first
keyframed property in panel order; none → nothing.

### Collapsed-mode diamond interactions (lightweight; heavy ops live in expanded mode)

- **Click**: select the diamond and seek the playhead to it (jump-and-edit flow).
- **Drag**: horizontal retime, frame-grid snapped, commit on release.
- **Del**: delete selection (deleting the last keyframe auto-collapses the track to
  Static at the current evaluated value).
- **Right-click**: interpolation menu — Hold / Linear / EaseIn / EaseOut. (Bezier is a
  linear stub in the engine; not in the menu.)

Keyframe times are layer-relative (existing data model), so diamonds ride along when
clips move. Keyframes pushed outside the clip span by trimming are **kept in data**;
collapsed mode does not render them (expanded mode renders them dimmed — section 5).

## 5. Expanded-mode property sub-lanes (KeyframeLane)

**Expansion granularity = track.** The twirl sits on the track header. Expanding
generates sub-lanes from the **union of keyframed properties** across all layers on
the track — one row per property; each diamond renders at
`owning layer.t_start + kf.t_us` absolute position. One `opacity` row can hold
diamonds from multiple clips (spatially separated since clips are; combined-row
visual/audio property sets don't intersect). Tracks with no keyframed property get a
grayed-out twirl.

```
v V1 . A-Roll  | [clipA------]      [clipB--------]
    opacity    |  -*----*-           -*--*-
    scale      |                      --*----*-
```

Sub-lanes: fixed 24 px height, not resizable. Row header is the property name only
(right-aligned in the header column). AE's prev/next-key navigation arrows are later
polish, not v1.

**Interactions:**

- **Click**: select + seek (consistent with collapsed mode). **Shift+click**: extend
  multi-select (no seek).
- **Drag on empty lane area**: marquee box-select across sub-lanes.
- **Drag selected diamonds**: group horizontal move, frame-snapped, commit on release.
  Cross-property/cross-layer selections convert per-layer relative times individually;
  one gesture is still one undo step via the batch `update_layer_param_tracks`.
- **Del / right-click interp menu**: applies to the whole selection.

**Out-of-range keyframes** (outside the clip span after trims): rendered at 40%
opacity at their true time position — selectable, deletable, draggable back. Data is
never dropped (complements collapsed mode's hide).

**Interplay with existing layout:** sub-lanes insert directly below their track row.
The height-drag handle stays on the main row (sub-lanes don't participate). The
playhead line spans sub-lanes. Blade, clip drag, drop zones are oblivious to
sub-lanes. Two overlapping visual layers with the same keyframed property may
interleave diamonds in one row — hit-testing disambiguates; acceptable for v1.

## 6. Data flow, error handling, testing, phases

### Data flow

```
panel stopwatch/edits ---+
collapsed diamond ops ---+--> update_layer_param_track(s) --> actor: normalize+store (recorded)
expanded diamond ops  ---+                                          |
track header eye/M/S/lock --> update_track_flags (unrecorded)       |
                                                                    v
                       project:changed --> projectStore --> Timeline/panel re-render
playhead (audio-master clock) --> panel resolveAnimated display / preview engine (already done, zero change)
```

### Error handling

Actor normalizes keyframe writes (sort, frame-snap, same-frame dedupe with
last-write-wins). Hard rejections: empty `Keyframed` array; writes to locked
tracks/layers (same convention as locked group members). Empty solo set → mixer takes
the normal path; no "everything muted" trap.

### Testing

- `geometry.ts` pure-function unit tests (time<->px, diamond hit, relative/absolute
  conversion).
- Rust unit tests for `update_layer_param_track` normalization (sort/snap/collapse/
  reject).
- Interpolation engines need no new tests — golden vectors lock both sides.
- **One new e2e** (real WebView2, existing wdio harness): stopwatch on → auto-key two
  frames → drag a diamond → export and sample frames to verify the animation took
  effect. This also closes the known keyframed-gain e2e gap.
- Phase-1 refactor safety net: zero-behavior-change rule + full run of existing
  export/audio e2e + manual interaction checklist (drag/trim/blade/groups/snap/zoom
  anchor).

### Phases (each independently mergeable)

1. **Decompose + visual refresh + track header** — includes Rust `muted`/`solo`
   fields, the two `mix.rs` skips, `update_track_flags`.
2. **Write path + stopwatch + collapsed diamonds** — `update_layer_param_track(s)`,
   panel playhead evaluation, focus broadcast.
3. **Expanded sub-lanes** — twirl, property-union rows, marquee/multi-drag/interp
   menu.

## Out of scope (this round)

- Clip thumbnails, audio waveforms, status badges (info density — deferred).
- Track rename UI entry.
- `Animated<Rgba>` (no interpolation engine yet) and Bezier interp authoring (engine
  stub is linear).
- Keyframe glyph shape variants per interp type; prev/next-key navigation arrows;
  solo-state export warning.
- MCP keyframe tools (natural follow-on once `update_layer_param_track` exists, but
  not part of these three phases).
- `MiniTimeline` restyle.
