# Motifs TS migration — Phase 4 (delete Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The finale. Delete the Rust `motifs` Cargo feature, its module, its commands, its 4 napi methods, its file watcher, and its MCP catalog/resource arms. Move the 6 MCP-advertised motif tool defs + the `motifs://current` resource onto the **TS** MCP surface. After this phase the native crate carries **no motif subsystem** — only the inert state-layer `MotifParams` variant the read-mirror must still deserialize (see Global Constraints).

**Architecture:** Phases 1–3 already moved every motif *behavior* to TS (data layer, catalog/authoring/install, staleness/watcher); the Rust code has been dead since Phase 3. Phase 4 is removal + the last wiring move: motif MCP defs become a TS-side `MOTIF_TOOL_DEFS` table merged into `ListTools`, and `motifs://current` is served from the TS host. `mergeMcpCatalog` is generalized to keep only `rust`/`hybrid` routes from the Rust side (motif + ts come from TS), so each commit stays green whether or not Rust still advertises motif tools.

**Tech Stack:** Rust (napi-rs native crate), TypeScript (electron-vite main bundle), vitest, Playwright `_electron` e2e, `napi build`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-motifs-ts-migration-design.md` — §1 (scope/end-state), §6 (MCP rewiring), §7 phase 4, §9 testing, §10 risks.
- **SCOPE NARROWING vs the spec's "zero motif knowledge in native" framing — two items INTENTIONALLY PRESERVED (verified necessary during investigation):**
  - **`state/layer.rs` `MotifParams` + `LayerParams::Motif` STAY.** The Rust read-mirror (`setProjectMirror`) deserializes the full `Project`; removing the variant breaks serde for any project containing a motif layer → the mirror push fails → Rust compute/export breaks. This is a hard correctness constraint. The spec's §1.1 concrete list never asked to remove it; only the prose intro implied "zero motif knowledge." We keep the inert data type. Its doc comment references `resolve_motif_max_dur_us` — the clamping now lives in TS (`shared/motifs/catalog.ts`); leave the comment (it describes the field's *meaning*, still accurate) or lightly note Rust no longer computes it.
  - **`app_settings.rs prebake_motifs` STAYS.** It is a stored boolean preference, not part of the motif *module*. Removing a settings field risks the AppSettings round-trip tests + TS↔Rust settings parity; out of scope for this phase.
- **`MotifRebindEntry` (state/command.rs) IS removed.** It is a compute-output DTO (return of the deleted `compute_motif_rebind`/`compute_ack_motif_rebind`), NOT part of `Project` state. Verified: every remaining reference is inside a file being deleted, plus its own def + the `state/mod.rs` re-export. Safe to delete with its re-export.
- **The MCP catalog snapshot is a FROZEN baseline — do NOT regenerate it.** `fixtures/mcp/rust-catalog-snapshot.json` (61 tools) was captured at Phase 4a-i when Rust advertised everything; it was *not* regenerated after the state-actor "Phase 4b" catalog trim (live Rust now emits ~12). The bijection test asserts the route-classifier + TS tables reconstitute that frozen 61-tool union. Phase 4 keeps it at 61 and **reclassifies the 6 motif tools from the route-derived "native" bucket into a TS-motif bucket** — exactly how the 47 mutations are already handled. The 6 motif defs are extracted FROM this frozen snapshot (golden schemas).
- **Only 6 motif tools are MCP-advertised** (`mcp/catalog.rs`): `list_motifs`, `get_motif_source`, `write_motif_draft`, `preview_motif_draft`, `install_motif`, `delete_motif`. The spec §6's 10-item list over-counts: `amend_motif_draft`, `create_edit_draft`, `import_motif`, `motif_staleness_report`, `acknowledge_motif_staleness` are renderer-only IPC commands, never in the MCP catalog — they need no def move.
- **`preview_motif_draft` execution is already TS** (`server.ts:72-80`, `captureMotifFrameB64`); only its *def* moves. It routes `rust` and is intercepted by the `name === 'preview_motif_draft'` special-case after the tsHost block — leave that intact.
- **No `Set-Content` on source files** (cp1252 mangles em-dashes) — use Edit/Write.
- **Commands:** typecheck `npm --prefix apps/desktop run -s typecheck`; unit `npm --prefix apps/desktop run -s test -- <file>`; Rust build `npm --prefix apps/desktop run -s napi:build` (after dropping `motifs` from the feature list); e2e `npm --prefix apps/desktop run -s e2e:electron -- <spec>` (needs a `VITE_WEFTCUT_E2E=1` build; local-only).
- **Parallel sessions:** the user edits this checkout concurrently. The working tree already has 4 unstaged files from another effort (`native/Cargo.toml` + `Cargo.lock` dropping `ts-rs`; `apps/desktop/package.json` + `package-lock.json` dropping `esbuild`) — **NOT part of this phase; do not stage, revert, or depend on them.** Stage Phase-4 files by explicit path; re-check `git status` before each commit.

---

## File Structure

**Create:**
- `apps/desktop/src/main/mcp/motifToolDefs.ts` — `MOTIF_TOOL_DEFS` (6 entries: `{ name, description, inputSchema }`), descriptions verbatim from `catalog.rs`, inputSchemas verbatim from the frozen snapshot. Plus `MOTIF_RESOURCE_DEFS` (the single `motifs://current` ResourceDef).
- `apps/desktop/src/main/mcp/motifToolDefs.test.ts` — assert the 6 names == `MOTIF_TOOLS`, and (golden) each def's `inputSchema`/`description` equals the frozen snapshot entry.

