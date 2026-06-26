# Phase 4a-ii — slice-4a stragglers (add_motif hybrid + Motif clamp + fresh_media_item) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three remaining additive ports of slice 4a — `add_motif` as a Rust-compute→TS-apply hybrid, the Motif `update_layer_params` content-window clamp (TS port + cross-language golden), and the `fresh_media_item` mirror re-point — so `BLOCKED_UNDER_FLAG`/`MCP_BLOCKED_UNDER_FLAG` reach ∅ and slice 4a is differential-complete. **This is the FINAL oracle regeneration** before the 4b delete.

**Architecture:** `add_motif` joins the 3d-e hybrid family (Rust `compute_add_motif` validates/canonicalizes/resolves against the read-mirror and returns a track *plan* — never a minted id; the TS host applies through the gated actor and mints all ids in the no-`track_id` two-commit order). The Motif clamp is pure-TS inside the synchronous commit pipeline, backed by a TS manifest cache (data single-sourced from Rust `list_motifs`) and a small `resolveMotifMaxDurUs` helper golden-gated against Rust `resolve_motif_max_dur_us`. `fresh_media_item` threads the read-mirror into the job-capture closures. All differential-gated against the live Rust actor; the corpus grows additively; existing oracles stay byte-identical; **this is the last regen** (the harness is retired in 4b).

**Tech Stack:** Rust (`apps/desktop/native/`, cargo `--features replay,jobs,export,mcp,cloud,motifs`), TypeScript (Electron main `apps/desktop/src/main/state/` + `apps/desktop/src/main/mcp/`), Vitest, Immer (mutations run in `produce`), the `weftcut-eval` wasm leaf (`snap_frame_floor`/`snap_frame_round`). Oracle regen via `node scripts/gen-state-oracle.mjs` (env `FFMPEG_DIR`/`LIBCLANG_PATH`/`PATH+=$FFMPEG_DIR/bin`).

## Global Constraints

Copied from the spec (`specs/2026-06-25-state-actor-phase-4-design.md` §2.2/§2.3/§2.4/§2.8); every task's requirements implicitly include these.

