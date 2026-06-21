# Design Spec — per-layer effects subsystem (Pixi filters on the 10-bit path)

> Working plan (ephemeral; delete on consolidation per the docs convention).
> Branch: `feat/effects-subsystem` (worktree `videtor-wt2`).
> Companion validation PoC lives on branch `poc/f16-filter-pool`.

## Goal

Reintroduce the per-layer effects subsystem that was deleted with the PixiJS
migration (see `docs/roadmap.md`), as **per-sprite Pixi filter chains driven by
a `layer.effects` field**, while satisfying one hard constraint: the **10-bit
export path composites into `rgba16float`**, but Pixi's filter ecosystem
allocates its intermediate render targets from a single, format-fixed global
texture pool that defaults to 8-bit. Running any stock filter on the 10-bit
path therefore quantizes the signal to 8 bits at the first filter, killing the
precision the path exists to preserve.

The design goal is to **consume the community filter ecosystem (pixi.js +
pixi-filters) unmodified** while keeping full precision on the 10-bit path —
no fork of Pixi, no per-filter rewrites.

## Validated finding (the load-bearing assumption)

The "pool-bump" approach is **proven** by the PoC on branch `poc/f16-filter-pool`
(minimal Electron + WebGL2 harness, pixi.js 8.18.1, Electron 42, ANGLE WebGL2,
`EXT_color_buffer_float` present):

| Probe | Default pool | f16 pool (set at init) |
|---|---|---|
| Source f16 gradient | 1024 distinct | 1024 distinct |
| **Filter intermediate texture format** | **`bgra8unorm`** | **`rgba16float`** |
| `ColorMatrixFilter` (identity) | **256** (8-bit banding) | **1024** (preserved) |
| `BlurFilter` (strength 2) | 158 | 1018 |

Mechanism: Pixi's `FilterSystem` imports the module-global `TexturePool`
singleton directly (`filters/FilterSystem.mjs`), and `getOptimalTexture`'s cache
key is `(width, height, mipmap, antialias)` — **format is not in the key**. The
default `TextureSource.format` is `rgba8unorm`. Setting
`TexturePool.textureOptions.format = "rgba16float"` once, at renderer init,
makes every filter intermediate `rgba16float`, and stock filters preserve full
precision **unmodified**. The export Worker is a separate Web Worker (separate
JS realm → separate Pixi singletons), so this is realm-local and never touches
the preview realm.

### Landmine (must be respected in the implementation)

**Never call `TexturePool.clear(true)` on a live `FilterSystem`.** `clear(true)`
destroys pooled textures that the persistent `_globalFilterBindGroup` still
references (resource slots 1/2 = `input.source` / `.style`); the destroy listener
nulls the bind group's `resources`, and the next filter crashes in
`BindGroup.setResource` (`Cannot read properties of null`). The real pipeline
avoids this for free: set the pool format **once at init, before any
filtering**, when the pool is empty. Encode this as a hard rule — a future
"clear the pool when switching bit depth" optimization would reintroduce the
crash.

## A. Central architecture split: Rust owns instances, TS owns the catalog

The pivot of the whole design:

- **Rust (`@weftcut/core`) owns effect _instances_** — the ordered list per
  layer, each param's value and keyframes, enabled/bypass, undo/redo. Rust does
  **not** know what "blur strength" means; an effect is a typed, animatable
  parameter bag.
- **The TS renderer owns the effect _catalog_** — which filters exist, their
  param schemas, and how to instantiate a Pixi `Filter`. The Pixi/pixi-filters
  classes live in TS by nature.

The two sides join on a `kind` string. **This is where "consume the ecosystem"
lives:** adding a community filter is a new TS catalog entry (factory + param
glue + fidelity tier) — zero changes to the Rust engine, IPC, or undo stack.
Rust stays a dumb typed store + animator.

## B. Data model (Rust + IPC)

New `Effect` in `native/src/state/`, on `Layer` (applies to the composited
sprite):

