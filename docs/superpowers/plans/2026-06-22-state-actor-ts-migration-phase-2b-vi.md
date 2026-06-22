# State-Actor TS Migration — Phase 2b-vi Plan (captions + role/settings/flags)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the SIXTH (and final mutation) slice of **Phase 2b** of the master plan `2026-06-22-state-actor-ts-migration.md`. Read the **Phase-2b-v plan** (`…-phase-2b-v.md`) first — it established the per-slice workflow (port TS mutation → unit-test → extend dispatch+vocab+driver → author corpus → regen oracles → differential-gate), the unrecorded-closure pattern (`addMediaItem`/`updateTrackFlags`), and the id-contract discipline this slice depends on.

> **SCOPE (decided 2026-06-22):** the two remaining command families that are NOT blocked on an external dependency — **captions** (`add_caption_track`, `restyle_caption_track`) and **role/settings/flags** (`set_role_gain` [recorded], `update_role_flags` [unrecorded], `update_project_settings` [unrecorded]). Tasks 1–3 cover role/settings/flags (the lighter family; mostly mirrors existing `replace_*_everywhere` infra); Tasks 4–7 cover captions (the heavier family; ports the subtitle layout `cue_to_text_params` + the greedy lane-packing). After this slice the only un-ported actor commands are a STRAGGLER TAIL deferred to a future slice/Phase-3 cleanup: `rebind_motif` (needs the motif catalog — already-deferred dep), `remove_media`/`set_media_derivatives` (media-derivative lifecycle), `add_transient_track`, `replace_state`, `set_media_workspace_paths`. None of those is in this slice.

