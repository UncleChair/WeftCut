# State-Actor TS Migration — Phase 2b-v Plan (media pool + media-bearing layers + separate_audio + params)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the FIFTH slice of **Phase 2b** of the master plan `2026-06-22-state-actor-ts-migration.md`. Read the **Phase-2b-iv plan** (`…-phase-2b-iv.md`) first — it established the per-slice workflow (port TS mutation → unit-test → extend dispatch+vocab+driver → author corpus → regen oracles → differential-gate) and the id-contract discipline this slice depends on.

> **SCOPE (decided 2026-06-22):** this is the COMBINED 2b-v from the master plan — **media** (pool + media-bearing layers + separate_audio) AND **params** (`update_layer_params` + `update_layer_param_track`/`_tracks`). Tasks 1–4 cover media; Tasks 5–8 cover params. After this slice the remaining roadmap is **2b-vi = captions + role/settings/flags**. ONE SCOPE-OUT inside params: `apply_update_layer_params`'s **Motif content-window clamp** (mutations.rs:391-453) depends on the motif catalog (`motifs::catalog::builtins()` + `motif_cap_us`), which the TS state actor does not have and the corpus has no Motif layers to exercise — it is the single piece deferred (a carry-forward, gated when the harness gains a motif catalog). Everything else in `apply_update_layer_params` (the catalog-free `apply_params_patch` field-merge for all 6 kinds incl. Motif field merges) IS ported.

**Goal:** Port and differential-gate the media subsystem (`add_media_item`, media-bearing `add_layer`, `separate_audio_to_new_track`) AND the params subsystem (`update_layer_params` — the `LayerParamsPatch` field-merge; `update_layer_param_track`/`_tracks` — keyframe-track writes with the param-key resolver + `normalize_keyframes` + lazy effect-param insertion).

**Architecture:** Same as Phase 1/2a/2b-* — pure functions over an Immer draft, 1:1 with the authoritative Rust. **Media:** `add_media_item` is UNRECORDED (mirrors `do_add_media_item`, actor.rs:2690): it inserts into the pool, validates the probe, replaces the pool in EVERY snapshot+checkpoint (`History.replaceMediaPoolEverywhere`, new — mirror of `replace_media_pool_everywhere`, history.rs:225), and broadcasts (burns one id). `separate_audio` is RECORDED (`do_separate_audio`, actor.rs:2573). Media-bearing `add_layer` reuses `applyAddLayer` + new param-builders. **Params:** all three ops are RECORDED. `applyUpdateLayerParams` = lock-check + locate + `applyParamsPatch` (the kind-matched field-merge, mutations.rs:1232; Motif clamp scoped out). `applyUpdateLayerParamTrack` = lock-check + `normalizeKeyframes` (snap+sort+dedupe, EmptyKeyframeTrack on empty) + locate + resolve the `Animated<f64>` slot by param-key (transform/opacity for visual kinds; gain_db/pan for Audio; `effects[<id>].params[<key>]` with lazy `Static(0)` insertion) + assign; `update_layer_param_tracks` loops it under ONE commit. The differential corpus grows by ~27 sequences; the Rust `replay_driver` gains `add_media`/`separate_audio` arms, media-kind `add_layer` arms, and `update_layer_params`/`update_layer_param_track`/`update_layer_param_tracks` arms; the gate (`differential.phase2.test.ts`) auto-picks-up new sequences once vocabulary + oracles exist.

**Tech Stack:** TypeScript, Immer, Vitest, the `weftcut-eval` wasm leaf (`snapFrameRound`, UNCHANGED, via `applyAddLayer` + `normalizeKeyframes`), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (needs the cargo/ffmpeg toolchain).

## Global Constraints

