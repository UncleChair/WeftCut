# Phase 4a-i — TS command/MCP surface (single-source table + parser hardening + restore_checkpoint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the regen-free, pure-TS half of Phase 4a — collapse the five hand-aligned MCP tool tables into one single-source record per tool (so an advertised schema can't drift from its validator), extend parser-discipline to every pre-commit arg adapter, harden the change-broadcast against a throwing subscriber, and un-block `project_restore_checkpoint` — all without regenerating the differential oracle corpus.

**Architecture:** Slice 4a-i is the pure-TS surface of the spec's slice 4a (`specs/2026-06-25-state-actor-phase-4-design.md` §2.1/§2.5/§2.6/§2.7). Every change here is behavior-preserving (table projections), reject-only (typed parsers rejecting malformed input that previously `as`-cast to `NaN`/garbage), broadcast-resilience, or a thin command alias reusing already-gated actor code. Because the success-only differential corpus exercises only well-formed inputs, the existing `*.differential.test.ts` gates stay byte-identical **without** touching the Rust replay drivers — the corpus regeneration is deferred entirely to slice 4a-ii. The single-source MCP table is built **dormant**: `ListTools` still sources from Rust (`server.ts` → `backend.mcpCatalog()`) this slice; 4b only flips `ListTools` to the merge and deletes the Rust mutation catalog.

**Tech Stack:** TypeScript (Electron main, `apps/desktop/src/main/state/` + `apps/desktop/src/main/mcp/`), Vitest, esbuild (note: vitest does NOT typecheck — `tsc -b` is a separate gate), Immer (mutations run in `produce`). No Rust changes in this slice.

## Global Constraints

Copied from the spec; every task's requirements implicitly include these.

- **No oracle regeneration this slice.** `apps/desktop/fixtures/state-corpus/oracle*/` and `sequences*/` MUST stay byte-identical: `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` is empty at every commit. The differential gates (`differential.phase2`, `summary.differential`, `persistence.differential`, `commands.differential`, `mcp.differential`) stay green by being unchanged, not regenerated.
- **Determinism / id-allocation contract is sacred.** Any code that mints ids via the injected `idGen` must preserve allocation order. No new `idGen()` calls on a path the corpus exercises (this slice adds none — `restore_checkpoint`'s id behavior is already gated by 3d-c's `begin→restore` corpus).
- **Reject before commit.** A malformed wire arg (non-uuid / non-finite-number / wrong-typed) must reject as `McpArgError` (→ `-32602`/`invalid_params`) or a `CommandError` BEFORE any `commit`/mutation. Never `as`-cast unknown wire input straight into the actor.
- **Behavior-preserving refactor.** Collapsing `MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS`/`MCP_TOOLS` into projections of one table must not change any tool's runtime behavior on valid input — proven by the unchanged `mcp.differential` gate.
- **`tsc -b` is a required gate** after any shared-interface change (the recurring lesson: vitest runs esbuild and does NOT typecheck).
- **TimeUs is `number`** (proven safe); preference-shaped patches are unrecorded; the wasm eval leaf (`snap.ts`) is never reimplemented.
- **Frozen-corpus prep:** nothing here deletes drivers or the `replay` feature — that is 4b. This slice must leave the harness fully intact.

---

## File Structure

| File | Responsibility | This slice |
|---|---|---|
| `apps/desktop/src/main/state/actor.ts` | The actor: `emit` broadcast (§2.6), `dispatch()` arms + `restore_checkpoint` arm (§2.1), `mcpCall` dedicated arms consuming typed args (§2.7/§2.5), `specToDryRunOp` hardening (§2.5) | Modify |
| `apps/desktop/src/main/state/mcp-commands.ts` | The single-source `MCP_TOOL_DEFS` table + `parseArgs`/`shapeResult`/`inputSchema` per tool; `MCP_TOOLS`/`MCP_ARG_PARSERS`/`MCP_RESULT_SHAPERS` become projections; typed parsers (§2.7/§2.5) | Modify (major) |
| `apps/desktop/src/main/state/commands.ts` | Renderer command adapter: `prodColorParams`/`prodTextParams`/`prodMediaLayer` hardening + `project_restore_checkpoint` MECHANICAL alias + `PRODUCTION_OPS` (§2.5/§2.1) | Modify |
| `apps/desktop/src/main/state/router.ts` | Drop `project_restore_checkpoint` from `BLOCKED_UNDER_FLAG` (§2.1) | Modify |
| `apps/desktop/src/main/mcp/mutationTools.ts` | Drop `project_restore_checkpoint` from `MCP_BLOCKED_UNDER_FLAG`; `routeMcpTool` reads `MCP_TOOLS` projection (§2.1/§2.7) | Modify |
| `apps/desktop/src/main/state/ts-actor-host.ts` | `emitLog` host dep + Restore/Checkpoint LogBus parity on the restore/checkpoint paths (§2.1 log) | Modify |
| `apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts` | The permanent structural gate: name partition + handler presence + schema↔validator consistency + loose faithfulness vs Rust catalog snapshot (§2.7) | Create |
| `apps/desktop/src/main/state/__tests__/mcp.tool-table.test.ts` | Projections equal the prior tables; parseArgs typed-rejection unit tests (§2.7/§2.5) | Create |
| `apps/desktop/fixtures/mcp/rust-catalog-snapshot.json` | Committed snapshot of `backend.mcpCatalog()` for the loose faithfulness check (§2.7) | Create |

---

## Task 1: Harden the change broadcast against a throwing subscriber (§2.6)

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts:113` (`emit`)
- Test: `apps/desktop/src/main/state/__tests__/actor.subscribers.test.ts` (Create)

**Interfaces:**
- Consumes: `createActor` (existing), `ActorHandle.subscribe` (existing).
- Produces: no signature change — `emit` stays `(e: ChangeEvent) => void`; only its fault-isolation behavior changes.

Today `function emit(e) { for (const cb of subs) cb(e) }` (actor.ts:113) runs subscribers synchronously; the live finding (soak note) is that `pushMirror` throwing a Rust-deserialize error aborts the loop, starving `autosave`/`mcpNotify`. Isolate each callback.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/main/state/__tests__/actor.subscribers.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

describe('actor change broadcast fault isolation', () => {
  it('a throwing subscriber does not starve later subscribers', () => {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const thrower = vi.fn(() => { throw new Error('subscriber boom') })
    const after = vi.fn()
    actor.subscribe(thrower)
    actor.subscribe(after)
    // Any recorded mutation broadcasts a ChangeEvent.
    actor.dispatch('add_track', { label: 'X' })
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1) // would be 0 before the fix
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/actor.subscribers.test.ts`
Expected: FAIL — `after` called 0 times (the thrower aborts the loop).

