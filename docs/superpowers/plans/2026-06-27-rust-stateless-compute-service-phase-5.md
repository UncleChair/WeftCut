# Rust stateless-compute-service — Phase 5: delete the read-mirror

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Rust read-mirror wholesale — the last residue of project state on the Rust side. After Phases 1–4 every compute reader takes its exact state slice as a call argument, so the `read_mirror` field is now **write-only**: `set_project_mirror` fills it on every commit, but its only two readers (`snapshot_for_read` / `mirror_history_view`) are already `#[allow(dead_code)]` and caller-less. Removing it makes the boundary self-evident: **TypeScript owns ALL project state; the Rust core holds none.** No behavior changes — the renderer-facing `project:changed` event and `project_summary` pull are untouched.

**Architecture:** Spec `docs/superpowers/specs/2026-06-27-rust-stateless-compute-service-design.md` §3 ("Deletion") + sequencing item 5. Delete (Rust `napi_backend.rs`): the `ReadMirror` struct, the `read_mirror` field, `set_project_mirror`, `snapshot_for_read`, `mirror_history_view`. Delete (TS): the per-commit `pushMirror` serialize + `setProjectMirror` push in `ts-actor-host.ts`, and the `setProjectMirror` facade wiring in `index.ts`. Then re-point every doc/comment/test that still describes the mirror as a current mechanism. The evergreen design docs (`architecture.md`, `data-model.md`) currently assert "the Rust core keeps a deserialized read-mirror" — that becomes false here, so updating them is this phase's documentation deliverable (same as Phase 4 rewrote the data-model import paragraph).

**Tech Stack:** Rust (napi-rs addon, `apps/desktop/native`), TypeScript (Electron main + TS state actor, `apps/desktop/src/main`). Rust async via tokio; `cargo test`. TS via vitest + `tsc -b`.

## Global Constraints