- **The oracle-regeneration toolchain (verified working through 2b-iv).** Regenerating oracles builds `replay_driver` (compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence 2× (determinism gate), writes oracle/*.json
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error). **Every driver change in this slice is ADDITIVE** — after a regen, the **116 pre-existing oracles must be byte-identical**; only NEW oracle files may appear. Verify with `git status --short fixtures/state-corpus/oracle/` after each regen (only `??` new files, never `M`). If an existing oracle shows Modified, STOP — the change wasn't additive; investigate.
- **Baseline:** the corpus currently holds **116 sequences / 116 oracles**; `differential.phase2.test.ts` runs all 116 with `skipped === []`.
- **Gate-ordering invariant (why task order matters).** `differential.phase2.test.ts` asserts `skipped === []` over the LIVE corpus dir, and `gen-state-oracle.mjs` runs the Rust driver over the LIVE corpus dir. So for any new op X: X must be in TS `SUPPORTED_OPS` + `buildArgs` + a dispatch arm + its mutation, AND in the Rust driver's `apply()`, **before** any corpus sequence using X exists. Likewise a new `add_layer` `kind` (`video`/`audio`/`image`) must be in TS `SUPPORTED_ADD_KINDS` + the dispatch param-builder AND the driver's `add_layer` match before any corpus sequence uses it. (Tasks 1–3 land TS code + unit tests with NO corpus; Task 4 wires the driver + vocab and only THEN authors the corpus.)
- **★ KEYSTONE — `add_media_item` is UNRECORDED, pool-everywhere, and the media id is CALLER-SUPPLIED (not counter-minted); only the broadcast burns one counter id.** `do_add_media_item` (actor.rs:2690) clones the current pool, inserts `item` (using `item.id` verbatim — NO `new_id()`), validates a probe with the new pool, then `replace_media_pool_everywhere` (history.rs:225 — sets `media_pool` on EVERY snapshot+checkpoint so the pool is durable across undo/redo) and `broadcast_unrecorded` (actor.rs:3815 — mints ONE id; the TS twin `broadcastUnrecorded` already does `idGen()`). No HistoryEntry is recorded. So the only counter interaction is the one broadcast id; the media id itself is a literal carried by the corpus command (driver and TS both use it verbatim). Gated by `add-media-survives-undo.json` (pool persists through an undo of an unrelated edit) + a trailing `add_layer` whose id reveals the single broadcast burn.
- **★ KEYSTONE — `separate_audio` mints the new-track id AFTER the locate + kind checks, before commit.** `do_separate_audio` (actor.rs:2573) returns early on `LayerNotFound` (locate) / `WrongLayerKind` (the layer is not `Audio`) **before** `Track::new()` (so those failures burn NO id — the `add_layer`/`add_transition` pattern), then mints the track id, moves the audio layer onto the new track, inserts it BEFORE the source track, and `commit`s (op_id minted only AFTER validate). The TS `applySeparateAudio` MUST call `idGen()` at the same point — after the checks, inside the `commit` recipe. Gated by `separate-audio-wrong-kind.json` (a trailing `add_layer`'s id stays unshifted → no burn) + a unit test.
- **★ KEYSTONE — media-bearing `add_layer` validation surfaces as `ValidationFailed(...)` and a validate-fail STILL burns the layer id (no new behavior — same as any overlap-reject add_layer).** `apply_add_layer` mints the layer id BEFORE `commit`'s `validate`. The validator (validate.rs:410-493, already ported in validate.ts:60-75) rejects a media layer with `MissingMedia` (media not in the pool), `InvalidSrcRange` (`src_in < 0 || src_in >= src_out`), or `SrcRangeExceedsMedia` (`src_out > media.duration_us`, when the media declares a duration). On any of these the layer id is burned but no op_id — exactly the established `overlap-reject-*` corpus behavior; `commit`'s `produce`→`runValidate`→throw already handles it. The corpus must therefore `add_media` BEFORE the referencing `add_layer`.
- **★ KEYSTONE — `MediaItem` must serialize BYTE-IDENTICALLY between the Rust driver and the TS replay.** Both construct a `MediaItem` from the same minimal corpus spec `{ id, kind, duration_us }` using identical fixed defaults for every other field (see the `media_item`/`mediaItemTemplate` helpers in Task 3/4). The only fragile field is `imported_at` (Rust `DateTime<Utc>` → serde RFC3339 vs the TS string literal). The driver builds it from a fixed instant; **after the first regen, read the oracle's serialized `imported_at` string and set the TS template literal to EXACTLY match** (the regenerated oracle is truth — the differential gate will flag any mismatch with the exact diff). `path_abs` uses FORWARD slashes (`"media/clip.bin"`) so Rust `PathBuf` serialization is platform-stable. `canonicalize` key-sorts recursively, so field ORDER is irrelevant — only VALUES must match. `MediaMetadata`'s `video`/`audio`/`container_format` all serialize (serde `#[serde(default)]` does not skip serialization), so the TS template MUST set them to `null` explicitly.
- **★ PARAMS KEYSTONE — `apply_params_patch` is a kind-matched field-merge; a kind mismatch is the ONLY error, and it mints no id.** `apply_params_patch` (mutations.rs:1232) matches `(layer.params, patch)` on the discriminant: the 6 matching arms merge each present field (animated fields wrap as `Animated::Static(v)`, replacing any keyframe track — a documented MVP limitation; Motif `props` MERGE field-wise, never replace the whole map); the fallback arm returns `LayerParamsKindMismatch{layer,actual,patch}` (both already in errors.ts:44). `do_update_layer_params` (actor.rs:2734) is `check_track_lock` (TrackLocked / LayerNotFound) → `apply_update_layer_params` (locate → patch → Motif clamp [SCOPED OUT] → autofit only if geom changed) → recorded `commit`. For the 6 non-Motif/Motif-field paths there is NO geometry change, so NO autofit. The Motif `seconds`-shrink content-window clamp (the only autofit trigger) is the deferred carry-forward.
- **★ PARAMS KEYSTONE — the keyframe param-track write: `normalize_keyframes` first (EmptyKeyframeTrack), then resolve-or-lazy-insert (UnknownKeyframeParam), then assign; NO autofit; keyframe ids are caller-supplied literals.** `apply_update_layer_param_track` (mutations.rs:457): (1) `check_track_lock`; (2) `track.normalize_keyframes(snap)` — snap each `t_us` via `snapFrameRound`, stable-sort by `t_us`, dedupe same-snapped-time KEEPING THE LAST (JS `Array.sort` is stable in Node 22; dedupe keeps last-by-input-order), and an EMPTY `Keyframed` track → `EmptyKeyframeTrack{layer,param_key}` (Static is unchanged, always ok); (3) locate (LayerNotFound); (4) resolve the `Animated<f64>` slot by `param_key` — visual kinds (VideoClip/ImageOverlay/Text/Motif) accept `x`/`y`/`scale_x`/`scale_y`/`rotation_deg`/`opacity`, Audio accepts `gain_db`/`pan`, Color accepts none, AND `effects[<uuid>].params[<key>]` resolves into `layer.effects` — IF the slot is missing AND the key is a valid effect-param path for an EXISTING effect, lazily insert `Static(0.0)` (so a fresh effect's first keyframe write creates the slot), then re-resolve; still-missing → `UnknownKeyframeParam{layer,param_key}` (both errors already in errors.ts:53-54); (5) assign the normalized track; (6) NO `apply_duration_autofit` (a keyframe write never moves `t_start`/`t_end`). `update_layer_param_tracks` (do_update_layer_param_tracks, actor.rs:2771) loops `apply_update_layer_param_track` per entry over ONE cloned draft, then ONE recorded `commit` (one op_id for the whole batch; any entry's failure aborts the batch with no commit). Keyframe ids/values/interp are carried VERBATIM by the corpus (no counter interaction).
- **id contract (otherwise unchanged):** `commit` allocates the op_id AFTER `validate`; a successful recorded op burns one op_id; a failed mutation or failed validate burns no op_id. `add_media_item` burns exactly one id (the unrecorded broadcast) and the media id is a literal. `separate_audio` mints one entity id (the new track) on the success path + one op_id; on `LayerNotFound`/`WrongLayerKind` it burns nothing. A media-bearing `add_layer` mints the layer id in the recipe (burned even on a validate failure) + one op_id on success. `update_layer_params`/`update_layer_param_track` burn one op_id on success, none on a pre-validate failure (LayerNotFound/TrackLocked/LayerParamsKindMismatch/EmptyKeyframeTrack/UnknownKeyframeParam are all raised in the recipe → produce-throw → no op_id); `update_layer_param_tracks` burns ONE op_id for the whole batch.
- **The wasm snap leaf is sacred** — `snapFrameRound` from `../snap`, never reimplemented (reached through `applyAddLayer` and `normalizeKeyframes`). **TimeUs is `number`.** Keyframe param-tracks are `Animated<f64>` ONLY (the resolver handles no `Animated<Rgba>` — color keyframing is not a thing).
- **The TS model + validator + errors already cover this slice — no changes there.** `VideoClipParams`/`AudioParams`/`ImageOverlayParams`/`MediaItem`/`MediaMetadata`/`Project.media_pool` are in model.ts:37-100; the validator's media rules (`MissingMedia`/`InvalidSrcRange`/`SrcRangeExceedsMedia`) are in validate.ts:60-75; the `WrongLayerKind` `CommandError` and the three media `ValidationError` variants are in errors.ts:16-18,30; `serializeProject` is identity over `media_pool` and `canonicalize` key-sorts; `parseOracleErrorVariant`/`tsErrorVariant` already normalize `WrongLayerKind` (top-level) and `ValidationFailed(MissingMedia/SrcRangeExceedsMedia)` (inner) with no new code. This slice adds NO `model.ts`/`validate.ts`/`errors.ts`/`serialize.ts`/`canonical.ts` changes.
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — [[feedback_parallel_sessions_git]]). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Reference Rust sources (cite; re-read only if a differential step diverges)

- Media model: `native/src/state/media.rs` (`MediaItem` — id/label/path_abs/path_rel/kind/metadata/proxy_path/proxy_format_version/quick_proxy_path/proxy_bypassed/export_uses_original/waveform_path/conform_path/thumbnails_dir/file_hash_blake3/file_size/file_mtime/imported_at; `MediaKind::{Video,Audio,Image,Subtitle}`; `MediaMetadata { duration_us, video, audio, container_format }`).
- `do_add_media_item` (UNRECORDED; pool-everywhere + broadcast) — `native/src/state/actor.rs:2690-2714`. `replace_media_pool_everywhere` — `native/src/state/history.rs:225-239`. `broadcast_unrecorded` (burns one id) — `actor.rs:3811-3820`.
- `do_separate_audio` (RECORDED) — `native/src/state/actor.rs:2573-2620`. `Track::new()` defaults are mirrored by the existing `applyAddTrack` (add.ts:43-50: `enabled:true,locked:false,muted:false,solo:false,removable:true,role:null,transient:false,height_px:64,layers:[]`).
- `apply_add_layer` (mints layer id after the TrackNotFound check; snaps both edges; t-sorted insert; autofit) — `native/src/state/actor/mutations.rs:47-89` (TS twin `applyAddLayer`, add.ts:28).
- Media-layer param shapes (canonical defaults to mirror): `add_media_layer` — `native/src/commands/mutations.rs:91-137` (VideoClip: `src_in:0,src_out:dur,transform default,opacity 1,crop None,flip false,blend default,speed 1,fades 0`; Audio standalone: `gain 0,pan 0,fades 0,mute false,role Music`; Image: `transform default,opacity 1,blend default,fades 0`). `Default::default()` for `BlendMode` is `Normal`; for `Transform` is x/y 0, scale 1, rotation 0, anchor [0.5,0.5] (matches `defaultTransform`, add.ts:21).
- Validator media rules — `native/src/state/validate.rs:410-493` (`validate_layer` → `check_media_ref` → `MissingMedia`; `check_src_range` → `InvalidSrcRange`/`SrcRangeExceedsMedia`).
- The handle methods the driver calls: `add_media_item` — `actor.rs:1163-1178`; `add_layer` — `actor.rs:949-970`; `separate_audio_to_new_track` — `actor.rs:1075-1090`; `update_layer_params`/`update_layer_param_track`/`update_layer_param_tracks` — `actor.rs:1199-1256`.
- **Params** — `LayerParamsPatch` (`#[serde(tag="kind")]` internally-tagged enum: `Text`/`VideoClip`/`ImageOverlay`/`Motif`/`Color`/`Audio` + their `*Patch` field structs) — `native/src/state/actor.rs:99-255`. `apply_params_patch` (the kind-matched field-merge; `layer_params_kind`/`layer_params_patch_kind` for the mismatch error) — `mutations.rs:1232-1452`. `do_update_layer_params`/`do_update_layer_param_track`/`do_update_layer_param_tracks` — `actor.rs:2734-2789`. `apply_update_layer_params` (lock-check, locate, patch, **Motif clamp = the deferred branch**, conditional autofit) — `mutations.rs:372-455`. `apply_update_layer_param_track` (lock, normalize, locate, lazy effect-param insert, resolve, assign) — `mutations.rs:457-492`. The param-key resolver: `resolve_animated_f64_mut`/`transform_or_opacity`/`parse_effect_param_key`/`resolve_animated_f64_mut_on_layer` — `native/src/state/layer.rs:320-382`. `Animated::normalize_keyframes` — `native/src/state/animated.rs:118-146`. `Animated<T>` wire shape is `#[serde(tag="mode", content="value")]` = `{mode,value}` (animated.rs:30-35) — already mirrored by the TS `Animated<T>` (model.ts:20).
- TS pieces already in place: media types + `MediaItem`/`media_pool` (model.ts:37-103); media validator rules (validate.ts:60-75); errors — media (errors.ts:16-18,30) + params (`LayerParamsKindMismatch` errors.ts:44, `EmptyKeyframeTrack`/`UnknownKeyframeParam` errors.ts:53-54); `Animated<T>`/`Keyframe`/`Interpolation`/`Transform` (model.ts:16-27); `applyAddLayer`/`applyAddTrack`/`defaultTransform`/`colorParams`/`textParamsDefault` (add.ts); `shiftKeyframes`/`retainKeyframes`/`collapseToStatic` (animated.ts — the home for the new `normalizeKeyframes`); the `commit`/`broadcastUnrecorded`/`runValidate`/dispatch idioms + the `updateTrackFlags` unrecorded closure as the template for `addMediaItem` (actor.ts:62-90,185-189); the existing `update_layer` dispatch arm + `LayerPatch` flow as the template for the params dispatch arms (actor.ts:241); `History.replaceTrackFlagsEverywhere`/`replaceSettingsEverywhere` as templates for `replaceMediaPoolEverywhere` (history.ts:82-103); `forEachAnimatedF64` shows the param-key→slot vocabulary (animated.ts:7-19).

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/history.ts` | `replaceMediaPoolEverywhere(pool)` (mirror history.rs:225). | Mod |
| `src/main/state/history.test.ts` | Media-pool-everywhere unit test (patches all snapshots, cursor unchanged, durable across undo). | Mod |
| `src/main/state/mutations/media.ts` | `videoClipParams`/`audioParams`/`imageOverlayParams` param-builders; `applySeparateAudio` (id minted after checks); `mediaItemTemplate(id,kind,durationUs)`. | **New** |
| `src/main/state/mutations/media.test.ts` | Unit tests: param-builder shapes; separate_audio happy/LayerNotFound/WrongLayerKind + the no-burn id assertion; mediaItemTemplate shape. | **New** |
| `src/main/state/mutations/add.ts` | `export` `defaultTransform` (consumed by media.ts). | Mod |
| `src/main/state/actor.ts` | `addMediaItem` closure (unrecorded, pool-everywhere + broadcast); `add_media`/`separate_audio` dispatch arms; media-kind arms in the `add_layer` dispatch. | Mod |
| `src/main/state/actor.test.ts` | Dispatch describe blocks: media add_layer (video/audio/image) + MissingMedia/SrcRangeExceedsMedia; add_media + survives-undo; separate_audio + WrongLayerKind/LayerNotFound. | Mod |
| `src/main/state/mutations/animated.ts` | `normalizeKeyframes(a, snap)` (mirror animated.rs:118). | Mod |
| `src/main/state/mutations/animated.test.ts` | `normalizeKeyframes` unit test (snap/sort/dedupe-last; empty→false; Static→true). | Mod |
| `src/main/state/mutations/params.ts` | `LayerParamsPatch` TS type; `applyParamsPatch`; `applyUpdateLayerParams` (clamp scoped out); `parseEffectParamKey`; `applyUpdateLayerParamTrack` (resolve-or-lazy-insert + normalize). | **New** |
| `src/main/state/mutations/params.test.ts` | Unit tests: per-kind field-merge; kind-mismatch; lock reject; missing layer; param-track happy/empty/unknown/effect-lazy-insert; batch. | **New** |
| `src/main/state/actor.ts` | `add_media`/`separate_audio`/media `add_layer` (media tasks); `update_layer_params`/`update_layer_param_track`/`update_layer_param_tracks` dispatch arms (params tasks). | Mod |
| `src/main/state/actor.test.ts` | Media dispatch (Tasks 3); params dispatch describe blocks (Task 7). | Mod |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` += `add_media`/`separate_audio` (media) + `update_layer_params`/`update_layer_param_track`/`update_layer_param_tracks` (params); `SUPPORTED_ADD_KINDS` += `video`/`audio`/`image`; `buildArgs` for all + extend `add_layer`. | Mod |
| `native/src/bin/replay_driver.rs` | `add_media`+`media_item`, `separate_audio`, media `add_layer` arms (media); `update_layer_params`/`update_layer_param_track`/`update_layer_param_tracks` arms (params). | Mod |
| `fixtures/state-corpus/sequences/*.json` | ~11 media + ~16 params sequences. | **New** |
| `fixtures/state-corpus/oracle/*.json` | Regenerated oracle traces (generated). | **New (generated)** |
| `fixtures/state-corpus/README.md` | Media + params coverage rows; close gap #1 (media) + the params half of gap #5. | Mod |

> Note: the `actor.ts`, `actor.test.ts`, `replay.ts`, `replay_driver.rs`, and corpus dirs are touched by BOTH the media tasks (1–4) and the params tasks (5–8); each task's commit stages only its own slice's additions (additive — no conflict).

---

## Task 1: `History.replaceMediaPoolEverywhere` (TS only)

**Files:**
- Modify: `src/main/state/history.ts`
- Test: `src/main/state/history.test.ts`

**Interfaces:**
- Produces: `History.replaceMediaPoolEverywhere(pool: Record<string, MediaItem>): void` — copy `pool` into EVERY snapshot + checkpoint; cursor unchanged; not recorded.
- Consumes: `MediaItem` from `./model`.

- [ ] **Step 1: Write the failing test** in `src/main/state/history.test.ts` (add a describe block near `replaceTrackFlagsEverywhere`; add `type MediaItem` to the model import if absent):

```ts
describe('History.replaceMediaPoolEverywhere', () => {
  const mediaItem = (id: string): MediaItem => ({
    id, label: null, path_abs: 'media/clip.bin', path_rel: null, kind: 'Video',
    metadata: { duration_us: 4_000_000, video: null, audio: null, container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '2026-01-01T00:00:00Z',
    proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false,
    proxy_format_version: 0, conform_path: null, waveform_path: null, thumbnails_dir: null,
  })
  it('sets the pool on every snapshot, leaving the cursor put and surviving undo', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, gen())
    // record a second snapshot (an unrelated edit) so there are two entries to patch
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000 } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    const id = '00000000-0000-0000-0000-0000000000aa'
    h.replaceMediaPoolEverywhere({ [id]: mediaItem(id) })
    expect(Object.keys(h.current().media_pool)).toEqual([id]) // head patched
    const earlier = h.undo()! // back to the Initial snapshot
    expect(Object.keys(earlier.media_pool)).toEqual([id])       // earlier snapshot patched too (durable across undo)
    expect(earlier.composition.duration_us).toBe(0)             // pool-only patch leaves the rest intact
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/history.test.ts` → FAIL (method missing).

- [ ] **Step 3: Implement** in `history.ts` (after `replaceTrackFlagsEverywhere`, before `replaceCompositionCanvasEverywhere`). Add `MediaItem` to the model import:
```ts
import type { Composition, MediaItem, Project, ProjectSettings, Uuid } from './model'
```
```ts
  /** native/src/state/history.rs:225 — set `media_pool` on EVERY snapshot +
   *  checkpoint. Media imports live OUTSIDE the editing undo/redo stack, so the
   *  pool must be durable across undos/redos through unrelated edits (cursor
   *  unchanged; never recorded — project_settings_patch_convention). */
  replaceMediaPoolEverywhere(pool: Record<string, MediaItem>): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, media_pool: pool }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, media_pool: pool }
  }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/history.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/history.test.ts
