# Phase 3d-c — MCP checkpoints + agent session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 4 MCP checkpoint/agent-session tools (`checkpoint`, `list_checkpoints`, `restore_checkpoint`, `begin_agent_session`) onto the TS state actor as a DORMANT, differential-gated extension of the 3d-a/3d-b `actor.mcpCall` adapter, and build the `agent_session_end` history-unlock seam dormant + unit-tested. No live routing — the `server.ts` flip + MCP un-pause is Phase 3d-d.

**Architecture:** The `History` class (`src/main/state/history.ts`) already implements `checkpoint`/`restoreCheckpoint`/`listCheckpoints`. This slice (1) exposes `checkpoint(label)`/`restoreCheckpoint(id)`/`listCheckpoints()` as internal actor closures + on `ActorHandle` (mirroring `undo`/`redo`), minting ids from the actor's deterministic `idGen` to match Rust `new_id()` order; (2) adds 4 arms to `actor.mcpCall` that shape the exact `ToolResult` envelopes; (3) builds a dependency-injected `agentSessionEnd` seam (slot-end + `actor.unlockHistory`) unit-tested but unrouted; (4) extends the Rust `mcp_driver` + TS `replay.ts` `@ref` capture for server-minted checkpoint ids; (5) adds an additive `sequences-mcp/`/`oracle-mcp/` corpus dimension. The Rust `mcp_driver` (3d-a) drives the REAL `dispatch_tool` for these 4 tools with **zero Rust handler changes**.

**Tech Stack:** TypeScript (Electron main, vitest/esbuild), Rust (napi-rs addon + `bin` drivers, `serde_json`), the existing `fixtures/state-corpus` differential harness.

## Global Constraints

