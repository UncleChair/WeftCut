# Keyframe Navigator: AE-style Per-Property ◄ ◆ ► Controls in the Expanded Sub-lanes

**Date:** 2026-06-16
**Status:** Draft — brainstormed and approved; implementation plan pending.

## Goal

Add an After Effects-style **keyframe navigator** — a three-button group `◄ ◆ ►`
(previous keyframe / set keyframe at playhead / next keyframe) — to the **left of
each property row** in the expanded keyframe sub-lane header. Today the expanded
sub-lane (`KeyframeLane` + `KeyframeLaneHeaders`) shows one row per animated
property with only a right-aligned property-name label; there is no per-property way
to step between keys or to toggle a key at the playhead from the timeline. This adds
that, matching the AE keyframe-navigator affordance.

Scope is **purely frontend**. It reuses the shipped `update_layer_param_track` write
path and the existing pure transforms in `keyframe/edits.ts`. No backend, IPC, Rust,
engine, schema, or export change — therefore **no engine-pair drift risk** (the #1
keyframe hazard).

## Relationship to the timeline keyframe arc

This sits on top of the already-shipped keyframe authoring stack:

- `2026-06-11-timeline-redesign-design.md` — the focus model (`focusStore`) and the
  hybrid collapsed-diamonds / expanded-sub-lane paradigm.
- `2026-06-14-keyframe-authoring-design.md` — the per-property stopwatch
  (`AnimatableField`) that turns animation on/off and the `update_layer_param_track`
  write path.
- `2026-06-14-keyframe-sublanes-design.md` — the expanded `KeyframeLane` /
  `KeyframeLaneHeaders` surface this navigator is added to.

**Clean split from the stopwatch.** The inspector stopwatch turns a property's
animation *on/off* (Static ↔ Keyframed). The navigator's `◆` only **adds/removes
keys on an already-animated property** — it never lifts Static→Keyframed or collapses
the track itself (except the natural last-key-removed collapse, see §2). A property
row only exists once some clip has that param Keyframed (`trackKeyframeProperties`
filters to `mode === "Keyframed"`), so by the time a navigator is visible, animation
is already on. This keeps the two controls non-overlapping.

## Decisions (settled during brainstorming)

- **Middle button `◆` = add/remove keyframe at the playhead** (AE-faithful), *not* an
  easing/settings popup. Filled ◆ when a key sits exactly on the frame-snapped
  playhead → click removes it; hollow ◇ when none → click adds one at the current
  value. The easing/preset menu already exists via right-click on a diamond and is
  unchanged.
- **Prev/next `◄ ► ` traverse the target clip's keys only** (not all clips' keys in
  the row). On a multi-clip track, the navigator follows the focused clip; see the
  target-clip resolution below.
- **Navigator shows on every property row** (matching AE and the approved mockup),
  collapsed (24px) and expanded (72px) alike — not only the focused row.
- **Target-clip resolution per row** (see §3) — focused clip first, sole-keyframed
  clip as fallback, otherwise the navigator is disabled. This makes the common
  one-clip-per-track case work with no prior click.
- **Placement:** buttons pinned to the **left** of the header-column row; the
  property-name label stays right-aligned, adjacent to the body (AE layout). Lucide
  icons, styled like the existing `anim-stopwatch` button.

## 1. Layout

`KeyframeLaneHeaders` renders inside the sticky 160px header column
(`HEADER_COL_PX`), one row per `trackKeyframeProperties(track)` entry, row-aligned
with the body lanes by sharing `KF_SUBLANE_H` / `KF_SUBLANE_EXPANDED_H`. Today each
row is `flex items-center justify-end` with just the label.

Change each row to `flex items-center justify-between`: the `KeyframeNavigator`
button group on the left, the property-name label on the right (still adjacent to the
body edge). The three icon buttons (~12px Lucide glyphs) fit the 24px collapsed row;
in the 72px expanded row they stay top-aligned.

## 2. Button behavior

