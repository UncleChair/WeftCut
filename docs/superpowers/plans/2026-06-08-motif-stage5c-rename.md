# Motifs Stage 5c — the Template→Motif rename + catalog unify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This is a PURE MECHANICAL RENAME — zero behavior change. The objective gate per slice is `npm run typecheck && npm test` (TS) / `cargo test` (Rust) staying green. The compiler guarantees completeness (a missed reference won't compile). Steps use checkbox syntax.

**Goal:** Erase the last of the legacy "Template" naming. Rename `Template*`→`Motif*` symbols, move `render/templates/`→`render/motifs/`, rename the `templateBakeStatusStore`, the `prebake_templates` setting, and the Rust `templates::` module → `motifs::catalog`, plus the 3 deferred Stage-1 Rust nits. Drop dead SVG-era catalog fields.

**Architecture:** Functionally complete already (all CDP). This stage is naming only. Execute as compile-green SLICES (rename a cohesive symbol group across ALL its occurrences per commit, so each commit builds). Review = self-verified diff + green gate (it's find-replace; reserve a reviewer only if a slice looks wrong).

**Decisions (locked):**
- Rename the persisted `prebake_templates` app-setting → `prebake_motifs` (Rust `app_settings` + TS + i18n key + usages; clean break to saved settings, fine pre-release).
- Rename the Rust `templates::` module → `motifs::catalog` (fold into the existing `motifs::` module) + the 3 Stage-1 nits + the stale doc.
- DROP the dead SVG-era catalog fields: `Template.html`, `Template.fonts`, `TemplateFont`, `TemplateEngine`/`engine` (never read after the SVG deletion) + delete the dead TS `render/templates/builtin/countdown/index.html` (only `manifest.json` is loaded).
- KEEP the `bake_*`/`warming` i18n string keys + values (they name real concepts — disk pre-bake + L0 warming — not the "template" noun). Only `prebake_templates`→`prebake_motifs` changes among i18n keys.
- KEEP names with no "template" in them: `LayerBakeStatus`, `useLayerBakePhase`, `setLayerBakeStatuses`, `motifWarmPhase`, `sharedBakedKeyIndex`, `BakedKeyIndex`, `bakeContentFrameFor`, `frameTimeSec`, `bakeMotifFrame`, `rasterMotifFrame`, `prebakeBus`, `bakePlan`, `prewarmPlan`, `pngEncode`.

---

## Rename mapping (the spec every slice follows)

**TS symbols** (rename across ALL of `apps/desktop/src` incl. tests + comments):
| From | To |
|---|---|
| `Template` (type, catalog.ts) | `Motif` |
| `TemplateManifest` | `MotifManifest` |
| `TemplateFont` | *(deleted — dead field)* |
| `TemplateEngine` / `engine?` field | *(deleted — dead field)* |
| `Template.html` / `Template.fonts` | *(deleted — dead fields)* |
| `getTemplate` | `getMotif` |
| `listTemplates` | `listMotifs` |
| `resolveTemplateContentDurationUs` | `resolveMotifContentDurationUs` |
| `TemplateFrameCache` | `MotifFrameCache` |
| `sharedTemplateFrameCache` | `sharedMotifFrameCache` |
| `TemplatePrewarmer` | `MotifPrewarmer` |
| `TemplateBaker` | `MotifBaker` |
| `TemplateBakeSpec` | `MotifBakeSpec` |
| `templateFrameDescriptor` / `TemplateFrameDescriptor` | `motifFrameDescriptor` / `MotifFrameDescriptor` |
| `templateDurationFrames` | `motifDurationFrames` |
| `templateContentFrame` | `motifContentFrame` |
| `resolveTemplateFrame` | `resolveMotifFrame` |
| `templateLayersToBake` | `motifLayersToBake` |
| `exportBakeTemplates` | `exportBakeMotifs` |
| `__weftcutTemplatePerf` | `__weftcutMotifPerf` |
| `useTemplateBakeStatusStore` | `useMotifBakeStatusStore` |
| `TemplatePreview` / `TemplateCardThumbnail` / `TemplateForm` (picker) | `MotifPreview` / `MotifCardThumbnail` / `MotifForm` |
| `installTemplateHarnessHook` (e2e) | `installMotifTestHooks` |
| `usePrebakeTemplatesEnabled` | `usePrebakeMotifsEnabled` |

**TS files moved** `render/templates/X` → `render/motifs/X` (all remaining): `catalog.ts`, `frameCache.ts`, `bakedKeyIndex.ts`, `bakePlan.ts`, `prewarmPlan.ts`, `prebakeBus.ts`, `templateRaster.ts`→`motifRasterCache.ts` (avoid confusion with the existing `motifRaster.ts`), `pngEncode.ts`, `Rasterizer.ts`, `TemplateBaker.ts`→`MotifBaker.ts`, `TemplatePrewarmer.ts`→`MotifPrewarmer.ts`, `templateFrames.ts`→`motifFrames.ts`, `templateFrameDescriptor.ts`→`motifFrameDescriptor.ts` (+ `__tests__/`), `builtin/countdown/manifest.json` (drop `index.html`). NOTE the collision guard: a file named `motifRaster.ts` ALREADY exists in `render/motifs/` (the CDP producer) — so `templates/templateRaster.ts` moves to `motifs/motifRasterCache.ts` (it's the cache+resolve module, not the raw producer).
Also `timeline/templateBakeStatusStore.ts` → `timeline/motifBakeStatusStore.ts`.

**Rust:** `src-tauri/src/templates/` → `src-tauri/src/motifs/catalog.rs` (or `motifs/catalog/`); update `lib.rs` mod decls + all `templates::` refs. The `prebake_templates` field in `app_settings.rs` → `prebake_motifs`. The 3 nits: `template_params_patch_rejects_kind_mismatch`→`motif_params_patch_rejects_kind_mismatch` (state/actor.rs), `ensure_template_target_track`→`ensure_motif_target_track` (mcp/mod.rs), the stale `templates/mod.rs` doc comment.

---

## Slice order (each = one subagent task, commit when green)

Baseline: `cd apps/desktop && npm run typecheck && npm test` + `cd apps/desktop/src-tauri && cargo test` green.

- [ ] **Slice 1 — catalog symbols + drop dead fields.** In `render/templates/catalog.ts`: rename `Template`→`Motif`, `TemplateManifest`→`MotifManifest`, `getTemplate`→`getMotif`, `listTemplates`→`listMotifs`, `resolveTemplateContentDurationUs`→`resolveMotifContentDurationUs`; DROP `TemplateFont`, the `engine?`/`TemplateEngine`, and the `html`/`fonts` fields + their `import.meta.glob` loading (keep `manifest.json` glob only). Delete the now-dead `render/templates/builtin/countdown/index.html`. Update ALL consumers (App.tsx, Compositor.ts, PropertyPanel.tsx, MotifSprite.ts, exportBake.ts, e2eHook.ts, templateFrameDescriptor.ts, ipc/index.ts `PropSpec` re-export, MotifPicker.tsx, + tests). Verify typecheck+vitest. Commit.

- [ ] **Slice 2 — render-pipeline symbols.** Rename across all src: `TemplateFrameCache`→`MotifFrameCache`, `sharedTemplateFrameCache`→`sharedMotifFrameCache`, `TemplatePrewarmer`→`MotifPrewarmer`, `TemplateBaker`→`MotifBaker`, `TemplateBakeSpec`→`MotifBakeSpec`, `templateFrameDescriptor`/`TemplateFrameDescriptor`→`motif*`, `templateDurationFrames`→`motifDurationFrames`, `templateContentFrame`→`motifContentFrame`, `resolveTemplateFrame`→`resolveMotifFrame`, `templateLayersToBake`→`motifLayersToBake`, `exportBakeTemplates`→`exportBakeMotifs`, `__weftcutTemplatePerf`→`__weftcutMotifPerf`. (Symbols only; files stay put — Slice 4 moves them.) Verify typecheck+vitest. Commit.

- [ ] **Slice 3 — status store + picker components + e2e hook name.** `useTemplateBakeStatusStore`→`useMotifBakeStatusStore`; picker `TemplatePreview`/`TemplateCardThumbnail`/`TemplateForm`→`Motif*`; e2e `installTemplateHarnessHook`→`installMotifTestHooks` (+ its `main.tsx` call). Verify typecheck+vitest. Commit.

- [ ] **Slice 4 — TS file moves** `render/templates/*`→`render/motifs/*` (per the mapping; `templateRaster.ts`→`motifs/motifRasterCache.ts`, `TemplateBaker.ts`→`MotifBaker.ts`, `TemplatePrewarmer.ts`→`MotifPrewarmer.ts`, `templateFrames.ts`→`motifFrames.ts`, `templateFrameDescriptor.ts`→`motifFrameDescriptor.ts`, others keep base name) + `timeline/templateBakeStatusStore.ts`→`motifBakeStatusStore.ts` + `builtin/countdown/manifest.json`. Use `git mv`; update EVERY import path. Verify typecheck+vitest. Commit. (After this, `render/templates/` should be empty/removed.)

- [ ] **Slice 5 — `prebake_templates`→`prebake_motifs` setting (cross-language, atomic).** Rust `app_settings.rs` struct field + serde; TS `appSettingsStore.ts` `AppSettings` field + `usePrebakeTemplatesEnabled`→`usePrebakeMotifsEnabled`; the Compositor read; the i18n key `settings.prebake_templates`→`prebake_motifs` (en-US + zh-CN); SettingsPanel + any other `prebake_templates` reference. Verify typecheck+vitest+cargo. Commit.

- [ ] **Slice 6 — Rust `templates::`→`motifs::catalog` + 3 nits + doc.** Move `src-tauri/src/templates/` into `motifs::catalog`; update `lib.rs` mod decls + all `templates::` refs. Rename test fn `template_params_patch_rejects_kind_mismatch`→`motif_*` (state/actor.rs), `ensure_template_target_track`→`ensure_motif_target_track` (mcp/mod.rs), fix the stale `templates/mod.rs` doc. Verify cargo test. Commit.

- [ ] **Slice 7 — verify.** Full gate (`npm run typecheck && npm test`; `cargo test`) + a grep sweep for residual `\bTemplate|templates/|template[A-Z]` in `apps/desktop/src` + `templates::|template_` in `src-tauri/src` (expect only legit hits like `<template>` HTML or unrelated words). Optionally run an e2e (e.g. `motif_live_preview.e2e.js`) to confirm nothing broke at runtime.

---

## Completion
Use **superpowers:finishing-a-development-branch** → merge to local `main` (ff) → push to origin. Update memory: Stage 5c done; Motifs migration COMPLETE; remaining = Plan 4 (upload security) + multi-Motif host navigation.

## Notes / hazards
- `String.raw` literals (`MOTIF_RUNTIME_SOURCE` in runtime.ts) — no backtick hazard from renames (no backticks added), but don't rename inside the embedded JS unless it's a real symbol.
- Watch for `template` as a plain English word in comments/strings (e.g. "templated", or unrelated) — don't blindly sed; the rename targets the specific symbols above. The compiler won't catch an over-eager comment edit, but it's harmless.
- `PropSpec` is shared (catalog.ts + ipc re-export) — keep the name (it's generic, not "Template").
- The existing `render/motifs/motifRaster.ts` (CDP producer) must NOT be confused with the moved `templateRaster.ts` (cache+resolve) → the latter becomes `motifRasterCache.ts`.
