# Phase 4a-ii — slice-4a stragglers (motifs → TS: shared catalog + pure-TS add_motif + clamp + fresh_media_item) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete slice 4a by pulling the motif *catalog logic* into a shared TS module, making `add_motif` a **pure TS recorded mutation** (no hybrid), porting the Motif `update_layer_params` content-window clamp, and re-pointing `fresh_media_item` at the read-mirror — so `BLOCKED_UNDER_FLAG`/`MCP_BLOCKED_UNDER_FLAG` reach ∅. **This is the FINAL oracle regeneration** before the 4b delete.

**Architecture:** The motif catalog (manifest model, strict `canonicalizeProps`, cap/end resolvers, built-in manifests) becomes ONE shared TS module imported by BOTH Electron-main (the actor: `add_motif`, the clamp) and the renderer (render/preview) — eliminating the existing renderer-vs-Rust partial twin. `add_motif` is a normal recorded mutation: canonicalize props in TS (reject-before-commit), resolve version/end in TS, then the no-`track_id` two-commit (mint Overlay track, then Motif layer). The clamp uses the shared catalog. The catalog's user-motif layer hydrates from Rust `list_motifs` (a read; the store/authoring stay Rust as a deferred follow-up). The `motif://` byte-server stays Rust (asset server for embedded built-in HTML). All differential-gated against the live Rust `add_motif`/clamp (the gate proves TS `canonicalizeProps`/cap ≡ Rust); the corpus grows additively; **this is the last regen** (harness retired in 4b). Supersedes spec §2.2's hybrid (see spec §9.8).

**Tech Stack:** Rust (`apps/desktop/native/`), TypeScript (Electron main `src/main/state/` + a new shared `src/shared/motifs/` + renderer `src/renderer/render/motifs/`), Vitest, Immer, the `weftcut-eval` wasm leaf (`snapFrameFloor`/`snapFrameRound` via `snap.ts`). Oracle regen via `node scripts/gen-state-oracle.mjs` (env `FFMPEG_DIR`/`LIBCLANG_PATH`/`PATH+=$FFMPEG_DIR/bin`, `--features replay,jobs,export,mcp,cloud,motifs`).

## Global Constraints

From the spec (`specs/2026-06-25-state-actor-phase-4-design.md` §2.2[superseded→§9.8]/§2.3/§2.4/§2.8/§9.8); every task implicitly includes these.