- DORMANT slice: **NO change to `src/main/index.ts`, `src/main/mcp/server.ts`, `src/main/state/ts-actor-host.ts`, `src/main/state/router.ts`, or `src/main/mcp/mutationTools.ts`.** The MCP mutation pause stays as-is; nothing goes live. Verified by diff in Task 5.
- Corpus changes are **ADDITIVE**: existing oracle dirs (`oracle/`, `oracle-summary/`, `oracle-prod/`, `oracle-mcp/`) stay byte-identical — `git diff --diff-filter=M fixtures/state-corpus` over those dirs must be empty after regen. 3d-b's `oracle-mcp/` is the prior baseline; 3d-c only ADDS files to it.
- `dispatch()`, `command()`, and the 3d-a/3d-b `mcpCall` arms stay **behaviorally untouched** — 3d-c only ADDS new `mcpCall` arms + new `ActorHandle` methods.
- Error gating = **`code` + structured `data` byte-identical + state byte-identical**. The prose `message` is generated reasonably but NOT asserted byte-equal. `HistoryLocked`/`CheckpointNotFound` map to `invalid_params` with **no `data`** → code-gated only. (Matches the 3d-a/3d-b `errKey` comparison.)
- Structured ToolResult JSON (`list_checkpoints`, `begin_agent_session`) serializes with **alpha-sorted keys** via `toolJson` (= `canonicalize` + `JSON.stringify`) to match Rust `serde_json` (preserve_order OFF → BTreeMap / `json!` Map).
- The MCP agent actor is `Actor::Agent{client:"mcp"}` — the corpus uses det ids, so actor attribution (stored on `NamedCheckpoint.actor`, NOT in `serializeProject` nor in the gated `{id,label,created_at}` list shape) does not affect any gated bytes.
- Regen toolchain env (Windows): `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…/ffmpeg-8.1.1-full_build-shared>`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH=$FFMPEG_DIR/bin:$PATH`; build `--features replay,jobs,export,mcp,cloud,motifs`. (Controller-run; per-task reviewers do NOT run cargo/regen — the controller verifies `tsc -b` since vitest uses esbuild and won't catch type errors.)
- Branch: `phase-3d-c-checkpoints` (created in Task 1 Step 0; plan doc committed first).

## Background facts (verified vs code — read before implementing)

- **Rust handlers** (`native/src/mcp/tools.rs`): `checkpoint` (1362), `list_checkpoints` (1396), `restore_checkpoint` (1410), `begin_agent_session` (154). All registered in `catalog.rs` (`tool_table!`) and routed by `dispatch_tool` — **no Rust handler edits needed**; `mcp_driver` drives `dispatch_tool`.
- **`checkpoint(label)`**: trims `label`, rejects empty → `invalid_params("label must be non-empty")`; `b.project().checkpoint(agent_actor(), label)` → `History::checkpoint` (history.rs:135) mints **1 id** (`new_id()`), NO history op, NO ChangeEvent/broadcast; returns `ToolResult::text(id.to_string())` (RAW uuid, not JSON-encoded).
- **`list_checkpoints()`**: read-only; `b.project().history_view(0).checkpoints` → `ToolResult::json(&view.checkpoints)`. The `checkpoints` field is `[{id,label,created_at}]` (NamedCheckpoint projected, oldest-first by `created_at`). Mints 0 ids.
- **`restore_checkpoint(checkpoint_id)`**: `parse_uuid`; looks up label (for the log only); `b.project().restore_checkpoint(agent_actor(), id)` → `do_restore_checkpoint` (actor.rs:3764): (1) `HistoryLocked{reason}` if `lock_reason()` set — **0 ids, BEFORE any mint**; (2) `History::restore_checkpoint(id)` (history.rs:148) — `checkpoints.get(&id)?` (None → `CheckpointNotFound`, **0 ids**), else mints **1 op_id** (`new_id()`) + records a HistoryEntry; (3) broadcasts a `ChangeEvent{op_id:new_id()}` — **+1 id**. Success = **2 ids** (entry op_id FIRST, broadcast op_id SECOND). Returns `ToolResult::empty()`.
- **`begin_agent_session(reason)`**: trims `reason`, rejects empty → `invalid_params("reason must be non-empty")` (**FIRST**, before any id/log); the `op_id` at tools.rs:165 is a raw `Uuid::now_v7()` for the LogEntry (NOT the det counter → consumes 0 det ids); `started_at = Utc::now()`; `b.project().checkpoint(agent_actor(), "Pre-agent: {reason}")` → **1 det id** (the checkpoint); flips the Rust `agent_session` slot + emits `agent_session:changed` (NON-project-state side effect — invisible to the gate); returns `ToolResult::json({checkpoint_id, started_at: started_at.to_rfc3339()})`.
- **The `agent_session_end` history-unlock seam** (`commands/prefs.rs:209`, a renderer/napi channel, NOT an MCP tool): `agent_session::end_and_emit(slot)` (clear slot + emit) THEN `handle.unlock_history()` (release any `lock_history` the agent took). Under `WEFTCUT_TS_ACTOR` the authoritative history is the TS actor, so the unlock must hit the TS actor, not the stale Rust handle. (The spec sketch's "begin_agent_session does lockHistory" is WRONG — begin only checkpoints + flips the slot. The lock is the separate `lock_history` tool, shipped in 3d-a.)
- **TS `History`** (`src/main/state/history.ts`): `checkpoint(label, actor, id, createdAt='<TS>'): Uuid` (80) stores `{id,label,actor,created_at,snapshot:current()}`, returns id, no op/broadcast; `restoreCheckpoint(id, opId, timestamp, actor): Project|null` (84) returns null if absent, else `record({op_id:opId,...})` + returns the snapshot; `listCheckpoints(): NamedCheckpoint[]` (90) sorted by `created_at` asc. `view()` (168) projects `checkpoints` to `[{id,label,created_at}]`. `lock(reason)`/`unlock()`/`lockReason()` (76-78). `CheckpointNotFound`/`HistoryLocked` are present in the TS `CommandError` union (`errors.ts:34,51`).
- **TS actor closure** (`actor.ts:71-110`): `idGen`, `clock` (= `()=>'<TS>'` in det mode), `actor` (= `{kind:'User'}` default), `history`, `current()`, `commit`, `broadcastUnrecorded(summary, snapshot)` (107 — mints **1 id** via `idGen()`, mirrors Rust `broadcast_unrecorded`'s `new_id`). The `mcpCall` catch (753) maps a thrown `CommandFailure` via `mapCommandError(e.err)`.
- **Canonicalizer** (`canonical.ts`): `TS_FIELDS = {'created_at','modified_at'}` normalized to `<TS>`. `begin_agent_session`'s result `started_at` is wall-clock RFC3339 in the oracle but `<TS>` from the TS clock → **must add `started_at` to `TS_FIELDS`** (collision-checked in Task 4 — no `serializeProject` field is named `started_at`). `created_at` is already covered → `checkpoint`/`list_checkpoints` need nothing.
- **`mcp.differential.test.ts`** is GENERIC (auto-discovers `sequences-mcp/*.json`, asserts per-step canonical `state` + `env.result` (ok) + `errKey` code+data (error)); new 3d-c sequences flow through it with NO new gate file. `mcpSequenceIsSupported` skips a sequence unless every op is `add_media` or in `MCP_TOOLS` — so new tools MUST be added to `MCP_TOOLS` as their arms land (else the "no silent skips" assertion fails loudly).
- **`mcp_driver.rs` `extract_ref_id`** (82) and **`replay.ts` `mcpRefId`** (222) are symmetric `@ref`-capture twins. id tools return the raw uuid text; `add_video_layer`/`get_param_track` parse the JSON. 3d-c adds `checkpoint` (raw text) and `begin_agent_session` (`checkpoint_id` field) so a sequence can `@ref` a server-minted checkpoint id.

## File Structure

- Modify `apps/desktop/src/main/state/history.ts` — add `hasCheckpoint(id): boolean` (presence peek so the actor can check existence BEFORE minting the restore op_id).
- Modify `apps/desktop/src/main/state/actor.ts` — add `checkpoint`/`restoreCheckpoint`/`listCheckpoints` internal closures + `ActorHandle` methods + interface entries; add 4 `mcpCall` arms.
- Modify `apps/desktop/src/main/state/canonical.ts` — add `started_at` to `TS_FIELDS`.
- Modify `apps/desktop/src/main/state/mcp-commands.ts` — add the 4 tools to `MCP_TOOLS` (as their arms land).
- Create `apps/desktop/src/main/state/agent-session-seam.ts` — the dormant DI `agentSessionEnd` seam.
- Modify `apps/desktop/native/src/bin/mcp_driver.rs` — `extract_ref_id` += `checkpoint`/`begin_agent_session`.
- Modify `apps/desktop/src/main/state/replay.ts` — `mcpRefId` += `checkpoint`/`begin_agent_session`.
- Create `apps/desktop/src/main/state/__tests__/checkpoint.actor.test.ts` — direct-actor id-contract unit gate (Task 1).
- Create `apps/desktop/src/main/state/__tests__/agent-session-seam.test.ts` — seam order unit test (Task 4).
- Create `apps/desktop/fixtures/state-corpus/sequences-mcp/*.json` + generated `oracle-mcp/*.json` (Tasks 2-4).
- Modify `apps/desktop/fixtures/state-corpus/README.md` — extend the mcp dimension note (Task 5).

The differential gate `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` (3d-a) is REUSED unchanged.

---

### Task 1: ActorHandle checkpoint surface + `hasCheckpoint` + `started_at` canonical + direct id-contract unit test (TS infra; no MCP yet)

**Files:**
- Modify: `apps/desktop/src/main/state/history.ts`
- Modify: `apps/desktop/src/main/state/canonical.ts`
- Modify: `apps/desktop/src/main/state/actor.ts`
- Create: `apps/desktop/src/main/state/__tests__/checkpoint.actor.test.ts`

**Interfaces:**
- Consumes: `History.checkpoint`/`restoreCheckpoint`/`listCheckpoints`/`lockReason` (history.ts), `idGen`/`clock`/`actor`/`history`/`broadcastUnrecorded`/`current` (actor closure), `CommandFailure` (errors), `Uuid` (model).
- Produces:
  - `History.hasCheckpoint(id: Uuid): boolean`.
  - actor closures `checkpoint(label: string): Uuid`, `restoreCheckpoint(id: Uuid): void` (throws `CommandFailure(HistoryLocked|CheckpointNotFound)`), `listCheckpoints(): Array<{ id: Uuid; label: string; created_at: string }>`.
  - `ActorHandle.checkpoint`/`restoreCheckpoint`/`listCheckpoints` (same signatures).
  - `canonical.ts` `TS_FIELDS` includes `started_at`.

- [ ] **Step 0: Create the branch and commit this plan.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor
git checkout -b phase-3d-c-checkpoints
git add docs/superpowers/plans/2026-06-25-state-actor-ts-migration-phase-3d-c.md
git commit -m "docs(state-migration): Phase 3d-c plan (MCP checkpoints + agent session)"
```

- [ ] **Step 1: Add `hasCheckpoint` to `History`.**

In `apps/desktop/src/main/state/history.ts`, immediately after `listCheckpoints()` (ends line 92), add:

```typescript
  /** Presence peek (history.rs:149 `checkpoints.get(&id)?`). The actor checks
   *  this BEFORE minting the restore op_id, so a CheckpointNotFound restore
   *  burns zero ids — matching Rust, where `new_id()` sits after the `get?`. */
  hasCheckpoint(id: Uuid): boolean { return this.checkpoints.has(id) }
