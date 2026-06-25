# Phase 3d-d — Live MCP flip + read-mirror + un-pause — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `WEFTCUT_TS_ACTOR`, make the MCP tool surface authoritative against the TS state actor — mutations route to `actor.mcpCall`, reads are served fresh via a Rust read-mirror fed by the TS host, and the blanket mutation pause is lifted — leaving 4 native-compute hybrid writes blocked for Phase 3d-e.

**Architecture:** The dormant `actor.mcpCall` adapter (3d-a/b/c) is flipped live in `server.ts` behind the flag; a new `read_mirror` slot on the Rust `Backend` (set by the TS host on every change) makes all Rust read paths serve TS state with zero per-resource porting; agent-session slot lifecycle + history-view authorship are wired to the TS actor.

**Tech Stack:** TypeScript (Electron main, vitest), Rust (napi-rs `Backend`, `dispatch_tool`, `mcp_driver` det-id differential), Playwright `_electron` e2e, `@modelcontextprotocol/sdk`.

## Global Constraints

- The flip flag is `WEFTCUT_TS_ACTOR` (default OFF). Flag-off behavior MUST be byte-for-byte unchanged: every new code path is gated on the flag (or on `tsHost`/mirror presence, which is null/None flag-off).
- Error gating: the MCP differential asserts error `code` + structured `data` only; the prose `message` is NOT asserted (`mcp.differential.test.ts` `errKey` = `{code, data}`). Reproduce `code` exactly; messages may be reasonable-but-different.
- Corpus additivity: pre-existing oracle dirs (`oracle`, `oracle-summary`, `oracle-prod`, and the existing `oracle-mcp` files) MUST stay byte-identical — `git diff --diff-filter=M fixtures/state-corpus` is empty after any regen. New seqs add files only.
- Oracle regen is CONTROLLER-run with the verified toolchain env: `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…/ffmpeg-8.1.1-full_build-shared>`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH+=$FFMPEG_DIR/bin`; via `node scripts/gen-state-oracle.mjs` (builds `--features replay,jobs,export,mcp,cloud,motifs`). Per-task reviewers do NOT run `tsc`/`cargo` (vitest uses esbuild) — the controller verifies `tsc -b` + `cargo test` (3c-i lesson).
- napi bindings (`native/index.d.ts`) are GITIGNORED (`apps/desktop/.gitignore:1-4`); the controller regenerates them via `npm run napi:build` (features `jobs,export,mcp,cloud,motifs`) so new `#[napi]` methods are callable from TS. Not committed.
- Commit convention: `<type>(state-migration): … (Phase 3d-d)`; every commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- wasm eval leaf stays pure (`snap.ts`/`renderer/eval`; engine-source-drift, snap-math-drift goldens). The flip already `await initEval()` once at bring-up (3c-ii-d) — do not duplicate.
- Working tree: local `main`, NOT pushed. Stage by explicit path; re-check `git status` before each commit (concurrent sessions edit this checkout).

**Verified code anchors (HEAD `8a1ac12d`):**
- `actor.mcpCall(name, argsJson): McpCallResult` — `src/main/state/actor.ts:624`; returns `{ok:true,result:ToolResultJson}` / `{ok:false,error:McpToolErrorJson}` (`mcp-commands.ts:12`).
- MCP arg parsers/shapers + `MCP_TOOLS` set — `src/main/state/mcp-commands.ts` (`MCP_TOOLS` at :156).
- `server.ts` CallTool → `isPausedUnderTsActor` (`:51`) then `backend.mcpCallTool` (`:77`); `unwrap(json)` (`:29`) + `CODE_MAP` (`:22`).
- `mutationTools.ts` — `MUTATION_TOOLS` + `isPausedUnderTsActor`.
- `router.ts` `routeChannel` + `BLOCKED_UNDER_FLAG`; `router.test.ts`.
- `ts-actor-host.ts` `createTsActorHost` → `{actor, handleInvoke, start, stop}`; `emitChange` (`:73`); deps incl. `napi` (`:22`).
- `index.ts`: `tsHost` module-scoped (`:37`); `startMcpHost(backend)` (`:192`); tsHost construct (`:246`); napi facade `napiFacadeWithCache` (`:238`).
- Rust `Backend` struct (`napi_backend.rs:26-58`), `build_backend` (`:63-118`), `project()` (`:438`, returns `Result<&ProjectHandle,String>`), `snapshot()` → `Arc<Project>` (`state/actor.rs:873`). `#[napi]` sync ex. `set_cloud_key` (`:242`), async ex. `invoke` (`:234`), `set_ts_derivative_authority` (`:334`).
- `resources.rs read_resource` snapshot at `:66`, history_view at `:82`. `tools.rs detect_silences` snapshot at `:494`; `transcribe_clip_inner` snapshot at `:2631`.
- `agent_session.rs`: `AgentSession{client,reason,started_at}` (built `tools.rs:202`), `begin_and_emit` (`:79`), `end_and_emit` (`:91`). `commands/prefs.rs:209 agent_session_end` = `end_and_emit` + `project()?.unlock_history()` + log.
- `mcp_driver.rs` (det-id oracle, drives `dispatch_tool`); `gen-state-oracle.mjs` (regens `oracle`/`oracle-summary`/`oracle-prod`/`oracle-mcp`); `mcp.differential.test.ts` gate.
- TS types: `Interpolation` / `Animated<T>` / `Keyframe<T>` — `model.ts:16-20`.

---

## Task 1: Pre-flight gate — validate `interp` / `track` in mcpCall (close 3d-b cast debt)

The 3d-b mcpCall arms cast `a.interp as Interpolation` (`set_keyframe`/`set_keyframe_easing`) and `a.track as Animated<number>` (`set_param_track`) unchecked. Rust rejects bad values in-handler with `invalid_params` (`tools.rs:934-940`/`992-993`/`1038-1039`). Add TS validators + corpus seqs so garbage returns `invalid_params` instead of passing through / throwing.

**Files:**
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (add `parseInterp`, `parseInterpOpt`, `parseAnimatedF64`)
- Modify: `apps/desktop/src/main/state/actor.ts:690-777` (use the validators in the 3 arms)
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-interp.json`
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-track.json`
- Create (test): `apps/desktop/src/main/state/__tests__/mcp.validators.test.ts`

**Interfaces:**
- Produces: `parseInterp(v: unknown): Interpolation`, `parseInterpOpt(v: unknown): Interpolation | undefined`, `parseAnimatedF64(v: unknown): Animated<number>` — all throw `McpArgError` on malformed input. Consumed by Task 1's arms only (later tasks don't touch them).

- [ ] **Step 1: Write the failing unit test**

