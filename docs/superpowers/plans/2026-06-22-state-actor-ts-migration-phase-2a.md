# State-Actor TS Migration — Phase 2a Plan (Group System + split_layer + Live Fan-Out)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is **Phase 2a** of the master plan `2026-06-22-state-actor-ts-migration.md` (Part 4, Phase 2). Read the master plan §2.1/§2.4 and the **Phase-1 plan** (`…-phase-1.md`) first — Phase 1 built the actor core, validator, history, Immer commit pipeline, the move/trim/delete/duplicate slice, the replay twin, and the differential gate, and wrote the group fan-out as **dead code**. Phase 2a turns it live and adds groups + split.

**Goal:** Port the group system (`groups_create/dissolve/add_members/remove_members/rename`) and `split_layer` to the TypeScript actor, make the move/trim group fan-out + lock checks **live**, and flip the differential gate so the 18 already-committed group/split oracle traces run and match the Rust oracle byte-for-byte.

**Architecture:** Same as Phase 1 — pure functions over an Immer draft, 1:1 with the Rust `apply_*` helpers; the actor's `commit` runs validate→record→emit. Phase 2a adds two new mutation modules (`mutations/groups.ts`, `mutations/split.ts`) plus a generic Animated-traversal helper module (`mutations/animated.ts`), centralizes the group helpers that Phase 1 stubbed locally in `move.ts`, and extends the string-dispatch + replay vocabulary. The differential harness is unchanged in shape; only the supported-op vocabulary grows, which automatically pulls the 18 deferred corpus sequences into the gate.

**Tech Stack:** TypeScript, Immer (already a dependency), Vitest, the existing `weftcut-eval` wasm leaf (`snapFrameRound` — UNCHANGED), the Phase-0/1 `model.ts`/`serialize.ts`/`canonical.ts`/`ids.ts`/`errors.ts`/`validate.ts`/`history.ts`/`actor.ts`, and the **already-committed** Rust oracle corpus (`apps/desktop/fixtures/state-corpus/`).

## Global Constraints

