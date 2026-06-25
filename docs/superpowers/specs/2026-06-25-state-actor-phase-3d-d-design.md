# State-actor TS migration — Phase 3d-d design (live MCP flip + read-mirror + un-pause)

Date: 2026-06-25. Status: brainstormed + approved.
Predecessor: Phase 3d-c — the MCP checkpoint/agent-session tools were ported onto the
TS actor as **dormant, differential-gated** `actor.mcpCall` arms (HEAD `8a1ac12d`).
3d-a/3d-b/3d-c together built the full pure-state MCP category-A surface
(`actor.mcpCall`, `mcp-commands.ts`, the `mcp.differential` gate) but wired **nothing**
live: `server.ts`/`router.ts`/`mutationTools.ts` are byte-untouched and the MCP
mutation pause (`isPausedUnderTsActor`) still rejects every category-A tool under the
flag.

3d-d is **the live MCP flip**: it makes the MCP tool surface work against the TS state
actor under `WEFTCUT_TS_ACTOR`, lifts the mutation pause, and re-points reads off the
now-stale Rust actor — the MCP analogue of the 3c-ii-d renderer flip.

## Goal

Under `WEFTCUT_TS_ACTOR`, external MCP agents mutate and read project state through the
TS actor exactly as they do today against Rust — byte-identical results, errors matching
in `code` + structured `data` + variant (prose `message` reasonable-but-not-asserted, per
the 3d error-gating refinement) — and the blanket mutation pause is removed.

## Two decisions taken in this brainstorm

- **D1 — Reads served via a READ-MIRROR seam, not by porting per-resource view-builders
  to TS.** The TS host pushes its serialized project into a Rust read-mirror; the Rust
  read paths (`read_resource`, read-tool handlers, and the downstream native-compute
  paths) resolve their project snapshot from the mirror. `server.ts`'s read paths
  (`mcpReadResource`, the native read tools) stay 100% on Rust and serve byte-identical
  results for free — including the compute-bearing reads (`project://compiled`
  audio-mix-plan, `media://*` binary, `detect_silences`, `transcribe_clip`) that cannot
  be ported to TS cheaply. **This also fixes the *read* side of the post-flip-audit
  findings F1–F7 (3d-e) at no extra cost**, collapsing 3d-e to its write-back seams +
  un-block. Cost/consequence: the Rust actor goes from "frozen at blank init" (3c-ii-d
  mental model) to a **TS-fed read-replica**. Writes still never reach it from
  MCP/renderer (routed to TS or rejected), so the single-writer-of-authority invariant
  holds; the Phase-4 "Rust has no project" story becomes "Rust's only project is the
  TS-fed read-mirror," which 3d-e/Phase-4 already require.

- **D2 — All four hybrid WRITES are deferred to 3d-e.** `apply_subtitles`,
  `import_media`, `synthesize_speech`, and `install_motif` (update-mode rebind) all need
  the same new seam — "Rust compute → returns data → TS state write" — which 3d-e builds
  once, alongside the renderer F1–F7 write fixes. 3d-d keeps them rejected under the
  flag. Consequence: during the soak, MCP agents can edit and read freely but cannot
  import media, synthesize speech, apply subtitles, or install motifs.

These supersede the literal 3d-d sketch in the Phase-3d design spec
(`2026-06-24-state-actor-phase-3d-design.md`, lines 221–230), which predated the
post-flip native-compute audit and listed `detect_silences`/`transcribe_clip`/
`project://compiled`/`apply_subtitles`/`import_media`/`synthesize_speech` under 3d-d.
The audit (same doc, §"Post-flip audit", lines 232+) had already begun pulling
native-compute into 3d-e; D1/D2 complete that reorganization.

## Scope

**IN (3d-d):**
1. Pre-flight gates (close the 3d-a/3d-b/3d-c rejected-input + unchecked-cast debts).
2. The read-mirror seam (napi setter + Rust read paths consult the mirror + TS host sync).
3. The live MCP routing flip in `server.ts` (mutations → TS `mcpCall`; reads → Rust
   mirror-backed; hybrids/Phase-4 tools → reject).