**Modify (TS):**
- `apps/desktop/src/main/mcp/mcpCatalog.ts` — generalize `mergeMcpCatalog` to keep only `rust`/`hybrid` Rust tools (drops both `ts` and `motif`); add `mergeMcpResources(rustResources, tsResources)` (drops `motifs://current` from the Rust side, appends the TS one).
- `apps/desktop/src/main/mcp/mcpCatalog.test.ts` — `list_motifs` is now TS-table-sourced, not "native kept"; assert motif def comes from `MOTIF_TOOL_DEFS`; add a `mergeMcpResources` test.
- `apps/desktop/src/main/mcp/server.ts` — `ListTools`: `mergeMcpCatalog(rust, [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS])`; `ListResources`: `mergeMcpResources(rustResources, MOTIF_RESOURCE_DEFS)`; `ReadResource`: handle `motifs://current` via the TS host (list, strip `html`) before falling to `backend.mcpReadResource`.
- `apps/desktop/src/main/state/__tests__/mcp.catalog-bijection.test.ts` — reclassify: `nativeNames` = snapshot names routing `rust`|`hybrid` (exclude `motif`); add `motifNames` = `MOTIF_TOOL_DEFS` names; assert `native ∪ ts ∪ motif === allRustNames`; add "every `MOTIF_TOOLS` name is in `motifNames`" and "every `MOTIF_TOOL_DEFS` name routes `motif`".
- `apps/desktop/src/main/state/__tests__/mcp.catalog-faithfulness.test.ts` — extend the loop to also iterate `MOTIF_TOOL_DEFS` against the frozen snapshot (locks the TS motif schemas to the original Rust ones).
- `apps/desktop/src/main/state/hybrids.ts` — delete the unreachable `case 'install_motif'` (134-148) + `computeMotifRebind`/`computeAckMotifRebind` from the `ComputeNapi` interface (21-23).
- `apps/desktop/src/main/index.ts` — delete `computeFacade.computeMotifRebind`/`computeAckMotifRebind` (280-281) + the stale comment about the Rust watcher (315-316) since it's now gone.
- Test mocks dropping the two compute fields: `src/main/mcp/server.flip.test.ts:18`, `src/main/state/ts-actor-host.test.ts:58`, `src/main/state/__tests__/agent-session-end.test.ts:13`, `src/main/state/__tests__/hybrids.test.ts:53-54` + the `computeMotifRebind` install describe block (~140-196), `src/main/state/__tests__/mcp.malformed-args.test.ts:16`, `src/main/state/__tests__/mirror-push.test.ts:10`, `src/main/state/__tests__/restore-log-parity.test.ts:39`.