```

- [ ] **Step 2: Add `started_at` to the canonicalizer.**

First confirm no serialized project field collides:

```bash
cd /c/Users/jonny/Desktop/learning/videtor/apps/desktop
grep -rn "started_at" src/main/state/model.ts src/main/state/serialize.ts fixtures/state-corpus/oracle fixtures/state-corpus/oracle-prod | head
```
Expected: NO hits (the only `started_at` in the tree is `AgentSession`, which is not serialized into the project). If any project/oracle hit appears, STOP — normalizing it would mask real state; instead normalize `started_at` only inside the `mcp.differential` `resultKey` and report the deviation.

Then in `apps/desktop/src/main/state/canonical.ts` line 1, change:

```typescript
const TS_FIELDS = new Set(['created_at', 'modified_at'])
```
to:
```typescript
// `started_at` is begin_agent_session's wall-clock result field (the agent
// session start); normalized so the MCP envelope gates deterministically.
// No serialized Project field is named started_at (collision-checked).
const TS_FIELDS = new Set(['created_at', 'modified_at', 'started_at'])
```

- [ ] **Step 3: Add the `checkpoint`/`restoreCheckpoint`/`listCheckpoints` closures to `actor.ts`.**

In `apps/desktop/src/main/state/actor.ts`, immediately after the `redo()` function (ends line 192), add:

```typescript
  // ── checkpoints (do_restore_checkpoint actor.rs:3764; History::checkpoint
  //    history.rs:135) — used by the MCP checkpoint + begin_agent_session tools
  //    (3d-c). checkpoint mints 1 id, no op/broadcast; restore success = 2 ids
  //    (entry op_id then broadcast op_id); CheckpointNotFound/HistoryLocked = 0. ──
  function checkpoint(label: string): Uuid {
    const id = idGen() // History::checkpoint's new_id — no commit, no broadcast
    return history.checkpoint(label, actor, id, clock())
  }
  function restoreCheckpoint(id: Uuid): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason }) // 0 ids
    if (!history.hasCheckpoint(id)) throw new CommandFailure({ error: 'CheckpointNotFound', checkpoint: id }) // 0 ids — peek BEFORE mint
    const opId = idGen() // entry op_id (history.rs:151 new_id, FIRST)
    const snap = history.restoreCheckpoint(id, opId, clock(), actor)!
    broadcastUnrecorded(`Restored checkpoint ${id}`, snap) // +1 broadcast id (actor.rs:3780, SECOND)
  }
  function listCheckpoints(): Array<{ id: Uuid; label: string; created_at: string }> {
    return history.listCheckpoints().map((c) => ({ id: c.id, label: c.label, created_at: c.created_at }))
  }
```

- [ ] **Step 4: Expose them on `ActorHandle`.**

In `actor.ts`, add to the `ActorHandle` interface (after `unlockHistory(): void`, line 66):

```typescript
  checkpoint(label: string): Uuid
  restoreCheckpoint(id: Uuid): void
  listCheckpoints(): Array<{ id: Uuid; label: string; created_at: string }>
