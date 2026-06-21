# Pipeline-seam abstraction backlog

Status: **active** — Step 1 in progress (2026-06-22).

Produced by a seven-way parallel audit of the codebase seams (renderer↔main IPC,
MCP, decode, render/sprite/effects, export/mux, audio + cross-language twins,
Rust jobs/mutations). Refactoring cost was deliberately set aside — items are
ranked purely by leverage = touch-count × drift-risk × frequency-of-change.

## The meta-pattern

Almost every high-leverage item is one root cause seen from a different seam:

> **The code parameterizes by hand-copying instead of by a parameter.** The thing
> that varies — the *actor* (User/Agent/Job), the *job kind*, the *visual kind*,
> the *buffer policy*, the *language* — is encoded by duplicating the surrounding
> scaffolding once per value, instead of writing the invariant scaffolding once
> and passing the variant in.

The encouraging corollary: the right abstraction usually **already exists** a few
files away and simply wasn't propagated — `tool_table!` (table-driven dispatch),
`weftcut-eval` (single-sourced cross-language math), `stageVisual` (kind-agnostic
staging), the export path already reusing the preview `Compositor`, snapshot-based
undo. This backlog is "finish applying the patterns you already validated", not
"invent new architecture".

---

## Tier 1 — structural wins

### 1. The command/mutation surface is written 3–4 times  ·  leverage: HIGH

Spans three seams (renderer↔main IPC, MCP, Rust actor). One logical mutation like
`move_layer` exists today as **13** forms:

| # | Site | Role |
|---|------|------|
| 1 | `renderer/ipc/index.ts:934` `moveLayer()` | TS wrapper → `invoke("move_layer", {…})` |
| 2 | `commands/mod.rs:774` `MoveLayerArgs` | UI args struct (**camelCase**, `Deserialize`) |
| 3 | `commands/mutations.rs:487` `move_layer()` | UI wrapper: parse UUID, `Actor::User`, `→ String` |
| 4 | `napi_backend.rs:441` dispatch arm | deserialize + `ser(...)` |
| 5 | `mcp/tools.rs:606` `MoveLayerArgs` | **2nd** args struct (**snake_case**, `+JsonSchema`) |
| 6 | `mcp/tools.rs:617` `move_layer()` | MCP wrapper: parse UUID, `agent_actor()`, `→ McpToolError` |
| 7 | `mcp/catalog.rs` `tool_table!` row | MCP catalog entry |
| 8 | `actor.rs:537` `Command::MoveLayer{…}` | actor message variant |
| 9 | `actor.rs:1252` `ProjectHandle::move_layer()` | oneshot send + await |
| 10 | `actor.rs:1967` `handle` match arm | unpack → `do_move_layer` → `reply.send` |
| 11 | `actor.rs:2780` `do_move_layer()` | `clone → apply_move_layer → commit` |
| 12 | `state/actor/mutations.rs` `apply_move_layer()` | **← the only real logic** |
| 13 | `actor.rs:789` + `:2303` `DryRunOp::MoveLayer` | parallel dry-run dispatch table |

Only #12 is business logic; the other 12 are mechanical plumbing. #2 and #5 are
two structs for the same params with different casing — the reason UI and MCP have
each grown commands the other lacks. **Touch-count to add a mutation: 8–9 Rust
sites + TS wrapper + TS type + docs.** Drift caught only at runtime by serde.

**Abstraction.** One declarative command descriptor per logical mutation
(typed args + `apply(&mut Project, Actor) -> Result<Out, CommandError>` +
metadata). The existing `tool_table!` macro (`mcp/catalog.rs:10`) already proves
the table-driven shape in-crate; extend it (or a sibling `command_table!`) to emit
the `Command` variant, the `ProjectHandle` method, the `handle` arm, the `do_*`
body, the napi arm, the MCP arm, **and** the dry-run arm (dry-run becomes a mode
flag → `OperationSpec`/`spec_to_op` at `tools.rs:1459-1656`, ~150 lines, deletes;
every mutation gets dry-run for free). `Actor` becomes a parameter, not a
hardcoded literal stamped ~30× each side. **Add-a-mutation drops to ~2 sites.**

Sequenced as three sub-steps (see **Step 1 plan** below): (1a) Actor-parameterize +
merge the wrapper bodies + unify on `CommandError`; (1b) codegen TS types/wrappers
from the Rust structs; (1c) the `command_table!` macro.

### 2. Decode pipeline: two pools, one genuine difference  ·  leverage: HIGH

