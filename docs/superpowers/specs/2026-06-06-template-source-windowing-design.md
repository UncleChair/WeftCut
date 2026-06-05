# Template Source-Windowing Design

## Problem

Templates placed on the timeline couple their rendered animation length to the
layer's timeline width. The countdown template renders `remaining =
ceil(durationSec - tSec)` where `durationSec` is the **layer duration**
(`t_end_us - t_start_us`). Consequences:

- Editing the `seconds` prop does not change what renders (the animation length
  is the layer width, not the prop). The user must manually drag an edge to
  change the visible countdown.
- There is no notion of "the template's intrinsic content" separate from "how
  much of it the timeline shows".

## Goal

Adopt the same **source + window** model that video clips already use:

1. **Changing the `seconds` prop changes only the rendered content** (the
   countdown's max value / animation length). It does not move or resize the
   timeline layer, except when the content shrinks below the current window
   (see "Shrink" below).
2. **Dragging the layer on the timeline changes only the display window** into
   that content — never the content's intrinsic length.

This mirrors `VideoClipParams.src_in_us` / `src_out_us` windowing into source
media, with the template's intrinsic content duration playing the role of
"source media duration".

## Core Model

- **`seconds` prop = the content's intrinsic full duration** (e.g. a 6-second
  countdown counts 6→1). This is the "source duration" analogue. It is already
  surfaced by the manifest's `max_duration_prop` and resolved by
  `resolve_template_max_dur_us(manifest, props)` → µs. No new field is needed
  for the content duration.

- **`TemplateParams.src_in_us` (new, the only new persisted field)** = the
  window's start offset into the content. The window **width equals the layer
  width** (`t_end_us - t_start_us`); `src_out` is **derived**
  (`src_in_us + (t_end_us - t_start_us)`), never stored, so it cannot desync
  from the layer width. (Templates have no `speed`, so width maps 1:1 to content
  time.)

- **Invariant:** `0 ≤ src_in_us` and `src_in_us + (t_end_us - t_start_us) ≤
  content_dur_us`, where `content_dur_us = resolve_template_max_dur_us(...)`.

- Content frame 0 (the "6") sits at content time 0; the window
  `[src_in_us, src_in_us + width]` selects what the layer shows.

## Components

### 1. Data model
- **Rust** `state/layer.rs` `TemplateParams`: add `pub src_in_us: TimeUs`
  (default `0`).
- **TS** `ipc/index.ts` `TemplateView`: add `src_in_us: number`.
- **ipc mapping** (wherever `TemplateView` is built from `TemplateParams`): pass
  `src_in_us` through.
- **`TemplatePatch`** (Rust `state/actor.rs` + TS `ipc/index.ts`): add
  `src_in_us: Option<TimeUs>` / `src_in_us?: number` for completeness
  (panel/MCP edits). Applied in `apply_params_patch`.

### 2. Rendering — decouple content time from layer width
- **`Compositor.updateTemplate`** (`render/Compositor.ts`):
  - `contentTimeUs = layer.params.src_in_us + (tUs - layer.t_start_us)`
  - `contentDurationUs = resolve cap` for the layer's template+props; if the
    template is **unbounded** (no `max_duration_prop` and no `max_duration_s`),
    fall back to legacy `contentDurationUs = t_end_us - t_start_us` and treat
    `src_in_us` as 0.
  - Pass `contentTimeUs` and `contentDurationUs` to `TemplateSprite.update`.
- **`TemplateSprite.update`** (`render/sprite/TemplateSprite.ts`): signature
  takes content time + content duration instead of layer-local time + layer
  duration. `tSec = contentTimeUs / 1e6`, `durationSec = contentDurationUs /
  1e6`. The frame passed to the cache is the **absolute content frame index**
  (`round(contentTimeUs * fps)`), clamped to `contentDurationFrames - 1`.
- **Cache key** (`templateFrameCacheKey`): replace the layer-duration-derived
  `durationFrames` with **`contentDurationFrames`** (from `seconds`). Because
  the frame number is now an absolute content frame, two windows into the same
  template+props reuse overlapping cached frames, and distinct windows no longer
  collide on `(key, frame)`.

### 3. Trim — mirror VideoClip (replace the template cap branch)
In `apply_trim_layer` (`state/actor.rs`):
- **IN edge:** `t_start_us += Δ; src_in_us += Δ` (scrub into content).
- **OUT edge:** `t_end_us += Δ` (`src_out` derives from the new width).
In `trim_delta_bounds`, the template branch bounds Δ by the
`[0, content_dur_us]` window instead of the old cap-only logic:
- IN edge: `Δ ≥ -src_in_us` (can't scrub before content 0) and
  `Δ ≤ width - 1` (can't cross the out edge).
- OUT edge: `Δ ≤ content_dur_us - (src_in_us + width)` (can't window past
  content end) and `Δ ≥ -(width - 1)` (can't cross the in edge).
Frame-snapping of the cap-clamped edge is retained.

### 4. Changing `seconds` (replace the current auto-extend fix in
`apply_update_layer_params`)
On a Template params patch, after merging props, recompute
`content_dur_us = resolve_template_max_dur_us(new props)`:
- **Grow** (content ≥ current window end): do nothing to geometry — layer width,
  `src_in_us`, `t_start_us` all unchanged. Only the render updates.
- **Shrink below window** (`src_in_us + width > content_dur_us`): clamp the
  window into the new content. First clamp `src_in_us` to
  `min(src_in_us, max(0, content_dur_us - 1))`; then clamp the width by setting
  `t_end_us = t_start_us + (content_dur_us - src_in_us)` (frame-snapped). The
  layer shrinks — accepted behavior (the longer content no longer exists).
- Call `apply_duration_autofit` afterward.

### 5. Creation & fallbacks
- **`add_template`** (`commands.rs`) + MCP `add_template`: initialize
  `src_in_us = 0`. Existing default-duration / cap-clamp on `t_end_us` stays.
- **Unbounded templates**: keep legacy behavior (`durationSec = layer width`,
  `src_in_us` forced 0, both edges trim freely as today). Only capped templates
  get true windowing.
- **`split_layer`**: each half must carry the correct `src_in_us` (the right
  half's `src_in_us` = left `src_in_us + left width`). Verify the existing
  windowing split path covers templates; add a template arm if not.

## Out of Scope
- Template `speed` / time-remapping (templates remain 1:1 content↔timeline).
- Looping / freeze-on-last-frame when window exceeds content — impossible by the
  trim bound (`src_out ≤ content_dur`), so not needed.
- Migration of existing projects: legacy template layers deserialize with
  `src_in_us = 0` (serde default), which is correct (window starts at content 0).

## Testing / Verification
- Rust: `trim_delta_bounds` window bounds (IN/OUT) for a capped template; the
  shrink-clamp in `apply_update_layer_params`.
- Real-WebView2 (the established verification path):
  - Add countdown (seconds=5) → 5s layer shows 5→1.
  - Properties: seconds 5→6 → layer width unchanged, render shows 6→2, "6" at
    layer start.
  - Drag OUT edge wider to 6s → reveals the "1" (6→1).
  - Drag IN edge right 1s → starts at "5" (scrubbed into content).
  - seconds 6→3 with a 6s-wide full window → layer shrinks to 3s, shows 3→1.
  - A non-`seconds` prop (color) edit → no geometry change.