```

And in the returned object literal (after `unlockHistory: () => history.unlock(),`, line 768):

```typescript
    checkpoint,
    restoreCheckpoint,
    listCheckpoints,
```

- [ ] **Step 5: Write the direct-actor id-contract unit test.**

Create `apps/desktop/src/main/state/__tests__/checkpoint.actor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'

function setup() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't') // mints A#1, B#2, project#3
  const actor = createActor({ initial, idGen, clock: () => '<TS>' }) // Initial op_id #4
  const aRoll = initial.tracks[0].id
  function addColor() {
    const r = actor.dispatch('add_layer', { kind: 'color', track: aRoll, t_start_us: 0, t_end_us: 1_000_000 })
    return r.ok ? (r.value as string) : ''
  }
  return { actor, addColor }
}

describe('actor checkpoint surface', () => {
  it('checkpoint returns an id that appears in the projected list shape', () => {
    // (The exact id-burn count is corpus-gated in Task 2 via the trailing-op
    // technique; this test pins the return value + the {id,label,created_at} shape.)
    const { actor } = setup()
    const cp = actor.checkpoint('cp1')
    expect(actor.listCheckpoints()).toEqual([{ id: cp, label: 'cp1', created_at: '<TS>' }])
  })

  it('restore reverts state to the checkpoint snapshot', () => {
    const { actor, addColor } = setup()
    addColor()
    const cp = actor.checkpoint('cp1')
    const snapAtCp = JSON.stringify(actor.snapshot())
    addColor() // diverge
    expect(JSON.stringify(actor.snapshot())).not.toBe(snapAtCp)
    actor.restoreCheckpoint(cp)
    expect(JSON.stringify(actor.snapshot())).toBe(snapAtCp)
  })

  it('restore of an unknown checkpoint throws CheckpointNotFound', () => {
    const { actor } = setup()
    expect(() => actor.restoreCheckpoint('00000000-0000-0000-0000-0000000000ee')).toThrow(/CheckpointNotFound/)
  })

  it('restore while history is locked throws HistoryLocked (before the presence check)', () => {
    const { actor } = setup()
    const cp = actor.checkpoint('cp1')
    actor.lockHistory('agent batch')
    expect(() => actor.restoreCheckpoint(cp)).toThrow(/HistoryLocked/)
  })
})
```

(Note: `CommandFailure.message` carries the variant tag; if `.toThrow(/CheckpointNotFound/)` fails because the message is shaped differently, wrap in `try/catch` and assert `e.err.error === 'CheckpointNotFound'` — check `errors.ts` `CommandFailure` and adjust.)

- [ ] **Step 6: Run the test + state suite + typecheck.**

```bash
cd apps/desktop && npx vitest run src/main/state/__tests__/checkpoint.actor.test.ts && npx vitest run src/main/state && npx tsc -b
```
Expected: all green. `tsc -b` proves the new `ActorHandle` methods type-check end to end.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/canonical.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/__tests__/checkpoint.actor.test.ts
git commit -m "feat(state-migration): actor checkpoint surface + hasCheckpoint + started_at canonical (Phase 3d-c)"
```

---

### Task 2: `checkpoint` + `list_checkpoints` mcpCall arms + harness checkpoint-id capture + gate

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`mcpCall` switch — add `checkpoint`/`list_checkpoints` arms)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`MCP_TOOLS` += `checkpoint`/`list_checkpoints`)
- Modify: `apps/desktop/native/src/bin/mcp_driver.rs` (`extract_ref_id` += `checkpoint`)
- Modify: `apps/desktop/src/main/state/replay.ts` (`mcpRefId` += `checkpoint`)
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/checkpoint-list.json` (+ generated oracle)
- Test: `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` (reused)

**Interfaces:**
- Consumes: `checkpoint`/`listCheckpoints` closures (Task 1), `toolText`/`toolJson`/`toolEmpty` (mcp-commands).
- Produces: `mcpCall` arms for `checkpoint`/`list_checkpoints`; the `checkpoint` `@ref` capture in both drivers.

- [ ] **Step 1: Add the `checkpoint` + `list_checkpoints` arms** in `actor.ts` `mcpCall`'s `switch (name)` block, after the `unlock_history` arm (line 642):

```typescript
        case 'checkpoint': {
          const label = ((a.label as string | undefined) ?? '').trim()
          if (label === '') return { ok: false, error: { code: 'invalid_params', message: 'label must be non-empty' } }
          return { ok: true, result: toolText(checkpoint(label)) }
        }
        case 'list_checkpoints': return { ok: true, result: toolJson(listCheckpoints()) }
```

(`toolText`/`toolJson`/`toolEmpty` are already imported in actor.ts from 3d-a/3d-b. `checkpoint`/`listCheckpoints` are the Task-1 closures, in scope.)

- [ ] **Step 2: Add the two tools to `MCP_TOOLS`** in `mcp-commands.ts` (after the Phase 3d-b block, before the closing `])`, line 168):

```typescript
  // Phase 3d-c: checkpoints + agent session
  'checkpoint', 'list_checkpoints',
```

- [ ] **Step 3: Add the `checkpoint` capture to `mcp_driver.rs`.**

In `apps/desktop/native/src/bin/mcp_driver.rs` `extract_ref_id` (line 85), add `checkpoint` to the raw-text match arm:

```rust
        "add_track" | "add_color_layer" | "duplicate_layer" | "groups_create"
        | "add_effect" | "add_marker" | "checkpoint" => Some(text.to_string()),