git commit -m "feat(state-migration): History.replaceMediaPoolEverywhere (Phase 2b-v)"
```

---

## Task 2: media param-builders + `applySeparateAudio` + `mediaItemTemplate` (`mutations/media.ts`)

**Files:**
- Create: `src/main/state/mutations/media.ts`
- Test: `src/main/state/mutations/media.test.ts`
- Modify: `src/main/state/mutations/add.ts` (export `defaultTransform`)

**Interfaces:**
- Produces:
  - `videoClipParams(media: Uuid, srcInUs: number, srcOutUs: number): LayerParams`
  - `audioParams(media: Uuid, srcInUs: number, srcOutUs: number): LayerParams` (standalone role = `Music`)
  - `imageOverlayParams(media: Uuid): LayerParams`
  - `applySeparateAudio(p: Project, idGen: IdGen, layerId: Uuid): Uuid` — locate else `LayerNotFound`; require `params.kind==='Audio'` else `WrongLayerKind{layer,expected:'Audio'}`; THEN `id=idGen()`; remove the audio layer from its source track; build a new non-reserved track labelled `"<source label> (audio)"` (or `"Audio"` when the source label is empty/null) holding the moved layer; splice it at the source track's index (BEFORE the source); return the new track id.
  - `mediaItemTemplate(id: Uuid, kind: MediaItem['kind'], durationUs: number | null): MediaItem` — the fixed-defaults media item (the byte-identical twin of the driver's `media_item`).
- Consumes: `defaultTransform` from `./add` (newly exported); `applyAddLayer`/`audioParams`/`colorParams` for test setup; `CommandFailure` from `../errors`; `seededGen`/`IdGen` from `../ids`; `Layer`/`LayerParams`/`MediaItem`/`Project`/`Track`/`Uuid` from `../model`.

- [ ] **Step 1: Export `defaultTransform` from `add.ts`** — change `function defaultTransform()` to `export function defaultTransform()` (add.ts:21). No other change.

- [ ] **Step 2: Write the failing tests** (`src/main/state/mutations/media.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { applyAddLayer } from './add'
import { isCommandFailure } from '../errors'
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate } from './media'

const MID = '00000000-0000-0000-0000-0000000000aa'
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function trackOfLayer(p: Project, id: string): { ti: number; layer: Layer } {
  for (let ti = 0; ti < p.tracks.length; ti++) { const l = p.tracks[ti].layers.find((x) => x.id === id); if (l) return { ti, layer: l } }
  throw new Error('layer not found')
}

describe('media param builders', () => {
  it('videoClipParams: defaults match add_media_layer (transform/opacity/crop/flip/blend/speed/fades)', () => {
    const p = videoClipParams(MID, 0, 4_000_000)
    expect(p).toEqual({ kind: 'VideoClip', media: MID, src_in_us: 0, src_out_us: 4_000_000,
      transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 },
        scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
      opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false, blend_mode: 'Normal',
      speed: 1, fade_in_us: 0, fade_out_us: 0 })
  })
  it('audioParams: standalone role is music (kebab-case wire form), gain/pan 0', () => {
    const p = audioParams(MID, 0, 3_000_000) as Extract<ReturnType<typeof audioParams>, { kind: 'Audio' }>
    expect([p.kind, p.role, p.gain_db, p.pan, p.mute]).toEqual(['Audio', 'music', { mode: 'Static', value: 0 }, { mode: 'Static', value: 0 }, false])
  })
  it('imageOverlayParams: no src range, blend Normal', () => {
    const p = imageOverlayParams(MID) as Extract<ReturnType<typeof imageOverlayParams>, { kind: 'ImageOverlay' }>
    expect([p.kind, p.media, p.blend_mode, p.fade_in_us]).toEqual(['ImageOverlay', MID, 'Normal', 0])
  })
})

describe('mediaItemTemplate', () => {
  it('builds a fixed-defaults pool item with an explicit-null metadata trio', () => {
    const it1 = mediaItemTemplate(MID, 'Video', 4_000_000)
    expect(it1.metadata).toEqual({ duration_us: 4_000_000, video: null, audio: null, container_format: null })
    expect([it1.path_abs, it1.file_hash_blake3, it1.proxy_bypassed, it1.proxy_format_version]).toEqual(['media/clip.bin', '0', false, 0])
  })
})

describe('applySeparateAudio', () => {
  /** A-roll holds one Audio layer L1 (id #6 — #1-3 blank, #4 Initial NOT consumed here, see note). */
  function withAudio(): { p: Project; gen: IdGen; a1: string } {
    const gen = seededGen()
    const p = blankProject(gen, 's') // #1 A #2 B #3 project
    const a1 = applyAddLayer(p, gen, p.tracks[0].id, audioParams('00000000-0000-0000-0000-0000000000aa', 0, 3_000_000), 0, 3_000_000) // #4
    return { p, gen, a1 }
  }
  it('lifts the audio layer onto a new track inserted before the source, labelled "<src> (audio)"', () => {
    const { p, gen, a1 } = withAudio()
    expect(p.tracks[0].layers.map((l) => l.id)).toEqual([a1]) // A roll holds it
    const newTrack = applySeparateAudio(p, gen, a1) // #5
    expect(newTrack).toBe('00000000-0000-0000-0000-000000000005')
    // new track inserted at the source index (0) → [newAudio, A, B]
    expect(p.tracks[0].id).toBe(newTrack)
    expect(p.tracks[0].label).toBe('A roll (audio)')
    expect(p.tracks[0].layers.map((l) => l.id)).toEqual([a1]) // layer moved here
    expect(p.tracks[0].removable).toBe(true)
    expect(p.tracks[1].layers).toEqual([]) // A roll now empty
  })
  it('LayerNotFound (no id minted)', () => {
    const { p, gen } = withAudio()
    expectCmd(() => applySeparateAudio(p, gen, 'ghost'), 'LayerNotFound')
    // gen un-advanced: next add_layer id is #5 (not #6)
    expect(applyAddLayer(p, gen, p.tracks[1].id, audioParams('00000000-0000-0000-0000-0000000000aa', 0, 1_000_000), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000005')
  })
  it('WrongLayerKind on a non-audio layer (no id minted)', () => {
    const gen = seededGen()
    const p = blankProject(gen, 's')
    const c1 = applyAddLayer(p, gen, p.tracks[0].id, videoClipParams('00000000-0000-0000-0000-0000000000aa', 0, 2_000_000), 0, 2_000_000) // #4 (video, not audio)
    expectCmd(() => applySeparateAudio(p, gen, c1), 'WrongLayerKind')
    expect(applyAddLayer(p, gen, p.tracks[1].id, audioParams('00000000-0000-0000-0000-0000000000aa', 0, 1_000_000), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000005') // no burn
  })
})
```

> Note on ids: these are direct mutation calls (no actor/History), so the History-constructor Initial op_id is NOT consumed here — `blankProject` consumes #1-3 and the first `applyAddLayer` layer id is #4. (Through the actor + driver the Initial op_id shifts everything by one; that path is gated in Task 4.)

- [ ] **Step 3: Run to verify they fail** — `npx vitest run src/main/state/mutations/media.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** (`src/main/state/mutations/media.ts`):

```ts
import type { Layer, LayerParams, MediaItem, Project, Track, Uuid } from '../model'
import type { IdGen } from '../ids'
import { CommandFailure } from '../errors'
import { defaultTransform } from './add'

/** commands/mutations.rs:91 — the canonical VideoClip layer shape. blend_mode
 *  default = Normal, transform default per defaultTransform. */
export function videoClipParams(media: Uuid, srcInUs: number, srcOutUs: number): LayerParams {
  return { kind: 'VideoClip', media, src_in_us: srcInUs, src_out_us: srcOutUs,
    transform: defaultTransform(), opacity: { mode: 'Static', value: 1 }, crop: null,
    flip_h: false, flip_v: false, blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 }
}
/** commands/mutations.rs:109 — standalone Audio layer. AudioRole is
 *  #[serde(rename_all="kebab-case")] (audio_role.rs:14), so Rust AudioRole::Music
 *  serializes to the lowercase wire form "music" — the TS model's AudioRole. */
export function audioParams(media: Uuid, srcInUs: number, srcOutUs: number): LayerParams {
  return { kind: 'Audio', media, src_in_us: srcInUs, src_out_us: srcOutUs,
    gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
    fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' }
}
/** commands/mutations.rs:123 — Image overlay (no src range; validator checks
 *  only the media ref). */
export function imageOverlayParams(media: Uuid): LayerParams {
  return { kind: 'ImageOverlay', media, transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 }, blend_mode: 'Normal', fade_in_us: 0, fade_out_us: 0 }
}

/** Fixed-defaults media-pool item; the byte-identical twin of the driver's
 *  media_item helper. imported_at is reconciled against the regenerated oracle
 *  (the only Rust-DateTime-fragile field). path_abs uses forward slashes so
 *  Rust PathBuf serialization is platform-stable. */
export function mediaItemTemplate(id: Uuid, kind: MediaItem['kind'], durationUs: number | null): MediaItem {
  return {
    id, label: null, path_abs: 'media/clip.bin', path_rel: null, kind,
    metadata: { duration_us: durationUs, video: null, audio: null, container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '2026-01-01T00:00:00Z',
    proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false,
    proxy_format_version: 0, conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
}

/** actor.rs:2573 do_separate_audio — lift an Audio layer onto a fresh
 *  non-reserved track inserted directly BEFORE its source. The new-track id is
 *  minted AFTER the locate + kind checks (so LayerNotFound/WrongLayerKind burn
 *  no id) but BEFORE commit's op_id (the keystone). Track defaults mirror
 *  Track::new() (== applyAddTrack). No autofit (no time change). */
export function applySeparateAudio(p: Project, idGen: IdGen, layerId: Uuid): Uuid {
  let ti = -1, li = -1
  for (let t = 0; t < p.tracks.length; t++) {
    const idx = p.tracks[t].layers.findIndex((l) => l.id === layerId)
    if (idx >= 0) { ti = t; li = idx; break }
  }
  if (ti < 0) throw new CommandFailure({ error: 'LayerNotFound', layer: layerId })
  const source = p.tracks[ti]
  const layer = source.layers[li]
  if (layer.params.kind !== 'Audio') throw new CommandFailure({ error: 'WrongLayerKind', layer: layerId, expected: 'Audio' })

  const newId = idGen() // after the checks, before commit's op_id (keystone)
  const srcLabel = source.label
  const label = srcLabel && srcLabel.length > 0 ? `${srcLabel} (audio)` : 'Audio'
  source.layers.splice(li, 1)
  const newTrack: Track = { id: newId, label, enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: null, transient: false, height_px: 64, layers: [layer] }
  p.tracks.splice(ti, 0, newTrack)
  return newId
}
```

- [ ] **Step 5: Run to verify they pass** — `npx vitest run src/main/state/mutations/media.test.ts` → PASS.

- [ ] **Step 6: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/media.ts apps/desktop/src/main/state/mutations/media.test.ts apps/desktop/src/main/state/mutations/add.ts
git commit -m "feat(state-migration): media param-builders + separate_audio mutation + media item template (Phase 2b-v)"
```

---

## Task 3: actor.ts wiring — `addMediaItem` closure, media `add_layer`, dispatch arms

**Files:**
- Modify: `src/main/state/actor.ts`
- Test: `src/main/state/actor.test.ts`

**Interfaces:**
- Consumes: `videoClipParams`/`audioParams`/`imageOverlayParams`/`applySeparateAudio`/`mediaItemTemplate` from `./mutations/media`; `MediaItem` from `./model`.
- Produces: an internal `addMediaItem(item: MediaItem): Uuid` closure (unrecorded; pool-everywhere + broadcast); dispatch handles `add_media` (returns the media id), `separate_audio` (returns the new track id), and media `kind`s (`video`/`audio`/`image`) in `add_layer`.

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts` (reuse the existing `createActor`/`seededGen`/`blankProject` imports):

```ts
describe('dispatch: media pool + media layers', () => {
  const VID = '00000000-0000-0000-0000-0000000000aa'
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'm'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    return { actor, a }
  }
  it('add_media inserts into the pool (unrecorded) and survives undo of a later edit', () => {
    const { actor, a } = setup()
    expect(actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 4_000_000 }).ok).toBe(true)
    expect(Object.keys(actor.snapshot().media_pool)).toEqual([VID])
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) // recorded
    actor.dispatch('undo')
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // edit undone
    expect(Object.keys(actor.snapshot().media_pool)).toEqual([VID]) // pool persists (replace-everywhere)
  })
  it('add_layer video referencing pooled media succeeds', () => {
    const { actor, a } = setup()
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 4_000_000 })
    const r = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers[0].params.kind).toBe('VideoClip')
  })
  it('add_layer video with media NOT in the pool → ValidationFailed(MissingMedia)', () => {
    const { actor, a } = setup()
    const r = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(r.ok).toBe(false)
    const err = (r as { ok: false; error: { error: string; detail?: { rule: string } } }).error
    expect([err.error, err.detail?.rule]).toEqual(['ValidationFailed', 'MissingMedia'])
  })
  it('add_layer video whose src_out exceeds the media duration → SrcRangeExceedsMedia', () => {
    const { actor, a } = setup()
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 2_000_000 })
    const r = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 5_000_000, t_start_us: 0, t_end_us: 5_000_000 })
    expect((r as { ok: false; error: { detail?: { rule: string } } }).error.detail?.rule).toBe('SrcRangeExceedsMedia')
  })
})

describe('dispatch: separate_audio', () => {
  const AID = '00000000-0000-0000-0000-0000000000bb'
  it('separate_audio lifts the audio layer onto a new track', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sa'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_media', { id: AID, kind: 'Audio', duration_us: 3_000_000 })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'audio', media: AID, src_in_us: 0, src_out_us: 3_000_000, t_start_us: 0, t_end_us: 3_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('separate_audio', { layer: l })
    expect(r.ok).toBe(true)
    const tracks = actor.snapshot().tracks
    expect(tracks[0].id).toBe((r as { ok: true; value: string }).value) // new track inserted before A
    expect(tracks[0].layers.map((x) => x.id)).toEqual([l])
    expect(tracks[0].label).toBe('A roll (audio)')
  })
  it('separate_audio on a color layer → WrongLayerKind', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sa2'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('separate_audio', { layer: l })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('WrongLayerKind')
  })
  it('separate_audio on a missing layer → LayerNotFound', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sa3')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const r = actor.dispatch('separate_audio', { layer: '00000000-0000-0000-0000-000000000000' })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerNotFound')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops / unknown kinds).

- [ ] **Step 3: Wire `actor.ts`.** Add imports (after the transitions import, line 22):
```ts
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate } from './mutations/media'
import type { MediaItem } from './model'
```
> If `MediaItem` is best merged into the existing `./model` type import on line 3, do that instead of a second import line — whichever keeps `npm run typecheck` clean.

Add the `addMediaItem` closure after `updateTrackFlags` (~line 189). It is the media twin of that unrecorded path:
```ts
  // ── add_media_item (do_add_media_item:2690) — UNRECORDED. Insert into the
  //    pool (media id is the caller's, NOT counter-minted), validate the probe,
  //    then replace the pool EVERYWHERE (durable across undo) + broadcast (burns
  //    one id). No HistoryEntry. ──
  function addMediaItem(item: MediaItem): Uuid {
    const cur = current()
    const nextPool = { ...cur.media_pool, [item.id]: item }
    runValidate({ ...cur, media_pool: nextPool })
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Imported media', current())
    return item.id
  }
```

Replace the `add_layer` dispatch arm (actor.ts:220-225) with the media-aware version:
```ts
        case 'add_layer': {
          const kind = a.kind as string
          let params: LayerParams
          switch (kind) {
            case 'text': params = textParamsDefault('hello'); break
            case 'color': params = colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080); break
            case 'video': params = videoClipParams(a.media as Uuid, a.src_in_us as number, a.src_out_us as number); break
            case 'audio': params = audioParams(a.media as Uuid, a.src_in_us as number, a.src_out_us as number); break
            case 'image': params = imageOverlayParams(a.media as Uuid); break
            default: return { ok: false, error: { error: 'InvalidArgument', field: 'kind', detail: `unknown kind ${kind}` } }
          }
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, a.track as Uuid, params, a.t_start_us as number, a.t_end_us as number))
          return { ok: true, value: id }
        }