`SourceDecoderPool` (preview) and `ExportDecoderPool` (export) duplicate the entire
decoder lifecycle line-for-line — build, identity-guarded output trampoline
(`this.decoder !== dec`), `buildConfig`, `handleDecodeError`→rebuild/downgrade, EOS
flush, mediabunny open+config+colorspace (`SourceDecoderPool.ts:324-537` ≈
`ExportDecoderPool.ts:448-615`). The open+config block recurs a 3rd time in
`probeSourceDecodable.ts:84-98`; the `getKeyPacket→getFirstPacket` fallback is an
acknowledged twin. The **only** real difference is buffer/eviction policy
(ImageBitmap sliding-window ring vs VideoFrame evict-after-cursor + `waitForPts`)
and drive model (pull/lookahead pump vs push/`decodeRange`). Two independent
hand-rolled binary searches over the same PTS-interval store, already diverging on
clamp behavior.

**Abstraction.** A shared `DecodeSession` core (decoder + output-guard +
`buildConfig` + error→rebuild + EOS flush) + a pluggable `FrameSink<F>` strategy
owning the sorted entries + interval search, parameterized by an `EvictionPolicy`
(`WindowEviction` vs `CursorEviction`). Centralize open/config/colorspace into one
`openConfiguredSource()`. Model 10-bit as the sink's pixel-format strategy rather
than a `tenBitLane` flag + `DecodedFrame` type-union threaded through shared
interfaces (which forces `isTenBitFrame` narrowing at every consumer:
`VideoClipSprite.ts:126`, `Compositor.ts:1558`). This is the largest duplicated
*landmine-commented, correctness-critical* code in the renderer.

### 3. Render: kind registry + bitmap-sprite base class  ·  leverage: HIGH

Adding a 6th visual kind is ~12 sites: `*View`/`Resolved*View`/`resolve*View`
(`resolveView.ts` ×3), a `*Sprite`, an `Active*` struct + `Map` + eviction + dispose
(`Compositor.ts` ×4), `ensure*`/`update*`/`compositeFrame` arm (×3), `isVisualKind`
+ PropertyPanel switch (×2), the IPC union. Miss the eviction loop → silent sprite +
effect-chain leak; miss `isVisualKind` → renders but can't carry effects. Separately,
the 3 bitmap sprites (`VideoClipSprite`, `MotifSprite`, `ImageOverlaySprite`)
duplicate ~120 lines of GPU texture lifecycle (`Texture.EMPTY` gating,
`ImageSource`/`Texture` rebind, `destroy(true)`) — exactly the bug-historied code.

**Abstraction.** A `VisualKindDescriptor<View,Resolved,Sprite>` registry collapsing
the five `Active*` structs/maps/eviction/dispose loops to one `Map<layerId,
ActiveLayer>` (6th kind → ~2 sites). A `BitmapBackedSprite` base for the texture
lifecycle. Push transform/zIndex/alpha into `StageableSprite.applyTransform()`
(currently rewritten per-kind across five `update*`).