```

- [ ] **Step 4: Add the symmetric `checkpoint` capture to `replay.ts`.**

In `apps/desktop/src/main/state/replay.ts` `mcpRefId` (line 230), add `'checkpoint'` to the raw-text list:

```typescript
  if (['add_track', 'add_color_layer', 'duplicate_layer', 'groups_create', 'add_effect', 'add_marker', 'checkpoint'].includes(op)) return text
```

- [ ] **Step 5: Write the `checkpoint-list` sequence.** `apps/desktop/fixtures/state-corpus/sequences-mcp/checkpoint-list.json`:

```json
{ "name": "checkpoint-list", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 255, "g": 0, "b": 0, "a": 255 }, "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "checkpoint", "label": "first cut", "ref": "CP" },
  { "op": "list_checkpoints" },
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 0, "g": 255, "b": 0, "a": 255 }, "t_start_us": 2000000, "t_end_us": 3000000 }
]}
```

This gates: `checkpoint`'s raw-uuid `text` result + the `@ref` capture; `list_checkpoints`'s `[{id,label,created_at}]` JSON (sorted keys, `created_at` → `<TS>`); and the 1-id burn — the trailing `add_color_layer`'s layer id is revealed in `state`, so a wrong checkpoint id-count would shift it and fail the gate.

- [ ] **Step 6: Regenerate and gate.**

```bash
cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts
```
Expected: prints `ok  mcp/checkpoint-list.json`; the gate passes. **If `state` diverges** at the trailing layer, the checkpoint id-count is wrong — confirm `checkpoint()` mints exactly one `idGen()` and does NOT commit/broadcast. **If `list_checkpoints` `env.result` diverges**, compare the `[{id,label,created_at}]` shape — `created_at` must canonicalize to `<TS>` and keys must be alpha-sorted via `toolJson`.

- [ ] **Step 7: Confirm additivity, run state suite + typecheck, commit.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor && git status --short apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod
```
Expected: empty (no pre-existing oracle modified; only NEW `oracle-mcp/checkpoint-list.json`). Then:
```bash
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/native/src/bin/mcp_driver.rs apps/desktop/src/main/state/replay.ts apps/desktop/fixtures/state-corpus/sequences-mcp/checkpoint-list.json apps/desktop/fixtures/state-corpus/oracle-mcp/checkpoint-list.json
git commit -m "feat(state-migration): MCP checkpoint + list_checkpoints + checkpoint-id capture, gated (Phase 3d-c)"
```

---

### Task 3: `restore_checkpoint` mcpCall arm + round-trip / not-found / locked corpus + gate

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`mcpCall` switch — add `restore_checkpoint` arm)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`MCP_TOOLS` += `restore_checkpoint`)
- Create sequences: `restore-checkpoint.json`, `err-restore-not-found.json`, `err-restore-history-locked.json` (+ generated oracles)
- Test: `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` (reused)

**Interfaces:**
- Consumes: `restoreCheckpoint` closure (Task 1), `parseUuid`/`toolEmpty`/`mapCommandError` (mcp-commands), the outer `mcpCall` catch (maps thrown `CommandFailure`).
- Produces: `mcpCall` arm for `restore_checkpoint`.

- [ ] **Step 1: Add the `restore_checkpoint` arm** in `actor.ts` `mcpCall`, after the `list_checkpoints` arm (Task 2):

```typescript
        case 'restore_checkpoint': {
          const id = parseUuid(a.checkpoint_id, 'checkpoint_id')
          restoreCheckpoint(id) // throws CommandFailure(HistoryLocked|CheckpointNotFound) → outer catch → mapCommandError → invalid_params (no data)
          return { ok: true, result: toolEmpty() }
        }
```

(No local try/catch needed — the `mcpCall` catch at line 753 maps the thrown `CommandFailure` via `mapCommandError(e.err)`. `HistoryLocked`/`CheckpointNotFound` hit `mapCommandError`'s default → `{code:'invalid_params', message:e.error}`, no `data` — matching Rust `map_command_error`'s `invalid_params(display_string)` for both variants.)

- [ ] **Step 2: Add `restore_checkpoint` to `MCP_TOOLS`** (extend the Phase 3d-c line from Task 2):

```typescript
  // Phase 3d-c: checkpoints + agent session
  'checkpoint', 'list_checkpoints', 'restore_checkpoint',
```

- [ ] **Step 3: Write the round-trip sequence.** `apps/desktop/fixtures/state-corpus/sequences-mcp/restore-checkpoint.json`:

```json
{ "name": "restore-checkpoint", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 255, "g": 0, "b": 0, "a": 255 }, "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "checkpoint", "label": "before edits", "ref": "CP" },
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 0, "g": 0, "b": 255, "a": 255 }, "t_start_us": 2000000, "t_end_us": 3000000 },
  { "op": "restore_checkpoint", "checkpoint_id": "@CP" },
  { "op": "add_track", "label": "after restore" }
]}
```

Gates: the restore REVERTS state to the single-layer checkpoint snapshot (visible in the post-restore `state`); the 2-id burn (entry op_id + broadcast) — the trailing `add_track`'s id reveals the count; `restore_checkpoint`'s empty `{content:[]}` result.

- [ ] **Step 4: Write the not-found error sequence.** `apps/desktop/fixtures/state-corpus/sequences-mcp/err-restore-not-found.json`:

```json
{ "name": "err-restore-not-found", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 255, "g": 0, "b": 0, "a": 255 }, "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "restore_checkpoint", "checkpoint_id": "00000000-0000-0000-0000-0000000000ee" },
  { "op": "add_track", "label": "after error" }
]}
```