- **The wasm eval leaf is sacred.** Snapping uses `snapFrameRound` from `../snap` only — never reimplemented (`feedback_snap_math_drift`, `feedback_engine_source_drift`).
- **`Group.members` ⇒ keep SORTED in memory (by Uuid string).** Rust stores members as an `imbl::OrdSet<LayerId>` which iterates **sorted by Uuid**. `split_layer`'s group fan-out allocates a fresh right-half id **per spanning sibling, in member-iteration order** — so if TS iterates members in a different order than Rust, the right-half ids drift and the differential gate fails. The seeded id generator emits lexicographically-increasing UUID strings (`…0001`, `…0002`, …), so a plain `.sort()` on member strings reproduces Rust's OrdSet order exactly. **Every write to `members` (create, add, remove, split-insert) must re-sort.** `serialize.ts` already sorts members for the trace, but that does NOT fix in-memory iteration order during split — this constraint is about iteration, not serialization. **This is the single most important correctness rule in this phase.**
- **Deterministic id contract (unchanged from Phase 1, restated for the new mutations):**
  1. Entity-creating mutations (`groups_create`, `split_layer`'s right-halves) allocate their id(s) **inside the mutation, before validation** — a mutation that allocates an id then fails validation still consumes that id.
  2. `commit` allocates the op_id **after** `validate` succeeds. A failed validate consumes **no** op_id.
  3. `split_layer` allocates **one** right-half id for the target plus **one per spanning sibling**, in sorted member-iteration order (see the members-sorted constraint above).
  4. `groups_create` allocates **one** group id (after the dedup/existence/already-grouped checks pass, mirroring Rust order).
- **`CommandError` / `ValidationError` variant names match Rust exactly** (the differential harness compares the leading identifier of the Rust `Debug` string against the TS variant). All variants this phase needs (`SplitOutsideLayer`, `TrackLocked`, `GroupLockedMember`, `GroupCreateNeedsTwoLayers`, `LayerNotFound`, `LayerAlreadyGrouped`, `GroupNotFound`, `LayerNotInGroup`) are already in the Phase-1 `errors.ts` union.
- **Out-of-range keyframes are VALID** (`validate.rs:495-509`). Do NOT add keyframe bounds checks.
- **TimeUs is `number`.** No `bigint`.
- **Every commit message ends with the trailer line** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Parallel sessions:** the user edits this checkout from other sessions. `git add` by **explicit path only** (never `git add -A`/`.`); re-check `git status` before each commit (`feedback_parallel_sessions_git`).
- TDD, frequent commits, DRY, YAGNI.

### Phase-2a command vocabulary (what the actor gains this phase)

Adds `split_layer` and `groups_create` to the supported replay vocabulary (the only two new ops any committed corpus sequence uses — confirmed: no committed sequence uses explicit `groups_dissolve`, `groups_add_members`, `groups_remove_members`, or a lock op; those are driver/corpus extensions deferred to Phase 2b). The remaining group mutations (`groups_dissolve/add_members/remove_members/rename`) are **ported and unit-tested** this phase (cheap, completes the surface) but are **not corpus-gated**. The live move/trim/split group fan-out becomes reachable because `groups_create` can now create groups.

### Reference Rust sources (cite; only re-read if a differential step diverges)

- `native/src/state/actor/mutations.rs`: `group_siblings_excluding` (661-670), `check_group_lock` (677-704), `apply_split_layer` (714-789), `split_track_half` (797-811), `split_single_layer` (815-874), `apply_move_layer` fan-out (535-624), `apply_trim_layer` aligned-set (906-1062), group ops `apply_groups_*` (180-319), `layer_id_set` (321-329).
- `native/src/state/group.rs`: `index_groups` (LayerId→GroupId map), `Group` shape.
- `native/src/state/layer.rs`: `for_each_animated_f64` / `for_each_animated_rgba` (per-kind animated-track enumeration — operates on `LayerParams`, NOT effects).
- `native/src/state/animated.rs`: `first_keyframe_value` / `last_keyframe_value` / `retain_keyframes` / `shift_keyframes`.
- `native/src/bin/replay_driver.rs`: already handles `split_layer` (drops return), `groups_create` (drops return), `groups_dissolve`. Error format is `format!("{e:?}")`.

---

## File Structure

All paths under `apps/desktop/`. All vitest commands run from `apps/desktop/` (`npx vitest run <path>`). The vitest config loads the wasm via `src/renderer/testSetup.ts`, so `snapFrameRound` works in every `src/main` spec.

| Path | Responsibility | New / Modified |
|---|---|---|
| `src/main/state/mutations/animated.ts` | Generic `Animated<T>` traversal: `forEachAnimatedF64`, `forEachAnimatedRgba`, `shiftKeyframes`, `retainKeyframes`, `firstKeyframeValue`, `lastKeyframeValue`, `collapseToStatic`. Mirrors `layer.rs` + `animated.rs`. | **New** |
| `src/main/state/mutations/groups.ts` | Group helpers (`indexGroups`, `groupSiblingsExcluding`, `checkGroupLock`, `layerIdSet`) + group mutations (`applyGroupsCreate/Dissolve/AddMembers/RemoveMembers/Rename`). | **New** |
| `src/main/state/mutations/split.ts` | `splitTrackHalf`, `splitSingleLayer`, `applySplitLayer` (group spanning fan-out). | **New** |
| `src/main/state/mutations/helpers.ts` | Refactor `shiftLayerKeyframes` to delegate to `animated.ts` (DRY); no behavior change. | Modify |
| `src/main/state/mutations/move.ts` | Replace local `groupSiblingsExcluding` with the shared one; add the `checkGroupLock` call before fan-out. | Modify |
| `src/main/state/mutations/trim.ts` | Add the live group aligned-set branch + `checkGroupLock`; drop the `void escapeGroup` stub. | Modify |
| `src/main/state/actor.ts` | Add `split_layer`, `groups_create`, `groups_dissolve`, `groups_add_members`, `groups_remove_members`, `groups_rename` dispatch arms. | Modify |
| `src/main/state/replay.ts` | Add `split_layer`, `groups_create` to `SUPPORTED_OPS` + `buildArgs`. | Modify |
| `src/main/state/__tests__/differential.phase2.test.ts` | Phase-2a gate: assert the FULL corpus is in-vocabulary (skipped==0) and matches the oracle. | **New** |
| `fixtures/state-corpus/README.md` | Move `split_layer` / `groups_create` / group fan-out out of "GAPS"; keep the genuinely-deferred items (explicit dissolve, custom-track ref, lock op, media, caption, effects, history cap). | Modify |

---

## Task 1: Animated traversal helpers (`mutations/animated.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/animated.ts`
- Test: `apps/desktop/src/main/state/mutations/animated.test.ts`

**Interfaces:**
- Consumes: `Animated`, `Keyframe`, `LayerParams` from `../model`.
- Produces:
  - `forEachAnimatedF64(params: LayerParams, fn: (a: Animated<number>) => void): void` — visits every `Animated<number>` track on the params (opacity + the 5 transform tracks for visual kinds; gain_db+pan for Audio; none for Color). Mirrors `layer.rs:for_each_animated_f64` (params-level only — NOT effects).
  - `forEachAnimatedRgba(params: LayerParams, fn: (a: Animated<Rgba>) => void): void` — visits the `Animated<Rgba>` color track (Color, Text); none for others.
  - `shiftKeyframes<T>(a: Animated<T>, deltaUs: number): void` — adds `deltaUs` to each keyframe's `t_us` (no-op on Static).
  - `retainKeyframes<T>(a: Animated<T>, pred: (tUs: number) => boolean): void` — keep keyframes whose `t_us` satisfies `pred` (no-op on Static).
  - `firstKeyframeValue<T>(a: Animated<T>): T | null` / `lastKeyframeValue<T>(a: Animated<T>): T | null` — Static→its value; Keyframed→first/last keyframe value, or `null` when empty.
  - `collapseToStatic<T>(a: Animated<T>, value: T): void` — mutate `a` in place into `{ mode: 'Static', value }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/animated.test.ts
import { describe, it, expect } from 'vitest'
import type { Animated, LayerParams } from '../model'
import {
  forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes, retainKeyframes,
  firstKeyframeValue, lastKeyframeValue, collapseToStatic,
} from './animated'

function kf<T>(id: string, t: number, v: T): { id: string; t_us: number; value: T; interp: { kind: 'Linear' } } {
  return { id, t_us: t, value: v, interp: { kind: 'Linear' } }
}

describe('animated traversal', () => {
  it('shiftKeyframes shifts Keyframed, no-ops Static', () => {
    const a: Animated<number> = { mode: 'Keyframed', value: [kf('k', 100, 1), kf('k2', 200, 2)] }
    shiftKeyframes(a, -50)
    expect((a as any).value.map((k: any) => k.t_us)).toEqual([50, 150])
    const s: Animated<number> = { mode: 'Static', value: 5 }
    shiftKeyframes(s, 99); expect(s).toEqual({ mode: 'Static', value: 5 })
  })

  it('retainKeyframes filters by t_us', () => {
    const a: Animated<number> = { mode: 'Keyframed', value: [kf('a', 0, 1), kf('b', 100, 2), kf('c', 200, 3)] }
    retainKeyframes(a, (t) => t > 50)
    expect((a as any).value.map((k: any) => k.t_us)).toEqual([100, 200])
  })

  it('first/last keyframe value: Static→value, Keyframed→ends, empty→null', () => {
    expect(firstKeyframeValue({ mode: 'Static', value: 7 })).toBe(7)
    expect(lastKeyframeValue({ mode: 'Static', value: 7 })).toBe(7)
    const a: Animated<number> = { mode: 'Keyframed', value: [kf('a', 0, 1), kf('b', 100, 2)] }
    expect(firstKeyframeValue(a)).toBe(1); expect(lastKeyframeValue(a)).toBe(2)
    const e: Animated<number> = { mode: 'Keyframed', value: [] }
    expect(firstKeyframeValue(e)).toBeNull(); expect(lastKeyframeValue(e)).toBeNull()
  })

  it('collapseToStatic rewrites mode + value in place', () => {
    const a: Animated<number> = { mode: 'Keyframed', value: [] }
    collapseToStatic(a, 42)
    expect(a).toEqual({ mode: 'Static', value: 42 })
  })

  it('forEachAnimatedF64 visits opacity + 5 transform tracks on Text, none on Color', () => {
    const text: LayerParams = {
      kind: 'Text', content: 'x', font: {} as any, color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } },
      align: 'left' as any,
      transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0, 0] } as any,
      opacity: { mode: 'Static', value: 1 }, shadow: null, outline: null,
    }
    let n = 0; forEachAnimatedF64(text, () => { n++ }); expect(n).toBe(6) // opacity + x,y,sx,sy,rot
    const color: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
    let m = 0; forEachAnimatedF64(color, () => { m++ }); expect(m).toBe(0)
  })

  it('forEachAnimatedRgba visits color on Color/Text, none on Audio', () => {
    const color: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 1, g: 2, b: 3, a: 4 } }, width: 1, height: 1 }
    let n = 0; forEachAnimatedRgba(color, () => { n++ }); expect(n).toBe(1)
    const audio: LayerParams = { kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 1, gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 }, fade_in_us: 0, fade_out_us: 0, mute: false, role: 'music' } as any
    let z = 0; forEachAnimatedRgba(audio, () => { z++ }); expect(z).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/animated.test.ts`
Expected: FAIL — `Cannot find module './animated'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/desktop/src/main/state/mutations/animated.ts
import type { Animated, Keyframe, LayerParams, Rgba } from '../model'

/** Mirror native/src/state/layer.rs:for_each_animated_f64 — every Animated<f64>
 *  track stored on the params (opacity + the 5 transform tracks for visual kinds;
 *  gain_db + pan for Audio). Operates on params ONLY (effects are not traversed by
 *  the Rust split/trim path). */
export function forEachAnimatedF64(p: LayerParams, fn: (a: Animated<number>) => void): void {
  switch (p.kind) {
    case 'Color': break
    case 'Text': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'VideoClip': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'ImageOverlay': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'Motif': fn(p.opacity); forEachTransformF64(p.transform, fn); break
    case 'Audio': fn(p.gain_db); fn(p.pan); break
  }
}
function forEachTransformF64(t: { x: Animated<number>; y: Animated<number>; scale_x: Animated<number>; scale_y: Animated<number>; rotation_deg: Animated<number> }, fn: (a: Animated<number>) => void): void {
  fn(t.x); fn(t.y); fn(t.scale_x); fn(t.scale_y); fn(t.rotation_deg)
}

/** Mirror native/src/state/layer.rs:for_each_animated_rgba — the color track on
 *  Color and Text. (Animated<Rgba> is stored but never interpolated in v1.) */
export function forEachAnimatedRgba(p: LayerParams, fn: (a: Animated<Rgba>) => void): void {
  switch (p.kind) {
    case 'Color': fn(p.color); break
    case 'Text': fn(p.color); break
    default: break
  }
}

export function shiftKeyframes<T>(a: Animated<T>, deltaUs: number): void {
  if (a.mode === 'Keyframed') for (const k of a.value as Keyframe<T>[]) k.t_us += deltaUs
}
export function retainKeyframes<T>(a: Animated<T>, pred: (tUs: number) => boolean): void {
  if (a.mode === 'Keyframed') a.value = (a.value as Keyframe<T>[]).filter((k) => pred(k.t_us))
}
export function firstKeyframeValue<T>(a: Animated<T>): T | null {
  if (a.mode === 'Static') return a.value
  const kfs = a.value as Keyframe<T>[]
  return kfs.length ? kfs[0].value : null
}
export function lastKeyframeValue<T>(a: Animated<T>): T | null {
  if (a.mode === 'Static') return a.value
  const kfs = a.value as Keyframe<T>[]
  return kfs.length ? kfs[kfs.length - 1].value : null
}
/** Rewrite `a` in place into Static(value) — used to collapse an emptied
 *  Keyframed half (animated.rs split semantics). */
export function collapseToStatic<T>(a: Animated<T>, value: T): void {
  const m = a as { mode: 'Static'; value: T }
  m.mode = 'Static'; m.value = value
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/animated.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `helpers.ts:shiftLayerKeyframes` to use `forEachAnimatedF64`/`forEachAnimatedRgba` (DRY, no behavior change)**

Replace the body of `shiftLayerKeyframes` and delete the now-unused private `shiftAnimated`/`shiftTransform`:

```ts
// in apps/desktop/src/main/state/mutations/helpers.ts — replace shiftLayerKeyframes + its private shiftAnimated/shiftTransform
import { forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes } from './animated'

/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). All-Static in the Phase-2a corpus, so this is a no-op there; written
 *  for fidelity with mutations.rs. */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  forEachAnimatedF64(params, (a) => shiftKeyframes(a, deltaUs))
  forEachAnimatedRgba(params, (a) => shiftKeyframes(a, deltaUs))
}
```

(Remove the `Animated`/`Keyframe` imports from `helpers.ts` if they become unused after this; keep `Animated` only if other helpers still reference it.)

- [ ] **Step 6: Run the helpers + trim tests to confirm no regression**

Run: `npx vitest run src/main/state/mutations/helpers.test.ts src/main/state/mutations/trim.test.ts`
Expected: PASS (the refactor is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/state/mutations/animated.ts apps/desktop/src/main/state/mutations/animated.test.ts apps/desktop/src/main/state/mutations/helpers.ts
git commit -m "feat(state-migration): Animated traversal helpers + DRY shiftLayerKeyframes (Phase 2a)"
```