```

Add two dispatch arms (after the `remove_transition` arm, ~line 253):
```ts
        case 'add_media': return { ok: true, value: addMediaItem(mediaItemTemplate(a.id as Uuid, a.kind as MediaItem['kind'], (a.duration_us as number | null) ?? null)) }
        case 'separate_audio': return { ok: true, value: commit('Separated audio', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applySeparateAudio(d, idGen, a.layer as Uuid)) }
```

- [ ] **Step 4: Run to verify all pass** — `npx vitest run src/main/state/actor.test.ts` → PASS. Then `npx vitest run src/main/state/__tests__/differential.phase2.test.ts` → still 116/116 (no corpus added yet; the dispatch changes must not perturb existing sequences).

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): actor add_media/separate_audio dispatch + media add_layer (Phase 2b-v)"
```

---

## Task 4: driver + vocabulary + corpus + regen + gate

**Files:**
- Modify: `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`
- Modify: `fixtures/state-corpus/{sequences,oracle}/`, `fixtures/state-corpus/README.md`

**Interfaces:**
- Consumes: the TS dispatch arms from Task 3; the handle methods `add_media_item`/`add_layer`/`separate_audio_to_new_track`.
- Produces: `SUPPORTED_OPS` += `add_media`/`separate_audio`; `SUPPORTED_ADD_KINDS` += `video`/`audio`/`image`; `buildArgs` cases; the driver's `add_media` arm + `media_item` helper, `separate_audio` arm, and media-kind arms in `add_layer`; ~11 corpus sequences + regenerated oracles.

- [ ] **Step 1: Wire `replay.ts`.**
  - Add `'add_media', 'separate_audio'` to `SUPPORTED_OPS`.
  - Change `SUPPORTED_ADD_KINDS` to `new Set<string>(['color', 'text', 'video', 'audio', 'image'])`.
  - Extend the `add_layer` `buildArgs` case to forward the media fields (media resolves a `@ref`; absent for color/text):
```ts
    case 'add_layer': return { track: resolve(refs, cmd.track), kind: cmd.kind, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us,
      media: cmd.media !== undefined ? resolve(refs, cmd.media) : undefined, src_in_us: cmd.src_in_us, src_out_us: cmd.src_out_us }
```
  - Add two `buildArgs` cases (before the `undo`/`redo` case):
```ts
    case 'add_media': return { id: cmd.id, kind: cmd.kind, duration_us: cmd.duration_us ?? null }
    case 'separate_audio': return { layer: resolve(refs, cmd.layer) }
```