Gates: `CheckpointNotFound` → `invalid_params` (code, no `data`); 0-id burn — the trailing `add_track`'s id is unchanged vs a no-restore baseline (the bogus literal exists on neither engine, and the op_id is minted only after the presence check).

- [ ] **Step 5: Write the history-locked error sequence.** `apps/desktop/fixtures/state-corpus/sequences-mcp/err-restore-history-locked.json`:

```json
{ "name": "err-restore-history-locked", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 255, "g": 0, "b": 0, "a": 255 }, "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "checkpoint", "label": "before lock", "ref": "CP" },
  { "op": "lock_history", "reason": "agent batch" },
  { "op": "restore_checkpoint", "checkpoint_id": "@CP" },
  { "op": "unlock_history" },
  { "op": "add_track", "label": "after unlock" }
]}
```

Gates: `HistoryLocked` → `invalid_params` (code, no `data`); the lock-check-FIRST ordering (the lock rejects before the presence check → 0-id burn even though `@CP` is a valid checkpoint) — the trailing `add_track`'s id proves zero ids were burned by the locked restore.

- [ ] **Step 6: Regen + gate.**

```bash
cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts
```
Expected: all three new sequences pass. **Common fix points:** (a) `restore-checkpoint` — if the post-restore `state` doesn't revert, confirm `restoreCheckpoint` calls `history.restoreCheckpoint` (which swaps the snapshot) and broadcasts the restored snap; if the trailing `add_track` id is off by one, confirm the order is entry op_id THEN broadcast (2 ids). (b) `err-restore-history-locked` — if the trailing id shifts, the lock check is minting an id; confirm `lockReason()` is checked BEFORE `idGen()`.

- [ ] **Step 7: Confirm additivity, full state suite + typecheck, commit.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor && git status --short apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/fixtures/state-corpus/sequences-mcp/ apps/desktop/fixtures/state-corpus/oracle-mcp/
git commit -m "feat(state-migration): MCP restore_checkpoint + round-trip/not-found/locked corpus, gated (Phase 3d-c)"
```

---

### Task 4: `begin_agent_session` mcpCall arm + agent-session-end seam (dormant) + corpus + unit test

**Files:**
- Modify: `apps/desktop/src/main/state/actor.ts` (`mcpCall` switch — add `begin_agent_session` arm)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`MCP_TOOLS` += `begin_agent_session`)
- Modify: `apps/desktop/native/src/bin/mcp_driver.rs` (`extract_ref_id` += `begin_agent_session`)
- Modify: `apps/desktop/src/main/state/replay.ts` (`mcpRefId` += `begin_agent_session`)
- Create: `apps/desktop/src/main/state/agent-session-seam.ts`
- Create: `apps/desktop/src/main/state/__tests__/agent-session-seam.test.ts`
- Create sequences: `begin-agent-session.json`, `begin-then-restore.json`, `err-checkpoint-empty-label.json`, `err-begin-empty-reason.json` (+ generated oracles)
- Test: `apps/desktop/src/main/state/__tests__/mcp.differential.test.ts` (reused) + the new seam unit test

**Interfaces:**
- Consumes: `checkpoint` closure (Task 1), `clock` (actor closure), `toolJson`/`toolText` (mcp-commands).
- Produces: `mcpCall` arm for `begin_agent_session`; the `begin_agent_session` `@ref` capture in both drivers; `agentSessionEnd(deps: AgentSessionSeamDeps): void` + `AgentSessionSeamDeps`.

- [ ] **Step 1: Add the `begin_agent_session` arm** in `actor.ts` `mcpCall`, after the `restore_checkpoint` arm (Task 3):

```typescript
        case 'begin_agent_session': {
          const reason = ((a.reason as string | undefined) ?? '').trim()
          if (reason === '') return { ok: false, error: { code: 'invalid_params', message: 'reason must be non-empty' } }
          const checkpointId = checkpoint(`Pre-agent: ${reason}`) // 1 det id; the slot-flip + log are non-state side effects wired live in 3d-d
          return { ok: true, result: toolJson({ checkpoint_id: checkpointId, started_at: clock() }) }
        }
```

(`started_at: clock()` = `'<TS>'` in det mode; the oracle's `Utc::now().to_rfc3339()` and this both canonicalize to `<TS>` via the Task-1 `TS_FIELDS` addition. The agent-session SLOT flip + `agent_session:changed` emit are NON-project-state side effects, invisible to the gate; they are wired at the 3d-d routing flip, NOT here.)

- [ ] **Step 2: Add `begin_agent_session` to `MCP_TOOLS`** (extend the Phase 3d-c line):

```typescript
  // Phase 3d-c: checkpoints + agent session
  'checkpoint', 'list_checkpoints', 'restore_checkpoint', 'begin_agent_session',
```

- [ ] **Step 3: Add the `begin_agent_session` capture to both drivers.**

`mcp_driver.rs` `extract_ref_id` — add a new arm after the `add_video_layer` arm (line 91):

```rust
        "begin_agent_session" => {
            serde_json::from_str::<Value>(text).ok()
                .and_then(|v| v.get("checkpoint_id").and_then(Value::as_str).map(str::to_string))
        }
```

`replay.ts` `mcpRefId` — add after the `add_video_layer` block (line 233):

```typescript
  if (op === 'begin_agent_session') {
    try { const v = JSON.parse(text) as { checkpoint_id?: string }; return v.checkpoint_id ?? null } catch { return null }
  }