---

## Task 2: Group helpers (`mutations/groups.ts` — read side)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/groups.ts`
- Test: `apps/desktop/src/main/state/mutations/groups.test.ts`

**Interfaces:**
- Consumes: model types; `CommandFailure` from `../errors`; `locateLayer` from `./helpers`.
- Produces:
  - `indexGroups(groups: Group[]): Map<Uuid, Uuid>` — member layer id → owning group id (mirrors `group.rs:index_groups`).
  - `groupSiblingsExcluding(p: Project, id: Uuid): Uuid[]` — all other members of `id`'s group, in **sorted member order** (empty when ungrouped). Mirrors `mutations.rs:661-670`.
  - `checkGroupLock(p: Project, anchor: Uuid, touched: Iterable<Uuid>): void` — throws `TrackLocked` / `GroupLockedMember`; no-op when the anchor is ungrouped. Mirrors `mutations.rs:677-704`.
  - `layerIdSet(p: Project): Set<Uuid>` — all layer ids across all tracks. Mirrors `mutations.rs:321-329`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/groups.test.ts (read-side helpers)
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { indexGroups, groupSiblingsExcluding, checkGroupLock, layerIdSet } from './groups'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function withTwo(): Project {
  const p = blankProject(seededGen(), 't')
  p.tracks[0].layers = [color('a', 0, 100), color('b', 200, 300)]
  p.groups = [{ id: 'g', members: ['a', 'b'] }]
  return p
}

