# Add Color & Text Layers — UI Entry Point + Placement

## Goal

Restore a first-class way for users to **add a color (solid) layer** and a **text/title
layer** to a composition from the UI. Today the full stack for both kinds already
exists — data model, IPC, PixiJS renderer, and the Property Panel editor — but the
creation entry points were removed during the A/B-roll redesign (commit `9c1402ef`),
so neither kind can be added at all from the running app.

## Scope

- **In:** Color layer + Text layer creation entry points, with a smart track-placement
  rule and immediate-edit selection.
- **Out:** Subtitle/Caption manual add (has its own approved design), shape layers
  (no backend/renderer), manual track creation (intentionally forbidden by the
  A/B-roll redesign).

## Current State (verified)

- `LayerParams` already includes `Color(ColorParams)` and `Text(TextParams)`
  (`state/layer.rs`). Both render (`Compositor.ts` → `ColorSprite` / `TextSprite`)
  and are fully editable in `properties/PropertyPanel.tsx` (`ColorFields`,
  `TextFields`).
- Creation today: only `add_demo_color_layer` / `add_demo_text_layer` (Tauri,
  test-only, no UI) and `add_text_layer(track_id, content, t_start_us, duration_us)`
  (Tauri, has a TS wrapper but is not wired to any UI control).
- The dead i18n keys `add_color_layer` / `add_text_layer` (en-US + zh-CN) survive
  from the removed menu items.
- **Precedent for placing a non-media layer:** `add_motif` with no `track_id`
  spawns a fresh `"Overlay"` track every insert so it never trips the per-track
  no-overlap invariant. The old demo color/text layers instead dumped onto the
  first/last existing track (arbitrary).

## Design

### 1. UI entry point

Add two items to the **Insert** menu in `App.tsx`, next to "Motifs":

- **「颜色层」 / "Color layer"**
- **「文本」 / "Text"**

Reuse the existing `add_color_layer` / `add_text_layer` i18n entries, dropping the
demo duration suffix (`"+ Color layer (2s)"` → `"颜色层"` / `"Color layer"`).

On click: insert at the **current playhead** position, then **auto-select the new
layer** so the right-hand Property Panel opens immediately for editing — mirroring
the Motif "New Motif" flow (which selects the freshly-placed layer).

### 2. Placement rule — smart Overlay-track reuse

New shared Rust helper (in `commands.rs`, used by both new commands):

```
async fn resolve_overlay_track(handle, t_start_us, t_end_us) -> Result<TrackId>
```

1. Snapshot the project.
2. **Candidate tracks** = tracks with `role == None` (i.e. NOT the reserved
   A-roll / B-roll / audio-a / audio-b rows), scanned **top of z-stack → bottom**
   (`tracks.iter().rev()`).
3. A candidate is **free** for `[t_start_us, t_end_us)` when *no* layer on it
   overlaps, using the existing half-open semantic
   (`!(t_start_us < l.t_end_us && l.t_start_us < t_end_us)` for every layer `l`).
   Return the first free candidate.
4. If no candidate is free, create a new `"Overlay"` track via
   `handle.add_track(Actor::User, Some("Overlay".into()))` (appended on top, same as
   `add_motif`) and return it.

Effect: consecutive **non-overlapping** color/text inserts stack onto the same
Overlay track; only a **time overlap** spawns a new track. On a fresh project
(all four reserved rows have `role == Some`), the first insert creates the Overlay
track — identical to current motif behavior.

### 3. Backend commands

Two Tauri commands, both returning the new `layer_id` (string):

```rust
add_color_layer(
    track_id: Option<String>,     // None → resolve_overlay_track
    color: Option<Rgba>,          // None → BLACK (0,0,0,255)
    width: Option<u32>,           // None → composition.width
    height: Option<u32>,          // None → composition.height
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,  // None → DEFAULT_DURATION_US
) -> Result<String, String>

add_text_layer(                   // RELAX the existing command's params to optional
    track_id: Option<String>,     // was required → None → resolve_overlay_track
    content: Option<String>,      // was required → None → "Text"
    t_start_us: TimeUs,
    duration_us: Option<TimeUs>,  // was required → None → DEFAULT_DURATION_US
) -> Result<String, String>
```

- `DEFAULT_DURATION_US = 5_000_000` (5 s). `add_layer` re-snaps both edges to the
  frame grid on entry, so no manual snapping here.
- **Text defaults** (when only `t_start_us` is given): `content = "Text"`, font
  Arial / 72 px / weight 400, color white, center align, `DrawText` backend —
  matching the existing `add_text_layer` body.
- **Color defaults:** `color = BLACK`, `width/height = composition` dims (full-frame
  matte).
- `add_demo_color_layer` / `add_demo_text_layer` are **left untouched** (e2e use).
- Register `add_color_layer` in the Tauri `invoke_handler`; `add_text_layer` is
  already registered.
- Relaxing required → optional does not break existing `add_text_layer` callers
  (they still pass `Some(..)`); the implementation step audits/migrates any caller
  that relied on the old required signature.

### 4. Frontend wiring

- TS wrappers in `ipc/index.ts`, options-object shaped:
  - `addColorLayer(opts: { tStartUs; durationUs?; trackId?; color?; width?; height? }) → Promise<string>`
  - `addTextLayer(opts: { tStartUs; durationUs?; trackId?; content? }) → Promise<string>`
    (migrate the current positional `addTextLayer` signature and its callers).
- `App.tsx` Insert handlers: read the current playhead → call the wrapper → on the
  returned `layerId`, set it as the selected layer via the same selection mechanism
  the Motif insert uses. The existing `project:changed` bridge refreshes the UI.

### 5. Z-order behavior (accepted)

A color layer defaults to a full-frame solid on a top Overlay track, so it visually
**covers the video** until the user lowers its opacity, shrinks `width/height`, or
moves it down — standard NLE color-matte behavior (e.g. Premiere places a color
matte on the track above). Accepted for v1; the user edits via the Property Panel
immediately after the auto-select.

## Testing

- **Rust unit tests** for `resolve_overlay_track`:
  - reuses a free non-reserved track at the requested range;
  - spawns a new Overlay track when the only candidate's range is occupied
    (overlap), and reuses again once a non-overlapping range is requested;
  - never returns a reserved (role = Some) track;
  - adjacent (edge-touching) ranges are treated as free (half-open semantic).
- **e2e** (existing WebView2 harness): Insert → Color / Text →
  - new layer appears at the playhead and is selected;
  - Property Panel shows the kind's fields and an edit commits;
  - export output includes the new layer.

## Risks / Migration

- `add_text_layer` signature change: low risk (required → optional). Mitigation:
  grep all callers (TS wrapper + tests + MCP, if any) during implementation and
  migrate.
- Two `add_color_layer` symbols will coexist: the **MCP tool** (`mcp/mod.rs`,
  track-required, agent-facing) and the new **Tauri command** (UI-facing). Different
  namespaces; no collision. Behavior is intentionally similar but not shared in v1.