- [ ] **Step 3: Implement per-subscriber isolation**

```typescript
// actor.ts — replace the one-line emit (was: for (const cb of subs) cb(e))
function emit(e: ChangeEvent): void {
  for (const cb of subs) {
    try { cb(e) }
    catch (err) {
      // A throwing subscriber (e.g. pushMirror on a transient Rust-deserialize
      // error) must not starve later subscribers (autosave / mcpNotify). Warn
      // and continue — cf. feedback_ui_actor_bridge, feedback_async_block_on_in_async.
      console.warn('[actor] change subscriber threw; continuing', err)
    }
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/actor.subscribers.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no differential regression + typecheck**

Run: `cd apps/desktop && npx vitest run src/main/state && npx tsc -b`
Expected: full state suite green (`skipped===[]` on every differential gate), `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/__tests__/actor.subscribers.test.ts
git commit -m "fix(state-migration): isolate change-broadcast subscribers (Phase 4a-i §2.6)"
```

---

## Task 2: Wire `project_restore_checkpoint` onto the renderer command surface + un-block (§2.1, routing)

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (add a `restore_checkpoint` arm to `dispatch()`, ≈ after the `redo` arm at :400)
- Modify: `apps/desktop/src/main/state/commands.ts` (`MECHANICAL` + `PRODUCTION_OPS`)
- Modify: `apps/desktop/src/main/state/router.ts:28` (`BLOCKED_UNDER_FLAG`)
- Modify: `apps/desktop/src/main/mcp/mutationTools.ts:12` (`MCP_BLOCKED_UNDER_FLAG`)
- Test: `apps/desktop/src/main/state/__tests__/restore-checkpoint-wiring.test.ts` (Create)
- Test: `apps/desktop/src/main/state/router.test.ts` (Modify — move the channel from blocked to command)

**Interfaces:**
- Consumes: `restoreCheckpoint(id: Uuid): void` (actor.ts:210, existing), `parseUuid` (mcp-commands.ts, existing), `parseMechanical`/`PRODUCTION_OPS` (commands.ts), `routeChannel` (router.ts), `routeMcpTool` (mutationTools.ts).
- Produces: renderer channel `project_restore_checkpoint` routes `{kind:'command'}` → `actor.command` → `dispatch('restore_checkpoint', {checkpoint_id})` → `restoreCheckpoint`. MCP `restore_checkpoint` routes `'ts'` (already in `MCP_TOOLS`).

Note: `restore_checkpoint` has NO `dispatch()` arm today (only the dedicated `mcpCall` arm calls `restoreCheckpoint` directly). The renderer `command()` path reaches the actor only through `parseMechanical` → `dispatch()`, so a `dispatch` arm is required.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/desktop/src/main/state/__tests__/restore-checkpoint-wiring.test.ts
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { routeChannel } from '../router'
import { routeMcpTool } from '../../mcp/mutationTools'

describe('project_restore_checkpoint wiring', () => {
  it('renderer channel routes to command and MCP routes to ts', () => {
    expect(routeChannel('project_restore_checkpoint')).toEqual({ kind: 'command' })
    expect(routeMcpTool('restore_checkpoint')).toBe('ts')
  })

  it('command(project_restore_checkpoint) restores a checkpoint by id', () => {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    // create a checkpoint via the gated MCP path, capture its id
    const made = actor.mcpCall('checkpoint', JSON.stringify({ label: 'cp1' }))
    expect(made.ok).toBe(true)
    const cpId = (made as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text
    // mutate so state diverges from the checkpoint
    actor.command('add_track', { })
    const before = actor.snapshot().tracks.length
    // restore via the renderer command channel
    const r = actor.command('project_restore_checkpoint', { checkpointId: cpId })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().tracks.length).toBe(before - 1)
  })

  it('command(project_restore_checkpoint) with a bad uuid rejects before mutating', () => {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const r = actor.command('project_restore_checkpoint', { checkpointId: 'not-a-uuid' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/restore-checkpoint-wiring.test.ts`
Expected: FAIL — `routeChannel` returns `{kind:'reject'}` (still blocked); `command` returns `unsupported op restore_checkpoint`.

- [ ] **Step 3: Add the `dispatch()` arm (with uuid hardening)**

```typescript
// actor.ts — inside dispatch(), add after the 'redo' case (≈ :400)
case 'restore_checkpoint': restoreCheckpoint(parseUuid(a.checkpoint_id, 'checkpoint_id')); return { ok: true, value: null }
```

(`parseUuid` is already imported into actor.ts — it is used by the existing `mcpCall` arms. `restoreCheckpoint` throws `CommandFailure(HistoryLocked|CheckpointNotFound)`, caught by the existing `dispatch` try/catch → `{ok:false,error}`; `parseUuid` throws `McpArgError` — see Step 3b.)

- [ ] **Step 3b: Ensure `dispatch()` maps `McpArgError` to a CommandError**

`dispatch()`'s catch only handles `CommandFailure`. `parseUuid` throws `McpArgError`. Add a mapping so a bad uuid becomes `InvalidArgument`, not an uncaught throw:

```typescript
// actor.ts — in dispatch()'s catch block, before `throw e`
} catch (e) {
  if (e instanceof CommandFailure) return { ok: false, error: e.err }
  if (e instanceof McpArgError) return { ok: false, error: { error: 'InvalidArgument', field: 'checkpoint_id', detail: e.mcpMessage } }
  throw e
}
```

(`McpArgError` import: add `McpArgError` to the existing `./mcp-commands` import in actor.ts if not already present — it is imported there for `specToDryRunOp`.)

- [ ] **Step 4: Add the MECHANICAL alias + PRODUCTION_OPS entry**

```typescript
// commands.ts — in the MECHANICAL map, add:
project_restore_checkpoint: (a) => ({ op: 'restore_checkpoint', args: { checkpoint_id: a.checkpointId } }),
```
```typescript
// commands.ts — add to the PRODUCTION_OPS Set literal:
'project_restore_checkpoint',
```

- [ ] **Step 5: Un-block in both routers**

```typescript
// router.ts:28 — drop the renderer channel (leaving only add_motif)
export const BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set(['add_motif'])
```
```typescript
// mutationTools.ts:12 — drop project_restore_checkpoint (already in MCP_TOOLS → routes 'ts')
export const MCP_BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set(['add_motif'])
```

