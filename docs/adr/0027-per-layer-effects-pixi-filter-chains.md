---
status: accepted
---

# Per-layer effects are Pixi filter chains: Rust owns instances, the renderer owns the catalog

## Context

The IR-driven per-layer effects subsystem was deleted in the PixiJS
migration. Reintroducing it has to satisfy three pulls at once:

- **Consume the community ecosystem.** pixi.js + pixi-filters are a large,
  maintained body of GPU filters. We want to use them, not reimplement them.
- **Stay coherent with the 10-bit path.** The export composites into
  `rgba16float` (ADR 0022); a filter must not silently quantize the signal.
- **Ride existing infrastructure.** Keyframes (`Animated<T>` + the shared
  `weftcut-eval` leaf crate, ADR 0025), undo, the actor/MCP surface, and the
  dual-engine discipline already exist; effects should reuse them, not fork
  them.

## Decision

A per-layer effect is a **Pixi filter** attached to the layer's sprite. The
ownership split is the load-bearing decision:

- **Rust owns effect _instances_.** `Layer.effects: Vec<Effect>` (ordered =
  filter-chain order); each `Effect { id, kind, enabled, params:
  BTreeMap<String, Animated<f64>> }`. The actor exposes `add_effect` /
  `update_effect` / `move_effect` / `remove_effect` (recorded/undoable) and
  the same four as MCP tools. Rust does **not** know what a `kind` means and
  does not validate it.
- **The renderer owns the _catalog_.** `render/effects/effectRegistry.ts`
  maps a `kind` string → an `EffectDescriptor` (a stock Pixi `Filter`
  factory + per-param apply glue + a fidelity tier). `EffectChain` caches
  filter instances per layer and pushes the per-frame-resolved params in;
  the Compositor sets `sprite.filters` from it. Unknown `kind` → skipped +
  warned.

The two halves join on the `kind` string. **Adding a community filter is one
catalog entry — zero Rust / IPC / undo change.**

Supporting decisions:

- **v1 params are scalar `Animated<f64>` only** — effects reuse the existing
  keyframe machinery (no new engine twin); a keyframe addresses an effect
  param via the path `effects[<id>].params[<key>]`. The broader `ParamValue`
  sum type (color / bool / enum) and `Animated<Rgba>` are deferred.
- **Working space stays display-referred gamma BT.709** (ADR 0021); filters
  operate in gamma space. A descriptor reserves a `colorspace` field for a
  future linear/HDR bracket.
- **10-bit precision** is preserved by bumping the export realm's global
  Pixi `TexturePool` to `rgba16float` once at init so stock filters run
  unmodified at full precision (ADR 0022; never `clear(true)` a live
  `FilterSystem`). A fidelity tier (`f16-verified` vs `precision-reduced`),
  classified by a GL-parity gate, labels filters whose own shader bands.
- **A preview-LOD toggle** (`preview_effects_enabled` AppSetting, default on)
  lets preview skip filters while scrubbing; export is always full quality.
- **`'unsafe-eval'` is granted in the packaged renderer CSP** (and the
  `pixi.js/unsafe-eval` no-eval polyfill dropped). The polyfill renders every
  *filtered* object EMPTY on the **WebGPU** backend — and both the preview
  and the 8-bit export prefer WebGPU — so the effects subsystem is dead under
  the polyfill. PixiJS's real `new Function()` shader codegen needs
  `'unsafe-eval'`; filters then render on WebGPU and WebGL alike. The grant
  widens the eval surface but not the content surface (the renderer still
  loads no remote or inline script), so the practical XSS vector stays
  closed. See [`security.md`](../security.md).

## Consequences

- The effects subsystem ships v1 with a single filter (Blur), wired on
  every visual sprite kind (clip / image / color / text / Motif), drivable
  from MCP and undoable, and rendering correctly in preview (WebGPU) and
  export. (All five kinds join the per-frame `Compositor.stageVisual` seam —
  a Motif's filter sits on its Pixi `Sprite`, compositing on top of the
  CDP-baked frame just like any other texture.)
- The catalog grows filter-by-filter with no engine churn; each new filter is
  gated by the parity gate before it is advertised as `f16-verified`.
- Granting `'unsafe-eval'` is an accepted, documented security trade made to
  keep the WebGPU backend.
- **Deferred:** more filters; `ParamValue` / animated color; an effects UI
  (v1 is MCP-only); a full filtered-10-bit-export e2e; a linear/HDR working
  space. `Speed` is time remapping, not a filter, and is out of
  `layer.effects`. Tracked in [`roadmap.md`](../roadmap.md).

## References

- ADR 0021 — color converges at ingest; working space = output space.
- ADR 0022 — 10-bit float16 composite (the rgba16float pool technique reused).
- ADR 0025 — shared `weftcut-eval` wasm leaf crate (the keyframe engine reused).
- [`render.md`](../render.md), [`data-model.md`](../data-model.md),
  [`mcp.md`](../mcp.md), [`security.md`](../security.md).
