# Template Animated Preview Design

## Problem

The template picker's preview is static. Both the left-column card thumbnails and
the right-column large preview render a single frame at `t=0`
(`TemplatePicker.tsx` `PREVIEW_T_SEC = 0`, with a `FOLLOW-UP: scrub slider`
comment). A user picking a template can't see what it animates into — a
countdown looks like a frozen "5".

## Goal

The **right-column large preview of the selected template** plays its animation
on a **real-time loop while the pointer is hovering the preview** — hovering
plays from the start; the static first frame shows otherwise. Card thumbnails
stay static. Leaving the preview (or switching selection / closing the picker)
resets/stops the loop.

- **Scope:** only the large preview animates, and only on hover. Cards remain
  static single-frame thumbnails (unchanged).
- **Trigger:** pointer hover over the large preview. Enter → play from `t=0`;
  leave → revert to the static first frame.
- **Loop:** while hovered, `t` runs `[0, duration)` then wraps to 0, repeating.
- **Timing:** real-time — the loop maps wall-clock 1:1 to template time (a 5 s
  countdown takes 5 s per loop), sampled at a preview frame rate (~20 fps).
- **Reset:** hover-leave (or selection change / picker close) returns to the
  static first frame and stops the loop.

## Approach

**Live re-render loop** (chosen over pre-baking a frame sequence). Only one
preview animates at a time and `TemplateHarness.renderFrameSvg` is ~single-digit
ms, so driving it live at ~20 fps is cheap, needs no pre-bake/extra memory, and
is truthful (same harness the timeline/export use). Pre-baking would smooth the
loop but adds upfront latency, memory, and code for a single preview — YAGNI.

## Components

Single touch point: **`apps/desktop/src/templates/TemplatePicker.tsx`**, the
`TemplatePreview` component (currently renders one static frame via
`harness.renderFrameSvg(PREVIEW_T_SEC, durSec, props)` → SVG string → Blob →
object URL → `<img>` scaled to fit).

### New `animate` prop on `TemplatePreview`
- `animate=false` (default; card thumbnails): unchanged — render one frame at
  `t=0`.
- `animate=true` (the large/selected preview): run an animation loop instead of
  the single render.

### The loop (when `animate=true`)
- Drive with `requestAnimationFrame`. The determinism stubs (`performance.now`,
  `rAF` no-ops) live INSIDE the harness iframe only — the picker's React code on
  the main thread uses `performance.now()` / `rAF` normally.
- Throttle to `PREVIEW_FPS` (~20): only issue a new render when
  `now - lastRenderAt >= 1000 / PREVIEW_FPS`.
- Compute the loop time with the pure helper
  `previewLoopTimeSec(elapsedMs, durationMs) = (elapsedMs % durationMs) / 1000`
  (`elapsedMs = now - startMs`). `durationMs` = the template's content duration
  (default-duration / cap, mirroring how the static preview already derives
  `durSec`).
- **Sequential guard:** never issue a new `renderFrameSvg` while the previous one
  is still in flight (a boolean `rendering` flag, or await-then-schedule). A
  dropped tick just renders the next eligible `t`.
- **Object-URL hygiene:** when a new frame's SVG Blob URL is bound to the
  `<img>`, revoke the PREVIOUS frame's URL (after the new one loads, to avoid a
  blank flash). On stop/unmount, revoke the last URL.
- The loop reads the CURRENT `props` each frame, so prop edits reflect live
  (compatible with the existing debounced prop state).

### Lifecycle
- **Hover gates the loop.** A `hovered` state (set by `onMouseEnter`/
  `onMouseLeave` on the large preview host) is in the render effect's deps. Enter
  → the effect runs the loop with a fresh `startMs` (plays from `t=0`). Leave →
  the effect re-runs into the static branch (renders `t=0`, resetting). The host
  has CSS `pointer-events: none` (so card clicks pass through to the card
  button); the animated large preview re-enables `pointer-events: auto` so it
  receives hover. Cards never set `hovered`.
- Restart from `t=0` when the selected template (`template.id`) changes (the
  effect re-runs; `startMs` resets) or on each debounced prop edit.
- Stop (cancel `rAF`, revoke URL) on unmount / picker close / hover-leave / when
  `animate` flips false.
- **Reduced motion:** if `window.matchMedia("(prefers-reduced-motion: reduce)")`
  matches, skip the loop and render the static `t=0` frame (accessibility).

### Call sites
- The right-column form preview (today `large={true}`) also passes
  `animate={true}` (gated by reduced-motion internally).
- Card thumbnails pass no `animate` (defaults to false → static, unchanged).

## Out of Scope
- Animating card thumbnails on hover (cards stay static).
- A manual scrub slider / scrubbable timeline in the picker.
- Pre-baking / caching the preview frame sequence.
- Compressed "quick sweep" timing (real-time only).
- Any change to the timeline/export render paths or the harness API.

## Testing / Verification
- **Unit (vitest):** `previewLoopTimeSec(elapsedMs, durationMs)` — wraps at the
  duration boundary, 0 at multiples, monotonic within a cycle, handles
  `elapsedMs < durationMs`.
- **Real-WebView2:** open the picker; the selected (countdown) large preview
  loops 5→1 with the arc sweeping, on repeat; switching templates restarts from
  the first frame; editing `seconds` changes the loop length live; cards stay
  static; no object-URL leak over a sustained loop (heap stable in the PerfHUD /
  no growth across many cycles).