Create `apps/desktop/src/main/state/__tests__/mcp.validators.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseInterp, parseInterpOpt, parseAnimatedF64, McpArgError } from '../mcp-commands'

describe('parseInterp', () => {
  it('accepts the simple kinds', () => {
    for (const kind of ['Hold', 'Linear', 'EaseIn', 'EaseOut'] as const)
      expect(parseInterp({ kind })).toEqual({ kind })
  })
  it('accepts Bezier with two control points', () => {
    expect(parseInterp({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })).toEqual({ kind: 'Bezier', p1: [0.42, 0], p2: [0.58, 1] })
  })
  it('rejects an unknown kind', () => {
    expect(() => parseInterp({ kind: 'bogus' })).toThrow(McpArgError)
  })
  it('rejects Bezier with a malformed control point', () => {
    expect(() => parseInterp({ kind: 'Bezier', p1: [0.42], p2: [0.58, 1] })).toThrow(McpArgError)
  })
  it('rejects non-objects', () => {
    expect(() => parseInterp(42)).toThrow(McpArgError)
  })
})
describe('parseInterpOpt', () => {
  it('passes undefined through', () => { expect(parseInterpOpt(undefined)).toBeUndefined() })
  it('validates a present value', () => { expect(() => parseInterpOpt({ kind: 'nope' })).toThrow(McpArgError) })
})
describe('parseAnimatedF64', () => {
  it('accepts Static', () => { expect(parseAnimatedF64({ mode: 'Static', value: 1 })).toEqual({ mode: 'Static', value: 1 }) })
  it('accepts Keyframed', () => {
    const t = { mode: 'Keyframed', value: [{ id: '00000000-0000-0000-0000-000000000001', t_us: 0, value: 0, interp: { kind: 'Linear' } }] }
    expect(parseAnimatedF64(t)).toEqual(t)
  })
  it('rejects a bad mode', () => { expect(() => parseAnimatedF64({ mode: 'Bogus', value: 1 })).toThrow(McpArgError) })
  it('rejects a keyframe with a bad interp', () => {
    expect(() => parseAnimatedF64({ mode: 'Keyframed', value: [{ id: 'x', t_us: 0, value: 0, interp: { kind: 'no' } }] })).toThrow(McpArgError)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL (validators not exported)**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.validators.test.ts`
Expected: FAIL — `parseInterp is not a function` (not yet exported).

- [ ] **Step 3: Implement the validators in `mcp-commands.ts`**

Add an `Interpolation`/`Animated` import at the top (`mcp-commands.ts:6` area, next to the `CommandError` import):

```ts
import type { CommandError } from './errors'
import type { Animated, Interpolation, Keyframe } from './model'
```

Add after `parseUuid` (`mcp-commands.ts:25`):

```ts
const INTERP_SIMPLE = new Set(['Hold', 'Linear', 'EaseIn', 'EaseOut'])
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

/** Validate an Interpolation (model.ts:16) — mirrors Rust serde from_value::<Interpolation>
 *  (tools.rs:934). Throws McpArgError on malformed input → invalid_params. */
export function parseInterp(v: unknown): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid interp: not an object`)
  const o = v as Record<string, unknown>
  const kind = o.kind
  if (typeof kind !== 'string') throw new McpArgError(`invalid interp: missing 'kind'`)
  if (INTERP_SIMPLE.has(kind)) return { kind } as Interpolation
  if (kind === 'Bezier') {
    if (!isPair(o.p1) || !isPair(o.p2)) throw new McpArgError(`invalid interp: Bezier needs p1/p2 as [number, number]`)
    return { kind: 'Bezier', p1: o.p1, p2: o.p2 }
  }
  throw new McpArgError(`invalid interp: unknown kind '${kind}'`)
}

/** Optional variant: undefined passes through (set_keyframe's interp is Option). */
export function parseInterpOpt(v: unknown): Interpolation | undefined {
  return v === undefined ? undefined : parseInterp(v)
}

/** Validate an Animated<number> (model.ts:20) — mirrors Rust serde
 *  from_value::<Animated<f64>> (tools.rs:1038). Throws McpArgError → invalid_params. */
export function parseAnimatedF64(v: unknown): Animated<number> {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: not an object`)
  const o = v as Record<string, unknown>
  if (o.mode === 'Static') {
    if (typeof o.value !== 'number') throw new McpArgError(`invalid track: Static value must be a number`)
    return { mode: 'Static', value: o.value }
  }
  if (o.mode === 'Keyframed') {
    if (!Array.isArray(o.value)) throw new McpArgError(`invalid track: Keyframed value must be an array`)
    const kfs: Keyframe<number>[] = o.value.map((raw) => {
      if (raw === null || typeof raw !== 'object') throw new McpArgError(`invalid track: keyframe must be an object`)
      const k = raw as Record<string, unknown>
      if (typeof k.id !== 'string') throw new McpArgError(`invalid track: keyframe id must be a string`)
      if (typeof k.t_us !== 'number') throw new McpArgError(`invalid track: keyframe t_us must be a number`)
      if (typeof k.value !== 'number') throw new McpArgError(`invalid track: keyframe value must be a number`)
      return { id: k.id, t_us: k.t_us, value: k.value, interp: parseInterp(k.interp) }
    })
    return { mode: 'Keyframed', value: kfs }
  }
  throw new McpArgError(`invalid track: unknown mode '${String(o.mode)}'`)
}
```

- [ ] **Step 4: Run unit test — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.validators.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the validators into the three `actor.ts` arms**

In `actor.ts`, add `parseInterp, parseInterpOpt, parseAnimatedF64` to the existing `mcp-commands` import. Then:

`set_keyframe` (`actor.ts:690-699`) — replace `const interp = a.interp as Interpolation | undefined` with:
```ts
          const interp = parseInterpOpt(a.interp)
```
`set_keyframe_easing` (`actor.ts:735`) — replace `setKeyframeInterp(track, keyframeId, a.interp as Interpolation)` with:
```ts
          const next = setKeyframeInterp(track, keyframeId, parseInterp(a.interp))
```
`set_param_track` (`actor.ts:770`) — replace `const input = a.track as Animated<number>` with:
```ts
          const input = parseAnimatedF64(a.track)
```
(All three throw `McpArgError` → caught at `actor.ts:799` → `invalid_params`. The unused `Interpolation`/`Animated` type imports in actor.ts stay — they're used elsewhere.)

- [ ] **Step 6: Author the two rejected-input corpus seqs**

`fixtures/state-corpus/sequences-mcp/err-bad-interp.json`:
```json
{ "name": "err-bad-interp", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000b1", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 1000000, "t_end_us": 4000000, "src_in_us": 0, "src_out_us": 3000000, "ref": "VL" },
  { "op": "set_keyframe", "layer_id": "@VL", "param_key": "opacity", "t_us": 1000000, "value": 0.0, "interp": { "kind": "Bogus" } },
  { "op": "add_track", "label": "after bad-interp error" }
]}
```

`fixtures/state-corpus/sequences-mcp/err-bad-track.json`:
```json
{ "name": "err-bad-track", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000b1", "kind": "Video", "duration_us": 5000000, "ref": "M1" },
  { "op": "add_video_layer", "track_id": "@A", "media_id": "@M1", "t_start_us": 1000000, "t_end_us": 4000000, "src_in_us": 0, "src_out_us": 3000000, "ref": "VL" },
  { "op": "set_param_track", "layer_id": "@VL", "param_key": "opacity", "track": { "mode": "Bogus", "value": 1.0 } },
  { "op": "add_track", "label": "after bad-track error" }
]}
```
(The trailing `add_track` proves the failed op burned no id — its id reveals the counter, matching Rust.)

- [ ] **Step 7: CONTROLLER regenerates the MCP oracles**

Run (with the toolchain env): `cd apps/desktop && node scripts/gen-state-oracle.mjs`
Expected: `ok  mcp/err-bad-interp.json` + `ok  mcp/err-bad-track.json` printed; `git diff --diff-filter=M fixtures/state-corpus` is EMPTY (only the 2 new `oracle-mcp/*` + 2 new `sequences-mcp/*` are added). Confirm each new oracle's failing step has `"ok": false` with `"error": {"code": "invalid_params", …}`.

- [ ] **Step 8: Run the differential gate — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: PASS — the new seqs match (TS now returns `invalid_params`, no silent skips).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/actor.ts \
  apps/desktop/src/main/state/__tests__/mcp.validators.test.ts \
  apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-interp.json \
  apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-track.json \
  apps/desktop/fixtures/state-corpus/oracle-mcp/err-bad-interp.json \
  apps/desktop/fixtures/state-corpus/oracle-mcp/err-bad-track.json
git commit -m "fix(state-migration): validate mcpCall interp/track shape + corpus seqs (Phase 3d-d pre-flight)"
```

---

## Task 2: Pre-flight gate — validate `role` + `lock_history` reason (close 3d-a parity debt)

Rust rejects an invalid `role` at the serde boundary (`AudioRole` enum, `invalid_params`) and an empty `lock_history` reason in-handler (`tools.rs:1323-1329`, `invalid_params "reason must be non-empty"`). The TS parsers pass `a.role` through and the `lock_history` arm doesn't trim/guard. Add guards + corpus seqs.

**Files:**
- Modify: `apps/desktop/src/main/state/mcp-commands.ts` (`parseRole` + use it in `set_role_gain`/`set_role_flags` parsers)
- Modify: `apps/desktop/src/main/state/actor.ts:671` (`lock_history` arm — empty-reason guard)
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-role.json`
- Create: `apps/desktop/fixtures/state-corpus/sequences-mcp/err-lock-empty-reason.json`
- Modify (test): `apps/desktop/src/main/state/__tests__/mcp.validators.test.ts`

**Interfaces:**
- Produces: `parseRole(v: unknown): string` — returns the kebab role string, throws `McpArgError` if not one of `dialogue|music|sfx|voiceover`.

- [ ] **Step 1: Add failing tests for `parseRole`**

Append to `mcp.validators.test.ts`:
```ts
import { parseRole } from '../mcp-commands'
describe('parseRole', () => {
  it('accepts the four roles', () => {
    for (const r of ['dialogue', 'music', 'sfx', 'voiceover']) expect(parseRole(r)).toBe(r)
  })
  it('rejects an unknown role', () => { expect(() => parseRole('bogus')).toThrow(McpArgError) })
  it('rejects a non-string', () => { expect(() => parseRole(3)).toThrow(McpArgError) })
})
```

- [ ] **Step 2: Run — expect FAIL** (`parseRole is not a function`).

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.validators.test.ts`

- [ ] **Step 3: Implement `parseRole` + wire into the two role parsers**

Add to `mcp-commands.ts` (after `parseAnimatedF64`):
```ts
const AUDIO_ROLES = new Set(['dialogue', 'music', 'sfx', 'voiceover'])
/** Validate an AudioRole (audio_role.rs kebab-case). Rust rejects an unknown
 *  role at the serde boundary → invalid_params; mirror that here. */
export function parseRole(v: unknown): string {
  if (typeof v !== 'string' || !AUDIO_ROLES.has(v)) throw new McpArgError(`invalid args for set_role_gain: unknown role '${String(v)}'`)
  return v
}
```
Update the two parsers (`mcp-commands.ts:143-144`):
```ts
  set_role_gain: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: a.gain_db } }),
  set_role_flags: (a) => ({ op: 'update_role_flags', args: { role: parseRole(a.role), patch: { muted: a.muted ?? null, solo: a.solo ?? null } } }),