- **ADDITIVE corpus only.** Existing oracles MUST stay byte-identical: `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` is empty at every commit; only NEW oracle files are added. The regen (Task 9) is the ONLY place new oracles appear. Drivers gain arms additively (the 3d-e proof: new arms don't perturb prior oracles).
- **Determinism / id-allocation contract is sacred.** `add_motif`'s TS apply mints ids in the EXACT order Rust does in the no-`track_id` case: **track id first** (`add_track` Overlay), **layer id second** (`add_layer` Motif). The Rust compute half NEVER mints a track/layer id (returns a *plan*) — minting there would steal allocation order from the TS actor.
- **Reject before commit / write-free compute.** The Rust `compute_add_motif` reads `snapshot_for_read()` and is WRITE-FREE (no actor mutation); a malformed motif/props rejects from `canonicalize_props` BEFORE the TS apply runs.
- **Cap helper is a TWIN — golden-protected.** `resolveMotifMaxDurUs` (TS) must mirror Rust `resolve_motif_max_dur_us` (catalog.rs:130-142) EXACTLY: prop-driven cap → `round(n*1e6)` when the `max_duration_prop` value is finite & >0, else `round(max_duration_s*1e6)` filtered >0, else `None`. It **EXCLUDES `content_duration_s`** — do NOT reuse the renderer's `resolveMotifContentDurationUs` (catalog.ts:181, which deliberately includes it). Golden fixture asserted on BOTH sides (the `snap_frame_golden` precedent).
- **Clamp math mirrors Rust exactly** (mutations.rs:391-449): no-op when `src_in + width ≤ content_dur`; else `new_src_in = snap_round(snap_floor(min(src_in, content_dur-1), fps))`, `capped_end = snap_round(snap_floor(t_start + (content_dur - new_src_in), fps))`, `new_t_end = max(capped_end, t_start+1)`; then `apply_duration_autofit`. Uses `snap.ts` (`snapFrameRound` + `snapFrameFloor` — both from the wasm leaf).
- **`tsc -b` is a required gate** after any shared-interface change (vitest runs esbuild and does NOT typecheck).
- **TimeUs is `number`**; preference-shaped patches are unrecorded; the wasm eval leaf is never reimplemented.
- **Final-regen discipline:** after Task 9's regen+commit, all differential gates report `skipped===[]`. Do NOT delete drivers/the `replay` feature — that is 4b.
- **DUAL-MANIFEST gotcha:** built-in motif manifests exist in BOTH `native/src/motifs/catalog/<dir>/manifest.json` (Rust) and `src/renderer/render/motifs/builtin/*/manifest.json` (TS renderer). The TS actor manifest cache hydrates from Rust `list_motifs` (single source) — do NOT add a third hand-copy.

---

## File Structure

| File | Responsibility | This slice |
|---|---|---|
| `apps/desktop/native/src/napi_backend.rs` | `read_mirror` → `Arc<Mutex<…>>` + `read_mirror_handle()`; new `compute_add_motif` napi | Modify |
| `apps/desktop/native/src/jobs/mod.rs` | `fresh_media_item` reads the mirror; `spawn_conform`/`spawn_quick_proxy`/`spawn_proxy` take the mirror handle (§2.4) | Modify |
| `apps/desktop/native/src/commands/motifs.rs` | factor a write-free `add_motif_compute(store, snap, args) -> AddMotifPlan` reused by the napi + (optionally) the existing handler | Modify |
| `apps/desktop/src/main/state/motifManifests.ts` | TS `Manifest` type + `MotifManifestCache` (Map<motif_id, Manifest>) + `resolveMotifMaxDurUs` (§2.3) | Create |
| `apps/desktop/src/main/state/actor.ts` | actor holds an injectable manifest cache; clamp wired into `update_layer_params` (§2.3) | Modify |
| `apps/desktop/src/main/state/mutations/params.ts` | the Motif content-window clamp (port of mutations.rs:391-449) (§2.3) | Modify |
| `apps/desktop/src/main/state/snap.ts` | ensure `snapFrameFloor` is exported (alongside `snapFrameRound`) | Modify (if needed) |
| `apps/desktop/src/main/state/hybrids.ts` | `ComputeNapi.computeAddMotif`; `runHybrid` `add_motif` branch (two-commit apply) (§2.2) | Modify |
| `apps/desktop/src/main/state/ts-actor-host.ts` | `listMotifs` dep + cache hydrate at `start()` + refresh on motif-store mutations; `HybridDeps` unchanged otherwise | Modify |
| `apps/desktop/src/main/index.ts` | provide `listMotifs` + `computeAddMotif` deps | Modify |
| `apps/desktop/src/main/state/router.ts` | `add_motif` → `HYBRID_CHANNELS`; drop from `BLOCKED_UNDER_FLAG` (∅) (§2.2) | Modify |
| `apps/desktop/src/main/mcp/mutationTools.ts` | `add_motif` → `HYBRID_TOOLS`; drop from `MCP_BLOCKED_UNDER_FLAG` (∅) (§2.2) | Modify |
| `apps/desktop/native/src/bin/{replay_driver,prod_driver,mcp_driver}.rs` | `add_motif` arms (renderer + MCP gated separately) + ref-capture (§2.2) | Modify |
| `apps/desktop/fixtures/state-corpus/sequences*/…` | add_motif seqs (renderer no-track / existing-track; MCP) + countdown-clamp seq (§2.2/§2.3) | Create |
| `apps/desktop/fixtures/motif-cap-golden.fixture.json` | hand-authored (manifest, props) → cap_us cases (§2.3) | Create |
| `apps/desktop/native/src/motifs/catalog.rs` | `#[test]` asserting `resolve_motif_max_dur_us` matches the golden fixture (§2.3) | Modify |
| `apps/desktop/src/main/state/motifCapGolden.test.ts` | TS test asserting `resolveMotifMaxDurUs` matches the golden fixture (§2.3) | Create |

---

## Task 1: `fresh_media_item` reads the read-mirror (§2.4, Rust, no differential)

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs` (`read_mirror` field type + `read_mirror_handle()`)
- Modify: `apps/desktop/native/src/jobs/mod.rs` (`fresh_media_item` + the three `spawn_*` signatures + their call sites)
- Test: `apps/desktop/native/src/jobs/mod.rs` `#[cfg(test)]` (or the existing `mirror_tests` module)

**Interfaces:**
- Consumes: `Backend::snapshot_for_read` semantics (mirror-or-actor), `ReadMirror { project: Arc<Project>, history_view }`.
- Produces: `read_mirror: Arc<Mutex<Option<ReadMirror>>>`; `fn read_mirror_handle(&self) -> Arc<Mutex<Option<ReadMirror>>>`; `fresh_media_item(project: &ProjectHandle, mirror: &Arc<Mutex<Option<ReadMirror>>>, media_id, fallback) -> MediaItem`.

Under the flag the Rust actor is frozen, so `fresh_media_item`'s `project.snapshot()` is stale (falls back to the enqueue-time item — accepted today). Re-point it to read the mirror (the TS-pushed `Arc<Project>`), falling back to the actor when the mirror is unset (flag-off).

- [ ] **Step 1: Make `read_mirror` shareable** — in `napi_backend.rs`, change the field `read_mirror: std::sync::Mutex<Option<ReadMirror>>` to `read_mirror: std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>>`. Update its initializer (`Mutex::new(None)` → `Arc::new(Mutex::new(None))`). `set_project_mirror` / `snapshot_for_read` lock through the `Arc` unchanged (`self.read_mirror.lock()` still compiles). Add:
```rust
/// Clone the read-mirror handle so background jobs can read the latest
/// TS-pushed project without holding a &Backend across an async spawn.
fn read_mirror_handle(&self) -> std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>> {
    self.read_mirror.clone()
}
```
(If `ReadMirror` is a private type, keep `read_mirror_handle` `pub(crate)` and the param type referenced via the same path. `ReadMirror.project` is `Arc<Project>`.)

- [ ] **Step 2: Write the failing test** — in `jobs/mod.rs` tests, assert that with a populated mirror, `fresh_media_item` returns the MIRROR's item (not the fallback), and with an empty mirror it returns the fallback. Mirror-test recipe (cf. the existing `mirror_tests`):
```rust
#[tokio::test]
async fn fresh_media_item_prefers_mirror() {
    // build a Project with media_id → item_v2 in media_pool; wrap as ReadMirror; Arc<Mutex<Some(..)>>.
    // a ProjectHandle whose snapshot lacks media_id (or has item_v1).
    let got = fresh_media_item(&handle, &mirror, media_id, fallback_v1).await;
    assert_eq!(got.file_hash_blake3, item_v2.file_hash_blake3); // mirror won
}
```
Run: `cd apps/desktop && cargo test --features jobs,export,motifs --lib fresh_media_item` → FAIL (signature still takes only `&ProjectHandle`).

- [ ] **Step 3: Re-point `fresh_media_item`** —
```rust
async fn fresh_media_item(
    project: &ProjectHandle,
    mirror: &std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>>,
    media_id: MediaId,
    fallback: MediaItem,
) -> MediaItem {
    // Prefer the TS read-mirror (fresh under the flag); fall back to the
    // live actor (flag-off), then the enqueue-time item.
    if let Some(m) = mirror.lock().expect("read_mirror poisoned").as_ref() {
        if let Some(it) = m.project.media_pool.get(&media_id) { return it.clone(); }
        return fallback;
    }
    project.snapshot().await.media_pool.get(&media_id).cloned().unwrap_or(fallback)
}
```

- [ ] **Step 4: Thread the mirror into the three callers** — add `mirror: std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>>` to `spawn_conform`, `spawn_quick_proxy`, `spawn_proxy` signatures (capture it into the `async move`), and pass it to `fresh_media_item`. At each spawn SITE (a `Backend` method), pass `self.read_mirror_handle()`. `spawn_waveform` is unchanged (no `fresh_media_item` call). Update ALL call sites of the three `spawn_*` fns accordingly.

- [ ] **Step 5: Run tests + build** — `cd apps/desktop && cargo test --features jobs,export,motifs --lib fresh_media_item` → PASS; `cargo build --features replay,jobs,export,mcp,cloud,motifs` clean.

- [ ] **Step 6: Commit**
```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/jobs/mod.rs
git commit -m "fix(state-migration): fresh_media_item reads the read-mirror under the flag (Phase 4a-ii §2.4)"
```

---

## Task 2: TS `Manifest` type + manifest cache + `resolveMotifMaxDurUs` (§2.3)

**Files:**
- Create: `apps/desktop/src/main/state/motifManifests.ts`
- Test: `apps/desktop/src/main/state/motifManifests.test.ts` (Create)

**Interfaces:**
- Produces:
```typescript
export interface Manifest {
  id: string; name: string; version: number; size: [number, number]
  default_duration_s: number
  max_duration_s?: number | null
  max_duration_prop?: string | null
  content_duration_s?: number | null
  props_schema: Record<string, unknown>   // structural; not interpreted by the cap helper
}
export type MotifManifestCache = ReadonlyMap<string, Manifest>
export function resolveMotifMaxDurUs(manifest: Manifest, props: Record<string, unknown>): number | null
export function manifestCacheFromList(listMotifsJson: unknown[]): Map<string, Manifest>
```
This is the data twin of Rust `Manifest` (catalog.rs:57-99) + the cap helper twin of `resolve_motif_max_dur_us` (catalog.rs:130-142). `manifestCacheFromList` builds the cache from the `list_motifs` payload (each entry is a serialized Manifest + extra `html`/`status`/`content_hash`/`target_id` keys — keep only the Manifest fields).

- [ ] **Step 1: Write the failing test** — mirror Rust `resolve_motif_max_dur_us` math:
```typescript
import { resolveMotifMaxDurUs, manifestCacheFromList, type Manifest } from './motifManifests'
const base: Manifest = { id: 'm', name: 'M', version: 1, size: [1920,1080], default_duration_s: 5, props_schema: {} }
it('prop-driven cap wins when finite & >0', () => {
  expect(resolveMotifMaxDurUs({ ...base, max_duration_prop: 'seconds', max_duration_s: 10 }, { seconds: 3 })).toBe(3_000_000)
})
it('falls back to max_duration_s when the prop is absent/invalid', () => {
  expect(resolveMotifMaxDurUs({ ...base, max_duration_prop: 'seconds', max_duration_s: 10 }, { seconds: 0 })).toBe(10_000_000)
  expect(resolveMotifMaxDurUs({ ...base, max_duration_s: 10 }, {})).toBe(10_000_000)
})
it('null when uncapped; EXCLUDES content_duration_s', () => {
  expect(resolveMotifMaxDurUs({ ...base }, {})).toBeNull()
  expect(resolveMotifMaxDurUs({ ...base, content_duration_s: 99 }, {})).toBeNull() // NOT 99e6
})
it('manifestCacheFromList keeps only manifest fields, keyed by id', () => {
  const c = manifestCacheFromList([{ ...base, html: '<x>', status: 'builtin', content_hash: 'h' }])
  expect(c.get('m')?.default_duration_s).toBe(5)
  expect((c.get('m') as Record<string, unknown>).html).toBeUndefined()
})
```
Run: `cd apps/desktop && npx vitest run src/main/state/motifManifests.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement** — `resolveMotifMaxDurUs` mirrors catalog.rs:130-142 exactly:
```typescript
export function resolveMotifMaxDurUs(manifest: Manifest, props: Record<string, unknown>): number | null {
  if (manifest.max_duration_prop != null) {
    const v = props[manifest.max_duration_prop]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v * 1_000_000)
  }
  if (manifest.max_duration_s != null && manifest.max_duration_s > 0) return Math.round(manifest.max_duration_s * 1_000_000)
  return null
}
export function manifestCacheFromList(entries: unknown[]): Map<string, Manifest> {
  const m = new Map<string, Manifest>()
  for (const e of entries) {
    const o = e as Record<string, unknown>
    if (typeof o.id !== 'string') continue
    m.set(o.id, { id: o.id, name: o.name as string, version: o.version as number, size: o.size as [number, number],
      default_duration_s: o.default_duration_s as number,
      max_duration_s: (o.max_duration_s as number | null) ?? null,
      max_duration_prop: (o.max_duration_prop as string | null) ?? null,
      content_duration_s: (o.content_duration_s as number | null) ?? null,
      props_schema: (o.props_schema as Record<string, unknown>) ?? {} })
  }
  return m
}
```
Run Step 1's test → PASS. `npx tsc -b` clean.

- [ ] **Step 3: Commit**
```bash
git add apps/desktop/src/main/state/motifManifests.ts apps/desktop/src/main/state/motifManifests.test.ts
git commit -m "feat(state-migration): TS Manifest type + cache + resolveMotifMaxDurUs (Phase 4a-ii §2.3)"
```

---

## Task 3: Cross-language golden for the cap helper (§2.3)

**Files:**
- Create: `apps/desktop/fixtures/motif-cap-golden.fixture.json`
- Modify: `apps/desktop/native/src/motifs/catalog.rs` (add a `#[test]` asserting the fixture)
- Create: `apps/desktop/src/main/state/motifCapGolden.test.ts`