**Goal:** Port and differential-gate the captions subsystem (`add_caption_track` — greedy lane-pack cues into `Caption`-role tracks, one Text layer per cue via the ported `cueToTextParams`; `restyle_caption_track` — batch font/color/outline patch over a track's Text layers) AND the role/settings subsystem (`set_role_gain` — recorded role-bus gain edit; `update_role_flags` — unrecorded role mute/solo; `update_project_settings` — unrecorded settings patch).

**Architecture:** Same as Phase 1/2a/2b-* — pure functions over an Immer draft, 1:1 with the authoritative Rust. **Role/settings:** `set_role_gain` is RECORDED (`do_set_role_gain`, actor.rs:3657) — a generic `commit` recipe that reads the role bus (default-filled when absent), overrides `gain_db`, reinserts. `update_role_flags` (`do_update_role_flags`, actor.rs:3681) and `update_project_settings` (`do_update_project_settings`, actor.rs:3619) are UNRECORDED — dedicated actor closures mirroring `updateTrackFlags`: patch every snapshot via a `History.replace*Everywhere` map (`replaceRoleFlagsEverywhere` is NEW — mirror of history.rs:300; `replaceSettingsEverywhere` already exists) + `broadcastUnrecorded` (burns one id). **Captions:** both ops are RECORDED. `applyAddCaptionTrack` clones-then-builds via a `commit` recipe: stable-sort cues by `start_us`, greedy-assign each into the first lane whose last layer's snapped end ≤ this cue's snapped start (else open a new `Caption`-role track), and `applyAddLayer` one Text layer per cue from `cueToTextParams(cue, comp_w, comp_h)`; returns the primary (first) track id; empty cues still create one empty caption track. `applyRestyleCaptionTrack` = locate (else `TrackNotFound`) → patch each Text layer's `font.family`/`font.size_px`/`color`(→Static)/`outline`(keep existing color or BLACK). The differential corpus grows by ~15 sequences; the Rust `replay_driver` gains `set_role_gain`/`update_role_flags`/`update_project_settings`/`add_caption_track`/`restyle_caption_track` arms (+ a `parse_cue` helper); the gate (`differential.phase2.test.ts`) auto-picks-up new sequences once vocabulary + oracles exist.

**Tech Stack:** TypeScript, Immer, Vitest, the `weftcut-eval` wasm leaf (`snapFrameRound`, UNCHANGED, via `applyAddLayer` + the caption lane-pack snap), the Rust `replay_driver` bin + `gen-state-oracle.mjs` (needs the cargo/ffmpeg toolchain).

## Global Constraints

- **The oracle-regeneration toolchain (verified working through 2b-v).** Regenerating oracles builds `replay_driver` (compiles the native crate incl. ffmpeg-next). Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, runs each sequence 2× (determinism gate), writes oracle/*.json
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error). **Every driver change in this slice is ADDITIVE** — after a regen, the **pre-existing oracles must be byte-identical**; only NEW oracle files may appear. Verify with `git status --short fixtures/state-corpus/oracle/` after each regen (only `??` new files, never `M`). If an existing oracle shows Modified, STOP — the change wasn't additive; investigate.
- **Baseline:** the corpus currently holds **141 sequences / 141 oracles**; `differential.phase2.test.ts` runs all 141 with `skipped === []`. After Task 3's regen → 148; after Task 7's regen → 156.
- **Gate-ordering invariant (why task order matters).** `differential.phase2.test.ts` asserts `skipped === []` over the LIVE corpus dir, and `gen-state-oracle.mjs` runs the Rust driver over the LIVE corpus dir. So for any new op X: X must be in TS `SUPPORTED_OPS` + `buildArgs` + a dispatch arm + its mutation, AND in the Rust driver's `apply()`, **before** any corpus sequence using X exists. (Tasks 1–2 / 4–6 land TS code + unit tests with NO corpus; Tasks 3 / 7 wire the driver + vocab and only THEN author the corpus + regen.) `add_caption_track` is a top-level op (NOT an `add_layer` kind), so it needs no `SUPPORTED_ADD_KINDS` entry.
- **★ ROLE KEYSTONE — roles ALWAYS exist (default-filled on read), so role writes have NO not-found branch, and `gain_db` (recorded) is orthogonal to `muted`/`solo` (unrecorded).** `Project::role_mix(role)` (project.rs:99) = `audio_roles.get(role).cloned().unwrap_or_default()` where the default is `{gain_db:0, muted:false, solo:false}`. `set_role_gain` (recorded) reads the bus, sets ONLY `gain_db`, reinserts — preserving `muted`/`solo`. `update_role_flags` (unrecorded, via `apply_role_flags` history.rs:370) reads the bus, sets ONLY the present `muted`/`solo`, reinserts — preserving `gain_db`. So a role's gain and flags can be set independently and each preserves the other (gated by `set-role-gain-then-flags`). The `audio_roles` map is keyed by the **kebab** wire form (`'dialogue'`/`'music'`/`'sfx'`/`'voiceover'` — `#[serde(rename_all="kebab-case")]`, audio_role.rs:14); `canonicalize` key-sorts so insertion order is irrelevant. `RoleMixSettings` serializes all three fields (`#[serde(default)]` does NOT skip), matching the TS `{gain_db, muted, solo}` interface.
- **★ ROLE/SETTINGS KEYSTONE — `set_role_gain` is RECORDED (burns one op_id, undoable); `update_role_flags`/`update_project_settings` are UNRECORDED (burn one broadcast id, never undoable).** `set_role_gain` goes through `commit` → op_id minted AFTER validate (validation always passes — no role rules), undo reverts the bus to its prior value (gated by `set-role-gain-undo`: undo returns `audio_roles` to `{}`). `update_role_flags`/`update_project_settings` call `replace*Everywhere` + `broadcastUnrecorded` (one id, like `updateTrackFlags`); the patch survives undo of an UNRELATED edit (gated by the `*-survives-undo` seqs). A trailing `add_layer` after each reveals the single id burn.
- **★ CAPTION KEYSTONE — `add_caption_track`'s id-allocation order: per cue (start-sorted), opening a lane mints the TRACK id (Track::new) BEFORE the layer id (apply_add_layer); the op_id is minted last by commit.** `do_add_caption_track` (actor.rs:2412): stable-sort `cues` by `start_us`; for each cue compute `snapped_start = snap_frame_round(cue.start_us, fps)`; find the FIRST slot (lowest lane index) whose tracked end ≤ `snapped_start`; if none, `Track::new()` (mints a track id, track.rs:67) → set `role=Caption`, `transient=false`, `label` → `push_back` (appended AFTER the existing tracks); then `apply_add_layer` (mints a layer id) places the Text layer at `cue.start_us..cue.end_us` (snapped internally); update the lane's tracked end to `snap_frame_round(cue.end_us, fps)`. Return the PRIMARY (first-opened) track id. Empty cues → the loop body never runs, so a single safety-net `Track::new()` is created AFTER the loop. The TS `applyAddCaptionTrack` MUST mint ids in this EXACT interleaved order (`idGen()` for a new lane's track BEFORE `applyAddLayer`'s `idGen()` for its layer) or every later entity id drifts. Gated by `add-caption-track-multi-lane` (lane packing + id interleave) + `add-caption-track-single`/`-empty` + unit tests.
- **★ CAPTION KEYSTONE — the f32×f64 layout-float landmine; the differential corpus dodges it with EXPLICIT clean style values.** The captions layout writes f32-typed fields: `FontSpec.size_px` (f32, layer.rs:130), `Outline.width` (f32, layer.rs:156), `Shadow.offset_x/offset_y/blur` (f32, layer.rs:148-150). The styleless DEFAULT path computes `size = round(comp_h*0.05)` and `outline_w = size*0.06` in **f32** on the Rust side vs **f64** in TS; for some comp dimensions the f32 and f64 products serialize to DIFFERENT shortest-decimal strings (e.g. `50*0.06` → f64 `2.9999999999999996` vs f32 `≈3.0`), which the gate's `JSON.stringify` comparison (after `JSON.parse`-ing the oracle, differential.phase2.test.ts:34) would flag. Anchor positions (`x`/`y`, computed via `*0.08`) are f64 on BOTH sides (`anchor_for` takes f64), so they always match regardless of comp dims. **Mitigation (mandatory for the corpus):** every differential caption cue supplies EXPLICIT `size_px`, `outline_px`, `shadow_px` as clean exact values (`54`, `3`, `2`) so NO float multiply happens on either side — `max(3,1)=3` and `max(2,1)=2` serialize identically as integers, and an explicit integer `size_px` serializes identically as f32-vs-f64. The styleless auto-multiply path (`size*0.06`) is covered by a TS UNIT TEST (Task 4) mirroring the Rust unit test, NOT a differential seq. If a future seq needs the default path, run the regen and inspect the oracle's float output before trusting it; do NOT emulate f32 in TS (Math.fround would serialize the f64-expansion of the f32, making it WORSE).
- **id contract (otherwise unchanged):** `commit` allocates the op_id AFTER `validate`; a successful recorded op burns one op_id; a failed mutation or failed validate burns no op_id. `set_role_gain` burns one op_id (always succeeds). `add_caption_track` burns N lane-track ids + N layer ids (interleaved, start-sorted) + one op_id (or, for empty cues, one safety-net track id + one op_id). `restyle_caption_track` burns one op_id on success; `TrackNotFound` is raised inside the recipe → produce-throw → NO op_id, NO entity id. `update_role_flags`/`update_project_settings` each burn exactly one broadcast id (the `broadcastUnrecorded` `idGen()`).
- **The wasm snap leaf is sacred** — `snapFrameRound` from `../snap`, never reimplemented (reached through `applyAddLayer` and the caption lane-pack). **TimeUs is `number`.**
- **NO `model.ts`/`validate.ts`/`errors.ts`/`serialize.ts`/`canonical.ts` changes are required.** `TrackRole='Caption'`, `TextParams`/`FontSpec`/`Outline`/`Shadow`/`TextAlign`/`TextBackend`/`Transform`/`Rgba`, `RoleMixSettings`, `ProjectSettings`, `AudioRole` are all already in model.ts (lines 12-117). `TrackNotFound` and `WrongLayerKind` are already in errors.ts:28,30. No caption/role/settings op introduces a new `CommandError` or `ValidationError` variant (`add_caption_track` always creates its own non-overlapping tracks; `restyle` only raises `TrackNotFound`; the role/settings ops cannot fail). `parseOracleErrorVariant`/`tsErrorVariant` already normalize `TrackNotFound` (top-level) with no new code. The NEW patch/cue types (`RoleFlagsPatch`, `Cue`/`CueStyle`, `CaptionStylePatch`) live in `history.ts` (role flags) and `mutations/captions.ts` (captions) — NOT in `model.ts`.
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — feedback_parallel_sessions_git). Work on local `main`; do NOT push. TDD, frequent commits, DRY, YAGNI.

### Reference Rust sources (cite; re-read only if a differential step diverges)

- **Role/settings:** `do_set_role_gain` (RECORDED, actor.rs:3657-3675), `do_update_role_flags` (UNRECORDED, actor.rs:3681-3691), `do_update_project_settings` (UNRECORDED, actor.rs:3619-3632). `History::replace_role_flags_everywhere` + `apply_role_flags` (history.rs:300-311, 370-385), `replace_settings_everywhere` (history.rs:263-274). `Project::role_mix` (project.rs:99). `AudioRole`/`RoleMixSettings`/`RoleFlagsPatch` (audio_role.rs:15,48,67). `ProjectSettings`/`ProjectSettingsPatch` (project.rs:113,147 — patch has the single field `auto_delete_empty_tracks: Option<bool>`). Handle methods: `update_project_settings` (actor.rs:1400), `set_role_gain` (actor.rs:1441), `update_role_flags` (actor.rs:1462).
- **Captions:** `do_add_caption_track` (RECORDED, actor.rs:2412-2516 — greedy lane-pack), `do_restyle_caption_track` (RECORDED, actor.rs:2521-2561). `cue_to_text_params` + `anchor_for` + `align_for` + `DEFAULT_CAPTION_FONT` (subtitles/layout.rs:7-82). `Cue`/`CueStyle` (subtitles/mod.rs:14-38 — NO Deserialize derive; the driver builds them manually). `CaptionStylePatch` (actor.rs:131-137 — derives Deserialize; fields `font_family`/`font_size_px:f32`/`color:Rgba`/`outline_width:f32`). `apply_add_layer` (mutations.rs:47, TS twin `applyAddLayer` add.ts:28). `Track::new()` mints `id: new_id()` (track.rs:67); defaults mirrored by `applyAddTrack` (add.ts:43: `removable:true,role:null,transient:false,height_px:64`). Handle methods: `add_caption_track` (actor.rs:976), `restyle_caption_track` (actor.rs:1000).
- **Float types** (for the f32 keystone): `FontSpec.size_px:f32` (layer.rs:130), `Shadow.offset_x/y/blur:f32` (layer.rs:148-150), `Outline.width:f32` (layer.rs:156); `Rgba::BLACK={0,0,0,255}`, `WHITE={255,255,255,255}` (color.rs:19-20).
- **TS pieces already in place:** `replaceSettingsEverywhere`/`replaceTrackFlagsEverywhere`/`replaceMediaPoolEverywhere` (history.ts:82-112 — templates for `replaceRoleFlagsEverywhere`); `updateTrackFlags`/`addMediaItem` unrecorded closures + `commit`/`broadcastUnrecorded`/`runValidate` + string dispatch (actor.ts:90-205,233); `applyAddLayer`/`defaultTransform`/`textParamsDefault` (add.ts); `RoleMixSettings`/`ProjectSettings`/`TextParams`/`TrackRole` (model.ts); `TrackNotFound`/`CommandFailure` (errors.ts); the driver `parse_cue`-style manual JSON→struct pattern (replay_driver.rs `media_item`).
- **Rust driver module paths (verified):** `weftcut_lib::state::ProjectSettingsPatch` (re-exported, mod.rs:55), `weftcut_lib::state::AudioRole` + `weftcut_lib::state::RoleFlagsPatch` (re-exported, mod.rs:59), `weftcut_lib::state::actor::CaptionStylePatch` (NOT re-exported — fully qualify), `weftcut_lib::subtitles::{Cue, CueStyle}` (lib.rs:55).

---

## File Structure

All paths under `apps/desktop/`. Vitest from `apps/desktop/` (`npx vitest run <path>`).

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/history.ts` | `RoleFlagsPatch` type + `replaceRoleFlagsEverywhere(role, patch)` (mirror history.rs:300). | Mod |
| `src/main/state/history.test.ts` | `replaceRoleFlagsEverywhere` unit test (default-fill, gain preserved, survives undo). | Mod |
| `src/main/state/actor.ts` | `setRoleGain` (recorded), `updateRoleFlags`/`updateProjectSettings` (unrecorded closures); dispatch arms for the trio (Tasks 1-2) + caption arms (Task 6). | Mod |
| `src/main/state/actor.test.ts` | Dispatch describe blocks: role gain/flags/settings (Task 2); captions (Task 6). | Mod |
| `src/main/state/mutations/captions.ts` | `Cue`/`CueStyle`/`CaptionStylePatch` types; `cueToTextParams`/`anchorFor`/`alignFor`; `applyAddCaptionTrack`; `applyRestyleCaptionTrack`. | **New** |
| `src/main/state/mutations/captions.test.ts` | Unit tests: `cueToTextParams` (mirror Rust); lane-pack/empty/id-order; restyle happy + TrackNotFound. | **New** |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` += the 5 ops; `buildArgs` for all 5. | Mod |
| `native/src/bin/replay_driver.rs` | `set_role_gain`/`update_role_flags`/`update_project_settings` arms (Task 3); `add_caption_track` (+`parse_cue`/`rgba_arr` helpers)/`restyle_caption_track` arms (Task 7). | Mod |
| `fixtures/state-corpus/sequences/*.json` | ~7 role/settings + ~8 caption sequences. | **New** |
| `fixtures/state-corpus/oracle/*.json` | Regenerated oracle traces (generated). | **New (generated)** |
| `fixtures/state-corpus/README.md` | Role/settings coverage rows (Task 3); caption rows + close gap #4 (Task 7). | Mod |

> Note: `actor.ts`, `actor.test.ts`, `replay.ts`, `replay_driver.rs`, and the corpus dirs are touched by BOTH families; each task's commit stages only its own slice's additions (additive — no conflict).

---

## Task 1: `History.replaceRoleFlagsEverywhere` + `RoleFlagsPatch` (TS only)

**Files:**
- Modify: `src/main/state/history.ts`
- Test: `src/main/state/history.test.ts`

**Interfaces:**
- Produces: `RoleFlagsPatch` interface (`{ muted?: boolean | null; solo?: boolean | null }`); `History.replaceRoleFlagsEverywhere(role: string, patch: RoleFlagsPatch): void` — patch one role's mute/solo into EVERY snapshot + checkpoint, default-filling the bus when absent, preserving `gain_db`; cursor unchanged; not recorded.
- Consumes: `RoleMixSettings` from `./model`.

- [ ] **Step 1: Write the failing test** in `src/main/state/history.test.ts` (add a describe block near `replaceSettingsEverywhere`):

```ts
describe('History.replaceRoleFlagsEverywhere', () => {
  it('sets the role flags on every snapshot (default-filled), surviving undo', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, gen())
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000 } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    h.replaceRoleFlagsEverywhere('music', { muted: true })
    expect(h.current().audio_roles.music).toEqual({ gain_db: 0, muted: true, solo: false }) // head patched, defaults filled
    const earlier = h.undo()! // back to the Initial snapshot
    expect(earlier.audio_roles.music).toEqual({ gain_db: 0, muted: true, solo: false }) // earlier patched too
    expect(earlier.composition.duration_us).toBe(0) // role-only patch leaves the rest intact
  })
  it('preserves an existing gain_db while toggling solo', () => {
    const gen = seededGen()
    const p0 = { ...blankProject(gen, 'h'), audio_roles: { dialogue: { gain_db: 6, muted: false, solo: false } } }
    const h = new History(p0, { kind: 'User' }, gen())
    h.replaceRoleFlagsEverywhere('dialogue', { solo: true })
    expect(h.current().audio_roles.dialogue).toEqual({ gain_db: 6, muted: false, solo: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/history.test.ts` → FAIL (method missing).

- [ ] **Step 3: Implement** in `history.ts`. Add `RoleMixSettings` to the model import (line 2) and a `RoleFlagsPatch` export near `TrackFlagsPatch` (line 10):
```ts
import type { Composition, MediaItem, Project, ProjectSettings, RoleMixSettings, Uuid } from './model'
```
```ts
/** native/src/state/audio_role.rs:67 RoleFlagsPatch — the Mixer panel's M/S
 *  toggles. null/absent = "don't touch". Unrecorded (preference-shaped). */
export interface RoleFlagsPatch { muted?: boolean | null; solo?: boolean | null }
```
Add the method after `replaceTrackFlagsEverywhere` (before `replaceMediaPoolEverywhere`):
```ts
  /** native/src/state/history.rs:300 replace_role_flags_everywhere (via apply_role_flags
   *  history.rs:370) — patch one audio role's mute/solo into EVERY snapshot + checkpoint.
   *  Roles ALWAYS exist (absent → RoleMixSettings default {gain_db:0,muted:false,solo:false}),
   *  so unlike tracks there is NO skip-when-absent branch: the patch applies unconditionally.
   *  gain_db is preserved (only mute/solo are preference-shaped). cursor unchanged; never
   *  recorded (project_settings_patch_convention). */
  replaceRoleFlagsEverywhere(role: string, patch: RoleFlagsPatch): void {
    const apply = (p: Project): Project => {
      const cur = p.audio_roles[role]
      const s: RoleMixSettings = { gain_db: cur?.gain_db ?? 0, muted: cur?.muted ?? false, solo: cur?.solo ?? false }
      if (typeof patch.muted === 'boolean') s.muted = patch.muted
      if (typeof patch.solo === 'boolean') s.solo = patch.solo
      return { ...p, audio_roles: { ...p.audio_roles, [role]: s } }
    }
    for (const e of this.snapshots) e.snapshot = apply(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = apply(cp.snapshot)
  }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/history.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/history.test.ts
git commit -m "feat(state-migration): History.replaceRoleFlagsEverywhere + RoleFlagsPatch (Phase 2b-vi)"
```

---

## Task 2: actor.ts wiring — `setRoleGain` / `updateRoleFlags` / `updateProjectSettings` + dispatch

**Files:**
- Modify: `src/main/state/actor.ts`
- Test: `src/main/state/actor.test.ts`

**Interfaces:**
- Consumes: `RoleFlagsPatch` from `./history`; `History.replaceRoleFlagsEverywhere`/`replaceSettingsEverywhere`.
- Produces: dispatch handles `set_role_gain` (recorded; returns null), `update_role_flags` (unrecorded), `update_project_settings` (unrecorded).

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts` (reuse the existing `createActor`/`seededGen`/`blankProject` imports):

```ts
describe('dispatch: role gain + flags + project settings', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'r'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    return { actor, a }
  }
  it('set_role_gain inserts a role bus and is undoable (recorded)', () => {
    const { actor } = setup()
    expect(actor.dispatch('set_role_gain', { role: 'music', gain_db: 6 }).ok).toBe(true)
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 6, muted: false, solo: false })
    actor.dispatch('undo')
    expect(actor.snapshot().audio_roles).toEqual({}) // recorded → undo clears the bus
  })
  it('set_role_gain then update_role_flags: flags preserve the gain', () => {
    const { actor } = setup()
    actor.dispatch('set_role_gain', { role: 'music', gain_db: 6 })
    actor.dispatch('update_role_flags', { role: 'music', patch: { muted: true } })
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 6, muted: true, solo: false })
  })
  it('update_role_flags toggles mute (unrecorded) and survives undo of a later edit', () => {
    const { actor, a } = setup()
    actor.dispatch('update_role_flags', { role: 'dialogue', patch: { muted: true } })
    expect(actor.snapshot().audio_roles.dialogue).toEqual({ gain_db: 0, muted: true, solo: false })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo')
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // edit undone
    expect(actor.snapshot().audio_roles.dialogue).toEqual({ gain_db: 0, muted: true, solo: false }) // flag persists
  })
  it('update_project_settings flips auto_delete_empty_tracks (unrecorded, survives undo)', () => {
    const { actor, a } = setup()
    actor.dispatch('update_project_settings', { patch: { auto_delete_empty_tracks: false } })
    expect(actor.snapshot().settings.auto_delete_empty_tracks).toBe(false)
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo')
    expect(actor.snapshot().settings.auto_delete_empty_tracks).toBe(false) // preference persists across undo
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Extend the history import (line 5) to include `RoleFlagsPatch`:
```ts
import { History, type Actor, type EntityRef, type TrackFlagsPatch, type RoleFlagsPatch } from './history'
```
Add the three closures after `addMediaItem` (~line 205):
```ts
  // ── set_role_gain (do_set_role_gain:3657) — RECORDED (undoable). Read the
  //    role's mix bus (default-filled when absent), override ONLY gain_db
  //    (muted/solo preserved), reinsert. No affected entities, Coarse hint. ──
  function setRoleGain(role: string, gainDb: number): void {
    commit(`Set ${role} role gain`, [], { kind: 'Coarse' }, (d) => {
      const cur = d.audio_roles[role]
      d.audio_roles[role] = { gain_db: gainDb, muted: cur?.muted ?? false, solo: cur?.solo ?? false }
    })
  }

  // ── update_role_flags (do_update_role_flags:3681) — UNRECORDED (mirrors
  //    updateTrackFlags). Patch mute/solo into EVERY snapshot + broadcast (burns
  //    one id). Roles always exist (default-filled), so no not-found branch. ──
  function updateRoleFlags(role: string, patch: RoleFlagsPatch): void {
    history.replaceRoleFlagsEverywhere(role, patch)
    broadcastUnrecorded('Updated role flags', current())
  }

  // ── update_project_settings (do_update_project_settings:3619) — UNRECORDED.
  //    Clone settings, apply the present fields, replace-everywhere + broadcast. ──
  function updateProjectSettings(patch: { auto_delete_empty_tracks?: boolean | null }): void {
    const next = { ...current().settings }
    if (typeof patch.auto_delete_empty_tracks === 'boolean') next.auto_delete_empty_tracks = patch.auto_delete_empty_tracks
    history.replaceSettingsEverywhere(next)
    broadcastUnrecorded('Updated project settings', current())
  }
```
Add the dispatch arms (in the `switch (channel)`, near the other unrecorded ops):
```ts
        case 'set_role_gain': setRoleGain(a.role as string, a.gain_db as number); return { ok: true, value: null }
        case 'update_role_flags': updateRoleFlags(a.role as string, a.patch as RoleFlagsPatch); return { ok: true, value: null }
        case 'update_project_settings': updateProjectSettings(a.patch as { auto_delete_empty_tracks?: boolean | null }); return { ok: true, value: null }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/actor.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): actor set_role_gain/update_role_flags/update_project_settings dispatch (Phase 2b-vi)"
```

---

## Task 3: driver + vocab + corpus + regen for role/settings/flags

**Files:**
- Modify: `src/main/state/replay.ts`
- Modify: `native/src/bin/replay_driver.rs`
- Create: 7 `fixtures/state-corpus/sequences/*.json`
- Generate: 7 `fixtures/state-corpus/oracle/*.json`
- Modify: `fixtures/state-corpus/README.md`

- [ ] **Step 1: Extend the TS vocabulary** (`replay.ts`). Add to `SUPPORTED_OPS`:
```ts
  'set_role_gain', 'update_role_flags', 'update_project_settings',
```
Add to `buildArgs` (before the `undo`/`redo` cases):
```ts
    case 'set_role_gain': return { role: cmd.role, gain_db: cmd.gain_db }
    case 'update_role_flags': return { role: cmd.role, patch: { muted: cmd.muted, solo: cmd.solo } }
    case 'update_project_settings': return { patch: { auto_delete_empty_tracks: cmd.auto_delete_empty_tracks } }
```

- [ ] **Step 2: Extend the Rust driver** (`replay_driver.rs`). Add these arms in `apply()` (before the final `other =>` arm):
```rust
        "set_role_gain" => {
            let role: state::AudioRole = serde_json::from_value(cmd["role"].clone()).map_err(|e| e.to_string())?;
            h.set_role_gain(u, role, cmd["gain_db"].as_f64().unwrap()).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_role_flags" => {
            let role: state::AudioRole = serde_json::from_value(cmd["role"].clone()).map_err(|e| e.to_string())?;
            let patch = state::RoleFlagsPatch { muted: cmd["muted"].as_bool(), solo: cmd["solo"].as_bool() };
            h.update_role_flags(u, role, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_project_settings" => {
            let patch = state::ProjectSettingsPatch { auto_delete_empty_tracks: cmd["auto_delete_empty_tracks"].as_bool() };
            h.update_project_settings(u, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
```
> `state::AudioRole`, `state::RoleFlagsPatch`, `state::ProjectSettingsPatch` are all re-exported at `weftcut_lib::state` (the driver already imports `weftcut_lib::state::{self, ...}`). `AudioRole` deserializes from the kebab string (`"music"` etc.).

- [ ] **Step 3: Author the 7 corpus sequences** in `fixtures/state-corpus/sequences/`:

`set-role-gain-music.json`:
```json
{ "name": "set-role-gain-music", "commands": [
  { "op": "set_role_gain", "role": "music", "gain_db": 6 },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 }
] }
```
`set-role-gain-undo.json`:
```json
{ "name": "set-role-gain-undo", "commands": [
  { "op": "set_role_gain", "role": "dialogue", "gain_db": -2.5 },
  { "op": "undo" }
] }
```
`set-role-gain-then-flags.json`:
```json
{ "name": "set-role-gain-then-flags", "commands": [
  { "op": "set_role_gain", "role": "music", "gain_db": 6 },
  { "op": "update_role_flags", "role": "music", "muted": true }
] }
```
`update-role-flags-mute.json`:
```json
{ "name": "update-role-flags-mute", "commands": [
  { "op": "update_role_flags", "role": "music", "muted": true },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 }
] }
```
`update-role-flags-survives-undo.json`:
```json
{ "name": "update-role-flags-survives-undo", "commands": [
  { "op": "update_role_flags", "role": "dialogue", "solo": true },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "undo" }
] }
```
`update-project-settings.json`:
```json
{ "name": "update-project-settings", "commands": [
  { "op": "update_project_settings", "auto_delete_empty_tracks": false },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 }
] }
```
`update-project-settings-survives-undo.json`:
```json
{ "name": "update-project-settings-survives-undo", "commands": [
  { "op": "update_project_settings", "auto_delete_empty_tracks": false },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "undo" }
] }
```

- [ ] **Step 4: Regenerate oracles** (from `apps/desktop/`, env vars per Global Constraints):
```bash
node scripts/gen-state-oracle.mjs
git status --short fixtures/state-corpus/oracle/   # MUST show only 7 new (??) files, never M
```
If any pre-existing oracle shows `M`, STOP — the driver change wasn't additive; investigate before continuing.

- [ ] **Step 5: Run the differential gate** — `npx vitest run src/main/state/__tests__/differential.phase2.test.ts` → PASS (148/148, `skipped === []`). Then the full state suite: `npx vitest run src/main/state` → all green.

- [ ] **Step 6: Update the corpus README.** Add coverage rows (and remove the "role/settings deferred" note if present):
```markdown
| set_role_gain (recorded, undoable) | set-role-gain-music.json, set-role-gain-undo.json |
| role gain + flags orthogonality | set-role-gain-then-flags.json |
| update_role_flags (unrecorded, survives undo) | update-role-flags-mute.json, update-role-flags-survives-undo.json |
| update_project_settings (unrecorded, survives undo) | update-project-settings.json, update-project-settings-survives-undo.json |
```

- [ ] **Step 7: Commit.**
```bash
git add apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/set-role-gain-music.json apps/desktop/fixtures/state-corpus/sequences/set-role-gain-undo.json apps/desktop/fixtures/state-corpus/sequences/set-role-gain-then-flags.json apps/desktop/fixtures/state-corpus/sequences/update-role-flags-mute.json apps/desktop/fixtures/state-corpus/sequences/update-role-flags-survives-undo.json apps/desktop/fixtures/state-corpus/sequences/update-project-settings.json apps/desktop/fixtures/state-corpus/sequences/update-project-settings-survives-undo.json apps/desktop/fixtures/state-corpus/oracle/set-role-gain-music.json apps/desktop/fixtures/state-corpus/oracle/set-role-gain-undo.json apps/desktop/fixtures/state-corpus/oracle/set-role-gain-then-flags.json apps/desktop/fixtures/state-corpus/oracle/update-role-flags-mute.json apps/desktop/fixtures/state-corpus/oracle/update-role-flags-survives-undo.json apps/desktop/fixtures/state-corpus/oracle/update-project-settings.json apps/desktop/fixtures/state-corpus/oracle/update-project-settings-survives-undo.json apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): role gain/flags + project settings live + corpus (Phase 2b-vi)"
```

---

## Task 4: `cueToTextParams` + `Cue`/`CueStyle` types (`mutations/captions.ts`)

**Files:**
- Create: `src/main/state/mutations/captions.ts`
- Test: `src/main/state/mutations/captions.test.ts`

**Interfaces:**
- Produces:
  - `interface CueStyle { font_family?, size_px?, primary?, bold?, italic?, outline_px?, outline_color?, shadow_px?, align?, pos? }` (mirror subtitles/mod.rs:27).
  - `interface Cue { start_us: number; end_us: number; text: string; style?: CueStyle }`.
  - `cueToTextParams(cue: Cue, compW: number, compH: number): TextParams` (mirror subtitles/layout.rs:14).
- Consumes: `Rgba`/`TextParams`/`TextAlign` from `../model`; `defaultTransform` from `./add`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/mutations/captions.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import type { TextParams } from '../model'
import { cueToTextParams, type Cue, type CueStyle } from './captions'

const cue = (style: CueStyle = {}): Cue => ({ start_us: 0, end_us: 1, text: 'hi', style })

describe('cueToTextParams (mirror subtitles/layout.rs)', () => {
  it('styleless cue → bottom-center default look', () => {
    const p = cueToTextParams(cue(), 1920, 1080)
    expect(p.font.family).toBe('Liberation Sans, Noto Sans SC')
    expect(p.font.size_px).toBe(54) // round(1080 * 0.05)
    expect(p.outline).not.toBeNull()
    expect(p.shadow).not.toBeNull()
    expect(p.transform.anchor).toEqual([0.5, 1.0]) // an2 bottom-center
    expect(p.transform.x).toEqual({ mode: 'Static', value: 960 }) // w/2
    expect((p.transform.y as { value: number }).value).toBeCloseTo(1080 - 1080 * 0.08, 5) // h - 8%
    expect(p.align).toBe('Center')
    expect(p.backend_hint).toBe('DrawText')
  })
  it('an8 → top-center anchors top', () => {
    expect(cueToTextParams(cue({ align: 8 }), 1920, 1080).transform.anchor).toEqual([0.5, 0.0])
  })
  it('an1 → bottom-left, Left align', () => {
    const p = cueToTextParams(cue({ align: 1 }), 1920, 1080)
    expect(p.transform.anchor).toEqual([0.0, 1.0])
    expect(p.align).toBe('Left')
  })
  it('explicit pos overrides the computed base position', () => {
    const p = cueToTextParams(cue({ align: 5, pos: [100, 200] }), 1920, 1080)
    expect([p.transform.x, p.transform.y]).toEqual([{ mode: 'Static', value: 100 }, { mode: 'Static', value: 200 }])
  })
  it('explicit clean style: bold/italic + size/outline', () => {
    const p = cueToTextParams(cue({ size_px: 54, bold: true, italic: true, outline_px: 3, shadow_px: 2 }), 1920, 1080)
    expect([p.font.size_px, p.font.weight, p.font.italic]).toEqual([54, 700, true])
    expect((p.outline as { width: number }).width).toBe(3)
    expect((p.shadow as { blur: number }).blur).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/captions.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** the top half of `src/main/state/mutations/captions.ts`. Import ONLY what `cueToTextParams` uses (Task 5 widens these imports when it adds the functions that need `Project`/`IdGen`/`snapFrameRound`/`applyAddLayer`/`CommandFailure`) — `tsconfig.main.json` sets `noUnusedLocals: true`, so an import unused in THIS task fails its typecheck step:

```ts
import type { Rgba, TextAlign, TextParams } from '../model'
import { defaultTransform } from './add'

/** subtitles/mod.rs:27 CueStyle — per-cue style hints (all optional; absent ⇒
 *  the default caption look applies). `align` is the ASS 9-grid (1..9). */
export interface CueStyle {
  font_family?: string | null
  size_px?: number | null
  primary?: Rgba | null
  bold?: boolean
  italic?: boolean
  outline_px?: number | null
  outline_color?: Rgba | null
  shadow_px?: number | null
  align?: number | null
  pos?: [number, number] | null
}
/** subtitles/mod.rs:16 Cue — one subtitle cue (text keeps explicit '\n'). */
export interface Cue { start_us: number; end_us: number; text: string; style?: CueStyle }

const DEFAULT_CAPTION_FONT = 'Liberation Sans, Noto Sans SC'
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 }