```

- [ ] **Step 4: Guard the empty `lock_history` reason**

In `actor.ts`, replace the `lock_history` arm (`actor.ts:671`):
```ts
        case 'lock_history': {
          const reason = ((a.reason as string | undefined) ?? '').trim()
          if (reason === '') return { ok: false, error: { code: 'invalid_params', message: 'reason must be non-empty' } }
          history.lock(reason); return { ok: true, result: toolEmpty() }
        }
```

- [ ] **Step 5: Run unit tests — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mcp.validators.test.ts`

- [ ] **Step 6: Author the two corpus seqs**

`fixtures/state-corpus/sequences-mcp/err-bad-role.json`:
```json
{ "name": "err-bad-role", "commands": [
  { "op": "set_role_gain", "role": "bogus", "gain_db": -6 },
  { "op": "add_track", "label": "after bad-role error" }
]}
```
`fixtures/state-corpus/sequences-mcp/err-lock-empty-reason.json`:
```json
{ "name": "err-lock-empty-reason", "commands": [
  { "op": "lock_history", "reason": "   " },
  { "op": "add_track", "label": "after empty-reason error" }
]}
```

- [ ] **Step 7: CONTROLLER regenerates oracles + run gate**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs && npx vitest run src/main/state/__tests__/mcp.differential.test.ts`
Expected: 2 new `ok  mcp/…`; gate PASS; `git diff --diff-filter=M fixtures/state-corpus` EMPTY. Confirm both new oracles' first step is `"ok": false`, `code: "invalid_params"`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/state/mcp-commands.ts apps/desktop/src/main/state/actor.ts \
  apps/desktop/src/main/state/__tests__/mcp.validators.test.ts \
  apps/desktop/fixtures/state-corpus/sequences-mcp/err-bad-role.json \
  apps/desktop/fixtures/state-corpus/sequences-mcp/err-lock-empty-reason.json \
  apps/desktop/fixtures/state-corpus/oracle-mcp/err-bad-role.json \
  apps/desktop/fixtures/state-corpus/oracle-mcp/err-lock-empty-reason.json
git commit -m "fix(state-migration): validate mcpCall role + lock_history reason + corpus seqs (Phase 3d-d pre-flight)"
```

---

## Task 3: Rust read-mirror — `set_project_mirror` napi + `snapshot_for_read` + re-point read sites

Add a TS-fed read-replica on `Backend`. Under the flag the TS host pushes the serialized project; the Rust read paths consult it. Mirror-present is the switch — flag-off the mirror is `None` and behavior is unchanged.

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs` (struct field, `build_backend` init, `set_project_mirror` `#[napi]`, `snapshot_for_read`/`mirror_history_view` accessors)
- Modify: `apps/desktop/native/src/mcp/resources.rs` (re-point `:66` snapshot + `:81-84` history)
- Modify: `apps/desktop/native/src/mcp/tools.rs` (re-point `detect_silences:494`, `transcribe_clip_inner:2631`)
- Modify (test): `apps/desktop/native/src/mcp/resources.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Produces (Rust): `Backend::set_project_mirror(project_json: String, history_view_json: String) -> napi::Result<()>` (JS `setProjectMirror`); `Backend::snapshot_for_read(&self) -> Result<Arc<Project>, String>`; `Backend::mirror_history_view(&self) -> Option<serde_json::Value>`. Consumed by Task 4 (TS host) + Task 6/10.

- [ ] **Step 1: Add the field + struct + init**

In `napi_backend.rs`, add a struct above `Backend` (near the other helpers):
```rust
/// A TS-fed read-replica of the project, used under WEFTCUT_TS_ACTOR so the Rust
/// read paths (resources, detect_silences, transcribe_clip, + Phase-3d-e compute)
/// serve fresh state while the Rust actor is frozen. Set only from TS; never
/// mutated by Rust handlers. `None` = flag-off → fall through to the actor.
struct ReadMirror {
    project: std::sync::Arc<crate::state::Project>,
    history_view: serde_json::Value,
}
```
Add the field to `Backend` (after `cloud_keys`, `napi_backend.rs:53`):
```rust
    /// See ReadMirror. Behind a Mutex like cloud_keys; None until the TS host pushes.
    read_mirror: std::sync::Mutex<Option<ReadMirror>>,
```
Init in `build_backend` (in the struct-literal block, `napi_backend.rs:91-117`, next to `cloud_keys`):
```rust
        read_mirror: std::sync::Mutex::new(None),
