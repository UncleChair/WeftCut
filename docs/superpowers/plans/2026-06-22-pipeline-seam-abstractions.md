# Pipeline-seam abstraction backlog

Status: **active** — re-baselined **2026-06-29**. The original 2026-06-22
seven-way seam audit was partly overtaken by two larger migrations that landed
after it: the **Rust→TS state-actor migration** (mutations now live in
TypeScript; Rust is a stateless compute service) and the **eval-leaf
pan/color unification** (`weftcut-eval` now single-sources pan, color, fade,
and µs↔frame). This file re-states only what is still true and still open; git
holds the original audit. Delete this file once the backlog is exhausted.

Items are ranked by **leverage = touch-count × drift-risk × frequency-of-change**;
refactoring *cost* is deliberately set aside (it's a separate scheduling question).

## The meta-pattern (unchanged — this is what survived)

> **The code parameterizes by hand-copying instead of by a parameter.** The thing
> that varies — the *visual kind*, the *buffer/eviction policy*, the *encode
> target*, the *job kind*, the *language* — is encoded by duplicating the
> surrounding scaffolding once per value, instead of writing the invariant
> scaffolding once and passing the variant in.

The encouraging corollary still holds: the right abstraction usually **already
exists** a few files away and just wasn't propagated. The migrations since
2026-06-22 *proved this twice* — they collapsed two of the original audit's
biggest items by applying patterns the codebase already had:

- `weftcut-eval` (ADR 0025) absorbed pan/color/fade/µs↔frame — closing the
  cross-language twin drift the old #6 was about.
- The TS actor's **table-exec adapter** shape (`commands.ts` + `mcp-commands.ts`
  → one `{ op, args }` dispatched by `actor.ts`, real logic single-sourced in
  `main/state/mutations/*`) is exactly the "one core, thin adapters" the old #1
  recommended — reached via the state migration rather than a Rust macro.

So this backlog is still "finish applying patterns you already validated", not
"invent new architecture".

---

## What the migrations already closed (do NOT re-plan)

### ✓ Command/mutation surface (was Tier 1 #1) — resolved via the TS migration

The old "one `move_layer` exists as 13 Rust forms" analysis is **dead** — the
Rust actor (`actor.rs`, `commands/mutations.rs`, `Command::MoveLayer`,
`do_move_layer`, `apply_move_layer`, `DryRunOp`) was deleted in the state
migration. Current shape:

- **One core mutation** per logical op — `applyMoveLayer` in
  `main/state/mutations/move.ts` (and siblings: `add.ts`, `trim.ts`,
  `delete.ts`, `duplicate.ts`, `split.ts`, `effects.ts`, `composition.ts`, …).
- **One actor dispatch** — `main/state/actor.ts` `case 'move_layer'` (~`:426`).
- **Two thin adapters** — `commands.ts` (`:174`, UI/production camelCase channels)
  and `mcp-commands.ts` (`:326`, MCP snake_case, `exec:'table'`). Both lower to
  the same `{ op, args }`.

**Residual (small, optional):** the two adapters still hand-parse args in two
casings (camelCase vs snake_case). Drift is now caught by the **byte-exact
differential gates** (`__tests__/prod.routing.test.ts`,
`__tests__/mcp.routing.test.ts`, `mcp.tool-table.test.ts`) rather than at
runtime by serde — a real improvement. A future codegen of the two arg shapes
from one schema would erase the residual, but it's no longer high-leverage; fold
it into Tier-3 #5 (cross-language codegen) if that's ever picked up.

### ✓ eval-leaf cross-language twins (was Tier 2 #6) — mostly closed

`weftcut-eval` (native + wasm32) now owns what the old #6 flagged as gaps:

| Twin | In leaf now? | Anchor |
|------|--------------|--------|
| `us_to_frame` (µs↔rate, half-up) | **Yes** | `eval/src/lib.rs:115`, wasm export `wasm.rs:62` |
| `pan_coeffs` (equal-power pan law) | **Yes** | `eval/src/lib.rs:473` + `pan_coeffs_branches` test + twin-PBT |
| `Animated<Rgba>` (OkLab + premult) | **Yes** | `Interpolate` trait `lib.rs:150`, `impl … for Rgba8` `:248` |
| `fade_multiplier` | **Yes** | `eval/src/lib.rs:497`, wasm export `fade_mul` |

**Residual:** (a) the **envelope sampler** is shared only at the per-point scalar
level — the loop+fade+lerp fill is still hand-synced on both sides; (b) the
`keyframe_edits` ↔ `edits.ts` upsert/remove/retime twin (already golden-covered).
Note pan is locked by a **twin-PBT**, not a golden fixture (there is no
`*pan*golden*.json`); the drift gap is closed regardless of mechanism.

---

## Tier 1 — structural wins (open)

### 1. Decode: one `DecodeSession` core + pluggable `FrameSink` · leverage: HIGH