/** subtitles/layout.rs:14 cue_to_text_params — lay out one cue as a Text layer.
 *  Styleless cues get white fill, black outline + soft shadow, size 5% of comp
 *  height, bottom-centre with an 8% safe-area margin. The ASS 9-grid align (or
 *  \pos) becomes an absolute anchor + position. NOTE the f32 keystone: size_px /
 *  outline width / shadow offsets are f32 in Rust — the differential corpus
 *  supplies explicit clean style values so the auto-multiply path (this fn's
 *  `size * 0.06`) is never differential-gated (it IS unit-tested above). */
export function cueToTextParams(cue: Cue, compW: number, compH: number): TextParams {
  const s = cue.style ?? {}
  const size = s.size_px ?? Math.round(compH * 0.05)
  const primary = s.primary ?? WHITE
  const outlineW = Math.max(s.outline_px ?? size * 0.06, 1.0)
  const shadowOff = Math.max(s.shadow_px ?? 2.0, 1.0)
  const an = s.align ?? 2
  const [anchor, baseX, baseY] = anchorFor(an, compW, compH)
  const [x, y] = s.pos ?? [baseX, baseY]
  return {
    kind: 'Text', content: cue.text,
    font: { family: s.font_family ?? DEFAULT_CAPTION_FONT, size_px: size, weight: s.bold ? 700 : 400, italic: s.italic ?? false },
    color: { mode: 'Static', value: primary },
    align: alignFor(an),
    transform: { ...defaultTransform(), x: { mode: 'Static', value: x }, y: { mode: 'Static', value: y }, anchor },
    opacity: { mode: 'Static', value: 1 },
    shadow: { color: BLACK, offset_x: shadowOff, offset_y: shadowOff, blur: shadowOff },
    outline: { color: s.outline_color ?? BLACK, width: outlineW },
    intro: null, outro: null, backend_hint: 'DrawText',
  }
}

