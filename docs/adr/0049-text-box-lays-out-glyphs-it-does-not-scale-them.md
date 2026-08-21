---
status: accepted
---

# A text layer's box lays out glyphs, it does not scale them

## Context

Text is the only visual kind with no intrinsic size. Every consequence of that
absence has hardened into a separate special case:

- `Transform.x`/`y` means the **unrotated top-left** for VideoClip,
  ImageOverlay and Motif, but the **anchor point itself** for Text, because
  measured glyph bounds move with the content and only an anchor-relative
  origin is stable.
- `Compositor.naturalSizeOf` reports a texture's dimensions for the media
  kinds and `getLocalBounds()` for Text — so the on-canvas gizmo's box is
  whatever the glyphs happen to occupy.
- The gizmo's resize handles therefore had nothing to write but
  `scale_x`/`scale_y`, and Pixi scales an already-rasterized glyph atlas.
  Enlarging a title enlarged its letters; the inspector's font size was
  advisory, because what reached the frame was `size_px × scale`.

Two further defects live in the same gap. `TextSprite` never set `wordWrap`,
so a line ran off the frame and the only wrapping mechanism was an explicit
`\n` — which hand-authored subtitle files carry and machine transcription does
not. And three separate factories minted default text params, drifted apart
(`Inter`/48/`Auto`, `Arial`/72/`DrawText`, `Arial`/96/700), and none of them
named a bundled family — so the cross-OS determinism guarantee that
`render/fonts/registry.ts` carries was never true on the default new-text path.

## Decision

### The box lays out; the font size is the standard

`TextParams` gains a box — `box_w`, `box_h` — in composition pixels, local
(before `scale`). The preview's eight resize handles write the box. The font
size in the inspector is what reaches the frame, at any box size.

`scale_x`/`scale_y` survive unchanged as whole-layer scaling, reachable from
the inspector and the keyframe lanes. This is After Effects' division: a text
layer's Scale scales the rendered result, and the box is a different property.
`scale_linked` keeps its existing job (whether the inspector shows Scale as
one lane or two) and stops gating handle visibility for Text, whose box axes
are independent by construction.

`x`/`y` stays the anchor point for Text — the asymmetry above is not resolved,
because its cause survives in Auto width, where the box *is* the measured
bounds and still moves with the content. What changes is the referent: with a
box, `x`/`y` anchors the **box**, and `naturalSizeOf` reports the box when one
is set. Auto width degenerates to the previous behavior exactly.

### Three modes, derived from nullability

Both box fields are `Option`, and the three resize modes are read off which
ones are set — there is no mode enum:

| `(box_w, box_h)` | Mode        | Wraps | Shrinks |
| ---------------- | ----------- | ----- | ------- |
| `(null, null)`   | Auto width  | no    | no      |
| `(set, null)`    | Auto height | yes   | no      |
| `(set, set)`     | Fixed       | yes   | **yes** |

This follows `scale_linked`'s discipline: state is represented by its
consequences, not by a redundant flag that can contradict them. `(null, set)`
is not a mode — dragging a top or bottom edge backfills `box_w` from the
measured width in the **same commit**, the way an anchor gesture writes the
anchor and its position compensation together. The combination is
nevertheless reachable through MCP, which has no measuring ability, so the
boundary refuses it structurally and `TextSprite` coalesces it to Auto width
defensively — refuse at the edge, never blank the screen mid-render.

Neither box field is animatable. They are plain scalars, not `Animated`: a
keyframed box would change the shrink factor every frame, invalidate
`TextSprite`'s `appliedSig`, and rebuild the glyph atlas per frame. Animating
a text box is what `scale` is for.

### Shrink-to-fit is derived, never stored

Fixed is the only mode that can fail to contain its text, and it responds by
shrinking the rendered glyphs — `TextSprite` binary-searches the largest
containing size through `CanvasTextMetrics.measureText` (canvas measurement,
no rasterization, no GPU) and folds the result into `appliedSig`. The state
layer keeps exactly one font size: the one the user set.