**Modify (Rust):**
- `native/Cargo.toml` — remove `motifs = []` feature (line 102).
- `apps/desktop/package.json` — `napi:build` script: drop `,motifs` from `--features jobs,export,mcp,cloud,motifs`.
- `native/src/lib.rs` — remove `#[cfg(feature="motifs")] mod motifs;` (35-36) AND the now-dead `#[cfg(not(feature="motifs"))] mod motifs { catalog }` fallback + its stale comment (37-47). (Verified: no non-motif Rust code references `crate::motifs::catalog`.)
- `native/src/commands/mod.rs` — remove `pub mod motifs;` + `pub mod motif_authoring;` (18-21).
- `native/src/napi_backend.rs` — remove: `motif_store`/`motif_watcher` fields (66-69) + their init (92-93, 129-132); watcher spawn block (153-163); compute methods impl block (389-429); `MotifFile` struct + `motif_resolve_file`/`motif_ctx_duration_s` impl block (490-532); the 8 motif dispatch match arms (726-765); the `#[cfg(feature="motifs")]` motif unit tests (`motif_store_resolves_builtin_bytes`, `motif_staleness_report_empty_returns_empty_list`, `list_motifs_arm_returns_builtins` — ~951-1050).
- `native/src/mcp/catalog.rs` — remove the 6 motif tool entries from `tool_table!` (87-118).
- `native/src/mcp/tools.rs` — remove motif arg structs + handlers (315-475).
- `native/src/mcp/resources.rs` — remove `URI_MOTIFS` (35-36), the `read_resource` arm (119-132), the `static_resources` entry (404-410).
- `native/src/state/command.rs` — remove `MotifRebindEntry` (140-146); `native/src/state/mod.rs` — drop it from the re-export (34).

**Delete (Rust files):**
- `native/src/motifs/` entire dir: `mod.rs`, `authoring.rs`, `authoring_commands.rs`, `builtin.rs`, `catalog.rs`, `catalog/` (built-in HTML + Inter.woff2 assets — now duplicated by `src/shared/motifs/builtin/`), `staleness.rs`, `store.rs`, `watcher.rs`.
- `native/src/commands/motifs.rs`, `native/src/commands/motif_authoring.rs`.

---

## Task 1: TS — move motif MCP defs + resource to TS (TDD)

Lands FIRST, while Rust still advertises motif tools. The `mergeMcpCatalog` `rust`/`hybrid`-only filter makes this safe (Rust-advertised motif tools are dropped and re-added from TS — no duplicate), so the commit is green before any Rust deletion.

**Files:** create `motifToolDefs.ts` + `.test.ts`; modify `mcpCatalog.ts` + `.test.ts`, `server.ts`, `mcp.catalog-bijection.test.ts`, `mcp.catalog-faithfulness.test.ts`.

- [ ] **Step 1 (test):** `motifToolDefs.test.ts` — `new Set(MOTIF_TOOL_DEFS.map(d=>d.name))` equals `MOTIF_TOOLS`; each def's `description` + `inputSchema` deep-equals the frozen snapshot entry of the same name (golden lock).
- [ ] **Step 2 (impl):** create `motifToolDefs.ts`. `MOTIF_TOOL_DEFS` = the 6 `{name, description, inputSchema}`. Descriptions verbatim from `catalog.rs:88-118`. inputSchemas verbatim from the snapshot (`list_motifs`→EmptyArgs, `get_motif_source`/`delete_motif`→MotifIdArgs, `write_motif_draft`→WriteMotifDraftArgs, `preview_motif_draft`→PreviewMotifDraftArgs, `install_motif`→InstallMotifArgs). `MOTIF_RESOURCE_DEFS` = `[{ uri:'motifs://current', name:'Motif catalog', description:'Built-in, installed, and draft Motifs (html stripped). Re-fetch after motifs:changed events.', mimeType:'application/json' }]`.
- [ ] **Step 3 (test):** `mcpCatalog.test.ts` — rewrite the `rust` fixtures so `list_motifs` is NOT in the Rust array; pass `[...tsDefs, ...MOTIF_TOOL_DEFS]`; assert `list_motifs` present (from TS), no dup, and a motif tool still in the Rust array is dropped. Add a `mergeMcpResources` test (Rust `motifs://current` dropped, TS one present, no dup).
- [ ] **Step 4 (impl):** `mcpCatalog.ts` — `rustKept = rustTools.filter(t => { const r = routeMcpTool(t.name); return r === 'rust' || r === 'hybrid' })`; update the header comment. Add `mergeMcpResources(rust, ts)`: drop any Rust resource whose `uri` is in the TS set, append the TS ones.
- [ ] **Step 5 (impl):** `server.ts` — wire `ListTools`/`ListResources`/`ReadResource` per File Structure. For `ReadResource('motifs://current')` reuse the TS list (via the host) with `html` stripped; return the SDK `{contents:[{uri, mimeType:'application/json', text}]}` shape (match the envelope `unwrap` produces for the Rust path). Confirm the exact host accessor for the catalog list during impl (`tsHost.motifTool('list_motifs', {})` → strip html).
- [ ] **Step 6 (test):** update `mcp.catalog-bijection.test.ts` + `mcp.catalog-faithfulness.test.ts` per File Structure. Run all four MCP test files green.