4. `MUTATION_TOOLS` un-pause, re-partitioned into a narrower blocked set.
5. Agent-session slot-flip + `agent_session_end` seam wiring.
6. Widen the renderer `HistoryView.checkpoints` with `actor`.

**OUT → Phase 3d-e:** the 4 hybrid writes + renderer F1–F7 *write* fixes (their reads
are already mirror-fixed here) + un-block + the architectural "no Rust channel reads the
authoritative actor" gate.

**OUT → Phase 4:** `add_motif`, `project_restore_checkpoint` (stay blocked under the flag).

---

## Topology recap (verified vs code, HEAD `8a1ac12d`)

- `server.ts` `CallTool` → `isPausedUnderTsActor(name)` throws `-32600` under the flag,
  else `backend.mcpCallTool(name, argsJson)` (Rust `dispatch_tool`). Reads →
  `backend.mcpReadResource(uri)`. `unwrap()` maps the `{ok,result|error}` envelope's
  snake_case `code` to JSON-RPC numbers via `CODE_MAP`.
- `actor.mcpCall(name, argsJson) → McpCallResult` (`actor.ts:624`, signature
  `actor.ts:75`) returns the same `{ok:true,result:ToolResultJson}` /
  `{ok:false,error:McpToolErrorJson}` envelope shape `server.ts` already unwraps.
  Covers the ~46 pure-state mutation tools + the ported reads `get_param_track`/
  `list_checkpoints`/`dry_run`. Set = `MCP_TOOLS` (`mcp-commands.ts:156`).
- `mutationTools.ts`: `MUTATION_TOOLS` (the blanket pause set) + `isPausedUnderTsActor`.
- `router.ts`: `routeChannel` (renderer channels) + `BLOCKED_UNDER_FLAG`
  (`add_motif`, `project_restore_checkpoint`).
- `ts-actor-host.ts`: `createTsActorHost` → `{ actor, handleInvoke, start, stop }`;
  `emitChange` already fans `project:changed` to renderer + `mcpNotify`. `actor` exposes
  `mcpCall`, `snapshot`, `historyStatus`, `subscribe`.
- `index.ts`: `tsHost` is module-scoped (`:37`), constructed under the flag (`:246`),
  `tsHost.start()` (`:255`), `setTsDerivativeAuthority(true)` (`:257`). The MCP host is
  started at `:191` (`startMcpHost(backend)`), BEFORE `tsHost` exists.
- `resources.rs`: `read_resource(b, uri)` does `b.project()?.snapshot().await` (`:66`)
  then serde-serializes per-URI (`project://current|composition|media|tracks|markers|
  history|compiled|layers/{id}`, `media://*`, `composition://meter`, `motifs://current`).
- Compute-bearing read tools (`tools.rs`): `detect_silences` (`:489`) and
  `transcribe_clip` (`:2585`) both read `b.project()?.snapshot()` to resolve a layer's
  source window before cache/cloud compute.
- `agent-session-seam.ts`: `agentSessionEnd({ endSlot, unlockHistory })` (dormant; mirrors
  `commands/prefs.rs:209` ordering: end-slot FIRST, then unlock).

---

## A. Pre-flight gates (land FIRST — before any un-pause)

Until these close, malformed MCP input from an agent crashes or diverges (passes garbage
through / throws an uncaught `TypeError`) instead of returning a clean `invalid_params`,
which Rust does today. They are the "gate before flip" debts recorded across 3d-a/b/c.

- **3d-b unchecked casts:** `actor.mcpCall` arms cast `a.interp as Interpolation`
  (`set_keyframe`, `set_keyframe_easing`) and `a.track as Animated<number>`
  (`set_param_track`) with no validation. Rust validates via `serde_json::from_value`
  → `invalid_params`. Add shape validation (a small `parseInterp`/`parseAnimatedF64`
  in `mcp-commands.ts`) + rejected-input corpus seqs that drive the bad input through
  `mcp_driver` (Rust rejects) and assert the TS adapter matches `code`.
- **3d-a rejected-input parity:** empty-`reason` `lock_history` and invalid `role`
  strings (`set_role_gain`/`set_role_flags`) are TS pass-through but Rust-rejects. Add
  TS guards matching Rust's reject + corpus seqs.