**Interfaces:** consumes `resolve_motif_max_dur_us` (Rust) + `resolveMotifMaxDurUs` (TS, Task 2). Mirrors the `snap_frame_golden` precedent (`src/renderer/snapFrameGolden.fixture.json` + `native/eval/src/lib.rs:478-512` Rust test + `src/renderer/frames.golden.test.ts`): a HAND-AUTHORED fixture, `include_str!` on the Rust side, `import` on the TS side, exact equality both ways.

- [ ] **Step 1: Author the fixture** — cases covering the cap branches (prop-driven, max_duration_s fallback, uncapped/null, content_duration_s-ignored, rounding). Shape:
```json
{ "cases": [
  { "name": "prop-driven", "manifest": { "id":"countdown","name":"Countdown","version":1,"size":[1920,1080],"default_duration_s":5,"max_duration_prop":"seconds","max_duration_s":60,"content_duration_s":null,"props_schema":{} }, "props": { "seconds": 10 }, "expect_us": 10000000 },
  { "name": "fallback-max-s", "manifest": { "...":"same, max_duration_prop:seconds, max_duration_s:60" }, "props": { "seconds": 0 }, "expect_us": 60000000 },
  { "name": "uncapped-null", "manifest": { "...":"no max_duration_prop, no max_duration_s" }, "props": {}, "expect_us": null },
  { "name": "content-dur-ignored", "manifest": { "...":"content_duration_s:99, no caps" }, "props": {}, "expect_us": null }
] }
```
(Author every field explicitly; `expect_us: null` for uncapped. Keep values clean integers so JSON round-trips exactly.)