```

- [ ] **Step 4: Create the `agent_session_end` seam.** `apps/desktop/src/main/state/agent-session-seam.ts`:

```typescript
// The agent_session_end history-unlock seam (commands/prefs.rs:209). The
// renderer's "Exit to editor" / workspace-change / MCP-disconnect paths call
// this: clear the agent-session slot (a Rust process-global; the UI listens via
// `agent_session:changed`) AND release any `lock_history` the agent took. Under
// WEFTCUT_TS_ACTOR the authoritative history is the TS actor, so the unlock must
// hit the TS actor — not the stale Rust handle. DORMANT: 3d-d routes the
// `agent_session_end` channel here (injecting the napi slot-end + actor.unlockHistory).
export interface AgentSessionSeamDeps {
  /** Clear the Rust agent-session slot + emit `agent_session:changed`. */
  endSlot: () => void
  /** Release any revert-lock on the authoritative (TS) history. */
  unlockHistory: () => void
}

/** Mirrors prefs.rs:209 ordering: end_and_emit FIRST, then unlock_history. */
export function agentSessionEnd(deps: AgentSessionSeamDeps): void {
  deps.endSlot()
  deps.unlockHistory()
}
```

- [ ] **Step 5: Write the seam unit test.** `apps/desktop/src/main/state/__tests__/agent-session-seam.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { agentSessionEnd } from '../agent-session-seam'

describe('agentSessionEnd seam', () => {
  it('ends the slot, then unlocks history (prefs.rs:209 order)', () => {
    const calls: string[] = []
    agentSessionEnd({ endSlot: () => calls.push('end'), unlockHistory: () => calls.push('unlock') })
    expect(calls).toEqual(['end', 'unlock'])
  })
})
```

- [ ] **Step 6: Write the corpus sequences.**

`sequences-mcp/begin-agent-session.json` (checkpoint mint + envelope + list shows the Pre-agent checkpoint):
```json
{ "name": "begin-agent-session", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 255, "g": 0, "b": 0, "a": 255 }, "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "begin_agent_session", "reason": "cutting filler words" },
  { "op": "list_checkpoints" },
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 0, "g": 255, "b": 0, "a": 255 }, "t_start_us": 2000000, "t_end_us": 3000000 }
]}
```
Gates: the `{checkpoint_id, started_at}` envelope (`started_at` → `<TS>` on both sides); the `"Pre-agent: cutting filler words"` checkpoint label via `list_checkpoints`; the 1-id burn (trailing layer id).

`sequences-mcp/begin-then-restore.json` (begin's checkpoint is restorable via its `@ref`):
```json
{ "name": "begin-then-restore", "commands": [
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 255, "g": 0, "b": 0, "a": 255 }, "t_start_us": 0, "t_end_us": 1000000 },
  { "op": "begin_agent_session", "reason": "auto-cut pass", "ref": "BCP" },
  { "op": "add_color_layer", "track_id": "@A", "color": { "r": 0, "g": 0, "b": 255, "a": 255 }, "t_start_us": 2000000, "t_end_us": 3000000 },
  { "op": "restore_checkpoint", "checkpoint_id": "@BCP" },
  { "op": "add_track", "label": "after restore" }
]}
```
Gates: the `begin_agent_session` `checkpoint_id` `@ref` capture wires through to `restore_checkpoint`, which reverts to the begin-time single-layer state (begin↔restore integration).

`sequences-mcp/err-checkpoint-empty-label.json` (closes part of the 3d-a rejected-input-parity carry-forward):
```json
{ "name": "err-checkpoint-empty-label", "commands": [
  { "op": "checkpoint", "label": "" },
  { "op": "add_track", "label": "after empty-label error" }
]}
```
Gates: empty label → `invalid_params` (code, no `data`) on both engines; 0-id burn (trailing `add_track` id unchanged).

`sequences-mcp/err-begin-empty-reason.json`:
```json
{ "name": "err-begin-empty-reason", "commands": [
  { "op": "begin_agent_session", "reason": "" },
  { "op": "add_track", "label": "after empty-reason error" }
]}
```
Gates: empty reason → `invalid_params` (code, no `data`); 0-id burn (the empty check precedes any id/checkpoint).

- [ ] **Step 7: Regen + gate + seam test.**

```bash
cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts src/main/state/__tests__/agent-session-seam.test.ts
```
Expected: all four new sequences + the seam test pass. **If `begin-agent-session` `env.result` diverges**, confirm `started_at` is in `TS_FIELDS` (Task 1 Step 2) and the result is built via `toolJson` (sorted keys); the oracle's real RFC3339 `started_at` and the TS `<TS>` must both normalize to `<TS>`.

- [ ] **Step 8: Confirm additivity, full state suite + typecheck, commit.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor && git status --short apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod
cd apps/desktop && npx vitest run src/main/state && npx tsc -b
git add apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/mcp-commands.ts apps/desktop/native/src/bin/mcp_driver.rs apps/desktop/src/main/state/replay.ts apps/desktop/src/main/state/agent-session-seam.ts apps/desktop/src/main/state/__tests__/agent-session-seam.test.ts apps/desktop/fixtures/state-corpus/sequences-mcp/ apps/desktop/fixtures/state-corpus/oracle-mcp/
git commit -m "feat(state-migration): MCP begin_agent_session + agent-session-end seam (dormant), gated (Phase 3d-c)"
```

---

### Task 5: audit + corpus-README + dormancy diff + full verification

**Files:**
- Modify: `apps/desktop/fixtures/state-corpus/README.md`
- (Verification only — no code change)