- **ADDITIVE corpus only.** Existing oracles stay byte-identical: `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` empty at every commit; only NEW oracle files appear (Task 7's regen is the ONLY place). Drivers gain arms additively.
- **Determinism / id order is sacred.** TS `add_motif` mints ids in Rust's exact no-`track_id` order: **track first** (Overlay), **layer second**. Canonicalize/resolve happen BEFORE any commit (reject-before-commit), so a malformed motif/props burns NO id.
- **ONE shared catalog, no twin.** The catalog logic lives in `src/shared/motifs/` and is imported by main AND renderer. Do NOT create a main-only catalog beside the renderer's — unify the renderer onto the shared module. The Rust catalog stays alive ONLY as the differential oracle (deleted in 4b).
- **`canonicalizeProps` must match Rust `canonicalize_props` byte-for-byte on valid input** (proven by the add_motif differential gate): reject unknown keys → error; fill missing from defaults; validate EVERY value (string `max_length` = Unicode char count; color `^#([0-9a-fA-F]{3,4,6,8})$`; number `min`/`max`; enum `options`); serialize with keys in **alphabetical order** (mirrors Rust `BTreeMap`). A `canonicalizePropsLenient` (drop-unknown, default-on-invalid, never throws) is the migration sibling.
- **Cap helper EXCLUDES `content_duration_s`.** `resolveMotifMaxDurUs(manifest, props)` mirrors Rust `resolve_motif_max_dur_us` (catalog.rs:130-142): prop-driven cap → `round(n*1e6)` when `max_duration_prop`'s value is finite & >0, else `round(max_duration_s*1e6)` filtered >0, else `null`. Do NOT reuse `resolveMotifContentDurationUs` (which includes `content_duration_s`).
- **Clamp math mirrors Rust** (mutations.rs:391-449): no-op when `src_in + width ≤ content_dur`; else `new_src_in = snapFrameRound(snapFrameFloor(min(src_in, content_dur-1), fps), fps)`, `cappedEnd = snapFrameRound(snapFrameFloor(t_start + (content_dur - new_src_in), fps), fps)`, `t_end = max(cappedEnd, t_start+1)`; then `applyDurationAutofit`.
- **NO golden fixture.** The catalog is TS-sole-owner after 4b (no Rust twin to drift from); the differential gate covers TS≡Rust during the final regen. Guard with strong TS unit tests, not a cross-language golden.
- **`tsc -b` is a required gate** after any shared-interface change (vitest = esbuild, no typecheck).
- **TimeUs is `number`**; preference-shaped patches are unrecorded; the wasm eval leaf is never reimplemented.
- **Final-regen discipline:** after Task 7, all differential gates report `skipped===[]`. Do NOT delete drivers / the `replay` feature / the Rust catalog — that is 4b.
- **Deferred (NOT this slice):** porting `UserMotifStore` + authoring (`write/install/delete`) to TS; de-hybridizing install/acknowledge. **Kept Rust:** the `motif://` byte-server.

---

## File Structure

| File | Responsibility | This slice |
|---|---|---|
| `apps/desktop/native/src/napi_backend.rs` | `read_mirror` → `Arc<Mutex<…>>` + `read_mirror_handle()` (§2.4) | Modify |
| `apps/desktop/native/src/jobs/mod.rs` | `fresh_media_item` reads the mirror; `spawn_conform`/`spawn_quick_proxy`/`spawn_proxy` take the mirror handle (§2.4) | Modify |
| `apps/desktop/src/shared/motifs/catalog.ts` | shared `Manifest`/`PropSpec` types, strict `canonicalizeProps` + `canonicalizePropsLenient`, `resolveMotifMaxDurUs`, `resolveMotifTEndUs`, `resolveMotifContentDurationUs`, `MotifCatalog` registry (built-ins + settable user layer) | Create |
| `apps/desktop/src/shared/motifs/builtin/*/manifest.json` | the 3 built-in manifests (MOVED from `src/renderer/render/motifs/builtin/`) | Move |
| `apps/desktop/src/shared/motifs/catalog.test.ts` | unit tests: canonicalize strict rules + key order + cap/end resolvers | Create |
| `apps/desktop/src/renderer/render/motifs/catalog.ts` | re-export the shared module; keep the React subscription + `setUserMotifs` runtime layer | Modify |
| `apps/desktop/src/renderer/render/motifs/Rasterizer.ts` | use the shared `canonicalizeProps` | Modify |
| `apps/desktop/src/main/state/actor.ts` | hold a `MotifCatalog`; clamp wired into `update_layer_params`; `add_motif` dispatch + mcpCall arm (§2.2/§2.3) | Modify |
| `apps/desktop/src/main/state/mutations/params.ts` | the Motif content-window clamp (port of mutations.rs:391-449) | Modify |
| `apps/desktop/src/main/state/mutations/motif.ts` | `applyAddMotif` (canonicalize + two-commit builder helpers) | Create |
| `apps/desktop/src/main/state/commands.ts` | renderer `add_motif` command builder (→ PRODUCTION_OPS) | Modify |
| `apps/desktop/src/main/state/snap.ts` | ensure `snapFrameFloor` exported | Modify (if needed) |
| `apps/desktop/src/main/state/ts-actor-host.ts` | `listMotifs` dep + hydrate the actor catalog at `start()` + refresh on motif-store mutations | Modify |
| `apps/desktop/src/main/index.ts` | provide `listMotifs` dep | Modify |
| `apps/desktop/src/main/state/router.ts` | `add_motif` → `command` (PRODUCTION_OPS); `BLOCKED_UNDER_FLAG` → ∅ (§2.2) | Modify |
| `apps/desktop/src/main/mcp/mutationTools.ts` | `add_motif` → `MCP_TOOLS` (TS arm); `MCP_BLOCKED_UNDER_FLAG` → ∅ (§2.2) | Modify |
| `apps/desktop/native/src/bin/{prod_driver,mcp_driver}.rs` | `add_motif` ref-capture arms (renderer + MCP gated separately) (§2.2) | Modify |
| `apps/desktop/fixtures/state-corpus/sequences{-prod,-mcp,}/…` | add_motif seqs + countdown-clamp seq (§2.2/§2.3) | Create |

---

## Task 1: `fresh_media_item` reads the read-mirror (§2.4, Rust, no differential)

**Files:** Modify `native/src/napi_backend.rs` (`read_mirror` field + `read_mirror_handle()`), `native/src/jobs/mod.rs` (`fresh_media_item` + the three `spawn_*`). Test: `jobs/mod.rs` `#[cfg(test)]`.

**Interfaces:** Produces `read_mirror: Arc<Mutex<Option<ReadMirror>>>`, `fn read_mirror_handle(&self) -> Arc<Mutex<Option<ReadMirror>>>`, `fresh_media_item(project: &ProjectHandle, mirror: &Arc<Mutex<Option<ReadMirror>>>, media_id, fallback) -> MediaItem`.

- [ ] **Step 1: Make `read_mirror` shareable** — `napi_backend.rs`: field `read_mirror: std::sync::Mutex<Option<ReadMirror>>` → `std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>>`; init `Arc::new(Mutex::new(None))`. `set_project_mirror`/`snapshot_for_read` lock through the Arc unchanged. Add:
```rust
fn read_mirror_handle(&self) -> std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>> { self.read_mirror.clone() }
```

- [ ] **Step 2: Failing test** — with a populated mirror, `fresh_media_item` returns the MIRROR's item; with `None`, the fallback. Run: `cd apps/desktop && cargo test --features jobs,export,motifs --lib fresh_media_item` → FAIL (signature mismatch).

- [ ] **Step 3: Re-point** —
```rust
async fn fresh_media_item(project: &ProjectHandle, mirror: &std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>>, media_id: MediaId, fallback: MediaItem) -> MediaItem {
    if let Some(m) = mirror.lock().expect("read_mirror poisoned").as_ref() {
        return m.project.media_pool.get(&media_id).cloned().unwrap_or(fallback);
    }
    project.snapshot().await.media_pool.get(&media_id).cloned().unwrap_or(fallback)
}
```

- [ ] **Step 4: Thread the mirror** — add `mirror: Arc<Mutex<Option<ReadMirror>>>` to `spawn_conform`/`spawn_quick_proxy`/`spawn_proxy` (capture into the `async move`); pass to `fresh_media_item`. At each spawn SITE (a `Backend` method) pass `self.read_mirror_handle()`. `spawn_waveform` unchanged. Update ALL call sites.

- [ ] **Step 5: Build + test** — `cargo test --features jobs,export,motifs --lib fresh_media_item` PASS; `cargo build --features replay,jobs,export,mcp,cloud,motifs` clean.

- [ ] **Step 6: Commit**
```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/jobs/mod.rs
git commit -m "fix(state-migration): fresh_media_item reads the read-mirror under the flag (Phase 4a-ii §2.4)"
```

---

## Task 2: Shared TS motif catalog module (§2.2/§2.3 — the core port)

**Files:**
- Create: `apps/desktop/src/shared/motifs/catalog.ts`
- Move: `src/renderer/render/motifs/builtin/{countdown,lower-third,text-fx}/manifest.json` → `src/shared/motifs/builtin/…`
- Test: `apps/desktop/src/shared/motifs/catalog.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface Manifest { id: string; name: string; version: number; size: [number, number]
  default_duration_s: number; max_duration_s?: number | null; max_duration_prop?: string | null
  content_duration_s?: number | null; props_schema: Record<string, PropSpec> }
export type PropSpec =
  | { type: 'string'; default: string; max_length?: number; multiline?: boolean }
  | { type: 'color'; default: string }
  | { type: 'number'; default: number; min?: number; max?: number }
  | { type: 'enum'; default: string; options: string[] }
export class MotifPropError extends Error { constructor(public readonly detail: string) { super(detail) } }
export function canonicalizeProps(manifest: Manifest, provided: unknown): Record<string, unknown> // strict, THROWS MotifPropError
export function canonicalizePropsLenient(manifest: Manifest, provided: unknown): Record<string, unknown> // never throws
export function resolveMotifMaxDurUs(manifest: Manifest, props: Record<string, unknown>): number | null
export function resolveMotifTEndUs(tStartUs: number, tEndUs: number | null, defaultDurationS: number, maxDurUs: number | null): number
export function resolveMotifContentDurationUs(manifest: Manifest, props: Record<string, unknown>): number | null
export const BUILTIN_MANIFESTS: ReadonlyMap<string, Manifest> // the 3 built-ins, statically imported
export class MotifCatalog { // built-ins + settable user layer (built-ins win on id collision)
  get(id: string): Manifest | undefined
  setUserManifests(ms: Manifest[]): void
  list(): Manifest[] }
```
The built-ins are STATIC imports (`import countdown from './builtin/countdown/manifest.json'` ×3) → `BUILTIN_MANIFESTS`. (No `import.meta.glob` — that's renderer-only; static imports work in both bundles.)

- [ ] **Step 1: Move the built-in manifests** — `git mv` the 3 `manifest.json` into `src/shared/motifs/builtin/<dir>/manifest.json`. (HTML stays where it is — served by the Rust byte-server; this slice touches only manifests.)

- [ ] **Step 2: Write failing unit tests** — port the Rust `validate_prop` rules (catalog.rs:332-373) + canonicalize semantics:
```typescript
const m: Manifest = { id:'t', name:'T', version:1, size:[1,1], default_duration_s:5, props_schema: {
  title: { type:'string', default:'Hi', max_length:5 }, color: { type:'color', default:'#fff' },
  n: { type:'number', default:1, min:0, max:10 }, mode: { type:'enum', default:'a', options:['a','b'] } } }
it('fills defaults + alphabetical key order', () => {
  expect(Object.keys(canonicalizeProps(m, {}))).toEqual(['color','mode','n','title']) }) // sorted
it('rejects unknown key', () => expect(() => canonicalizeProps(m, { nope:1 })).toThrow(MotifPropError))
it('string max_length is unicode char count', () => expect(() => canonicalizeProps(m, { title:'abcdef' })).toThrow())
it('color must match #rgb/#rgba/#rrggbb/#rrggbbaa', () => expect(() => canonicalizeProps(m, { color:'red' })).toThrow())
it('number min/max', () => { expect(() => canonicalizeProps(m, { n:-1 })).toThrow(); expect(() => canonicalizeProps(m, { n:11 })).toThrow() })
it('enum options', () => expect(() => canonicalizeProps(m, { mode:'z' })).toThrow())
it('lenient drops unknown + defaults invalid, never throws', () => {
  expect(canonicalizePropsLenient(m, { nope:1, n:99 })).toEqual({ color:'#fff', mode:'a', n:1, title:'Hi' }) })
it('resolveMotifMaxDurUs excludes content_duration_s', () => {
  expect(resolveMotifMaxDurUs({ ...m, content_duration_s:99 }, {})).toBeNull()
  expect(resolveMotifMaxDurUs({ ...m, max_duration_prop:'n', max_duration_s:10 }, { n:3 })).toBe(3_000_000) })
```
Run → FAIL (module not found).

- [ ] **Step 3: Implement** — `canonicalizeProps` mirrors Rust (catalog.rs:216-250): null→`{}`; reject non-object + unknown keys; iterate `props_schema` keys **sorted alphabetically**; per key use provided-or-default; validate via the per-type rules; return an object built in sorted-key order. `canonicalizePropsLenient` = drop-unknown + default-on-invalid (catalog.rs:258-273). `resolveMotifMaxDurUs` per the Global Constraint. `resolveMotifTEndUs` mirrors commands/motifs.rs:19-36 (NOTE: the `None` branch uses `(default_duration_s*1e6) as i64` = TRUNCATE via `Math.trunc`, NOT round — match Rust). `MotifCatalog` holds `BUILTIN_MANIFESTS` + a user Map; `get` prefers built-ins. Run Step 2 → PASS. `npx tsc -b` clean.

- [ ] **Step 4: Build wiring** — verify both bundles resolve `src/shared/`: add a tsconfig path/project-reference if needed (mirror how `snap.ts` shares the eval leaf across main↔renderer). Run `cd apps/desktop && npx tsc -b` clean (main + renderer projects).

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/shared/motifs/ 
git commit -m "feat(state-migration): shared TS motif catalog (canonicalize/cap/manifests) (Phase 4a-ii §2.2/§2.3)"
```

---

## Task 3: Unify the renderer onto the shared catalog (§9.8 — kill the twin)

**Files:** Modify `src/renderer/render/motifs/catalog.ts` (re-export shared types/fns; keep the React subscription + `setUserMotifs`), `src/renderer/render/motifs/Rasterizer.ts` (use shared `canonicalizeProps`). Tests: existing renderer motif tests.

**Interfaces:** Consumes Task 2's shared module. Produces: the renderer catalog is a thin layer over `src/shared/motifs/catalog.ts` (no duplicate manifest model / canonicalize logic).

- [ ] **Step 1: Re-point `catalog.ts`** — replace the local `MotifManifest`/`PropSpec` types + `canonicalizePropsLenient`/`resolveMotifContentDurationUs` with re-exports from `../../../shared/motifs/catalog` (adjust the relative path). Keep the renderer-only runtime: `import.meta.glob` is replaced by the shared `BUILTIN_MANIFESTS`; `setUserMotifs`/`subscribeMotifCatalog`/`motifCatalogRevision` (the React `useSyncExternalStore` layer) stay, now backed by a shared `MotifCatalog` instance. Built-in manifest imports now resolve from `src/shared/motifs/builtin/`.

- [ ] **Step 2: Re-point `Rasterizer.ts`** — `canonicalizeProps` import now from the shared module (the strict one; remove the local copy). Confirm `exportBake.ts` (which calls `Rasterizer`'s canonicalize + `resolveMotifContentDurationUs`) still resolves.

- [ ] **Step 3: Run renderer tests + typecheck** — `cd apps/desktop && npx vitest run src/renderer/render/motifs && npx tsc -b` → green, clean. (The strict canonicalize now ALSO validates provided values + sorts keys — confirm no renderer test relied on insertion-order keys or unvalidated values; fix any that did, noting the behavior is now Rust-faithful.)

- [ ] **Step 4: Commit**
```bash
git add apps/desktop/src/renderer/render/motifs/catalog.ts apps/desktop/src/renderer/render/motifs/Rasterizer.ts
git commit -m "refactor(state-migration): renderer motif catalog re-exports the shared module (Phase 4a-ii §9.8)"
```

---

## Task 4: Wire `MotifCatalog` into the actor + port the Motif clamp + hydrate from `list_motifs` (§2.3)

**Files:** Modify `src/main/state/actor.ts` (hold an injectable `MotifCatalog`; clamp in `update_layer_params`), `src/main/state/mutations/params.ts` (the clamp), `src/main/state/snap.ts` (ensure `snapFrameFloor`), `src/main/state/ts-actor-host.ts` (`listMotifs` dep + hydrate), `src/main/index.ts` (`listMotifs` dep). Tests: `params.test.ts` + `ts-actor-host.test.ts`.

**Interfaces:** Consumes Task 2's `MotifCatalog`/`resolveMotifMaxDurUs`, `snapFrameRound`/`snapFrameFloor`, `applyDurationAutofit`. Produces: `createActor` accepts `motifCatalog?: MotifCatalog` (default a fresh one with built-ins) + `setUserMotifManifests(ms)`; `applyUpdateLayerParams(p, id, patch, catalog)` clamps Motif geometry; host hydrates the user layer from `list_motifs`.

- [ ] **Step 1: Confirm `snapFrameFloor`** — `rg -n "snapFrameFloor|snapFrameRound" src/main/state/snap.ts`; if absent, re-export the leaf's `snap_floor` alongside `snap_round`.

- [ ] **Step 2: Failing clamp test** — a `countdown` Motif layer (cache has the built-in) at `t_start=0,t_end=10s,src_in=0,props.seconds=10` (cap 10s, no clamp); `update_layer_params props.seconds=3` → cap 3s, window src_out=10s>3s → clamp `t_end→3s`, `src_in→0`. Plus a grow no-op case. Run → FAIL (params.ts field-merges only).

- [ ] **Step 3: Port the clamp** — `applyUpdateLayerParams(p, id, patch, catalog: MotifCatalog)`: after the field-merge, if `params.kind==='Motif'`, `const manifest = catalog.get(params.motif_id)`; if none → return (no clamp); `const contentDur = resolveMotifMaxDurUs(manifest, params.props)`; if null → return; then the clamp math (Global Constraint) with `snapFrameRound`/`snapFrameFloor` (match snap.ts's arg shape) and `applyDurationAutofit(p)` on geometry change.

- [ ] **Step 4: Thread the catalog** — `createActor` gains `motifCatalog?` (stored; default `new MotifCatalog()`) + `setUserMotifManifests(ms)`. The `update_layer_params` dispatch arm passes the stored catalog. Update all `applyUpdateLayerParams` call sites.

- [ ] **Step 5: Host hydration** — `TsActorHostDeps.listMotifs?: () => Promise<string>`. In `start()` (after `pushMirror`): best-effort `deps.listMotifs?.().then(j => actor.setUserMotifManifests(manifestsFromList(JSON.parse(j))))` (a small adapter keeping only Manifest fields). Add `refreshMotifCatalog()` called after a motif-store-mutating channel/tool (install/delete/write/import/amend/create_edit). `index.ts`: `listMotifs: () => backend.invoke('list_motifs','{}')`.

- [ ] **Step 6: Run tests + full suite** — `cd apps/desktop && npx vitest run src/main/state/mutations/params.test.ts src/main/state/ts-actor-host.test.ts && npx tsc -b` PASS/clean; `npx vitest run src/main/state` green; differential gates still `skipped===[]` (no Motif corpus seq yet — clamp inert until Task 6).

- [ ] **Step 7: Commit**
```bash
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mutations/params.ts apps/desktop/src/main/state/snap.ts apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/mutations/params.test.ts apps/desktop/src/main/state/ts-actor-host.test.ts
git commit -m "feat(state-migration): Motif clamp via shared catalog + list_motifs hydration (Phase 4a-ii §2.3)"
```

---

## Task 5: `add_motif` as a pure TS recorded mutation + un-block → blocked sets ∅ (§2.2)

**Files:** Create `src/main/state/mutations/motif.ts` (`applyAddMotif` helpers). Modify `actor.ts` (`add_motif` dispatch arm + mcpCall arm), `commands.ts` (renderer builder + PRODUCTION_OPS), `router.ts` (BLOCKED→∅), `mutationTools.ts` (MCP_TOOLS + MCP_BLOCKED→∅). Tests: `__tests__/add-motif.test.ts` + router/mutationTools test updates.

**Interfaces:** Consumes Task 2's `canonicalizeProps`/`resolveMotifMaxDurUs`/`resolveMotifTEndUs` + the actor's `MotifCatalog`. Produces: renderer channel `add_motif` → `{kind:'command'}`; MCP tool `add_motif` → `'ts'` (dedicated mcpCall arm); both reject-before-commit; return the **layer id** (confirm vs Rust `add_motif`'s ToolResult/return).

`add_motif` is NOT a hybrid. The arm canonicalizes (strict, throws `MotifPropError`→reject), resolves version (`manifest.version`) + `t_end` (`resolveMotifTEndUs(t_start, t_end_opt, manifest.default_duration_s, resolveMotifMaxDurUs(manifest, props))`), then the two-commit: if no `track_id` → `add_track` (Overlay) mints the track id, then `add_layer`(Motif) mints the layer id; if `track_id` given → just `add_layer`(Motif). Mirrors Rust commands/motifs.rs:148-211 / mcp/tools.rs:2023-2094 — but minting on the TS side.

- [ ] **Step 1: Failing tests** — (a) routing: `routeChannel('add_motif')`→`{kind:'command'}`, `routeMcpTool('add_motif')`→`'ts'`. (b) `actor.command('add_motif', { motif_id:'countdown', t_start_us:0 })` (no track) creates an Overlay track THEN a Motif layer (id order), layer params `{kind:'Motif', motif_id:'countdown', motif_version:<from manifest>, props:<canonical countdown defaults>, src_in_us:0, transform:identity, opacity:Static(1)}`. (c) bad props reject before commit (no track/layer minted). Run → FAIL (blocked / no arm).

- [ ] **Step 2: `applyAddMotif` helper** — in `mutations/motif.ts`, a helper that builds the Motif `LayerParams` from canonicalized props + version, and (given the actor's commit primitives) does the two-commit. Keep the canonicalize/resolve in the dispatch arm (so it rejects before the first commit). Reuse the existing `add_track`/`add_layer` mutation paths (the actor already supports Motif `add_layer` — the replay driver's `add_layer` "Motif" sub-kind proves the params shape).

- [ ] **Step 3: Dispatch + mcpCall arms** — `actor.ts`: `add_motif` dispatch arm (renderer command path) + a dedicated `mcpCall` `case 'add_motif'` (MCP agent actor; returns `toolText(layerId)`). Both: resolve manifest from the actor's `MotifCatalog` (`MotifNotFound` error if absent), `canonicalizeProps` (reject), resolve version/end, two-commit. `commands.ts`: MECHANICAL/builder entry for `add_motif` (camelCase wire args → op) + add `'add_motif'` to `PRODUCTION_OPS`.

- [ ] **Step 4: Un-block** — `router.ts`: `BLOCKED_UNDER_FLAG = new Set([])` (∅; update the doc comment — slice 4a complete). `mutationTools.ts`: `MCP_BLOCKED_UNDER_FLAG = new Set([])` (∅); `add_motif` is now served via `MCP_TOOLS` (the TS arm) — add it to `MCP_TOOLS` (and the §2.7 `MCP_TOOL_DEFS` table as a dedicated def with a `parseDedicated` validating `motif_id`/`track_id?`/`t_start_us`/`t_end_us?`/`props?`). Update the router/mutationTools/bijection tests (add_motif moves blocked→ts; blocked sets empty; bijection still holds — add_motif now in the TS table, routes 'ts').

- [ ] **Step 5: Run tests + typecheck** — `cd apps/desktop && npx vitest run src/main/state/__tests__/add-motif.test.ts src/main/state/router.test.ts src/main/state/__tests__/mcp.catalog-bijection.test.ts src/main/mcp/*.test.ts && npx tsc -b` PASS/clean; full `npx vitest run src/main/state` green (differential still `skipped===[]` — drivers/corpus next).

- [ ] **Step 6: Commit**
```bash
git add apps/desktop/src/main/state/mutations/motif.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/commands.ts apps/desktop/src/main/state/router.ts apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/__tests__/add-motif.test.ts apps/desktop/src/main/state/router.test.ts <bijection/mutationTools tests>
git commit -m "feat(state-migration): add_motif as a pure TS mutation + un-block → blocked sets ∅ (Phase 4a-ii §2.2)"
```

---

## Task 6: Extend the differential drivers + author corpus sequences (§2.2/§2.3)

**Files:** Modify `native/src/bin/prod_driver.rs` + `mcp_driver.rs` (add_motif ref-capture arms). Create `fixtures/state-corpus/sequences-prod/add-motif-*.json`, `sequences-mcp/add-motif-*.json`, `sequences/countdown-clamp.json` (+ prod/summary mirrors for the clamp).

**Interfaces:** the drivers run the REAL Rust `add_motif` (renderer via `backend.dispatch`, MCP via `dispatch_tool`) to produce the oracle; the TS replay runs the TS `add_motif` mutation → asserts byte-identical (proving TS `canonicalizeProps`/cap/version ≡ Rust). Renderer (actor source `User`) and MCP (agent actor + ToolResult shape) gated SEPARATELY.

- [ ] **Step 1: Driver arms** — `prod_driver.rs`: `extract_ref_id` returns the layer id for `add_motif` (the no-`track_id` case mints track THEN layer — capture the LAYER id; document the Overlay track id is allocated first to match the TS two-commit order). `mcp_driver.rs`: parse the layer id from `add_motif`'s ToolResult. `replay_driver.rs` needs NO add_motif arm (state/summary replay the countdown-clamp via `add_layer`(Motif) + `update_layer_params`, both already present; add_motif itself is a command/MCP composite covered by prod/mcp).

- [ ] **Step 2: add_motif seqs** — `sequences-prod/add-motif-no-track.json` (`{op:'add_motif', motif_id:'countdown', t_start_us:0, ref:'L1'}`), `add-motif-existing-track.json` (after an `add_track`, with `track_id:@<ref>`), `sequences-mcp/add-motif-*.json`. Built-in `countdown` only.

- [ ] **Step 3: countdown-clamp seq** — `sequences/countdown-clamp.json` (+ prod/summary mirrors): add a `countdown` Motif layer wide (`t_end 10s`, `props.seconds:10`), then `update_layer_params props.seconds→3` to fire the clamp. The TS differential replay seeds the actor's `MotifCatalog` with the built-in `countdown` (wire `replay.ts`/the prod replay to construct the actor with `new MotifCatalog()` — built-ins are already in it). Document the built-in-only seeding in the corpus README.

- [ ] **Step 4: Build drivers** — `cargo build --features replay,jobs,export,mcp,cloud,motifs --bin prod_driver --bin mcp_driver` clean.

- [ ] **Step 5: Commit (sources + seqs; oracles in Task 7)**
```bash
git add apps/desktop/native/src/bin/*.rs apps/desktop/fixtures/state-corpus/sequences*/*.json apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): driver add_motif arms + add_motif/countdown-clamp corpus seqs (Phase 4a-ii §2.2/§2.3)"
```

---

## Task 7: FINAL oracle regeneration + differential gates (§2.8)

**Files:** `fixtures/state-corpus/oracle*/…` (NEW files only). CONTROLLER step (napi/cargo toolchain).

- [ ] **Step 1: Regenerate** — `cd apps/desktop && node scripts/gen-state-oracle.mjs` (env `FFMPEG_DIR=<Gyan.FFmpeg.Shared>/ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH+=$FFMPEG_DIR/bin`). Any `NONDETERMINISTIC` line is a bug — fix before committing.
- [ ] **Step 2: Assert ADDITIVITY** — `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` MUST be empty (no pre-existing oracle modified; only NEW add_motif/countdown-clamp oracles appear). If an existing oracle changed, STOP — a driver arm perturbed allocation.
- [ ] **Step 3: All differential gates** — `cd apps/desktop && npx vitest run src/main/state` → every `*.differential.test.ts` green `skipped===[]` (the new seqs in-vocabulary, byte-identical to Rust → proves TS canonicalize/cap ≡ Rust). `npx tsc -b` clean.
- [ ] **Step 4: Commit oracles**
```bash
git add apps/desktop/fixtures/state-corpus/
git commit -m "test(state-migration): FINAL oracle regen — add_motif + countdown-clamp (Phase 4a-ii §2.8)"
```

---

## Task 8: Full verification + flag-on e2e (slice-4a exit)

- [ ] **Step 1: Full vitest** — `cd apps/desktop && npx vitest run` (FULL, not just src/main/state — catches renderer/mcp consumers of the unified catalog) → all green; `npx tsc -b` clean.
- [ ] **Step 2: Rust** — `cargo build --features replay,jobs,export,mcp,cloud,motifs` clean; `cargo test --features jobs,export,motifs --lib` green (incl. fresh_media_item). `npm run napi:build` clean.
- [ ] **Step 3: Blocked sets ∅** — confirm `BLOCKED_UNDER_FLAG` and `MCP_BLOCKED_UNDER_FLAG` are both empty.
- [ ] **Step 4: Flag-on e2e** — rebuild (`npm run build`) then `npx playwright test -c playwright.config.ts e2e/electron/ts-actor-flip.spec.ts e2e/electron/mcp-flip.spec.ts` green; add (or extend) an e2e that with `WEFTCUT_TS_ACTOR=1` **adds a motif** (renderer + MCP, now pure-TS, no longer rejected) and asserts a Motif layer lands; and that a motif render/export still works (the unified catalog feeds the renderer + capture). 
- [ ] **Step 5: Corpus additivity (final)** — `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` empty.

---

## Self-Review

**Spec coverage (vs §2.2[→§9.8]/§2.3/§2.4/§2.8/§9.8):**
- §2.2/§9.8 add_motif pure TS: Task 5 (canonicalize+two-commit mutation, renderer command + MCP arm, un-block), Task 6 (drivers + separate prod/mcp seqs). ✓ id order track→layer pinned; reject-before-commit. ✓ NOT a hybrid. ✓
- §2.3 Motif clamp: Task 2 (cap helper twin, EXCLUDES content_duration_s), Task 4 (clamp port + catalog injection + hydration), Task 6 Step 3 (countdown-clamp seq). ✓ No golden — differential gate covers equivalence. ✓
- §2.4 fresh_media_item: Task 1. ✓
- §9.8 shared catalog (no twin): Task 2 (shared module), Task 3 (renderer unification). ✓ Store/authoring deferred; byte-server kept Rust. ✓
- §2.8 exit: Task 7 (final additive regen, skipped===[]), Task 8 (full vitest + cargo + e2e; blocked sets ∅). ✓

**Open design decisions (flag for human):**
1. **Shared-module placement** — `src/shared/motifs/` imported by main + renderer (mirrors the `snap.ts`/eval-leaf cross-project pattern). Task 2 Step 4 verifies the electron-vite/tsconfig wiring; if it resists, fallback = main owns the module + renderer imports from main. **Recommended: src/shared/.**
2. **Renderer unification scope (Task 3)** — re-export only (keep the renderer's React/runtime layer), NOT a rewrite. If the strict canonicalize's new per-value validation breaks a renderer test that fed invalid props, that test was asserting non-Rust-faithful behavior — fix it. **Recommended: minimal re-export.**
3. **add_motif return shape** — Task 5 returns the layer id; confirm against Rust `add_motif`'s actual renderer-return + MCP ToolResult so the prod/mcp ref-capture aligns.
4. **`canonicalizeProps` key order** — alphabetical (Rust `BTreeMap`); the renderer previously used insertion order. The differential gate (canonical props in the add_motif oracle) is the proof; Task 3 Step 3 watches for renderer fallout.

**Placeholder scan:** the driver-arm + corpus tasks (6) name the seqs concretely (countdown only; two add_motif shapes; the clamp shrink) gated by Task 7 additivity + skipped===[]. The catalog (Task 2) + clamp (Task 4) + add_motif (Task 5) carry full code/semantics. No `TODO`/`TBD`.

**Type consistency:** `Manifest`/`PropSpec`/`canonicalizeProps`/`resolveMotifMaxDurUs`/`MotifCatalog` (Task 2) consumed identically in Tasks 3/4/5. `setUserMotifManifests`/`motifCatalog` (Task 4) consumed by Task 5 + the host. ✓

**Ordering:** 1 (fresh_media) independent. 2 → 3 (renderer unify) and 2 → 4 (actor clamp) and 2 → 5 (add_motif). 4 + 5 before 6 (drivers/replay seeding). 6 → 7 (regen). 8 last. The FINAL regen (7) happens ONCE.