/** layout.rs:60 anchor_for — ASS 9-grid → (anchor, x, y). 1-3 bottom, 4-6 middle,
 *  7-9 top; 1/4/7 left, 2/5/8 centre, 3/6/9 right. 8% safe-area margins (f64). */
function anchorFor(an: number, w: number, h: number): [[number, number], number, number] {
  const mx = w * 0.08, my = h * 0.08
  let ax: number, x: number
  if (an === 1 || an === 4 || an === 7) { ax = 0.0; x = mx }
  else if (an === 3 || an === 6 || an === 9) { ax = 1.0; x = w - mx }
  else { ax = 0.5; x = w / 2.0 }
  let ay: number, y: number
  if (an === 7 || an === 8 || an === 9) { ay = 0.0; y = my }
  else if (an === 4 || an === 5 || an === 6) { ay = 0.5; y = h / 2.0 }
  else { ay = 1.0; y = h - my }
  return [[ax, ay], x, y]
}
/** layout.rs:76 align_for. */
function alignFor(an: number): TextAlign {
  if (an === 1 || an === 4 || an === 7) return 'Left'
  if (an === 3 || an === 6 || an === 9) return 'Right'
  return 'Center'
}
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run src/main/state/mutations/captions.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/captions.ts apps/desktop/src/main/state/mutations/captions.test.ts
git commit -m "feat(state-migration): port cueToTextParams + Cue/CueStyle types (Phase 2b-vi)"
```

---

## Task 5: `applyAddCaptionTrack` + `applyRestyleCaptionTrack` + `CaptionStylePatch`

**Files:**
- Modify: `src/main/state/mutations/captions.ts`
- Test: `src/main/state/mutations/captions.test.ts`

**Interfaces:**
- Produces:
  - `interface CaptionStylePatch { font_family?, font_size_px?, color?, outline_width? }` (mirror actor.rs:131).
  - `applyAddCaptionTrack(p, idGen, cues: Cue[], compW: number, compH: number, label: string | null): Uuid` — greedy lane-pack; returns the primary track id; empty cues create one empty caption track. ★ Mints the lane track id BEFORE the layer id (id keystone).
  - `applyRestyleCaptionTrack(p, trackId: Uuid, patch: CaptionStylePatch): void` — patch every Text layer; `TrackNotFound` when absent.

- [ ] **Step 1: Add failing tests** to `src/main/state/mutations/captions.test.ts`:

```ts
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddCaptionTrack, applyRestyleCaptionTrack } from './captions'