describe('group read-side helpers', () => {
  it('indexGroups maps each member to its group', () => {
    const m = indexGroups([{ id: 'g', members: ['a', 'b'] }])
    expect(m.get('a')).toBe('g'); expect(m.get('b')).toBe('g'); expect(m.get('x')).toBeUndefined()
  })
  it('groupSiblingsExcluding returns the other members, sorted, [] when ungrouped', () => {
    const p = withTwo()
    expect(groupSiblingsExcluding(p, 'a')).toEqual(['b'])
    expect(groupSiblingsExcluding(p, 'b')).toEqual(['a'])
    p.groups = []
    expect(groupSiblingsExcluding(p, 'a')).toEqual([])
  })
  it('layerIdSet collects all layer ids', () => {
    const p = withTwo(); expect([...layerIdSet(p)].sort()).toEqual(['a', 'b'])
  })
  it('checkGroupLock: ungrouped anchor is a no-op', () => {
    const p = withTwo(); p.groups = []
    expect(() => checkGroupLock(p, 'a', ['a', 'b'])).not.toThrow()
  })
  it('checkGroupLock throws GroupLockedMember when a touched member is layer-locked', () => {
    const p = withTwo(); p.tracks[0].layers[1].locked = true // 'b' locked
    try { checkGroupLock(p, 'a', ['a', 'b']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
  it('checkGroupLock throws TrackLocked when a touched member sits on a locked track', () => {
    const p = withTwo()
    // move 'b' to B-roll and lock that track
    p.tracks[0].layers = [color('a', 0, 100)]
    p.tracks[1].layers = [color('b', 200, 300)]; p.tracks[1].locked = true
    try { checkGroupLock(p, 'a', ['a', 'b']); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/groups.test.ts`
Expected: FAIL — `Cannot find module './groups'`.

- [ ] **Step 3: Write the implementation (read-side only for now)**

```ts
// apps/desktop/src/main/state/mutations/groups.ts
import type { Group, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { locateLayer } from './helpers'

/** group.rs:index_groups — member LayerId → owning GroupId. */
export function indexGroups(groups: Group[]): Map<Uuid, Uuid> {
  const m = new Map<Uuid, Uuid>()
  for (const g of groups) for (const member of g.members) m.set(member, g.id)
  return m
}

/** mutations.rs:321-329 — every layer id across all tracks. */
export function layerIdSet(p: Project): Set<Uuid> {
  const s = new Set<Uuid>()
  for (const t of p.tracks) for (const l of t.layers) s.add(l.id)
  return s
}

/** mutations.rs:661-670 — all OTHER members of `id`'s group, in sorted member
 *  order (Rust OrdSet iteration order). Empty when ungrouped. The sort is the
 *  id-allocation-order guarantee for split fan-out (see plan Global Constraints). */
export function groupSiblingsExcluding(p: Project, id: Uuid): Uuid[] {
  const idx = indexGroups(p.groups)
  const gid = idx.get(id)
  if (gid === undefined) return []
  const group = p.groups.find((g) => g.id === gid)
  if (!group) return []
  return [...group.members].filter((m) => m !== id).sort()
}

/** mutations.rs:677-704 — reject if any `touched` member is layer-locked or on a
 *  locked track. No-op when `anchor` is ungrouped. */
export function checkGroupLock(p: Project, anchor: Uuid, touched: Iterable<Uuid>): void {
  const idx = indexGroups(p.groups)
  const gid = idx.get(anchor)
  if (gid === undefined) return
  for (const id of touched) {
    const loc = locateLayer(p, id)
    if (!loc) continue
    const track = p.tracks[loc[0]]
    if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
    const layer = track.layers[loc[1]]
    if (layer.locked) throw new CommandFailure({ error: 'GroupLockedMember', group: gid, locked_layer: id, touched: anchor })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/groups.ts apps/desktop/src/main/state/mutations/groups.test.ts
git commit -m "feat(state-migration): group read-side helpers (indexGroups/siblings/lock-check)"
```

---

## Task 3: Group mutations (`mutations/groups.ts` — write side)

**Files:**
- Modify: `apps/desktop/src/main/state/mutations/groups.ts`
- Test: `apps/desktop/src/main/state/mutations/groups.mutations.test.ts`

**Interfaces:**
- Consumes: `IdGen` from `../ids`; `dropLayerFromGroups` from `./helpers`; the read-side helpers from Task 2.
- Produces (all mutate a `Project` draft):
  - `applyGroupsCreate(p, idGen, layerIds: Uuid[], label: string | null, reassign: boolean): Uuid` — mirrors `mutations.rs:180-219`.
  - `applyGroupsDissolve(p, id: Uuid): void` — `mutations.rs:221-232`.
  - `applyGroupsAddMembers(p, id: Uuid, layerIds: Uuid[], reassign: boolean): void` — `mutations.rs:234-277`.
  - `applyGroupsRemoveMembers(p, id: Uuid, layerIds: Uuid[]): void` — `mutations.rs:279-305` (auto-dissolve below 2).
  - `applyGroupsRename(p, id: Uuid, label: string | null): void` — `mutations.rs:307-319`.

**Note on `label`:** the wire shape omits `label` when absent (serde `skip_serializing_if`, mirrored in `serialize.ts`). In the editable model `Group.label` is `string | undefined`. When the arg is `null`, store `undefined` (i.e., do not set the field) so the serialized group matches the Rust `Option::None` (omitted). Construct groups as `{ id, members }` and add `label` only when a non-null string is provided.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/groups.mutations.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyGroupsCreate, applyGroupsDissolve, applyGroupsAddMembers, applyGroupsRemoveMembers, applyGroupsRename } from './groups'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function withLayers(ids: string[]): Project {
  const p = blankProject(seededGen(), 't')
  p.tracks[0].layers = ids.map((id, i) => color(id, i * 1000, i * 1000 + 500))
  return p
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('group mutations', () => {
  it('create: rejects < 2 unique members', () => {
    const p = withLayers(['a'])
    expectCmd(() => applyGroupsCreate(p, seededGen(), ['a', 'a'], null, false), 'GroupCreateNeedsTwoLayers')
  })
  it('create: rejects a missing member', () => {
    const p = withLayers(['a', 'b'])
    expectCmd(() => applyGroupsCreate(p, seededGen(), ['a', 'ghost'], null, false), 'LayerNotFound')
  })
  it('create: makes a group with sorted members; label omitted when null', () => {
    const p = withLayers(['a', 'b'])
    const gen = seededGen()
    const gid = applyGroupsCreate(p, gen, ['b', 'a'], null, false)
    expect(p.groups.length).toBe(1)
    expect(p.groups[0].id).toBe(gid)
    expect([...p.groups[0].members].sort()).toEqual(['a', 'b'])
    expect('label' in p.groups[0]).toBe(false) // null → field omitted (serde None parity)
  })
  it('create: rejects an already-grouped layer unless reassign', () => {
    const p = withLayers(['a', 'b', 'c'])
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    expectCmd(() => applyGroupsCreate(p, seededGen(), ['b', 'c'], null, false), 'LayerAlreadyGrouped')
    // reassign moves 'b' to the new group; old group drops to 1 member → auto-dissolves
    applyGroupsCreate(p, seededGen(), ['b', 'c'], 'L', true)
    expect(p.groups.length).toBe(1)
    expect([...p.groups[0].members].sort()).toEqual(['b', 'c'])
    expect(p.groups[0].label).toBe('L')
  })
  it('dissolve: removes the group, errors when missing', () => {
    const p = withLayers(['a', 'b'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyGroupsDissolve(p, gid); expect(p.groups.length).toBe(0)
    expectCmd(() => applyGroupsDissolve(p, gid), 'GroupNotFound')
  })
  it('addMembers: adds, rejects already-grouped unless reassign', () => {
    const p = withLayers(['a', 'b', 'c'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyGroupsAddMembers(p, gid, ['c'], false)
    expect([...p.groups[0].members].sort()).toEqual(['a', 'b', 'c'])
    expectCmd(() => applyGroupsAddMembers(p, 'nope', ['a'], false), 'GroupNotFound')
  })
  it('removeMembers: removes, auto-dissolves below 2, errors on non-member', () => {
    const p = withLayers(['a', 'b', 'c'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b', 'c'], null, false)
    applyGroupsRemoveMembers(p, gid, ['c'])
    expect([...p.groups[0].members].sort()).toEqual(['a', 'b'])
    expectCmd(() => applyGroupsRemoveMembers(p, gid, ['ghost']), 'LayerNotInGroup')
    applyGroupsRemoveMembers(p, gid, ['b']) // drops to 1 → dissolve
    expect(p.groups.length).toBe(0)
  })
  it('rename: sets label, errors when missing', () => {
    const p = withLayers(['a', 'b'])
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyGroupsRename(p, gid, 'Scene 1'); expect(p.groups[0].label).toBe('Scene 1')
    expectCmd(() => applyGroupsRename(p, 'nope', 'x'), 'GroupNotFound')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/groups.mutations.test.ts`
Expected: FAIL — the `applyGroups*` exports don't exist yet.

- [ ] **Step 3: Append the write-side implementation to `groups.ts`**

> Port `mutations.rs:180-319` exactly. Read that range if any test diverges. `members` is kept sorted on every write (Global Constraint). `reassign` calls `dropLayerFromGroups` (which auto-dissolves prior groups below 2) BEFORE inserting.

```ts
// append to apps/desktop/src/main/state/mutations/groups.ts
import type { IdGen } from '../ids'
import { dropLayerFromGroups } from './helpers'

function sortedUnique(ids: Uuid[]): Uuid[] { return [...new Set(ids)].sort() }

/** mutations.rs:180-219 */
export function applyGroupsCreate(p: Project, idGen: IdGen, layerIds: Uuid[], label: string | null, reassign: boolean): Uuid {
  const unique = sortedUnique(layerIds)
  if (unique.length < 2) throw new CommandFailure({ error: 'GroupCreateNeedsTwoLayers', got: unique.length })
  const known = layerIdSet(p)
  for (const m of unique) if (!known.has(m)) throw new CommandFailure({ error: 'LayerNotFound', layer: m })
  const idx = indexGroups(p.groups)
  for (const m of unique) {
    const existing = idx.get(m)
    if (existing !== undefined && !reassign) throw new CommandFailure({ error: 'LayerAlreadyGrouped', layer: m, existing })
  }
  if (reassign) for (const m of unique) dropLayerFromGroups(p, m)
  const id = idGen()
  const group: Group = label === null ? { id, members: unique } : { id, label, members: unique }
  p.groups.push(group)
  return id
}

/** mutations.rs:221-232 */
export function applyGroupsDissolve(p: Project, id: Uuid): void {
  const i = p.groups.findIndex((g) => g.id === id)
  if (i < 0) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  p.groups.splice(i, 1)
}

/** mutations.rs:234-277 */
export function applyGroupsAddMembers(p: Project, id: Uuid, layerIds: Uuid[], reassign: boolean): void {
  const unique = sortedUnique(layerIds)
  const known = layerIdSet(p)
  for (const m of unique) if (!known.has(m)) throw new CommandFailure({ error: 'LayerNotFound', layer: m })
  const target = p.groups.find((g) => g.id === id)
  if (!target) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  const idx = indexGroups(p.groups)
  for (const m of unique) {
    const existing = idx.get(m)
    if (existing !== undefined && existing !== id && !reassign) throw new CommandFailure({ error: 'LayerAlreadyGrouped', layer: m, existing })
  }
  if (reassign) for (const m of unique) { if (idx.get(m) !== id) dropLayerFromGroups(p, m) }
  // re-find target: dropLayerFromGroups may have spliced groups (never the target, which keeps ≥1 here)
  const t = p.groups.find((g) => g.id === id)!
  t.members = sortedUnique([...t.members, ...unique])
}

/** mutations.rs:279-305 — remove members; auto-dissolve below 2. */
export function applyGroupsRemoveMembers(p: Project, id: Uuid, layerIds: Uuid[]): void {
  const i = p.groups.findIndex((g) => g.id === id)
  if (i < 0) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  const g = p.groups[i]
  for (const m of layerIds) if (!g.members.includes(m)) throw new CommandFailure({ error: 'LayerNotInGroup', group: id, layer: m })
  g.members = g.members.filter((m) => !layerIds.includes(m))
  if (g.members.length < 2) p.groups.splice(i, 1)
}

/** mutations.rs:307-319 */
export function applyGroupsRename(p: Project, id: Uuid, label: string | null): void {
  const g = p.groups.find((x) => x.id === id)
  if (!g) throw new CommandFailure({ error: 'GroupNotFound', group: id })
  if (label === null) delete g.label
  else g.label = label
}
```

> **Verify against Rust before finalizing:** confirm the `reassign` ordering in `apply_groups_create`/`apply_groups_add_members` (does Rust check already-grouped THEN drop, or drop unconditionally?) and the exact auto-dissolve threshold in `apply_groups_remove_members`. The structure above matches the agent inventory; if a unit test or the differential gate (Task 8) diverges on a group sequence, re-read `mutations.rs:180-319` and align.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/groups.mutations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/groups.ts apps/desktop/src/main/state/mutations/groups.mutations.test.ts
git commit -m "feat(state-migration): group mutations (create/dissolve/add/remove/rename)"
```

---

## Task 4: `split_layer` (`mutations/split.ts`)

**Files:**
- Create: `apps/desktop/src/main/state/mutations/split.ts`
- Test: `apps/desktop/src/main/state/mutations/split.test.ts`

**Interfaces:**
- Consumes: model types; `IdGen`; `snapFrameRound` from `../snap`; `locateLayer` from `./helpers`; `groupSiblingsExcluding`, `checkGroupLock`, `indexGroups` from `./groups`; the animated helpers from `./animated`; `CommandFailure`.
- Produces:
  - `applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUs: number, escapeGroup: boolean): { left: Uuid; right: Uuid }` — mirrors `mutations.rs:714-789`.
  - (module-private) `splitSingleLayer(p, idGen, id, atTUs): { left: Uuid; right: Uuid }` (815-874) and `splitTrackHalf(a, splitOffset, right)` (797-811).

**Phase-2a scope note:** the corpus is media-free and keyframe-free (color/text, all Static params). So the `src_in/src_out` partition (VideoClip/Audio) and the keyframe retain/collapse paths are exercised only by **unit tests** here, not by the differential gate. Port them faithfully anyway — Phase 2b's media corpus will gate them. Motif cap handling: there is no Motif in the Phase-2a corpus; mirror the Rust guard but you may treat `motifCapUs` as always-`null` for now (a `// Phase 2b: real motif cap` marker), since the corpus never constructs a capped Motif. Keep the `_capped` branch shape so the Phase-2b port is a one-line change.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/src/main/state/mutations/split.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applySplitLayer } from './split'
import { applyGroupsCreate } from './groups'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function one(): Project {
  const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 1_000_000)]; return p
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}

describe('applySplitLayer', () => {
  it('splits a layer into left[0,t) + right[t,end); right gets a fresh id; left keeps id', () => {
    const p = one()
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, false)
    expect(r.left).toBe('a')
    const layers = p.tracks[0].layers
    expect(layers.length).toBe(2)
    expect(layers[0].id).toBe('a'); expect(layers[0].t_start_us).toBe(0)
    expect(layers[1].id).toBe(r.right)
    expect(layers[1].t_start_us).toBe(layers[0].t_end_us) // contiguous at the split point
    expect(layers[1].t_end_us).toBe(1_000_000)
  })
  it('rejects a split at/outside the layer bounds', () => {
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 0, false), 'SplitOutsideLayer')
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 1_000_000, false), 'SplitOutsideLayer')
    expectCmd(() => applySplitLayer(one(), seededGen(), 'a', 2_000_000, false), 'SplitOutsideLayer')
  })
  it('rejects a missing layer and a locked track', () => {
    expectCmd(() => applySplitLayer(one(), seededGen(), 'ghost', 100, false), 'LayerNotFound')
    const p = one(); p.tracks[0].locked = true
    expectCmd(() => applySplitLayer(p, seededGen(), 'a', 400_000, false), 'TrackLocked')
  })
  it('partitions src_in/src_out for media kinds', () => {
    const p = blankProject(seededGen(), 't')
    const vid: Layer = { id: 'v', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {},
      params: { kind: 'VideoClip', media: 'm', src_in_us: 500_000, src_out_us: 1_500_000, transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0, 0] } as any, opacity: { mode: 'Static', value: 1 }, crop: null } as any, effects: [] }
    p.tracks[0].layers = [vid]
    applySplitLayer(p, seededGen(), 'v', 400_000, false) // offset 400_000
    const [l, rr] = p.tracks[0].layers as any
    expect(l.params.src_out_us).toBe(900_000)  // src_in(500k) + offset(400k)
    expect(rr.params.src_in_us).toBe(900_000)  // src_in(500k) + offset(400k)
    expect(rr.params.src_out_us).toBe(1_500_000)
  })
  it('group spanning split: both halves stay in the group; non-spanning members untouched', () => {
    const p = blankProject(seededGen(), 't')
    // a:[0,1s] and b:[0,1s] on track A grouped; both span t=400k
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    const r = applySplitLayer(p, seededGen(), 'a', 400_000, false)
    const group = p.groups.find((g) => g.id === gid)!
    // a's right-half + b's right-half both joined the group → 4 members
    expect(group.members.length).toBe(4)
    expect(group.members).toContain(r.right)
    expect(p.tracks[1].layers.length).toBe(2) // b was spanning → split too
  })
  it('escape_group splits only the target, leaves siblings whole', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    const gid = applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applySplitLayer(p, seededGen(), 'a', 400_000, true)
    expect(p.tracks[1].layers.length).toBe(1) // b untouched
    expect(p.groups.find((g) => g.id === gid)!.members.length).toBe(2) // unchanged
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/state/mutations/split.test.ts`
Expected: FAIL — `Cannot find module './split'`.

- [ ] **Step 3: Write the implementation**

> Port `mutations.rs:714-874` exactly. Mind the snap-on-entry, the strict-containment spanning filter, the lock check over `[id, ...spanning]`, and inserting the right half at `li+1`. **Spanning siblings are iterated in `groupSiblingsExcluding` (sorted) order → id allocation order matches Rust OrdSet.**

```ts
// apps/desktop/src/main/state/mutations/split.ts
import type { Animated, Layer, Project, Uuid } from '../model'
import type { IdGen } from '../ids'
import { snapFrameRound } from '../snap'
import { CommandFailure } from '../errors'
import { locateLayer } from './helpers'
import { groupSiblingsExcluding, checkGroupLock, indexGroups } from './groups'
import { forEachAnimatedF64, forEachAnimatedRgba, retainKeyframes, shiftKeyframes, firstKeyframeValue, lastKeyframeValue, collapseToStatic } from './animated'

/** mutations.rs:797-811 — partition one Animated<T> track for a split at the
 *  clip-local `splitOffset`. LEFT keeps t<=offset; RIGHT keeps t>offset, rebased
 *  by -offset. An emptied Keyframed half collapses to Static at the boundary value
 *  (LEFT→first, RIGHT→last). */
function splitTrackHalf<T>(a: Animated<T>, splitOffset: number, right: boolean): void {
  const boundary = right ? lastKeyframeValue(a) : firstKeyframeValue(a)
  if (right) { retainKeyframes(a, (t) => t > splitOffset); shiftKeyframes(a, -splitOffset) }
  else { retainKeyframes(a, (t) => t <= splitOffset) }
  if (a.mode === 'Keyframed' && a.value.length === 0 && boundary !== null) collapseToStatic(a, boundary)
}

/** mutations.rs:815-874 — single-layer split (group-unaware). Returns {left,right};
 *  left reuses the original id, right gets a fresh one and is inserted at li+1. */
function splitSingleLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number): { left: Uuid; right: Uuid } {
  const atTUs = snapFrameRound(atTUsRaw, p.composition.fps.num, p.composition.fps.den)
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  const original = p.tracks[ti].layers[li]
  if (atTUs <= original.t_start_us || atTUs >= original.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })
  const splitOffset = atTUs - original.t_start_us

  // RIGHT half — fresh id, [atTUs, original.t_end].
  const right = JSON.parse(JSON.stringify(original)) as Layer // Immer-draft-safe deep clone (see duplicate.ts)
  right.id = idGen()
  right.t_start_us = atTUs
  right.t_end_us = original.t_end_us
  // Phase 2a: no Motif cap in the corpus; capped===false. Phase 2b wires motifCapUs.
  const rightCapped = false
  if (right.params.kind === 'VideoClip' || right.params.kind === 'Audio') right.params.src_in_us += splitOffset
  else if (right.params.kind === 'Motif' && rightCapped) right.params.src_in_us += splitOffset
  forEachAnimatedF64(right.params, (a) => splitTrackHalf(a, splitOffset, true))
  forEachAnimatedRgba(right.params, (a) => splitTrackHalf(a, splitOffset, true))

  // LEFT half — reuses original id, [original.t_start, atTUs].
  const left = JSON.parse(JSON.stringify(original)) as Layer
  left.t_end_us = atTUs
  if (left.params.kind === 'VideoClip' || left.params.kind === 'Audio') left.params.src_out_us = left.params.src_in_us + splitOffset
  forEachAnimatedF64(left.params, (a) => splitTrackHalf(a, splitOffset, false))
  forEachAnimatedRgba(left.params, (a) => splitTrackHalf(a, splitOffset, false))

  p.tracks[ti].layers[li] = left
  p.tracks[ti].layers.splice(li + 1, 0, right)
  return { left: id, right: right.id }
}

/** mutations.rs:714-789 — split with group spanning fan-out. */
export function applySplitLayer(p: Project, idGen: IdGen, id: Uuid, atTUsRaw: number, escapeGroup: boolean): { left: Uuid; right: Uuid } {
  const atTUs = snapFrameRound(atTUsRaw, p.composition.fps.num, p.composition.fps.den)
  // Pre-flight on the target.
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  if (p.tracks[ti].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[ti].id })
  const tgt = p.tracks[ti].layers[li]
  if (atTUs <= tgt.t_start_us || atTUs >= tgt.t_end_us) throw new CommandFailure({ error: 'SplitOutsideLayer', layer: id, at_t: atTUs })

  // Spanning siblings: members whose interval strictly contains atTUs (sorted order).
  const spanning: Uuid[] = escapeGroup ? [] : groupSiblingsExcluding(p, id).filter((s) => {
    const sl = locateLayer(p, s); if (!sl) return false
    const l = p.tracks[sl[0]].layers[sl[1]]
    return l.t_start_us < atTUs && atTUs < l.t_end_us
  })
  if (!escapeGroup) checkGroupLock(p, id, [id, ...spanning])

  // Split target first.
  const targetHalves = splitSingleLayer(p, idGen, id, atTUs)

  // Split each spanning sibling; add its right-half to the sibling's group.
  for (const sid of spanning) {
    const { right: rightId } = splitSingleLayer(p, idGen, sid, atTUs)
    const gid = indexGroups(p.groups).get(sid)
    if (gid !== undefined) { const g = p.groups.find((x) => x.id === gid); if (g) { g.members = [...g.members, rightId].sort() } }
  }
  // Add the target's right-half to its group, if any.
  const tgid = indexGroups(p.groups).get(targetHalves.left)
  if (tgid !== undefined) { const g = p.groups.find((x) => x.id === tgid); if (g) { g.members = [...g.members, targetHalves.right].sort() } }

  return targetHalves
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/state/mutations/split.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/split.ts apps/desktop/src/main/state/mutations/split.test.ts
git commit -m "feat(state-migration): port split_layer (single + group spanning fan-out)"
```

---

## Task 5: Live group fan-out in `move.ts`

**Files:**
- Modify: `apps/desktop/src/main/state/mutations/move.ts`
- Test: `apps/desktop/src/main/state/mutations/move.test.ts` (add cases)

**Interfaces:**
- Consumes: `groupSiblingsExcluding`, `checkGroupLock` from `./groups` (replacing the local stub).
- Produces: `applyMoveLayer` unchanged signature; now honours the group lock check.

- [ ] **Step 1: Add the failing tests (lock-check coverage — not corpus-gated)**

```ts
// add to apps/desktop/src/main/state/mutations/move.test.ts
import { applyGroupsCreate } from './groups'
// ... existing imports/helpers ...

describe('move group lock checks (not corpus-gated)', () => {
  it('rejects a coupled move when a group sibling is layer-locked', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 100_000)]
    p.tracks[1].layers = [color('b', 0, 100_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true // sibling b locked
    try { applyMoveLayer(p, 'a', p.tracks[0].id, 500_000, false); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
  it('escape_group bypasses the sibling lock check and moves only the target', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 100_000)]
    p.tracks[1].layers = [color('b', 0, 100_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true
    expect(() => applyMoveLayer(p, 'a', p.tracks[0].id, 500_000, true)).not.toThrow()
    expect(p.tracks[1].layers[0].t_start_us).toBe(0) // sibling unmoved
  })
})
```

> Use whatever `color`/`isCommandFailure` helpers `move.test.ts` already imports; mirror its existing setup style.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run src/main/state/mutations/move.test.ts`
Expected: FAIL — the coupled-lock case does not throw yet (lock check is currently omitted).

- [ ] **Step 3: Edit `move.ts` — use the shared helper + add the lock check**

Delete the local `groupSiblingsExcluding` function (lines 7-13) and import the shared one. Add the `checkGroupLock` call (mirrors `mutations.rs:535-545`: only when not escaping and siblings exist). Replace the top of the file and the siblings computation:

```ts
// apps/desktop/src/main/state/mutations/move.ts (header)
import type { Layer, Project, Uuid } from '../model'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit, locateLayer, pruneEmptyHiddenTracks } from './helpers'
import { groupSiblingsExcluding, checkGroupLock } from './groups'
import { CommandFailure } from '../errors'
```

Then, where the siblings are computed (currently `const siblings = escapeGroup ? [] : groupSiblingsExcluding(p, id)` and the "group lock check omitted in P1" comment), replace with:

```ts
  const siblings = escapeGroup ? [] : groupSiblingsExcluding(p, id)
  // Reject up-front if any member (incl. target) is locked / on a locked track
  // (mutations.rs:535-545). Only fires for a coupled move with real siblings.
  if (!escapeGroup && siblings.length > 0) checkGroupLock(p, id, [id, ...siblings])
```

(Keep the rest of `applyMoveLayer` as-is — the fan-out body already matches `mutations.rs:553-624`.)

- [ ] **Step 4: Run to verify all move tests pass**

Run: `npx vitest run src/main/state/mutations/move.test.ts`
Expected: PASS (existing + new lock cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/move.ts apps/desktop/src/main/state/mutations/move.test.ts
git commit -m "feat(state-migration): live group fan-out + lock check in move_layer"
```

---

## Task 6: Live aligned-set fan-out in `trim.ts`

**Files:**
- Modify: `apps/desktop/src/main/state/mutations/trim.ts`
- Test: `apps/desktop/src/main/state/mutations/trim.test.ts` (add cases)

**Interfaces:**
- Consumes: `groupSiblingsExcluding`, `checkGroupLock` from `./groups`.
- Produces: `applyTrimLayer` unchanged signature; the aligned set now includes group members whose matching edge sits at the same `t` as the target's pre-trim edge, and the lock check fires.

- [ ] **Step 1: Add the failing tests**

```ts
// add to apps/desktop/src/main/state/mutations/trim.test.ts
import { applyGroupsCreate } from './groups'

describe('trim group aligned-set (live)', () => {
  it('coupled OUT trim fans out to a sibling sharing the same out-edge', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)] // same out-edge 1_000_000
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 600_000, false)
    expect(p.tracks[0].layers[0].t_end_us).toBe(600_000)
    expect(p.tracks[1].layers[0].t_end_us).toBe(600_000) // sibling fanned out
  })
  it('does NOT fan out to a sibling whose edge differs', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 800_000)] // different out-edge
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 600_000, false)
    expect(p.tracks[1].layers[0].t_end_us).toBe(800_000) // untouched
  })
  it('rejects a coupled trim when an aligned sibling is locked', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true
    try { applyTrimLayer(p, 'a', 'Out', 600_000, false); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
})
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx vitest run src/main/state/mutations/trim.test.ts`
Expected: FAIL — the coupled cases don't fan out yet (`aligned = [id]` always).

- [ ] **Step 3: Edit `trim.ts` — build the live aligned set + lock check**

Add the import and replace the aligned-set stub (`const aligned: Uuid[] = [id]` / `void escapeGroup`) with the port of `mutations.rs:906-928`:

```ts
// apps/desktop/src/main/state/mutations/trim.ts (header) — add:
import { groupSiblingsExcluding, checkGroupLock } from './groups'
```

```ts
// replace the aligned-set stub block:
  // Aligned set: the target + every group sibling whose MATCHING edge sits at the
  // same t as the target's pre-trim edge (mutations.rs:906-928).
  const aligned: Uuid[] = [id]
  if (!escapeGroup) {
    for (const sid of groupSiblingsExcluding(p, id)) {
      const sl = locateLayer(p, sid); if (!sl) continue
      const s = p.tracks[sl[0]].layers[sl[1]]
      const sEdgeT = edge === 'In' ? s.t_start_us : s.t_end_us
      if (sEdgeT === curEdgeT) aligned.push(sid)
    }
    checkGroupLock(p, id, aligned)
  }