Update the doc comments above each set to say only `add_motif` remains (Phase 4b deferred — hybrid catalog).

- [ ] **Step 6: Update router.test.ts**

In `router.test.ts`, move `project_restore_checkpoint` from the expected-blocked list to the expected-command list (search for the `BLOCKED_UNDER_FLAG`/partition assertions and the `ALL_CHANNELS` coverage). Mirror in any `mutationTools` test asserting the blocked set.

- [ ] **Step 7: Run tests + typecheck**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/restore-checkpoint-wiring.test.ts src/main/state/router.test.ts && npx tsc -b`
Expected: PASS; `tsc` clean. Then `npx vitest run src/main/state` — full suite green, `skipped===[]`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/commands.ts apps/desktop/src/main/state/router.ts apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/state/__tests__/restore-checkpoint-wiring.test.ts apps/desktop/src/main/state/router.test.ts
git commit -m "feat(state-migration): wire+un-block project_restore_checkpoint on the TS actor (Phase 4a-i §2.1)"
```

---

## Task 3: Restore LogBus record-panel parity for restore/checkpoint (§2.1, log)

**Files:**
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (add `emitLog` dep + emit on restore + checkpoint/begin paths)
- Modify: `apps/desktop/src/main/index.ts` (provide the `emitLog` dep — backed by the existing `log_emit` backend surface)
- Test: `apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts` (Create)

**Interfaces:**
- Consumes: the existing `log_emit` backend channel (router.ts PERSISTENCE set — Rust LogBus). Its input shape mirrors `LogEntryInput` (history.rs:51-65): `{ level, category, source, message, details }`.
- Produces: `TsActorHostDeps.emitLog?: (entry: { level: string; category: string; source: { kind: 'User' } | { kind: 'Agent'; client: string }; message: string; details: Record<string, unknown> }) => void`.