For the row's `paramKey` and its resolved **target clip** (§3), let
`trk = readParamTrack(layer.params, paramKey)` and
`tLocalUs = snapFrameRound(currentTimeUs − layer.t_start_us, fpsNum, fpsDen)`
(layer-local, frame-snapped — keys are frame-snapped by the actor, so equality is
exact).

- **◄ Previous / ► Next.** Find the prev/next key by `t_us` relative to `tLocalUs`
  (`prevKeyAt` / `nextKeyAt`, §4). On click: `transportSeek(layer.t_start_us +
  key.t_us)`, then `selectKeyframe({layerId, paramKey, kfId})` +
  `setKeyframeFocus(layerId, paramKey)` so the landed key highlights and its row
  becomes the focused/editable one (same side-effects as `LayerCurveLane.onSelectSeek`).
  `◄` disabled when no earlier key; `►` disabled when no later key.
- **◆ Set.** Let `at = keyAt(trk, tLocalUs)` (§4).
  - `at` found → filled ◆; click commits `removeKeyframe(trk, at.id, fallback)`. If it
    was the last key, `removeKeyframe` collapses the track to Static (the row then
    disappears) — existing behavior, accepted.
  - `at` not found → hollow ◇; click commits
    `upsertKeyframe(trk, tLocalUs, displayValue(trk, tLocalUs, fallback))` — a new key
    at the current evaluated value. `displayValue` and `fallback` come from the
    existing `AnimatableField` helper and the param descriptor.
  - **Disabled** (greyed, hollow) when the playhead is **off the target clip's span**
    (`tLocalUs < 0 || tLocalUs > layer.t_end_us − layer.t_start_us`) — can't author
    off-clip, matching the stopwatch's `playheadInSpan` gate.

All `◆` commits go through the existing `onCommitParamTrack(layerId, paramKey, next)`
(which calls `updateLayerParamTrack` then `onMutated`). One click = one undo step,
as the actor already guarantees.

## 3. Target-clip resolution

A sub-lane row is a **union across the track's clips** for one param, but the
navigator must act on a single clip. Resolve per row (param `P`):

1. **Focused clip** — if `focusStore.layerId` is a layer in this track *and* that
   layer has `P` Keyframed → target it.
2. **Sole keyframed clip** — else if exactly one layer on the track has `P`
   Keyframed → target it.
3. **Ambiguous** — else (multiple keyframed clips, none focused) → navigator
   **disabled**.

Rule 2 makes the dominant one-clip-per-track case work with zero prior interaction.
Rule 1 honors the approved "prev/next follow the focused clip" decision on multi-clip
tracks; clicking any diamond or inspector field already sets focus
(`setKeyframeFocus`), so the user steers which clip the navigator follows. Because
rules 1–2 only ever target a clip that *has `P` Keyframed*, `◆` never needs to lift a
Static track — reinforcing the stopwatch/navigator split (§ Goal).

## 4. Pure query helpers — `keyframe/nav.ts` (new, unit-tested)

Distinct from the *transforms* in `edits.ts` (which return new tracks); these are
read-only *queries* over a `AnimTrack<number>`. Layer-local µs in, `Keyframe | null`
out. Static tracks have no keys → all return `null`.

```
keyAt(track, tUs):     Keyframe | null   // key with t_us === tUs (exact; caller pre-snaps)
prevKeyAt(track, tUs): Keyframe | null   // greatest key with t_us < tUs
nextKeyAt(track, tUs): Keyframe | null   // least key with t_us > tUs
```

`prev`/`next` use strict `<` / `>` so that, when the playhead sits exactly on a key,
`◄`/`►` step *off* it to the neighbors rather than re-selecting it.

## 5. Component — `timeline/KeyframeNavigator.tsx` (new)

Props: `{ track: TrackSummary, paramKey: string, fallback: number, currentTimeUs,
fpsNum, fpsDen, onCommitParamTrack }`. Internally:

