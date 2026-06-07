# Motif Rename (product surface) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `template` **product surface** to `Motif` — data model, Tauri commands, MCP tools, IPC view types, compositor/sprite, picker, their tests, and user-visible strings — as a clean break (no backward compat).

**Architecture:** Pure mechanical rename, no behavior change. The gate for every task is "the build compiles and existing tests stay green," not red-green TDD. Scoped to the product surface; the legacy internal render machinery (`render/templates/` catalog + raster/cache/prewarmer/baker + SVG files) keeps its current names this round — it gets redirected/unified/deleted in editor-integration Stages 3–5. The interim "Frankenstein" (a `Motif`-named layer whose sprite still imports legacy `getTemplate`/`resolveTemplateFrame` from `render/templates/`) already exists from the live-preview slice and builds + runs.

**Tech Stack:** Rust (Tauri 2, `cargo`), TypeScript (Vitest, `tsc -b`), real-WebView2 e2e (WebdriverIO).

**Spec:** `docs/superpowers/specs/2026-06-07-motifs-editor-integration-design.md` §2 (cutover table) + §7 (cutover). Clean break — saved projects with `Template` layers will fail to load; accepted (pre-release, user-confirmed).

---

## Scope: what renames vs what is deferred

**RENAME this round (product surface):**

| Rust (src-tauri) | → | TS (apps/desktop/src) | → |
|---|---|---|---|
| `LayerParams::Template(TemplateParams)` | `Motif(MotifParams)` | `LayerParamsView` `"Template"` variant | `"Motif"` |
| `TemplateParams { template_id, template_version, props, src_in_us, transform, opacity }` | `MotifParams { motif_id, motif_version, … }` | `TemplateView` (ipc) | `MotifView` |
| `TemplatePatch` | `MotifPatch` | `TemplateSummary` (ipc) | `MotifSummary` |
| `add_template` (cmd + MCP tool + `AddTemplateArgs`) | `add_motif` (`AddMotifArgs`) | `addTemplate` (ipc fn) | `addMotif` |
| `list_templates` (cmd + MCP tool) | `list_motifs` | `listTemplates` (ipc fn) | `listMotifs` |
| `resolve_template_t_end_us`, `resolve_template_max_dur_us` | `resolve_motif_*` | `TemplateSprite` / `TemplateSpriteInit` (render/sprite) | `MotifSprite` / `MotifSpriteInit` (file renamed) |
| | | `ActiveTemplate`, `ensureTemplate`, `updateTemplate` (Compositor.ts) | `ActiveMotif`, `ensureMotif`, `updateMotif` |
| | | `TemplatePicker` (templates/TemplatePicker.tsx) | `MotifPicker` (file renamed) |