**Non-finding:** the effect *catalog* (`effectRegistry.ts`) is already a clean
single source of truth; the Rust side stores opaque `kind:String` + param map and
deliberately does **not** duplicate it. Adding an effect is genuinely 1 site. Its
only ceiling is scalar-only params (ties to #6 / keyframe vectorization).

---

## Tier 2 — high leverage, narrower scope

### 4. Job orchestration: a `Job` trait + one driver  ·  leverage: HIGH

The five `spawn_*` in `jobs/mod.rs:192-693` are the same 60–70-line template with
the kind swapped (`spawn → emit(STARTED) → ffmpeg_sem().acquire() → run() → build
MediaDerivativesPatch → set_media_derivatives → emit(COMPLETE/ERROR)`). The
`Err => warn + emit JobError` and patch-commit blocks are textually identical 5–7×;
the derivatives-patch commit recurs 7× (incl. both `spawn_proxy_decision` arms).

**Abstraction.** A `Job` trait (`const KIND`, `async run(cache, media) -> Result<
PathBuf>`, `derivatives_patch(output)`) + one generic `run_job<J>()` owning the
lifecycle. A `run_ffmpeg_to_cache(dest, args)` inner helper dedupes the
`is_installed → cached_ok → temp → spawn → verify → promote` skeleton each `run()`
also shares.

### 5. Export: an `EncodeTarget` descriptor + codec registry  ·  leverage: HIGH

Export does **not** fork the renderer — it reuses `Compositor.compositeFrame` and
the full `resolveView` keyframe path (`exportWorker.ts:409`); only the capture tail
forks (a small `FrameCapturer` interface). The real duplication is downstream:
- No encode-target value. `App.tsx:1267-1499` hand-branches three encode routes
  (WebCodecs-direct / ffmpeg-mezzanine / native-10-bit-sink), recomputing
  `computeBitrate`/`gopFrames` 2–3× each.
- Codec knowledge across 5 TS+Rust sites: `CodecId` (TS) and `TargetCodec` (Rust)
  are two enums, plus a 3rd implicit enumeration as WebCodecs prefix strings that
  `muxCodec.ts` re-parses by hand (dead weight — the worker already holds the
  `CodecId`). Capability facts split arbitrarily (AV1∉MOV in `exportSettings.ts:281`,
  HEVC-needs-hvc1 in `mod.rs:385`, color tags hardcoded twice in `videosink.rs`).

**Abstraction.** `resolveEncodeTarget(settings) → EncodeTarget` discriminated union
(bitrate/gop/dims/color computed once) + a TS codec registry table making
`codecString`/`containersForCodec`/`isBitDepthValid`/bpp all lookups. Add-a-codec:
one row + one arm.

> Note: `docs/export-ipc-transport.md` **exists** (repo-root `docs/`). An earlier
> audit pass wrongly flagged it missing because it globbed under `apps/desktop/`.

### 6. Finish the eval-leaf migration + close the missing goldens  ·  leverage: HIGH

`weftcut-eval` (ADR 0025) killed every *scalar* twin, each with a golden. Remaining:

| Twin | In leaf? | Golden? | Note |
|------|----------|---------|------|
| `pan_frame` ↔ `StereoPannerNode` | No | **No** | Rust port of the very Chromium code it must match — **sharpest drift risk** |
| `us_to_frame` (µs↔48k) | No | **No** | leaf-ready integer; `div_euclid` vs `Math.round` **diverge on negative input**, reachable from `planChunks` |
| envelope sampler | scalars only | Yes | loop+fade+lerp still hand-synced both sides |
| `keyframe_edits` ↔ `edits.ts` | No | Yes | JS reimplements upsert/remove/retime |
| `Animated<Rgba>` resolution | No | n/a | blocked on leaf eval being f64-only |

**Abstraction.** Push `pan_frame` (needs `libm` trig) + `us_to_frame` into the leaf
with goldens — `pan_frame`'s golden is the cheapest, highest-value gap. Make the
envelope per-point value a shared scalar; leave only the fill loop duplicated. The
`Animated<Rgba>` item is the **same root flaw** the keyframe-optimization backlog
already names (`2026-06-22-keyframe-system-optimization.md`, P1 = Interpolate
trait + color); widening the leaf's eval to a vector `Interpolate` trait unblocks
color keyframes, the scalar-only effect-param ceiling, and the `trackStatic` color
escape-hatch (`resolveView.ts:95-103`) at once.

---

## Tier 3 — real, but codegen-shaped or supporting

7. **Codegen cross-language types.** `ProjectSummary` + subtree is a 100%
   hand-mirrored Rust↔TS wall (`commands/mod.rs:41-318` ↔ `ipc/index.ts:6-324`),
   guarded by one serde-key test. Export wire structs (`VideoSinkStartArgs`,
   `TranscodeSpec`, `AudioEncodeSpec`) are hand-mirrored literals. Events use
   magic-string names with `unknown` payloads end-to-end. Fix: `ts-rs`/`schemars`
   from the Rust view structs (MCP catalog already emits JSON Schema — half the
   input exists) + a shared event-name/payload catalog. (This is Step 1b.)

8. **`LayerParams` enum accessors.** The 6-arm `match LayerParams` is hand-written
   in ~8 fns (`layer.rs:226-388`, `mutations.rs`); "which kinds carry
   transform+opacity" repeats 4×. A `transform_mut()`/`opacity_mut()`/
   `animated_f64_fields_mut()` accessor makes a 7th kind or 6th transform field one
   edit. Exhaustiveness is the only safety net today.

9. **Main-process command interceptors** (`main/index.ts:189-220`) — the growing
   `if (channel === 'motif_capture_frame')` chain wants a `Record<string, handler>`
   map. Small now; it's the growth point for every future OS/keyring/CDP command.

---

## Do NOT abstract (correct as-is; over-abstraction would regress)

- **Undo/history.** Snapshot-based (`Arc<Project>` per entry, cheap via `imbl`
  structural sharing). No mutation defines an inverse; a new field rides the
  snapshot free. Adding per-mutation inverse-ops would be strictly worse. Only
  extractable bit: fold the ~5 `replace_*_everywhere` loops into one
  `map_all_snapshots(f)`.
- **The effect catalog.** Already a true SSOT; Rust is deliberately kind-agnostic.
  Adding a Rust effect enum to "match" the TS one would *create* the drift it
  avoids.
- **The preload capability list.** Keep `window.api` curated/named (security
  rationale at `preload/index.ts:16-22`). Only the *plumbing* between the type and
  the two endpoints is mechanism worth a channel registry.

---

## Recommended sequencing

1. **#1 command-surface unification** — largest + most drift-prone (it has already
   drifted), enabling pattern proven in-crate; transitively simplifies MCP,
   dry-run, docs, the read-model. Do as 1a → 1b → 1c.
