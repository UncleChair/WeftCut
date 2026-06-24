# State-Actor TS Migration — Assessment & Implementation Plan

> **For agentic workers:** This is a MASTER plan spanning multiple subsystems. Each
> Phase below is a self-contained sub-project that produces working, testable
> software and should be expanded into its own bite-sized plan (via
> superpowers:writing-plans) before execution. REQUIRED SUB-SKILL for executing any
> expanded phase: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move WeftCut's project-state actor — the document model, mutations,
validation, and undo/redo history — from the Rust napi addon into TypeScript in the
Electron **main** process, leaving Rust as a focused media-compute library.

**Architecture:** A framework-agnostic single-writer "store" module in main owns the
immutable `Project`. UI (renderer) and MCP (main) drive it through the same command
surface, exactly as they drive the Rust actor today. The renderer relationship is
unchanged: it sends `invoke(cmd, args)` commands and receives a `project:changed`
signal, then pulls the snapshot. The cutover is gated end-to-end by a **differential
harness** that replays command sequences through both the Rust actor and the TS actor
and asserts byte-canonical-identical project state. Rust keeps ffmpeg orchestration,
the audio DSP mixer, the export pipeline, media probing, motif file resolution, and
the shared `weftcut-eval` wasm leaf.

**Tech Stack:** TypeScript, Immer (immutable state + structural sharing), Electron
main-process IPC, the existing `weftcut-eval` wasm leaf (UNCHANGED — `snap_round`,
`eval`, `db_to_linear`, `role_audible`), Vitest, the existing Rust actor (kept alive
through the migration as the differential oracle).

## Global Constraints

- **The wasm eval leaf is sacred.** `snapFrameRound`, `evalTrack`, `dbToLinear`,
  `roleAudible` (`src/renderer/eval/index.ts:57-120`) are the cross-language
  determinism guarantee, golden-locked against Rust. The TS actor MUST call
  `snapFrameRound` for frame-grid snapping at mutation time and MUST NOT reimplement
  any of these. See `feedback_engine_source_drift`, `feedback_snap_math_drift`.
- **serde wire-shape fidelity.** A `project.json` written by Rust must load in the TS
  actor and vice versa, through the entire migration (both run side by side). The
  exact tagging shapes are non-negotiable — see the Wire-Shape table in Part 2.
- **One mutation path for humans and agents.** The single most valuable property of
  today's actor: UI and MCP share one validated mutation + commit path. This MUST be
  preserved — do not fork it. This aligns with the in-flight command-surface
  unification (`commands/mutations.rs:1-13`,
  `docs/superpowers/plans/2026-06-22-pipeline-seam-abstractions.md`).
- **Evergreen docs.** Design docs (`docs/*.md`, ADRs) describe the system as if
  authored today. This dated plan lives only in `docs/superpowers/plans/` and is
  deleted once consolidated; phase history lives in git. See `feedback_evergreen_docs`.
- **TimeUs is `number`.** `TimeUs = i64` microseconds. Max safe integer (2^53 µs ≈ 285
  years) exceeds any real timeline, so plain `number` is correct — no `bigint`.
- **Frequent commits, TDD, DRY, YAGNI.** Every mutation ports test-first against the
  differential harness.

---

# Part 1 — Assessment

## 1.1 Why migrate (decision already taken)

The state actor sits in Rust by inertia, not by technical necessity:

- **It is not a hot path.** Mutations are a few KB, human-paced (one per drag/click).
  The only performance-critical path — per-frame keyframe evaluation — already lives
  in the `weftcut-eval` wasm leaf (`reference_wasm_boundary_cost`: 36ns/eval) and is
  untouched by this migration.
- **The model is already maintained twice.** `src/renderer/ipc/index.ts` (1457 lines)
  is a hand-written TS mirror of the Rust domain types, kept in sync by hand. `ts-rs`
  is a dependency but no codegen is wired up (zero `#[ts]` attributes). This is the
  documented drift-bug class (`feedback_snap_math_drift`,
  `feedback_engine_source_drift`).
- **The boundary is stringly-typed.** Every mutation crosses
  `invoke(cmd: string, argsJson: string): Promise<string>` (`native/index.d.ts:10`) —
  no compile-time safety on the highest-traffic interactions.