```

(The rest of `applyTrimLayer` — clamp across aligned, apply, re-sort on IN — already iterates `aligned` and matches `mutations.rs:930-1062`.)

- [ ] **Step 4: Run to verify all trim tests pass**

Run: `npx vitest run src/main/state/mutations/trim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/trim.ts apps/desktop/src/main/state/mutations/trim.test.ts
git commit -m "feat(state-migration): live group aligned-set + lock check in trim_layer"
```

---

## Task 7: Dispatch + replay vocabulary (`actor.ts`, `replay.ts`)

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts`
- Modify: `apps/desktop/src/main/state/replay.ts`
- Test: `apps/desktop/src/main/state/actor.test.ts` (add cases)

**Interfaces:**
- Consumes: `applySplitLayer` from `./mutations/split`; `applyGroupsCreate/Dissolve/AddMembers/RemoveMembers/Rename` from `./mutations/groups`.
- Produces: dispatch handles `split_layer`, `groups_create`, `groups_dissolve`, `groups_add_members`, `groups_remove_members`, `groups_rename`. `replay.ts` `SUPPORTED_OPS` gains `split_layer`, `groups_create`.

- [ ] **Step 1: Add the failing dispatch tests**

```ts
// add to apps/desktop/src/main/state/actor.test.ts
import { applyGroupsCreate } from './mutations/groups' // if needed for setup; otherwise drive via dispatch

describe('dispatch: split + groups', () => {
  it('groups_create then split_layer through dispatch produce ok results', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l1 = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(l1.ok).toBe(true)
    const l2 = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
    expect(l2.ok).toBe(true)
    const g = actor.dispatch('groups_create', { layers: [l1.value, l2.value], reassign: false })
    expect(g.ok).toBe(true)
    expect(actor.snapshot().groups.length).toBe(1)
    const s = actor.dispatch('split_layer', { layer: l1.value, at_t_us: 400_000, escape_group: false })
    expect(s.ok).toBe(true)
  })
  it('groups_create with < 2 layers returns a GroupCreateNeedsTwoLayers error', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l1 = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const g = actor.dispatch('groups_create', { layers: [l1.value], reassign: false })
    expect(g.ok).toBe(false)
    expect(g.ok === false && g.error.error).toBe('GroupCreateNeedsTwoLayers')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/state/actor.test.ts`