- Subscribes to `focusStore` (atomic selector, per the zustand composite-selector
  rule) to resolve the target clip (§3).
- Computes `tLocalUs`, the disabled state, and the `◆` filled/hollow state from §2/§4.
- Renders three buttons (`ChevronLeft` / `Diamond` / `ChevronRight` from
  `lucide-react`), styled like `anim-stopwatch`; `Diamond` filled vs outline conveys
  the key-at-playhead state; `aria-label`/`title` from new i18n keys
  (`keyframe.nav_prev` / `keyframe.nav_set` / `keyframe.nav_next`, en-US + zh-CN).

`KeyframeLaneHeaders` gains four props threaded from `Timeline.tsx` — `currentTimeUs`,
`fpsNum`, `fpsDen`, `onCommitParamTrack` — all already in scope at the call site
(`Timeline.tsx` ~line 563). It passes them plus the row's descriptor `fallback` into
each `KeyframeNavigator`.

## 6. Determinism, migration, docs

- **Determinism/export:** untouched. Same `update_layer_param_track` write path and
  same `resolveAnimated`; `◆` authors exactly the keys the diamonds/inspector already
  author, only via a different gesture. Existing golden vectors and
  `keyframe_authoring.e2e.js` remain the gate and must stay green.
- **Migration:** none — no stored shape changes.
- **Docs:** update the timeline keyframe-authoring section (evergreen tone — no
  dates/phase numbers) to mention the per-property navigator and what `◆` does
  vs. the stopwatch.

## 7. Testing

- **Pure unit (vitest)** — `keyframe/nav.ts`: empty/Static track; single key;
  playhead before-first / after-last / exactly-on-key (prev/next step off it);
  interior. Round-trips against `edits.ts` add/remove on the same fixture.
- **Component (RTL)** — `KeyframeNavigator`: filled vs hollow vs disabled ◆ state by
  playhead position; `◆` dispatches `removeKeyframe`/`upsertKeyframe` via
  `onCommitParamTrack`; arrows dispatch `transportSeek` + select/focus and respect the
  disabled-at-ends rule; target-clip resolution rules 1/2/3 (focused vs sole vs
  ambiguous-disabled).
- **Gate:** `npx tsc -b` clean (vitest transpiles without full typecheck — always run
  `tsc -b` per the keyframe-authoring lesson) + vitest green.
- **e2e:** the shipped `keyframe_authoring.e2e.js` already covers the write path
  end-to-end in real WebView2; a dedicated navigator e2e is **optional**, not a
  blocker, since the navigator only re-drives the same already-gated path.

## Out of scope (this round) / future

- **Auto-key while scrubbing** (AE's "create keyframe on any value change with
  stopwatch on") — orthogonal; the stopwatch already exists, this round only adds
  manual navigation/toggle.
- **Navigator on the collapsed in-clip view (`LayerBlock`)** — the in-clip diamonds
  keep their current click-seek/drag-retime/Delete behavior; the navigator lives in
  the expanded sub-lane only.
- **`Animated<Rgba>` color rows** — Color/Subtitles still have no f64 sub-lanes
  (needs the Rust `Rgba::value_at` twin first); the navigator inherits that gap.
- **Multi-clip simultaneous navigation** (operate on all clips' keys at once) — the
  decided model is single-target (focused/sole clip).

## Related

- `docs/superpowers/specs/2026-06-14-keyframe-authoring-design.md` — stopwatch +
  `update_layer_param_track` write path + `AnimatableField` (`displayValue`).
- `docs/superpowers/specs/2026-06-14-keyframe-sublanes-design.md` — the
  `KeyframeLane` / `KeyframeLaneHeaders` surface.
- `docs/superpowers/specs/2026-06-15-inline-keyframe-curve-graph-design.md` — the
  expanded-lane curve graph the navigator coexists with.
- `docs/data-model.md` — `Animated<T>` / `Keyframe` / `Interpolation`, frame-snap
  storage invariant.