```rust
struct Effect {
    id: EffectId,
    kind: String,                                   // catalog join key, e.g. "blur"
    enabled: bool,
    params: BTreeMap<String, Animated<ParamValue>>, // reuse existing Animated<T>
}
// Layer { ..., effects: Vec<Effect> }              // Vec order = filter-chain order
```

- Param values reuse the existing `Animated<T>` → every param is keyframeable
  for free, and **no new cross-language twin** is introduced (`value_at` already
  lives in the `weftcut-eval` leaf crate, shared native + wasm).
- The concrete `ParamValue` representation (the Rust sum type spanning scalar /
  color / bool / enum, and its IPC encoding) is **deferred to the implementation
  plan**; the design only requires that it is a typed, animatable bag.
- **v1 param types:** `Animated<f64>` scalars + static `bool`/`enum`. Color
  params land static now; **animated color params gate on `Animated<Rgba>`**
  (an existing roadmap item).
- **IPC:** the `resolveView` per-frame evaluation path already exists (keyframe
  IPC is merged). Effect params ride it: each frame, Rust evaluates `value_at`
  for each param and ships the resolved values in the view. Filter **structure**
  (kind list + order; changes only on mutation) and per-frame **param values**
  travel separately.
- **Rust is permissive about `kind`:** it does not validate it (the catalog is
  in TS). An unknown `kind` is a renderer-side skip + a status-log warning, not
  a hard error. `kind` validity is checked at the TS/MCP boundary. This matches
  the existing `validate.rs` note that effect routing is an add-time/planner
  concern, not a commit-time invariant.

## C. Capability registry (the ecosystem adapter, TS renderer)

`effectRegistry.ts`: `kind → EffectDescriptor`:

```ts
interface EffectDescriptor {
  kind: string;
  nameI18nKey: string;
  create(): Filter;                       // stock pixi.js / pixi-filters, unmodified
  params: Record<string, {
    type: "scalar" | "color" | "bool" | "enum";
    default: unknown;
    range?: [number, number];
    apply(filter: Filter, resolved: unknown): void;  // the only per-filter glue
  }>;
  fidelity: "f16-verified" | "precision-reduced";     // see E/F
  colorspace: "display-gamma";            // HDR seam reserved (see I)
}
```

The **preview (`Compositor.ts`) and the export Worker share the same
descriptors** — the same `kind` builds the same filter; the only difference
between the two realms is the pool format.

## D. Apply path (shared by Compositor and export Worker)

An `EffectChain` applier that caches filter instances per layer (mirrors how
`TenBitIngest` caches a texture per clip):

- Rebuild `sprite.filters = [...]` only on a **structural** change (kind list /
  order / enabled set).
- Each frame, push only the resolved param values from the view into the cached
  filter instances via `descriptor.params[k].apply(filter, value)` (uniform
  update, no rebuild).

## E. 10-bit reconciliation (validated) + a simplification

- In the export Worker realm, at renderer init and before any filtering, when
  the export bit depth is 10: set `TexturePool.textureOptions.format =
  "rgba16float"`. Never `clear(true)` a live `FilterSystem` (see Landmine).
- The preview realm stays default 8-bit — filters there run at 8-bit, which is
  all the preview can display anyway (preview is SDR/8-bit per ADR 0022), so
  WYSIWYG is not harmed.