- [ ] **Step 2: Add the driver arms** in `native/src/bin/replay_driver.rs`.
  - Extend the imports (line 11): add `MediaItem`-reachable paths. Use the fully-qualified `state::media::...` and `state::layer::...` paths inline (no new `use` needed beyond what's there); `AudioRole` is at `state::audio_role::AudioRole`.
  - Replace the `add_layer` arm's `params` match (replay_driver.rs:71-78) with:
```rust
            let params = match cmd["kind"].as_str().unwrap() {
                "color" => LayerParams::Color(ColorParams {
                    color: Animated::Static(Rgba { r: 255, g: 0, b: 0, a: 255 }),
                    width: 1920, height: 1080,
                }),
                "text" => default_text_params(),
                "video" => LayerParams::VideoClip(state::layer::VideoClipParams {
                    media: resolve_id(refs, cmd["media"].as_str().unwrap()),
                    src_in_us: r(cmd, "src_in_us"), src_out_us: r(cmd, "src_out_us"),
                    transform: Default::default(), opacity: Animated::Static(1.0), crop: None,
                    flip_h: false, flip_v: false, blend_mode: Default::default(), speed: 1.0,
                    fade_in_us: 0, fade_out_us: 0,
                }),
                "audio" => LayerParams::Audio(state::layer::AudioParams {
                    media: resolve_id(refs, cmd["media"].as_str().unwrap()),
                    src_in_us: r(cmd, "src_in_us"), src_out_us: r(cmd, "src_out_us"),
                    gain_db: Animated::Static(0.0), pan: Animated::Static(0.0),
                    fade_in_us: 0, fade_out_us: 0, mute: false,
                    role: state::audio_role::AudioRole::Music,
                }),
                "image" => LayerParams::ImageOverlay(state::layer::ImageOverlayParams {
                    media: resolve_id(refs, cmd["media"].as_str().unwrap()),
                    transform: Default::default(), opacity: Animated::Static(1.0),
                    blend_mode: Default::default(), fade_in_us: 0, fade_out_us: 0,
                }),
                other => return Err(format!("unknown kind {other}")),
            };
```
  - Add the `add_media` + `separate_audio` arms before the `other =>` arm:
```rust
        "add_media" => h.add_media_item(u, media_item(cmd)).await
            .map(|mid| Some(mid.to_string())).map_err(|e| format!("{e:?}")),
        "separate_audio" => h.separate_audio_to_new_track(u, resolve_id(refs, cmd["layer"].as_str().unwrap())).await
            .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}")),
```
  - Add the `media_item` helper after `default_text_params`:
```rust
/// Byte-identical twin of the TS mediaItemTemplate. Fixed defaults for every
/// field bar id/kind/duration_us; path uses forward slashes for stable PathBuf
/// serialization; imported_at is a fixed instant (the TS literal must match its
/// serialized form — see the regen step).
fn media_item(cmd: &Value) -> state::media::MediaItem {
    use state::media::{MediaItem, MediaKind, MediaMetadata};
    let kind = match cmd["kind"].as_str().unwrap() {
        "Video" => MediaKind::Video, "Audio" => MediaKind::Audio, "Image" => MediaKind::Image,
        other => panic!("bad media kind {other}"),
    };
    MediaItem {
        id: uuid::Uuid::parse_str(cmd["id"].as_str().unwrap()).unwrap(),
        label: None, path_abs: "media/clip.bin".into(), path_rel: None, kind,
        metadata: MediaMetadata { duration_us: cmd["duration_us"].as_i64(), video: None, audio: None, container_format: None },
        proxy_path: None, proxy_format_version: 0, quick_proxy_path: None,
        proxy_bypassed: false, export_uses_original: false, waveform_path: None,
        conform_path: None, thumbnails_dir: None,
        file_hash_blake3: "0".into(), file_size: 0, file_mtime: 0,
        imported_at: chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap().with_timezone(&chrono::Utc),
    }
}
```
> If `chrono` is not already a direct dependency of the `replay_driver` bin's crate features, it is — `MediaItem.imported_at: DateTime<Utc>` comes from `chrono` in `native`. If the path `chrono::DateTime` does not resolve in the bin, use `state::media::...`'s re-export or `weftcut_lib::...`; the simplest robust form is `"2026-01-01T00:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap()`.

- [ ] **Step 3: Author the corpus sequences** under `fixtures/state-corpus/sequences/`. Media ids are literals (`…00aa` etc.); `add_media` carries `{id, kind, duration_us}` and a `ref`; `add_layer` media kinds reference the media via `@ref`. Times on the default 30fps grid.

`add-media-item.json` (pool insert; trailing add_layer gates the single broadcast burn)
```json
{ "name": "add-media-item", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M1" },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" }
] }
```
`add-video-layer.json`
```json
{ "name": "add-video-layer", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M1", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L1" }
] }
```
`add-audio-layer.json`
```json
{ "name": "add-audio-layer", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000bb", "kind": "Audio", "duration_us": 3000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "audio", "media": "@M1", "src_in_us": 0, "src_out_us": 3000000, "t_start_us": 0, "t_end_us": 3000000, "ref": "L1" }
] }
```
`add-image-layer.json` (Image media has no declared duration; only the media-ref rule applies)
```json
{ "name": "add-image-layer", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000cc", "kind": "Image", "duration_us": null, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "image", "media": "@M1", "t_start_us": 0, "t_end_us": 3000000, "ref": "L1" }
] }
```
`add-media-layer-missing-media.json` (media NOT in pool → ValidationFailed(MissingMedia); trailing add_layer shows the layer-id burn on validate-fail)
```json
{ "name": "add-media-layer-missing-media", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "00000000-0000-0000-0000-0000000000aa", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000 },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" }
] }
```
`add-media-layer-src-exceeds.json` (src_out 5M > media 2M → SrcRangeExceedsMedia)
```json
{ "name": "add-media-layer-src-exceeds", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 2000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M1", "src_in_us": 0, "src_out_us": 5000000, "t_start_us": 0, "t_end_us": 5000000 }
] }
```
`add-media-survives-undo.json` (★ pool durable across an undo of an unrelated edit)
```json
{ "name": "add-media-survives-undo", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "undo" }
] }
```
`add-video-layer-undo.json`
```json
{ "name": "add-video-layer-undo", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M1", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L1" },
  { "op": "undo" }
] }
```
`separate-audio.json` (lift audio off @A onto a new track inserted before it)
```json
{ "name": "separate-audio", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000bb", "kind": "Audio", "duration_us": 3000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "audio", "media": "@M1", "src_in_us": 0, "src_out_us": 3000000, "t_start_us": 0, "t_end_us": 3000000, "ref": "L1" },
  { "op": "separate_audio", "layer": "@L1", "ref": "T1" }
] }
```
`separate-audio-wrong-kind.json` (★ WrongLayerKind on a color layer; trailing add_layer's id unshifted → no burn)
```json
{ "name": "separate-audio-wrong-kind", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "separate_audio", "layer": "@L1" },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L2" }
] }
```
`separate-audio-missing.json` (LayerNotFound)
```json
{ "name": "separate-audio-missing", "commands": [
  { "op": "separate_audio", "layer": "00000000-0000-0000-0000-000000000000" }
] }
```

- [ ] **Step 4: Regenerate oracles + reconcile `imported_at`.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the ~11 new oracle files as ?? — no M on the 116 existing
```
Open any new oracle that contains a media item (e.g. `oracle/add-media-item.json`) and read the serialized `imported_at` string in `media_pool`. If it is NOT exactly `"2026-01-01T00:00:00Z"`, update `mediaItemTemplate`'s `imported_at` literal in `mutations/media.ts` to match it verbatim (the Rust `DateTime<Utc>` serde form is truth). Re-run the gate after any such edit.

- [ ] **Step 5: Run the gate.**
```bash
npx vitest run src/main/state/__tests__/differential.phase2.test.ts
```
Expected: PASS at **127** sequences (116 + 11), `skipped === []`. If a sequence diverges, debug the TS path against the cited Rust; do NOT edit the oracle/gate — the regenerated oracle is the truth. (Most likely first failure: an `imported_at` or `MediaMetadata` field mismatch → fix `mediaItemTemplate`. A separate-audio track-shape mismatch → check the insert index / track defaults.)

- [ ] **Step 6: Update the corpus README.** In `fixtures/state-corpus/README.md`: delete the `### 1. Media-bearing layers` gap section and its "Media-bearing layers — deferred" DEFERRED row; add a coverage block:
```markdown
| **— media pool + media-bearing layers —** | |
| add_media (pool insert, unrecorded) | add-media-item.json |
| add_layer video / audio / image | add-video-layer.json, add-audio-layer.json, add-image-layer.json |
| add_layer media missing from pool → ValidationFailed(MissingMedia) (burns layer id) | add-media-layer-missing-media.json |
| add_layer src_out > media duration → SrcRangeExceedsMedia | add-media-layer-src-exceeds.json |
| add_media pool survives undo (replace-everywhere) | add-media-survives-undo.json |
| add_layer video undo | add-video-layer-undo.json |
| **— separate audio —** | |
| separate_audio (audio layer → new track before source) | separate-audio.json |
| separate_audio on non-audio → WrongLayerKind (no id burned) | separate-audio-wrong-kind.json |
| separate_audio missing layer → LayerNotFound | separate-audio-missing.json |
```
Delete the `### 1. Media-bearing layers` gap section only (the params half of gap #5 is closed later, in Task 8). Renumber the remaining "Known gaps" headings.

- [ ] **Step 7: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/src/main/state/mutations/media.ts apps/desktop/fixtures/state-corpus/README.md \
  apps/desktop/fixtures/state-corpus/sequences/add-media-item.json apps/desktop/fixtures/state-corpus/sequences/add-video-layer.json apps/desktop/fixtures/state-corpus/sequences/add-audio-layer.json apps/desktop/fixtures/state-corpus/sequences/add-image-layer.json apps/desktop/fixtures/state-corpus/sequences/add-media-layer-missing-media.json apps/desktop/fixtures/state-corpus/sequences/add-media-layer-src-exceeds.json apps/desktop/fixtures/state-corpus/sequences/add-media-survives-undo.json apps/desktop/fixtures/state-corpus/sequences/add-video-layer-undo.json apps/desktop/fixtures/state-corpus/sequences/separate-audio.json apps/desktop/fixtures/state-corpus/sequences/separate-audio-wrong-kind.json apps/desktop/fixtures/state-corpus/sequences/separate-audio-missing.json \
  apps/desktop/fixtures/state-corpus/oracle/add-media-item.json apps/desktop/fixtures/state-corpus/oracle/add-video-layer.json apps/desktop/fixtures/state-corpus/oracle/add-audio-layer.json apps/desktop/fixtures/state-corpus/oracle/add-image-layer.json apps/desktop/fixtures/state-corpus/oracle/add-media-layer-missing-media.json apps/desktop/fixtures/state-corpus/oracle/add-media-layer-src-exceeds.json apps/desktop/fixtures/state-corpus/oracle/add-media-survives-undo.json apps/desktop/fixtures/state-corpus/oracle/add-video-layer-undo.json apps/desktop/fixtures/state-corpus/oracle/separate-audio.json apps/desktop/fixtures/state-corpus/oracle/separate-audio-wrong-kind.json apps/desktop/fixtures/state-corpus/oracle/separate-audio-missing.json
git commit -m "test(state-migration): media pool + media layers + separate_audio live + corpus (Phase 2b-v)"
```

---

## Task 5: params — `LayerParamsPatch` + `applyParamsPatch` + `applyUpdateLayerParams` (`mutations/params.ts`)

**Files:**
- Create: `src/main/state/mutations/params.ts`
- Test: `src/main/state/mutations/params.test.ts`

**Interfaces:**
- Produces:
  - `LayerParamsPatch` — internally-tagged TS union mirroring the 6 Rust `*Patch` structs (every field optional bar `kind`).
  - `applyParamsPatch(layer: Layer, patch: LayerParamsPatch): void` — kind-matched field merge; mismatch → `LayerParamsKindMismatch{layer,actual,patch}`. Animated fields wrap as `{mode:'Static',value}`; Motif `props` merge field-wise.
  - `applyUpdateLayerParams(p: Project, id: Uuid, patch: LayerParamsPatch): void` — `checkTrackLock` (LayerNotFound/TrackLocked) → `locateLayer` → `applyParamsPatch`. (Motif content-window clamp SCOPED OUT; no autofit on any non-Motif path.)
- Consumes: `checkTrackLock`/`locateLayer` from `./helpers`; `CommandFailure` from `../errors`; the param interfaces + `Animated`/`AudioRole`/`Rgba`/`Layer`/`Project`/`Uuid` from `../model`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/mutations/params.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type MotifParams, type Project } from '../model'
import { applyAddLayer, colorParams, textParamsDefault } from './add'
import { videoClipParams, audioParams } from './media'
import { isCommandFailure } from '../errors'
import { applyParamsPatch, applyUpdateLayerParams, type LayerParamsPatch } from './params'

const MID = '00000000-0000-0000-0000-0000000000aa'
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function layerOf(p: Project, id: string): Layer {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error('not found')
}

describe('applyUpdateLayerParams (field merge)', () => {
  it('Text patch sets content/opacity/x (animated fields → Static)', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[1].id, textParamsDefault('hi'), 0, 1_000_000)
    applyUpdateLayerParams(p, id, { kind: 'Text', content: 'world', opacity: 0.5, x: 10 })
    const t = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Text' }>
    expect([t.content, t.opacity, t.transform.x]).toEqual(['world', { mode: 'Static', value: 0.5 }, { mode: 'Static', value: 10 }])
  })
  it('Color patch sets color + width', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 100, 100), 0, 1_000_000)
    applyUpdateLayerParams(p, id, { kind: 'Color', color: { r: 1, g: 2, b: 3, a: 255 }, width: 640 })
    const c = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Color' }>
    expect([c.color, c.width, c.height]).toEqual([{ mode: 'Static', value: { r: 1, g: 2, b: 3, a: 255 } }, 640, 100])
  })
  it('VideoClip patch sets src range + scale + speed + flip', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, videoClipParams(MID, 0, 4_000_000), 0, 4_000_000)
    applyUpdateLayerParams(p, id, { kind: 'VideoClip', src_in_us: 500_000, src_out_us: 3_000_000, scale_x: 2, speed: 1.5, flip_h: true })
    const v = layerOf(p, id).params as Extract<Layer['params'], { kind: 'VideoClip' }>
    expect([v.src_in_us, v.src_out_us, v.transform.scale_x, v.speed, v.flip_h]).toEqual([500_000, 3_000_000, { mode: 'Static', value: 2 }, 1.5, true])
  })
  it('Audio patch sets gain/mute/role', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, audioParams(MID, 0, 3_000_000), 0, 3_000_000)
    applyUpdateLayerParams(p, id, { kind: 'Audio', gain_db: -6, mute: true, role: 'dialogue' })
    const a = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Audio' }>
    expect([a.gain_db, a.mute, a.role]).toEqual([{ mode: 'Static', value: -6 }, true, 'dialogue'])
  })
  it('Motif patch merges props field-wise (does not replace the map)', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const motif: MotifParams = { kind: 'Motif', motif_id: 'm', motif_version: 1, props: { a: 1, b: 2 },
      src_in_us: 0, transform: textParamsDefaultTransform(), opacity: { mode: 'Static', value: 1 } }
    p.tracks[0].layers.push({ id: 'mo', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params: motif, effects: [] })
    applyUpdateLayerParams(p, 'mo', { kind: 'Motif', opacity: 0.3, props: { b: 9, c: 3 } })
    const m = layerOf(p, 'mo').params as MotifParams
    expect([m.props, m.opacity]).toEqual([{ a: 1, b: 9, c: 3 }, { mode: 'Static', value: 0.3 }])
  })
  it('kind mismatch → LayerParamsKindMismatch', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 10, 10), 0, 1_000_000)
    expectCmd(() => applyUpdateLayerParams(p, id, { kind: 'Text', content: 'x' }), 'LayerParamsKindMismatch')
  })
  it('locked track → TrackLocked; missing layer → LayerNotFound', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 10, 10), 0, 1_000_000)
    p.tracks[0].locked = true
    expectCmd(() => applyUpdateLayerParams(p, id, { kind: 'Color', width: 1 }), 'TrackLocked')
    expectCmd(() => applyUpdateLayerParams(p, 'ghost', { kind: 'Color', width: 1 }), 'LayerNotFound')
  })
})

// local helper for the hand-built Motif layer (mirrors add.ts defaultTransform)
function textParamsDefaultTransform() {
  const s = (v: number) => ({ mode: 'Static' as const, value: v })
  return { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor: [0.5, 0.5] as [number, number] }
}
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/params.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`src/main/state/mutations/params.ts`):

```ts
import type { Animated, AudioParams, AudioRole, ColorParams, ImageOverlayParams, Layer, MotifParams, Project, Rgba, TextParams, Uuid, VideoClipParams } from '../model'
import { CommandFailure } from '../errors'
import { checkTrackLock, locateLayer } from './helpers'

/** native/src/state/actor.rs:99-255 — internally-tagged ("kind") param patch.
 *  Every field optional bar kind; absent = "don't touch". */
export type LayerParamsPatch =
  | { kind: 'Text'; content?: string; font_family?: string; font_size_px?: number; color?: Rgba; x?: number; y?: number; opacity?: number }
  | { kind: 'VideoClip'; src_in_us?: number; src_out_us?: number; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; speed?: number; flip_h?: boolean; flip_v?: boolean; fade_in_us?: number; fade_out_us?: number }
  | { kind: 'ImageOverlay'; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; fade_in_us?: number; fade_out_us?: number }
  | { kind: 'Motif'; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; src_in_us?: number; motif_id?: string; motif_version?: number; props?: Record<string, unknown> }
  | { kind: 'Color'; color?: Rgba; width?: number; height?: number }
  | { kind: 'Audio'; src_in_us?: number; src_out_us?: number; gain_db?: number; pan?: number; fade_in_us?: number; fade_out_us?: number; mute?: boolean; role?: AudioRole }

const stat = <T>(value: T): Animated<T> => ({ mode: 'Static', value })

/** mutations.rs:1232 apply_params_patch — kind-matched field merge; a discriminant
 *  mismatch is the only error. Animated fields collapse to Static(v) (MVP: this
 *  overwrites any keyframe track). Motif props merge field-wise (never replace). */
export function applyParamsPatch(layer: Layer, patch: LayerParamsPatch): void {
  const p = layer.params
  if (p.kind !== patch.kind) {
    throw new CommandFailure({ error: 'LayerParamsKindMismatch', layer: layer.id, actual: p.kind, patch: patch.kind })
  }
  switch (patch.kind) {
    case 'Text': {
      const t = p as TextParams
      if (patch.content !== undefined) t.content = patch.content
      if (patch.font_family !== undefined) t.font.family = patch.font_family
      if (patch.font_size_px !== undefined) t.font.size_px = patch.font_size_px
      if (patch.color !== undefined) t.color = stat(patch.color)
      if (patch.x !== undefined) t.transform.x = stat(patch.x)
      if (patch.y !== undefined) t.transform.y = stat(patch.y)
      if (patch.opacity !== undefined) t.opacity = stat(patch.opacity)
      return
    }
    case 'VideoClip': {
      const v = p as VideoClipParams
      if (patch.src_in_us !== undefined) v.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) v.src_out_us = patch.src_out_us
      if (patch.x !== undefined) v.transform.x = stat(patch.x)
      if (patch.y !== undefined) v.transform.y = stat(patch.y)
      if (patch.scale_x !== undefined) v.transform.scale_x = stat(patch.scale_x)
      if (patch.scale_y !== undefined) v.transform.scale_y = stat(patch.scale_y)
      if (patch.opacity !== undefined) v.opacity = stat(patch.opacity)
      if (patch.speed !== undefined) v.speed = patch.speed
      if (patch.flip_h !== undefined) v.flip_h = patch.flip_h
      if (patch.flip_v !== undefined) v.flip_v = patch.flip_v
      if (patch.fade_in_us !== undefined) v.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) v.fade_out_us = patch.fade_out_us
      return
    }
    case 'ImageOverlay': {
      const i = p as ImageOverlayParams
      if (patch.x !== undefined) i.transform.x = stat(patch.x)
      if (patch.y !== undefined) i.transform.y = stat(patch.y)
      if (patch.scale_x !== undefined) i.transform.scale_x = stat(patch.scale_x)
      if (patch.scale_y !== undefined) i.transform.scale_y = stat(patch.scale_y)
      if (patch.opacity !== undefined) i.opacity = stat(patch.opacity)
      if (patch.fade_in_us !== undefined) i.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) i.fade_out_us = patch.fade_out_us
      return
    }
    case 'Motif': {
      const m = p as MotifParams
      if (patch.x !== undefined) m.transform.x = stat(patch.x)
      if (patch.y !== undefined) m.transform.y = stat(patch.y)
      if (patch.scale_x !== undefined) m.transform.scale_x = stat(patch.scale_x)
      if (patch.scale_y !== undefined) m.transform.scale_y = stat(patch.scale_y)
      if (patch.opacity !== undefined) m.opacity = stat(patch.opacity)
      if (patch.src_in_us !== undefined) m.src_in_us = patch.src_in_us
      if (patch.motif_id !== undefined) m.motif_id = patch.motif_id
      if (patch.motif_version !== undefined) m.motif_version = patch.motif_version
      if (patch.props !== undefined) for (const k of Object.keys(patch.props)) m.props[k] = patch.props[k]
      return
    }
    case 'Color': {
      const c = p as ColorParams
      if (patch.color !== undefined) c.color = stat(patch.color)
      if (patch.width !== undefined) c.width = patch.width
      if (patch.height !== undefined) c.height = patch.height
      return
    }
    case 'Audio': {
      const au = p as AudioParams
      if (patch.src_in_us !== undefined) au.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) au.src_out_us = patch.src_out_us
      if (patch.gain_db !== undefined) au.gain_db = stat(patch.gain_db)
      if (patch.pan !== undefined) au.pan = stat(patch.pan)
      if (patch.fade_in_us !== undefined) au.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) au.fade_out_us = patch.fade_out_us
      if (patch.mute !== undefined) au.mute = patch.mute
      if (patch.role !== undefined) au.role = patch.role
      return
    }
  }
}