`SourceDecoderPool.ts` (preview) and `ExportDecoderPool.ts` (export) still
duplicate the **entire decoder lifecycle** near line-for-line, sharing only the
minimal `DecoderHandle` interface (`SourceDecoderPool.ts:92-129`) — no base class.

Duplicated, with current anchors (Source ≈ Export):

| Concern | Source | Export |
|---|---|---|
| Output-callback identity guard (`this.decoder !== dec`) | `:333-337`, `:364-367` | `:495-498`, `:536-537` |
| `buildConfig()` (spread config + override HW accel) | `:488-496` | `:580-588` |
| `handleDecodeError` → rebuild/downgrade dispatch | `:429-447` | `:557-570` |
| Decoder rebuild / reset path | `:507-537` | `:595-615` |
| mediabunny open + `getDecoderConfig` + `withDefaultColorSpace` | `:199-212` (`SourceMedia.ensureReady`) | `:449-460` (`_doEnsureReady`) |

The open+config block recurs a **third time** in `probeSourceDecodable.ts:85-96`
(minus colorimetry), and the `getKeyPacket(0) → getFirstPacket()` fallback is a
fourth twin (`ExportDecoderPool` `decodeRange` `:683-692` ≈ probe `:94-96`).

The **only** genuine differences:

- **Ring/frame type** — `FrameRing` of `ImageBitmap` (preview) vs
  `ExportFrameStore` of `VideoFrame | TenBitFrame` (export).
- **Eviction** — anchor/lookahead-window advance (preview) vs `evictBefore(cutoff)`
  + `freeBehindWaiters()` (export).
- **Drive model** — pull (`requestFrameAt(tUs)` per tick) vs push
  (`decodeRange(a,b)` + `waitForPts`).
- **10-bit lane** — export-only `tenBitLane` flag → `DecodedFrame` union
  (`SourceDecoderPool.ts:70`) forcing `isTenBitFrame` narrowing at
  `ExportFrameStore.push:109` and the decoder output `:523`.

**Abstraction.** A shared `DecodeSession` (decoder + output-guard + `buildConfig`
+ error→rebuild + EOS flush + `openConfiguredSource()`) and a pluggable
`FrameSink<F>` owning the sorted entries + PTS interval search, parameterized by
an `EvictionPolicy` (`WindowEviction` vs `CursorEviction`). Model 10-bit as the
sink's pixel-format strategy, not a `tenBitLane` flag + type-union threaded
through every consumer. **This is the largest landmine-commented,
correctness-critical duplication in the renderer — do it first.**

### 2. Render: visual-kind registry + `BitmapBackedSprite` base · leverage: HIGH

Adding a 6th visual kind today is **~17 edit sites** across 5 files (verified):

- `ipc/index.ts` — view union + new `*View` (`:113-119`), patch union + `*Patch`
  (`:408-414`).
- `resolveView.ts` — new `resolve*View()` + `Resolved*View`.
- `Compositor.ts` — `Active*` struct (`:268-282`), its `Map`, the eviction loop
  (`:550-618`), the `compositeFrame` arm (`:792-817`), `ensure*`/`update*`.
- `sprite/*.ts` — a new wrapper implementing `StageableSprite`.
- `properties/PropertyPanel.tsx` — `isVisualKind` (`:114-122`), the `KindFields`
  switch (`:149-163`), a new `*Fields` component.

Miss the eviction loop → silent sprite + effect-chain leak; miss `isVisualKind` →
renders but can't carry effects. Separately, the three bitmap sprites
(`VideoClipSprite`, `MotifSprite`, `ImageOverlaySprite`) duplicate **~65 lines**
of GPU texture lifecycle at 85–95% identity — `Texture.EMPTY` gating
(`VideoClipSprite:118`, `ImageOverlaySprite:60`, `MotifSprite:108`),
`ImageSource`/`Texture` rebind, `destroy(true)` (catch-wrapped) in
`bindBitmap`/`rebindSource`/`dispose`. This is the bug-historied code.

`StageableSprite` (the 2026-06-21 refactor) added `displayObject` + `stageReady`
but **not** a base class or registry; transform/zIndex/alpha is still re-applied
per-kind across the five `update*` (`updateClip:1546-1607`, etc.).

**Abstraction.** A `VisualKindDescriptor<View,Resolved,Sprite>` registry
collapsing the five `Active*` structs/maps/eviction/dispose loops to one
`Map<layerId, ActiveLayer>` (6th kind → ~2 sites). A `BitmapBackedSprite` base
for the texture lifecycle. Push transform/zIndex/alpha into
`StageableSprite.applyTransform()`.

**Non-finding (unchanged):** the effect *catalog* (`effectRegistry.ts`) is a
clean SSOT; Rust stores opaque `kind:String` + param map and deliberately does
not duplicate it. Adding an effect is genuinely 1 site.

---

## Tier 2 — high leverage, narrower scope

### 3. Export: an `EncodeTarget` descriptor + codec registry · leverage: HIGH

