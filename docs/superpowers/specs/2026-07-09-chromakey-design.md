# Chromakey v1 — Color-Difference Keyer

**Date:** 2026-07-09
**Status:** Approved design, pre-implementation

## Goal

Add a `chromakey` effect to the effects catalog: a single-pass Pixi v8 filter
implementing color-difference (Vlahos/Keylight-family) keying with screen
subtraction, despill, and matte post-processing.

**Quality target:** on evenly lit, lightly compressed green/blue-screen footage,
core matte quality (hair, motion blur, semi-transparency) in the same class as
Keylight / Premiere Ultra Key — categorically above similarity-threshold keyers
(ffmpeg `chromakey`, OBS-style CbCr distance).

**Accepted limitation (explicit non-goal):** tolerance for badly lit or heavily
compressed footage will be one to two grades below mature commercial keyers.
The long-tail cleanup controls that close that gap (despill bias, clip
rollback, despot, large-radius softness) are deferred — see Deferred section.

## Background / constraints

- Effects architecture: Rust owns effect instances (`kind` string + scalar
  `Animated<f64>` params); the TS renderer owns the catalog
  (`render/effects/effectRegistry.ts`). Adding an effect = one registry entry;
  UI param rows, keyframes, undo, and MCP `add_effect` are data-driven and need
  no changes.
- `EffectChain` calls `create()` once per structural change and
  `params[key].apply(filter, value)` every frame — the filter exposes uniform
  setters and animation comes for free.
- Preview and 8-bit export render on WebGPU; 10-bit export forces WebGL — the
  filter needs both WGSL and GLSL sources.
- 10-bit export routes filter intermediates through the f16 `TexturePool`
  technique; the filter must be verified by the `effects-f16-parity` gate.
- Working colorspace is display-gamma BT.709 (registry `colorspace:
  "display-gamma"`). Linear-light keying is out of scope until colorspace
  bracketing exists.

## Design

### Files

- `apps/desktop/src/renderer/render/effects/filters/ChromaKeyFilter.ts` — new;
  the first custom (non-stock) filter in the repo. WGSL and GLSL fragment
  sources live side by side in this file to prevent drift.
- `apps/desktop/src/renderer/render/effects/effectRegistry.ts` — one new
  `chromakey` entry.
- Locale files (en-US, zh-CN) — `effects.chromakey.*` name/label keys following
  the existing `effects.blur.*` pattern.

### Algorithm (single pass)

Let `key = (keyR, keyG, keyB)`, dominant channel `d = argmax(key)`, and `a, b`
the other two channels. All math on gamma-encoded values in [0,1].

1. **Color-difference matte** with Keylight-style screen balance:

   ```
   weighted(c) = mix(max(c[a], c[b]), min(c[a], c[b]), balance)
   mPx   = px[d]  - weighted(px)
   mKey  = key[d] - weighted(key)
   alphaRaw = 1 - mPx / max(mKey, eps)
   ```

   `balance` 0 → classic conservative Vlahos (`max`), 1 → aggressive (`min`),
   0.5 (default) → average. Normalizing by `mKey` makes the pure-green default
   key work against darker/desaturated real screens.

2. **Levels:** `alpha = clamp((alphaRaw - clipBlack) / max(clipWhite - clipBlack, eps), 0, 1)`.