const CLEAN: CueStyle = { size_px: 54, outline_px: 3, shadow_px: 2 } // explicit ⇒ no f32 multiply

describe('applyAddCaptionTrack', () => {
  // blankProject consumes #1 A-roll, #2 B-roll, #3 project (no actor/History here).
  function blank() { const gen = seededGen(); return { p: blankProject(gen, 'c'), gen } }
  it('one cue → a Caption track appended after B-roll with one Text layer, returns the primary id', () => {
    const { p, gen } = blank()
    const tid = applyAddCaptionTrack(p, gen, [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], 1920, 1080, 'Captions')
    expect(tid).toBe('00000000-0000-0000-0000-000000000004') // track id #4 (Track::new first), layer #5
    expect(p.tracks.map((t) => t.id).slice(2)).toEqual([tid]) // appended after [A, B]
    const ct = p.tracks[2]
    expect([ct.role, ct.label, ct.removable, ct.transient]).toEqual(['Caption', 'Captions', true, false])
    expect(ct.layers).toHaveLength(1)
    expect(ct.layers[0].params.kind).toBe('Text')
  })
  it('two overlapping cues open two lanes; a third non-overlapping cue reuses lane 1', () => {
    const { p, gen } = blank()
    applyAddCaptionTrack(p, gen, [
      { start_us: 0, end_us: 2_000_000, text: 'a', style: CLEAN },        // lane1: end 2s
      { start_us: 1_000_000, end_us: 3_000_000, text: 'b', style: CLEAN }, // overlaps lane1 (2s>1s) → lane2
      { start_us: 2_000_000, end_us: 3_000_000, text: 'c', style: CLEAN }, // lane1 end 2s <= 2s → reuse lane1
    ], 1920, 1080, null)
    const caps = p.tracks.filter((t) => t.role === 'Caption')
    expect(caps).toHaveLength(2)
    expect(caps[0].layers.map((l) => (l.params as { content: string }).content)).toEqual(['a', 'c'])
    expect(caps[1].layers.map((l) => (l.params as { content: string }).content)).toEqual(['b'])
  })
  it('empty cues → one empty Caption track (raw-contract safety net)', () => {
    const { p, gen } = blank()
    const tid = applyAddCaptionTrack(p, gen, [], 1920, 1080, 'X')
    expect(p.tracks[2].id).toBe(tid)
    expect([p.tracks[2].role, p.tracks[2].layers.length]).toEqual(['Caption', 0])
  })
})