Export does **not** fork the renderer — it reuses `Compositor.compositeFrame`
(`exportWorker.ts:407`) + the full `resolveView` keyframe path. The duplication
is downstream:

- **No encode-target value.** `App.tsx` hand-branches three routes —
  10-bit native sink (`:1276-1297`), WebCodecs-direct (`resolveEncodePath`
  `:1304-1311`), ffmpeg-mezzanine (`:1318`, `:1471`) — recomputing
  `computeBitrate` 3× (`App.tsx:1285`, `:1319`, `:1471`) and `gopFrames` 3×
  (`App.tsx:1287`, `:1479`, `exportWorker.ts:282`). No `EncodeTarget` /
  `resolveEncodeTarget` exists.
- **Codec knowledge across 4 sites.** TS `CodecId` (`exportSettings.ts:5`,
  3 variants) vs Rust `TargetCodec` (`hwencoder.rs:28-33`, 4 variants incl.
  `Vp9`); WebCodecs codec strings (`exportSettings.ts:178-187`) that
  `muxCodec.ts:9-17` re-parses by prefix at mux time (dead weight — the worker
  already holds the `CodecId`). Capability facts split arbitrarily: AV1∉MOV
  (`exportSettings.ts:281-286`), HEVC-needs-`hvc1` (`export/mod.rs:390-400`),
  10-bit color tags hardcoded (`videosink.rs:141-144`), 10-bit source caps
  (`exportSettings.ts:272-276`).

**Abstraction.** `resolveEncodeTarget(settings) → EncodeTarget` discriminated
union (bitrate/gop/dims/color computed once) + a TS codec registry table making
`codecString`/`containersForCodec`/`isBitDepthValid`/bpp all lookups.
Add-a-codec: one row + one arm. Reconcile `CodecId` and `TargetCodec` to one
source (or codegen the Rust enum from the TS table).

### 4. Jobs: an `ffmpeg→cache` skeleton · leverage: MEDIUM · **re-audit needed**

The old "five `spawn_*` in `jobs/mod.rs:192-693`" reference is **stale** — jobs
are now split per-kind (`jobs/{import,proxy,conform,frame,thumbnails,waveform,
quick_proxy,proxy_decision}.rs`) and the derivatives-patch commit moved onto the
stateless-compute seam. What likely persists: the
`is_installed → cached_ok → temp → spawn → verify → promote` skeleton each job
re-implements (e.g. `proxy.rs` imports `cached_ok`/`temp_path`/`promote_temp`/
`discard_temp` directly; no `run_ffmpeg_to_cache` helper exists). **Confirm the
current duplication shape across the split files before scheduling** — then a
`run_ffmpeg_to_cache(dest, args)` helper + a thin `Job` trait dedupes it.

---

## Tier 3 — real, but codegen-shaped or supporting

5. **Cross-language codegen.** The `Project` model + subtree is hand-mirrored
   Rust↔TS — TS now *owns* it (`main/state/model.ts`), and Rust compute
   deserializes a project slice per call, so the mirror is still load-bearing.
   Export wire structs (`VideoSinkStartArgs`, `TranscodeSpec`, `AudioEncodeSpec`)
   are hand-mirrored literals. Fix: generate one side from the other (the MCP
   catalog already emits JSON Schema). Subsumes the #1 arg-casing residual.

6. **`LayerParams` enum accessors (Rust).** The multi-arm `match LayerParams` is
   hand-written in ~8 fns in `native/src/state/layer.rs`; "which kinds carry
   transform+opacity" repeats. `transform_mut()`/`opacity_mut()`/
   `animated_f64_fields_mut()` accessors make a new kind or transform field one
   edit. Exhaustiveness is the only net today.

7. **Main-process command interceptors.** The growing `if (channel === …)` chain
   in `main/index.ts` wants a `Record<string, handler>` map — the growth point
   for every future OS/keyring/CDP command.

---

## Do NOT abstract (correct as-is; over-abstraction would regress)

- **Undo/history.** Snapshot-based (cheap via structural sharing). No mutation
  defines an inverse; a new field rides the snapshot free. Per-mutation
  inverse-ops would be strictly worse.
- **The effect catalog.** Already a true SSOT (`effectRegistry.ts`); Rust is
  deliberately kind-agnostic. A matching Rust effect enum would *create* drift.
- **The preload capability list.** Keep `window.api` curated/named (security
  rationale in `preload/index.ts`). Only the plumbing between the type and the
  two endpoints is worth a channel registry.

---

## Recommended sequencing

1. **#1 (DecodeSession + FrameSink)** — largest correctness-critical duplication;
   landmine-commented; do first.
2. **#2 (kind registry + `BitmapBackedSprite`)** — independent render-side win,
   parallelizable with #1.
3. **#3 (EncodeTarget + codec registry)** — high leverage, self-contained.
4. **#4 jobs** — re-audit the per-file duplication first, then the helper.