```

- [ ] **Step 2: Add the napi setter + accessors**

In the `#[napi] impl Backend` block, near `set_cloud_key` (`:242`):
```rust
    /// Replace the read-mirror with a TS-serialized project + history view.
    /// Called by the TS host on every project:changed under WEFTCUT_TS_ACTOR.
    #[napi]
    pub fn set_project_mirror(&self, project_json: String, history_view_json: String) -> napi::Result<()> {
        let project: crate::state::Project = serde_json::from_str(&project_json)
            .map_err(|e| Error::from_reason(format!("set_project_mirror: invalid project json: {e}")))?;
        let history_view: serde_json::Value = serde_json::from_str(&history_view_json)
            .map_err(|e| Error::from_reason(format!("set_project_mirror: invalid history json: {e}")))?;
        *self.read_mirror.lock().expect("read_mirror poisoned") =
            Some(ReadMirror { project: std::sync::Arc::new(project), history_view });
        Ok(())
    }
```
In the plain `impl Backend` block (where `project()` lives, `:434-440`):
```rust
    /// Project snapshot for READ-ONLY consumers (resources, detect_silences,
    /// transcribe_clip). Returns the TS read-mirror when set, else the actor.
    pub(crate) async fn snapshot_for_read(&self) -> std::result::Result<std::sync::Arc<crate::state::Project>, String> {
        if let Some(m) = self.read_mirror.lock().expect("read_mirror poisoned").as_ref() {
            return Ok(m.project.clone());
        }
        Ok(self.project()?.snapshot().await)
    }
    /// The mirrored history view (project://history under the flag), or None.
    pub(crate) fn mirror_history_view(&self) -> Option<serde_json::Value> {
        self.read_mirror.lock().expect("read_mirror poisoned").as_ref().map(|m| m.history_view.clone())
    }
```

- [ ] **Step 3: Re-point `resources.rs`**

`resources.rs:66` — replace `let snap = b.project()?.snapshot().await;` with:
```rust
    let snap = b.snapshot_for_read().await?;
```
`resources.rs` `URI_HISTORY` arm (`:81-84`) — replace:
```rust
        URI_HISTORY => {
            let view = b.project()?.history_view(HISTORY_LIMIT).await;
            serde_json::to_value(&view).map_err(serialize_err)?
        }
```
with:
```rust
        URI_HISTORY => match b.mirror_history_view() {
            Some(v) => v,
            None => serde_json::to_value(&b.project()?.history_view(HISTORY_LIMIT).await).map_err(serialize_err)?,
        },
```

- [ ] **Step 4: Re-point the two read tools**

`tools.rs:494` (`detect_silences`) — replace `let snap = b.project()?.snapshot().await;` with:
```rust
    let snap = b.snapshot_for_read().await?;
```
`tools.rs:2631` (`transcribe_clip_inner`) — same replacement.

- [ ] **Step 5: Write the Rust read-mirror test**

Add a `#[cfg(test)]` module at the bottom of `resources.rs`:
```rust
#[cfg(test)]
mod read_mirror_tests {
    use super::*;
    use crate::napi_backend::Backend;

    #[tokio::test]
    async fn read_resource_serves_the_mirror_when_set() {
        // new_for_test: see napi_backend.rs:457 for the exact constructor args.
        let b = Backend::new_for_test();
        let mut p = crate::state::Project::new_blank("mirror-test");
        let original_id = p.project_id.to_string();
        let project_json = serde_json::to_string(&p).unwrap();
        let history_json = r#"{"ops":[],"cursor":0,"len":1,"checkpoints":[]}"#.to_string();
        b.set_project_mirror(project_json, history_json).unwrap();

        let r = read_resource(&b, "project://current").await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["project_id"].as_str().unwrap(), original_id, "served the mirrored project");
    }
}
```
(If `Backend::new_for_test()` takes args, supply them per `napi_backend.rs:457`. Goal: a `Backend` with no actor init — the mirror is the sole source.)

- [ ] **Step 6: CONTROLLER builds + runs the Rust test + regenerates bindings**

Run (toolchain env): `cd apps/desktop && cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs read_mirror`
Expected: `read_resource_serves_the_mirror_when_set ... ok`. Then `npm run napi:build` (regenerate `index.d.ts` with `setProjectMirror`).

- [ ] **Step 7: CONTROLLER re-runs the full corpus regen (additivity guard)**

Run: `cd apps/desktop && node scripts/gen-state-oracle.mjs`
Expected: all `ok`; `git diff --diff-filter=M fixtures/state-corpus` EMPTY (the read-mirror re-point must not change any oracle — `mcp_driver` uses `init_for_replay`, no mirror set, so `snapshot_for_read` falls through to the actor).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/mcp/resources.rs apps/desktop/native/src/mcp/tools.rs
git commit -m "feat(state-migration): Rust read-mirror seam — set_project_mirror + snapshot_for_read re-point (Phase 3d-d)"
```

---

## Task 4: TS host pushes the read-mirror on every change

Wire `createTsActorHost` to push `serializeProjectToJson(snapshot)` + `JSON.stringify(historyView(100))` into `setProjectMirror` on each `project:changed` and once at bring-up.

**Files:**
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (deps + `emitChange` + `start`)
- Modify: `apps/desktop/src/main/index.ts:219-244` (napi facade gains `setProjectMirror`)
- Create (test): `apps/desktop/src/main/state/__tests__/mirror-push.test.ts`

**Interfaces:**
- Consumes: Task 3's `setProjectMirror(projectJson, historyViewJson)`.
- Produces: `TsActorHostDeps.setProjectMirror?: (projectJson: string, historyViewJson: string) => void`. The host calls it in `emitChange` + `start`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/state/__tests__/mirror-push.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

function makeDeps(setProjectMirror: (p: string, h: string) => void) {
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  return {
    send: () => {}, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    workspaceDir: () => null as string | null,
    setProjectMirror,
  }
}

describe('TS host read-mirror push', () => {
  it('pushes the serialized project + history view at start and on every change', () => {
    const calls: Array<{ p: string; h: string }> = []
    const host = createTsActorHost(makeDeps((p, h) => calls.push({ p, h })))
    host.start()
    expect(calls.length, 'a bring-up push').toBe(1)
    // A mutation must trigger another push reflecting the new state.
    const before = calls.length
    const track = host.actor.snapshot().tracks[0].id
    host.actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(calls.length, 'a push per change').toBe(before + 1)
    const pushed = JSON.parse(calls[calls.length - 1].p)
    const layers = pushed.tracks.reduce((n: number, t: any) => n + t.layers.length, 0)
    expect(layers, 'the pushed project reflects the new layer').toBe(1)
    const hv = JSON.parse(calls[calls.length - 1].h)
    expect(Array.isArray(hv.ops), 'history view shape').toBe(true)
    host.stop()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`setProjectMirror` not invoked).

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mirror-push.test.ts`

- [ ] **Step 3: Implement the push in `ts-actor-host.ts`**

Add to `TsActorHostDeps` (after `workspaceDir`, `:25`):
```ts
  /** Push the TS-serialized project + history view into the Rust read-mirror
   *  (backend.setProjectMirror). Optional → omitted/no-op flag-off + in tests. */
  setProjectMirror?: (projectJson: string, historyViewJson: string) => void
```
Replace `emitChange` (`:73-77`):
```ts
  function pushMirror(): void {
    if (!deps.setProjectMirror) return
    deps.setProjectMirror(serializeProjectToJson(actor.snapshot()), JSON.stringify(actor.historyView(100)))
  }

  function emitChange(e: ChangeEvent): void {
    pushMirror()
    const payload = mapChangeEvent(e)
    deps.send('project:changed', payload)
    deps.mcpNotify(payload)
  }
```
In `start()` (`:110-113`), push once at bring-up so the first read (before any mutation) is fresh:
```ts
    start() {
      if (!unsub) unsub = actor.subscribe(emitChange)
      autosave.start()
      pushMirror()
    },
```
(`serializeProjectToJson` is already imported at `ts-actor-host.ts:9`.)