## Task 2: TS — delete the dead motif compute path

`install_motif`/`acknowledge_motif_staleness` route `motif` (Phases 2/3); `runHybrid` is never called for them. Remove the dead branch + interface methods + wiring + the ~8 test mocks.

**Files:** `hybrids.ts`, `index.ts`, + the 7 test files listed in File Structure (incl. the `computeMotifRebind` describe block in `hybrids.test.ts`).

- [ ] **Step 1:** delete `ComputeNapi.computeMotifRebind`/`computeAckMotifRebind` (hybrids.ts:21-23) and the `case 'install_motif'` (134-148).
- [ ] **Step 2:** delete `computeFacade.computeMotifRebind`/`computeAckMotifRebind` (index.ts:280-281).
- [ ] **Step 3:** remove the two fields from each compute mock; delete the `hybrids.test.ts` install describe block (it only exercised the removed branch). Run the touched test files + `typecheck` green.

## Task 3: Rust — delete the motifs feature wholesale

After Tasks 1-2, no TS code calls any motif napi method and motif defs come from TS. Now remove all Rust motif code. Do it as one coherent change (the deletions are interdependent — feature flag, module, dispatch, MCP arms).

**Files:** all "Modify (Rust)" + "Delete (Rust files)" in File Structure.

- [ ] **Step 1:** drop `motifs` from `napi:build` features (package.json) + the `motifs = []` feature (Cargo.toml).
- [ ] **Step 2:** delete the `motifs/` dir + `commands/motif*.rs`; remove the `mod`/`pub mod` declarations (lib.rs, commands/mod.rs).
- [ ] **Step 3:** strip the motif sites from `napi_backend.rs` (fields/init/watcher/compute/resolve/dispatch/tests), `mcp/{catalog,tools,resources}.rs`, and remove `MotifRebindEntry` (command.rs + mod.rs re-export). Leave `state/layer.rs MotifParams` + `app_settings.rs prebake_motifs` UNTOUCHED.
- [ ] **Step 4:** `npm --prefix apps/desktop run -s napi:build` compiles clean (no `motifs` feature). Grep `grep -rin motif native/src` — only `state/layer.rs` (`MotifParams` + doc) and `app_settings.rs` (`prebake_motifs`) and the `media_conformance.rs` test comments should remain.

## Task 4: Verification

- [ ] `npm --prefix apps/desktop run -s typecheck` clean.
- [ ] `npm --prefix apps/desktop run -s test` — full vitest suite green (the bijection/faithfulness/tool-table/mcpCatalog gates pass with motif on the TS side).
- [ ] `napi:build` green (Task 3 Step 4).
- [ ] e2e (local, `VITE_WEFTCUT_E2E=1` build): `motif-lifecycle.spec.ts` (all 3 sections), `motif-protocol`, `motif-capture` PASS — motif serving + authoring + install + staleness now run with zero Rust motif code. Capture determinism unchanged.

---

## Self-Review

- [ ] No `#[cfg(feature = "motifs")]` remains anywhere (`grep -rn 'feature = "motifs"' native`).
- [ ] `mcpCatalog()` (live Rust) no longer lists motif tools or `motifs://current`; `ListTools`/`ListResources` over MCP still expose all 6 motif tools + the resource (now TS-sourced); `ReadResource('motifs://current')` returns the html-stripped catalog.
- [ ] The frozen snapshot is UNCHANGED (61 tools); bijection still asserts the full union, now with motif in the TS bucket.
- [ ] `MotifParams` + `prebake_motifs` preserved; read-mirror still deserializes a motif-layer project (a quick e2e place-motif → export sanity, or rely on motif-lifecycle).
- [ ] Staged by explicit path; the 4 unrelated `ts-rs`/`esbuild` working-tree files are untouched.
- [ ] Update `MEMORY.md` / `project_motifs_ts_migration.md`: Phase 4 done, migration COMPLETE.