- **3d-c:** empty-label `checkpoint` / empty-reason `begin_agent_session` are already
  gated (`err-checkpoint-empty-label`/`err-begin-empty-reason`). Confirm no remainder.

## B. Read-mirror seam

- **napi `Backend::set_project_mirror(project_json: String)`** (NOT feature-gated):
  parse the TS-serialized `Project` into a `read_mirror: Mutex<Option<Project>>` field on
  `Backend`. Under TS authority the Rust read paths resolve their snapshot from the mirror
  instead of the frozen actor — preferred shape: a `Backend` accessor
  `project_snapshot_for_read()` that returns the mirror when present, else
  `self.project()?.snapshot()`, and is called by `read_resource`, `detect_silences`,
  `transcribe_clip`, and (in 3d-e) the F1–F7 compute paths. The mirror is set only from
  TS; it is never mutated by Rust handlers. `read_resource`'s `project://history` reads
  `b.project()?.history_view()` — under the flag the renderer `HistoryView` is the TS
  source of truth, so `project://history` should also resolve from a mirror-supplied
  history view (smallest change: include the serialized history view in the mirror push,
  or route `project://history` through `tsHost`; decided in the plan).
- **TS host sync:** in `createTsActorHost`'s `emitChange` (the existing `project:changed`
  subscription), additionally push `serializeProjectToJson(actor.snapshot())` →
  `napi.setProjectMirror(json)`. Push once at flip bring-up (after `tsHost.start()`).
  Always-fresh: every mutation flows through TS first, so the mirror is current before any
  subsequent read. (Fallback if push-on-change is racy: lazy push-before-each-read in
  `server.ts`/the resource handler.)
- **Net effect:** all Rust reads serve fresh state with zero per-resource TS porting;
  `project://compiled`/`media://*`/`detect_silences`/`transcribe_clip` keep their Rust
  compute but over fresh input; and audit F1–F7's *reads* are fixed for free.

## C. Live routing flip — `server.ts` CallTool, under the flag

Re-partition the current blanket pause into three routes. `server.ts` gains access to
`tsHost` (inject the host — or an `mcpCall` callback — via `buildMcpServer`, or a
module getter; `tsHost` is constructed after `startMcpHost`, so the injection must be a
late-bound reference, not a value captured at host-build time).

- **TS-adapter set** = `MCP_TOOLS` (the ~46 mutations + ported reads
  `get_param_track`/`list_checkpoints`/`dry_run`) → `tsHost.actor.mcpCall(name,
  JSON.stringify(args))`. The returned envelope is byte-identical to Rust's `reply()`, so
  `server.ts`'s `unwrap()`/`CODE_MAP` are unchanged.
- **Blocked-under-flag set** → reject `-32600` (`invalid_request`): the 4 hybrid writes
  (`apply_subtitles`, `import_media`, `synthesize_speech`, `install_motif`) +
  `acknowledge_motif_staleness`/`motif_staleness_report` (native motif, audit F7) +
  `add_motif` + `project_restore_checkpoint` (Phase 4).
- **Everything else** (`groups_list`, `groups_get`, `ping`, `list_motifs`,
  `get_motif_source`, `preview_motif_draft`, and `mcpReadResource` resources) → Rust,
  **mirror-backed → fresh**. (`groups_list`/`groups_get` are thereby re-pointed to fresh
  TS state without a TS port — the mirror serves them.)

`mutationTools.ts`: replace the blanket `isPausedUnderTsActor` with a narrower
`isBlockedUnderTsActor` over the blocked set; keep the function flag-gated (dormant when
the flag is off). `MUTATION_TOOLS` itself can stay as documentation of the historical
pause set, or be repurposed; the plan decides.

## D. Agent-session lifecycle wiring