- **MCP transport is already TS.** The MCP host runs in main via
  `@modelcontextprotocol/sdk` (`src/main/index.ts:158-160`); only the tool *handlers*
  are Rust. Moving the actor to main-TS *consolidates* the agent path rather than
  fragmenting it.

The migration's cost is concentrated in one place — the 5,429-line Rust invariant test
suite (`state/actor/tests.rs`) — which is precisely what the differential harness (Part
3) converts from "re-derive by hand and hope" into "prove equivalence mechanically."

## 1.2 Topology: the TS actor lives in the **main** process

The Rust `Backend` (the actor's host) already loads into the Electron **main** process
(`src/main/index.ts:150-164`); `onEvent` relays `project:changed` to the renderer over
IPC; autosave, persistence, and the MCP host all live in main. Therefore:

- The TS actor **replaces the Rust actor in main**. The renderer is unchanged in
  Phase 1–3: it still calls `invoke("move_layer", …)`; main's `backend:invoke` handler
  (`src/main/index.ts:189-220`) routes project commands to the TS actor instead of
  forwarding to Rust.
- **The process firewall is preserved.** It comes from "the document model lives in
  main," not from "the model is Rust." Renderer ↔ main is still IPC commands + a
  signal.
- Renderer-as-host (zero model-IPC) is explicitly **out of scope** — it would force
  MCP→renderer proxying and break the single-window/main-owns-document assumption.
  Revisit only if profiling ever shows model-IPC is a bottleneck (it will not for a
  single project).

## 1.3 What stays in Rust (the narrowed napi boundary)

Post-migration, `native/index.d.ts` keeps only the genuinely-native surface:

| Stays in Rust | Why | Source |
|---|---|---|
| ffmpeg orchestration (import/proxy/conform/thumbnails/waveform) | native process mgmt | `jobs/` (feature `jobs`) |
| audio DSP mixer + conform + envelope | real compute; audio-master clock | `audio/` |
| export pipeline (IPC frame sink, mux, EOS-tail logic) | native streaming | `export/`, `exportVideoSinkWrite` |
| media probe (codec/pix_fmt/color tags) | ffprobe | `io/probe` |
| motif file resolution + capture duration | offscreen capture host | `motifResolveFile`, `motifCtxDurationS` |
| cloud audio extraction (ffmpeg step) | ffmpeg; HTTP layer is Tier-1, separate | `cloud/` |
| **`weftcut-eval` wasm leaf** | shared determinism, already wasm | `native/eval/` |

What moves to TS: `state/` (actor 3821 + mutations 1558 + validate 1236 + history 536
+ model ~2600 LOC), the project-state arms of the `invoke` dispatcher, the project
`commands/*` (mutations/query/history/persistence), the Rust MCP tool handlers
(`mcp/tools.rs`), and `io/autosave.rs`.

---

# Part 2 — Migration Surface Inventory

All citations are into `apps/desktop/native/src/` unless noted.

## 2.1 Command surface (the actor's public API)

~40 commands across four tiers. The TS actor must expose all of them. Source:
`state/actor.rs:452-775` (Command enum) + the `ProjectHandle` methods.

**Recorded mutations (push an undo entry):** `add_track`, `add_transient_track`,
`add_layer`, `add_caption_track`, `restyle_caption_track`, `delete_layer`,
`rebind_motif`, `delete_track`, `separate_audio_to_new_track`, `split_layer`,
`trim_layer`, `replace_state`, `add_media_item`, `update_layer`, `update_layer_params`,
`update_layer_param_track`, `update_layer_param_tracks`, `move_layer`,
`duplicate_layer`, `set_composition`, `fit_composition_to_layers`, `set_role_gain`,
`add_marker`, `update_marker`, `remove_marker`, `add_transition`, `remove_transition`,
`add_effect`, `update_effect`, `move_effect`, `remove_effect`, `groups_create`,
`groups_dissolve`, `groups_add_members`, `groups_remove_members`, `groups_rename`,
`move_track`, `remove_media`, `set_media_derivatives`.

**Unrecorded / preference-shaped (applied to ALL history snapshots, never undoable):**
`update_project_settings`, `update_track_flags`, `update_role_flags`,
`set_media_workspace_paths` (background reconciliation). Implemented via
`history.replace_*_everywhere` (`history.rs:225-311`) — a map-over-all-snapshots. See
`project_settings_patch_convention`.

**History / checkpoint meta:** `undo`, `redo`, `checkpoint`, `list_checkpoints`,
`restore_checkpoint`, `lock_history`, `unlock_history`, `snapshot`, `history_status`,
`history_view`.

**Dry-run:** `dry_run(ops: DryRunOp[]) -> Result<DryRunOutput, CommandError>[]`
(`state/actor.rs:782-833, 2288-2351`). Clones state, applies + validates each op, halts
at first error, never commits. Used by MCP to preview multi-step edits. Fresh ids each
run.

**`CommandError` variants** (`state/actor.rs:336-433`): ~30 typed errors
(`TrackNotFound`, `LayerOverlap`, `MediaInUse`, `TransitionLayersNotAdjacent`,
`GroupLockedMember`, `TrimEdgeOutOfRange`, `HistoryLocked`, `ValidationFailed(...)`, …).
The TS actor reproduces these as a discriminated union; MCP renders them via
`map_command_error` (`mcp/tools.rs:61-118`), UI flattens to string.

## 2.2 Domain model type graph

Root `Project` (`state/project.rs:24-53`), `SCHEMA_VERSION = 9` (`project.rs:22`).
Containers use `imbl` for cheap snapshot cloning; in TS these become arrays / records /
sets (structural sharing comes from Immer instead).

```
Project { schema_version, project_id: Uuid, metadata, composition: Composition,
          media_pool: HashMap<MediaId, MediaItem>, tracks: Vector<Track>,
          markers: Vector<Marker>, transitions: Vector<Transition>,
          groups: Vector<Group>, audio_roles: HashMap<AudioRole, RoleMixSettings>,
          settings: ProjectSettings }
Track  { id, label?, enabled, locked, muted, solo, removable, role?: TrackRole,
         transient, height_px, layers: Vector<Layer> }
Layer  { id, label?, t_start_us, t_end_us, enabled, locked,
         metadata: HashMap<String,Value>, params: LayerParams, effects: Vec<Effect> }
LayerParams = VideoClip | ImageOverlay | Text | Motif | Audio | Color   (tag "kind")
Animated<T> = Static(T) | Keyframed(Vector<Keyframe<T>>)                 (tag "mode"/"value")
Keyframe<T> { id, t_us, value: T, interp: Interpolation }
Transform { x,y,scale_x,scale_y,rotation_deg: Animated<f64>; anchor: (f64,f64) static }
```

Per-kind param fields, primitives (`TimeUs=i64`, `Rational{num,den}`,
`Rgba{r,g,b,a:u8}`, `ColorSpace`, `AudioRole`, all ids = `Uuid`), `MediaItem`,
`Marker`, `Transition`, `Group{members: OrdSet<LayerId>}`, `Effect{kind:String,
enabled, params: BTreeMap<String, Animated<f64>>}` — full field lists in
`state/{layer,media,marker,transition,group,effect,transform,audio_role,composition}.rs`.

**Leaky-generic landmine:** `Animated<T>` is generic but only `Animated<f64>` has eval
semantics (`animated.rs:223-252`). `Animated<Rgba>` (TextParams.color, ColorParams.color)
is **stored but never interpolated** in v1. Port the same limitation — do NOT add Rgba
eval here (that is the separate `project_keyframe_optimization` P1 work).

## 2.3 serde Wire-Shape table (MUST match exactly)

| Type | Tagging | Wire shape | Source |
|---|---|---|---|
| `LayerParams` | external on `kind` | `{"kind":"VideoClip", ...fields}` | `layer.rs:60` |
| `Animated<T>` | internal `mode`/`value` | `{"mode":"Static","value":0.5}` | `animated.rs:31` |
| `Interpolation` | external on `kind` | `{"kind":"Bezier","p1":[..],"p2":[..]}` | `weftcut-eval lib.rs:122` |
| `TransitionKind` | external on `kind` | `{"kind":"Crossfade"}` | `transition.rs:33` |
| `AudioRole` | rename_all kebab | `"voiceover"` | `audio_role.rs:14` |
| ids (all) | — | UUID string | `ids.rs:8-21` |
| `Group.members` | `OrdSet` | JSON array, **sorted** | `group.rs` |
| `Project.media_pool` / `audio_roles` | `HashMap` | object; serialize **key-sorted** for determinism | `project.rs:30,50` |
| `Effect.params` | `BTreeMap` | object, **key-sorted** | `effect.rs:20` |
| many fields | `#[serde(default)]` | omittable for back-compat | see §2.2 sources |

Determinism note: `imbl::HashMap`/`OrdSet` serialize in a stable order; TS `Map`/`Set`
do not. The TS serializer must canonicalize (sort keys / members) so saved files and
differential comparisons are stable.

## 2.4 Validation invariants (26 rules — port to `validate.ts`)

`validate(project)` (`state/validate.rs:137-148`) is a **pure, full-project, stop-at-
first-error** pass: composition → transitions → tracks/layers → groups. Per-class
overlap (visual vs audio tracked separately; different classes may coexist), transition
duration must **exactly** equal computed overlap, "longest-reaching previous layer"
logic for non-monotonic end times, group ≥2 members, global layer-id uniqueness, src-
range bounds vs optional media duration. **Out-of-range keyframes are VALID by design**
(`validate.rs:495-509`) — do not add bounds checks. No external-crate calls (no
weftcut-eval, no snap). Full 26-rule table with error variants and file:lines is
reproduced in the Phase-2 expansion; the canonical source is `state/validate.rs`.

## 2.5 Consumers (everything that must re-point at the TS actor)

| Consumer | Today | Source |
|---|---|---|
| napi `invoke` dispatcher (project arms) | string match → `commands::*` | `napi_backend.rs:235-714` |
| UI command wrappers (~82) | `invoke(cmd, args)` | `src/renderer/ipc/index.ts:423-1436` |
| Zustand store | pulls `projectSummary()` on `project:changed` | `src/renderer/state/projectStore.ts:98-129` |
| MCP tool handlers (~50+) | Rust `handle.<method>(agent_actor(), …)` | `mcp/tools.rs` |
| MCP dry_run / resources | `handle.dry_run`, `handle.snapshot` | `mcp/tools.rs:1658-1686`, `mcp/resources.rs:62-80` |
| autosave | `handle.subscribe()` → debounce → `save_to_dir` | `io/autosave.rs:75-100` |
| persistence (save/load) | `serde_json` ↔ `replace_state` | `io/mod.rs:19-56`, `commands/persistence.rs:86-89` |
| background jobs callback | `set_media_derivatives` / `set_media_workspace_paths` | `jobs/mod.rs:215-227, …` |
| change-event bridge | `project:changed` signal → renderer pull | `napi_backend.rs:143-197`, `src/main/index.ts:154-163` |

**Key seam:** the command-surface unification (`commands/mutations.rs:1-13`) is already
collapsing UI + MCP onto one `(actor: Actor) -> Result<_, CommandError>` impl. The
migration re-points that single impl at the TS actor; the MCP/UI adapters stay thin.

---

# Part 3 — The Differential Harness (the safety net)

This is the cornerstone. It replaces "re-derive 5,429 lines of invariant tests by hand"
with "mechanically prove the TS actor is behaviorally identical to the Rust actor."

## 3.1 Principle

Feed the **same command sequence** to both actors; assert the **canonicalized** project
JSON after each command is identical, and that errors match (same `CommandError`
variant). The existing `state/actor/tests.rs` corpus + golden fixtures + generated
fuzz sequences are the input.

## 3.2 Determinism prerequisites (Phase 0)

Both actors are nondeterministic in two ways that must be injected:

1. **ids** — `new_id() = Uuid::now_v7()` (`ids.rs:19-21`). Make id generation a
   dependency: Rust gains a test-mode injectable id source (a seeded sequence); the TS
   actor takes `idGen: () => string`. The same seed → the same id sequence on both
   sides. (`dry_run` already documents fresh-ids-per-run, so id-determinism is
   understood.)
2. **timestamps** — `Utc::now()` in `HistoryEntry` / `ChangeEvent`. Inject a fixed
   clock on both sides.

## 3.3 Canonicalization

A shared canonical-JSON function (recursively sort object keys, sort `Group.members`,
sort `media_pool`/`audio_roles`/`Effect.params` keys) applied to both outputs before
comparison — because `imbl` serializes ordered and TS containers do not.

## 3.4 Harness shape

```
corpus (command sequences) ──┬─► Rust replay driver  ─► canonical JSON trace (oracle)
                             └─► TS actor             ─► canonical JSON trace (candidate)
                                   assert traces equal, op-by-op; assert errors match
```

- **Rust replay driver:** a small `#[cfg(test)]` / feature-gated binary that reads a
  JSON command sequence, runs it through the real actor with injected id+clock, and
  emits the canonical JSON after each step + any `CommandError`. Reuses the existing
  test fixtures.
- **TS side:** a Vitest suite that runs the same sequences through the TS actor and
  compares against the committed oracle traces.
- **Fuzz:** a generator produces random valid-ish command sequences (weighted toward
  group/trim/split edge cases) to catch invariants the hand-written corpus misses.

This harness is built in Phase 0 and is the exit gate for every later phase.

---

# Part 4 — Phase Breakdown

Each phase ends with working, merged, testable software. Expand each into its own
bite-sized plan before execution.

## Phase 0 — Foundations & safety net (no behavior change)

**Scope:** TS canonical model types + serde-faithful (de)serialization; id+clock
injection on both sides; the differential harness; oracle traces from the existing
corpus.

**Files:**
- Create `src/main/state/model.ts` — canonical editable `Project` type + all nested
  types, matching §2.2 and the §2.3 wire shapes. (Supersedes the read-only mirror in
  `src/renderer/ipc/index.ts` over later phases; for now it is additive.)
- Create `src/main/state/serialize.ts` — `parseProject(json)` / `serializeProject(p)`
  with canonical key ordering; round-trips real `project.json`.
- Create `src/main/state/canonical.ts` — `canonicalJson(value)` shared by harness.
- Create `src/main/state/ids.ts` — `IdGen` interface + `uuidV7Gen()` (prod) +
  `seededGen(seed)` (test).
- Modify `native/src/state/ids.rs` — inject id source (test-mode seeded generator)
  behind a test feature; default unchanged.
- Create `native/src/bin/replay_driver.rs` (feature-gated) — command-sequence replay →
  canonical JSON trace.
- Create `src/main/state/__tests__/differential.test.ts` — runs oracle traces.
- Create `apps/desktop/fixtures/state-corpus/` — exported command sequences + oracle
  traces.

**Interfaces produced:**
- `Project` and all nested TS types (consumed by every later phase).
- `parseProject`, `serializeProject`, `canonicalJson`.
- `IdGen`, `Clock` injection contracts.
- `runOracle(sequence) -> Trace` (Rust driver) and the committed oracle traces.

**Exit criteria:**
- Every committed `project.json` fixture round-trips: `serialize(parse(x))` canonical-
  equals `x`.
- The Rust replay driver produces stable oracle traces from ≥50 corpus sequences.
- `differential.test.ts` runs (TS side stubbed to "not yet implemented" — wired in
  Phase 1).

## Phase 1 — TS actor core + first mutation slice (behind a flag, shadow mode)

**Scope:** the single-writer store, history (full-snapshot via Immer), commit pipeline
(mutate → `validate` → record → emit), undo/redo/checkpoint/lock, snapshot /
history_view / history_status, dry_run, the FULL `validate.ts` (26 invariants), and the
first mutation slice already isolated by Step-1a: **move / trim / delete /
duplicate_layer** (`commands/mutations.rs`, slice `f6f0d902`).

**Files:**
- Create `src/main/state/actor.ts` — store + history + commit + meta commands.
- Create `src/main/state/validate.ts` — port of `validate.rs` (all 26 rules).
- Create `src/main/state/mutations/{move,trim,delete,duplicate}.ts` — the first slice.
- Create `src/main/state/errors.ts` — `CommandError` discriminated union.
- Modify `src/main/index.ts:189-220` — `backend:invoke` routes the migrated commands to
  the TS actor when `WEFTCUT_TS_ACTOR` flag is set; otherwise Rust. In dev, **shadow
  mode**: run both and assert canonical-equality, log divergence.

**Interfaces produced:**
- `createActor({ initial, idGen, clock }) -> Actor` with `dispatch(cmd, args, actor)`,
  `snapshot()`, `undo()/redo()`, `checkpoint()/...`, `dryRun(ops)`, `subscribe(cb)`.
- `validate(project): void | throw CommandError.ValidationFailed`.

**Exit criteria:**
- `validate.ts` passes a dedicated invariant corpus (every error variant triggered).
- The four migrated mutations pass the differential harness across the full corpus.
- App runs with the flag on; shadow mode reports zero divergence in manual editing.

**Undo decision (locked):** full-snapshot history via Immer-frozen `Project` in a plain
array, cap 200, cursor model — a 1:1 port of `history.rs` (whose structural sharing
already lives inside each `Arc<Project>`, not the container; `history.rs:45-50`).
Preference-patches-applied-everywhere is a trivial `snapshots.map(applyPatch)`.
`produceWithPatches`-based history is a deferred optimization, NOT this phase.

## Phase 2 — Remaining mutations + group fan-out

**Scope:** all remaining recorded mutations (tracks, every layer kind, params, split,
separate_audio, captions, effects, markers, transitions, composition, media ops, motif
rebind) and the hard group coupling (split/trim/move fan-out, aligned-edge clamping,
escape_group, lock checks — `mutations.rs:502-635, 714-789, 881-1222`).

**Files:** `src/main/state/mutations/*.ts` (one module per command family);
`src/main/state/groups.ts` (fan-out + clamping + lock checks);
`src/main/state/snap.ts` (thin wrapper calling the wasm `snapFrameRound`).

**Exit criteria:** ALL mutations pass the differential harness, including a dedicated
group-coupling fuzz set; flag flips to TS-by-default for all project commands; shadow
mode stays clean for a soak period.

## Phase 3 — Preferences, persistence, MCP, autosave cutover

**Scope:** unrecorded preference patches (settings / track-flags / role-flags applied-
everywhere); re-point persistence (save/load `project.json`) at the TS actor; port the
Rust MCP tool handlers (`mcp/tools.rs`, ~50 tools + dry_run + resources) to TS thin
adapters over the TS actor (the MCP host is already TS in main; wire types already
match the JS SDK); re-point autosave at the TS actor's change stream.

**Files:** `src/main/state/preferences.ts`; `src/main/state/persistence.ts`;
`src/main/mcp/tools/*.ts` (ported handlers); `src/main/state/autosave.ts`.

**Exit criteria:** MCP tool calls produce identical results to the Rust handlers
(differential harness extended to MCP tool args → command sequences); a project edited
via MCP and via UI is byte-canonical-identical to the Rust baseline; autosave + backups
work; persistence round-trips real workspaces.

**⚠️ Default-on gate (2026-06-24 audit) — NOT a Phase-4-only item:** before
`WEFTCUT_TS_ACTOR` may flip to default-on, **Phase 3d-e (native-compute input re-point)**
must land. The renderer-side compute channels left on Rust read/write `backend.project()`
→ blank/stale under the flag (export audio, `import_media`, proxy/conform/thumbnail/
waveform, `install_motif` update-mode rebind, `acknowledge_motif_staleness`,
`motif_staleness_report`). 3d-e re-points their input to the TS actor (explicit args /
read-mirror) or `reject`s them under the flag; the durable allowlist gate (no
`{kind:'rust'}` channel touches the actor) backstops it. Full record:
`specs/2026-06-24-state-actor-phase-3d-design.md` §"Post-flip audit". Do NOT treat 3d-e
as Phase-4 cleanup — the flip exposes the gap the moment the flag is on.

## Phase 4 — Decommission Rust state + narrow the boundary

**Scope:** delete `state/`, the project `commands/*`, the Rust `mcp/` handlers,
`io/autosave.rs`, and the project arms of the `invoke` dispatcher; narrow
`native/index.d.ts` to the media/export/cloud/motif/eval surface; remove the
now-redundant view mirror in `src/renderer/ipc/index.ts` (renderer imports
`src/main/state/model.ts` view types instead, via the shared IPC contract). Optional:
swap `project:changed` signal+pull for patch-push over IPC (Immer inverse patches),
eliminating the per-mutation full-view re-serialize.

**⚠️ Prerequisite (2026-06-24 audit):** the §1.3 "stays in Rust" compute arms
(import/proxy/conform/thumbnail/waveform, the audio-only export gate, motif staleness)
currently read/write the project actor for their INPUTS (`commands/export.rs:34`,
`commands/media.rs:25/88/143/155/168/176/190`, `napi_backend.rs:812/814`). Once `state/`
is deleted they have no actor to read — so Phase 4 must **re-point their input to the TS
actor** (explicit args or a serialized-project read-mirror), not merely delete the
project arms. Crucially this re-point is **NOT** Phase-4-only: under `WEFTCUT_TS_ACTOR`
these read stale/blank state, so the re-point (tracked as **Phase 3d-e** in
`specs/2026-06-24-state-actor-phase-3d-design.md`) MUST land before the flag goes
default-on. See also Risk Register row "stale native-compute reads/writes".

**Exit criteria:** Rust builds without the `state` module; 3-OS CI green; the worktree
bootstrap simplifies (`reference_worktree_bootstrap`); the Rust napi surface is the
"small, coarse, heavy-call" shape napi-rs is good at.

---

# Part 5 — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Group fan-out / trim-clamp regressions | High | High | Differential harness + dedicated group fuzz; Phase 2 isolated and soak-tested |
| serde wire-shape drift (tagging, key order) | Medium | High | §2.3 table + canonical round-trip gate in Phase 0; real `project.json` fixtures |
| id/clock nondeterminism breaks differential compare | Medium | Med | Inject both on both sides (Phase 0) before any mutation port |
| Snap drift (TS snapping ≠ Rust) | Medium | High | TS actor calls the wasm `snapFrameRound` — never reimplements; harness catches drift |
| Immer Map/Set + i64 edge cases | Low | Med | `enableMapSet()`; TimeUs proven `number`-safe; round-trip tests |
| MCP handler port volume (~2600 LOC) | Med | Med | Step-1a makes them thin adapters; port family-by-family with harness gate |
| Undo memory blow-up | Low | Med | Full-snapshot via Immer = structural sharing (parity with imbl); cap 200 unchanged |
| Long-lived dual maintenance during migration | Med | Low | Flag + shadow mode keeps both correct; phases are short and mergeable |
| Stale native-compute reads/writes (export/import/proxy/conform/thumbnail/waveform read `backend.project()` + `install_motif` update-mode / `acknowledge_motif_staleness` / `motif_staleness_report` rebind/read the actor → blank under the flag; silent wrong export, split-brain media pool, wrong motif rebind) | High (if flag→default-on pre-fix) | High | **Phase 3d-e** re-points their input to the TS actor (or rejects under flag); flag must not go default-on before it; durable allowlist gate asserting no `{kind:'rust'}` channel touches the actor (2026-06-24 audit) |

---

# Part 6 — Open Decisions (resolve before/within Phase 0)

1. **Test-mode id injection in Rust** — seeded-sequence generator behind a `test`
   feature vs a thread-local override. Recommendation: thread-local override set by the
   replay driver, zero prod impact.
2. **Where the canonical view types live for the renderer** — keep emitting
   `ProjectSummary`-shaped views from main (Phase 1–3, renderer unchanged) and only swap
   the renderer's import in Phase 4. Recommendation: yes, defer renderer churn to
   Phase 4.
3. **MCP host process** — confirm MCP tool handlers can call the in-process TS actor
   synchronously (they can: same main process, `src/main/index.ts:158-160`).

---

## Self-Review

- **Spec coverage:** every command tier (§2.1), the model (§2.2), wire shapes (§2.3),
  invariants (§2.4), and all consumers (§2.5) map to a phase. ✓
- **Type consistency:** `Actor`, `CommandError`, `Project`, `IdGen`, `validate`,
  `createActor`, `canonicalJson` are named identically across phases. ✓
- **No placeholders in phase specs** — each phase lists exact files, interfaces, and
  exit criteria; bite-sized TDD code is deferred to per-phase expansions (explicitly,
  because a 15K-LOC port's mechanical type/mutation code is generated at execution time,
  not pasted in a master plan). ✓