- [ ] **Step 2: Rust golden test (RED→GREEN)** — in `catalog.rs` tests, `include_str!("../../../fixtures/motif-cap-golden.fixture.json")` (adjust the relative path from `native/src/motifs/` to `apps/desktop/fixtures/`), deserialize `{cases:[{name, manifest:Manifest, props:serde_json::Value, expect_us:Option<i64>}]}`, and for each assert `resolve_motif_max_dur_us(&case.manifest, &props_as_imbl_hashmap) == case.expect_us`. Run: `cd apps/desktop && cargo test --features motifs --lib motif_cap_golden` → expect PASS (the fixture is authored to match Rust; if a case fails, the FIXTURE is wrong — fix the fixture, not the helper).

- [ ] **Step 3: TS golden test (RED→GREEN)** — `motifCapGolden.test.ts`:
```typescript
import fixture from '../../../fixtures/motif-cap-golden.fixture.json'
import { resolveMotifMaxDurUs, type Manifest } from './motifManifests'
interface Case { name: string; manifest: Manifest; props: Record<string, unknown>; expect_us: number | null }
describe('motif cap golden (cross-language)', () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => { expect(resolveMotifMaxDurUs(c.manifest, c.props)).toBe(c.expect_us) })
  }
})
```
Run: `cd apps/desktop && npx vitest run src/main/state/motifCapGolden.test.ts` → PASS (both sides now pinned to one fixture).

- [ ] **Step 4: Commit**
```bash
git add apps/desktop/fixtures/motif-cap-golden.fixture.json apps/desktop/native/src/motifs/catalog.rs apps/desktop/src/main/state/motifCapGolden.test.ts
git commit -m "test(state-migration): cross-language golden for motif cap helper (Phase 4a-ii §2.3)"
```

---

## Task 4: Wire the manifest cache into the actor + port the Motif clamp (§2.3)

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (inject/hold a `MotifManifestCache`; pass it into the params clamp)
- Modify: `apps/desktop/src/main/state/mutations/params.ts` (the clamp)
- Modify: `apps/desktop/src/main/state/snap.ts` (ensure `snapFrameFloor` exported — confirm Step 1)
- Test: `apps/desktop/src/main/state/mutations/params.test.ts` (Modify/extend) + a clamp unit test

**Interfaces:**
- Consumes: `resolveMotifMaxDurUs` + `Manifest` (Task 2), `snapFrameRound`/`snapFrameFloor` (snap.ts), `applyDurationAutofit` (mutations/composition.ts).
- Produces: `createActor` accepts optional `motifManifests?: MotifManifestCache` (default empty Map) + a `setMotifManifests(cache)` method on `ActorHandle`; `applyUpdateLayerParams(p, id, patch, manifests)` clamps Motif geometry.

The actor stays the single source for the clamp logic; the cache is injected (so the differential replay can seed the built-in `countdown` manifest, and the host hydrates it from `list_motifs` at runtime). Mirrors Rust mutations.rs:391-449 using `motif_cap_us`-equivalent lookup (cache → `resolveMotifMaxDurUs`).

- [ ] **Step 1: Confirm `snapFrameFloor`** — Run: `cd apps/desktop && rg -n "snapFrameFloor|snapFrameRound|export" src/main/state/snap.ts`. If `snapFrameFloor` is not exported, add it as a re-export of the wasm leaf's `snap_floor` (mirror how `snapFrameRound` re-exports `snap_round`). Both must be available to params.ts.

- [ ] **Step 2: Write the failing clamp test** — a Motif layer whose `seconds` prop shrinks the cap below the current window must clamp `src_in_us` + `t_end_us`:
```typescript
// build an actor with a manifest cache holding `countdown` (max_duration_prop:'seconds', e.g. cap from seconds)
// add a Motif layer countdown at t_start=0,t_end=10s, src_in=0, props.seconds=10 (cap 10s → src_out=10s ≤ 10s, no clamp)
// update_layer_params props.seconds=3 → cap 3s; window 0..10s has src_out=10s > 3s → clamp:
//   new_src_in = 0 (src_in 0 ≤ cap-1), capped_end = snap(t_start + (3s - 0)) = 3s, t_end → 3s
expect(layer.t_end_us).toBe(3_000_000)
expect((layer.params as MotifParams).src_in_us).toBe(0)
```
Also a no-op case (growing `seconds` does NOT resize). Run → FAIL (params.ts field-merges only, no clamp).