/** actor.rs:2734 do_update_layer_params (mutation half): lock-check, locate,
 *  field-merge. The Motif content-window clamp + autofit (mutations.rs:391-453)
 *  is SCOPED OUT — it needs the motif catalog (motif_cap_us) the TS actor lacks,
 *  and the corpus has no Motif layers; it is the ONLY autofit trigger, so every
 *  non-Motif params edit leaves geometry (and composition duration) unchanged. */
export function applyUpdateLayerParams(p: Project, id: Uuid, patch: LayerParamsPatch): void {
  checkTrackLock(p, id) // LayerNotFound / TrackLocked
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  applyParamsPatch(p.tracks[loc[0]].layers[loc[1]], patch)
}
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run src/main/state/mutations/params.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/params.ts apps/desktop/src/main/state/mutations/params.test.ts
git commit -m "feat(state-migration): update_layer_params field-merge port (Phase 2b-v)"
```

---

## Task 6: params — keyframe param-track write (`normalizeKeyframes` + resolver + `applyUpdateLayerParamTrack`)

**Files:**
- Modify: `src/main/state/mutations/animated.ts` (+ test)
- Modify: `src/main/state/mutations/params.ts` (+ params.test.ts)

**Interfaces:**
- Produces:
  - `normalizeKeyframes<T>(a: Animated<T>, snap: (t: number) => number): boolean` (animated.ts) — snap+stable-sort+dedupe-last; `false` for empty `Keyframed`; `true` for `Static`/non-empty.
  - `parseEffectParamKey(key: string): [Uuid, string] | null` (params.ts).
  - `applyUpdateLayerParamTrack(p: Project, id: Uuid, paramKey: string, track: Animated<number>): void` (params.ts) — lock-check → normalize (EmptyKeyframeTrack) → locate → resolve-or-lazy-insert (UnknownKeyframeParam) → assign; NO autofit.
- Consumes: `Keyframe` from `../model`; `snapFrameRound` from `../snap`; `checkTrackLock`/`locateLayer` from `./helpers`.

- [ ] **Step 1: Write the failing `normalizeKeyframes` test** in `src/main/state/mutations/animated.test.ts`:

```ts
import { normalizeKeyframes } from './animated'

describe('normalizeKeyframes', () => {
  const id = (n: number) => `00000000-0000-0000-0000-0000000000${n.toString(16).padStart(2, '0')}`
  const kf = (n: number, t: number, v: number) => ({ id: id(n), t_us: t, value: v, interp: { kind: 'Linear' as const } })
  const snap30 = (t: number) => Math.round(t / (1_000_000 / 30)) * (1_000_000 / 30) // illustrative; impl uses snapFrameRound
  it('Static is unchanged and returns true', () => {
    const a = { mode: 'Static' as const, value: 5 }
    expect(normalizeKeyframes(a, (t) => t)).toBe(true)
    expect(a).toEqual({ mode: 'Static', value: 5 })
  })
  it('empty Keyframed returns false', () => {
    expect(normalizeKeyframes({ mode: 'Keyframed' as const, value: [] }, (t) => t)).toBe(false)
  })
  it('snaps + stable-sorts + dedupes same-snapped-time keeping the last', () => {
    const a = { mode: 'Keyframed' as const, value: [kf(2, 2_000_000, 20), kf(1, 0, 10), kf(3, 10, 99)] }
    // snap-to-0 collapses kf1(t=0) and kf3(t=10→0); stable order keeps kf3 (last in input among equal times)
    expect(normalizeKeyframes(a, (t) => (t < 1_000_000 ? 0 : t))).toBe(true)
    expect(a.value.map((k) => [k.t_us, k.value])).toEqual([[0, 99], [2_000_000, 20]])
  })
})
```

- [ ] **Step 2: Implement `normalizeKeyframes`** in `animated.ts` (after `collapseToStatic`):
```ts
import type { Animated, Keyframe, LayerParams, Rgba } from '../model'   // add Keyframe if not already imported
```
```ts
/** native/src/state/animated.rs:118 — canonicalize a Keyframed track: snap each
 *  t_us, stable-sort by t_us, dedupe same-snapped-time KEEPING THE LAST (JS
 *  Array.sort is stable on Node 22; the write path appends the edited key last →
 *  last-write-wins on a collision). Returns false for an EMPTY Keyframed track
 *  (→ EmptyKeyframeTrack); Static is unchanged and always true. */
export function normalizeKeyframes<T>(a: Animated<T>, snap: (t: number) => number): boolean {
  if (a.mode !== 'Keyframed') return true
  const kfs = a.value as Keyframe<T>[]
  if (kfs.length === 0) return false
  const snapped = kfs.map((k) => ({ ...k, t_us: snap(k.t_us) }))
  snapped.sort((x, y) => x.t_us - y.t_us)
  const out: Keyframe<T>[] = []
  for (const k of snapped) {
    const last = out[out.length - 1]
    if (last && last.t_us === k.t_us) out[out.length - 1] = k
    else out.push(k)
  }
  a.value = out
  return true
}
```

- [ ] **Step 3: Run** — `npx vitest run src/main/state/mutations/animated.test.ts` → PASS.

- [ ] **Step 4: Add failing param-track tests** to `src/main/state/mutations/params.test.ts`:
```ts
import { applyUpdateLayerParamTrack } from './params'

describe('applyUpdateLayerParamTrack', () => {
  const kfTrack = () => ({ mode: 'Keyframed' as const, value: [
    { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 0, interp: { kind: 'Linear' as const } },
    { id: '00000000-0000-0000-0000-0000000000f2', t_us: 1_000_000, value: 1, interp: { kind: 'Linear' as const } },
  ] })
  function textLayer(): { p: Project; id: string } {
    const g = seededGen(); const p = blankProject(g, 'kf')
    const id = applyAddLayer(p, g, p.tracks[1].id, textParamsDefault('t'), 0, 2_000_000)
    return { p, id }
  }
  it('writes a keyframed track to opacity', () => {
    const { p, id } = textLayer()
    applyUpdateLayerParamTrack(p, id, 'opacity', kfTrack())
    const t = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Text' }>
    expect(t.opacity.mode).toBe('Keyframed')
    expect((t.opacity.value as { t_us: number }[]).map((k) => k.t_us)).toEqual([0, 1_000_000])
  })
  it('empty Keyframed track → EmptyKeyframeTrack', () => {
    const { p, id } = textLayer()
    expectCmd(() => applyUpdateLayerParamTrack(p, id, 'opacity', { mode: 'Keyframed', value: [] }), 'EmptyKeyframeTrack')
  })
  it('unknown param key → UnknownKeyframeParam', () => {
    const { p, id } = textLayer()
    expectCmd(() => applyUpdateLayerParamTrack(p, id, 'bogus', kfTrack()), 'UnknownKeyframeParam')
  })
  it('effect-param path lazily inserts the slot for an existing effect, then writes', () => {
    const { p, id } = textLayer()
    const layer = layerOf(p, id)
    layer.effects.push({ id: '00000000-0000-0000-0000-0000000000e1', kind: 'blur', enabled: true, params: {} })
    applyUpdateLayerParamTrack(p, id, 'effects[00000000-0000-0000-0000-0000000000e1].params[intensity]', kfTrack())
    expect(layerOf(p, id).effects[0].params.intensity.mode).toBe('Keyframed')
  })
  it('locked track → TrackLocked (checked before normalize)', () => {
    const { p, id } = textLayer()
    p.tracks[1].locked = true
    expectCmd(() => applyUpdateLayerParamTrack(p, id, 'opacity', { mode: 'Keyframed', value: [] }), 'TrackLocked')
  })
})
```

- [ ] **Step 5: Run to verify they fail** — `npx vitest run src/main/state/mutations/params.test.ts` → FAIL (function missing).

- [ ] **Step 6: Implement** in `params.ts` — add the import and the functions (after `applyUpdateLayerParams`):
```ts
import { snapFrameRound } from '../snap'
import { normalizeKeyframes } from './animated'
```
```ts
/** native/src/state/layer.rs:358 — parse "effects[<uuid>].params[<key>]" →
 *  [effectId, paramKey]; null otherwise. (A non-UUID id still parses here but the
 *  subsequent effect lookup fails → resolves to null, matching the Rust outcome.) */