describe('applyRestyleCaptionTrack', () => {
  it('patches every Text layer; outline_width keeps the existing outline color', () => {
    const gen = seededGen(); const p = blankProject(gen, 'c')
    const tid = applyAddCaptionTrack(p, gen, [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], 1920, 1080, null)
    applyRestyleCaptionTrack(p, tid, { font_family: 'Arial', font_size_px: 60, outline_width: 4 })
    const tp = p.tracks[2].layers[0].params as TextParams
    expect([tp.font.family, tp.font.size_px]).toEqual(['Arial', 60])
    expect(tp.outline).toEqual({ color: { r: 0, g: 0, b: 0, a: 255 }, width: 4 }) // BLACK kept from the original outline
  })
  it('TrackNotFound on a missing track', () => {
    const gen = seededGen(); const p = blankProject(gen, 'c')
    expect(() => applyRestyleCaptionTrack(p, '00000000-0000-0000-0000-0000000000ff', { font_size_px: 60 })).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/main/state/mutations/captions.test.ts` → FAIL (functions missing).

- [ ] **Step 3: Implement** — first WIDEN the imports at the top of `src/main/state/mutations/captions.ts` to add the symbols these functions need (Task 4 imported only what `cueToTextParams` used):
```ts
import type { Project, Rgba, TextAlign, TextParams, Uuid } from '../model'
import type { IdGen } from '../ids'
import { snapFrameRound } from '../snap'
import { applyAddLayer, defaultTransform } from './add'
import { CommandFailure } from '../errors'
```
Then append the functions:

```ts
/** actor.rs:131 CaptionStylePatch — batch style applied to a caption track's
 *  Text layers. null/absent = "don't touch". */
export interface CaptionStylePatch {
  font_family?: string | null
  font_size_px?: number | null
  color?: Rgba | null
  outline_width?: number | null
}

/** actor.rs:2412 do_add_caption_track — greedy lane-pack the cues into Caption
 *  tracks (one Text layer per cue). Cues stable-sorted by start_us; each cue goes
 *  to the FIRST lane whose last layer's snapped end <= this cue's snapped start,
 *  else a new Caption track is opened (appended after the existing tracks).
 *  Returns the primary (first-opened) track id. Empty cues still create one empty
 *  Caption track. ★ ID ORDER: opening a lane mints the track id (newCaptionTrack
 *  → idGen) BEFORE the layer id (applyAddLayer → idGen) — mirror Track::new()
 *  then apply_add_layer exactly. No explicit autofit (applyAddLayer autofits per
 *  layer). */
export function applyAddCaptionTrack(p: Project, idGen: IdGen, cues: Cue[], compW: number, compH: number, label: string | null): Uuid {
  const fps = p.composition.fps
  const sorted = cues.slice().sort((a, b) => (a.start_us < b.start_us ? -1 : a.start_us > b.start_us ? 1 : 0)) // stable by start_us
  const trackIds: Uuid[] = []
  const trackEnds: number[] = []
  for (const cue of sorted) {
    const snappedStart = snapFrameRound(cue.start_us, fps.num, fps.den)
    const slot = trackEnds.findIndex((end) => end <= snappedStart)
    let trackId: Uuid
    if (slot >= 0) { trackId = trackIds[slot] }
    else { trackId = newCaptionTrack(p, idGen, label); trackIds.push(trackId); trackEnds.push(0) }
    applyAddLayer(p, idGen, trackId, cueToTextParams(cue, compW, compH), cue.start_us, cue.end_us)
    trackEnds[trackIds.indexOf(trackId)] = snapFrameRound(cue.end_us, fps.num, fps.den)
  }
  if (trackIds.length > 0) return trackIds[0]
  return newCaptionTrack(p, idGen, label) // empty-cues safety net (Track::new after the loop)
}

/** Track::new() defaults (track.rs:65) + role=Caption, transient=false; appended
 *  to the END of the track list (push_back). removable=true (Track::new default,
 *  == applyAddTrack). */
function newCaptionTrack(p: Project, idGen: IdGen, label: string | null): Uuid {
  const id = idGen()
  p.tracks.push({ id, label, enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: 'Caption', transient: false, height_px: 64, layers: [] })
  return id
}

/** actor.rs:2521 do_restyle_caption_track — patch font_family/font_size_px/color/
 *  outline_width onto every Text layer of the track in one commit; non-Text layers
 *  skipped. TrackNotFound when the track is absent (raised in the recipe → no
 *  op_id). outline_width keeps the existing outline color (or BLACK if none). */
export function applyRestyleCaptionTrack(p: Project, trackId: Uuid, patch: CaptionStylePatch): void {
  const track = p.tracks.find((t) => t.id === trackId)
  if (!track) throw new CommandFailure({ error: 'TrackNotFound', track: trackId })
  for (const layer of track.layers) {
    if (layer.params.kind !== 'Text') continue
    const tp = layer.params
    if (patch.font_family !== undefined && patch.font_family !== null) tp.font.family = patch.font_family
    if (patch.font_size_px !== undefined && patch.font_size_px !== null) tp.font.size_px = patch.font_size_px
    if (patch.color !== undefined && patch.color !== null) tp.color = { mode: 'Static', value: patch.color }
    if (patch.outline_width !== undefined && patch.outline_width !== null) {
      const existingColor = tp.outline ? tp.outline.color : BLACK
      tp.outline = { color: existingColor, width: patch.outline_width }
    }
  }
}
```

- [ ] **Step 4: Run to verify they pass** — `npx vitest run src/main/state/mutations/captions.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/mutations/captions.ts apps/desktop/src/main/state/mutations/captions.test.ts
git commit -m "feat(state-migration): add_caption_track + restyle_caption_track ports (Phase 2b-vi)"
```

---

## Task 6: actor.ts caption dispatch arms

**Files:**
- Modify: `src/main/state/actor.ts`
- Test: `src/main/state/actor.test.ts`

**Interfaces:**
- Consumes: `applyAddCaptionTrack`/`applyRestyleCaptionTrack`/`Cue`/`CaptionStylePatch` from `./mutations/captions`.
- Produces: dispatch handles `add_caption_track` (returns the primary track id) + `restyle_caption_track`.

- [ ] **Step 1: Add failing dispatch tests** to `src/main/state/actor.test.ts`:

```ts
describe('dispatch: caption tracks', () => {
  const CLEAN = { size_px: 54, outline_px: 3, shadow_px: 2 }
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'cap')
    const actor = createActor({ idGen, initial, clock: () => '<TS>' })
    return { actor, a: initial.tracks[0].id }
  }
  it('add_caption_track creates a Caption track and returns its id', () => {
    const { actor } = setup()
    const r = actor.dispatch('add_caption_track', { cues: [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], comp_w: 1920, comp_h: 1080, label: 'Captions' })
    expect(r.ok).toBe(true)
    const tid = (r as { ok: true; value: string }).value
    const ct = actor.snapshot().tracks.find((t) => t.id === tid)!
    expect([ct.role, ct.layers[0].params.kind]).toEqual(['Caption', 'Text'])
  })
  it('add_caption_track is recorded → undo removes it', () => {
    const { actor } = setup()
    actor.dispatch('add_caption_track', { cues: [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], comp_w: 1920, comp_h: 1080, label: null })
    expect(actor.snapshot().tracks.some((t) => t.role === 'Caption')).toBe(true)
    actor.dispatch('undo')
    expect(actor.snapshot().tracks.some((t) => t.role === 'Caption')).toBe(false)
  })
  it('restyle_caption_track patches the Text layers', () => {
    const { actor } = setup()
    const tid = (actor.dispatch('add_caption_track', { cues: [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], comp_w: 1920, comp_h: 1080, label: null }) as { ok: true; value: string }).value
    const r = actor.dispatch('restyle_caption_track', { track: tid, patch: { font_size_px: 60 } })
    expect(r.ok).toBe(true)
    const ct = actor.snapshot().tracks.find((t) => t.id === tid)!
    expect((ct.layers[0].params as { font: { size_px: number } }).font.size_px).toBe(60)
  })
  it('restyle_caption_track on a missing track → TrackNotFound', () => {
    const { actor } = setup()
    const r = actor.dispatch('restyle_caption_track', { track: '00000000-0000-0000-0000-0000000000ff', patch: { font_size_px: 60 } })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('TrackNotFound')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (unsupported ops).

- [ ] **Step 3: Wire `actor.ts`.** Add the import (after the media import, line 23):
```ts
import { applyAddCaptionTrack, applyRestyleCaptionTrack, type Cue, type CaptionStylePatch } from './mutations/captions'
```
Add the dispatch arms (near the other recorded ops):
```ts
        case 'add_caption_track': return { ok: true, value: commit('Added caption track', [], { kind: 'Coarse' }, (d) => applyAddCaptionTrack(d, idGen, a.cues as Cue[], a.comp_w as number, a.comp_h as number, (a.label as string) ?? null)) }
        case 'restyle_caption_track': commit('Restyled caption track', [{ kind: 'Track', id: a.track as Uuid }], { kind: 'Coarse' }, (d) => applyRestyleCaptionTrack(d, a.track as Uuid, a.patch as CaptionStylePatch)); return { ok: true, value: null }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/actor.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): actor add_caption_track/restyle_caption_track dispatch (Phase 2b-vi)"
```

---

## Task 7: driver + vocab + corpus + regen for captions

**Files:**
- Modify: `src/main/state/replay.ts`
- Modify: `native/src/bin/replay_driver.rs`
- Create: 8 `fixtures/state-corpus/sequences/*.json`
- Generate: 8 `fixtures/state-corpus/oracle/*.json`
- Modify: `fixtures/state-corpus/README.md`

- [ ] **Step 1: Extend the TS vocabulary** (`replay.ts`). Add to `SUPPORTED_OPS`:
```ts
  'add_caption_track', 'restyle_caption_track',
```
Add to `buildArgs`:
```ts
    case 'add_caption_track': return { cues: cmd.cues, comp_w: cmd.comp_w, comp_h: cmd.comp_h, label: cmd.label ?? null }
    case 'restyle_caption_track': return { track: resolve(refs, cmd.track), patch: cmd.patch }
```

- [ ] **Step 2: Extend the Rust driver** (`replay_driver.rs`). Add these arms in `apply()`:
```rust
        "add_caption_track" => {
            let cues: Vec<_> = cmd["cues"].as_array().unwrap().iter().map(parse_cue).collect();
            let comp_w = cmd["comp_w"].as_u64().unwrap() as u32;
            let comp_h = cmd["comp_h"].as_u64().unwrap() as u32;
            h.add_caption_track(u, cues, comp_w, comp_h, cmd["label"].as_str().map(str::to_string)).await
                .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "restyle_caption_track" => {
            let patch: weftcut_lib::state::actor::CaptionStylePatch =
                serde_json::from_value(cmd["patch"].clone()).map_err(|e| e.to_string())?;
            h.restyle_caption_track(u, resolve_id(refs, cmd["track"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
```
Add these two helpers near `media_item` (bottom of the file). `CueStyle`/`Cue` have NO Deserialize derive, so build them manually (mirroring the TS cue JSON shape):
```rust
/// Rgba from a [r,g,b,a] JSON array (u8 components).
fn rgba_arr(v: &Value) -> Rgba {
    let a = v.as_array().unwrap();
    Rgba { r: a[0].as_u64().unwrap() as u8, g: a[1].as_u64().unwrap() as u8,
           b: a[2].as_u64().unwrap() as u8, a: a[3].as_u64().unwrap() as u8 }
}

/// Build a subtitles::Cue from the corpus cue JSON ({start_us,end_us,text,style?}).
/// style fields mirror CueStyle; colors are [r,g,b,a] arrays; pos is [x,y].
fn parse_cue(v: &Value) -> weftcut_lib::subtitles::Cue {
    use weftcut_lib::subtitles::{Cue, CueStyle};
    let style = match v.get("style") {
        Some(s) if !s.is_null() => CueStyle {
            font_family: s.get("font_family").and_then(|v| v.as_str()).map(str::to_string),
            size_px: s.get("size_px").and_then(|v| v.as_f64()).map(|n| n as f32),
            primary: s.get("primary").map(rgba_arr),
            bold: s.get("bold").and_then(|v| v.as_bool()).unwrap_or(false),
            italic: s.get("italic").and_then(|v| v.as_bool()).unwrap_or(false),
            outline_px: s.get("outline_px").and_then(|v| v.as_f64()).map(|n| n as f32),
            outline_color: s.get("outline_color").map(rgba_arr),
            shadow_px: s.get("shadow_px").and_then(|v| v.as_f64()).map(|n| n as f32),
            align: s.get("align").and_then(|v| v.as_u64()).map(|n| n as u8),
            pos: s.get("pos").map(|p| { let a = p.as_array().unwrap(); (a[0].as_f64().unwrap(), a[1].as_f64().unwrap()) }),
        },
        _ => CueStyle::default(),
    };
    Cue { start_us: v["start_us"].as_i64().unwrap(), end_us: v["end_us"].as_i64().unwrap(),
          text: v["text"].as_str().unwrap().to_string(), style }
}
```
> The corpus cue `style` uses `[r,g,b,a]` arrays for `primary`/`outline_color`, while `restyle_caption_track`'s `patch.color` uses the `{r,g,b,a}` OBJECT form (because `CaptionStylePatch` derives `Deserialize` and `Rgba` serializes as an object). Keep the two distinct — the corpus seqs below follow this.

- [ ] **Step 3: Author the 8 corpus sequences** in `fixtures/state-corpus/sequences/`. Every cue supplies explicit `size_px`/`outline_px`/`shadow_px` (the f32 keystone — never rely on the auto-multiply path for differential seqs):

`add-caption-track-single.json`:
```json
{ "name": "add-caption-track-single", "commands": [
  { "op": "add_caption_track", "ref": "ct", "comp_w": 1920, "comp_h": 1080, "label": "Captions",
    "cues": [ { "start_us": 0, "end_us": 1000000, "text": "Hello", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } } ] }
] }
```
`add-caption-track-multi-lane.json`:
```json
{ "name": "add-caption-track-multi-lane", "commands": [
  { "op": "add_caption_track", "ref": "ct", "comp_w": 1920, "comp_h": 1080, "label": "Captions",
    "cues": [
      { "start_us": 0, "end_us": 2000000, "text": "a", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } },
      { "start_us": 1000000, "end_us": 3000000, "text": "b", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } },
      { "start_us": 2000000, "end_us": 3000000, "text": "c", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } }
    ] }
] }
```
`add-caption-track-align.json` (two non-overlapping cues, same lane, align variants):
```json
{ "name": "add-caption-track-align", "commands": [
  { "op": "add_caption_track", "comp_w": 1920, "comp_h": 1080, "label": "Captions",
    "cues": [
      { "start_us": 0, "end_us": 1000000, "text": "top", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2, "align": 8 } },
      { "start_us": 1000000, "end_us": 2000000, "text": "botleft", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2, "align": 1 } }
    ] }
] }
```
`add-caption-track-pos.json`:
```json
{ "name": "add-caption-track-pos", "commands": [
  { "op": "add_caption_track", "comp_w": 1920, "comp_h": 1080, "label": null,
    "cues": [ { "start_us": 0, "end_us": 1000000, "text": "p", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2, "align": 5, "pos": [100, 200] } } ] }
] }
```
`add-caption-track-styled.json` (font_family + colors via [r,g,b,a] arrays + bold/italic):
```json
{ "name": "add-caption-track-styled", "commands": [
  { "op": "add_caption_track", "comp_w": 1920, "comp_h": 1080, "label": "Captions",
    "cues": [ { "start_us": 0, "end_us": 1000000, "text": "styled", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2, "font_family": "Arial", "bold": true, "italic": true, "primary": [255, 255, 0, 255], "outline_color": [0, 0, 255, 255] } } ] }
] }
```
`add-caption-track-empty.json`:
```json
{ "name": "add-caption-track-empty", "commands": [
  { "op": "add_caption_track", "comp_w": 1920, "comp_h": 1080, "label": "Empty", "cues": [] }
] }
```
`add-caption-track-undo.json` (recorded → undo removes it):
```json
{ "name": "add-caption-track-undo", "commands": [
  { "op": "add_caption_track", "comp_w": 1920, "comp_h": 1080, "label": "Captions",
    "cues": [ { "start_us": 0, "end_us": 1000000, "text": "x", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } } ] },
  { "op": "undo" }
] }
```
`restyle-caption-track.json`:
```json
{ "name": "restyle-caption-track", "commands": [
  { "op": "add_caption_track", "ref": "ct", "comp_w": 1920, "comp_h": 1080, "label": "Captions",
    "cues": [
      { "start_us": 0, "end_us": 1000000, "text": "a", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } },
      { "start_us": 1000000, "end_us": 2000000, "text": "b", "style": { "size_px": 54, "outline_px": 3, "shadow_px": 2 } }
    ] },
  { "op": "restyle_caption_track", "track": "@ct", "patch": { "font_family": "Arial", "font_size_px": 60, "color": { "r": 255, "g": 255, "b": 0, "a": 255 }, "outline_width": 4 } }
] }
```
`restyle-caption-track-not-found.json` (TrackNotFound burns no op_id → trailing add_layer id is unshifted):
```json
{ "name": "restyle-caption-track-not-found", "commands": [
  { "op": "restyle_caption_track", "track": "00000000-0000-0000-0000-0000000000ff", "patch": { "font_size_px": 60 } },
  { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 }
] }
```
> That is 9 files; commit all 9 (the README says "~8" — the styled variant is a useful 9th).

- [ ] **Step 4: Regenerate oracles** (from `apps/desktop/`, env vars per Global Constraints):
```bash
node scripts/gen-state-oracle.mjs
git status --short fixtures/state-corpus/oracle/   # MUST show only the 9 new (??) files, never M
```
If a pre-existing oracle shows `M`, STOP and investigate (additive invariant). **If a NEW caption oracle shows a float field (`size_px`/outline `width`/shadow offsets) that the TS replay does not reproduce**, the cause is the f32×f64 keystone — confirm every cue in that seq supplies explicit `size_px`/`outline_px`/`shadow_px` (no auto-multiply); positions/anchors are f64 on both sides and must match regardless.

- [ ] **Step 5: Run the differential gate** — `npx vitest run src/main/state/__tests__/differential.phase2.test.ts` → PASS (157/157, `skipped === []`). Then `npx vitest run src/main/state` → all green; `npm run typecheck` clean.

- [ ] **Step 6: Update the corpus README.** Replace the gap-#4 "Caption tracks ... deferred to later slices" entry with coverage rows, and remove the `| Caption tracks / params | deferred — later slices |` row:
```markdown
| add_caption_track single cue | add-caption-track-single.json |
| add_caption_track greedy lane-packing (overlap → 2 lanes, reuse) | add-caption-track-multi-lane.json |
| add_caption_track ASS align anchors (an8/an1) | add-caption-track-align.json |
| add_caption_track \pos override | add-caption-track-pos.json |
| add_caption_track styled cue (font/colors/bold/italic) | add-caption-track-styled.json |
| add_caption_track empty-cue safety net | add-caption-track-empty.json |
| add_caption_track recorded → undo | add-caption-track-undo.json |
| restyle_caption_track happy path | restyle-caption-track.json |
| restyle_caption_track TrackNotFound (no id burn) | restyle-caption-track-not-found.json |
```
Update the "Known gaps" section: caption tracks are now covered; the only remaining caption-adjacent gap is the **default-style (auto-`size*0.06`) layout path, which is f32×f64-fragile and is unit-tested (`captions.test.ts`), not differential-gated** — note this. The straggler tail (`rebind_motif`, `remove_media`, `set_media_derivatives`, `add_transient_track`, `replace_state`, `set_media_workspace_paths`, Motif `update_layer_params` clamp) stays listed as deferred.

- [ ] **Step 7: Commit.**
```bash
git add apps/desktop/src/main/state/replay.ts apps/desktop/native/src/bin/replay_driver.rs apps/desktop/fixtures/state-corpus/sequences/add-caption-track-single.json apps/desktop/fixtures/state-corpus/sequences/add-caption-track-multi-lane.json apps/desktop/fixtures/state-corpus/sequences/add-caption-track-align.json apps/desktop/fixtures/state-corpus/sequences/add-caption-track-pos.json apps/desktop/fixtures/state-corpus/sequences/add-caption-track-styled.json apps/desktop/fixtures/state-corpus/sequences/add-caption-track-empty.json apps/desktop/fixtures/state-corpus/sequences/add-caption-track-undo.json apps/desktop/fixtures/state-corpus/sequences/restyle-caption-track.json apps/desktop/fixtures/state-corpus/sequences/restyle-caption-track-not-found.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-single.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-multi-lane.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-align.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-pos.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-styled.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-empty.json apps/desktop/fixtures/state-corpus/oracle/add-caption-track-undo.json apps/desktop/fixtures/state-corpus/oracle/restyle-caption-track.json apps/desktop/fixtures/state-corpus/oracle/restyle-caption-track-not-found.json apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): caption tracks live + corpus (Phase 2b-vi)"
```

---

## Done criteria

- The differential gate (`differential.phase2.test.ts`) passes with `skipped === []` over the grown corpus (141 → 157), every pre-existing oracle byte-identical (additive regens only).
- The full `src/main/state` vitest suite is green; `npm run typecheck` clean.
- `add_caption_track`/`restyle_caption_track`/`set_role_gain`/`update_role_flags`/`update_project_settings` are all in `SUPPORTED_OPS`, the dispatch, and the Rust driver, with unit + differential coverage.
- Corpus README reflects the new coverage and the remaining straggler tail.

## Self-review notes (for the executor)

- **f32 keystone:** the ONE genuine risk. Differential caption cues MUST carry explicit `size_px`/`outline_px`/`shadow_px`. The auto-multiply path is unit-test-only by design.
- **id order in `add_caption_track`:** track-id-before-layer-id, per start-sorted cue. A drift here surfaces as an id mismatch on the FIRST multi-lane oracle step — re-check `newCaptionTrack` mints before `applyAddLayer`.
- **`affected`/summary strings** are HistoryEntry metadata, NOT in `serializeProject` → invisible to the gate; exact values don't matter for differential parity (only that recorded vs unrecorded is correct).
- **`removable: true`** on caption tracks comes from `Track::new()`'s default; if a multi-lane oracle diverges on `removable`, re-confirm track.rs:65 defaults.