- [ ] **Step 3: Port the clamp** — in `params.ts`, change `applyUpdateLayerParams` to accept the manifest cache and, after the field-merge, run the clamp (port of mutations.rs:391-449 verbatim in math):
```typescript
export function applyUpdateLayerParams(p: Project, id: Uuid, patch: LayerParamsPatch, manifests: MotifManifestCache): void {
  checkTrackLock(p, id)
  const [ti, li] = locateLayer(p, id)!
  applyParamsPatch(p.tracks[ti].layers[li], patch)
  const layer = p.tracks[ti].layers[li]
  if (layer.params.kind !== 'Motif') return
  const manifest = manifests.get(layer.params.motif_id)
  if (!manifest) return // unknown motif → no clamp (mirrors builtins-only None)
  const contentDur = resolveMotifMaxDurUs(manifest, layer.params.props)
  if (contentDur == null) return
  const fps = p.composition.fps // {num,den}
  const tStart = layer.t_start_us, tEnd = layer.t_end_us
  const srcIn = layer.params.src_in_us, width = tEnd - tStart
  if (srcIn + width <= contentDur) return // grow / within content
  const maxSrcIn = Math.max(contentDur - 1, 0)
  const newSrcIn = snapFrameRound(snapFrameFloor(Math.min(srcIn, maxSrcIn), fps), fps)
  const cappedEnd = snapFrameRound(snapFrameFloor(tStart + (contentDur - newSrcIn), fps), fps)
  layer.params.src_in_us = newSrcIn
  layer.t_end_us = Math.max(cappedEnd, tStart + 1)
  applyDurationAutofit(p)
}
```
(Match the exact arg shape `snapFrameRound`/`snapFrameFloor` use in this codebase — they may take `(t, num, den)` or `(t, fps)`; adapt. Verify against params.ts:3's existing `snapFrameRound` usage.)

- [ ] **Step 4: Thread the cache from the actor** — `createActor` gains `motifManifests?: MotifManifestCache` (stored, default `new Map()`) + `setMotifManifests(c)`. The `update_layer_params` dispatch arm passes the stored cache to `applyUpdateLayerParams`. Update ALL `applyUpdateLayerParams` call sites (dispatch + any test) to pass the cache.

- [ ] **Step 5: Run tests + typecheck** — `cd apps/desktop && npx vitest run src/main/state/mutations/params.test.ts && npx tsc -b` → PASS, clean. Then `npx vitest run src/main/state` — full suite green; **differential gates still `skipped===[]`** (the corpus has no Motif layers YET, so the clamp is inert until Task 8's countdown seq — confirm no existing oracle perturbed).

- [ ] **Step 6: Commit**
```bash
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mutations/params.ts apps/desktop/src/main/state/snap.ts apps/desktop/src/main/state/mutations/params.test.ts
git commit -m "feat(state-migration): Motif update_layer_params content-window clamp (Phase 4a-ii §2.3)"
```

---

## Task 5: Rust `compute_add_motif` (write-free) + `ComputeNapi.computeAddMotif` (§2.2)

**Files:**
- Modify: `apps/desktop/native/src/commands/motifs.rs` (factor `add_motif_compute`)
- Modify: `apps/desktop/native/src/napi_backend.rs` (new `compute_add_motif` napi)
- Modify: `apps/desktop/src/main/state/hybrids.ts` (`ComputeNapi.computeAddMotif`)

**Interfaces:**
- Produces (Rust): `pub async fn compute_add_motif(&self, args_json: String) -> napi::Result<String>` returning JSON:
```json
{ "props": <canonical props object>, "motif_version": <u32>, "t_end_us": <i64>,
  "t_start_us": <i64>, "track_plan": { "kind": "existing", "track_id": "<uuid>" } | { "kind": "create_overlay" } }
```
- Produces (TS): `ComputeNapi.computeAddMotif(argsJson: string): Promise<string>`.

The compute reads `snapshot_for_read()` + the motif store, resolves the Motif: `canonicalize_props` → props (object), `motif.manifest.version`, `resolve_motif_t_end_us(t_start, t_end_opt, default_duration_s, resolve_motif_max_dur_us(...))` → `t_end_us`, and a **track PLAN** (NOT a minted id): if the caller supplied `track_id` → `{existing, track_id}`; else `{create_overlay}` (mirrors commands/motifs.rs:193 which always creates a fresh Overlay in the no-track case — do NOT call `resolve_overlay_track`, `add_motif` does not reuse tracks). WRITE-FREE: no `handle.add_track`/`add_layer`/store mutation.

- [ ] **Step 1: Factor a write-free compute** — extract from `commands/motifs.rs::add_motif` the resolution half into:
```rust
pub struct AddMotifPlan { pub props: serde_json::Value, pub motif_version: u32, pub t_start_us: i64, pub t_end_us: i64, pub track_plan: TrackPlan }
pub enum TrackPlan { Existing(String), CreateOverlay }
pub fn add_motif_compute(store: &UserMotifStore, snap: &Arc<Project>, args: &AddMotifArgs) -> Result<AddMotifPlan, String>
```
It resolves the motif (built-in via `builtins()` or `store.get_motif`), `canonicalize_props` (returns canonical JSON; parse back to `serde_json::Value` for the payload), `motif.manifest.version`, and `t_end_us` via `resolve_motif_t_end_us(args.t_start_us, args.t_end_us, manifest.default_duration_s, resolve_motif_max_dur_us(&manifest, &props_map))`. `track_plan` from `args.track_id`. (Keep the existing `add_motif` handler working — it can call `add_motif_compute` then apply, OR stay as-is; this slice only ADDS the compute path for the hybrid.)

- [ ] **Step 2: Add the napi** — in `napi_backend.rs`, mirror `compute_motif_rebind` (napi_backend.rs:385-407):
```rust
#[napi]
#[cfg(feature = "motifs")]
pub async fn compute_add_motif(&self, args_json: String) -> napi::Result<String> {
    let args: crate::commands::motifs::AddMotifArgs = serde_json::from_str(&args_json).map_err(err)?;
    let snap = self.snapshot_for_read().await.map_err(err)?;
    let plan = crate::commands::motifs::add_motif_compute(&self.motif_store, &snap, &args).map_err(err)?;
    serde_json::to_string(&plan).map_err(err)  // #[derive(Serialize)] on AddMotifPlan/TrackPlan
}
```
Run: `cd apps/desktop && cargo build --features replay,jobs,export,mcp,cloud,motifs && npm run napi:build` (regen `index.d.ts`).

- [ ] **Step 3: Add to `ComputeNapi`** — in `hybrids.ts`, add `computeAddMotif(argsJson: string): Promise<string>` to the facade (alongside the other 5). `tsc -b` clean.

- [ ] **Step 4: Commit**
```bash
git add apps/desktop/native/src/commands/motifs.rs apps/desktop/native/src/napi_backend.rs apps/desktop/src/main/state/hybrids.ts
git commit -m "feat(state-migration): compute_add_motif write-free entrypoint + ComputeNapi (Phase 4a-ii §2.2)"
```

---

## Task 6: `runHybrid` add_motif branch (two-commit apply) + un-block (§2.2)

**Files:**
- Modify: `apps/desktop/src/main/state/hybrids.ts` (`runHybrid` `add_motif` branch)
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (listMotifs dep + cache hydrate — see Task 7; the hybrid branch only needs `deps.actor`)
- Modify: `apps/desktop/src/main/state/router.ts` (`HYBRID_CHANNELS` += add_motif; `BLOCKED_UNDER_FLAG` → ∅)
- Modify: `apps/desktop/src/main/mcp/mutationTools.ts` (`HYBRID_TOOLS` += add_motif; `MCP_BLOCKED_UNDER_FLAG` → ∅)
- Modify: `apps/desktop/src/main/index.ts` (provide `computeAddMotif`)
- Test: `apps/desktop/src/main/state/__tests__/add-motif-hybrid.test.ts` (Create) + router/mutationTools test updates

**Interfaces:**
- Consumes: `ComputeNapi.computeAddMotif` (Task 5), `deps.actor.dispatch` (add_track / add_layer).
- Produces: renderer channel + MCP tool `add_motif` route `hybrid`; the branch returns the **layer id** as text (matching Rust `add_motif`'s ToolResult — confirm: Rust returns the layer id string).

The branch mirrors `install_motif` (hybrids.ts:136-150) but does the TWO-COMMIT id-minting apply on the TS side:
```typescript
case 'add_motif': {
  const plan = JSON.parse(await deps.compute.computeAddMotif(JSON.stringify(args.args ?? args))) as {
    props: Record<string, unknown>; motif_version: number; t_start_us: number; t_end_us: number
    track_plan: { kind: 'existing'; track_id: string } | { kind: 'create_overlay' }
  }
  // Resolve the track id — minting the Overlay track FIRST (id order: track, then layer).
  let trackId: string
  if (plan.track_plan.kind === 'existing') trackId = plan.track_plan.track_id
  else {
    const r = deps.actor.dispatch('add_track', { label: 'Overlay' })
    if (!r.ok) throw new Error(JSON.stringify(r.error)); trackId = r.value as string
  }
  // Add the Motif layer SECOND (mints the layer id).
  const params = { kind: 'Motif', motif_id: (args.args ?? args).motif_id, motif_version: plan.motif_version,
    props: plan.props, src_in_us: 0, transform: defaultTransform(), opacity: { mode: 'Static', value: 1 } }
  const r2 = deps.actor.dispatch('add_layer', { track: trackId, params, t_start_us: plan.t_start_us, t_end_us: plan.t_end_us })
  if (!r2.ok) throw new Error(JSON.stringify(r2.error))
  return r2.value as string // layer id
}
```
(Confirm `add_layer` dispatch accepts a fully-formed `params` object with `kind:'Motif'` — the replay_driver handles `"Motif"` as an `add_layer` sub-kind, so the TS actor's add_layer must accept Motif params. Verify against mutations/add.ts; if add_layer expects a builder, route through the same path the driver's Motif sub-kind uses. `defaultTransform()` = the identity transform the model uses.)

- [ ] **Step 1: Write failing tests** — (a) `routeChannel('add_motif')` → `{kind:'hybrid', tool:'add_motif'}`; `routeMcpTool('add_motif')` → `'hybrid'`. (b) a `runHybrid('add_motif', {motif_id:'countdown', t_start_us:0}, deps)` with a fake `computeAddMotif` returning a `create_overlay` plan creates an Overlay track + Motif layer in the right id order. Run → FAIL (still blocked; no branch).

- [ ] **Step 2: Un-block + add to hybrid sets** — `router.ts`: `BLOCKED_UNDER_FLAG = new Set([])` (∅; update the doc comment — nothing remains blocked, Phase 4a complete); `HYBRID_CHANNELS` add `'add_motif'`. `mutationTools.ts`: `MCP_BLOCKED_UNDER_FLAG = new Set([])` (∅); `HYBRID_TOOLS` add `'add_motif'`. Update the router/mutationTools tests asserting the blocked sets (move add_motif from blocked → hybrid; assert blocked sets are empty).

- [ ] **Step 3: Implement the branch** (Step-1(b) code) + provide `computeAddMotif` in `index.ts` (where the other compute napis are wired): `computeAddMotif: (j) => backend.computeAddMotif(j)`.

- [ ] **Step 4: Run tests + typecheck** — `cd apps/desktop && npx vitest run src/main/state/__tests__/add-motif-hybrid.test.ts src/main/state/router.test.ts src/main/mcp/*.test.ts && npx tsc -b` → PASS, clean. Full `npx vitest run src/main/state` green (differential still `skipped===[]` — drivers not yet extended, corpus unchanged).

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/main/state/hybrids.ts apps/desktop/src/main/state/router.ts apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/__tests__/add-motif-hybrid.test.ts apps/desktop/src/main/state/router.test.ts <mutationTools test>
git commit -m "feat(state-migration): add_motif hybrid (two-commit TS apply) + un-block → blocked sets ∅ (Phase 4a-ii §2.2)"
```

---

## Task 7: TS manifest-cache hydration in the host (§2.3, runtime wiring)

**Files:**
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (`listMotifs` dep; hydrate at `start()`; refresh after motif-store mutations)
- Modify: `apps/desktop/src/main/index.ts` (provide `listMotifs`)
- Test: `apps/desktop/src/main/state/ts-actor-host.test.ts` (extend)

**Interfaces:**
- Consumes: `manifestCacheFromList` (Task 2), `actor.setMotifManifests` (Task 4).
- Produces: `TsActorHostDeps.listMotifs?: () => Promise<string>` (returns the `list_motifs` JSON array); host hydrates the actor's cache on `start()` and after any motif-store-mutating channel/tool completes.

Rust `list_motifs` is the single source (built-ins + user manifests). The host hydrates the actor's injectable cache so the clamp (Task 4) sees user motifs too (a superset of Rust's builtins-only clamp — see the parity note). Motif-store mutations (`install_motif`/`delete_motif`/`write_motif_draft`/`import_motif`/`amend_motif_draft`/`create_edit_draft`) emit `motifs:changed`; refresh after those.

- [ ] **Step 1: Write the failing test** — `createTsActorHost({...deps, listMotifs: vi.fn(async () => JSON.stringify([countdownManifestEntry]))})`; after `host.start()`, the actor's cache has `countdown`. (Expose cache state via a test hook or assert a clamp fires after hydration.) Run → FAIL.

- [ ] **Step 2: Implement hydration** — add `listMotifs?` to `TsActorHostDeps`. In `start()`, after `pushMirror()`: `if (deps.listMotifs) void deps.listMotifs().then((j) => actor.setMotifManifests(manifestCacheFromList(JSON.parse(j))))` (best-effort, non-blocking — wrap in try/catch). Add a `refreshMotifCache()` helper and call it after a successful motif-store-mutating channel in `handleInvoke` (install/delete/write/import/amend/create_edit) and the MCP equivalents (via the host `mcpCall`/hybrid completion). Keep it best-effort.

- [ ] **Step 3: Provide `listMotifs` in index.ts** — `listMotifs: () => backend.invoke('list_motifs', '{}')` (adjust to the real method/shape; `list_motifs` returns the manifest array). `tsc -b` clean.

- [ ] **Step 4: Run tests** — `cd apps/desktop && npx vitest run src/main/state/ts-actor-host.test.ts && npx tsc -b` → PASS, clean.

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/ts-actor-host.test.ts
git commit -m "feat(state-migration): hydrate TS motif manifest cache from list_motifs (Phase 4a-ii §2.3)"
```

---

## Task 8: Extend the differential drivers + author corpus sequences (§2.2/§2.3)

**Files:**
- Modify: `apps/desktop/native/src/bin/replay_driver.rs`, `prod_driver.rs`, `mcp_driver.rs` (add_motif arms + ref-capture)
- Create: `apps/desktop/fixtures/state-corpus/sequences-prod/add-motif-*.json`, `sequences-mcp/add-motif-*.json`, `sequences/countdown-clamp.json` (+ the matching prod/summary seq for the clamp)

**Interfaces:** the drivers run the REAL Rust `add_motif` (compute + Rust-actor apply) to produce the oracle; the TS replay applies the captured payload through the TS actor. Renderer (`prod_driver`, actor source `User`) and MCP (`mcp_driver`, agent actor + ToolResult shape) are gated SEPARATELY.

- [ ] **Step 1: Add driver arms** — in each driver's dispatch/`extract_ref_id`, add `add_motif`:
  - `prod_driver.rs`: route `add_motif` through `backend.dispatch("add_motif", args)`; `extract_ref_id` returns the layer id (so a seq can ref the layer). The no-`track_id` case mints track THEN layer — ensure ref-capture grabs the LAYER id (the return), and document that the intermediate Overlay track id is allocated first (matches the TS two-commit order).
  - `mcp_driver.rs`: route via `dispatch_tool(&backend, "add_motif", …)`; `extract_ref_id` parses the layer id from the ToolResult.
  - `replay_driver.rs`: `add_motif` is NOT a state-actor op (it's a command/MCP composite) — the state/summary dimensions replay via `prod`/`mcp`, so `replay_driver` does NOT need an add_motif arm (Motif layers already replay as `add_layer` sub-kind for the clamp seq). Confirm the countdown-clamp seq uses `add_layer`(Motif) + `update_layer_params`, both already in `replay_driver`.

- [ ] **Step 2: Author add_motif seqs** — `sequences-prod/add-motif-no-track.json` (`{op:'add_motif', motif_id:'countdown', t_start_us:0, ref:'L1'}` → creates Overlay + Motif layer), `add-motif-existing-track.json` (with a `track_id:@A` after an add_track), and `sequences-mcp/add-motif-*.json` (MCP variants). Use only the built-in `countdown` motif (the only motif the harness has).

- [ ] **Step 3: Author the countdown-clamp seq** — `sequences/countdown-clamp.json` (+ prod/summary mirrors): add a `countdown` Motif layer wide (e.g. t_end 10s, props.seconds:10), then `update_layer_params` props.seconds→3 to drop the cap below the window and fire the clamp. The TS differential replay must seed the actor's manifest cache with the built-in `countdown` manifest (wire the replay harness — `replay.ts`/the prod replay — to inject `manifestCacheFromList([countdownManifest])` so the clamp has its cap). Document this seeding in the corpus README.

- [ ] **Step 4: Build the drivers** — `cd apps/desktop && cargo build --features replay,jobs,export,mcp,cloud,motifs --bin replay_driver --bin prod_driver --bin mcp_driver` clean (surface compile errors before regen).

- [ ] **Step 5: Commit (sources + seqs; oracles regen in Task 9)**
```bash
git add apps/desktop/native/src/bin/*.rs apps/desktop/fixtures/state-corpus/sequences*/*.json apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): driver add_motif arms + add_motif/countdown-clamp corpus seqs (Phase 4a-ii §2.2/§2.3)"
```

---

## Task 9: FINAL oracle regeneration + differential gates (§2.8)

**Files:** `apps/desktop/fixtures/state-corpus/oracle*/…` (NEW files only)

**This is the final regeneration.** A CONTROLLER step (needs the napi/cargo toolchain), not an implementer edit.

- [ ] **Step 1: Regenerate** — `cd apps/desktop && node scripts/gen-state-oracle.mjs` (with env `FFMPEG_DIR=<Gyan.FFmpeg.Shared>/ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH+=$FFMPEG_DIR/bin`). The script runs each seq twice for determinism; any `NONDETERMINISTIC` line is a BUG (fix before committing).

- [ ] **Step 2: Assert ADDITIVITY** — `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` MUST be empty (no pre-existing oracle modified). Only NEW oracle files (the add_motif + countdown-clamp seqs across oracle/oracle-prod/oracle-mcp/oracle-summary) appear as untracked/added. If any existing oracle changed, STOP — a driver arm perturbed allocation; diagnose.

- [ ] **Step 3: Run ALL differential gates** — `cd apps/desktop && npx vitest run src/main/state` → every `*.differential.test.ts` green with `skipped===[]` (the new add_motif/clamp seqs now in-vocabulary and byte-identical to Rust). `npx tsc -b` clean.

- [ ] **Step 4: Commit the oracles**
```bash
git add apps/desktop/fixtures/state-corpus/
git commit -m "test(state-migration): FINAL oracle regen — add_motif + countdown-clamp (Phase 4a-ii §2.8)"
```

---

## Task 10: Full verification + flag-on e2e (slice-4a exit)

- [ ] **Step 1: Full suite** — `cd apps/desktop && npx vitest run` (FULL, not just src/main/state) → all green; `npx tsc -b` clean.
- [ ] **Step 2: Rust** — `cargo build --features replay,jobs,export,mcp,cloud,motifs` clean; `cargo test --features jobs,export,motifs --lib` green (incl. the motif-cap golden + fresh_media_item test). `npm run napi:build` clean.
- [ ] **Step 3: Blocked sets ∅** — confirm `BLOCKED_UNDER_FLAG` and `MCP_BLOCKED_UNDER_FLAG` are both empty.
- [ ] **Step 4: Flag-on e2e** — rebuild (`npm run build`) then `npx playwright test -c playwright.config.ts e2e/electron/ts-actor-flip.spec.ts e2e/electron/mcp-flip.spec.ts` green; add a NEW e2e (or extend) that, with `WEFTCUT_TS_ACTOR=1`, **adds a motif** via the renderer + MCP path (now hybrid, no longer rejected) and asserts a Motif layer lands. (This is one of the §3 transition's never-soaked paths — verifying it here de-risks the transition.)
- [ ] **Step 5: Corpus additivity (final)** — `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` empty.

---

## Self-Review

**Spec coverage (vs §2.2/§2.3/§2.4/§2.8):**
- §2.2 add_motif hybrid: Task 5 (write-free compute + track *plan*, no minted id), Task 6 (two-commit TS apply minting track→layer, un-block, renderer+MCP separate gating), Task 8 (drivers + separate prod/mcp seqs). ✓ The "track plan not id" contract + the no-`track_id` two-commit order are pinned. ✓
- §2.3 Motif clamp: Task 2 (cache + cap helper twin), Task 3 (cross-language golden), Task 4 (clamp port + cache injection), Task 7 (runtime hydration from list_motifs), Task 8 Step 3 (countdown-clamp seq + replay cache seeding). ✓ The cap twin EXCLUDES content_duration_s (distinct from the renderer's resolveMotifContentDurationUs). ✓
- §2.4 fresh_media_item: Task 1 (read_mirror Arc + thread into spawn_*; mirror-or-actor read). ✓
- §2.8 exit: Task 9 (FINAL additive regen, all gates skipped===[]), Task 10 (full vitest + cargo + e2e; blocked sets ∅). ✓

**Open design decisions (flag for human before execution):**
1. **Clamp cache parity:** the TS clamp uses the full `list_motifs` cache (built-ins + user), so it clamps USER motifs where Rust's builtins-only clamp (mutations.rs:401) does not. The differential gate uses the built-in `countdown` (parity holds); user-motif clamping is a TS-only improvement NOT exercised by the harness (the harness embeds only built-ins). Alternative: mirror Rust's builtins-only limitation exactly. **Recommended: full cache (more correct); documented divergence.**
2. **fresh_media_item threading:** `read_mirror` → `Arc<Mutex<…>>` + a cloned handle threaded into the three `spawn_*` closures. Alternative: capture a snapshot accessor closure. **Recommended: Arc<Mutex> (minimal ripple).**
3. **add_motif return shape:** Task 6 returns the layer id as text — confirm against Rust `add_motif`'s actual ToolResult (Area A found the handler returns the layer id; verify the renderer command return matches so the prod-differential ref-capture aligns).

**Placeholder scan:** the driver-arm and corpus-seq tasks (8) describe the seqs concretely (countdown only, the two add_motif shapes, the clamp shrink) with the gate (Task 9 additivity + skipped===[]) as acceptance — the SDD pattern for mechanical corpus bulk. The clamp code (Task 4) and cap helper (Task 2) are full. No `TODO`/`TBD`.

**Type consistency:** `Manifest`/`MotifManifestCache`/`resolveMotifMaxDurUs` (Task 2) are consumed identically in Tasks 3/4/7. `AddMotifPlan`/`TrackPlan` (Task 5) ↔ the `runHybrid` parse shape (Task 6) match. `setMotifManifests`/`motifManifests` (Task 4) consumed by Task 7. ✓

**Ordering note:** Tasks 1 (fresh_media), 2-3 (cache+golden) are independent and can lead. 4 needs 2. 5 before 6. 7 needs 4. 8 needs 5+6 (drivers) and 4 (clamp replay seeding). 9 needs 8. 10 last. The FINAL regen (9) happens ONCE, after all additive ports.