export function parseEffectParamKey(key: string): [Uuid, string] | null {
  const m = /^effects\[([^\]]+)\]\.params\[(.+)\]$/.exec(key)
  return m ? [m[1], m[2]] : null
}

const TRANSFORM_F64_KEYS = ['x', 'y', 'scale_x', 'scale_y', 'rotation_deg']

/** layer.rs:322/377 — resolve a param-key to a setter for its Animated<f64> slot,
 *  or null if the key is unknown / invalid on this kind. Effect-param paths look
 *  in layer.effects (and require the param slot to already exist). */
function f64Lens(layer: Layer, key: string): { set(v: Animated<number>): void } | null {
  const eff = parseEffectParamKey(key)
  if (eff) {
    const e = layer.effects.find((x) => x.id === eff[0])
    if (!e || !(eff[1] in e.params)) return null
    return { set: (v) => { e.params[eff[1]] = v } }
  }
  const p = layer.params
  if (p.kind === 'Color') return null
  if (p.kind === 'Audio') {
    if (key === 'gain_db') return { set: (v) => { p.gain_db = v } }
    if (key === 'pan') return { set: (v) => { p.pan = v } }
    return null
  }
  // VideoClip | ImageOverlay | Text | Motif — transform + opacity
  if (key === 'opacity') return { set: (v) => { p.opacity = v } }
  if (TRANSFORM_F64_KEYS.includes(key)) return { set: (v) => { (p.transform as unknown as Record<string, Animated<number>>)[key] = v } }
  return null
}

/** actor.rs:2752 do_update_layer_param_track (mutation half): lock-check →
 *  normalize (EmptyKeyframeTrack on empty) → locate → resolve, lazily inserting
 *  Static(0) for a missing slot of an EXISTING effect → re-resolve
 *  (UnknownKeyframeParam) → assign. NO autofit (a keyframe write never moves
 *  t_start/t_end). Keyframe param-tracks are Animated<f64> only. */
export function applyUpdateLayerParamTrack(p: Project, id: Uuid, paramKey: string, track: Animated<number>): void {
  checkTrackLock(p, id) // LayerNotFound / TrackLocked — BEFORE normalize
  const fps = p.composition.fps
  if (!normalizeKeyframes(track, (t) => snapFrameRound(t, fps.num, fps.den))) {
    throw new CommandFailure({ error: 'EmptyKeyframeTrack', layer: id, param_key: paramKey })
  }
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = p.tracks[loc[0]].layers[loc[1]]
  if (f64Lens(layer, paramKey) === null) {
    const eff = parseEffectParamKey(paramKey)
    if (eff) {
      const e = layer.effects.find((x) => x.id === eff[0])
      if (e && !(eff[1] in e.params)) e.params[eff[1]] = { mode: 'Static', value: 0 }
    }
  }
  const lens = f64Lens(layer, paramKey)
  if (!lens) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: paramKey })
  lens.set(track)
}
```

- [ ] **Step 7: Run to verify they pass** — `npx vitest run src/main/state/mutations/params.test.ts src/main/state/mutations/animated.test.ts` → PASS.

- [ ] **Step 8: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/animated.ts apps/desktop/src/main/state/mutations/animated.test.ts apps/desktop/src/main/state/mutations/params.ts apps/desktop/src/main/state/mutations/params.test.ts
git commit -m "feat(state-migration): keyframe param-track write (normalize + resolver + lazy effect-param) (Phase 2b-v)"
```

---

## Task 7: params — actor dispatch arms

**Files:**
- Modify: `src/main/state/actor.ts`
- Test: `src/main/state/actor.test.ts`