2. **#2 (DecodeSession + FrameSink)** and **#3 (kind registry + bitmap base)** —
   independent, parallelizable render-side wins.
3. **`pan_frame` golden (#6)** — cheapest item on the list, closes the single
   sharpest correctness gap; do regardless of the bigger refactors.

---

## Step 1 plan (executing now)

Goal of **Step 1a**: collapse the two command-wrapper layers
(`commands/mutations.rs` with hardcoded `Actor::User` + `→ String`, and
`mcp/tools.rs` with hardcoded `agent_actor()` + `→ McpToolError`) into **one
`Actor`-parameterized command layer that returns `CommandError`**. Both
dispatchers become thin adapters that supply their own `Actor` and render the
error to their own wire shape.

Deliberately **deferred** to keep TS untouched and risk low:
- Merging the two args structs / flipping wire casing → Step 1b (with codegen).
- The `command_table!` macro → Step 1c.

### Design

`commands::mutations::<cmd>` becomes the single implementation:

```rust
pub async fn move_layer(
    backend: &Backend,
    actor: Actor,                 // ← was hardcoded Actor::User
    layer_id: String,
    new_track_id: String,
    new_t_start_us: TimeUs,
    escape_group: bool,
) -> Result<(), CommandError> {   // ← was Result<(), String>
    let handle = backend.project().map_err(CommandError::Backend)?;
    let id  = parse_uuid(&layer_id, "layer_id")?;          // → CommandError::InvalidArgument
    let tid = parse_uuid(&new_track_id, "new_track_id")?;
    handle.move_layer(actor, id, tid, new_t_start_us, escape_group).await
}
```

- napi UI dispatch: `ser(commands::mutations::move_layer(self, Actor::User, …)
  .await.map_err(|e| e.to_string()))` — flattens to `String` at the boundary, so
  **TS is unchanged**.
- MCP `tools::move_layer` becomes an adapter: deserialize its (snake_case) args →
  `commands::mutations::move_layer(b, agent_actor(), …).await
  .map_err(map_command_error)?; Ok(ToolResult::empty())`. The body lives once.

### New `CommandError` variants (`state/actor.rs:338`)

- `InvalidArgument { field: String, detail: String }` — UUID/edge parse failures.
- `Backend(String)` — `backend.project()` "not initialized".

`map_command_error` (`mcp/tools.rs:73`) maps `InvalidArgument → invalid_params`,
`Backend → internal_error`. UI `e.to_string()` covers both.

### Rollout order (each: edit shared fn → repoint napi arm → make MCP fn an adapter → `cargo test`)

- [x] First slice (prove the pattern): `move_layer`, `trim_layer`, `delete_layer`,
  `duplicate_layer`. **Done 2026-06-22** — single `Actor`-parameterized
  `commands::mutations::*` returning `CommandError`; napi UI dispatch passes
  `Actor::User` + flattens to string; MCP `tools::*` are now thin adapters;
  added `CommandError::{InvalidArgument, Backend}` + routed them in
  `map_command_error`; deleted the now-dead `tools::parse_layer_edge` + its
  import. New `arg_parsing_tests` lock the `InvalidArgument` contract. 623
  lib tests green (`--features jobs,export,cloud,mcp,motifs`); TS untouched.
- [ ] Then: `split_layer_grouped`/`split_layer`, `groups_create`, `groups_dissolve`,
  `set_role_gain`, `update_role_flags`, `update_layer`, `update_layer_params`,
  `add_color_layer`, `add_text_layer`, effects (`add/update/move/remove_effect`),
  `set_composition`.
- [ ] Unify the divergent ones last: `add_media_layer` (UI) vs `add_video_layer`
  (MCP auto-pair logic) — these have drifted; reconcile into one.

### Verification

- `cargo test` (native, with `--features jobs,export,motifs,mcp` as needed).
- Existing MCP smoke + UI e2e remain green (behavior is identical; only the actor
  source and error rendering move).