Storing the shrunk size was rejected because it would be a renderer-derived
number in authored state: an MCP `content` edit never reaches the renderer, so
the stored value would be a lie from the next word typed. Preview and export
share this code path, so deriving it costs nothing in agreement between them.

The shrink factor multiplies every other length authored *against the glyphs* —
`outline.width`, `shadow.offset_x/y`/`blur`, `line_height` and
`letter_spacing` — all derived, none written back. An absolute 4 px outline on
text compressed to 43% reads as a smeared border, and `subtitles/layout.rs`
already treats an outline as a fraction of the size (`size * 0.06`) at import;
an absolute 80 px leading around 8 px glyphs is the same defect wearing a
different name. Leading has a second reason: it is the one such length that can
otherwise make the search *unable to converge*, because an explicit
`line_height` exceeding `box_h` puts a floor under the measured height that no
font size can get below. Scaling it also makes that height linear in the
candidate size, which is the monotonicity the bisection assumes. `line_height`
`0` means "the font's own metrics", and `0 × factor` is exactly `0`, so the
default path is untouched.

The floor is absolute — 8 px — not proportional: a proportional floor would
crush 12 px text to 3 px while leaving 96 px text legible, so the same setting
would behave differently at different sizes. At the floor the text overflows
and is marked, rather than shrinking further. The same 8 px is the drag floor
for `box_w`, and Auto height narrower than one glyph overflows horizontally
instead of shrinking — shrink belongs to Fixed alone, with no exceptions to
remember.

### CJK breaking is half of the determinism contract

Pixi's wrap unit is a space-delimited token
(`CanvasTextMetrics.canBreakWords` returns the style's `breakWords`, false by
default), so an unspaced CJK sentence is one token and never wraps at all.
`breakWords: true` is not the answer either — it splits Latin words mid-word.
The static hook is overridden instead: a token is breakable if the style says
so **or** it contains CJK, which wraps Chinese per character and English per
word.

That override is realm-global, which places it in the same contract as the
bundled fonts: set it in one realm only and preview wraps where export does
not. It lives beside the font registry.

Unlike the fonts, though, it needs exactly one install site rather than one per
realm — the `Compositor` constructor, unconditionally. Every realm that
rasterizes text builds a Compositor, the export Worker included, so installing
there is realm-complete *by construction*, where a per-realm call list has to be
remembered for each new realm. The condition that matters is therefore not "did
we call it twice" but "is the call ungated": moving it inside the
preview-only branch is the whole defect, and is what the CJK e2e goes red for.
Kinsoku (no line-leading punctuation) is a separate, incremental decision with
its own corpus.

### One default, at the center of the frame

The three drifted factories collapse into `textParamsDefault(content, comp)`.
A new text layer lands at the composition's center (`x = comp.width / 2`,
`y = comp.height / 2` — the anchor point, centered by the default `0.5`
anchor) instead of the top-left corner, in Auto width, at
`"Liberation Sans, Noto Sans SC"` — the bundled pair, which makes the
determinism guarantee true on the default path and renders CJK without tofu.
Successive text layers do not cascade: they stack dead center, the way
Premiere and After Effects place theirs, because a cascade offset makes
"duplicate a title and keyframe it" unpredictable.

Imported and transcribed captions are born with `box_w = comp_w × 0.84`,
matching the 8% per-side safe-area margin `subtitles/layout.rs` already
applies, and `box_h = null`. Auto height wraps without shrinking, so a
transcript's unbroken line stays inside the frame at the size its style asked
for.

`backend_hint` and the `TextBackend` enum are deleted rather than carried
through this change: five write sites, no reader, and the data model already
labelled the field legacy.

## Considered options

- **Handles keep writing `scale`; the box becomes two inspector numbers.**
  Rejected: it leaves the original defect — enlarging a title enlarges its
  letters — entirely in place.
- **Delete `scale` for Text so the handles have one meaning.** Rejected: it
  breaks existing scale keyframes and forces a Text special case through
  `transformOf`, the keyframe descriptors and the MCP surface, to remove a
  property whose animation channel is legitimate.