- [ ] **Step 4: Run test — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/mirror-push.test.ts`

- [ ] **Step 5: Wire the napi facade in `index.ts`**

In `napiFacade` (`index.ts:219-224`) add:
```ts
      setProjectMirror: (pj: string, hv: string) => backend!.setProjectMirror(pj, hv),
```
In the `createTsActorHost({ … })` call (`index.ts:246-254`) add:
```ts
      setProjectMirror: (pj, hv) => backend!.setProjectMirror(pj, hv),
```
(The host's `deps.napi` typing — `WorkspaceNapi` — does not need `setProjectMirror`; the host uses the dedicated `deps.setProjectMirror`. Passing it via the facade object is fine since `index.ts` calls `backend.setProjectMirror` directly.)

- [ ] **Step 6: CONTROLLER typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean (`backend.setProjectMirror` resolves against the regenerated `index.d.ts` from Task 3 Step 6).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/__tests__/mirror-push.test.ts
git commit -m "feat(state-migration): TS host pushes read-mirror on every change (Phase 3d-d)"
```

---

## Task 5: `routeMcpTool` classifier + blocked set

A pure 3-way MCP-tool router (the MCP analogue of `router.ts`): mutations + ported reads → TS; native-compute hybrids + Phase-4 tools → blocked; everything else → Rust (mirror-backed).

**Files:**
- Modify: `apps/desktop/src/main/mcp/mutationTools.ts` (add `routeMcpTool` + `MCP_BLOCKED_UNDER_FLAG`)
- Create (test): `apps/desktop/src/main/mcp/mcpRouter.test.ts`

