# State-Actor TS Migration — Phase 4b Implementation Plan (Decommission the Rust state actor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently delete the Rust project-state actor and all of its now-dead consumers, split the MCP catalog so Rust advertises only native/compute/hybrid tools while the ~47 TS-executed tools advertise from the TS single-source table, retire the differential harness, and remove the `WEFTCUT_TS_ACTOR` flag — leaving Rust a focused media-compute lib with a read-mirror and a compute-only MCP surface.

**Architecture:** The TS state actor (`apps/desktop/src/main/state/`) is already authoritative at default-on (flag flipped in `f2660636`). 4b removes the fallback: every Rust path that read/mutated the live actor (`ProjectHandle`) is deleted; compute reads consult only the read-mirror (`snapshot_for_read`, no actor fallback); the renderer/MCP surfaces are TS or native-only. The committed oracle corpus survives as **frozen** TS-only regression fixtures (the Rust drivers that minted them are deleted, so no new TS≡Rust oracle can ever be regenerated — hence the pre-delete tag).

**Tech Stack:** TypeScript (Electron main, `apps/desktop/src/main`), Rust napi addon (`apps/desktop/native`, crate `@weftcut/core`), Vitest, Playwright `_electron` e2e, Cargo.

## Global Constraints

- **IRREVERSIBLE.** Once Task 5 deletes the `replay` Cargo feature + driver bins, the corpus is un-regenerable. The pre-flight tag `state-corpus-frozen-pre-phase4b` is the ONLY recovery path. Do not start Task 1 until the tag exists (Step 0).
- **Branch/commit convention:** all work lands on **local `main`, NOT pushed** (the migration's established pattern). Stage by explicit path only — the user edits this checkout from parallel sessions ([[feedback_parallel_sessions_git]]); re-check `git status` before each commit.
- **Commit trailer (verbatim):** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Subject style: `type(state-migration): summary (Phase 4b …)`.
- **The wasm eval leaf is sacred** ([[feedback_engine_source_drift]], [[feedback_snap_math_drift]]): do NOT touch `weftcut-eval`, `snap.ts`, or the renderer eval path.
- **The `state/` MODEL serde modules STAY** (project/layer/track/media/ids/composition/time/animated/color/transform/marker/transition/group/effect/audio_role/keyframe_edits) — Rust deserializes the mirror and computes against them. Only the actor/history/validate LOGIC is deleted.
- **Frozen fixtures STAY:** `apps/desktop/fixtures/state-corpus/{sequences,sequences-prod,sequences-mcp,oracle,oracle-summary,oracle-prod,oracle-mcp}` + all six `*.differential.test.ts` gates + the TS-side `state/replay.ts`. Only the **Rust** drivers + `gen-state-oracle.mjs` are deleted.
- **Verified baseline (HEAD `f2660636`, 2026-06-26):** full vitest = **176 files / 2085 tests / 0 failures / 0 skipped**; all six differential gates assert `skipped===[]` and pass. Every task's TS verification must keep this green; the byte-frozen corpus must stay byte-identical (`git diff` over the oracle dirs empty).
- **Rust build gates:** `npm run napi:build` (release napi addon) and `cargo build` under the feature set the build uses. The differential drivers needed `--features replay,jobs,export,mcp,cloud,motifs`; after Task 5 the `replay` feature is gone, so the standard `napi:build` is the gate.
- **PowerShell `Set-Content` mangles UTF-8 in Rust source** ([[feedback_powershell_setcontent_cp1252]]) — use the Edit/Write tools, never `Set-Content`, for `.rs` files.

---

## Pre-flight (Step 0 — controller runs this BEFORE dispatching Task 1; not an SDD task)

- [ ] **0.1 Confirm the green baseline.** From `apps/desktop`:
  - `npm run typecheck` → clean.
  - `npm test` → `2085 passed (2085)`, `0 skipped`.
  - `npm run napi:build` then `cargo build --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs` → both succeed. (If the working tree is dirty from a parallel session, resolve before proceeding.)
- [ ] **0.2 Tag the frozen corpus** at the current HEAD (the last commit where the live Rust harness can still regenerate the oracles):

```bash
git tag -a state-corpus-frozen-pre-phase4b -m "Last commit where the differential harness (replay/prod/mcp drivers) can regenerate the state-corpus oracles against the live Rust actor. Phase 4b deletes the actor + drivers; the committed oracles become frozen TS-only regression fixtures. Check out this tag to regenerate."
git tag --list 'state-corpus-frozen-pre-phase4b'   # confirm it exists
```

The tag is local-only (matches the migration's no-push convention). Do not delete it.

---

## Deletion order (why the tasks are sequenced this way)

The Rust build cannot be green at every micro-step because the actor's consumers are tightly coupled. The order guarantees a green build at each **task** boundary:

1. **T1 (TS): ListTools merge** — so after the Rust mutation catalog shrinks (T3), the MCP surface still advertises the TS tools. Safe while Rust is intact (the merge filters the Rust catalog to non-`ts` names).
2. **T2 (TS): flag removal + bring-up reorder** — TS always constructs the actor; the mirror is pushed before the MCP host starts. Rust still compiles (actor becomes unreachable, not yet deleted).
3. **T3 (Rust): MCP catalog split** — delete the MCP mutation handlers + `keyframes.rs` while the actor still exists (so the *remaining* native handlers still compile); shrink `tool_table!`.
4. **T4 (Rust): the actor core + all live consumers** — the irreversible heart; one coupled deletion that only builds green when complete (dispatch fallback, autosave, jobs write-back, `snapshot_for_read` mirror-only, `Backend.project` removal, `state/mod.rs`, flag-authority plumbing).
5. **T5 (Rust+scripts): harness retirement** — delete the `replay` feature, driver bins, re-exports, `gen-state-oracle.mjs`; mark the corpus README frozen.
6. **T6: final verification** — regenerate `native/index.d.ts`, run the flag-on e2es as the default path, confirm the narrowed surface.

---

## Task 1: MCP `ListTools` merge flip + extract testable merge + re-target bijection gate

**Files:**
- Modify: `apps/desktop/src/main/mcp/server.ts:86-89` (the `ListToolsRequestSchema` handler)
- Create: `apps/desktop/src/main/mcp/mcpCatalog.ts` (the pure `mergeMcpCatalog` fn)
- Modify: `apps/desktop/src/main/mcp/mcpRouter.test.ts` (re-target the bijection gate at the merged catalog)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (enrich the bare complex-field schemas — Step 7)
- Test: `apps/desktop/src/main/mcp/mcpCatalog.test.ts` (new)

**Carry-item (ledger T6-M2):** when ListTools flips to advertise the TS table's `inputSchema`, the complex-field property schemas currently advertised as bare `{}` in the TS table — `role` (`set_role_gain`/`set_role_flags`), `color` (`add_color_layer`), `patch` (`update_layer`/`update_layer_params`) — would regress vs the richer Rust-derived schemas. Runtime validation is unaffected (parseArgs still enforces), but this is the **last task that can copy the Rust shapes** (T3 deletes the Rust catalog). Step 7 enriches them. (The 5 whole-`{}` schemas — `undo`/`redo`/`fit_composition_to_layers`/`unlock_history`/`list_checkpoints` — are correctly no-arg; leave them.)

**Interfaces:**
- Consumes: `MCP_TOOL_DEFS` (`apps/desktop/src/main/state/mcp-commands.ts:247`, `ReadonlyArray<McpToolDef>` with `{name, description, inputSchema, exec, …}`); `routeMcpTool` (`apps/desktop/src/main/mcp/mutationTools.ts:24`, `(name) => 'ts'|'rust'|'blocked'|'hybrid'`); `MCP_TOOLS`/`HYBRID_TOOLS` (`mcp-commands.ts`/`mutationTools.ts`).
- Produces: `mergeMcpCatalog(rustTools: Array<{name:string}>, tsDefs: ReadonlyArray<{name:string;description:string;inputSchema:Record<string,unknown>}>) => Array<{name:string;description:string;inputSchema:Record<string,unknown>}>` — exact union, no dup, no dropped tool. Consumed by `server.ts` (T1) and re-targeted by the gate; the SAME function is the post-split merge in 4b (input swaps, logic constant).

- [ ] **Step 1: Write the failing merge unit test.** Create `apps/desktop/src/main/mcp/mcpCatalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeMcpCatalog } from './mcpCatalog.js'
import { MCP_TOOL_DEFS } from '../state/mcp-commands.js'
import { routeMcpTool } from './mutationTools.js'

describe('mergeMcpCatalog', () => {
  const tsDefs = MCP_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))

  it('is an exact union with no duplicate names (TS tools dropped from the Rust side)', () => {
    // Rust catalog still advertises EVERYTHING in 4a (mutations + native + hybrids).
    const rust = [
      { name: 'list_motifs' }, { name: 'ping' }, { name: 'import_media' }, // native + hybrid (kept)
      { name: 'add_track' }, { name: 'add_motif' },                        // TS-executed (dropped from rust side)
    ]
    const merged = mergeMcpCatalog(rust, tsDefs)
    const names = merged.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)            // no dup
    expect(names).toContain('list_motifs')                    // rust-native kept
    expect(names).toContain('import_media')                   // hybrid kept (route 'hybrid' !== 'ts')
    expect(names).toContain('add_track')                      // ts kept (from TS table)
    expect(names).toContain('add_motif')
  })

  it('every merged name resolves to exactly one engine (no advertised-but-unhandled)', () => {
    const rust = [{ name: 'list_motifs' }, { name: 'ping' }, { name: 'import_media' }, { name: 'add_track' }]
    const merged = mergeMcpCatalog(rust, tsDefs)
    for (const t of merged) expect(['ts', 'rust', 'hybrid', 'blocked']).toContain(routeMcpTool(t.name))
  })

  it('advertises the TS table inputSchema for ts-routed tools', () => {
    const rust = [{ name: 'add_track', description: 'RUST DESC', inputSchema: { type: 'object', properties: {} } }]
    const merged = mergeMcpCatalog(rust, tsDefs)
    const addTrack = merged.find((t) => t.name === 'add_track')!
    expect(addTrack.description).not.toBe('RUST DESC')        // TS table wins for ts tools
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/main/mcp/mcpCatalog.test.ts` → FAIL (`Cannot find module './mcpCatalog.js'`).

- [ ] **Step 3: Implement `mergeMcpCatalog`.** Create `apps/desktop/src/main/mcp/mcpCatalog.ts`:

```ts
// Merge the Rust-advertised MCP catalog with the TS single-source table into the
// catalog the MCP host advertises via ListTools. The TS-executed tools advertise
// from the TS table (schema + parser are two fields of one record — they cannot
// drift); they are dropped from the Rust side to avoid duplicates. Rust keeps
// native reads/compute + hybrids (their schema is Rust's). The result is an exact
// union by construction. This same function is the post-split merge in Phase 4b —
// only its `rustTools` input narrows (mutation catalog removed from Rust); the
// union property is constant.
import { routeMcpTool } from './mutationTools.js'

export interface CatalogTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

export function mergeMcpCatalog(
  rustTools: ReadonlyArray<{ name: string } & Partial<CatalogTool>>,
  tsDefs: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): CatalogTool[] {
  const rustKept = rustTools.filter((t) => routeMcpTool(t.name) !== 'ts')
  const tsTools = tsDefs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  return [...rustKept, ...tsTools]
}
```

- [ ] **Step 4: Run the test to verify it passes.** Run: `npx vitest run src/main/mcp/mcpCatalog.test.ts` → PASS.

- [ ] **Step 5: Wire `mergeMcpCatalog` into `server.ts` ListTools.** Replace `server.ts:86-89`:

```ts
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rust = (JSON.parse(await backend.mcpCatalog()) as { tools: Array<{ name: string }> }).tools
    return { tools: mergeMcpCatalog(rust, MCP_TOOL_DEFS) } as unknown as ServerResult
  })
```

Add the imports near the top of `server.ts` (after line 14):

```ts
import { mergeMcpCatalog } from './mcpCatalog.js'
import { MCP_TOOL_DEFS } from '../state/mcp-commands.js'
```

- [ ] **Step 6: Re-target the bijection gate.** In `apps/desktop/src/main/mcp/mcpRouter.test.ts`, add a block that proves the merged ListTools is a clean bijection (exact union + every name routes once + ts-routed ⊆ TS table + hybrid-routed ⊆ HYBRID_TOOLS). Append:

```ts
import { mergeMcpCatalog } from './mcpCatalog.js'
import { MCP_TOOL_DEFS, MCP_TOOLS } from '../state/mcp-commands.js'
import { HYBRID_TOOLS } from './mutationTools.js'

describe('merged ListTools is a clean catalog↔handler bijection', () => {
  // Simulate the Rust-advertised set: in 4a it still includes the TS-executed
  // names; in 4b it is the post-split native+hybrid set. Either way the merge
  // must be a duplicate-free union where every name routes to exactly one engine.
  const rust4a = [...MCP_TOOLS].map((n) => ({ name: n })).concat(
    [{ name: 'ping' }, { name: 'list_motifs' }, { name: 'get_motif_source' }, { name: 'preview_motif_draft' },
     { name: 'detect_silences' }, { name: 'transcribe_clip' }, { name: 'import_media' }, { name: 'apply_subtitles' },
     { name: 'install_motif' }, { name: 'acknowledge_motif_staleness' }, { name: 'synthesize_speech' }],
  )
  const tsDefs = MCP_TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }))
  const merged = mergeMcpCatalog(rust4a, tsDefs)

  it('no duplicate names', () => {
    const names = merged.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('no advertised-but-unhandled / handled-but-unadvertised', () => {
    const advertised = new Set(merged.map((t) => t.name))
    for (const n of MCP_TOOLS) expect(advertised.has(n)).toBe(true)   // every ts tool advertised
    for (const t of merged) {
      const r = routeMcpTool(t.name)
      if (r === 'ts') expect(MCP_TOOLS.has(t.name)).toBe(true)
      if (r === 'hybrid') expect(HYBRID_TOOLS.has(t.name)).toBe(true)
    }
  })
})
```

- [ ] **Step 7: Enrich the bare complex-field schemas (ledger T6-M2; last chance before T3).** Capture the Rust-advertised schemas while they still exist: `node -e "const {Backend}=require('./native'); const b=new Backend(); b.init().then(async()=>{const c=JSON.parse(await b.mcpCatalog()); for(const t of c.tools) if(['set_role_gain','set_role_flags','add_color_layer','update_layer','update_layer_params'].includes(t.name)) console.log(t.name, JSON.stringify(t.inputSchema));})"` (or read the Rust `tool_table!` arg types). In `apps/desktop/src/main/state/mcp-commands.ts`, replace the bare `role: {}` / `color: {}` / `patch: {}` property sub-schemas with the Rust shapes — e.g. `role: { type: 'string', enum: [<the AudioRole kebab values>] }`, `color: { type: 'object', properties: { r/g/b/a … }, … }`, `patch` with its documented structure. If the captured Rust sub-schema is ALSO bare `{}` (no richer source exists), leave the TS one as `{}` and note it in the commit body. Do NOT change `parseArgs`/`parseDedicated` — only the advertised `inputSchema`. The 5 no-arg whole-`{}` schemas stay.

- [ ] **Step 8: Run the gates.** Run: `npx vitest run src/main/mcp/` → all PASS.

- [ ] **Step 9: Full verification + commit.** Run: `npm run typecheck` (clean) and `npm test` (2085 passed, 0 skipped). Then:

```bash
git add apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/mcpCatalog.ts apps/desktop/src/main/mcp/mcpCatalog.test.ts apps/desktop/src/main/mcp/mcpRouter.test.ts apps/desktop/src/main/state/mcp-commands.ts
git commit   # subject: feat(state-migration): MCP ListTools merges TS single-source table + enrich schemas (Phase 4b T1 §4.2)
```

---

## Task 2: Remove the flag in TS, reorder bring-up so the mirror precedes the MCP host, delete dev shadow, add the startup-order e2e

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (~L211-359: bring-up order, flag removal, shadow removal)
- Modify: `apps/desktop/src/main/state/router.ts:28,60` (drop `BLOCKED_UNDER_FLAG` + its rejection branch)
- Delete: `apps/desktop/src/main/state/shadow.ts` and `apps/desktop/src/main/state/shadow.test.ts` (dev-only, tied to the removed `WEFTCUT_TS_ACTOR_SHADOW`)
- Modify: `apps/desktop/src/main/state/router.test.ts` (remove `BLOCKED_UNDER_FLAG` assertions if any reference the dropped export)
- Create: `apps/desktop/e2e/electron/ts-actor-bringup.spec.ts` (startup-order guard)

**Interfaces:**
- Consumes: `createTsActorHost` (`state/ts-actor-host.ts`), `startMcpHost` (`mcp/index.ts`), `routeChannel` (`state/router.ts`).
- Produces: a boot sequence where `tsHost.start()` (which calls `pushMirror` → `setProjectMirror`) completes **before** `startMcpHost(...)`; `tsHost` is always constructed (no flag).

- [ ] **Step 1: Reorder + unconditionally construct the TS host in `index.ts`.** Currently (`index.ts`): `startMcpHost` is at ~L212-214, then `const tsActorOn = …!== '0'` (~L221) gates the whole `tsHost` construction+start block (~L222-300), and the dev `WEFTCUT_TS_ACTOR_SHADOW` block is at ~L346-356. Restructure to:
  - Move the entire `tsHost` construction (the `createTsActorHost({...})` call and its `nodeFs`/`napiFacade…`/`computeFacade` locals + `initEval()`) to run **before** `startMcpHost`, and **unconditionally** (delete `const tsActorOn = …` and the `if (tsActorOn) {` wrapper — keep its body, de-indented).
  - Call `tsHost.start()` and `backend.setTsDerivativeAuthority(true)` immediately after construction (still before `startMcpHost`).
  - Then call `const mcpHost = await startMcpHost(backend, () => tsHost)` and `mcpHostRef = mcpHost`.
  - **Ordering rationale (spec §4.3/§4.6):** `tsHost.start()` pushes the initial mirror via `setProjectMirror`; the MCP host (and any compute read) must not run before that. `mcpNotify` inside `createTsActorHost` uses `mcpHostRef?.notifyChange` (optional) so it is a safe no-op during the initial pre-MCP push.
  - Delete the `WEFTCUT_TS_ACTOR_SHADOW` block (`if (process.env['WEFTCUT_TS_ACTOR_SHADOW'] === '1') { … }`) and the `tsActorHandles` import.
  - The `if (tsHost)` guard inside the `backend:invoke` handler (~L338-341) can stay as-is (tsHost is now always set) OR be simplified to drop the guard; keep it for minimal diff but the router is always consulted now.

  Confirm the final order is: `initEval()` → build facades → `tsHost = createTsActorHost(...)` → `tsHost.start()` → `backend.setTsDerivativeAuthority(true)` → `startMcpHost(...)` → `mcpHostRef = mcpHost`.

- [ ] **Step 2: Drop `BLOCKED_UNDER_FLAG` from the router.** In `apps/desktop/src/main/state/router.ts`: delete the `BLOCKED_UNDER_FLAG` export (line 28) and the `if (BLOCKED_UNDER_FLAG.has(channel)) return …` branch (line 60). Keep the `routeChannel` partition otherwise intact (the unclassified default at line 72 stays a loud `reject`). Update the file header comment that references "Consulted … ONLY when the flag is on" to "the TS actor is authoritative; this splits every renderer channel."

- [ ] **Step 3: Delete the dev shadow.** Delete `apps/desktop/src/main/state/shadow.ts` and `apps/desktop/src/main/state/shadow.test.ts`. Grep to confirm no surviving import: `git grep -n "from './shadow'" "from '../state/shadow'" "shadow.js" apps/desktop/src` → only the deleted files (and the now-removed index.ts import). If `router.test.ts` references `BLOCKED_UNDER_FLAG`, remove those assertions.

- [ ] **Step 4: Write the startup-order e2e (the §4.3/§4.6 guard).** Create `apps/desktop/e2e/electron/ts-actor-bringup.spec.ts`. It boots the app **with no flag** (the default path) and asserts that an early mirror-backed read returns real project data — proving the mirror was pushed before any compute path can run (the no-fallback risk):

```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'

// Phase 4b §4.3/§4.6 — after the actor is deleted, snapshot_for_read() has NO
// actor fallback. Bring-up MUST push the mirror before any compute/MCP read.
// This boots the DEFAULT path (no WEFTCUT_TS_ACTOR env) and confirms an early
// renderer summary reflects the project — i.e. the mirror was populated first.
test('bring-up: project summary is available immediately after boot (no flag)', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    // The renderer summary is served by the TS actor; a blank project still has
    // the two reserved tracks. If the mirror/actor were not ready, this is empty.
    const summary = await win.evaluate(async () => {
      // @ts-expect-error preload bridge
      return JSON.parse(await window.api.invoke('project_summary', {}))
    })
    expect(summary.tracks.length).toBeGreaterThanOrEqual(2)
  } finally {
    await app.close()
  }
}, 120_000)
```

  (Adjust the preload-bridge call shape to match the project's actual `window.api` surface — mirror an existing spec such as `ts-actor-flip.spec.ts`. The build step `VITE_WEFTCUT_E2E=1 npm run build` + `npm run napi:build` is the e2e precondition.)

- [ ] **Step 5: Verify.** Run: `npm run typecheck` (clean), `npm test` (2085 passed minus the deleted `shadow.test.ts` cases — note the new count and that 0 are skipped). Build + run the new e2e: `npm run napi:build && VITE_WEFTCUT_E2E=1 npm run build && npx playwright test e2e/electron/ts-actor-bringup.spec.ts` → PASS. Also re-run the existing flip e2es (`ts-actor-flip`, `mcp-flip`, `ts-actor-motif-flip`, `ts-actor-native-compute`) — they set `WEFTCUT_TS_ACTOR=1`, still harmless (the env is now ignored) → PASS.

- [ ] **Step 6: Commit.**

```bash
git add -A apps/desktop/src/main/index.ts apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts apps/desktop/e2e/electron/ts-actor-bringup.spec.ts
git rm apps/desktop/src/main/state/shadow.ts apps/desktop/src/main/state/shadow.test.ts
git commit   # subject: feat(state-migration): always construct TS host, push mirror before MCP host, drop flag/shadow (Phase 4b T2 §4.3/§4.4)
```

---

## Task 3: Rust MCP catalog split — shrink `tool_table!` to native, delete the mutation handlers + `keyframes.rs`

**Files:**
- Modify: `apps/desktop/native/src/mcp/catalog.rs` (the `tool_table!` invocation, ~L40-276 — remove the TS-executed entries)
- Modify: `apps/desktop/native/src/mcp/tools.rs` (delete the ~47 TS-executed handler fns; keep native reads/compute + hybrid-compute halves)
- Delete: `apps/desktop/native/src/mcp/keyframes.rs` + its `mod keyframes;` declaration (in `mcp/mod.rs`)
- Modify: `apps/desktop/native/src/mcp/mod.rs` (drop the `keyframes` module)

**KEEP in `tool_table!` / `tools.rs` (native — they do NOT touch the actor):** `ping`, `list_motifs`, `get_motif_source`, `preview_motif_draft`, `write_motif_draft`*, `delete_motif`*, `detect_silences`, `transcribe_clip`, `begin_agent_session` (metadata via the event sink, not `b.project()`), and the **hybrid-compute halves** `import_media`, `apply_subtitles`, `install_motif`, `acknowledge_motif_staleness`, `synthesize_speech` (their TS-write half runs via `runHybrid`; the Rust arm does compute only). `groups_list`/`groups_get`/`get_param_track`/`list_checkpoints` are **TS-served reads** (in `MCP_TOOLS`) → their Rust arms are **DELETE**.

> *Note on `write_motif_draft`/`delete_motif`: these are motif-authoring writes against the `UserMotifStore` (NOT the project actor) — they call the store, not `b.project()`. KEEP (the catalog/authoring Rust residue is a deferred follow-up per spec §9.8). Verify each: if it calls `b.project()`, it is a project mutation → DELETE; if it calls the motif store only → KEEP.

**DELETE from `tool_table!` / `tools.rs` (the ~47 TS-executed tools — all in `MCP_TOOLS`):** `add_track`, `remove_track`, `move_track`, `duplicate_layer`, `update_layer`, `update_layer_params`, `move_layer`, `trim_layer`, `delete_layer`, `add_color_layer`, `add_video_layer`, `split_layer`, `groups_create`, `groups_dissolve`, `groups_add_members`, `groups_remove_members`, `groups_rename`, `groups_list`, `groups_get`, `add_effect`, `update_effect`, `move_effect`, `remove_effect`, `set_composition`, `fit_composition_to_layers`, `add_marker`, `update_marker`, `remove_marker`, `remove_media`, `undo`, `redo`, `lock_history`, `unlock_history`, `checkpoint`, `list_checkpoints`, `restore_checkpoint`, `dry_run`, `set_role_gain`, `set_role_flags`, `get_param_track`, `set_keyframe`, `remove_keyframe`, `retime_keyframe`, `set_keyframe_easing`, `smooth_keyframes`, `clear_keyframes`, `set_param_track`, `add_motif`.

- [ ] **Step 1: Cross-check the delete/keep partition against the TS table.** The authoritative TS-executed set is `MCP_TOOLS` (the names in `MCP_TOOL_DEFS`, `mcp-commands.ts`). Any Rust `tool_table!` name where `routeMcpTool(name) === 'ts'` is DELETE; `'hybrid'` and native reads are KEEP. Produce the final delete list by intersecting the `tool_table!` names with `MCP_TOOLS` (47 names listed above).

- [ ] **Step 2: Remove the deleted tools' entries from `tool_table!`** in `catalog.rs` (each `"name" => (desc, ArgsTy, tools::handler)` line). This simultaneously removes the schema (from `tool_catalog()`) and the dispatch arm (from `dispatch_tool`) — the macro binds them together, so deletion stays a bijection.

- [ ] **Step 3: Delete the corresponding handler fns + arg structs in `tools.rs`** (the bodies that call `b.project()?`). Delete `mcp/keyframes.rs` entirely and its `mod keyframes;` in `mcp/mod.rs`; delete the keyframe-tool arms in `tools.rs` that delegated to `super::keyframes::*`.

- [ ] **Step 4: Build.** Run: `cargo build --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs` → SUCCESS. Fix any now-unused imports/structs the compiler flags (the actor still exists, so the kept native handlers compile). Run `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs mcp` → green (delete or adjust any unit test that asserted a deleted tool is dispatchable by Rust).

- [ ] **Step 5: napi:build + the MCP e2e.** Run: `npm run napi:build`, then `VITE_WEFTCUT_E2E=1 npm run build && npx playwright test e2e/electron/mcp-flip.spec.ts` → PASS (ListTools now shows the merged set: Rust-native catalog has shrunk to the native tools, the TS table supplies the 47; a TS tool executes against the actor; a native tool reads the mirror).

- [ ] **Step 6: Confirm the frozen corpus is untouched + commit.** Run: `npm test` (2085-baseline TS still green; the Rust deletion does not touch TS). `git diff --stat apps/desktop/fixtures/state-corpus/` → empty. Then:

```bash
git add -A apps/desktop/native/src/mcp/
git commit   # subject: refactor(state-migration): split MCP catalog — Rust advertises native/compute/hybrid only (Phase 4b T3 §4.2)
```

---

## Task 4: ⚠️ THE IRREVERSIBLE CORE — delete the Rust actor + every live consumer

> One coupled deletion. The Rust build will NOT be green until every sub-step is done. Work top-to-bottom, then build. The pre-flight tag (`state-corpus-frozen-pre-phase4b`) is the recovery point.

**Files (delete wholesale):**
- `apps/desktop/native/src/state/actor.rs`, `state/actor/mutations.rs`, `state/actor/tests.rs`, `state/history.rs`, `state/validate.rs`
- `apps/desktop/native/src/commands/mutations.rs`, `commands/history.rs`, `commands/query.rs`
- `apps/desktop/native/src/io/autosave.rs`

**Files (partial edits):**
- `apps/desktop/native/src/state/mod.rs` — drop `mod actor; mod history; mod validate;` (or the `actor` submodule wiring) + the `pub use actor::{ProjectHandle, ProjectActor, spawn, …}` / `pub use history::{…}` / `pub use validate::{…}` re-exports; KEEP all model `mod`/`pub use`.
- `apps/desktop/native/src/commands/mod.rs` — drop `pub mod mutations; pub mod history; pub mod query;` and the `build_project_summary` fn + `ProjectSummary` type (~L321-…); KEEP the other command modules.
- `apps/desktop/native/src/lib.rs:18-19` — drop `pub use commands::build_project_summary;`.
- `apps/desktop/native/src/napi_backend.rs` — see sub-steps (dispatch arms, `Backend` field, `init`, `snapshot_for_read`, debug arms, replay constructors).
- `apps/desktop/native/src/jobs/mod.rs` — `commit_media_derivatives`/`commit_media_workspace_paths` signature change + `TS_DERIVATIVE_AUTHORITY` removal + callers.
- `apps/desktop/src/main/index.ts` — drop `backend.setTsDerivativeAuthority(true)` (the Rust method is being removed).
- `apps/desktop/native/index.d.ts` — drop `setTsDerivativeAuthority` (regenerated in T6, but remove the call site now).

- [ ] **Step 1: Delete the actor core files** (`state/actor.rs`, `state/actor/mutations.rs`, `state/actor/tests.rs`, `state/history.rs`, `state/validate.rs`) and fix `state/mod.rs` (drop the modules + their re-exports; keep the model). The 5,429-line `actor/tests.rs` goes with it (its coverage is replaced by the TS suite + frozen differential gates).

- [ ] **Step 2: Delete the renderer dispatch fallback.** Delete `commands/mutations.rs`, `commands/history.rs`, `commands/query.rs`; update `commands/mod.rs` (drop the modules + `build_project_summary`/`ProjectSummary`); drop `lib.rs:18-19`. In `napi_backend.rs` `dispatch()` (the big `match` ~L680+): delete every arm that called `commands::mutations::*`, `commands::history::*`, or `commands::query::project_summary` — plus the `debug_lock_history`/`debug_unlock_history`/`debug_simulate_agent_session` arms. **KEEP** the arms for channels the router still sends to `'rust'`: the `PURE_NATIVE ∪ PERSISTENCE ∪ MIRROR_BACKED_READS` sets in `router.ts:40-52` (e.g. `ping`, `mux_export`, settings/recents/keybindings/log stores, `export_project_audio_only`, `ensure_conform`, `get_media_thumbnail`, `get_waveform_peaks`, `motif_staleness_report`, motif authoring) + the hybrid-compute channels. Cross-check the kept arms against that allowlist.

- [ ] **Step 3: Remove the `DEBUG_ONLY` routing (TS).** In `apps/desktop/src/main/state/router.ts`: delete the `DEBUG_ONLY` set (line 55) and drop it from the `'rust'` fall-through condition (line 70). Update `router.test.ts` to remove `DEBUG_ONLY`/`debug_*` assertions. (The Rust debug handlers were deleted in Step 2; they have no e2e dependency — verified by grep, only `router.*`/`napi_backend.rs`/`commands/history.rs` referenced them.)

- [ ] **Step 4: Delete autosave + the actor spawn in `Backend`.** Delete `io/autosave.rs` + its `mod autosave;`. In `napi_backend.rs` `init()`: delete the `state::spawn(...)` (~L147), the `handle.subscribe()` UI-event bridge (~L158), and `AutosaveController::spawn(handle, …)` (~L216). Delete the `Backend.project` field (the `OnceCell<ProjectHandle>` / actor handle) and the `pub fn project(&self) -> Result<&ProjectHandle, …>` method. Fix the two remaining `project()` callers found in the census — `enqueue_jobs_for_media` (~L330) and `commit_workspace` (~L462): these are jobs/workspace bookkeeping that no longer need the actor handle (the TS host drives state); remove the handle access (they should operate without the actor — confirm each compiles against the mirror or drops the unused read).

- [ ] **Step 5: Make `snapshot_for_read` mirror-only.** In `napi_backend.rs` (~L619-624): remove the actor fallback (`self.project()?.snapshot().await`). Return the mirror's `Arc<Project>` snapshot; if the mirror is unset, return a clear error (bring-up guarantees it is pushed first — T2). Same for `mirror_history_view` if it had a fallback. KEEP `read_mirror`, `set_project_mirror`, `read_mirror_handle`.

- [ ] **Step 6: Simplify the jobs write-back + remove the authority flag.** In `jobs/mod.rs`:
  - Delete `TS_DERIVATIVE_AUTHORITY` (L58), `set_ts_derivative_authority` (L61-63), `ts_derivative_authority` (L65-67), and `actor_for_jobs()` (now dead — only the deleted `else` arms used it).
  - Rewrite `commit_media_derivatives` to drop the `project: &ProjectHandle` param and the `if/else` — always emit:

```rust
pub(crate) async fn commit_media_derivatives(
    events: &Arc<dyn EventSink>,
    media_id: MediaId,
    patch: MediaDerivativesPatch,
) -> Result<(), CommandError> {
    events.emit(
        "media:derivatives",
        serde_json::json!({ "media_id": media_id.to_string(), "patch": patch }),
    );
    Ok(())
}
```

  - Rewrite `commit_media_workspace_paths` the same way (drop `project: &ProjectHandle`, keep the emit arm, delete the `else`).
  - Update **every caller** of these two fns to drop the `ProjectHandle` argument (the census flagged the napi open-time derivative fan-out + the proxy/conform/quick_proxy/waveform/thumbnail/import job sites). The compiler will list them; remove the now-unused `ProjectHandle` plumbing threaded through those job signatures.
  - Delete the test-only `set_ts_derivative_authority(false/true)` setups in the `jobs` tests (~L840/848/982) and any test that depended on the Rust-write arm.

- [ ] **Step 7: Remove the napi `setTsDerivativeAuthority` method + its call site + replay constructors.** In `napi_backend.rs`: delete the `#[napi] pub fn set_ts_derivative_authority` method and the `#[cfg(feature="replay")]` `new_for_replay`/`init_for_replay` (~L665-679). In `apps/desktop/src/main/index.ts`: delete the `backend.setTsDerivativeAuthority(true)` call (added unconditionally in T2). In `native/index.d.ts`: delete the `setTsDerivativeAuthority(on: boolean): void` line (T6 regenerates the file; remove now so typecheck passes).

- [ ] **Step 8: Build the Rust side green.** Run: `npm run napi:build` and `cargo build --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs`. Iterate on the compiler's dangling-reference list until both succeed with **no `state::actor`/`ProjectHandle`/`history`/`validate` references remaining**. Run `cargo test --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs` → green (delete any surviving Rust test that drove the actor; the `napi_backend.rs` `project_summary_*` / actor tests at ~L1039+ go with the actor).

- [ ] **Step 9: Typecheck + full TS suite + frozen-corpus integrity.** Run: `npm run typecheck` (clean — the `index.d.ts` edit removed `setTsDerivativeAuthority`), `npm test` (TS baseline still green; the six differential gates still `skipped===[]` — they replay through the TS actor, unaffected by the Rust deletion). `git diff --stat apps/desktop/fixtures/state-corpus/` → empty.

- [ ] **Step 10: Commit (the point of no return).**

```bash
git add -A apps/desktop/native/ apps/desktop/src/main/index.ts apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts
git status   # confirm the deleted files (actor.rs, mutations.rs, history.rs, validate.rs, autosave.rs, commands/{mutations,history,query}.rs) show as deletions
git commit   # subject: feat(state-migration)!: delete the Rust state actor + all live consumers; mirror-only reads (Phase 4b T4 §4.1)
```

---

## Task 5: Retire the differential harness + mark the corpus frozen

**Files:**
- Modify: `apps/desktop/native/Cargo.toml` (delete the `replay` feature + the three `[[bin]]` entries)
- Delete: `apps/desktop/native/src/bin/replay_driver.rs`, `prod_driver.rs`, `mcp_driver.rs`
- Modify: `apps/desktop/native/src/lib.rs` (delete the `#[cfg(feature="replay")]` re-exports)
- Modify: `apps/desktop/native/src/events.rs` (delete `#[cfg(feature="replay")] NullEventSink`)
- Modify: `apps/desktop/native/src/mcp/mod.rs` (delete `#[cfg(feature="replay")] pub use wire::reply;`)
- Delete: `apps/desktop/scripts/gen-state-oracle.mjs`
- Modify: `apps/desktop/fixtures/state-corpus/README.md` (regen section → frozen note)

- [ ] **Step 1: Delete the driver bins + the Cargo feature.** Delete the three `src/bin/*_driver.rs` files. In `native/Cargo.toml` delete the `replay = []` (or `replay = [...]`) feature line and the three `[[bin]]` blocks (`replay_driver`/`prod_driver`/`mcp_driver`). Delete `scripts/gen-state-oracle.mjs`.

- [ ] **Step 2: Delete the feature-gated re-exports + helpers.** In `native/src/lib.rs` delete the `#[cfg(feature="replay")] pub use events::NullEventSink;`, `#[cfg(feature="replay")] pub use napi_backend::Backend;`, and `#[cfg(all(feature="replay", feature="mcp"))] pub use mcp::{dispatch_tool, reply};` lines. In `events.rs` delete the `#[cfg(feature="replay")] pub struct NullEventSink` + impl. In `mcp/mod.rs` delete `#[cfg(feature="replay")] pub use wire::reply;`. Grep for any other `#[cfg(feature = "replay")]` / `cfg(feature="replay")` across `native/src` and remove each.

- [ ] **Step 3: Rewrite the corpus README regen section.** In `apps/desktop/fixtures/state-corpus/README.md`, replace the "Generating / regenerating oracles" section with:

```markdown
## Oracles are FROZEN (Phase 4b)

The oracles in `oracle*/` were generated by the differential-harness drivers
(`replay_driver`, `prod_driver`, `mcp_driver`, Cargo feature `replay`) running the
**live Rust state actor** under deterministic ids, then committed. Phase 4b deleted
the Rust actor and those drivers, so the oracles can no longer be regenerated against
Rust — they are **frozen TS-only regression fixtures**. The `*.differential.test.ts`
gates still replay these sequences through the **TS** actor and assert byte-identity,
which catches TS regressions; only the cross-language regeneration path is gone.

To regenerate (e.g. to extend the corpus before a future change), check out the tag
`state-corpus-frozen-pre-phase4b`, run the drivers there, then port the result —
the live Rust≡TS oracle cannot be minted on `main` after Phase 4b.
```

- [ ] **Step 4: Build + verify the frozen gates still pass.** Run: `cargo build --manifest-path apps/desktop/native/Cargo.toml --features jobs,export,mcp,cloud,motifs` (no `replay` feature exists now — confirm no `--features replay` is needed anywhere) and `npm run napi:build` → SUCCESS. Run `npm test` → the six `*.differential.test.ts` gates still green, `skipped===[]`, full suite green. `git diff --stat apps/desktop/fixtures/state-corpus/{oracle,oracle-mcp,oracle-prod,oracle-summary,sequences,sequences-mcp,sequences-prod}` → empty (only `README.md` changed).

- [ ] **Step 5: Commit.**

```bash
git add -A apps/desktop/native/ apps/desktop/fixtures/state-corpus/README.md
git rm apps/desktop/scripts/gen-state-oracle.mjs apps/desktop/native/src/bin/replay_driver.rs apps/desktop/native/src/bin/prod_driver.rs apps/desktop/native/src/bin/mcp_driver.rs
git commit   # subject: chore(state-migration): retire differential harness; corpus oracles frozen (Phase 4b T5 §4.5)
```

---

## Task 6: Final verification — regenerate `index.d.ts`, run the flag-on e2es as the default path, confirm the narrowed surface

**Files:**
- Modify (regenerated): `apps/desktop/native/index.d.ts`

- [ ] **Step 1: Regenerate the napi type surface.** Run `npm run napi:build` (this regenerates `native/index.d.ts` from the `#[napi]` annotations). Confirm the diff drops `setTsDerivativeAuthority` and any other removed methods, and that the surface is the narrowed media/export/cloud/motif/eval + read-mirror (`setProjectMirror`/`snapshotForRead`/`mirrorHistoryView`) + compute-only MCP (`mcpCatalog`/`mcpCallTool`/`mcpReadResource`/…) set — no actor/mutation/history methods. `npm run typecheck` → clean against the regenerated file.

- [ ] **Step 2: Run the full e2e flag-on set as the DEFAULT path.** Build once: `npm run napi:build && VITE_WEFTCUT_E2E=1 npm run build`. Then run the four flip e2es + the bring-up e2e:

```
npx playwright test e2e/electron/ts-actor-flip.spec.ts e2e/electron/mcp-flip.spec.ts e2e/electron/ts-actor-motif-flip.spec.ts e2e/electron/ts-actor-native-compute.spec.ts e2e/electron/ts-actor-bringup.spec.ts
```

  All PASS. (They set `WEFTCUT_TS_ACTOR=1`, now ignored; the app is TS-authoritative regardless. Optionally drop the now-dead env from these specs in this task — a cosmetic cleanup; not required.)

- [ ] **Step 3: Sanity-run a representative native/motif e2e** to confirm the narrowed Rust surface still serves compute/reads off the mirror: `npx playwright test e2e/electron/mcp-motif.spec.ts e2e/electron/motif-export.spec.ts` → PASS (or document any that are local-only/flaky per [[project_media_conformance_harness]]).

- [ ] **Step 4: Full final gate.** Run from `apps/desktop`: `npm run typecheck` (clean), `npm test` (full suite green, `skipped===[]`), `cargo build --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs` + `npm run napi:build` (both succeed with NO `state` actor module). Confirm `git grep -n "ProjectHandle\|state::spawn\|mod actor\|WEFTCUT_TS_ACTOR" apps/desktop/native/src apps/desktop/src` returns nothing live (only comments/history references, if any).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/native/index.d.ts apps/desktop/e2e/
git commit   # subject: chore(state-migration): regenerate narrowed napi index.d.ts; flag-on e2es pass as default (Phase 4b T6 §4.7)
```

- [ ] **Step 6 (controller): 3-OS CI.** 4b's exit criteria (§4.7) include 3-OS CI green. CI runs on push; per the migration's no-push convention this is the user's call. Surface that the local gates are green and CI is the remaining cross-OS confirmation (it is the hard gate for "a dangling actor consumer left after delete").

---

## Self-Review (against spec `specs/2026-06-25-state-actor-phase-4-design.md` §4)

**Spec coverage:**
- §4.1 `ProjectHandle` census (DELETE / KEEP-REPOINT / KEEP) → Task 4 (actor core, dispatch fallback, autosave, jobs, `snapshot_for_read` mirror-only, `state/mod.rs`); `fresh_media_item` already re-pointed in 4a-ii (verified — no 4b work); `project_summary` resolved as DELETE (dead-under-flag, confirmed) → Task 4 Step 2.
- §4.2 MCP catalog split → Task 1 (ListTools merge, TS side) + Task 3 (Rust shrink). The §2.7 single-source table + bijection gate already exist (4a); Task 1 only flips ListTools to the merge and re-targets the gate. ✓
- §4.3 startup-order constraint + test → Task 2 (reorder: `tsHost.start()`/mirror before `startMcpHost`) + the `ts-actor-bringup` e2e. ✓
- §4.4 flag plumbing removal → Task 2 (index.ts/router.ts/shadow) + Task 4 (jobs `TS_DERIVATIVE_AUTHORITY` + napi `setTsDerivativeAuthority`). ✓
- §4.5 harness retirement (4 preconditions) → pre-flight tag (Step 0.2) + Task 5 (feature/bins/re-exports/gen-script delete; keep oracles+gates; README frozen note). ✓
- §4.6 no-fallback bring-up risk → Task 4 Step 5 (`snapshot_for_read` mirror-only) guarded by the Task 2 reorder + e2e. ✓
- §4.7 exit criteria → Task 6 (cargo+napi build with no actor; frozen gates green; flag-on e2es as default; narrowed `index.d.ts`; 3-OS CI = controller). ✓
- §5 final Rust boundary → achieved by Tasks 3–5 (compute-only MCP, read-mirror, model serde, motif `motif://` byte-server kept; catalog logic already shared-TS per 4a-ii). ✓

**Risk register (spec §6) addressed:** dangling consumer → Task 4 census + cargo/napi/CI hard gates; catalog drop/dup/drift → Task 1 bijection gate + `mcp-flip` e2e; compute-read-before-mirror → Task 2 reorder + bring-up e2e + Task 4 mirror-only; corpus frozen too early → Step 0.1 confirms `skipped===[]` before the Step 0.2 tag; LogBus parity → handled in 4a (restore log emit landed); motif cap drift → N/A (4a-ii shared-TS catalog, twin deleted with the actor).

**Placeholder scan:** new code (mergeMcpCatalog, ListTools handler, jobs `commit_media_*`, bring-up e2e, README) is complete; deletions are specified by file + symbol + line-anchor (lines drift from `f2660636`; the implementer confirms each with `cargo build`'s dangling-reference list — that is the deletion's "test").

**Type consistency:** `mergeMcpCatalog` signature is identical in Task 1 (definition) and the gate; `routeMcpTool`/`MCP_TOOLS`/`HYBRID_TOOLS`/`MCP_TOOL_DEFS` names match their current exports; `commit_media_derivatives`/`commit_media_workspace_paths` drop `project: &ProjectHandle` consistently in def + callers.

**Open item carried to execution (non-blocking):** Task 3 Step 1 — verify `write_motif_draft`/`delete_motif` call the motif store (KEEP) vs `b.project()` (DELETE) before finalizing the Rust delete list; Task 4 Step 4 — the exact post-actor shape of `enqueue_jobs_for_media`/`commit_workspace` (drop the unused handle read). Both resolve mechanically against the compiler.