**Interfaces:** none (documentation + verification).

- [ ] **Step 1: Update the corpus README mcp dimension note.**

In `apps/desktop/fixtures/state-corpus/README.md`, find the section describing the `sequences-mcp/`/`oracle-mcp/` dimension (the 3d-a/3d-b note) and append:

```markdown
- **Phase 3d-c (checkpoints + agent session):** `checkpoint-list`, `restore-checkpoint`,
  `err-restore-not-found`, `err-restore-history-locked`, `begin-agent-session`,
  `begin-then-restore`, `err-checkpoint-empty-label`, `err-begin-empty-reason`.
  - `checkpoint` mints 1 id (no op/broadcast); `restore_checkpoint` success = 2 ids
    (entry op_id then broadcast), `CheckpointNotFound`/`HistoryLocked` = 0 (lock checked
    first); `begin_agent_session` = 1 id (the log op_id is a raw now_v7, off the det
    counter). The trailing add_* op in each sequence reveals the id-burn count.
  - `begin_agent_session`'s `started_at` result field is wall-clock; normalized to `<TS>`
    via `canonical.ts` `TS_FIELDS` (no serialized Project field is named `started_at`).
  - The agent-session SLOT flip + `agent_session_end` unlock seam are NON-project-state
    (Rust process-global / HistoryView lock — not in serializeProject), so they are NOT
    corpus-gated; the seam is unit-tested (`agent-session-seam.test.ts`) and routed live
    in 3d-d. `err-checkpoint-empty-label`/`err-begin-empty-reason` close part of the 3d-a
    rejected-input-parity carry-forward (empty-string rejection, code-gated).
```

(If the README's mcp section is structured differently, match its existing format — the facts above are what must be recorded.)

- [ ] **Step 2: Verify dormancy by diff.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor
git diff --stat phase-3d-c-checkpoints~5 -- apps/desktop/src/main/index.ts apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/state/router.ts
```
Expected: EMPTY (no change to any live-wiring file — the slice is dormant). If any appears, STOP and remove it.

- [ ] **Step 3: Confirm full corpus additivity.**

```bash
git diff --diff-filter=M --name-only HEAD~5 -- apps/desktop/fixtures/state-corpus/oracle apps/desktop/fixtures/state-corpus/oracle-summary apps/desktop/fixtures/state-corpus/oracle-prod
```
Expected: EMPTY (only NEW files added to `oracle-mcp/`; no pre-existing oracle in any dimension modified).

- [ ] **Step 4: Full verification.**

```bash
cd apps/desktop
npx vitest run src/main/state   # all differentials green, skipped===[]
npx tsc -b                      # clean
```
Expected: full state suite green (all `*.differential` gates including `mcp.differential` with `skipped===[]`); typecheck clean. (Controller also runs the full Rust lib test suite `cargo test --lib --features replay,jobs,export,mcp,cloud,motifs` to confirm no Rust-side regression from the `mcp_driver` edits.)

- [ ] **Step 5: Commit.**

```bash
cd /c/Users/jonny/Desktop/learning/videtor
git add apps/desktop/fixtures/state-corpus/README.md
git commit -m "docs(state-migration): corpus README — 3d-c checkpoints + agent-session mcp coverage (Phase 3d-c)"
```

---

## Self-Review

**Spec coverage (vs `2026-06-24-…-3d-design.md` §3d-c):**
- "Expose `checkpoint`/`restoreCheckpoint`/`listCheckpoints` as actor commands" → Task 1.
- "port `begin_agent_session` (auto-checkpoint + UI flip + lockHistory)" → Task 4 ports the auto-checkpoint; the spec's "+ lockHistory" is a documented error (begin does NOT lock — Background facts); the "UI flip" (slot) is a non-state 3d-d wiring concern, documented.
- "the `agent_session_end` history-unlock seam" → Task 4 (`agent-session-seam.ts`, dormant + unit-tested).
- "Differential-gated where state-bearing" → Tasks 2-4 corpus; D2 det-id MCP differential reused; D3 dormant (no live wiring) → Task 5 dormancy diff.
- `MUTATION_TOOLS` un-pause + live routing → explicitly DEFERRED to 3d-d (Global Constraints).

**Type consistency:** `checkpoint(label:string):Uuid`, `restoreCheckpoint(id:Uuid):void`, `listCheckpoints():Array<{id;label;created_at}>` are used identically in the closures (Task 1 Step 3), the `ActorHandle` interface + literal (Task 1 Step 4), and the `mcpCall` arms (Tasks 2-4). `hasCheckpoint(id:Uuid):boolean` (Task 1 Step 1) matches its caller in `restoreCheckpoint`. `AgentSessionSeamDeps{endSlot;unlockHistory}` matches the unit test (Task 4 Steps 4-5). `MCP_TOOLS` additions accrete across Tasks 2-4 onto one Phase-3d-c comment line.

**Placeholder scan:** none — every code/step is concrete.

**Carry-forwards recorded for 3d-d:** (a) wire the live routing flip + `MUTATION_TOOLS` un-pause for these 4 tools; (b) wire the `begin_agent_session` slot-flip (a napi call after `mcpCall` returns) + route `agent_session_end` → `agentSessionEnd({endSlot: <napi>, unlockHistory: actor.unlockHistory})`; (c) `list_checkpoints` is a READ tool — re-point it to the TS actor in the 3d-d read-repoint set (the dormant adapter is gated, but the live read path is stale-Rust until 3d-d).