**Interfaces:**
- Consumes: `MCP_TOOLS` (`mcp-commands.ts:156`).
- Produces: `type McpRoute = 'ts' | 'rust' | 'blocked'`; `routeMcpTool(name: string): McpRoute`; `MCP_BLOCKED_UNDER_FLAG: ReadonlySet<string>`. Consumed by Task 6 (`server.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/mcp/mcpRouter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { routeMcpTool, MCP_BLOCKED_UNDER_FLAG } from './mutationTools'
import { MCP_TOOLS } from '../state/mcp-commands'

describe('routeMcpTool', () => {
  it('routes ported mutations + reads to ts', () => {
    for (const t of ['add_color_layer', 'set_keyframe', 'undo', 'get_param_track', 'list_checkpoints', 'dry_run'])
      expect(routeMcpTool(t), t).toBe('ts')
  })
  it('blocks native-compute hybrids + Phase-4 tools', () => {
    for (const t of ['apply_subtitles', 'import_media', 'synthesize_speech', 'install_motif', 'acknowledge_motif_staleness', 'motif_staleness_report', 'add_motif', 'project_restore_checkpoint'])
      expect(routeMcpTool(t), t).toBe('blocked')
  })
  it('routes reads + native-read tools to rust', () => {
    for (const t of ['groups_list', 'groups_get', 'ping', 'list_motifs', 'get_motif_source', 'preview_motif_draft', 'detect_silences', 'transcribe_clip'])
      expect(routeMcpTool(t), t).toBe('rust')
  })
  it('single-writer invariant: every TS-adapter tool routes to ts, never rust', () => {
    for (const t of MCP_TOOLS) expect(routeMcpTool(t), t).toBe('ts')
  })
  it('no blocked tool is also a TS-adapter tool', () => {
    for (const t of MCP_BLOCKED_UNDER_FLAG) expect(MCP_TOOLS.has(t), t).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`routeMcpTool` not exported).

Run: `cd apps/desktop && npx vitest run src/main/mcp/mcpRouter.test.ts`

- [ ] **Step 3: Implement in `mutationTools.ts`**

Append to `mutationTools.ts`:
```ts
import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'blocked'

/** Category-A MCP tools with NO TS path under WEFTCUT_TS_ACTOR — rejected -32600.
 *  The 4 hybrid writes (Rust-compute → TS-write) ride Phase 3d-e; the native-motif
 *  family rides 3d-e (audit F7); add_motif/project_restore_checkpoint ride Phase 4. */
export const MCP_BLOCKED_UNDER_FLAG: ReadonlySet<string> = new Set([
  'apply_subtitles', 'import_media', 'synthesize_speech', 'install_motif',
  'acknowledge_motif_staleness', 'motif_staleness_report',
  'add_motif', 'project_restore_checkpoint',
])

/** Where an MCP tool runs under the flag. ts → tsHost.actor.mcpCall; blocked →
 *  reject -32600; rust → backend (reads are mirror-backed, fresh). Blocked-first
 *  so a name can never both block and route to ts. */
export function routeMcpTool(name: string): McpRoute {
  if (MCP_BLOCKED_UNDER_FLAG.has(name)) return 'blocked'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/mcp/mcpRouter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/mcp/mcpRouter.test.ts
git commit -m "feat(state-migration): routeMcpTool classifier + blocked set (Phase 3d-d)"
```

---

## Task 6: `server.ts` live MCP routing flip + un-pause

Route CallTool through `routeMcpTool` under the flag (mutations → `actor.mcpCall`, blocked → -32600, rust → mirror-backed `backend`), removing the blanket `isPausedUnderTsActor` pause. Extract the routing into a testable `handleCallTool`.

**Files:**
- Modify: `apps/desktop/src/main/mcp/server.ts` (`unwrapEnvelope`, `handleCallTool`, `buildMcpServer(backend, getTsHost)`, drop `isPausedUnderTsActor`)
- Modify: `apps/desktop/src/main/mcp/index.ts` (`startMcpHost(backend, getTsHost)` → `buildMcpServer(backend, getTsHost)`)
- Modify: `apps/desktop/src/main/index.ts:192` (`startMcpHost(backend, () => tsHost)`)
- Modify: `apps/desktop/src/main/mcp/mutationTools.ts` (remove now-dead `isPausedUnderTsActor`)
- Modify: `apps/desktop/src/main/mcp/mutationTools.test.ts` (drop the `isPausedUnderTsActor` tests)
- Create (test): `apps/desktop/src/main/mcp/server.flip.test.ts`

**Interfaces:**
- Consumes: `routeMcpTool` (Task 5); `TsActorHost` (`ts-actor-host.ts:35`) with `.actor.mcpCall`.
- Produces: `handleCallTool(backend, getTsHost, name, args): Promise<ServerResult>`; `buildMcpServer(backend, getTsHost?)`; `startMcpHost(backend, getTsHost?)`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/desktop/src/main/mcp/server.flip.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { handleCallTool } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'flip'), idGen, clock: () => '<TS>' })
  return { actor, handleInvoke: async () => null, start: () => {}, stop: () => {}, beginAgentSessionSlot: () => {} } as any
}
function fakeBackend(mcpCallTool: (n: string, a: string) => Promise<string>) {
  return { mcpCallTool, mcpReadResource: async () => '{"ok":true,"result":{}}', mcpCatalog: async () => '{"tools":[]}' } as any
}

describe('handleCallTool flip routing', () => {
  it('routes a mutation tool to the TS actor (state changes)', async () => {
    const ts = tsHostStub()
    const track = ts.actor.snapshot().tracks[0].id
    const out: any = await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'add_color_layer', { track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 })
    expect(out.content[0].type).toBe('text') // a uuid
    const layers = ts.actor.snapshot().tracks.reduce((n: number, t: any) => n + t.layers.length, 0)
    expect(layers).toBe(1)
  })
  it('rejects a blocked tool with code -32600', async () => {
    const ts = tsHostStub()
    await expect(handleCallTool(fakeBackend(async () => '{}'), () => ts, 'import_media', { path: '/x.mp4' }))
      .rejects.toMatchObject({ code: -32600 })
  })
  it('forwards a rust-routed read to the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[{"type":"text","text":"[]"}]}}')
    await handleCallTool(fakeBackend(spy), () => ts, 'groups_list', {})
    expect(spy).toHaveBeenCalledWith('groups_list', JSON.stringify({}))
  })
  it('flag-off (no tsHost) forwards everything to the backend', async () => {
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[]}}')
    await handleCallTool(fakeBackend(spy), () => null, 'add_color_layer', {})
    expect(spy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`handleCallTool` not exported).

Run: `cd apps/desktop && npx vitest run src/main/mcp/server.flip.test.ts`

- [ ] **Step 3: Refactor `server.ts` — `unwrapEnvelope` + `handleCallTool` + flip routing**

Replace the imports + `unwrap` (`server.ts:11-12, 29-38`) and add the new functions. New top of file:
```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js'
import { captureMotifFrameB64 } from '../motif/capture.js'
import { routeMcpTool } from './mutationTools.js'
import type { TsActorHost } from '../state/ts-actor-host.js'

type Backend = import('@weftcut/core').Backend

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
}
const CODE_MAP: Record<string, number> = {
  invalid_params: -32602, invalid_request: -32600, not_found: -32601, internal: -32603,
}

/** Map a parsed {ok,result|error} envelope to the SDK result (or throw the
 *  SDK-shaped error). The TS actor.mcpCall returns this same shape as Rust's reply(). */
function unwrapEnvelope(env: Envelope): unknown {
  if (env.ok) return env.result
  const err = env.error!
  const e = new Error(err.message) as Error & { code?: number; data?: unknown }
  e.code = CODE_MAP[err.code] ?? -32603
  e.data = err.data
  throw e
}
function unwrap(json: string): unknown { return unwrapEnvelope(JSON.parse(json) as Envelope) }
```
Add the routing function (above `buildMcpServer`):
```ts
/** CallTool routing. Under the flag (tsHost present): mutations → TS actor.mcpCall,
 *  blocked → -32600, rust → backend (mirror-backed reads). Flag-off → backend. */
export async function handleCallTool(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  name: string,
  args: Record<string, unknown>,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    const route = routeMcpTool(name)
    if (route === 'blocked') {
      const e = new Error(`${name} is unavailable while the TS state actor is active (WEFTCUT_TS_ACTOR); ported in a later phase`) as Error & { code?: number }
      e.code = -32600
      throw e
    }
    if (route === 'ts') {
      return unwrapEnvelope(tsHost.actor.mcpCall(name, JSON.stringify(args))) as ServerResult
    }
    // route === 'rust' → fall through (reads are mirror-backed).
  }
  if (name === 'preview_motif_draft') {
    const a = args as { id?: string; motif_id?: string; t_sec?: number; props?: unknown; width?: number; height?: number }
    const motifId = a.id ?? a.motif_id ?? ''
    const b64 = await captureMotifFrameB64(backend, {
      motifId, tSec: a.t_sec ?? 0, propsJson: JSON.stringify(a.props ?? {}),
      width: a.width ?? 480, height: a.height ?? 480, settleRafs: null, contentHash: '',
    })
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] } as unknown as ServerResult
  }
  return unwrap(await backend.mcpCallTool(name, JSON.stringify(args))) as ServerResult
}
```
Change `buildMcpServer` signature + the CallTool handler (`server.ts:40, 50-80`):
```ts
export function buildMcpServer(backend: Backend, getTsHost: () => TsActorHost | null = () => null): Server {
  const server = new Server(
    { name: 'weftcut', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const cat = JSON.parse(await backend.mcpCatalog()) as { tools: unknown[] }
    return { tools: cat.tools } as unknown as ServerResult
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCallTool(backend, getTsHost, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  )
  // …unchanged: ListResources, ReadResource (backend.mcpReadResource — mirror-backed),
  //   ListPrompts, GetPrompt…
  return server
}
```
(Keep the ReadResource/ListResources/Prompts handlers byte-identical — reads stay on Rust, now mirror-backed.)

- [ ] **Step 4: Thread `getTsHost` through `startMcpHost` + `index.ts`**

`mcp/index.ts:27` — change the signature:
```ts
export async function startMcpHost(backend: Backend, getTsHost: () => import('../state/ts-actor-host.js').TsActorHost | null = () => null): Promise<McpHost> {
```
`mcp/index.ts:81` — `newServer = buildMcpServer(backend, getTsHost)`.
`src/main/index.ts:192` — `const mcpHost = await startMcpHost(backend, () => tsHost)`.
(`tsHost` is the module-scoped `let` at `index.ts:37`, captured by reference — set later at `:246`, available by the time any CallTool fires.)

- [ ] **Step 5: Remove the dead pause + update its test**

In `mutationTools.ts` delete `isPausedUnderTsActor` (and `MUTATION_TOOLS` if unused elsewhere — keep it only if a remaining importer needs it; `grep` first). In `mutationTools.test.ts` delete the `isPausedUnderTsActor` describe block (the routing is now covered by `mcpRouter.test.ts`).

Run: `cd apps/desktop && grep -rn "isPausedUnderTsActor\|MUTATION_TOOLS" src/` — expect no remaining references except the (now-deleted) ones; fix any.

- [ ] **Step 6: Run the integration test — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/mcp/server.flip.test.ts`

- [ ] **Step 7: CONTROLLER typecheck**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/index.ts apps/desktop/src/main/index.ts \
  apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/mcp/mutationTools.test.ts \
  apps/desktop/src/main/mcp/server.flip.test.ts
git commit -m "feat(state-migration): live MCP routing flip + un-pause (Phase 3d-d)"
```

---

## Task 7: Rust napi — agent-session slot begin/end

`begin_agent_session`'s state effect (auto-checkpoint) is done by `actor.mcpCall` (3d-c); the slot flip (`agent_session:changed`) is a non-state side effect needing napi. Add minimal slot begin/end methods.

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs` (`begin_agent_session_slot`, `end_agent_session_slot` `#[napi]`)
- Modify (test): `apps/desktop/native/src/agent_session.rs` (`#[cfg(test)]` slot+emit assertions, if not already covered)

**Interfaces:**
- Produces (Rust): `Backend::begin_agent_session_slot(reason: String)` (JS `beginAgentSessionSlot`); `Backend::end_agent_session_slot()` (JS `endAgentSessionSlot`). Consumed by Task 8.

- [ ] **Step 1: Implement the two napi methods**

In the `#[napi] impl Backend` block (near `set_ts_derivative_authority`, `:334`):
```rust
    /// Flip the agent-session slot ON (emits agent_session:changed). The
    /// auto-checkpoint is minted TS-side by actor.mcpCall; this is the slot-only
    /// side effect (agent_session.rs:79). client is always "mcp".
    #[napi]
    pub fn begin_agent_session_slot(&self, reason: String) {
        let session = crate::agent_session::AgentSession {
            client: "mcp".into(), reason, started_at: chrono::Utc::now(),
        };
        crate::agent_session::begin_and_emit(self.events.as_ref(), &self.agent_session, session);
    }
    /// Flip the agent-session slot OFF (emits agent_session:changed; agent_session.rs:91).
    /// The TS-history unlock is the caller's (the agent-session-end seam).
    #[napi]
    pub fn end_agent_session_slot(&self) {
        crate::agent_session::end_and_emit(self.events.as_ref(), &self.agent_session);
    }
```
(If `chrono::Utc` isn't already imported in `napi_backend.rs`, add `use chrono::Utc;` and write `Utc::now()`.)

- [ ] **Step 2: Write/confirm a Rust slot test**

If `agent_session.rs` lacks a begin/end-emit test, add a `#[cfg(test)]` test using a capturing `EventSink` that records emitted `(event, payload)`; assert `begin_and_emit` sets `slot.current().is_some()` + emits `agent_session:changed` non-null, and `end_and_emit` clears it + emits null. (If a test already covers `begin_and_emit`/`end_and_emit`, skip — note it in the commit.)

- [ ] **Step 3: CONTROLLER builds + tests + regenerates bindings**

Run: `cd apps/desktop && cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs agent_session && npm run napi:build`
Expected: tests pass; `index.d.ts` now has `beginAgentSessionSlot`/`endAgentSessionSlot`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/agent_session.rs
git commit -m "feat(state-migration): napi agent-session slot begin/end (Phase 3d-d)"
```

---

## Task 8: TS agent-session lifecycle wiring (begin slot + end seam)

After a TS-routed `begin_agent_session` succeeds, flip the Rust slot; route the renderer `agent_session_end` channel to the seam (slot-end + TS `unlockHistory`) instead of the stale Rust `agent_session_end` (which would unlock the frozen Rust history).

**Files:**
- Modify: `apps/desktop/src/main/state/router.ts` (new `agentSessionEnd` route)
- Modify: `apps/desktop/src/main/state/router.test.ts` (move `agent_session_end` off rust)
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (`beginAgentSessionSlot` on the host; `agentSessionEnd` handleInvoke case; napi facade deps)
- Modify: `apps/desktop/src/main/mcp/server.ts` (`handleCallTool` calls `beginAgentSessionSlot` after a successful `begin_agent_session`)
- Modify: `apps/desktop/src/main/index.ts:219-254` (facade gains `beginAgentSessionSlot`/`endAgentSessionSlot`)
- Modify (test): `apps/desktop/src/main/mcp/server.flip.test.ts` + `apps/desktop/src/main/state/__tests__/` (host end-seam test)

**Interfaces:**
- Consumes: Task 7's napi `beginAgentSessionSlot`/`endAgentSessionSlot`; `agentSessionEnd` (`agent-session-seam.ts:16`).
- Produces: `TsActorHost.beginAgentSessionSlot(reason: string): void`; `Route` gains `{ kind: 'agentSessionEnd' }`; `TsActorHostDeps` gains `beginAgentSessionSlot`/`endAgentSessionSlot`.

- [ ] **Step 1: Failing router test**

In `router.test.ts`: remove `'agent_session_end'` from the rust-list array (`:22`), and add to the "reads + persistence" test (`:9-16`):
```ts
    expect(routeChannel('agent_session_end').kind).toBe('agentSessionEnd')
```
Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts` → expect FAIL.

- [ ] **Step 2: Add the route**

`router.ts` — extend the `Route` union (`:7-13`) with `| { kind: 'agentSessionEnd' }`, and add a case in `routeChannel` (before `default`):
```ts
    case 'agent_session_end': return { kind: 'agentSessionEnd' }
```

- [ ] **Step 3: Run router test — expect PASS**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts`

- [ ] **Step 4: Wire the host**

`ts-actor-host.ts` — add to `TsActorHostDeps` (after `setProjectMirror`):
```ts
  /** Flip the Rust agent-session slot ON/OFF (backend.beginAgentSessionSlot / endAgentSessionSlot). */
  beginAgentSessionSlot?: (reason: string) => void
  endAgentSessionSlot?: () => void
```
Add to the `TsActorHost` interface (`:35-40`):
```ts
  beginAgentSessionSlot: (reason: string) => void
```
Import the seam at the top:
```ts
import { agentSessionEnd } from './agent-session-seam'
```
Add an `agentSessionEnd` case in `handleInvoke` (`:102`, before `case 'rust'`):
```ts
      case 'agentSessionEnd':
        agentSessionEnd({
          endSlot: () => deps.endAgentSessionSlot?.(),
          unlockHistory: () => actor.unlockHistory(),
        })
        return null
```
Expose `beginAgentSessionSlot` on the returned host object (`:107-118`):
```ts
    beginAgentSessionSlot(reason: string) { deps.beginAgentSessionSlot?.(reason) },
```

- [ ] **Step 5: Wire the begin-slot in `server.ts` handleCallTool**

In `handleCallTool`, in the `route === 'ts'` branch, special-case `begin_agent_session` so the slot flips after the checkpoint succeeds:
```ts
    if (route === 'ts') {
      const out = unwrapEnvelope(tsHost.actor.mcpCall(name, JSON.stringify(args)))
      if (name === 'begin_agent_session') tsHost.beginAgentSessionSlot(((args.reason as string | undefined) ?? '').trim())
      return out as ServerResult
    }
```
(mcpCall already rejected an empty reason in 3d-c, so a successful call has a non-empty reason; `unwrapEnvelope` throws before the slot flip on failure.)

- [ ] **Step 6: Wire the napi facade in `index.ts`**

In `napiFacade` (`index.ts:219-224`):
```ts
      beginAgentSessionSlot: (reason: string) => backend!.beginAgentSessionSlot(reason),
      endAgentSessionSlot: () => backend!.endAgentSessionSlot(),
```
In the `createTsActorHost({ … })` call:
```ts
      beginAgentSessionSlot: (reason) => backend!.beginAgentSessionSlot(reason),
      endAgentSessionSlot: () => backend!.endAgentSessionSlot(),
```

- [ ] **Step 7: Add host end-seam + begin-slot integration coverage**

Add a test (e.g. in `server.flip.test.ts`) that a `begin_agent_session` call invokes `tsHost.beginAgentSessionSlot` with the reason:
```ts
  it('flips the agent-session slot after a successful begin_agent_session', async () => {
    const ts = tsHostStub()
    const spy = vi.fn()
    ts.beginAgentSessionSlot = spy
    await handleCallTool(fakeBackend(async () => '{}'), () => ts, 'begin_agent_session', { reason: 'cleanup' })
    expect(spy).toHaveBeenCalledWith('cleanup')
  })
```
And a host test (new `__tests__/agent-session-end.test.ts`) that `handleInvoke('agent_session_end', {})` calls `endAgentSessionSlot` then `actor.unlockHistory` (assert via spies + that history lock is cleared).

- [ ] **Step 8: Run tests + typecheck**

Run: `cd apps/desktop && npx vitest run src/main/mcp/server.flip.test.ts src/main/state/router.test.ts src/main/state/__tests__/agent-session-end.test.ts && npx tsc -b`
Expected: all PASS, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts \
  apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/mcp/server.ts \
  apps/desktop/src/main/index.ts apps/desktop/src/main/mcp/server.flip.test.ts \
  apps/desktop/src/main/state/__tests__/agent-session-end.test.ts
git commit -m "feat(state-migration): wire agent-session slot begin + end seam to TS actor (Phase 3d-d)"
```

---

## Task 9: Widen `HistoryView.checkpoints` with `actor`

The renderer `HistoryView.checkpoints` omits `actor` vs Rust `NamedCheckpointSummary` (`{id,label,actor,created_at}`). Under the flag the TS actor produces the view, so the history panel would drop checkpoint authorship.

**Files:**
- Modify: `apps/desktop/src/main/state/history.ts:22` (type) + `:172` (projection)
- Create (test): `apps/desktop/src/main/state/__tests__/history-view-actor.test.ts`

**Interfaces:**
- Produces: `HistoryView.checkpoints: Array<{ id: Uuid; label: string; actor: Actor; created_at: string }>`.

- [ ] **Step 1: Failing test**

Create `apps/desktop/src/main/state/__tests__/history-view-actor.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { History } from '../history'
import { blankProject } from '../model'
import { uuidV7Gen } from '../ids'

describe('HistoryView checkpoints carry actor', () => {
  it('includes the checkpoint actor', () => {
    const idGen = uuidV7Gen()
    const h = new History(blankProject(idGen, 'x'), { kind: 'User' }, idGen())
    h.checkpoint('cp', { kind: 'Agent', client: 'mcp' }, idGen())
    const v = h.view(10)
    expect(v.checkpoints[0].actor).toEqual({ kind: 'Agent', client: 'mcp' })
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (type/projection missing `actor`).

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/history-view-actor.test.ts`
Expected: FAIL — `v.checkpoints[0].actor` is `undefined`.

- [ ] **Step 3: Widen the type + projection**

`history.ts:22` — change `checkpoints: Array<{ id: Uuid; label: string; created_at: string }>` to:
```ts
checkpoints: Array<{ id: Uuid; label: string; actor: Actor; created_at: string }>
```
`history.ts:172` — change the map to include `actor`:
```ts
    const checkpoints = this.listCheckpoints().map((c) => ({ id: c.id, label: c.label, actor: c.actor, created_at: c.created_at }))
```

- [ ] **Step 4: Run — expect PASS + typecheck**

Run: `cd apps/desktop && npx vitest run src/main/state/__tests__/history-view-actor.test.ts && npx tsc -b`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/__tests__/history-view-actor.test.ts
git commit -m "feat(state-migration): HistoryView checkpoints carry actor authorship (Phase 3d-d)"
```

---

## Task 10: Live MCP flip e2e + corpus docs + full verification

Prove the live MCP flip end-to-end through the real app (TS actor + Rust read-mirror), document the new corpus dimension, and run the full gate matrix.

**Files:**
- Create: `apps/desktop/e2e/electron/mcp-flip.spec.ts`
- Modify: `apps/desktop/fixtures/state-corpus/README.md` (document the 3d-d seqs + read-mirror)

**Interfaces:**
- Consumes: the live flip wired in Tasks 3–8; `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`.

- [ ] **Step 1: Write the MCP flip e2e**

Create `apps/desktop/e2e/electron/mcp-flip.spec.ts` (launches under the flag, connects a real MCP client to the host, drives a mutation + read + a blocked tool):
```ts
import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(__dirname, '../../out/main/index.js')

// Parse the `[mcp] connect: {…}` line the host logs in unpackaged runs (mcp/index.ts:123).
function parseConnect(line: string): { url: string; token: string } | null {
  const m = line.match(/\[mcp\] connect: (\{.*\})/)
  if (!m) return null
  const cfg = JSON.parse(m[1]) as { mcpServers: { weftcut: { url: string; headers: { Authorization: string } } } }
  const s = cfg.mcpServers.weftcut
  return { url: s.url, token: s.headers.Authorization.replace(/^Bearer /, '') }
}

test('WEFTCUT_TS_ACTOR flip: MCP mutate → resource read reflects it; blocked tool rejects', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mcp-flip-'))
  let connect: { url: string; token: string } | null = null
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_TS_ACTOR: '1', WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' } as Record<string, string>,
  })
  app.process().stdout!.on('data', (b: Buffer) => { const c = parseConnect(b.toString()); if (c) connect = c })
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).api?.backend?.invoke, undefined, { timeout: 30_000 })
    // New workspace (TS orchestrator) so there's a project + tracks.
    await page.evaluate(([ws]) => (window as any).api.backend.invoke('project_new_workspace', { parentFolder: ws, name: 'mcp', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }), [ws])
    // Wait for the connect log, then open an MCP client.
    await expect.poll(() => connect, { timeout: 15_000 }).not.toBeNull()
    const transport = new StreamableHTTPClientTransport(new URL(connect!.url), { requestInit: { headers: { Authorization: `Bearer ${connect!.token}` } } })
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(transport)
    try {
      // A read resource served from the Rust read-mirror (TS state).
      const before = await client.readResource({ uri: 'project://tracks' })
      const tracks = JSON.parse((before.contents[0] as { text: string }).text) as Array<{ id: string }>
      expect(tracks.length).toBeGreaterThan(0)
      // Mutate via the TS actor.mcpCall path.
      const added = await client.callTool({ name: 'add_color_layer', arguments: { track_id: tracks[0].id, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 } })
      expect((added.content as Array<{ type: string }>)[0].type).toBe('text')
      // The mirror reflects the mutation on the next read.
      const after = await client.readResource({ uri: 'project://current' })
      const proj = JSON.parse((after.contents[0] as { text: string }).text) as { tracks: Array<{ layers: unknown[] }> }
      expect(proj.tracks.reduce((n, t) => n + t.layers.length, 0)).toBe(1)
      // A blocked hybrid rejects.
      await expect(client.callTool({ name: 'import_media', arguments: { path: '/nope.mp4' } })).rejects.toThrow()
    } finally {
      await client.close()
    }
  } finally {
    await app.close()
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: CONTROLLER builds the app + runs the e2e**

Run (after a build): `cd apps/desktop && npm run build && npx playwright test e2e/electron/mcp-flip.spec.ts`
Expected: PASS. (A stale `out/` bundle mimics a code bug — rebuild first.) If the SDK client import path differs, adjust to the installed `@modelcontextprotocol/sdk` client entrypoints.

- [ ] **Step 3: Document the new corpus + read-mirror in the README**

Edit `fixtures/state-corpus/README.md` — under the MCP section, note the 4 new rejected-input seqs (`err-bad-interp`/`err-bad-track`/`err-bad-role`/`err-lock-empty-reason`, gating the 3d-a/3d-b carry-forward validators) and that 3d-d added no Rust driver arms (existing ops, bad args). Add a short "read-mirror" note: under `WEFTCUT_TS_ACTOR` the Rust read paths serve a TS-fed mirror, so MCP reads are not corpus-gated (the `mcp_driver` runs mirror-free → falls through to the actor, keeping oracles additive).

- [ ] **Step 4: CONTROLLER full verification matrix**

Run, expecting all green:
```bash
cd apps/desktop
node scripts/gen-state-oracle.mjs        # all ok; git diff --diff-filter=M fixtures/state-corpus EMPTY
npx vitest run                           # full TS suite, all differential gates skipped===[]
npx tsc -b                               # clean
cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs --lib  # Rust lib green
git status --short                       # only intended files
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/electron/mcp-flip.spec.ts apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): live MCP flip e2e + corpus README for read-mirror (Phase 3d-d)"
```

---

## Carry-forwards (record at merge)

- **Phase 3d-e:** build the single "Rust-compute → TS-write" seam for the 4 blocked hybrid writes (`apply_subtitles`/`import_media`/`synthesize_speech`/`install_motif`) + the renderer F1–F7 *write* fixes (`ensure_full_proxy` direct `set_media_derivatives` → the 3c-ii-c event seam; `import_media` `add_media_item` → TS) + un-block them in `MCP_BLOCKED_UNDER_FLAG`. **3d-e's read side is already done (the read-mirror).** Durable architectural gate: assert no `routeChannel`/`routeMcpTool` rust-routed channel reads `backend.project()` (the authoritative actor) — the mirror is exempt (TS-fed).
- **Phase 4:** un-block `add_motif`/`project_restore_checkpoint`; delete the Rust state actor — the read-mirror becomes Rust's sole project input for the kept compute arms.
- **Accepted minors (non-blocking):** `begin_agent_session_slot` does NOT re-emit the record-panel log entries the Rust handler did (`tools.rs:166-233`) — logs are not project state, not gated, low value during a single-writer soak. `project://history` under the mirror serves the TS `historyView(100)` shape (fresh, correct-shaped) but is not byte-gated vs Rust's `HistoryView` serde.