Rust's renderer/MCP restore emits a `Restore` LogEntry (history.rs:51-65) — the record panel's pin-row signal. Under the flag the TS path skips it (the 3d-d LogBus-under-flip gap). Restore parity for the **restore** path (the new port) + the **checkpoint** path (mirrors `debug_simulate_agent_session`'s `Checkpoint` entry, history.rs:102-113). Logs are not state and not differential-gated → unit + e2e verified.

> **Sub-decision pinned here:** scope = `restore_checkpoint` (Restore entry) + `checkpoint`/`begin_agent_session` (Checkpoint entry). `lock_history`/`unlock_history` emit no Rust LogBus pin-row (confirm by grepping `log_slot.emit` in `commands/prefs.rs`/`actor.rs`; if they do, add them — else document the exclusion). The emit is best-effort: a throwing `emitLog` must not abort the mutation (Task 1's isolation covers the broadcast; wrap the explicit emit in try/catch too).

- [ ] **Step 1: Confirm the `log_emit` backend signature**

Run: `cd apps/desktop && rg -n "log_emit|fn .*log.*emit|logEmit" native/src/napi_backend.rs native/src/logs.rs`
Read the napi method (e.g. `backend.logEmit(entryJson)` or the `log_emit` invoke arm) and the `LogEntryInput` serde field names + `LogLevel`/`LogCategory`/`LogSource` wire forms. Record the exact shape; the steps below assume `backend.invoke('log_emit', json)` — adjust to the real method.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'
import { makeTestHostDeps } from './host-test-deps' // existing helper if present; else inline a minimal deps stub

describe('restore_checkpoint LogBus parity', () => {
  it('emits a Restore log entry on restore via the host', () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeTestHostDeps(), emitLog })
    host.start()
    const made = host.actor.mcpCall('checkpoint', JSON.stringify({ label: 'cp1' }))
    const cpId = (made as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text
    emitLog.mockClear()
    host.actor.mcpCall('restore_checkpoint', JSON.stringify({ checkpoint_id: cpId }))
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      category: 'Project',
      message: expect.stringContaining('Restored to checkpoint'),
      details: expect.objectContaining({ kind: 'Restore', checkpoint_id: cpId }),
    }))
  })
})
```

(If no `makeTestHostDeps` helper exists, the implementer inlines the minimal `TsActorHostDeps` stub already used by `ts-actor-host` tests — search `createTsActorHost(` in `__tests__`.)

- [ ] **Step 3: Run to confirm failure**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/restore-log-parity.test.ts`
Expected: FAIL — `emitLog` not called (the host never emits).

- [ ] **Step 4: Add the `emitLog` dep + emit on the restore/checkpoint paths**

```typescript
// ts-actor-host.ts — add to TsActorHostDeps
/** Emit a record-panel LogBus entry via the Rust log surface (3d-d parity).
 *  Optional → no-op in tests/flag-off. */
emitLog?: (entry: { level: string; category: string; source: { kind: 'User' } | { kind: 'Agent'; client: string }; message: string; details: Record<string, unknown> }) => void
```

The restore/checkpoint emits must fire when these run through the host. Both `restore_checkpoint` and `checkpoint`/`begin_agent_session` are MCP-served via `actor.mcpCall` (server.ts) and `restore_checkpoint` is also renderer-served via `handleInvoke`'s `command` route. Emit at the host boundary, not inside the actor (the actor stays log-free / pure). Add a post-success hook in `handleInvoke` for the command route and expose a host method the MCP server calls. Concretely, wrap the actor call sites:

```typescript
// ts-actor-host.ts — helper
function logRestore(checkpointId: string, label: string | null): void {
  try {
    deps.emitLog?.({
      level: 'Info', category: 'Project', source: { kind: 'User' },
      message: label ? `Restored to checkpoint: ${label}` : `Restored to checkpoint: ${checkpointId}`,
      details: { kind: 'Restore', checkpoint_id: checkpointId, label },
    })
  } catch (err) { console.warn('[host] emitLog failed', err) }
}
```

In `handleInvoke`'s `case 'command'`, after a successful `project_restore_checkpoint`, look up the label from `actor.listCheckpoints()` BEFORE dispatch is gone (the checkpoint is removed only on `replace_state`, not restore — restore keeps it), then `logRestore`. For the MCP path, have `server.ts`'s `'ts'` branch call a new `host.afterMcpCall(name, args)` hook (or emit inside the existing `begin_agent_session` slot-flip branch for the Checkpoint entry). Mirror the `Checkpoint` entry shape from history.rs:102-113 for `checkpoint`/`begin_agent_session`.

> Keep the emit OUTSIDE the actor and AFTER success; never let it block or fail the mutation.

- [ ] **Step 5: Provide the real `emitLog` in `index.ts`**

```typescript
// index.ts — where createTsActorHost({...}) is constructed, add:
emitLog: (entry) => { void backend.invoke('log_emit', JSON.stringify(entry)) }, // adjust to the real napi from Step 1
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/restore-log-parity.test.ts && npx tsc -b`
Expected: PASS; `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts
git commit -m "feat(state-migration): LogBus record-panel parity for restore/checkpoint under the flag (Phase 4a-i §2.1)"
```

---

## Task 4: Single-source MCP tool table — mechanical tools + projections (§2.7 + §2.5)

**Files:**
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (define `McpToolDef` + `MCP_TOOL_DEFS`; make `MCP_ARG_PARSERS`, `MCP_RESULT_SHAPERS`, `MCP_TOOLS` projections)
- Test: `apps/desktop/src/main/state/__tests__/mcp.tool-table.test.ts` (Create)

**Interfaces:**
- Consumes: existing `parseUuid`/`parseRole`/`parseNum`/`parseNumOpt`/`parseStr`/`parseRgba`/`parseInterp`/`parseAnimatedF64`, `toolText`/`toolEmpty`/`toolJson`.
- Produces:
  ```typescript
  export interface McpToolDef {
    name: string
    description: string                 // populated in Task 6 (placeholder '' acceptable until then? NO — see Step 1)
    inputSchema: Record<string, unknown> // populated in Task 6
    exec: 'table' | 'dedicated'
    parseArgs?: (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> } // table-exec only
    shapeResult?: (value: unknown) => ToolResultJson                                            // table-exec only (default toolEmpty)
    parseDedicated?: (a: Record<string, unknown>) => Record<string, unknown>                    // dedicated-exec only (Task 5)
  }
  export const MCP_TOOL_DEFS: ReadonlyArray<McpToolDef>
  ```
  `MCP_TOOLS = new Set(MCP_TOOL_DEFS.map(d => d.name))`; `MCP_ARG_PARSERS = Object.fromEntries(MCP_TOOL_DEFS.filter(d => d.parseArgs).map(d => [d.name, d.parseArgs!]))`; `MCP_RESULT_SHAPERS = Object.fromEntries(MCP_TOOL_DEFS.filter(d => d.shapeResult).map(d => [d.name, d.shapeResult!]))`.

This task migrates the **27 table-exec tools** (current `MCP_ARG_PARSERS` keys) into `MCP_TOOL_DEFS` records, folding §2.5 hardening into each `parseArgs` (replace every unchecked `as number`/`as boolean`/`as string`/`as string[]` with `parseNum`/typed reads). The 19 dedicated tools get `{ exec: 'dedicated', parseDedicated }` records in Task 5. `description`/`inputSchema` are filled in Task 6 — to avoid a placeholder, this task seeds them from the prior values: `description: ''` is NOT allowed; instead Task 4 imports the descriptions from the committed Rust catalog snapshot (Task 6 Step 1 creates it; if running Task 4 first, set `inputSchema: {}` + `description: ''` ONLY behind a `// FILLED IN TASK 6` marker and make Task 6 a hard dependency before any non-test gate — see ordering note). Recommended: do Task 6's snapshot step first so descriptions/schemas are real here.

- [ ] **Step 1: Write the projection-equivalence test (the behavior-preservation gate)**

```typescript
// apps/desktop/src/main/state/__tests__/mcp.tool-table.test.ts
import { describe, it, expect } from 'vitest'
import { MCP_TOOL_DEFS, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, MCP_TOOLS } from '../mcp-commands'

describe('MCP tool table projections', () => {
  it('MCP_TOOLS equals the set of def names', () => {
    expect(MCP_TOOLS).toEqual(new Set(MCP_TOOL_DEFS.map((d) => d.name)))
  })
  it('every table-exec def round-trips a representative valid arg set identically to its prior parser', () => {
    // remove_track: prior → { op:'delete_track', args:{ track:<uuid>, force:false } }
    const u = '00000000-0000-7000-8000-000000000001'
    expect(MCP_ARG_PARSERS['remove_track']({ track_id: u })).toEqual({ op: 'delete_track', args: { track: u, force: false } })
    expect(MCP_ARG_PARSERS['set_role_gain']({ role: 'music', gain_db: -3 })).toEqual({ op: 'set_role_gain', args: { role: 'music', gain_db: -3 } })
  })
  it('hardened parseArgs rejects malformed input (was a silent as-cast)', () => {
    // force must be a boolean; previously `(a.force as boolean) ?? false` let a string through
    expect(() => MCP_ARG_PARSERS['remove_track']({ track_id: '00000000-0000-7000-8000-000000000001', force: 'yes' })).toThrow()
    // gain_db must be a finite number (was `a.gain_db` raw)
    expect(() => MCP_ARG_PARSERS['set_role_gain']({ role: 'music', gain_db: 'loud' })).toThrow()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.tool-table.test.ts`
Expected: FAIL — `MCP_TOOL_DEFS` not exported.

- [ ] **Step 3: Add a boolean parser + define the table (representative entries shown; SDD fills the rest against the gate)**

```typescript
// mcp-commands.ts — add alongside the other parsers
/** Validate a required boolean wire arg; optional variant defaults via ?? at call site. */
export function parseBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new McpArgError(`${field} must be a boolean`)
  return v
}
export function parseBoolOpt(v: unknown, field: string, dflt: boolean): boolean {
  return v === undefined || v === null ? dflt : parseBool(v, field)
}
```

```typescript
// mcp-commands.ts — the single-source table (table-exec tools shown representatively).
// Each entry folds §2.5 hardening into parseArgs. The remaining 27 table tools
// follow the SAME pattern: every former `a.x as T` → parseX(a.x, 'x'); optional
// flags → parseBoolOpt; patch/track objects stay structural (validated by the
// downstream mutation) but uuid/number/enum scalars are parser-gated.
export const MCP_TOOL_DEFS: McpToolDef[] = [
  { name: 'remove_track', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  { name: 'set_role_gain', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: parseNum(a.gain_db, 'gain_db') } }) },
  { name: 'groups_create', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'groups_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'add_track', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'add_track', args: { label: parseStrOpt(a.label) } }), shapeResult: (v) => toolText(v as string) },
  // … remaining 23 table tools (duplicate_layer, move_track, update_layer,
  //    update_layer_params, move_layer, trim_layer, delete_layer,
  //    groups_dissolve/add_members/remove_members/rename, add/update/move/remove_effect,
  //    set_composition, fit_composition_to_layers, update_marker, remove_marker,
  //    remove_media, undo, redo, set_role_flags) ported from the current
  //    MCP_ARG_PARSERS body, each with scalar args parser-gated.
]
```

Add the small helpers used above:
```typescript
export function parseStrOpt(v: unknown): string | null { return v === undefined || v === null ? null : (typeof v === 'string' ? v : (() => { throw new McpArgError('label must be a string') })()) }
function asArray(v: unknown, field: string): string[] { if (!Array.isArray(v)) throw new McpArgError(`${field} must be an array`); return v as string[] }
```

- [ ] **Step 4: Replace the standalone tables with projections**

```typescript
// mcp-commands.ts — replace the literal MCP_ARG_PARSERS / MCP_RESULT_SHAPERS / MCP_TOOLS
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> =
  Object.fromEntries(MCP_TOOL_DEFS.filter((d) => d.parseArgs).map((d) => [d.name, d.parseArgs!]))
export const MCP_RESULT_SHAPERS: Record<string, (value: unknown) => ToolResultJson> =
  Object.fromEntries(MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => [d.name, d.shapeResult!]))
export const MCP_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_DEFS.map((d) => d.name))
```

- [ ] **Step 5: Run the projection test + the full MCP differential gate (behavior preservation)**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.tool-table.test.ts src/main/state/__tests__/mcp.differential.test.ts && npx tsc -b`
Expected: tool-table PASS; **`mcp.differential` still green, `skipped===[]`** (this is the proof the projection refactor is behavior-preserving on valid input); `tsc` clean. `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` must be empty.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/__tests__/mcp.tool-table.test.ts
git commit -m "refactor(state-migration): single-source MCP table — table-exec tools as projections, hardened parseArgs (Phase 4a-i §2.7/§2.5)"
```

---

## Task 5: Dedicated `mcpCall` arms consume typed `parseDedicated` (§2.7 + §2.5)

**Files:**
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (add `parseDedicated` to the 19 dedicated defs)
- Modify: `apps/desktop/src/main/state/actor.ts` (dedicated `mcpCall` arms call `parseDedicated` instead of re-casting raw `a.*`)
- Test: extend `apps/desktop/src/main/state/__tests__/mcp.tool-table.test.ts`

**Interfaces:**
- Consumes: `MCP_TOOL_DEFS` (Task 4).
- Produces: each dedicated def gains `parseDedicated(a) => typedArgs`; the matching `mcpCall` arm reads `typedArgs` fields. The arm's apply logic (multi-commit, auto-pair, keyframe edit) is unchanged.

The 19 dedicated arms (`add_color_layer`, `add_video_layer`, `add_marker`, `split_layer`, `lock_history`, `unlock_history`, `checkpoint`, `list_checkpoints`, `restore_checkpoint`, `begin_agent_session`, `set_keyframe`, `get_param_track`, `remove_keyframe`, `retime_keyframe`, `set_keyframe_easing`, `smooth_keyframes`, `clear_keyframes`, `set_param_track`, `dry_run`) already validate uuids/colors/numbers inline — but the validation lives in `actor.ts`, divorced from the schema. Move each arm's arg validation into its def's `parseDedicated` so schema (Task 6) and validator co-locate. Several arms still have unchecked casts (the §2.5 targets): `set_keyframe` `a.param_key as string`/`a.t_us as number`/`a.value as number`; `remove_keyframe`/`retime_keyframe`/`set_keyframe_easing`/`smooth_keyframes`/`clear_keyframes`/`get_param_track`/`set_param_track` `a.param_key as string` (+ `a.t_us`/`a.value`); `dry_run` `a.operations as Array`.

- [ ] **Step 1: Write failing tests for the still-unhardened dedicated arms**

```typescript
// append to mcp.tool-table.test.ts
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

describe('dedicated arms reject malformed scalars before commit', () => {
  const mk = () => createActor({ initial: blankProject(uuidV7Gen(), 't'), idGen: uuidV7Gen(), clock: () => '2026-01-01T00:00:00.000Z' })
  it('set_keyframe rejects non-number t_us', () => {
    const r = mk().mcpCall('set_keyframe', JSON.stringify({ layer_id: '00000000-0000-7000-8000-000000000001', param_key: 'opacity', t_us: 'soon', value: 1 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
  })
  it('set_keyframe rejects non-string param_key', () => {
    const r = mk().mcpCall('set_keyframe', JSON.stringify({ layer_id: '00000000-0000-7000-8000-000000000001', param_key: 42, t_us: 0, value: 1 }))
    expect(r.ok).toBe(false)
  })
  it('dry_run rejects non-array operations', () => {
    const r = mk().mcpCall('dry_run', JSON.stringify({ operations: 'nope' }))
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.tool-table.test.ts -t "reject malformed scalars"`
Expected: FAIL — non-number `t_us` currently `as number` → `NaN` flows in (no reject), or throws an uncaught TypeError.

- [ ] **Step 3: Add `parseDedicated` to each dedicated def + harden the scalars**

Example records (the arm keeps its apply logic; validation moves here):
```typescript
// mcp-commands.ts — dedicated defs (representative)
{ name: 'add_color_layer', exec: 'dedicated', description: '', inputSchema: {},
  parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), color: parseRgba(a.color, 'color'),
    width: parseNumOpt(a.width, 'width'), height: parseNumOpt(a.height, 'height'),
    t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us') }) },
{ name: 'set_keyframe', exec: 'dedicated', description: '', inputSchema: {},
  parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
    t_us: parseNum(a.t_us, 't_us'), value: parseNum(a.value, 'value'), interp: parseInterpOpt(a.interp) }) },
{ name: 'dry_run', exec: 'dedicated', description: '', inputSchema: {},
  parseDedicated: (a) => ({ operations: asArray(a.operations, 'operations') }) },
// … the remaining 16 dedicated defs.
```

- [ ] **Step 4: Rewrite the dedicated `mcpCall` arms to consume `parseDedicated`**

```typescript
// actor.ts — example: add_color_layer arm
case 'add_color_layer': {
  const p = mcpDef('add_color_layer').parseDedicated!(a)
  const params = colorParams(p.color as Rgba, (p.width as number | undefined) ?? 1920, (p.height as number | undefined) ?? 1080)
  const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, p.track as string, params, p.t_start_us as number, p.t_end_us as number))
  return { ok: true, result: toolText(id) }
}
// set_keyframe arm:
case 'set_keyframe': {
  const p = mcpDef('set_keyframe').parseDedicated!(a)
  const { tStartUs, track } = readLayerTrack(current(), p.layer as string, p.param_key as string)
  const next = upsertKeyframe(track, (p.t_us as number) - tStartUs, p.value as number, p.interp as Interpolation | undefined, idGen)
  const r = dispatch('update_layer_param_track', { layer: p.layer, param_key: p.param_key, track: next })
  if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
  return { ok: true, result: toolEmpty() }
}
```

Add the small lookup helper (imported into actor.ts):
```typescript
// mcp-commands.ts
const DEF_BY_NAME: Map<string, McpToolDef> = new Map(MCP_TOOL_DEFS.map((d) => [d.name, d]))
export function mcpDef(name: string): McpToolDef { const d = DEF_BY_NAME.get(name); if (!d) throw new Error(`no MCP def for ${name}`); return d }
```

Each `parseDedicated` runs inside `mcpCall`'s existing try/catch, so a thrown `McpArgError` already maps to `-32602` (actor.ts:831). The `McpArgError` thrown before any `commit` guarantees reject-before-commit.

- [ ] **Step 5: Run tests + the differential gate**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.tool-table.test.ts src/main/state/__tests__/mcp.differential.test.ts src/main/state/__tests__/mcp.malformed-args.test.ts && npx tsc -b`
Expected: all PASS; `mcp.differential` green `skipped===[]` (valid corpus inputs unaffected); `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/__tests__/mcp.tool-table.test.ts
git commit -m "refactor(state-migration): dedicated mcpCall arms consume typed parseDedicated (Phase 4a-i §2.7/§2.5)"
```

---

## Task 6: Author `inputSchema` + `description` for all 46 + faithfulness snapshot gate (§2.7)

**Files:**
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (fill `description`/`inputSchema` on every def)
- Create: `apps/desktop/fixtures/mcp/rust-catalog-snapshot.json` (committed snapshot of `backend.mcpCatalog()`)
- Create: `apps/desktop/scripts/snapshot-mcp-catalog.mjs` (one-shot generator)
- Test: `apps/desktop/src/main/state/__tests__/mcp.catalog-faithfulness.test.ts` (Create)

**Interfaces:**
- Consumes: `MCP_TOOL_DEFS` (Tasks 4-5), the live Rust catalog via `backend.mcpCatalog()`.
- Produces: every def has a real `description` + a real JSON-Schema `inputSchema` (advertised in 4b); a committed `rust-catalog-snapshot.json`; a loose faithfulness gate.

The TS schemas need not byte-equal Rust's schemars output (schemars emits `$schema`/`definitions`/`title` that hand-written schemas won't match). The faithfulness gate is therefore **loose**: same tool-name set, and for each tool the same set of **required field names** + each field's top-level JSON type. The strong invariant (schema ↔ validator can't drift) is the bijection gate in Task 7.

- [ ] **Step 1: Generate + commit the Rust catalog snapshot**

```javascript
// apps/desktop/scripts/snapshot-mcp-catalog.mjs
import { Backend } from '@weftcut/core'
import { writeFileSync } from 'node:fs'
const b = new Backend()          // construct as the existing dev scripts do; adjust if init needed
const cat = JSON.parse(await b.mcpCatalog())
writeFileSync('apps/desktop/fixtures/mcp/rust-catalog-snapshot.json', JSON.stringify(cat, null, 2) + '\n')
console.log(`snapshot: ${cat.tools.length} tools`)
```

Run: `cd apps/desktop && node scripts/snapshot-mcp-catalog.mjs` (with the FFMPEG/LLVM env from the corpus-regen recipe if the napi requires it). Commit the snapshot. This is a one-time data fixture, NOT an oracle — it does not touch `fixtures/state-corpus`.

- [ ] **Step 2: Write the failing faithfulness test**

```typescript
// apps/desktop/src/main/state/__tests__/mcp.catalog-faithfulness.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as { tools: Array<{ name: string; inputSchema: { required?: string[]; properties?: Record<string, { type?: string }> } }> }
const rustByName = new Map(rust.tools.map((t) => [t.name, t]))

describe('TS MCP schemas are faithful to the Rust catalog (loose)', () => {
  for (const def of MCP_TOOL_DEFS) {
    it(`${def.name}: required-field names + types match Rust`, () => {
      const r = rustByName.get(def.name)
      expect(r, `${def.name} missing from Rust catalog`).toBeDefined()
      const ts = def.inputSchema as { required?: string[]; properties?: Record<string, { type?: string }> }
      expect(new Set(ts.required ?? [])).toEqual(new Set(r!.inputSchema.required ?? []))
      for (const [k, v] of Object.entries(r!.inputSchema.properties ?? {})) {
        if (v.type) expect(ts.properties?.[k]?.type, `${def.name}.${k} type`).toBe(v.type)
      }
    })
  }
})
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.catalog-faithfulness.test.ts`
Expected: FAIL — `inputSchema` is `{}` for every def.

- [ ] **Step 4: Fill `description` + `inputSchema` from the snapshot**

For each def, copy the `description` verbatim from the snapshot and author a minimal JSON Schema matching the snapshot's `required` + property `type`s (drop schemars-specific `$schema`/`definitions`/`title`). Representative:
```typescript
{ name: 'remove_track', exec: 'table',
  description: 'Remove a custom (non-reserved) track…',  // from snapshot
  inputSchema: { type: 'object', required: ['track_id'], properties: {
    track_id: { type: 'string', description: 'UUID of the track' },
    force: { type: 'boolean' } } },
  parseArgs: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
```
Fill all 46 (SDD task; the faithfulness test green-lights each).

- [ ] **Step 5: Run the faithfulness gate + typecheck**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.catalog-faithfulness.test.ts && npx tsc -b`
Expected: 46/46 PASS; `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/fixtures/mcp/rust-catalog-snapshot.json apps/desktop/scripts/snapshot-mcp-catalog.mjs apps/desktop/src/main/state/__tests__/mcp.catalog-faithfulness.test.ts
git commit -m "feat(state-migration): author TS MCP inputSchema+description + faithfulness gate vs Rust catalog (Phase 4a-i §2.7)"
```

---

## Task 7: Structural catalog↔handler bijection gate (§2.7, permanent)

**Files:**
- Create: `apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts`
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (export a `schemaFieldsReferencedByParse` helper if needed for the consistency check)

**Interfaces:**
- Consumes: `MCP_TOOL_DEFS`, `routeMcpTool` (mutationTools.ts), `HYBRID_TOOLS` (mutationTools.ts), the Rust catalog snapshot.
- Produces: the permanent gate. No regen dependency → survives the 4b harness freeze.

This is the gate the spec §2.7 promises. Three assertions, with the **gate-input-in-4a derivation** pinned (the Rust catalog is not split until 4b, so "Rust-native" = the snapshot filtered to non-`ts`-routed names):

- [ ] **Step 1: Write the gate**

```typescript
// apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS } from '../mcp-commands'
import { routeMcpTool, HYBRID_TOOLS } from '../../mcp/mutationTools'

const rust = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as { tools: Array<{ name: string }> }
const allRustNames = rust.tools.map((t) => t.name)
const tsNames = new Set(MCP_TOOL_DEFS.map((d) => d.name))
// 4a derivation: "Rust-native" = the live catalog minus the ts-routed names.
const nativeNames = allRustNames.filter((n) => routeMcpTool(n) !== 'ts')

describe('MCP catalog↔handler bijection (permanent gate)', () => {
  it('1. merged catalog (native ∪ TS table) is an exact union — no dup, no drop', () => {
    const merged = new Set([...nativeNames, ...tsNames])
    // no duplicate: nativeNames and tsNames are disjoint by construction of nativeNames
    expect(nativeNames.filter((n) => tsNames.has(n))).toEqual([])
    // exact union: merged equals the advertised Rust set (no drop, no extra). In 4a
    // every TS tool is still Rust-advertised, so the two sets coincide; in 4b the
    // same assertion re-targets the post-split merged catalog.
    expect(merged).toEqual(new Set(allRustNames))
  })
  it('2. every TS-table name routes to ts (advertised ⇒ handled by the TS path)', () => {
    for (const d of MCP_TOOL_DEFS) expect(routeMcpTool(d.name)).toBe('ts')
  })
  it('3. every ts-routed name is in the TS table; every hybrid-routed name is in HYBRID_TOOLS (handled ⇒ advertised)', () => {
    for (const n of allRustNames) {
      const r = routeMcpTool(n)
      if (r === 'ts') expect(tsNames.has(n)).toBe(true)
      if (r === 'hybrid') expect(HYBRID_TOOLS.has(n)).toBe(true)
    }
  })
  it('4. schema↔validator consistency: every required inputSchema field is read by the tool’s parser', () => {
    for (const d of MCP_TOOL_DEFS) {
      const required = ((d.inputSchema as { required?: string[] }).required) ?? []
      const parse = d.parseArgs ?? d.parseDedicated
      if (!parse) continue
      // Probe: omitting a required field must throw (the validator enforces what the schema advertises).
      for (const field of required) {
        const args: Record<string, unknown> = {}
        for (const r of required) if (r !== field) args[r] = sampleFor(d.name, r)
        expect(() => parse(args), `${d.name}: missing required '${field}' should reject`).toThrow()
      }
    }
  })
})

// sampleFor: minimal valid value per (tool, field) so the "omit one required" probe
// isolates the omitted field. Implemented as a small lookup keyed by field-name
// convention (uuid → a valid uuid, *_us → 0, role → 'music', color → {r,g,b,a}).
function sampleFor(_tool: string, field: string): unknown {
  if (field.endsWith('_id') || field === 'track' || field === 'group' || field === 'layer') return '00000000-0000-7000-8000-000000000001'
  if (field.endsWith('_us') || field === 'gain_db' || field === 'value') return 0
  if (field === 'role') return 'music'
  if (field === 'color') return { r: 0, g: 0, b: 0, a: 255 }
  if (field === 'operations') return []
  return 'x'
}
```

> Assertion 4 is the real anti-drift invariant: a schema that advertises a required field whose parser doesn't enforce it fails the build. (Tools whose required set is empty, or whose parser tolerates the field absent, are skipped naturally — tune `sampleFor` per the actual schemas during implementation.)

- [ ] **Step 2: Run — fix any genuine drift it surfaces**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.catalog-bijection.test.ts`
Expected: PASS. Any failure is a real schema↔validator or routing mismatch — fix the def, not the test.

- [ ] **Step 3: Full suite + typecheck**

Run: `cd apps/desktop && npx vitest run && npx tsc -b`
Expected: full vitest green (`skipped===[]` on every differential gate; corpus untouched), `tsc` clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts apps/desktop/src/main/state/mcp-commands.ts
git commit -m "test(state-migration): permanent MCP catalog↔handler bijection gate (Phase 4a-i §2.7)"
```

---

## Task 8: Parser-harden the command path, `dispatch()` arms, and `specToDryRunOp` (§2.5)

**Files:**
- Modify: `apps/desktop/src/main/state/commands.ts` (`prodColorParams`/`prodTextParams`/`prodMediaLayer`, MECHANICAL casts)
- Modify: `apps/desktop/src/main/state/actor.ts` (`dispatch()` arms :371-409 + `specToDryRunOp` :615-639)
- Test: `apps/desktop/src/main/state/__tests__/command-path-hardening.test.ts` (Create)

**Interfaces:**
- Consumes: the typed parsers from `mcp-commands.ts` (now exported: `parseNum`/`parseNumOpt`/`parseStr`/`parseRgba`/`parseBoolOpt`/`parseUuid`). For the command (renderer) path these reject as `CommandError`/`McpArgError`; `command()` already wraps `McpArgError`→`InvalidArgument` via `dispatch`'s catch (Task 2 Step 3b makes that mapping exist).
- Produces: no malformed wire value reaches a `commit` as `NaN`/garbage from the renderer or `specToDryRunOp` paths.

The renderer `command()` path's rich builders cast freely: `commands.ts` `prodColorParams` (`a.color as Rgba`, `a.width as number`), `prodMediaLayer` (`a.mediaId as string`), and `command()`'s inline `wireArgs.tStartUs as number`/`wireArgs.durationUs as number`. `specToDryRunOp` casts `spec.t_start_us as number`, `spec.color as Rgba`, `spec.patch as LayerPatch`, etc. `dispatch()` arms cast `a.t_start_us as number` etc. (the corpus feeds these well-formed, but the uniform discipline removes the "which adapter is trusted" reasoning burden — spec §2.5 names `actor.ts ≈ L368`).

- [ ] **Step 1: Write failing tests**

```typescript
// apps/desktop/src/main/state/__tests__/command-path-hardening.test.ts
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

const mk = () => { const g = uuidV7Gen(); return createActor({ initial: blankProject(g, 't'), idGen: g, clock: () => '2026-01-01T00:00:00.000Z' }) }

describe('command-path arg hardening', () => {
  it('add_color_layer rejects a non-number tStartUs instead of committing NaN', () => {
    const r = mk().command('add_color_layer', { tStartUs: 'soon', durationUs: 1_000_000 })
    expect(r.ok).toBe(false)
  })
  it('add_color_layer rejects a string color', () => {
    const r = mk().command('add_color_layer', { tStartUs: 0, color: '#fff' })
    expect(r.ok).toBe(false)
  })
  it('dry_run via specToDryRunOp rejects a non-number t_start_us', () => {
    const r = mk().mcpCall('dry_run', JSON.stringify({ operations: [{ kind: 'add_color_layer', track_id: '00000000-0000-7000-8000-000000000001', color: { r:0,g:0,b:0,a:255 }, t_start_us: 'x', t_end_us: 1 }] }))
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/command-path-hardening.test.ts`
Expected: FAIL — NaN commits or an uncaught throw.

- [ ] **Step 3: Harden `commands.ts` builders + `command()` inline casts**

```typescript
// commands.ts — prodColorParams
export function prodColorParams(a: Record<string, unknown>, comp: { width: number; height: number }): LayerParams {
  const color = a.color === undefined ? { r: 0, g: 0, b: 0, a: 255 } : parseRgba(a.color, 'color')
  return { kind: 'Color', color: { mode: 'Static', value: color },
    width: parseNumOpt(a.width, 'width') ?? comp.width, height: parseNumOpt(a.height, 'height') ?? comp.height }
}
```
Apply the same discipline to `prodTextParams` (`content` via `parseStrOpt`), `prodMediaLayer` (`mediaId` via `parseStr`), and `command()`'s `tStartUs`/`durationUs`/`trackId` reads (`parseNum`/`parseNumOpt`/uuid-when-present). Import the parsers from `./mcp-commands`.

- [ ] **Step 4: Harden `specToDryRunOp` + the `dispatch()` arms**

In `actor.ts` `specToDryRunOp` (:615): replace `spec.t_start_us as number` → `parseNum(spec.t_start_us, 't_start_us')`, `spec.color as Rgba` → `parseRgba(spec.color, 'color')`, `spec.width/height` → `parseNumOpt`, etc. (`parseUuid` is already used there.) In `dispatch()` arms (:371-409), replace scalar `as number`/`as string` casts that originate from non-corpus callers with the typed parsers — keep structural objects (`patch`) as-is. `McpArgError` thrown here is mapped by Task 2 Step 3b's catch addition.

- [ ] **Step 5: Run tests + full differential gates**

Run: `cd apps/desktop && npx vitest run src/main/state && npx tsc -b`
Expected: hardening tests PASS; **all differential gates green `skipped===[]`** (valid corpus inputs unaffected — the proof the hardening is reject-only); `tsc` clean; `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` empty.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/state/commands.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/__tests__/command-path-hardening.test.ts
git commit -m "fix(state-migration): parser-gate command path, dispatch arms, specToDryRunOp (Phase 4a-i §2.5)"
```

---

## Final verification (run before declaring 4a-i done)

- [ ] `cd apps/desktop && npx vitest run` — full suite green; every `*.differential.test.ts` reports `skipped===[]`.
- [ ] `cd apps/desktop && npx tsc -b` — clean.
- [ ] `git diff --diff-filter=M apps/desktop/fixtures/state-corpus` — **empty** (no oracle regenerated; the spine constraint).
- [ ] `BLOCKED_UNDER_FLAG` and `MCP_BLOCKED_UNDER_FLAG` each contain only `add_motif`.
- [ ] The bijection gate + faithfulness gate are green (the permanent backstops that survive 4b).
- [ ] Run the existing flag-on e2es: `npx playwright test e2e/electron/ts-actor-flip.spec.ts e2e/electron/mcp-flip.spec.ts` — green (the TS surface still drives end-to-end; `restore_checkpoint` now reachable).

---

## Self-Review

**Spec coverage (vs §2.1/§2.5/§2.6/§2.7):**
- §2.1 restore_checkpoint: Task 2 (routing + dispatch arm + un-block) + Task 3 (LogBus parity). ✓ The §7 open-item (renderer-restore differential seeding) is resolved by the "thin alias verified by unit test + targeted soak" option — Task 2's unit test + the transition soak; no new prod-corpus seq (keeps 4a-i regen-free). ✓
- §2.5 parser hardening: Task 4 (table-exec parseArgs), Task 5 (dedicated parseDedicated), Task 8 (command path + dispatch + specToDryRunOp). The "every pre-commit unknown→type adapter parser-gated" goal is covered across MCP + renderer + dry-run surfaces. ✓
- §2.6 subscriber-starvation: Task 1. ✓
- §2.7 single-source table + structural gate: Task 4 (table + projections), Task 5 (dedicated co-location), Task 6 (inputSchema + loose faithfulness), Task 7 (bijection gate, dormant, survives 4b). The gate-input-in-4a derivation (native = snapshot minus ts-routed) is pinned in Task 7. ✓ `add_motif` correctly absent from the TS table (it joins `HYBRID_TOOLS` in 4a-ii). ✓

**Placeholder scan:** The `// … remaining N tools` markers in Tasks 4/5/6 are bounded by the gates (projection-equivalence, faithfulness, bijection) — the SDD task fills them with the gate as the acceptance criterion, which is the intended pattern for mechanical bulk (not vague "implement later"). The `inputSchema`/`description` empty seeds in Task 4 are explicitly resolved in Task 6 with an ordering note; recommend running Task 6's snapshot step (6.1) before Task 4 so the seeds are never committed empty. No `TODO`/`TBD`/"handle edge cases" remain.

**Type consistency:** `McpToolDef` fields (`exec`/`parseArgs`/`shapeResult`/`parseDedicated`/`inputSchema`/`description`) are used identically across Tasks 4-7. `parseBool`/`parseBoolOpt`/`parseStrOpt`/`asArray`/`mcpDef` are defined in Task 4/5 and consumed consistently. The `McpArgError`→`InvalidArgument` mapping added in Task 2 Step 3b is relied on by Tasks 5 and 8 (dispatch-path rejects). ✓

**Ordering note (important for the executor):** run **Task 6 Step 1 (the catalog snapshot) first**, then Tasks 4 → 5 → 6 (fill) → 7, with Tasks 1/2/3/8 independent. Tasks 4/5 commit defs with real descriptions/schemas only after the snapshot exists; otherwise the empty-seed defs would ship in an intermediate commit (harmless — gated by Task 6 — but avoidable).