Expected: FAIL — `groups_create`/`split_layer` are unsupported ops.

- [ ] **Step 3: Add the dispatch arms in `actor.ts`**

Add the imports:

```ts
import { applySplitLayer } from './mutations/split'
import { applyGroupsCreate, applyGroupsDissolve, applyGroupsAddMembers, applyGroupsRemoveMembers, applyGroupsRename } from './mutations/groups'
```

Add these arms to the `switch (channel)` in `dispatch` (before `default`):

```ts
        case 'split_layer': return { ok: true, value: commit('Split layer', [], { kind: 'Coarse' }, (d) => applySplitLayer(d, idGen, a.layer as Uuid, a.at_t_us as number, (a.escape_group as boolean) ?? false)) }
        case 'groups_create': return { ok: true, value: commit('Created group', [], { kind: 'Coarse' }, (d) => applyGroupsCreate(d, idGen, a.layers as Uuid[], (a.label as string) ?? null, (a.reassign as boolean) ?? false)) }
        case 'groups_dissolve': commit('Dissolved group', [], { kind: 'Coarse' }, (d) => applyGroupsDissolve(d, a.group as Uuid)); return { ok: true, value: null }
        case 'groups_add_members': commit('Added group members', [], { kind: 'Coarse' }, (d) => applyGroupsAddMembers(d, a.group as Uuid, a.layers as Uuid[], (a.reassign as boolean) ?? false)); return { ok: true, value: null }
        case 'groups_remove_members': commit('Removed group members', [], { kind: 'Coarse' }, (d) => applyGroupsRemoveMembers(d, a.group as Uuid, a.layers as Uuid[])); return { ok: true, value: null }
        case 'groups_rename': commit('Renamed group', [], { kind: 'Coarse' }, (d) => applyGroupsRename(d, a.group as Uuid, (a.label as string) ?? null)); return { ok: true, value: null }
```

