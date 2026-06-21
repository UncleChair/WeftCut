# Wire per-layer effects onto Motif sprites

**Date:** 2026-06-21
**Scope:** Small feature. Render a Motif layer's effect chain (preview + 8-bit
export), reusing the `StageableSprite` / `Compositor.stageVisual` seam landed
in the staging-unification refactor.

## Problem

Per-layer effects (ADR 0027) render on clip / image / color / text sprites but
not on Motif sprites. This is not a compositing limitation: a `MotifSprite`
wraps a plain Pixi `Sprite`, and the staging-unification refactor already
routes every visual kind's "apply filters + addChild" tail through
`Compositor.stageVisual(sprite, effects, layer, tInLayerUs, effectOpts)`. The
Motif branch passes `effects = undefined`, so its (already storable) effect
chain is ignored at render time.

The data model already supports it: `Layer.effects: Vec<Effect>` lives on every
layer regardless of kind, the actor's `apply_add_effect` only locates the layer
by id and pushes (no kind validation, per ADR 0027), and the `add_effect` MCP
tool accepts any `layer_id`. So an effect added to a Motif layer is stored and
survives undo today — it simply never reaches the GPU.

## Goal

Give `ActiveMotif` an `EffectChain` and pass it through the existing
`stageVisual` seam so a Motif layer's effects render in preview and 8-bit
export, with no new Rust, IPC, undo, or content-production work.

Non-goals (hard boundary):
- **filtered-10-bit-export gate** — proving filters preserve 10-bit precision
  through a full export is a pre-existing cross-cutting gap (open for *all*
  layer kinds; the parity gate proves the f16 pool technique in isolation, not
  an end-to-end filtered export). Not Motif-specific; stays a separate roadmap
  item.
- effects UI (effects remain MCP-only for every kind).
- growing the filter catalog (Blur stays the only filter).
- any change to the Motif content-production path (CDP capture, the raster
  cache, the export bake / `injectedFrames`) or to `MotifSprite.dispose`.

## Design

### 1. Wiring (`apps/desktop/src/renderer/render/Compositor.ts` only)

Mirror the four effect-bearing kinds. Four edits:

1. **`ActiveMotif` interface** — add the field:
   ```ts
   interface ActiveMotif {
     layerId: string;
     motifId: string;
     sprite: MotifSprite;
     effects: EffectChain;
   }
   ```
2. **`ensureMotif`** — construct the chain alongside the sprite:
   ```ts
   const tmpl: ActiveMotif = { layerId: layer.id, motifId, sprite, effects: new EffectChain() };
   ```
3. **Composite-loop Motif branch** — pass the chain instead of `undefined`:
   ```ts
   this.stageVisual(tmpl.sprite, tmpl.effects, layer, tInLayerUs, effectOpts);
   ```
4. **Three teardown sites** — dispose the chain (mirrors clip/image/color/text;
   a leaked chain leaks Pixi `Filter` GPU resources):
   - `ensureMotif` retarget-swap (where a layer is rebound to a different
     motif and the stale sprite is disposed): add `existing.effects.dispose();`
   - the per-layer removal pass (removes an active record when its layer
     leaves the project): add `t.effects.dispose();`
   - the full `Compositor` dispose loop over `activeMotifs`: change
     `t.sprite.dispose();` to `t.sprite.dispose(); t.effects.dispose();`

Because the composite loop is shared by the preview renderer and the export
Worker, both filter Motif sprites after this change. The export Worker binds
each pre-baked `injectedFrames` bitmap to the same Pixi `Sprite`, and
`stageVisual` applies the filter on top of it exactly as for any other sprite —
no export-path code change. Preview-LOD (`preview_effects_enabled`) is already
honored by `stageVisual` via `effectOpts`.

No Rust / IPC / undo / catalog changes: `add_effect` already stores effects on
a Motif layer; the renderer is the only consumer that ignored them.

### 2. Test (e2e — preview + 8-bit export)

Add a second `test()` to `apps/desktop/e2e/electron/effects-smoke.spec.ts`,
reusing the file's existing helpers (`connectMcp`, `sampleAt`, `effectsOf`,
and the `driver` helpers `launchApp` / `newProject` / `invokeCmd` /
`driveExport`). Mirror the existing clip/text blur test with a Motif layer:

- New project → `add_track` → `add_motif` with a built-in motif
  (`{ motifId: 'countdown', tStartUs: 0 }`, duration covering the sample time).
- Warm up: poll `sampleAt` until the Motif has composited (CDP capture is
  async, so the first sample can read empty — same warmup the text case uses).
  Record the sharp baseline.
- `add_effect` via the real MCP (`{ layer_id, kind: 'blur' }`); poll until the
  `project:changed` → `setProject` event applies the chain; sample the blurred
  frame. Assert `nonTransparent` differs from the baseline and is `> 0` (blur
  spreads alpha).
- `driveExport` an 8-bit export with the blur on; assert it completes and the
  output is non-empty (same ffmpeg-extract / no-error check the existing case
  uses).
- `undo` via MCP; assert the layer's `effects` length returns to 0.

This proves a filter renders on a CDP-baked Motif sprite end-to-end in preview
and 8-bit export, and that it is undoable.

### 3. Verification

- `tsc -b` exits 0 (the `effects` field + `stageVisual(... tmpl.effects ...)`
  type-check; `StageableSprite` already constrains the sprite).
- The existing unit suite stays green (zero behavior change for the four other
  kinds; this is purely additive for Motif).
- The new Motif-effects e2e is green. It is a built-app / local gate
  (`VITE_WEFTCUT_E2E=1` build + display); per project convention GUI/e2e is a
  user checkpoint run before merge.