**Simplification surfaced by the PoC:** the pool is realm-global and
single-format (format is not in the cache key, so 8-bit and 16-bit intermediates
cannot coexist in one `FilterSystem`). In the f16 pool, the filter's input
texture values are still in `[0, 1]` — identical numeric range to 8-bit
normalized. So a "Tier-B" filter (one whose GLSL bakes 8-bit assumptions, e.g.
`/255` quantization) at worst **bands due to its own shader**; it cannot produce
wrong colors. Therefore **the tier is purely a verification/labeling concern,
not a render-path fork**: all filters run through the same f16 pool; Tier-A is
lossless, Tier-B bands internally and is honestly flagged "precision-reduced" in
the UI. **There is no second 8-bit render path** (this drops the "Approach C as
the Tier-B fallback" idea from brainstorming).

## F. GL-parity gate extension

Extend the existing 10-bit GL-parity gate (the `TenBitIngest` VERT/FRAG copy in
`apps/desktop/e2e`): for each filter that declares `fidelity: "f16-verified"`,
push a known high-precision gradient through it under the f16 pool and assert the
distinct-value count stays above a threshold (precision preserved) — the PoC,
productized. A filter that fails is auto-demoted to `precision-reduced`. This
gate both backs the "supported" allowlist and guards the Pixi-internal invariant
the pool-bump relies on: a Pixi upgrade that changes filter pooling fails the
gate.

## G. preview-LOD flag (required from day one)

Filters break batching (one render-target switch per filtered sprite). A preview
preference (via the unrecorded `replace_settings_everywhere` path, per the
ProjectSettings convention) lets preview **render filters at reduced resolution
or skip them entirely while scrubbing**; export is always full quality.

## H. Actor + MCP + keyframes

- Actor commands (recorded / undoable; replace the "No set-effects command"
  comment in `actor.rs`): `add_effect{layer, kind, index?}`,
  `update_effect{layer, id, param-patches | enabled}`,
  `move_effect{layer, id, to_index}`, `remove_effect{layer, id}`.
- Effect-param keyframes **reuse the existing keyframe authoring path** (actor
  patches the Static-wrap → AnimTrack) and the 8 existing MCP keyframe tools,
  addressed at effect-param paths.
- 4 MCP tools mirror the actor commands.

## I. Colorspace contract + HDR seam

- Working space = gamma-encoded BT.709 = output space. Filters operate in gamma
  space — stated as the contract, consistent with the rest of the pipeline
  (`working = output`, ADR 0021/0022) and with the entire SDR web/Pixi world.
- Seam for the future: when HDR / wide-gamut / linear-light lands, a filter that
  needs linear declares `colorspace: "linear"` in its descriptor and the
  compositor brackets it with linearize / delinearize passes. v1: every filter is
  `"display-gamma"`, no bracketing. The field is reserved now.

## J. Scope

- **v1:** data model; registry seeded with a **single** f16-verified Tier-A
  filter (Blur); f16-pool reconciliation; GL-parity gate; actor + MCP commands;
  scalar-param keyframes; preview-LOD skip toggle. (One filter proves the whole
  vertical slice end-to-end; the catalog grows filter-by-filter afterward,
  gated by F.)
- **Deferred:** animated color params (need `Animated<Rgba>`); a large
  pixi-filters catalog; linear/HDR colorspace bracketing; a rich
  property-panel UI (start minimal).
- **Explicitly out of scope:** `Speed` is time-remapping, not a filter
  (`docs/roadmap.md`); it does not belong in `layer.effects` and needs its own
  design.

## Open questions / risks

- **Community filters beyond Blur/ColorMatrix are unverified.** Only the two
  most common building blocks were probed (both Tier-A). The GL-parity gate (F)
  classifies the rest as they are added; the tier label (E) keeps unverified
  ones safe (band, not break).
- **Memory:** f16 pool textures are 2× the bytes of 8-bit; a 4K filtered sprite
  doubles pool memory. Must be reconciled with the 4K ring-cap work
  (ADR 0022 follow-up).
- **Filters that allocate their own explicit-format render targets** (rare)
  bypass the pool. A registry edge case; flag such a filter as
  `precision-reduced` if found.

## References

- `docs/roadmap.md` — "Effect subsystem on the PixiJS path" (the planned shape).
- `docs/render.md` — effects currently out of scope.
- ADR 0022 — 10-bit float16 composite + native encode exit (the `rgba16float`
  composite this filters into; the deferred HDR/linear work this leaves a seam
  for).
- ADR 0021 — color converges at ingest; working space = output space.
- ADR 0004 — WebCodecs buffer-pool discipline.
- Branch `poc/f16-filter-pool` — the validation PoC (harness + result).
