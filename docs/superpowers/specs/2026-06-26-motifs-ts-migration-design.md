# Motifs → TypeScript migration

**Date:** 2026-06-26
**Status:** approved (brainstorming)
**Goal:** Move the entire Motifs "brain" from Rust to TypeScript and **delete the Rust `motifs` Cargo feature entirely**, so the native crate ends with zero motif knowledge.

This completes the Rust→TS migration arc: with the state actor already in TS (sole writer) and Rust reduced to compute + read-mirror, the Motifs subsystem is the last large block of motif-specific Rust. Once ported, the `motifs` feature, its napi methods, the read-mirror round-trip for motif compute, and the DUAL-MANIFEST gotcha all disappear.

---

## 1. Scope

### 1.1 End state

- No `native/src/motifs/` module, no `native/src/commands/motif*.rs`.
- No motif napi methods (`motifResolveFile`, `motifCtxDurationS`, `computeMotifRebind`, `computeAckMotifRebind`).
- No `motifs` Cargo feature; no `#[cfg(feature = "motifs")]` arms.
- Motif MCP tool defs + the `motifs://current` resource originate from the **TS** MCP surface.
- The `motif://` protocol is served entirely from TS (built-in assets + the TS user store).
- On-disk user store layout at `<config>/motifs/` is **unchanged** — existing user motifs/drafts keep working with no migration step.

### 1.2 Already in TS (do NOT re-port)

`src/shared/motifs/catalog.ts` (built for the Phase 4a-ii differential gate) already mirrors Rust byte-for-byte:

- `PropSpec`, `Manifest` types; `MotifPropError`.
- `canonicalizeProps` / `canonicalizePropsLenient`.
- `resolveMotifMaxDurUs` (layer cap), `resolveMotifTEndUs` (`add_motif` end), `resolveMotifContentDurationUs` (seek span).
- `BUILTIN_MANIFESTS` (imported from `src/shared/motifs/builtin/<id>/manifest.json`), `MotifCatalog` class.

The renderer render/bake/raster path (`src/renderer/render/motifs/*`), the capture driver (`src/main/motif/capture.ts`), the `motif://` protocol handler shell (`src/main/motif/protocol.ts`), the `add_motif`/`rebind_motif` state mutations (`src/main/state/mutations/motif.ts`), and the UI (`MotifPicker.tsx`, `MotifStaleDialog.tsx`) are all already TS and stay.

### 1.3 Genuinely Rust-only — the actual port

| Rust source | Ported to |
|---|---|
| `catalog.rs`: `parse_manifest_island`, `validate_manifest`, `validate_default_for` | `src/shared/motifs/catalog.ts` (pure) |
| `authoring.rs`: `compose_motif_html`, `strip_manifest_island`, `sanitize_id`, `assign_unique_id` | `src/shared/motifs/catalog.ts` (pure) |
| `catalog.rs`: `content_hash` (blake3) | `src/main/motif/contentHash.ts` (Node `crypto`, **sha256**) |
| `catalog.rs`: `motif_ctx_duration_s` | `src/shared/motifs/catalog.ts` (`motifCtxDurationS`, seconds, default fallback) |
| `store.rs`: `UserMotifStore` | `src/main/motif/store.ts` |
| `authoring_commands.rs`: write/amend/create-edit/import/install-compute/delete cores, `build_rebind_updates` | `src/main/motif/authoring.ts` |
| `staleness.rs`: `current_versions`, `build_staleness_report`, `build_ack_entries` | `src/main/motif/staleness.ts` |
| `watcher.rs`: `notify` watcher + debounce | `src/main/motif/watcher.ts` (Node `fs.watch`) |
| `builtin.rs`: built-in served bytes (`index.html` + fonts), `resolve_bytes`, `content_type_for` | `src/main/motif/builtinAssets.ts` + relocated assets |
| `commands/motifs.rs`: `motif_to_payload`, `list_motifs` | `src/main/motif/catalog-payload` (in `authoring.ts` or a small module) |
| MCP tool defs (`mcp/catalog.rs`) + `motifs://current` resource (`mcp/resources.rs`) | TS `MCP_TOOL_DEFS` + TS resource list |

Out of scope: none requested — full port. `preview_motif_draft` stays exactly as-is (already TS capture).

---

## 2. Module layout & ownership