- **An explicit `resize: AutoWidth | AutoHeight | Fixed` enum beside two
  plain numbers.** Rejected: the enum and the numbers can disagree (Fixed with
  `box_w = 0`), and nullability already encodes the three modes without a
  second source of truth.
- **Store the shrunk size as `effective_size_px`.** Rejected: see above — any
  edit that does not pass through the renderer staleness it immediately.
- **Let Fixed overflow visibly and mark it, as Figma does.** Not chosen: the
  product call is that a box the user sized is a promise the text will fit;
  the overflow mark survives only at the 8 px floor.
- **Unify Text's `x`/`y` onto the unrotated top-left now that it has a size.**
  Rejected: the asymmetry's cause survives in Auto width, and centered
  auto-width text would drift left as it is typed. The cost — `anchorPivot.ts`,
  `originFor`, both `anchorCompensation` formulas and the data-model table —
  buys a symmetry that is no longer there to gain.
- **`breakWords: true` globally for CJK.** Rejected: splits Latin words.
- **Make the box animatable for text-box animation.** Rejected: a per-frame
  glyph atlas rebuild; `scale` already animates.

## Consequences

- The gizmo grows a Text branch: eight handles regardless of `scale_linked`,
  writing box fields, with a double-click on a handle clearing that axis back
  to auto and an inspector segmented control as the explicit exit from Fixed.
  Auto width is a one-gesture-only state — any handle drag leaves it, as in
  Figma.
- Vertical centering becomes reachable two ways, and they are orthogonal:
  `anchor_y` places the box against `x`/`y`; the new `valign` places the text
  inside the box. The inspector must separate them (Transform section vs Text
  section) so they do not read as duplicates.
- `line_height` and `letter_spacing` join `TextParams` — a multi-line box
  makes leading the first thing asked for, and both are single scalars Pixi
  already supports.
- `GizmoProbe` gains `effectiveFontSizeOf`, because the shrink factor is
  derived in the renderer and the inspector has to display it ("auto-reduced
  to 31 px"). It reuses the existing renderer→UI handshake rather than
  starting a second registry.
- Safe-area guides (title/action) and canvas-centering actions land alongside:
  once a box has a width, "how wide should a caption be" needs a visual
  reference, and it cross-checks the 8% margin the caption importer applies.
- No migration and no schema bump: `Option` with a serde default deserializes
  absent as `None`, which is Auto width, which is the previous rendering. The
  repository carries no `.vproj` fixtures, so nothing on disk needs repair.
- On-canvas text entry is **not** part of this decision and is deliberately
  sequenced after it: an inline editor needs a definite geometry — wrap width,
  alignment, box — and this is what supplies it. IME candidate placement,
  caret drawing and per-keystroke undo coalescing are its own work.

## References

- [ADR 0026](0026-captions-as-text-layers.md) (captions are Text layers),
  [ADR 0048](0048-transition-overlap-by-placement-not-extension.md) (the
  no-silent-clamping red line this decision's MCP refusal follows).
- [`docs/architecture.md`](../architecture.md) — Rust is project-state
  stateless, which is why the shrink factor can only be derived in the
  renderer and never round-trips through the state layer.
- [`CONTEXT.md`](../../CONTEXT.md#text-box) — text box, resize mode and
  shrink-to-fit glossary entries.
- [`docs/data-model.md`](../data-model.md) — `TextParams` and the transform
  origin table.
- `native/src/state/layer.rs` (serde twin), `src/main/state/model.ts`,
  `src/main/state/mutations/add.ts` (the single default factory),
  `src/renderer/render/sprite/TextSprite.ts` (wrap, box layout, shrink),
  `src/renderer/render/fonts/` (the CJK break override, beside the bundled
  fonts), `src/renderer/preview/TransformGizmo.tsx` (the Text handle branch).
- Gates: the box/wrap/shrink unit suites, and a CJK export-vs-preview pixel
  comparison covering the two-realm break override.