`begin_agent_session`'s `mcpCall` arm already mints the auto-checkpoint (state, 3d-c);
the **slot flip** (a Rust process-global the UI watches via `agent_session:changed`) is a
non-state side effect the host must drive. After a successful `begin_agent_session`
`mcpCall`, the host calls a small napi `begin_agent_session_slot(reason, checkpoint_id)`
(set slot + emit `agent_session:changed` + log; the checkpoint is already minted TS-side).
Route the existing `agent_session_end` channel (renderer/napi, not MCP) → the dormant
`agentSessionEnd({ endSlot: napi.endAgentSessionSlot, unlockHistory:
actor.unlockHistory })` seam. Verify against `commands/prefs.rs:209` that the Rust
`begin_agent_session` handler's non-state work is exactly slot-set + emit + log (the
3d-c correction established it does NOT lock history — `lock_history` is separate).

## E. Widen `view().checkpoints` with `actor`

The renderer `HistoryView.checkpoints` (`history.ts:22` type, `:172` projection) omits
`actor` vs Rust `NamedCheckpointSummary` (`{id,label,actor,created_at}`). Under the flag
the renderer `HistoryView` is produced by the TS actor (the plan confirms the exact
channel — `buildProjectSummary` and/or a distinct `historyView` IPC), so the history
panel would silently drop checkpoint authorship. Add `actor` to the TS
`HistoryView.checkpoints` type + `view()` projection. (The MCP `list_checkpoints` arm
already returns the 4-field shape incl. `actor` — 3d-c.)

---

## Gating / definition of done

- **Pre-flight:** validation unit tests + rejected-input corpus seqs; `mcp.differential`
  green with the new seqs (`skipped===[]`).
- **All prior differential gates** (`differential.phase2`, `summary.differential`,
  `persistence.differential`, `commands.differential`, `mcp.differential`) stay green.
- **Read-mirror:** a round-trip identity test (TS-serialize → Rust `set_project_mirror`
  → Rust read serialize ≡ TS, reusing the `persistence.differential` machinery / a Rust
  unit test) + an integration assertion that under the flag a `project://current` read
  reflects a preceding TS mutation.
- **Live flip e2e** (extend `e2e/electron/ts-actor-flip.spec.ts` or a new MCP spec):
  under the flag, drive MCP through the host — mutate (`add_color_layer`) → read
  `project://current` → see the new layer; a blocked hybrid (`import_media`) rejects;
  the renderer `project_summary` agrees.
- **Router / architectural test:** no mutation tool routes to Rust under the flag; the
  blocked set rejects. (Foundation for 3d-e's "no Rust channel reads the *authoritative*
  actor" gate — distinguishing the read-mirror from the authority.)
- Rust lib tests pass; `tsc -b` clean; corpus additivity proven
  (`git diff --diff-filter=M fixtures/state-corpus` = ∅); final opus whole-branch review
  READY-TO-MERGE with zero Critical/Important. Build/regen/cargo/e2e are controller-run
  with the verified toolchain env (`FFMPEG_DIR`=`…Gyan.FFmpeg.Shared…/
  ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`,
  `PATH+=$FFMPEG_DIR/bin`; build `--features replay,jobs,export,mcp,cloud,motifs`).

## Carry-forwards

- **3d-e:** the hybrid-write seam (Rust-compute → TS-write) for `apply_subtitles`/
  `import_media`/`synthesize_speech`/`install_motif` + the renderer F1–F7 *write* fixes
  (`ensure_full_proxy`'s direct `set_media_derivatives` → the 3c-ii-c event seam;
  `import_media`'s `add_media_item` → TS write-back) + un-block these + the durable
  architectural gate. **3d-e's read side is already done here (the mirror).**
- **Phase 4:** un-block `add_motif`/`project_restore_checkpoint`; delete the Rust state
  actor — the read-mirror becomes Rust's sole project input for the kept compute arms.

## Constraints (carried)

- wasm eval leaf is sacred; keep `snap.ts`/`renderer/eval` pure (engine-source-drift,
  snap-math-drift goldens). The flip already `await initEval()` once at bring-up (3c-ii-d).
- `TimeUs = number` is safe; preference patches stay unrecorded.
- Evergreen docs: this spec/plan is a dated snapshot; design docs in `docs/` stay
  date/phase-free.
- The flip flag `WEFTCUT_TS_ACTOR` stays default-OFF; flipping to default-on is the
  user's call after a manual soak — and now also gated on Phase 3d-e (native-compute
  re-point) per the post-flip audit.