- Native Rust build/test MUST pass `--features export,mcp,cloud` — the default (no-feature) build does not compile. (`export` and `cloud` both imply `jobs`.)
- **Phase ordering is load-bearing (TS before Rust).** Task 2 (TS deletion) MUST land before Task 3 (Rust deletion of the napi method). Deleting `set_project_mirror` from Rust regenerates `apps/desktop/native/index.d.ts` (gitignored, built locally) **without** `setProjectMirror`; if the TS `index.ts` still called `backend.setProjectMirror`, the typecheck would break. Removing the TS call first keeps every commit green. (Same shape as Phase 4's Task 2-before-Task 3 lesson.)
- **napi rebuild:** Task 3 removes the `set_project_mirror` napi method (a signature change to the `Backend` surface). Run `npm --prefix apps/desktop run napi:build` at the end of Task 3, then re-run the TS typecheck to confirm the regenerated `index.d.ts` (now without `setProjectMirror`) still typechecks. **Close the app first** — the running `weftcut-core.*.node` is file-locked on Windows.
- **The timestamp constraint survives — do NOT delete `blank-project-timestamps.test.ts`.** `blankProject` must still emit real RFC3339 timestamps, because the project JSON is still deserialized into a Rust `crate::state::Project` by the surviving Phase-2 export-audio channels and the Phase-3 `project://compiled` resource. Only the *mechanism reference* (`set_project_mirror`) in that test's comment is stale — update the comment, keep the test.
- Commit after each task. Stage by **explicit path** (other sessions edit this checkout concurrently — re-check `git status` before each commit).
- End every task green on `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud` (Rust tasks) and `npm --prefix apps/desktop run typecheck` + `npm --prefix apps/desktop test` (TS tasks).

---

## File Structure

- `apps/desktop/src/main/state/ts-actor-host.ts` — Task 2: delete the `setProjectMirror?` dep field + doc (`:46-48`), the `pushMirror` fn (`:217-220`), and its two call sites (`emitChange` `:223`, `start()` `:398`). `serializeProjectToJson` import STAYS (autosave still uses it, `:162`).
- `apps/desktop/src/main/index.ts` — Task 2: delete the `setProjectMirror:` facade wiring (`:334`); update the bring-up comments (`:223-227`, `:348`, `:361`) that justify "push the mirror before MCP host start."
- `apps/desktop/src/main/state/model.ts` — Task 2: update the `blankProject` LANDMINE comment (`:127-131`) — the timestamp must round-trip through Rust `Project` deserialization, but via the export-audio / `project://compiled` paths now, not `set_project_mirror`.
- `apps/desktop/src/main/state/actor.ts` — Task 2: update the throwing-subscriber comment (`:124-126`) — the `pushMirror` example is gone; use a surviving subscriber (autosave / mcpNotify).
- `apps/desktop/src/main/state/__tests__/mirror-push.test.ts` — Task 2: **DELETE** (tests the deleted push behavior end-to-end).
- `apps/desktop/src/main/state/__tests__/mcp.malformed-args.test.ts` — Task 2: drop the `setProjectMirror` dep param + the push-count tracking + the `:34` "must not push the mirror" assertion; update the `:8` comment. The core (malformed args rejected, no state mutation) stays.
- `apps/desktop/src/main/state/__tests__/blank-project-timestamps.test.ts` — Task 2: update the `:6-11` comment (mechanism: export-audio / `project://compiled` deserialize, not `set_project_mirror`). Body unchanged.
- `apps/desktop/e2e/electron/ts-actor-bringup.spec.ts` — Task 2: update the `:5-8` + `:30-32` comments (the summary is TS-served; drop the `snapshot_for_read`/mirror bring-up rationale).
- `apps/desktop/e2e/electron/ts-actor-native-compute.spec.ts` — Task 2: re-frame the `snapshot_for_read`/"mirror-backed" comments → the TS host injects the project slice (Phase 2). Body unchanged.
- `apps/desktop/native/src/napi_backend.rs` — Task 3: delete `ReadMirror` (`:24-32`), the `read_mirror` field + doc (`:56-58`), the constructor binding (`:70-73`) + field init (`:108`), `set_project_mirror` (`:159-170`), `snapshot_for_read` (`:404-417`), `mirror_history_view` (`:419-425`); update the module doc (`:1-4`); update/rename the source-guard test's docstring + its Phase-4 "remain (deleted in Phase 5)" comment (`:866-952`).
- `apps/desktop/native/src/io/mod.rs` — Task 3: update the module doc comment (`:5-6`) that says the Rust core keeps a read-mirror filled by `set_project_mirror`.
- `docs/architecture.md` — Task 4: rewrite the 5 read-mirror descriptions (`:5-8`, `:62-65`, `:74-77`, `:165-169`, `:186-189`).
- `docs/data-model.md` — Task 4: rewrite the intro read-mirror sentence (`:4-8`).

**Parked (out of scope — pre-existing migration-era drift, not made worse by Phase 5):** `apps/desktop/fixtures/state-corpus/README.md` §"live MCP flip and read-mirror" (`:588-651`) documents the long-removed `WEFTCUT_TS_ACTOR` flag + a flag-off Rust-actor path that no longer exists; it is a historical migration narrative (and already references a stale test name). Rewriting it means rewriting the flag narrative too — a separate cleanup. Note it; do not touch it here.

---

## Task 1: Plan doc

- [x] This document. Commit:

```bash
git add docs/superpowers/plans/2026-06-27-rust-stateless-compute-service-phase-5.md
git commit -m "docs(plan): add stateless-compute-service phase-5 plan (delete the read-mirror)"
```

---

## Task 2: TS — delete the per-commit mirror push + dependent tests/comments

The TS host stops serializing the whole project + history on every commit. `emitChange` keeps emitting `project:changed` (renderer) + `mcpNotify` (MCP relay); only the `pushMirror()` line goes. **This is the load-bearing task — it must land before Task 3** (so the still-present `set_project_mirror` napi method has no TS caller before it is deleted).

**Files:** see File Structure (the TS + e2e + test entries).

- [ ] **Step 1: Delete the mirror push in `ts-actor-host.ts`.**
  - Delete the `setProjectMirror?` dep field + its doc comment (`:46-48`).
  - Delete the `pushMirror` fn (`:217-220`).
  - In `emitChange` (`:222-227`), delete the `pushMirror()` line; the fn now starts at `const payload = mapChangeEvent(e)`.
  - In `start()` (`:395-400`), delete the `pushMirror()` line (keep `autosave.start()` + `refreshMotifCatalog()`).
  - Leave the `serializeProjectToJson` import (`:9`) — `createAutosave({ serialize: serializeProjectToJson })` (`:162`) still uses it.

- [ ] **Step 2: Delete the facade wiring + fix the comments in `index.ts`.**
  - Delete the `setProjectMirror: (pj, hv) => backend!.setProjectMirror(pj, hv),` line (`:334`).
  - Update the `tsHost` bring-up comment (`:223-227`): drop "pushing the initial read-mirror via setProjectMirror … so that snapshot_for_read() has the mirror populated before any compute/MCP read can run." The TS host is constructed before `startMcpHost` so the actor (which serves all MCP state views + injects compute slices) is ready first.
  - Update the `:348` log line — replace "mirror pushed before MCP host start" (e.g. `'[main] TS state actor authoritative; MCP host starting'`).
  - Update the `:360-362` comment — `startMcpHost` is started after `tsHost.start()` so the actor is ready before any MCP read; drop the "read-mirror is populated" wording.

- [ ] **Step 3: Fix the surviving comments in `model.ts` + `actor.ts`.**
  - `model.ts` (`:127-131`): keep the LANDMINE (real timestamps, not the `<TS>` sentinel) but re-point the *why*: the project JSON round-trips through Rust `DateTime<Utc>` deserialization via the export-audio channels (`export_project_audio_only` / `ensure_export_audio_conform` take a `project: Project`) and the `project://compiled` MCP resource — a `<TS>` sentinel would make those deserializations fail.
  - `actor.ts` (`:124-126`): the throwing-subscriber example was `pushMirror`; replace with a surviving subscriber (e.g. "autosave serialize / mcpNotify"). The principle (one throwing subscriber must not starve the others) is unchanged.

- [ ] **Step 4: Delete `mirror-push.test.ts`.** `git rm apps/desktop/src/main/state/__tests__/mirror-push.test.ts` — it asserts the push happens at start + on every change, the exact behavior being removed.

- [ ] **Step 5: Rework `mcp.malformed-args.test.ts`.**
  - `makeDeps`: drop the `setProjectMirror` param + the `setProjectMirror,` field. (Keep the `compute` stub with `hashMediaSource` etc.)
  - First test ("add_marker with a string color"): drop `const pushes` / `pushesAtStart` and the `:34` assertion `expect(pushes.length, 'a rejected call must not push the mirror')…`. Keep the `r.ok === false` + `invalid_params` + "no garbage marker committed" assertions (the real regression).
  - Update the file-header comment (`:4-9`): the soak finding was that a struct-shaped bad arg committed garbage / wedged the actor; drop the "then broke the read-mirror push" clause.

- [ ] **Step 6: Update the `blank-project-timestamps.test.ts` comment** (`:6-11`): the round-trip is through the Phase-2 export-audio `serde_json::from_str::<Project>` (and `project://compiled`), not `set_project_mirror`. The assertions are unchanged — `blankProject` must still emit real RFC3339, not `<TS>`.

- [ ] **Step 7: Re-frame the two e2e spec comments.**
  - `ts-actor-bringup.spec.ts` (`:5-8`, `:30-32`): the test confirms `project_summary` is served immediately after boot. The summary is served by the TS actor directly; drop the "snapshot_for_read() has no actor fallback / mirror must be pushed first" rationale.
  - `ts-actor-native-compute.spec.ts`: replace every "mirror-backed read" / "reads `snapshot_for_read()`" / "present in the TS mirror" phrasing with the Phase-2 reality — `ensure_export_audio_conform` takes a `project` arg the TS host injects from `actor.snapshot()`; the test proves that export-input injection path is wired. (Body + assertions unchanged.)

- [ ] **Step 8: Typecheck + full TS suite (must be green).** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean (the locally-built `index.d.ts` still declares `setProjectMirror`, now unused — harmless); all tests pass (one fewer test file after the `mirror-push.test.ts` delete).

- [ ] **Step 9: Commit.**

```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/index.ts apps/desktop/src/main/state/model.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/__tests__/mirror-push.test.ts apps/desktop/src/main/state/__tests__/mcp.malformed-args.test.ts apps/desktop/src/main/state/__tests__/blank-project-timestamps.test.ts apps/desktop/e2e/electron/ts-actor-bringup.spec.ts apps/desktop/e2e/electron/ts-actor-native-compute.spec.ts
git commit -m "refactor(stateless): drop the per-commit read-mirror push (TS host)"
```

---

## Task 3: Rust — delete the read-mirror wholesale

With no TS caller (Task 2) and the two readers already dead-code, every mirror symbol is removable. The compiler is the proof: nothing references them.

**Files:** `apps/desktop/native/src/napi_backend.rs`, `apps/desktop/native/src/io/mod.rs`.

- [ ] **Step 1: Delete the `ReadMirror` struct** (`:24-32`, including its doc comment).

- [ ] **Step 2: Delete the `read_mirror` field** (`:56-58`, the field + its `/// See ReadMirror…` doc) from `struct Backend`.

- [ ] **Step 3: Delete the constructor wiring in `build_backend`.** Remove the `read_mirror` `let` binding + its comment (`:70-73`) and the `read_mirror,` field initializer (`:108`).

- [ ] **Step 4: Delete `set_project_mirror`** (`:159-170`, the `#[napi]` method + its doc comment).

- [ ] **Step 5: Delete `snapshot_for_read`** (`:404-417`) **and `mirror_history_view`** (`:419-425`), including their doc comments. (They are the two `#[allow(dead_code)]` readers.)

- [ ] **Step 6: Update the module doc comment** (`:1-4`). Replace "Holds the TS-fed read-mirror + managed stores" — the Backend now holds **no project state**; it owns the cache/workspace/log/cloud-key stores + the job queue, and exposes a single stateless `invoke` dispatcher (every compute call takes its state slice as an argument).

- [ ] **Step 7: Update the source-guard test.** In `mirror_backed_reads_use_the_mirror_not_an_actor` (`:866-976`):
  - Rename it to reflect what it now guards — the compute/jobs paths are stateless (no mirror, no stale actor). Suggested: `compute_paths_take_slices_not_the_mirror_or_stale_actor`.
  - Rewrite the docstring (`:866-870`): the read handlers take their state slice at the call boundary (Phases 1–3); the jobs path bakes the real hash at enqueue (Phase 4); no file reads a mirror or the deleted Rust actor; `ensure_full_proxy` routes through `commit_media_derivatives`.
  - In the Phase-4 comment block (`:932-937`), drop the trailing "; only `set_project_mirror` + the two dead-code readers remain (deleted in Phase 5)" — they are gone now. (The `snapshot_for_read`-absence asserts on export/tools/resources/media remain valid and become trivially true; leave them — they still pin the slice contract.)

- [ ] **Step 8: Update `io/mod.rs` doc** (`:5-6`). It says "The Rust core only keeps a read-mirror, which `Backend::set_project_mirror` fills with a plain serde deserialize." Re-point: `io` is the project.json (de)serialize used when Rust is *handed* a project/MediaItem slice for a compute call (export audio, `project://compiled`) and by `io/migrate.rs` for schema migrations — no resident copy.

- [ ] **Step 9: Native suite green (before commit).** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed. No dead-code / unused-import warnings (deleting the readers may free an unused `serde_json::Value` use or similar — clear any warning the compiler surfaces).

- [ ] **Step 10: Rebuild the napi addon (regenerate `index.d.ts`).** Close the app if running (the `.node` is file-locked). Run: `npm --prefix apps/desktop run napi:build`
Verify the method is gone: `rg -n "setProjectMirror" apps/desktop/native/index.d.ts` → no matches.

- [ ] **Step 11: Re-typecheck TS (the regenerated `index.d.ts` no longer declares `setProjectMirror`).** Run: `npm --prefix apps/desktop run typecheck`
Expected: clean (Task 2 removed the only TS caller). If it reports `Property 'setProjectMirror' does not exist`, a Task-2 reference was missed — find and remove it.

- [ ] **Step 12: Commit.**

```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/io/mod.rs
git commit -m "refactor(stateless): delete the read-mirror (set_project_mirror/snapshot_for_read/ReadMirror)"
```

---

## Task 4: Docs — architecture.md + data-model.md to "Rust holds no state"

The evergreen design docs still describe the read-mirror as a current fact. Phase 5 makes that false; per the evergreen-docs convention these read as if authored today.

**Files:** `docs/architecture.md`, `docs/data-model.md`.

- [ ] **Step 1: `data-model.md` intro** (`:4-8`). Replace "the Rust core deserializes the same shapes into a read-mirror for its compute paths" with: the Rust core deserializes the same shapes from the **slice it is handed per compute call** (export audio, `project://compiled`, media reads) — it keeps no resident copy. UI, MCP server, and persistence remain clients of the TS actor.

- [ ] **Step 2: `architecture.md`** — rewrite the 5 sites so Rust reads as compute-only/stateless:
  - `:5-8` (intro): "…the Rust core (an in-process napi addon) is compute-only — media jobs, the audio mixer, ffmpeg — taking the project/MediaItem slice it needs as a call argument; it holds no project state."
  - `:62-65`: drop "and the read-mirror of project state" from the Rust-side list; Rust = background jobs, audio mixer, ffmpeg, export, probe, cloud — stateless.
  - `:74-77`: replace "The Rust core keeps a deserialized read-mirror of the committed state for its compute paths; it never writes." → Rust receives the exact state slice each compute call needs and never writes / never retains it.
  - `:165-169` (`src/state/`): "project state data types — the model Rust compute deserializes from the slice it is handed (the actor, history, validation, autosave live in TS main)."
  - `:186-189` (`io/`): "project.json (de)serialize for the per-call project/MediaItem slices + io/migrate.rs (schema migrations)."

- [ ] **Step 3: Commit.**

```bash
git add docs/architecture.md docs/data-model.md
git commit -m "docs(stateless): Rust core holds no project state (read-mirror deleted)"
```

---

## Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Native suite green.** `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud` → PASS, 0 failed.
- [ ] **Step 2: TS typecheck + suite green.** `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test` → clean + all pass.
- [ ] **Step 3: Confirm the mirror is gone.** `rg -n "read_mirror|set_project_mirror|snapshot_for_read|mirror_history_view|ReadMirror|setProjectMirror|pushMirror" apps/desktop/src apps/desktop/native/src` → **no matches** except the renamed guard test's assertion string literals in `napi_backend.rs` (and any intentional historical mention). No production source line should match.
- [ ] **Step 4: Real-app smoke (optional but recommended).** Boot the app, import a clip, run a mutation, open the MCP `project://current` resource, trigger an audio export-readiness check — all functional with no mirror. The `project:changed`-driven UI refresh + `project_summary` pull behave identically (no mirror was ever on that path).

---

## Self-review notes (for the executor)

- **Why TS before Rust (and green between):** After Task 2, no TS code calls `backend.setProjectMirror`; the napi method still exists and the locally-built `index.d.ts` still declares it (unused — harmless), so TS typecheck + vitest stay green. Task 3 then deletes the method and `napi:build` regenerates `index.d.ts` without it; the re-typecheck is green because the only caller is already gone. Reversing the order breaks typecheck between commits.
- **The timestamp test is NOT mirror cruft.** It guards a live constraint: `blankProject`'s timestamps round-trip through Rust `Project` deserialization in the surviving export-audio + `project://compiled` paths. Deleting it would drop a real regression guard. Only its comment's *mechanism reference* is stale.
- **`mirror-push.test.ts` is the one full delete.** It tests the push lifecycle (start + per-change) end-to-end — there is nothing left to assert once the push is gone. `mcp.malformed-args.test.ts` is reworked (not deleted): its real subject (malformed args rejected before commit, no state mutation) survives; only the incidental "did not push the mirror" assertion goes.
- **The guard test stays valuable post-deletion.** Its `snapshot_for_read`-absence asserts become trivially true (the symbol no longer exists anywhere), but it still pins the positive contract — the compute files take slices, don't read a stale actor, and `ensure_full_proxy` routes through the write seam. Renaming it removes a now-false name (`…use_the_mirror…`).
- **No new guard for napi_backend.rs itself.** A self-scan asserting the mirror never returns would have to read `napi_backend.rs`, whose own assertion-string literals would self-match — the same trap the existing guard avoids by reading *other* files. The compiler already enforces deletion (nothing references the symbols), so no extra guard is added.
- **Parked, by design:** `state-corpus/README.md` §588-651 is a historical 3d-d/3d-e migration narrative tied to the removed `WEFTCUT_TS_ACTOR` flag — already drifted before Phase 5 (it cites a stale test name). Out of this phase's deletion scope; a standalone fixtures-README cleanup.
- **Migration complete after this phase.** All five phases land: single-media reads (1), broad-state compute (2), MCP resources (3), import hash-first (4), mirror deletion (5). The boundary is now unambiguous — TS owns all state, Rust is a stateless in-process compute service (ADR 0024 in-process addon stands; "service" = stateless request/response).