3. **Shrink then feather**, single pass, alpha recomputed at sample taps (no
   matte texture, no extra render target, no `TexturePool` interaction).
   Radii are in source texels (via the filter's input-size uniform):
   - choke: 5-tap cross at radius `|shrink|` px; erode (min over taps) for
     negative shrink, dilate (max) for positive.
   - feather: 5-tap cross average at radius `feather` px, evaluated over the
     choked alpha (nested — worst case 25 alpha evaluations, pure ALU +
     bilinear samples, trivial GPU cost).
   - Fast paths: a zero radius collapses its ring to the center tap; both zero
     → single evaluation.

4. **Screen subtraction:** `fgPremult = max(px.rgb - key * (1 - alpha) * srcA, 0)`.
   The subtraction result is exactly the premultiplied foreground, matching
   Pixi's premultiplied-alpha filter convention. `srcA` is the source pixel's
   own alpha, so the filter composes correctly with sprite antialiasing and
   layer opacity; final output alpha is `alpha * srcA`.

5. **Despill + fixed luma restore:**

   ```
   limit  = mix(fg[a], fg[b], 0.5)
   spill  = max(fg[d] - limit, 0) * despill
   fg[d] -= spill
   fg.rgb += spill * lumaWeight[d] * 0.5   // neutral restore, Rec.709 weights
   ```

`viewMatte = 1` outputs `(alpha, alpha, alpha, 1)` after all matte processing,
for tuning.

### Parameters (all existing scalar `Animated<f64>` machinery)

| param | default | range | step | notes |
|---|---|---|---|---|
| keyR / keyG / keyB | 0 / 1 / 0 | [0,1] | 0.01 | key color |
| balance | 0.5 | [0,1] | 0.01 | screen balance (Keylight semantics) |
| clipBlack | 0 | [0,1] | 0.01 | matte black level |
| clipWhite | 1 | [0,1] | 0.01 | matte white level |
| despill | 1 | [0,1] | 0.01 | spill suppression strength |
| feather | 0 | [0,10] | 0.5 | matte softness, px |
| shrink | 0 | [-5,5] | 0.5 | matte choke, px (negative = erode) |
| viewMatte | 0 | [0,1] | 1 | show matte (0/1 toggle rendered as number row) |

Ten parameters; key color as three scalars is a deliberate v1 decision (zero
schema work, keyframeable today). An eyedropper/color-param UX upgrade rides
the deferred `ParamValue` work and migrates these params without breaking
projects.

### Registry entry

`kind: "chromakey"`, `nameI18nKey: "effects.chromakey.name"`,
`colorspace: "display-gamma"`. `fidelity` starts `"precision-reduced"` and
flips to `"f16-verified"` in the same branch once the parity gate passes —
merging with the gate unrun is not acceptance-complete.

## Testing / acceptance

1. **Unit** (`effectRegistry.test.ts` pattern): descriptor shape, param specs,
   apply-glue writes each uniform.
2. **e2e** (`effects-smoke.spec.ts` pattern): synthetic green background +
   foreground square → add `chromakey` via MCP → non-transparent pixel count
   collapses to ≈ foreground area; `viewMatte = 1` renders grayscale; 8-bit
   export path renders the keyed result; undo restores. Rebuild
   (`VITE_WEFTCUT_E2E=1 npm run build`) before running — stale-build e2e
   failures mimic real bugs.
3. **f16 parity gate** (`effects-f16-parity`): run with chromakey in the chain;
   flip fidelity flag on pass.
4. 10-bit filtered-export end-to-end remains a known repo-wide deferred gate;
   chromakey relies on the proven f16 pool technique like every other filter.

## Deferred (v2+ candidates, in priority order)

1. **Despill bias color** — preserves skin tones under heavy spill (3 scalars).
2. **Clip rollback** — recover edge detail lost to levels clipping.
3. **Despot + large-radius softness** — needs a matte-texture multi-pass;
   shared infrastructure with IBK.
4. **IBK-style clean-plate mode** — per-pixel local screen color for unevenly
   lit screens.
5. **Linear-light keying** — rides colorspace bracketing.

**Out of scope entirely:**
- ML background removal (RVM et al.) — a separate feature and project; note
  RVM is GPL-3.0 and @imgly/background-removal is AGPL/commercial, both
  incompatible with open-source licensing plans. Requires a license-clean
  model and an offline-analysis + cached-alpha architecture.
- Garbage/holdout masks — belongs to a general masking feature, not the keyer.
- Porting shader code from OBS/Natron (GPL) — algorithm math is from public
  literature; no code may be copied.