> `split_layer` returns the `{left,right}` object as `value` — the replay driver drops it (it captures only string refs), so this is harmless. `groups_create` returns the group-id string; same — the corpus never `ref`-captures it.

- [ ] **Step 4: Extend `replay.ts` vocabulary + buildArgs**

```ts
// replay.ts — SUPPORTED_OPS: add the two new gated ops
export const SUPPORTED_OPS = new Set<string>([
  'add_layer', 'add_track', 'add_marker', 'set_composition',
  'move_layer', 'trim_layer', 'delete_layer', 'duplicate_layer', 'undo', 'redo',
  'split_layer', 'groups_create',
])
```

```ts
// replay.ts — buildArgs: add the two cases (resolve @refs in layer arrays)
    case 'split_layer': return { layer: resolve(refs, cmd.layer), at_t_us: cmd.at_t_us, escape_group: cmd.escape_group ?? false }
    case 'groups_create': return { layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)), label: cmd.label ?? null, reassign: cmd.reassign ?? false }
```

- [ ] **Step 5: Run the actor tests + the existing Phase-1 gate to confirm no regression**

Run: `npx vitest run src/main/state/actor.test.ts src/main/state/__tests__/differential.phase1.test.ts`
Expected: PASS. The Phase-1 gate's skipped count drops (the split/group sequences are now in-vocabulary and will be exercised — they must already match because the mutations are ported). If any group/split sequence now fails inside the Phase-1 gate, that's the differential surfacing a port bug — fix it before continuing (systematic-debugging; re-read the cited Rust lines).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/actor.test.ts
git commit -m "feat(state-migration): dispatch + replay vocab for split_layer + groups"
```

---

## Task 8: Phase-2a differential gate + corpus README

**Files:**
- Create: `apps/desktop/src/main/state/__tests__/differential.phase2.test.ts`
- Modify: `apps/desktop/fixtures/state-corpus/README.md`

**Interfaces:**
- Consumes: `replaySequence`, `sequenceIsSupported` from `../replay`; `canonicalize`, `parseOracleErrorVariant`.
- Produces: a gate asserting the FULL committed corpus is now in-vocabulary (skipped==0) and every step matches the oracle.

- [ ] **Step 1: Write the gate (it should pass once Tasks 1–7 are correct)**

```ts
// apps/desktop/src/main/state/__tests__/differential.phase2.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replaySequence, sequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences')
const ORACLE = join(ROOT, 'oracle')

