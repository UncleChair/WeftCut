# Color Picker (Eyedropper)

One global pick session serves every color surface. `pickColor()`
(`src/renderer/colorpick/pickColor.ts`) freezes two buffers at session start —
the composited preview via `extract.pixels` (working-space-true, composition
resolution) and a `capturePage()` window snapshot — then every hover sample is
a CPU read. The native `EyeDropper` API handles whole-screen picks (`S` during
a session); it returns only a color (no coordinates, no hover), which is why it
cannot carry the in-app session.

## Why the sample source is frozen

Chromakey hover live-applies the key color while you move. Sampling the LIVE
composite would read the keyed result (the background), not the source pixel —
a feedback loop. The session therefore freezes a PRE-key frame
(`excludeEffectId` disables that filter for the freeze) and sampling never
touches the live pipeline.

## Integration seams

- `previewSamplerRegistry` — PixiPreview registers capture/mapping on mount;
  the picker never imports Pixi.
- `effectOverrides` — transient per-effect param overrides + disable flags,
  consulted by `EffectChain.sync()` after track resolution. Never recorded,
  never in React state. PixiPreview re-composites on every change so hover
  edits render while paused.
- `AppColorField` — eyedropper button by default (`withEyeDropper={false}` to
  opt out); commits through the caller's `onValueChange`.
- Effect descriptors declare `colorGroups` (RGB scalar triplets); the inspector
  renders an eyedropper per group and commits all three tracks as one undo
  entry via `updateLayerParamTracks`.

## Limits

- Screen picks have no hover preview or custom magnifier (platform API limit);
  `screenPick.ts` is the seam to replace with a full-screen custom overlay.
- The composition buffer is an 8-bit extract — HDR/10-bit picks read the
  tone-mapped value.
- The window snapshot is frozen at session start; UI changes mid-session are
  not reflected.