**Interfaces:**
- Consumes: `applyUpdateLayerParams`/`applyUpdateLayerParamTrack`/`LayerParamsPatch` from `./mutations/params`; `Animated` from `./model`.
- Produces: dispatch arms `update_layer_params`, `update_layer_param_track`, `update_layer_param_tracks` (all recorded; `update_layer_param_tracks` loops under ONE commit).

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts`:
```ts
describe('dispatch: params', () => {
  function textActor() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'pp')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const id = (actor.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'text', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    return { actor, id }
  }
  it('update_layer_params merges fields (recorded; undoable)', () => {
    const { actor, id } = textActor()
    const before = JSON.stringify(actor.snapshot())
    expect(actor.dispatch('update_layer_params', { layer: id, patch: { kind: 'Text', opacity: 0.25, content: 'z' } }).ok).toBe(true)
    const t = actor.snapshot().tracks[1].layers[0].params as Extract<ReturnType<typeof actor.snapshot>['tracks'][0]['layers'][0]['params'], { kind: 'Text' }>
    expect([t.opacity, t.content]).toEqual([{ mode: 'Static', value: 0.25 }, 'z'])
    expect(actor.dispatch('undo').ok).toBe(true)
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
  it('update_layer_params kind mismatch → LayerParamsKindMismatch', () => {
    const { actor, id } = textActor()
    const r = actor.dispatch('update_layer_params', { layer: id, patch: { kind: 'Color', width: 1 } })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerParamsKindMismatch')
  })
  it('update_layer_param_track writes opacity keyframes', () => {
    const { actor, id } = textActor()
    const track = { mode: 'Keyframed', value: [
      { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 0, interp: { kind: 'Linear' } },
      { id: '00000000-0000-0000-0000-0000000000f2', t_us: 1_000_000, value: 1, interp: { kind: 'Linear' } }] }
    expect(actor.dispatch('update_layer_param_track', { layer: id, param_key: 'opacity', track }).ok).toBe(true)
    expect((actor.snapshot().tracks[1].layers[0].params as { opacity: { mode: string } }).opacity.mode).toBe('Keyframed')
  })
  it('update_layer_param_tracks applies a batch in one commit (one undo reverts all)', () => {
    const { actor, id } = textActor()
    const before = JSON.stringify(actor.snapshot())
    const kf = (v: number) => ({ mode: 'Keyframed', value: [{ id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: v, interp: { kind: 'Linear' } }, { id: '00000000-0000-0000-0000-0000000000f2', t_us: 1_000_000, value: v, interp: { kind: 'Linear' } }] })
    expect(actor.dispatch('update_layer_param_tracks', { layer: id, entries: [['x', kf(0)], ['opacity', kf(1)]] }).ok).toBe(true)
    expect(actor.dispatch('undo').ok).toBe(true) // single commit → one undo
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Add the import (after the media import):
```ts
import { applyUpdateLayerParams, applyUpdateLayerParamTrack, type LayerParamsPatch } from './mutations/params'
```
> `Animated` is needed for the track-arg cast — add it to the existing `./model` type import on line 3 (`import type { ..., Animated, ... } from './model'`).

Add three dispatch arms (after the `update_layer` arm, ~line 241):
```ts
        case 'update_layer_params': commit('Updated layer params', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayerParams(d, a.layer as Uuid, a.patch as LayerParamsPatch)); return { ok: true, value: null }
        case 'update_layer_param_track': commit('Keyframed layer param', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayerParamTrack(d, a.layer as Uuid, a.param_key as string, a.track as Animated<number>)); return { ok: true, value: null }
        case 'update_layer_param_tracks': commit('Keyframed layer params', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => { for (const [k, t] of a.entries as [string, Animated<number>][]) applyUpdateLayerParamTrack(d, a.layer as Uuid, k, t) }); return { ok: true, value: null }
```

- [ ] **Step 4: Run to verify all pass** — `npx vitest run src/main/state/actor.test.ts` → PASS. Then `npx vitest run src/main/state/__tests__/differential.phase2.test.ts` → still 127/127 (media corpus from Task 4; no params corpus yet).

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): actor update_layer_params/param_track/param_tracks dispatch (Phase 2b-v)"
```

---

## Task 8: params — driver + vocabulary + corpus + regen + gate

**Files:**
- Modify: `src/main/state/replay.ts`, `native/src/bin/replay_driver.rs`, `fixtures/state-corpus/{sequences,oracle}/`, `fixtures/state-corpus/README.md`

**Interfaces:**
- Consumes: the Task-7 dispatch arms; the handle methods `update_layer_params`/`update_layer_param_track`/`update_layer_param_tracks`.
- Produces: `SUPPORTED_OPS` += the three params ops; `buildArgs` cases; the driver's three params arms (deserializing `LayerParamsPatch` / `Animated<f64>` / `Vec<(String, Animated<f64>)>` directly via serde); ~14 corpus sequences + regenerated oracles.

- [ ] **Step 1: Wire `replay.ts`.** Add `'update_layer_params', 'update_layer_param_track', 'update_layer_param_tracks'` to `SUPPORTED_OPS`; add `buildArgs` cases (before `undo`/`redo`):
```ts
    case 'update_layer_params': return { layer: resolve(refs, cmd.layer), patch: cmd.patch }
    case 'update_layer_param_track': return { layer: resolve(refs, cmd.layer), param_key: resolveParamKey(refs, cmd.param_key as string), track: cmd.track }
    case 'update_layer_param_tracks': return { layer: resolve(refs, cmd.layer), entries: cmd.entries }
```
Add the param-key ref-substitution helper (near `resolve`), so an effect-param key may embed a captured effect ref `effects[@E1].params[<k>]`:
```ts
/** Substitute a single @ref token inside an effect-param key string. */
function resolveParamKey(refs: Map<string, string>, key: string): string {
  return key.replace(/@([A-Za-z0-9_]+)/, (_, r) => refs.get(r) ?? r)
}
```

- [ ] **Step 2: Add the driver arms** in `native/src/bin/replay_driver.rs` (before the `other =>` arm). Add a `resolve_param_key` helper (mirrors the TS one) and the three arms. `LayerParamsPatch`/`MarkerPatch`/etc. are reachable via `weftcut_lib::state::actor::...`:
```rust
        "update_layer_params" => {
            let patch: weftcut_lib::state::actor::LayerParamsPatch =
                serde_json::from_value(cmd["patch"].clone()).map_err(|e| e.to_string())?;
            h.update_layer_params(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_layer_param_track" => {
            let track: Animated<f64> = serde_json::from_value(cmd["track"].clone()).map_err(|e| e.to_string())?;
            let key = resolve_param_key(refs, cmd["param_key"].as_str().unwrap());
            h.update_layer_param_track(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), key, track).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_layer_param_tracks" => {
            let entries: Vec<(String, Animated<f64>)> = serde_json::from_value(cmd["entries"].clone()).map_err(|e| e.to_string())?;
            h.update_layer_param_tracks(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), entries).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
```
Add the helper after `resolve_id`:
```rust
/// Substitute a single @ref token inside an effect-param key (mirrors the TS resolveParamKey).
fn resolve_param_key(refs: &HashMap<String, String>, key: &str) -> String {
    if let Some(at) = key.find('@') {
        let tail = &key[at + 1..];
        let end = tail.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(tail.len());
        let name = &tail[..end];
        if let Some(v) = refs.get(name) {
            return format!("{}{}{}", &key[..at], v, &tail[end..]);
        }
    }
    key.to_string()
}
```

- [ ] **Step 3: Author the corpus sequences** under `fixtures/state-corpus/sequences/`. Text layers go on `@B` (overlay track) or `@A`; media layers seed the pool first. Keyframe ids are literal (`…00f1`); interp is `{"kind":"Linear"}`. Times on the 30fps grid.

`update-layer-params-text.json`
```json
{ "name": "update-layer-params-text", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "Text", "content": "world", "opacity": 0.5, "x": 10 } }
] }
```
`update-layer-params-color.json`
```json
{ "name": "update-layer-params-color", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "Color", "color": { "r": 1, "g": 2, "b": 3, "a": 255 }, "width": 640 } }
] }
```
`update-layer-params-video.json`
```json
{ "name": "update-layer-params-video", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M1", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L1" },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "VideoClip", "src_in_us": 500000, "src_out_us": 3000000, "scale_x": 2, "speed": 1.5, "flip_h": true } }
] }
```
`update-layer-params-audio.json`
```json
{ "name": "update-layer-params-audio", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000bb", "kind": "Audio", "duration_us": 3000000, "ref": "M1" },
  { "op": "add_layer", "track": "@A", "kind": "audio", "media": "@M1", "src_in_us": 0, "src_out_us": 3000000, "t_start_us": 0, "t_end_us": 3000000, "ref": "L1" },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "Audio", "gain_db": -6, "mute": true, "role": "dialogue" } }
] }
```
`update-layer-params-kind-mismatch.json` (Text patch on a Color layer; trailing add_layer gates no-op_id-burn)
```json
{ "name": "update-layer-params-kind-mismatch", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "Text", "content": "x" } },
  { "op": "add_layer", "track": "@B", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L2" }
] }
```
`update-layer-params-locked.json` (lock the track first via the unrecorded flag setter)
```json
{ "name": "update-layer-params-locked", "commands": [
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L1" },
  { "op": "update_track_flags", "track": "@A", "locked": true },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "Color", "width": 1 } }
] }
```
`update-layer-params-missing.json`
```json
{ "name": "update-layer-params-missing", "commands": [
  { "op": "update_layer_params", "layer": "00000000-0000-0000-0000-000000000000", "patch": { "kind": "Color", "width": 1 } }
] }
```
`update-layer-params-undo.json`
```json
{ "name": "update-layer-params-undo", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_params", "layer": "@L1", "patch": { "kind": "Text", "opacity": 0.25 } },
  { "op": "undo" }
] }
```
`param-track-opacity.json`
```json
{ "name": "param-track-opacity", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_param_track", "layer": "@L1", "param_key": "opacity", "track": { "mode": "Keyframed", "value": [
    { "id": "00000000-0000-0000-0000-0000000000f1", "t_us": 0, "value": 0, "interp": { "kind": "Linear" } },
    { "id": "00000000-0000-0000-0000-0000000000f2", "t_us": 1000000, "value": 1, "interp": { "kind": "Linear" } } ] } }
] }
```
`param-track-empty.json` (empty Keyframed → EmptyKeyframeTrack; trailing add_layer gates no-op_id-burn)
```json
{ "name": "param-track-empty", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_param_track", "layer": "@L1", "param_key": "opacity", "track": { "mode": "Keyframed", "value": [] } },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L2" }
] }
```
`param-track-unknown.json` (bad key → UnknownKeyframeParam; trailing add_layer gates no-op_id-burn)
```json
{ "name": "param-track-unknown", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_param_track", "layer": "@L1", "param_key": "bogus", "track": { "mode": "Keyframed", "value": [
    { "id": "00000000-0000-0000-0000-0000000000f1", "t_us": 0, "value": 0, "interp": { "kind": "Linear" } } ] } },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000, "ref": "L2" }
] }
```
`param-track-effect.json` (★ lazy effect-param insert; the effect ref is substituted into the key string)
```json
{ "name": "param-track-effect", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "add_effect", "layer": "@L1", "kind": "blur", "ref": "E1" },
  { "op": "update_layer_param_track", "layer": "@L1", "param_key": "effects[@E1].params[intensity]", "track": { "mode": "Keyframed", "value": [
    { "id": "00000000-0000-0000-0000-0000000000f1", "t_us": 0, "value": 0, "interp": { "kind": "Linear" } },
    { "id": "00000000-0000-0000-0000-0000000000f2", "t_us": 1000000, "value": 1, "interp": { "kind": "Linear" } } ] } }
] }
```
`param-tracks-batch.json` (one commit; one undo reverts both tracks)
```json
{ "name": "param-tracks-batch", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_param_tracks", "layer": "@L1", "entries": [
    ["x", { "mode": "Keyframed", "value": [ { "id": "00000000-0000-0000-0000-0000000000f1", "t_us": 0, "value": 0, "interp": { "kind": "Linear" } }, { "id": "00000000-0000-0000-0000-0000000000f2", "t_us": 1000000, "value": 100, "interp": { "kind": "Linear" } } ] }],
    ["opacity", { "mode": "Keyframed", "value": [ { "id": "00000000-0000-0000-0000-0000000000f3", "t_us": 0, "value": 1, "interp": { "kind": "Linear" } }, { "id": "00000000-0000-0000-0000-0000000000f4", "t_us": 1000000, "value": 0, "interp": { "kind": "Linear" } } ] }] ] },
  { "op": "undo" }
] }
```
`param-track-undo.json`
```json
{ "name": "param-track-undo", "commands": [
  { "op": "add_layer", "track": "@B", "kind": "text", "t_start_us": 0, "t_end_us": 2000000, "ref": "L1" },
  { "op": "update_layer_param_track", "layer": "@L1", "param_key": "x", "track": { "mode": "Keyframed", "value": [
    { "id": "00000000-0000-0000-0000-0000000000f1", "t_us": 0, "value": 0, "interp": { "kind": "Linear" } },
    { "id": "00000000-0000-0000-0000-0000000000f2", "t_us": 1000000, "value": 50, "interp": { "kind": "Linear" } } ] } },
  { "op": "undo" }
] }
```

- [ ] **Step 4: Regenerate oracles + run the gate.**
```bash
node scripts/gen-state-oracle.mjs   # env vars per Global Constraints
git status --short fixtures/state-corpus/oracle/   # ONLY the new oracle files as ?? — no M on the now-127 existing
npx vitest run src/main/state/__tests__/differential.phase2.test.ts
```
Expected: PASS at **141** sequences (127 + 14), `skipped === []`. If `param-track-effect.json` diverges, the effect-id substitution likely produced a key the TS and Rust resolve differently — confirm both `resolveParamKey` helpers substitute identically and the regenerated oracle's effect id matches `@E1`'s captured id. Do NOT edit the oracle/gate.

- [ ] **Step 5: Update the corpus README** — add a params coverage block and close the params half of gap #5:
```markdown
| **— layer params (field merge) —** | |
| update_layer_params Text / Color / VideoClip / Audio | update-layer-params-text.json, update-layer-params-color.json, update-layer-params-video.json, update-layer-params-audio.json |
| update_layer_params kind mismatch → LayerParamsKindMismatch | update-layer-params-kind-mismatch.json |
| update_layer_params on a locked track → TrackLocked | update-layer-params-locked.json |
| update_layer_params missing layer → LayerNotFound | update-layer-params-missing.json |
| update_layer_params undo | update-layer-params-undo.json |
| **— keyframe param tracks —** | |
| update_layer_param_track opacity (keyframed) | param-track-opacity.json |
| update_layer_param_track empty → EmptyKeyframeTrack | param-track-empty.json |
| update_layer_param_track unknown key → UnknownKeyframeParam | param-track-unknown.json |
| update_layer_param_track effect-param (lazy slot insert) | param-track-effect.json |
| update_layer_param_tracks batch (one commit) | param-tracks-batch.json |
| update_layer_param_track undo | param-track-undo.json |
```
In "Known gaps", narrow the `### Caption tracks, params` section to **Caption tracks** only (params is now covered) and add a line under deferred: "Motif `update_layer_params` content-window clamp (motif_cap_us) — deferred (needs motif-catalog support in the harness; no Motif layers in the corpus)."

- [ ] **Step 6: Typecheck + commit.**
```bash
# npm run typecheck (clean) — stage the params replay/driver/README + the 14 sequence + 14 oracle files by explicit path
git add apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/README.md \
  apps/desktop/fixtures/state-corpus/sequences/update-layer-params-text.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-color.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-video.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-audio.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-kind-mismatch.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-locked.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-missing.json apps/desktop/fixtures/state-corpus/sequences/update-layer-params-undo.json apps/desktop/fixtures/state-corpus/sequences/param-track-opacity.json apps/desktop/fixtures/state-corpus/sequences/param-track-empty.json apps/desktop/fixtures/state-corpus/sequences/param-track-unknown.json apps/desktop/fixtures/state-corpus/sequences/param-track-effect.json apps/desktop/fixtures/state-corpus/sequences/param-tracks-batch.json apps/desktop/fixtures/state-corpus/sequences/param-track-undo.json \
  apps/desktop/fixtures/state-corpus/oracle/update-layer-params-text.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-color.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-video.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-audio.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-kind-mismatch.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-locked.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-missing.json apps/desktop/fixtures/state-corpus/oracle/update-layer-params-undo.json apps/desktop/fixtures/state-corpus/oracle/param-track-opacity.json apps/desktop/fixtures/state-corpus/oracle/param-track-empty.json apps/desktop/fixtures/state-corpus/oracle/param-track-unknown.json apps/desktop/fixtures/state-corpus/oracle/param-track-effect.json apps/desktop/fixtures/state-corpus/oracle/param-tracks-batch.json apps/desktop/fixtures/state-corpus/oracle/param-track-undo.json
git commit -m "test(state-migration): layer params + keyframe param-tracks live + corpus (Phase 2b-v)"
```

---

## Self-Review (run after the final task)

1. **Spec coverage.** Media: `add_media_item` (Tasks 1+3+4), media `add_layer` (Tasks 2+3+4), `separate_audio` (Tasks 2+3+4). Params: `update_layer_params` (Tasks 5+7+8), `update_layer_param_track`/`_tracks` (Tasks 6+7+8). The single scope-out (Motif content-window clamp) is documented in Task 5 + the README. Remaining roadmap: captions + role/settings/flags (2b-vi).
2. **id contract.** Media: add_media burns one (broadcast) + literal media id; separate_audio burns one (track) + one (op); media add_layer burns the layer id on validate-fail. Params: update_layer_params / update_layer_param_track burn one op_id on success / none on a pre-validate failure; update_layer_param_tracks burns ONE op_id for the batch. All gated by trailing-add_layer corpus seqs.
3. **No oracle/gate edits.** Divergences fixed in the TS port; the regenerated oracle is truth. TS literals tuned to the oracle: `mediaItemTemplate.imported_at` (DateTime) and (verify) `param-track-effect`'s captured effect id.
4. **Additivity.** The pre-existing oracles stay byte-identical at each regen (Task 4: 116 untouched; Task 8: 127 untouched) — driver changes are new arms / new `add_layer` kinds that existing seqs never hit. Verified via `git status --short oracle/`.
5. **Type consistency.** `LayerParamsPatch` (params.ts) is the single source consumed by `applyParamsPatch`, the actor dispatch, and the driver's serde. `normalizeKeyframes` (animated.ts) is consumed by `applyUpdateLayerParamTrack`. `AudioRole` wire form is kebab-case (`'music'`/`'dialogue'`) on BOTH the media param-builders and the Audio patch.

## On completion
- Update `project_state_actor_ts_migration.md`: mark Phase 2b-v DONE (commit range + corpus 116→~141), record that media AND params shipped together, note the ONE scope-out (Motif content-window clamp deferred — needs a motif catalog in the harness) and any landmines that bit (likely `imported_at` reconciliation; possibly the `param-track-effect` id). Update the still-open corpus-gaps list (media CLOSED; params CLOSED bar the Motif clamp).
- The roadmap "Next" becomes **2b-vi: captions + role/settings/flags** (`add_caption_track`/`restyle_caption_track`; `set_role_gain`/`update_role_flags`; `update_project_settings`).