describe('Phase 2a differential: TS actor === Rust oracle (FULL corpus)', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const skipped = files.filter((f) => !sequenceIsSupported(JSON.parse(readFileSync(join(SEQ, f), 'utf8'))))

  it('every committed corpus sequence is now in-vocabulary (no silent skips)', () => {
    // Phase 2a lights up split_layer + groups_create; nothing committed should remain skipped.
    expect(skipped.sort(), `unexpectedly skipped: ${skipped.join(', ')}`).toEqual([])
  })

  for (const f of files) {
    it(`matches the oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      expect(sequenceIsSupported(seq), `seq ${f} out of vocabulary`).toBe(true)
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replaySequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) {
          expect(parseOracleErrorVariant(String(ts.error)), `error ${where}`).toEqual(parseOracleErrorVariant(String(or.error)))
        }
      }
    })
  }
})
```

- [ ] **Step 2: Run the gate**

Run: `npx vitest run src/main/state/__tests__/differential.phase2.test.ts`
Expected: PASS — the full corpus (all sequences, including the 18 group/split traces) matches byte-for-byte and `skipped==[]`. If a group/split sequence diverges, debug the responsible mutation (the `where` label names the file/step/op) against the cited Rust lines before proceeding.

- [ ] **Step 3: Decide the fate of `differential.phase1.test.ts`**

The Phase-2 gate supersedes the Phase-1 gate (it covers a superset). Delete `differential.phase1.test.ts` to avoid a redundant double-run, OR keep it (it still passes). **Recommended: delete it** (the Phase-2 gate is strictly stronger; git is the archive — `feedback_evergreen_docs`). If deleting:

```bash
git rm apps/desktop/src/main/state/__tests__/differential.phase1.test.ts
```

- [ ] **Step 4: Update the corpus README**

Edit `apps/desktop/fixtures/state-corpus/README.md`: in the "Known gaps" section, remove gap items now COVERED by Phase 2a (the split sequences and `groups_create` coverage are no longer gaps — they are gated by the TS differential). **Keep** the genuinely-deferred items as Phase-2b gaps and label them so: explicit `groups_dissolve` (driver drops group id ref), move/trim to a custom track (driver drops track id ref), lock-member rejection (no lock op), group add/remove members (no driver op), media-bearing layers, history cap >200, composition fit/autofit, caption tracks, effects, transitions, params. Add a one-line note at the top of the gaps section: "Phase 2a (group system + split) is now gated by `differential.phase2.test.ts`; the items below are deferred to Phase 2b (they need Rust replay-driver + corpus extensions)."

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/__tests__/differential.phase2.test.ts apps/desktop/fixtures/state-corpus/README.md
# include the phase-1 gate removal if you deleted it:
git add -u apps/desktop/src/main/state/__tests__/differential.phase1.test.ts
git commit -m "test(state-migration): Phase-2a differential gate (full corpus, split+groups live)"
```

---

## Task 9: Full suite green + branch review

**Files:** none (verification + review).

- [ ] **Step 1: Run the entire state-actor test suite**

Run: `npx vitest run src/main/state`
Expected: PASS — every spec (animated, groups, split, move, trim, actor, history, validate, errors, snap, serialize, model, canonical, ids, both differential gates if you kept phase1). Capture the summary line (N passed).

- [ ] **Step 2: Typecheck the main-process state module**

Run (from `apps/desktop/`): `npx tsc --noEmit -p tsconfig.json` (or the project's configured main tsconfig — match how Phase 1 typechecked; if there is no main-only tsconfig, run the repo's standard typecheck script from `package.json`).
Expected: no new type errors in `src/main/state`.

- [ ] **Step 3: Request a whole-branch code review**

**REQUIRED SUB-SKILL:** Use superpowers:requesting-code-review (opus). Scope: all Phase-2a commits since `5ddba8ad`. Focus the reviewer on: (a) the members-sorted/id-allocation-order invariant in split fan-out; (b) faithfulness of the group lock-check ordering vs `mutations.rs`; (c) that the `reassign` paths and auto-dissolve thresholds match Rust; (d) no wire-shape drift in the `Group` `label`-omission. Resolve every Critical/Important finding before declaring done.

- [ ] **Step 4: Finish the development branch**

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch — present merge/PR options. (This work sits on local `main` per the established Phase-0/1 pattern; confirm the integration choice with the user.)

---

## Self-Review (author checklist — completed)

- **Spec coverage:** master-plan Phase-2 "remaining mutations" splits into 2a (groups + split + live fan-out — this plan) and 2b (params/effects/transitions/captions/media/tracks + corpus driver extensions). The hard group-coupling (split/trim/move fan-out, aligned-edge clamping, escape_group, lock checks — the explicit Phase-2 scope sentence) is FULLY covered here: split (Task 4), move fan-out + lock (Task 5), trim aligned-set + lock (Task 6), groups (Tasks 2-3). ✓
- **Exit criterion (this slice):** "group fan-out passes the differential harness" — Task 8 gates the full corpus incl. all 18 group/split traces with skipped==0. The broader Phase-2 exit ("ALL mutations pass; flag flips to TS-by-default") completes at the end of Phase 2b. ✓
- **Type consistency:** `applySplitLayer`, `applyGroups*`, `groupSiblingsExcluding`, `checkGroupLock`, `indexGroups`, `layerIdSet`, `forEachAnimatedF64/Rgba` named identically across tasks and matched to their consumers. Error variants (`SplitOutsideLayer`, `GroupLockedMember`, `GroupCreateNeedsTwoLayers`, `LayerAlreadyGrouped`, `GroupNotFound`, `LayerNotInGroup`, `TrackLocked`, `LayerNotFound`) all pre-exist in `errors.ts`. ✓
- **No placeholders:** every code step shows the code; the only "verify against Rust" notes are guarded debug pointers tied to the differential gate, not deferred work. ✓
- **Landmine captured:** members-sorted ⇒ id-allocation-order (Global Constraints, Tasks 3/4) — the one invariant most likely to fail the differential gate. ✓

## Phase-2b carry-forwards (NOT this plan)

- Extend the Rust `replay_driver.rs` + corpus: capture `groups_create`/`add_track` returned ids into refs (custom-track + explicit-dissolve coverage), add a `lock_layer`/`lock_track` op (GroupLockedMember/TrackLocked differential coverage), add `groups_add_members`/`groups_remove_members` ops, add media-bearing layers (video/audio) + Motif cap, history cap >200, composition fit.
- Remaining recorded mutations: `update_layer_params`/`update_layer_param_track(s)` (keyframe authoring), `rebind_motif`, effects (`add/update/move/remove_effect`), markers (`update/remove_marker`), transitions (`add/remove_transition` with extend/shrink), tracks (`delete_track`, `move_track`, `add_caption_track`, `restyle_caption_track`, `separate_audio_to_new_track`), media (`add_media_item`, `remove_media`, `set_media_derivatives`/`workspace_paths`), `set_role_gain`, `fit_composition_to_layers`, `replace_state`.
- Unrecorded/preference-shaped: `update_project_settings`, `update_track_flags`, `update_role_flags` (Phase 3 cutover territory; some land in 2b for parity).
- Wire the `Motif` cap into `split.ts` (`rightCapped`) + `trim.ts` (`trimDeltaBounds` motif arg) once a Motif appears in the corpus.
- The `InvalidArgument` CommandError variant is already in the TS union; no change needed.
- Carry-forward (a) from Phase 1 still open: `parseProject` structural conformance gate (differential catches field-VALUE drift, not type-NAME drift).