- **`src/shared/motifs/catalog.ts`** (extend the existing file): add the **pure, Node-free** functions — `parseManifestIsland`, `composeMotifHtml`/`stripManifestIsland`, `sanitizeId`/`assignUniqueId`, `validateManifest`/`validateDefaultFor`, `motifCtxDurationS`. Stays importable by both main and renderer (the renderer's draft editor needs island-parse/compose). `BUILTIN_IDS` constant added here.
- **`src/main/motif/` (new):**
  - `store.ts` — `UserMotifStore` (Node `fs`, path-safety, drafts, install/delete/list/target sidecar).
  - `authoring.ts` — lifecycle cores + `buildRebindUpdates` + `list_motifs` payload assembly (`motifToPayload`).
  - `staleness.ts` — `currentVersions`/`buildStalenessReport`/`buildAckEntries`.
  - `watcher.ts` — Node watcher emitting `motifs:changed`.
  - `contentHash.ts` — sha256 over canonical manifest JSON + html (Node `crypto`).
  - `builtinAssets.ts` — built-in served-byte registry + `resolveMotifFile(id, rest)` (built-ins first, then `store.readFile`), `contentTypeFor`.
- **Re-pointed (existing):** `protocol.ts` calls `resolveMotifFile` instead of `backend.motifResolveFile`; `capture.ts` calls `motifCtxDurationS` instead of `backend.motifCtxDurationS`.

`content_hash` is **main-only** (Node `crypto` is unavailable in the renderer bundle). The renderer only ever consumes the hash value in the `list_motifs` payload; it never computes it.

---

## 3. Built-in served assets

Today: built-in `index.html` + `Inter.woff2` are `include_bytes!`-embedded in Rust; manifests are duplicated in both `native/.../catalog/<id>/manifest.json` **and** `src/shared/motifs/builtin/<id>/manifest.json` (the DUAL-MANIFEST gotcha).

Plan: relocate each built-in's `index.html` + `assets/` into `src/shared/motifs/builtin/<id>/`, beside its already-present `manifest.json` — making that folder the **single source per built-in**. `builtinAssets.ts` loads them via electron-vite imports: `?raw` for `index.html`, `?asset` for fonts (the bundler resolves dev/prod paths). The DUAL-MANIFEST gotcha is retired (only the TS manifest remains).

`resolveMotifFile(id, rest)`: embedded built-in wins; else `store.readFile(id, rest)` (published copy, then draft fallback — port `read_file`'s semantics verbatim). `contentTypeFor` ports the extension table verbatim. Path-safety (`safeSeg`/`safeRel`) ports verbatim: reject empty / `.` / `..` / `/` / `\` / `:`. **Phase 1 must verify on a packaged build**, not just dev, that `?raw`/`?asset` resolve.

---

## 4. content_hash

`contentHash.ts`: `sha256( canonicalManifestJSON ‖ \0 ‖ html ‖ \0 )` as lowercase hex, where `canonicalManifestJSON` is the manifest serialized with **sorted keys** for stability. Same role as the Rust blake3 hash: the capture host `?v=` cache-buster and the raster-cache identity, surfaced in the `list_motifs` payload's `content_hash` field.

**Hash only the core manifest fields** — the ones that live in the on-disk island (`id`, `name`, `version`, `size`, `default_duration_s`, `max_duration_s`, `max_duration_prop`, `content_duration_s`, `fonts`, `props_schema`). The TS `Manifest` interface also carries payload-decoration fields (`status`, `content_hash`, `target_id`, `settle_rafs`) that must be **excluded**, or the hash becomes unstable. Pick the core subset explicitly rather than serializing the whole object.

The hash *value* changes once vs. blake3 → a one-time, harmless re-bake of any cached frames. Capture byte-determinism is a property of the capture pipeline (unchanged), not the hash.

---

## 5. Collapsing the compute hybrids

`install_motif` and `acknowledge_motif_staleness` are today the `hybrid` route: `server.ts` → `runHybrid` → `backend.computeMotifRebind` / `computeAckMotifRebind`, which read the **read-mirror** snapshot in Rust and return `MotifRebindEntry[]`; the TS host then dispatches `rebind_motif`.

After the port, `authoring.ts`/`staleness.ts` read the **live in-memory TS project** (via the actor/host) directly and produce the same `MotifRebindEntry[]`, applied by the existing `rebind_motif` mutation. The motif read-mirror round-trip is deleted. These two tools move from `hybrid` to pure-`ts`.

`build_rebind_updates` (lenient prop migration onto the target's new schema) and `build_ack_entries` port verbatim, reusing `canonicalizePropsLenient` from shared.

---

## 6. MCP rewiring

- Move the motif tool defs (descriptions + arg schemas) from `mcp/catalog.rs` into TS `MCP_TOOL_DEFS`: `list_motifs`, `get_motif_source`, `write_motif_draft`, `amend_motif_draft`, `create_edit_draft`, `import_motif`, `delete_motif`, `install_motif`, `acknowledge_motif_staleness`, `motif_staleness_report`. (`preview_motif_draft` already special-cased in `server.ts`.)
- `routeMcpTool`: all motif tools → `ts` (reads + mutations handled in the TS host / `server.ts`); `install_motif` + `acknowledge_motif_staleness` drop from `hybrid`.
- Move the `motifs://current` resource (catalog list, html stripped) to the TS resource list.
- `mergeMcpCatalog(rust, MCP_TOOL_DEFS)` keeps working; motif entries now come from the TS side and are removed from the Rust catalog.
- Update the catalog-bijection / tool-table tests to expect the motif tools on the TS side.

---

## 7. The four phases (each ships green)

1. **Data layer.** Add island-parse/compose/validate/id/`motifCtxDurationS` to `shared/catalog.ts`; add `store.ts` + `contentHash.ts` + `builtinAssets.ts`; relocate built-in assets into `shared/motifs/builtin/<id>/`; re-point `protocol.ts` and `capture.ts`'s duration call to TS. **Rust untouched and still authoritative for MCP/authoring.** Verify: protocol serves built-ins + user motifs from TS; capture duration matches Rust.
2. **Catalog read + authoring.** `list_motifs` payload + authoring cores in `authoring.ts`; route the 8 read/lifecycle tools `ts`; collapse the two compute hybrids to pure-TS. Rust authoring now dead code.
3. **Staleness + watcher.** `staleness.ts` + Node `watcher.ts` (emits `motifs:changed`); wire the on-open staleness report + ack to the TS path.
4. **Delete Rust.** Remove `motifs/`, `commands/motif*`, the 4 napi methods, the `motifs` Cargo feature, the motif MCP catalog/resource arms. Drop the duplicated `native/.../catalog/` assets.

---

## 8. Error handling & parity

- Rust `MotifError` / `Result<_, String>` map to the existing `MotifPropError` and thrown `Error`s. `server.ts`'s envelope mapper already turns thrown errors into `{ok:false, error:{code,message}}`; reuse it.
- Validation rejection sets port verbatim: `validate_manifest` (empty name, size bounds `[1,8192]`, finite-positive durations, ≤64 props, number min≤max, finite number defaults, `validate_default_for` per prop), hex-color regex, enum membership, string `max_length` counted as Unicode scalar values.
- Path-safety identical to `store.rs` so `motif://` byte-serving can never escape a motif directory.
- The `motifs:changed` event name and emit points (write/amend/install/delete + watcher) are preserved.

---

## 9. Testing

- **Reuse cross-language goldens.** The existing PropSpec/canonicalization differential fixtures pin TS↔Rust parity. For the newly-ported pure functions (island-parse, compose, validate_manifest, sanitize/assign-id), capture golden fixtures from **current Rust output before deletion** and assert the TS port against them.
- **Port the Rust unit suites near-verbatim** into vitest:
  - `store.ts`: drafts write/list/get, install (new + overwrite/update), delete (published + draft), path-traversal rejection, target sidecar round-trip, missing-root-is-empty, reserved `drafts` id blocked.
  - `authoring.ts`: write (unique final-ready id, version forced to 1), amend (id forced, body preserved), create-edit (built-in records no target; installed records target), import (mints fresh id, ignores claimed id), install-compute (new vs update rebind), `buildRebindUpdates` (retarget draft+target layers, lenient migrate).
  - `staleness.ts`: report grouping/min-placed/skip-equal-and-unknown/deterministic order/downgrades; ack bumps only stale, keeps props.
  - `watcher.ts`: debounce coalescing (injected events, mirroring the Rust debounce test).
- **e2e** (existing Playwright `_electron` harness): place → install → update-rebind → on-open staleness path on the TS surface; capture determinism (already TS) unchanged.

---

## 10. Risks

- **Watcher on Linux.** Node `fs.watch({recursive:true})` is Windows/macOS-only (the ship targets). Use recursive there; on Linux dev, fall back to per-subdir watches over the shallow `<root>/<id>/...` tree. Debounce logic is unit-tested independently of the OS watch.
- **Built-in asset bundling.** `?raw`/`?asset` must resolve in the **packaged** app, not just dev — gated in Phase 1.
- **MCP catalog drift.** The bijection/tool-table tests must be updated in lockstep with moving motif defs to TS, or they fail closed (acceptable — they catch exactly this).
- **Read-mirror removal.** Confirm no non-motif consumer depends on the motif compute methods before deleting them (grep shows only `hybrids.ts`/`index.ts` wiring).
