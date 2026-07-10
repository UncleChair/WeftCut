# Global Color Picker (Eyedropper) — Design

Status: approved design, pre-implementation.

## Goal

A single eyedropper capability, usable anywhere a color is edited:

1. **`AppColorField` upgrade** — every color swatch in the app (PropertyPanel,
   CaptionsPanel, MotifPicker, text styling, …) gains an eyedropper button for
   free.
2. **Chromakey key color** — the eyedropper UX upgrade deferred by the
   chromakey v1 spec, without the `ParamValue` schema work it was originally
   tied to.

Explicit non-goals at the end of this document.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Consumers | AppColorField upgrade + chromakey key color (no standalone tool) |
| Pixel semantics on the preview canvas | **Hybrid**: inside the canvas = read the composited working-space buffer; outside / on screen = OS pixels |
| Hover feedback | **Live-apply**: hovering transiently applies the key color to the filter; click commits, Esc reverts |
| Chromakey schema | Write the existing three scalars (`keyR/keyG/keyB`), one batched undo entry; no schema change |
| Architecture | Frozen dual-buffer in-app session + native `EyeDropper` as the screen fallback (Approach B) |

### Why the native `EyeDropper` API cannot carry the whole feature

`EyeDropper.open()` returns **only** `{ sRGBHex }` — no coordinates and no
hover events. Working-space-true sampling over the preview canvas needs the
pick *position* (to read the composition buffer), and live-apply needs *hover*
callbacks. Both are structurally impossible with the native API, so it is
demoted to the screen-pick fallback where it is a perfect fit.

### The feedback loop, and why the sample source is frozen

Live-apply + sampling the live composite = a feedback loop: hovering a green
pixel applies the key, the filter keys the green out, the next sample at that
spot reads the background instead of green. The fix shapes the whole
architecture: **the sample source and the live preview are decoupled**. At
session start we freeze one "pre-key" composition buffer and sample only from
it; live-apply re-renders the live pipeline without ever polluting the sample
source. Second dividend: every hover sample is a CPU array read — the whole
session costs one GPU readback and one IPC round-trip total.

## Public API

New module `apps/desktop/src/renderer/colorpick/`:

```ts
interface PickOptions {
  /// Chromakey: disable this effect's filter while freezing the composition
  /// frame, so samples are the pixels the shader actually compares against.
  excludeEffectId?: string;
  /// rAF-throttled hover callback; in-app sessions only (screen mode has none).
  onHover?: (hex: string) => void;
}

interface PickResult {
  hex: string;                             // "#rrggbb", 8-bit sRGB
  source: "composition" | "ui" | "screen"; // consumers may ignore
}

/// Global singleton session; a new call preempts the old one (old resolves null).
function pickColor(opts?: PickOptions): Promise<PickResult | null>; // null = cancelled
```

Internal files: `pickColor.ts` (session state machine), `PickOverlayHost.tsx`
(portal overlay mounted at app root, sibling of dialogs), `Magnifier.tsx`,
`samplers.ts` (the two frozen-buffer samplers), `screenPick.ts` (native
`EyeDropper` wrapper + feature detect).

## Integration points (one narrow seam each)

1. **`AppColorField`** — optional eyedropper button, default ON (all existing
   consumers gain it for free). Click → `pickColor()` → commit through the
   existing `onValueChange`. The component stays a stateless controlled input.
2. **`PixiPreview`** — registers sampling capability with a new
   `previewSamplerRegistry` on mount, unregisters on unmount (same pattern as
   the e2e `installPreviewBridge`):
   - `captureFrame(opts)` — one full-frame `extract.pixels` (the path already
     proven by `sampleComposite`/`capturePng`), honoring `excludeEffectId`;
   - `mapClientToComposition(x, y)` — letterbox/scale mapping owned by the
     preview side;
   - `canvasRect()` — CSS-px bounds for region hit-testing.
3. **`EffectChain`** — new module-level `effectOverrides` store:
   `setTransientOverrides(effectId, partial)` / `clearTransientOverrides(effectId)`
   plus a per-effect `disabled` flag. `EffectChain.sync()` consults overrides
   **after** `resolveAnimated`. This is the only correct hook point: `sync()`
   rewrites every filter uniform from resolved params each frame, so writing
   uniforms directly would be clobbered on the next composite. Overrides are
   transient — never in React state, never in undo.
4. **Main process** — one new IPC: `webContents.capturePage()` → window
   snapshot bytes + `deviceScaleFactor`, covering in-app non-canvas sampling.

**Chromakey entry point** — declarative, not special-cased: the effect
descriptor grows `colorGroups: [{ params: ["keyR", "keyG", "keyB"] }]`;
`EffectsSection` renders an eyedropper button for any declared group. Any
future effect with a color triplet gets the eyedropper automatically
(consistent with the kind-registry direction).

## Session data flow

**1. Enter** — eyedropper clicked → `transportPause()` (NLE convention) → the
two buffers freeze in parallel:

- *Composition buffer*: `previewSampler.captureFrame({ excludeEffectId })` —
  set the target filter `disabled` via `effectOverrides`, re-composite + render
  once, `extract.pixels` the full frame, restore. Result: the pre-key
  working-space RGBA.
- *Window snapshot*: IPC → `capturePage()` → ImageBitmap + dpr.

When both settle, the overlay shows (crosshair cursor; hint bar:
`Esc cancel · S screen pick`).

**2. Hover** (pointermove, rAF-throttled) — region test: cursor inside
`canvasRect()` → `mapClientToComposition` → read the composition buffer;
otherwise → `clientX/Y × dpr` → read the window snapshot. The magnifier (zoom
patch + hex readout) updates via **imperative DOM only — no React state**
(playhead-gate discipline). Then `onHover(hex)`.

**3. Chromakey hover consumption** — hex → three 0–1 floats →
`setTransientOverrides(effectId, { keyR, keyG, keyB })`. The always-on ticker's
next `sync()` picks the override up → the matte updates live. Sampling stays on
the frozen pre-key buffer, so the live preview can never pollute it.

**4. Commit / cancel** —

- *Click*: `clearTransientOverrides` → resolve `{ hex, source }`. Chromakey
  side splits hex into three scalars and writes them via
  `updateLayerParamTracks` (**one batched undo entry**, the plural API already
  exists). Each param follows **exactly the same keyframe semantics as a
  manual number edit** (Static: replace value; Animated: set/update a keyframe
  at the current time) — reuse `KeyframeField`'s track-building logic to
  construct the three next-tracks, then write them through the plural API in
  one call. The eyedropper is just another input method; it invents no new
  commit semantics.
  AppColorField side: `onValueChange(hex)`.
- *Esc / window blur / preempted by a new session*: `clearTransientOverrides` →
  resolve `null`; the preview returns to its pre-session state.

**5. Screen mode** — press `S` during the session (keydown carries transient
activation, so `EyeDropper.open()` is legal) → tear down the overlay → the
native eyedropper takes over the whole screen → `{ sRGBHex }` → resolve
`{ hex, source: "screen" }`. The native dropper's own Esc throws `AbortError`
→ resolve `null`. No `onHover` in this mode — honest degradation, the platform
offers none.

## Error handling (a degradation ladder, not all-or-nothing)

| Failure | Behavior |
|---|---|
| `window.EyeDropper` absent | Feature-detect; hint bar omits `S screen pick`; in-app session unaffected |
| `capturePage` IPC fails | Degrade to canvas-only session: outside-canvas magnifier shows a disabled state, clicks there don't commit; LogBus warn |
| `captureFrame` fails (no preview mounted / extract throws) | Canvas region disabled; if **both** buffers fail → cancel the session + status-bar error |
| Native dropper `AbortError` | Normal cancel path, resolve `null`, no error surfaced |
| Effect deleted mid-session (e.g. undo removes the chromakey) | Validate `effectId` still exists before commit; if gone, treat as cancel |

## Edge cases

- **Coordinate systems** — overlay and `canvasRect()` speak CSS px throughout;
  the window snapshot multiplies by dpr; composition mapping (letterbox/scale)
  is owned by the preview sampler. Three coordinate spaces, each with exactly
  one owner; no cross-module conversion.
- **Multi-display** — the in-app session only covers the app window, so it is
  unaffected; screen mode delegates to the native dropper, so the problem
  doesn't exist.
- **Alpha** — samples take RGB and ignore alpha (pre-key green-screen pixels
  are opaque anyway; over transparent regions the magnifier shows whatever the
  buffer holds).
- **Memory** — a 4K composition buffer ≈ 33 MB Uint8Array; the reference is
  dropped the moment the session ends; nothing enters any cache.

## Testing

1. **Unit** — sampler coordinate mapping (letterbox, dpr) as pure functions;
   `effectOverrides` + `EffectChain.sync()` override/disabled logic (alongside
   the existing `effectRegistry.test.ts` patterns); hex ↔ scalar conversion.
2. **Component (jsdom)** — overlay pointermove/click/Esc/preemption flows with
   both samplers mocked; the module boundary makes this layer Pixi-free.
3. **e2e (Playwright `_electron`, effects-smoke pattern)** — green-screen
   fixture → click the chromakey eyedropper → click a green area on the canvas
   → assert all three key params updated **and one undo reverts all three**;
   assert zero project-state changes during hover (transient overrides never
   touch state). The native EyeDropper's OS UI cannot be driven by automation
   → feature-detect unit test + a manual verification checklist.

## Non-goals

- Standalone global picker tool; recent-colors / palette history (excluded
  during requirements).
- Hover live-preview and a custom magnifier for *screen* picks (= the
  full-screen custom overlay approach; `screenPick.ts` is the seam to swap it
  in wholesale later).
- HDR / 10-bit picking (the composition buffer is an 8-bit extract; under f16
  preview the sample is the tone-mapped 8-bit value — sufficient).
- A color-typed `ParamValue` schema migration (decided: write three scalars).