**DEFER (not this round — Stages 3–5 redirect/unify/delete them):** the Rust `templates` module (`templates::catalog/builtins/canonicalize_props`) and the legacy TS `render/templates/` internals — `catalog.ts` (`getTemplate`/`Template`; would collide with Plan-1's `render/motifs/catalog.ts`), `templateRaster.ts`, `frameCache.ts`, `templateFrameDescriptor.ts`, `templateFrames.ts`, the prewarmer, the baker, and the SVG files (`harness.ts`/`rasterPool.ts`/`svgRaster.ts`/…). `MotifSprite` keeps importing these legacy names for now.

> **Runtime-consistency note:** the serialized enum tag (`"Template"`→`"Motif"`) is the Rust↔TS contract. After **Task 1 (Rust)** the app is runtime-inconsistent with the frontend until **Task 2 (TS)** lands — acceptable on a WIP branch (each commit builds + unit-tests green per side; the branch tip is fully consistent and e2e-verified in Task 4). Do the tasks in order; don't ship a mid-branch commit.

---

## Task 1: Rust product-surface rename

**Files (from the cutover map — grep to find every reference; these are the known anchors):**
- `apps/desktop/src-tauri/src/state/layer.rs` (the `LayerParams::Template` variant + `TemplateParams` struct + fields)
- `apps/desktop/src-tauri/src/state/actor.rs` (`TemplatePatch`)
- `apps/desktop/src-tauri/src/commands.rs` (`add_template`, `list_templates`, the `TemplateView`/`LayerParamsView` mapping)
- `apps/desktop/src-tauri/src/mcp/mod.rs` (`add_template`/`list_templates` tools, `AddTemplateArgs`, `resolve_template_t_end_us`, `templates_payload`)
- All `#[cfg(test)]` modules + `insta` snapshots that reference the renamed symbols/JSON tags
- `apps/desktop/src-tauri/src/lib.rs` (the `invoke_handler!` entries `commands::add_template`/`list_templates`)

- [ ] **Step 1: Enumerate the rename set**

Run (from repo root) to see the full reference surface before editing:
```
git grep -n "TemplateParams\|TemplatePatch\|add_template\|list_templates\|AddTemplateArgs\|resolve_template_\|LayerParams::Template\|template_id\|template_version" -- apps/desktop/src-tauri/src
```
Expected: a bounded list across the files above. (Do NOT rename inside `src-tauri/src/templates/` — that module is deferred; only rename the variant/params/commands/MCP/view surface. The commands may still CALL `templates::builtins()`/`canonicalize_props` — leave those call targets named as-is.)

- [ ] **Step 2: Rename the data model**

In `state/layer.rs`: `LayerParams::Template`→`Motif`; `struct TemplateParams`→`MotifParams`; fields `template_id`→`motif_id`, `template_version`→`motif_version` (leave `props`/`src_in_us`/`transform`/`opacity`). In `state/actor.rs`: `TemplatePatch`→`MotifPatch` and its application arm. Fix every reference the grep surfaced.

- [ ] **Step 3: Rename commands + MCP + view mapping**

In `commands.rs` + `mcp/mod.rs` + `lib.rs`: `add_template`→`add_motif`, `list_templates`→`list_motifs`, `AddTemplateArgs`→`AddMotifArgs`, `resolve_template_t_end_us`→`resolve_motif_t_end_us`, `resolve_template_max_dur_us`→`resolve_motif_max_dur_us`, the IPC/MCP `LayerParamsView`/`TemplateView` "Template" tag + struct → "Motif"/`MotifView`. Keep the calls into the deferred `templates::` module (e.g. `templates::builtins()`) unchanged — only the command/arg/view names change. Update the `invoke_handler!` entries.

- [ ] **Step 4: Update Rust tests + snapshots**

Update `#[cfg(test)]` references and any `insta` snapshots (the serialized JSON now says `"Motif"`/`motif_id`). Run `cargo insta review` if snapshots changed, or update the `.snap` files to match.

- [ ] **Step 5: Verify build + tests green**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin weftcut`
Expected: Finished, no errors.
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: all pass (update any remaining test refs until green).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "refactor(motifs): rename Rust product surface Template->Motif (data model, commands, MCP, view)"
```

---

## Task 2: TypeScript product-surface rename

**Files:**
- `apps/desktop/src/ipc/index.ts` (`TemplateView`→`MotifView`, `TemplateSummary`→`MotifSummary`, `addTemplate`→`addMotif`, `listTemplates`→`listMotifs`; the `invoke("add_template"…)`→`invoke("add_motif"…)` call strings + `LayerParamsView` `"Template"`→`"Motif"`)
- `apps/desktop/src/render/sprite/TemplateSprite.ts` → rename file to `MotifSprite.ts`; class `TemplateSprite`→`MotifSprite`, `TemplateSpriteInit`→`MotifSpriteInit` (keep its imports from `../templates/*` as-is — deferred)
- `apps/desktop/src/render/Compositor.ts` (`ActiveTemplate`→`ActiveMotif`, `ensureTemplate`→`ensureMotif`, `updateTemplate`→`updateMotif`, the `kind === "Template"`→`"Motif"` branch, the `import { TemplateSprite }`→`MotifSprite`)
- `apps/desktop/src/templates/TemplatePicker.tsx` → rename file to `MotifPicker.tsx`; component + its importers
- The e2e hook `apps/desktop/src/testhook/e2eHook.ts` (`motifAddCountdown` currently invokes `add_template` → change to `add_motif`; any `TemplateView` refs)
- e2e specs referencing template commands/props (`template_prebake.e2e.js`, `motif_live_preview.e2e.js`) + any vitest referencing the renamed TS symbols

- [ ] **Step 1: Enumerate**

Run (repo root):
```
git grep -n "TemplateView\|TemplateSummary\|addTemplate\|listTemplates\|TemplateSprite\|ActiveTemplate\|ensureTemplate\|updateTemplate\|TemplatePicker\|add_template\|list_templates\|\"Template\"" -- apps/desktop/src apps/desktop/e2e
```
Expected: a bounded list. (Do NOT rename `render/templates/` internals — `getTemplate`, `Template`, `templateRaster`, `templateFrameDescriptor`, `frameCache`, prewarmer/baker, SVG files. `MotifSprite` continues to import those legacy names.)

- [ ] **Step 2: Rename the IPC layer** (`ipc/index.ts`): the view/summary types, the two fn names, the `invoke` command strings, and the `LayerParamsView` `"Template"`→`"Motif"` tag. Fix all importers the grep found.

- [ ] **Step 3: Rename the sprite** — `git mv apps/desktop/src/render/sprite/TemplateSprite.ts apps/desktop/src/render/sprite/MotifSprite.ts`; rename the class + init type inside; update `Compositor.ts`'s import + the `ActiveTemplate`/`ensureTemplate`/`updateTemplate`/`"Template"`-branch references.

- [ ] **Step 4: Rename the picker** — `git mv apps/desktop/src/templates/TemplatePicker.tsx apps/desktop/src/templates/MotifPicker.tsx`; rename the component; fix importers (the toolbar / wherever it's mounted — the grep shows it).

- [ ] **Step 5: Update e2e hook + specs** — in `e2eHook.ts`, `motifAddCountdown` calls `addMotif` (or `invoke("add_motif"…)`); update any `TemplateView`→`MotifView`. In the e2e specs, update any `add_template`/template-command references to the renamed ones (the props are already `accent` from the slice).

- [ ] **Step 6: Verify build + tests green**

Run (from `apps/desktop`): `npx tsc -b` → clean.
Run: `npx vitest run` (full unit suite, excluding `*.browser.test.ts` per the `test` script) → all pass. Fix remaining refs until green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src apps/desktop/e2e
git commit -m "refactor(motifs): rename TS product surface Template->Motif (ipc, sprite, compositor, picker, hooks)"
```

---

## Task 3: User-visible strings → "Motif"

**Files:** the MCP tool descriptions/titles for `add_motif`/`list_motifs` (`mcp/mod.rs`), the picker UI labels (`MotifPicker.tsx`), any menu/toolbar label that says "Template", and any i18n locale entries (`en-US`/`zh-CN`) keyed for the template feature. (Internal code comments referencing the deferred legacy machinery may keep saying "template".)

- [ ] **Step 1: Enumerate user-facing strings**

Run (repo root):
```
git grep -ni "template" -- apps/desktop/src/**/*.tsx apps/desktop/src/**/locales apps/desktop/src-tauri/src/mcp/mod.rs
```
Filter to USER-VISIBLE strings (UI text, MCP tool `description`/title, i18n values) — NOT the deferred internal symbol names (`getTemplate`, `templateRaster`, etc., which stay).

- [ ] **Step 2: Rename the user-visible strings** to "Motif" / "Motifs" (and the zh-CN equivalent — pick a consistent term, e.g. keep "模板" or adopt a Motif-equivalent; match the project's i18n policy). Update MCP tool descriptions so an agent reading the tool surface sees "motif".

- [ ] **Step 3: Verify** — `npx tsc -b` (from apps/desktop) clean; `cargo build …` green; `npx vitest run` green (a snapshot/test asserting a label may need updating).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop
git commit -m "refactor(motifs): user-visible strings Template->Motif (UI, MCP descriptions, i18n)"
```

---

## Task 4: End-to-end verification (runtime-consistent)

No new code — confirm the renamed surface works end to end in real WebView2 (the Rust↔TS contract is now consistent at the branch tip).

- [ ] **Step 1: Run the affected e2e specs**

Run (from `apps/desktop`, e2e build sets `VITE_WEFTCUT_E2E=1`; msedgedriver must match the WebView2 build, as the existing suite requires):
```
npm --prefix apps/desktop run e2e -- --spec e2e/specs/motif_live_preview.e2e.js --spec e2e/specs/template_prebake.e2e.js
```
Expected: both PASS — `motif_live_preview` proves a `add_motif`-added countdown still renders live via CDP; `template_prebake` proves the (renamed) prop-patch + bake path still works. If a spec name/hook still says "template" internally that's fine as long as it exercises the renamed commands.

- [ ] **Step 2: Full-suite sanity**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` and (from apps/desktop) `npx vitest run` and `npx tsc -b` → all green together. This is the branch-tip consistency gate.

- [ ] **Step 3: Commit (if any test-file tweaks were needed)**

```bash
git add apps/desktop
git commit -m "test(motifs): confirm renamed surface green end-to-end"
```

---

## Self-Review

**Spec coverage:** spec §2/§7 cutover for the product surface (data model, commands, MCP, ipc, sprite, compositor, picker, user strings) → Tasks 1–3; the deferred internal machinery (catalog/raster/cache/prewarmer/baker/SVG) is explicitly out of THIS plan (Stages 3–5), stated in Scope. No spec requirement for this stage is unaddressed.

**Placeholder scan:** the tasks are rename operations — the concrete content is the exact old→new symbol maps (Scope table) + the `git grep` enumerations + the exact verification commands. No "TBD"/"handle edge cases". The one judgement call (zh-CN term in Task 3) is flagged with the existing i18n-policy constraint, not left vague.

**Type/name consistency:** the old→new map is applied identically in Rust (Task 1) and TS (Task 2) — `MotifParams`/`motif_id`/`MotifView`/`add_motif`/`list_motifs`/`MotifSprite`/`MotifPicker` are used consistently across tasks. The serialized tag `"Motif"` is renamed on BOTH sides (Task 1 Rust view + Task 2 TS `LayerParamsView`), and Task 4 verifies the contract at runtime.

**Risk note (carry into execution):** the Rust↔TS runtime-inconsistency window between Task 1 and Task 2 is expected; the e2e gate is Task 4 (after both). The deferred `render/templates/` ↔ `render/motifs/` duality (two `catalog.ts`, the `getTemplate` import in `MotifSprite`) is intentional interim Frankenstein, resolved in Stages 3–5 — do not "fix" it here (renaming the legacy catalog now collides with Plan-1's `motifs/catalog.ts`).
