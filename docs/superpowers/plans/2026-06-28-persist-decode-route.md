# Persist the Decode Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-source Decode Route a persisted, typed source of truth so illegal flag/path combinations are unrepresentable and the ~17 ad-hoc route readers collapse into one resolver.

**Architecture:** Replace `MediaItem`'s four flat routing fields (`proxy_bypassed`, `export_uses_original`, `proxy_path`, `quick_proxy_path` + `proxy_format_version`) with a single three-variant `DecodeRoute` enum whose variants *fold in* their readiness paths (`Bypass` | `DirectExport{quick}` | `Proxied{quick, full, version}`). Rust decides + writes the route; one pure TS `resolveDecode(media)` reads it; a thin TS session overlay layers the machine-specific decode bridge on top. The on-disk shape changes, so `SCHEMA_VERSION` bumps and pre-v10 projects are rejected (cut-over, no migration).

**Tech Stack:** Rust (napi core, serde), TypeScript (renderer + Electron main), vitest, cargo test.

## Global Constraints

- **Schema is cut-over, not migrated.** Bump `SCHEMA_VERSION` (native/src/state/project.rs:23) from `9` to `10`. Below-version projects are rejected with re-create guidance; no carry-forward code.
- **Enum wire form is kebab-case strings** `bypass` / `direct-export` / `proxied`, internally tagged on a `route` key. Locked by a golden asserted on both sides.
- **The route enum is hand-mirrored Rust↔TS** (consistent with the rest of the data model). It is NOT put in the `weftcut-eval` leaf — there is no shared *logic* twin, only a type.
- **`decide()` / `job_for` / route-correction stay Rust-only; `resolveDecode` / `importStatus` stay TS-only.** Never reconstruct the route from individual paths once the enum exists.
- **No `#[serde(default)]` on `decode_route`** — it is required at v10 (back-compat is handled by the schema gate, not by field defaults).
- **TDD, DRY, YAGNI, frequent commits.** Behavior of the import dialog (its six `OptimizeStatus` states + UX) is FROZEN — deepen the implementation, don't change what the user sees.
- **Commit directly on `main`** (no other work in flight).
- Test commands: TS `npx vitest run <file>`; typecheck `npm run typecheck`; Rust `cargo test --manifest-path native/Cargo.toml`. Run all from `apps/desktop/`.

---

## File Structure

**New files**
- `apps/desktop/native/src/state/decode_route.rs` — the Rust `DecodeRoute` enum + `route_corrected()` + decision-mapping helpers.
- `apps/desktop/src/renderer/render/decodeRoute.ts` — the TS `DecodeRoute` type + pure `resolveDecode` + session overlay `previewPathLive`.
- `apps/desktop/src/renderer/render/decodeRoute.test.ts` — exhaustive `resolveDecode` table test + overlay tests.
- `apps/desktop/src/renderer/render/decodeRouteWireGolden.fixture.json` — the three wire strings, asserted by both languages.

**Modified files**
- `native/src/state/media.rs` — `MediaItem`: five fields → one `decode_route`.
- `native/src/state/command.rs` — `MediaDerivativesPatch`: route fields → fold signals.
- `native/src/state/mod.rs` / `project.rs` — re-export `DecodeRoute`; bump `SCHEMA_VERSION`.
- `native/src/jobs/mod.rs` — decision site + quick/full proxy commit sites emit fold signals.
- `native/src/commands/media.rs` — `ensure_full_proxy` emits `route_corrected`.
- `native/src/napi_backend.rs` — stale-proxy invalidation reads/clears via the variant.
- `native/src/preview/mod.rs` — DELETE dead `with_proxies_substituted`.
- `apps/desktop/src/main/state/model.ts` — TS `MediaItem` mirror.
- `apps/desktop/src/main/state/mutations/media.ts` — `MediaDerivativesPatch` mirror + `applySetMediaDerivatives` fold logic + `mediaItemTemplate`.
- `apps/desktop/src/main/state/summary.ts` — `MediaSummary` builder copies `decode_route`.
- `apps/desktop/src/renderer/ipc/index.ts` — `MediaSummary` type mirror.
- `apps/desktop/src/renderer/state/projectStore.ts` — delete `previewPlaybackPathFor`/`exportPlaybackPathFor`; re-point callers at `resolveDecode`.
- `apps/desktop/src/renderer/render/exportReadiness.ts` — gate predicates become filters over `resolveDecode`.
- `apps/desktop/src/renderer/panels/importOptimize.ts` — `importOptimizeStatus` rewritten over `resolveDecode` (UX frozen).
- `docs/data-model.md` — MediaItem section + proxy-axes prose.

---

## Phase A — The type and its wire lock

### Task 1: Define the Rust `DecodeRoute` enum + wire golden + schema bump

**Files:**
- Create: `apps/desktop/native/src/state/decode_route.rs`
- Create: `apps/desktop/src/renderer/render/decodeRouteWireGolden.fixture.json`
- Modify: `apps/desktop/native/src/state/mod.rs` (re-export), `apps/desktop/native/src/state/project.rs:23` (bump)
- Test: inline `#[cfg(test)]` in `decode_route.rs`

**Interfaces:**
- Produces: `enum DecodeRoute { Bypass, DirectExport { quick_proxy: Option<PathBuf> }, Proxied { quick_proxy: Option<PathBuf>, full_proxy: Option<PathBuf>, format_version: u32 } }`; `DecodeRoute::route_corrected(self) -> DecodeRoute`; `DecodeRoute::from_proxy_route(route: ProxyRoute) -> DecodeRoute`.

- [ ] **Step 1: Write the wire golden fixture**

Create `apps/desktop/src/renderer/render/decodeRouteWireGolden.fixture.json`:

```json
{
  "tags": ["bypass", "direct-export", "proxied"],
  "samples": {
    "bypass": { "route": "bypass" },
    "direct-export": { "route": "direct-export", "quick_proxy": null },
    "proxied": { "route": "proxied", "quick_proxy": null, "full_proxy": null, "format_version": 0 }
  }
}
```

- [ ] **Step 2: Write the failing Rust enum + golden test**

Create `apps/desktop/native/src/state/decode_route.rs`:

```rust
//! The per-source Decode Route — where preview and export each read pixels.
//! Persisted as the source of truth (replaces the old flat proxy flags). The
//! readiness paths live INSIDE the variants so a route↔path contradiction
//! (a Bypass carrying a proxy) is unrepresentable. See docs/adr/0028 and CONTEXT.md.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::jobs::proxy_decision::{ExportSource, PreviewSource, ProxyRoute};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "route", rename_all = "kebab-case")]
pub enum DecodeRoute {
    /// Preview + export both decode the original. No proxy.
    Bypass,
    /// Export decodes the original; preview decodes the quick proxy
    /// (`None` until it lands).
    DirectExport {
        #[serde(default)]
        quick_proxy: Option<PathBuf>,
    },
    /// Preview decodes the quick proxy; export decodes the full export master.
    Proxied {
        #[serde(default)]
        quick_proxy: Option<PathBuf>,
        #[serde(default)]
        full_proxy: Option<PathBuf>,
        #[serde(default)]
        format_version: u32,
    },
}

impl DecodeRoute {
    /// The initial variant for a freshly-decided import (no derivatives yet).
    pub fn from_proxy_route(route: ProxyRoute) -> Self {
        match (route.export, route.preview) {
            (ExportSource::Original, PreviewSource::Original) => DecodeRoute::Bypass,
            (ExportSource::Original, PreviewSource::Proxy) => {
                DecodeRoute::DirectExport { quick_proxy: None }
            }
            (ExportSource::FullProxy, PreviewSource::Proxy) => DecodeRoute::Proxied {
                quick_proxy: None,
                full_proxy: None,
                format_version: 0,
            },
            (ExportSource::FullProxy, PreviewSource::Original) => {
                unreachable!("preview=Original implies export=Original")
            }
        }
    }

    /// Export-decode failed on this machine → become Proxied, carrying any
    /// quick proxy already produced. Bypass/Proxied are unchanged.
    pub fn route_corrected(self) -> Self {
        match self {
            DecodeRoute::DirectExport { quick_proxy } => DecodeRoute::Proxied {
                quick_proxy,
                full_proxy: None,
                format_version: 0,
            },
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Golden {
        tags: Vec<String>,
        samples: std::collections::BTreeMap<String, serde_json::Value>,
    }

    fn golden() -> Golden {
        // Same relative-path convention the roleGate/snapFrame Rust golden
        // tests use to read their TS-colocated fixtures.
        let raw = include_str!(
            "../../../src/renderer/render/decodeRouteWireGolden.fixture.json"
        );
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn wire_tags_match_golden() {
        let g = golden();
        assert_eq!(g.tags, vec!["bypass", "direct-export", "proxied"]);
        let bypass = serde_json::to_value(DecodeRoute::Bypass).unwrap();
        assert_eq!(bypass, g.samples["bypass"]);
        let de = serde_json::to_value(DecodeRoute::DirectExport { quick_proxy: None }).unwrap();
        assert_eq!(de, g.samples["direct-export"]);
        let px = serde_json::to_value(DecodeRoute::Proxied {
            quick_proxy: None,
            full_proxy: None,
            format_version: 0,
        })
        .unwrap();
        assert_eq!(px, g.samples["proxied"]);
    }

    #[test]
    fn route_correct_promotes_direct_export_carrying_quick() {
        let q = Some(PathBuf::from("q.mp4"));
        assert_eq!(
            DecodeRoute::DirectExport { quick_proxy: q.clone() }.route_corrected(),
            DecodeRoute::Proxied { quick_proxy: q, full_proxy: None, format_version: 0 }
        );
        assert_eq!(DecodeRoute::Bypass.route_corrected(), DecodeRoute::Bypass);
    }
}
```

Add to `apps/desktop/native/src/state/mod.rs` (near the other `pub use`/`mod` lines):

```rust
mod decode_route;
pub use decode_route::DecodeRoute;
```

- [ ] **Step 3: Run the test to verify it fails (module not yet wired)**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs decode_route`
Expected: COMPILE error or FAIL until `mod decode_route;` is added and `proxy_decision` types are `pub` (they already are).

- [ ] **Step 4: Bump the schema version**

Edit `apps/desktop/native/src/state/project.rs:23`: `pub const SCHEMA_VERSION: u32 = 9;` → `= 10;`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs decode_route`
Expected: PASS (`wire_tags_match_golden`, `route_correct_promotes_direct_export_carrying_quick`).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/src/state/decode_route.rs apps/desktop/native/src/state/mod.rs apps/desktop/native/src/state/project.rs apps/desktop/src/renderer/render/decodeRouteWireGolden.fixture.json
git commit -m "feat(decode-route): add DecodeRoute enum + wire golden, bump schema v10"
```

### Task 2: Mirror the `DecodeRoute` type in TypeScript + assert the same wire golden

**Files:**
- Create (type only, in) `apps/desktop/src/renderer/render/decodeRoute.ts`
- Test: `apps/desktop/src/renderer/render/decodeRoute.test.ts`

**Interfaces:**
- Produces: `type DecodeRoute = { route: 'bypass' } | { route: 'direct-export'; quick_proxy: string | null } | { route: 'proxied'; quick_proxy: string | null; full_proxy: string | null; format_version: number }`.

- [ ] **Step 1: Write the failing wire-golden test**

Create `apps/desktop/src/renderer/render/decodeRoute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import golden from "./decodeRouteWireGolden.fixture.json";
import type { DecodeRoute } from "./decodeRoute";

describe("DecodeRoute wire shape", () => {
  it("matches the cross-language golden tags", () => {
    expect(golden.tags).toEqual(["bypass", "direct-export", "proxied"]);
  });
  it("type literals construct each sample", () => {
    const bypass: DecodeRoute = { route: "bypass" };
    const de: DecodeRoute = { route: "direct-export", quick_proxy: null };
    const px: DecodeRoute = {
      route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0,
    };
    expect(bypass).toEqual(golden.samples.bypass);
    expect(de).toEqual(golden.samples["direct-export"]);
    expect(px).toEqual(golden.samples.proxied);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/render/decodeRoute.test.ts`
Expected: FAIL — `./decodeRoute` has no `DecodeRoute` export yet.

- [ ] **Step 3: Add the type**

Create `apps/desktop/src/renderer/render/decodeRoute.ts`:

```ts
// The per-source Decode Route — persisted source of truth, hand-mirrored from
// the Rust enum (native/src/state/decode_route.rs). Variants fold in their
// readiness paths so route↔path contradictions are unrepresentable.
// See docs/adr/0028 and CONTEXT.md. resolveDecode (below) is added in Task 8.

export type DecodeRoute =
  | { route: "bypass" }
  | { route: "direct-export"; quick_proxy: string | null }
  | {
      route: "proxied";
      quick_proxy: string | null;
      full_proxy: string | null;
      format_version: number;
    };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/render/decodeRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decodeRoute.ts apps/desktop/src/renderer/render/decodeRoute.test.ts
git commit -m "feat(decode-route): mirror DecodeRoute type in TS + wire golden assert"
```

---

## Phase B — Fold the route into the persisted model

### Task 3: Replace `MediaItem`'s flat routing fields with `decode_route` (Rust)

**Files:**
- Modify: `apps/desktop/native/src/state/media.rs:20-41` (remove 5 fields, add 1), `:113-142` (the test)
- Modify: every `MediaItem { … }` literal that set the removed fields — `native/src/export/mod.rs:559-563`, `native/src/jobs/frame.rs:173-248`, `native/src/jobs/conform.rs:243-247`, `native/src/jobs/proxy.rs` (test literals at 203-207, 317-322, 436-440, 516-521, 576-580)

**Interfaces:**
- Consumes: `DecodeRoute` (Task 1).
- Produces: `MediaItem.decode_route: DecodeRoute` (replaces `proxy_path`, `proxy_format_version`, `quick_proxy_path`, `proxy_bypassed`, `export_uses_original`).

- [ ] **Step 1: Edit `MediaItem`**

In `native/src/state/media.rs`, delete lines 20-41 (the `proxy_path` … `export_uses_original` block) and replace with:

```rust
    /// Where preview and export each decode this source from, plus the
    /// readiness of any proxy. Replaces the former flat proxy flags. v10.
    pub decode_route: DecodeRoute,
```

Add the import at the top: `use super::decode_route::DecodeRoute;`

- [ ] **Step 2: Replace the back-compat unit test**

Replace the `tests` module in `media.rs` (lines 113-142) with a round-trip assertion on the new field:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_item_round_trips_decode_route() {
        let json = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "label": null, "path_abs": "clip.mp4", "path_rel": null, "kind": "Video",
            "metadata": { "duration_us": null, "video": null, "audio": null },
            "decode_route": { "route": "direct-export", "quick_proxy": null },
            "waveform_path": null, "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": "abc", "file_size": 1, "file_mtime": 0,
            "imported_at": "2026-05-29T00:00:00Z"
        });
        let item: MediaItem = serde_json::from_value(json).unwrap();
        assert_eq!(item.decode_route, DecodeRoute::DirectExport { quick_proxy: None });
    }
}
```

- [ ] **Step 3: Fix every `MediaItem` literal (compile-driven)**

Run the compiler to list every broken literal:

Run: `cargo build --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud`
Expected: errors at each `MediaItem { … }` that named the removed fields (the sites listed under Files).

At each site, delete the five removed field initializers and add one. For a non-video / bypass fixture use `decode_route: DecodeRoute::Bypass,`; for the proxy-job test fixtures that asserted a generated proxy, use the variant the test intends (`DecodeRoute::Proxied { quick_proxy: None, full_proxy: None, format_version: 0 }`). Import `crate::state::DecodeRoute` in each test module.

- [ ] **Step 4: Verify it compiles + the round-trip test passes**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud media_item_round_trips_decode_route`
Expected: PASS, no compile errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src
git commit -m "refactor(decode-route): MediaItem holds decode_route, drop flat proxy flags (Rust)"
```

### Task 4: Mirror in the TS model, summary, and IPC type

**Files:**
- Modify: `apps/desktop/src/main/state/model.ts:90-95` (MediaItem)
- Modify: `apps/desktop/src/main/state/summary.ts` (the `decode_route` copy; near the old proxy-field copy ~line 191)
- Modify: `apps/desktop/src/renderer/ipc/index.ts:44-54` (MediaSummary)
- Modify: `apps/desktop/src/main/state/mutations/media.ts:34-44` (`mediaItemTemplate`)

**Interfaces:**
- Consumes: `DecodeRoute` (Task 2).
- Produces: `MediaItem.decode_route: DecodeRoute` and `MediaSummary.decode_route: DecodeRoute`.

- [ ] **Step 1: Update `model.ts`**

In `apps/desktop/src/main/state/model.ts`, in the `MediaItem` interface, delete the `proxy_path` / `quick_proxy_path` / `proxy_bypassed` / `export_uses_original` / `proxy_format_version` members (lines 92-93) and add:

```ts
  decode_route: DecodeRoute
```

Add `import type { DecodeRoute } from '../../renderer/render/decodeRoute'` at the top. (If main↔renderer import boundaries forbid this, re-declare the identical union in `apps/desktop/src/shared/` and import from there in both places — keep ONE definition.)

- [ ] **Step 2: Update the IPC `MediaSummary` type**

In `apps/desktop/src/renderer/ipc/index.ts`, delete lines 44-54 (`proxy_path` … `export_uses_original`) and add:

```ts
  /// Where preview/export decode from + proxy readiness. See decodeRoute.ts.
  decode_route: DecodeRoute;
```

Import `DecodeRoute` from `../render/decodeRoute`.

- [ ] **Step 3: Update the summary builder + the template**

In `apps/desktop/src/main/state/summary.ts`, replace the four flat-field copies with `decode_route: item.decode_route,`.

In `apps/desktop/src/main/state/mutations/media.ts:41`, replace
`proxy_path: null, quick_proxy_path: null, proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0,`
with `decode_route: { route: 'bypass' },` (the safe default for a bare template; video imports set the real route via the decision patch).

- [ ] **Step 4: Typecheck (expect downstream reader errors — that's the map for Phase D)**

Run: `npm run typecheck`
Expected: errors ONLY in the route readers (`projectStore.ts`, `exportReadiness.ts`, `importOptimize.ts`) — these are fixed in Phase D. Confirm no errors elsewhere.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/model.ts apps/desktop/src/main/state/summary.ts apps/desktop/src/renderer/ipc/index.ts apps/desktop/src/main/state/mutations/media.ts
git commit -m "refactor(decode-route): MediaItem/MediaSummary carry decode_route (TS)"
```

---

## Phase C — Decision → variant, and the async fold

### Task 5: Map the import decision to an initial `DecodeRoute` and emit it (Rust)

**Files:**
- Modify: `apps/desktop/native/src/jobs/mod.rs:337-425` (the `decide` → `job_for` match)
- Modify: `apps/desktop/native/src/state/command.rs:149-179` (`MediaDerivativesPatch` — done fully in Task 6; here only `set_route` is consumed)

**Interfaces:**
- Consumes: `DecodeRoute::from_proxy_route` (Task 1), `MediaDerivativesPatch.set_route` (Task 6).
- Produces: every import path commits an explicit initial route.

> Depends on Task 6's patch shape. Implement Task 6 first, then this. (Listed in decision order; execute 6 → 5 or fold into one commit.)

- [ ] **Step 1: Rewrite the three decision branches**

In `jobs/mod.rs`, replace the `match proxy_decision::job_for(route) { … }` body so each branch first commits `set_route` with the initial variant, then spawns its jobs:

```rust
let route = proxy_decision::decide(&media, source_gop_secs);
let initial = crate::state::DecodeRoute::from_proxy_route(route);
let patch = MediaDerivativesPatch { set_route: Some(initial), ..Default::default() };
if let Err(e) = commit_media_derivatives(&events, media_id, patch).await {
    warn!("route decision commit failed for {media_id}: {e}");
}
match proxy_decision::job_for(route) {
    proxy_decision::ProxyJob::None => { emit(/* EVENT_STARTED … unchanged */); spawn_decorations(events, cache, media); }
    proxy_decision::ProxyJob::QuickOnly => { /* emit EVENT_STARTED unchanged */ spawn_decorations(events.clone(), cache.clone(), media.clone()); spawn_quick_proxy(events, cache, media, false, source_gop_secs); }
    proxy_decision::ProxyJob::QuickThenFull => { spawn_quick_proxy(events, cache, media, true, source_gop_secs); }
}
```

Remove the old per-branch `proxy_bypassed: Some(true)` and `export_uses_original: Some(true)` commits (the initial `set_route` replaces them).

- [ ] **Step 2: Build (full test pass happens after Task 6/7)**

Run: `cargo build --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud`
Expected: compiles once `MediaDerivativesPatch.set_route` exists (Task 6).

- [ ] **Step 3: Commit (with Task 6)** — see Task 6 commit.

### Task 6: Restructure `MediaDerivativesPatch` into fold signals (Rust)

**Files:**
- Modify: `apps/desktop/native/src/state/command.rs:149-179`
- Modify: `native/src/jobs/mod.rs` quick-proxy commit (~520-529) and full-proxy commit (~607-616)
- Modify: `native/src/commands/media.rs` (`ensure_full_proxy`, ~104-115)
- Modify: `native/src/napi_backend.rs:181-190` (stale invalidation)

**Interfaces:**
- Produces: `MediaDerivativesPatch { set_route: Option<DecodeRoute>, quick_proxy_landed: Option<Option<PathBuf>>, full_proxy_landed: Option<Option<(PathBuf, u32)>>, waveform_path, conform_path, thumbnails_dir }`.

- [ ] **Step 1: Rewrite the patch struct**

In `command.rs`, replace the `proxy_path` / `proxy_format_version` / `quick_proxy_path` / `proxy_bypassed` / `export_uses_original` members with:

```rust
    /// Authoritative route replacement: the import decision, or a
    /// route-correction. Carries the variant's known payload at the time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_route: Option<crate::state::DecodeRoute>,
    /// A quick proxy landed (`Some(Some(p))`) or was cleared (`Some(None)`);
    /// folded into whatever the current variant is. Ignored on Bypass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_proxy_landed: Option<Option<std::path::PathBuf>>,
    /// A full export master landed (`Some(Some((p, version)))`) or was cleared.
    /// Folded into the current Proxied variant; ignored otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_proxy_landed: Option<Option<(std::path::PathBuf, u32)>>,
```

Keep `waveform_path` / `conform_path` / `thumbnails_dir` unchanged.

- [ ] **Step 2: Update the proxy-job commits**

In `jobs/mod.rs` quick-proxy success (was `quick_proxy_path: Some(Some(...)), proxy_bypassed: Some(false)`): emit `quick_proxy_landed: Some(Some(quick_path))`.
Full-proxy success (was `proxy_path: Some(Some(...)), proxy_format_version: Some(...), proxy_bypassed: Some(false)`): emit `full_proxy_landed: Some(Some((proxy_path, PROXY_FORMAT_VERSION)))`.

- [ ] **Step 3: Update `ensure_full_proxy` to route-correct**

In `commands/media.rs`, replace the body that set `export_uses_original: Some(false)` with:

```rust
let corrected = item.decode_route.clone().route_corrected();
crate::jobs::commit_media_derivatives(
    &backend.events, id,
    crate::state::MediaDerivativesPatch { set_route: Some(corrected), ..Default::default() },
).await.map_err(|e| format!("route-correct {id}: {e}"))?;
crate::jobs::enqueue_full_proxy(backend.events.clone(), backend.cache.clone(), item);
```

Keep the early `return Ok(())` when the full proxy already exists — adapt its check to `matches!(item.decode_route, DecodeRoute::Proxied { full_proxy: Some(ref p), .. } if p.is_file())`.

- [ ] **Step 4: Update the stale-proxy invalidation**

In `napi_backend.rs:181-190`, replace the `item.proxy_path.is_some() && item.proxy_format_version < PROXY_FORMAT_VERSION` check + `proxy_path: Some(None)` clear with a match on `DecodeRoute::Proxied { full_proxy: Some(_), format_version, .. }` where `format_version < PROXY_FORMAT_VERSION`, emitting `full_proxy_landed: Some(None)` to clear it (forcing regen).

- [ ] **Step 5: Build + run the jobs tests**

Run: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud jobs::`
Expected: PASS (adjust the `commit_derivatives_emits_event` / `proxy_bypassed` assertions in `jobs/mod.rs` tests to assert the new patch keys, e.g. `set_route` / `quick_proxy_landed`).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/src
git commit -m "refactor(decode-route): patch carries fold signals; jobs/ensure_full_proxy/stale-check fold into variant"
```

### Task 7: Fold signals into `decode_route` in the TS applier (the locality hub)

**Files:**
- Modify: `apps/desktop/src/main/state/mutations/media.ts:49-81` (`MediaDerivativesPatch` + `applySetMediaDerivatives`)
- Test: `apps/desktop/src/main/state/mutations/media.test.ts` (create if absent)

**Interfaces:**
- Consumes: `MediaDerivativesPatch` fold signals (Task 6).
- Produces: `applySetMediaDerivatives` mutates `item.decode_route` by folding `quick_proxy_landed` / `full_proxy_landed` into the current variant; `set_route` replaces it.

- [ ] **Step 1: Write the failing fold test**

Create `apps/desktop/src/main/state/mutations/media.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applySetMediaDerivatives } from "./media";

const base = (route: any) => ({
  m1: { id: "m1", decode_route: route, /* other MediaItem fields omitted via cast */ } as any,
});

describe("applySetMediaDerivatives — route fold", () => {
  it("set_route replaces the variant", () => {
    const out = applySetMediaDerivatives(base({ route: "bypass" }), "m1", {
      set_route: { route: "direct-export", quick_proxy: null },
    });
    expect(out.m1.decode_route).toEqual({ route: "direct-export", quick_proxy: null });
  });
  it("quick_proxy_landed folds into DirectExport", () => {
    const out = applySetMediaDerivatives(base({ route: "direct-export", quick_proxy: null }), "m1", {
      quick_proxy_landed: "q.mp4",
    });
    expect(out.m1.decode_route).toEqual({ route: "direct-export", quick_proxy: "q.mp4" });
  });
  it("full_proxy_landed folds into Proxied with version", () => {
    const out = applySetMediaDerivatives(
      base({ route: "proxied", quick_proxy: "q.mp4", full_proxy: null, format_version: 0 }),
      "m1",
      { full_proxy_landed: { path: "f.mp4", format_version: 3 } },
    );
    expect(out.m1.decode_route).toEqual({
      route: "proxied", quick_proxy: "q.mp4", full_proxy: "f.mp4", format_version: 3,
    });
  });
  it("quick_proxy_landed on Bypass is ignored", () => {
    const out = applySetMediaDerivatives(base({ route: "bypass" }), "m1", {
      quick_proxy_landed: "q.mp4",
    });
    expect(out.m1.decode_route).toEqual({ route: "bypass" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/state/mutations/media.test.ts`
Expected: FAIL — the patch still has the old fields.

- [ ] **Step 3: Rewrite the patch interface + applier**

In `mutations/media.ts`, replace the route members of `MediaDerivativesPatch` with:

```ts
  set_route?: DecodeRoute
  quick_proxy_landed?: string | null
  full_proxy_landed?: { path: string; format_version: number } | null
```

(keep `waveform_path` / `conform_path` / `thumbnails_dir`), import `DecodeRoute`, and rewrite the route handling inside `applySetMediaDerivatives`:

```ts
  let route = next.decode_route
  if ("set_route" in patch && patch.set_route) route = patch.set_route
  if ("quick_proxy_landed" in patch) {
    const q = patch.quick_proxy_landed ?? null
    if (route.route === "direct-export" || route.route === "proxied") route = { ...route, quick_proxy: q }
    // Bypass: no quick slot — ignore (Rust never emits this; defensive).
  }
  if ("full_proxy_landed" in patch) {
    const f = patch.full_proxy_landed
    if (route.route === "proxied") {
      route = { ...route, full_proxy: f?.path ?? null, format_version: f?.format_version ?? route.format_version }
    }
  }
  next.decode_route = route
```

Delete the old `proxy_path` / `quick_proxy_path` / `proxy_bypassed` / `export_uses_original` lines (71-75).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/state/mutations/media.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/mutations/media.ts apps/desktop/src/main/state/mutations/media.test.ts
git commit -m "feat(decode-route): applier folds proxy landings into decode_route variant"
```

---

## Phase D — The resolver and reader consolidation

### Task 8: Pure `resolveDecode` + exhaustive table test

**Files:**
- Modify: `apps/desktop/src/renderer/render/decodeRoute.ts` (add `resolveDecode`)
- Modify: `apps/desktop/src/renderer/render/decodeRoute.test.ts` (add the table)

**Interfaces:**
- Produces: `interface ResolvedDecode { route: DecodeRoute["route"]; previewPath: string | null; exportPath: string | null }`; `function resolveDecode(media: { kind: string; path: string; decode_route: DecodeRoute }): ResolvedDecode`.

- [ ] **Step 1: Write the failing exhaustive table test**

Append to `decodeRoute.test.ts`:

```ts
import { resolveDecode } from "./decodeRoute";

const M = (kind: string, decode_route: DecodeRoute, path = "orig.mp4") =>
  ({ kind, path, decode_route } as const);

describe("resolveDecode — full route × readiness matrix", () => {
  it.each([
    ["bypass", M("Video", { route: "bypass" }), "orig.mp4", "orig.mp4"],
    ["direct-export, quick pending", M("Video", { route: "direct-export", quick_proxy: null }), null, "orig.mp4"],
    ["direct-export, quick ready", M("Video", { route: "direct-export", quick_proxy: "q.mp4" }), "q.mp4", "orig.mp4"],
    ["proxied, nothing ready", M("Video", { route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), null, null],
    ["proxied, quick ready", M("Video", { route: "proxied", quick_proxy: "q.mp4", full_proxy: null, format_version: 0 }), "q.mp4", null],
    ["proxied, both ready", M("Video", { route: "proxied", quick_proxy: "q.mp4", full_proxy: "f.mp4", format_version: 3 }), "q.mp4", "f.mp4"],
    ["image is bypass-like", M("Image", { route: "bypass" }), "orig.mp4", "orig.mp4"],
  ])("%s", (_name, media, previewPath, exportPath) => {
    const r = resolveDecode(media);
    expect(r.previewPath).toBe(previewPath);
    expect(r.exportPath).toBe(exportPath);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/render/decodeRoute.test.ts`
Expected: FAIL — `resolveDecode` not exported.

- [ ] **Step 3: Implement `resolveDecode`**

Append to `decodeRoute.ts`:

```ts
export interface ResolvedDecode {
  route: DecodeRoute["route"];
  /** File preview decodes; null = not ready (no defensive fallback). */
  previewPath: string | null;
  /** File export decodes; null = not ready. */
  exportPath: string | null;
}

/** The one place the route maps to decode paths. Pure, persisted-only — the
 *  machine-specific bridge is layered on by previewPathLive. */
export function resolveDecode(media: {
  kind: string;
  path: string;
  decode_route: DecodeRoute;
}): ResolvedDecode {
  const r = media.decode_route;
  switch (r.route) {
    case "bypass":
      return { route: "bypass", previewPath: media.path, exportPath: media.path };
    case "direct-export":
      return { route: "direct-export", previewPath: r.quick_proxy, exportPath: media.path };
    case "proxied":
      return { route: "proxied", previewPath: r.quick_proxy, exportPath: r.full_proxy };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/render/decodeRoute.test.ts`
Expected: PASS (all matrix rows).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decodeRoute.ts apps/desktop/src/renderer/render/decodeRoute.test.ts
git commit -m "feat(decode-route): pure resolveDecode + exhaustive matrix test"
```

### Task 9: Session overlay — `previewPathLive`

**Files:**
- Modify: `apps/desktop/src/renderer/render/decodeRoute.ts` (add `previewPathLive`)
- Modify: `apps/desktop/src/renderer/render/decodeRoute.test.ts` (add overlay cases)

**Interfaces:**
- Consumes: `resolveDecode` (Task 8).
- Produces: `function previewPathLive(media, opts?: { previewDecodable?: boolean }): string | null`.

- [ ] **Step 1: Write the failing overlay test**

Append to `decodeRoute.test.ts`:

```ts
import { previewPathLive } from "./decodeRoute";

describe("previewPathLive — session bridge overlay", () => {
  const pending = M("Video", { route: "direct-export", quick_proxy: null });
  it("returns the resolved preview path when ready", () => {
    expect(previewPathLive(M("Video", { route: "direct-export", quick_proxy: "q.mp4" }))).toBe("q.mp4");
  });
  it("bridges to the original when this machine decoded it", () => {
    expect(previewPathLive(pending, { previewDecodable: true })).toBe("orig.mp4");
  });
  it("stays null when not ready and not bridged", () => {
    expect(previewPathLive(pending)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/render/decodeRoute.test.ts`
Expected: FAIL — `previewPathLive` not exported.

- [ ] **Step 3: Implement**

Append to `decodeRoute.ts`:

```ts
/** Preview path with the non-persisted session bridge layered on: when this
 *  machine confirmed it can decode the original (import probe), preview reads
 *  the original until a proxy lands. */
export function previewPathLive(
  media: { kind: string; path: string; decode_route: DecodeRoute },
  opts?: { previewDecodable?: boolean },
): string | null {
  const { previewPath } = resolveDecode(media);
  if (previewPath) return previewPath;
  if (opts?.previewDecodable) return media.path;
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/render/decodeRoute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decodeRoute.ts apps/desktop/src/renderer/render/decodeRoute.test.ts
git commit -m "feat(decode-route): previewPathLive session-bridge overlay"
```

### Task 10: Repoint the ~17 readers; delete the old resolvers

**Files:**
- Modify: `apps/desktop/src/renderer/state/projectStore.ts:164-201` (delete `previewPlaybackPathFor` + `exportPlaybackPathFor`)
- Modify: `apps/desktop/src/renderer/render/exportReadiness.ts:30-59,82-130` (predicates → filters over `resolveDecode`)
- Modify: all call sites of the deleted functions (compiler-listed)

**Interfaces:**
- Consumes: `resolveDecode`, `previewPathLive` (Tasks 8-9).

- [ ] **Step 1: Delete the old resolvers, re-export the new ones**

In `projectStore.ts`, delete `previewPlaybackPathFor` (164-188) and `exportPlaybackPathFor` (190-201). Where callers imported them, switch to: preview → `previewPathLive(media, { previewDecodable })`; export → `resolveDecode(media).exportPath`.

- [ ] **Step 2: Rewrite the gate predicates over `resolveDecode`**

In `exportReadiness.ts`, replace `sourcesNeedingPreflight` and `sourcesNeedingPreviewProbe` bodies with filters expressed through `resolveDecode` (no raw flag reads):

```ts
export function sourcesNeedingPreflight(mediaById: ReadonlyMap<string, MediaSummary>): MediaSummary[] {
  return [...mediaById.values()].filter((m) => {
    if (m.kind !== "Video") return false;
    const r = resolveDecode(m);
    return r.route === "direct-export" && r.exportPath != null && /* full not yet */ true && m.decode_route.route !== "proxied";
  });
}
export function sourcesNeedingPreviewProbe(mediaById: ReadonlyMap<string, MediaSummary>): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) => m.kind === "Video" && m.available && resolveDecode(m).previewPath == null && m.decode_route.route !== "bypass",
  );
}
```

(`sourcesNeedingPreflight` = DirectExport without a full proxy — i.e. route is `direct-export`. Simplify to `resolveDecode(m).route === "direct-export"`.) In `prepareExportMedia`, replace the `m.proxy_path || m.proxy_bypassed` / `m.export_uses_original` branches with `const { route, exportPath } = resolveDecode(m)`: `exportPath != null` ⇒ ready; `route === "direct-export"` ⇒ the probe branch; else waiting/failed.

- [ ] **Step 3: Fix remaining call sites (compiler-driven)**

Run: `npm run typecheck`
Expected: errors at each remaining `proxy_path` / `proxy_bypassed` / `export_uses_original` / old-resolver reader. Fix each via `resolveDecode` / `previewPathLive`. The App.tsx export-gate inline check (`m.export_uses_original`) becomes `resolveDecode(m).route === "direct-export"`.

- [ ] **Step 4: Verify typecheck + existing renderer tests pass**

Run: `npm run typecheck && npx vitest run src/renderer`
Expected: PASS, zero `proxy_path`/`proxy_bypassed`/`export_uses_original` references remain (grep to confirm: `git grep -n "export_uses_original\|proxy_bypassed" apps/desktop/src` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "refactor(decode-route): all preview/export/gate readers go through resolveDecode"
```

### Task 11: Rewrite `importOptimizeStatus` over `resolveDecode` (UX frozen)

**Files:**
- Modify: `apps/desktop/src/renderer/panels/importOptimize.ts:27-49`
- Test: `apps/desktop/src/renderer/panels/importOptimize.test.ts` (create if absent)

**Interfaces:**
- Consumes: `resolveDecode` (Task 8).
- Produces: `importOptimizeStatus(m, deps): OptimizeStatus` — same six states, same precedence, expressed over the route.

- [ ] **Step 1: Write the failing status table test**

Create `apps/desktop/src/renderer/panels/importOptimize.test.ts` covering the frozen behavior:

```ts
import { describe, expect, it } from "vitest";
import { importOptimizeStatus } from "./importOptimize";

const deps = (over: Partial<{ memo: Map<string, "ok" | "pending">; ps: any; rc: Set<string> }> = {}) => ({
  memo: over.memo ?? new Map(),
  proxyStateOf: () => over.ps,
  routeCorrected: over.rc ?? new Set<string>(),
});
const V = (decode_route: any, extra: any = {}) =>
  ({ id: "m1", kind: "Video", path: "o.mp4", decode_route, ...extra } as any);

describe("importOptimizeStatus (frozen behavior, route-driven)", () => {
  it("proxied + full ready ⇒ ready", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: "q", full_proxy: "f", format_version: 1 }), deps())).toBe("ready"));
  it("bypass ⇒ direct", () =>
    expect(importOptimizeStatus(V({ route: "bypass" }), deps())).toBe("direct"));
  it("direct-export + quick ready ⇒ direct", () =>
    expect(importOptimizeStatus(V({ route: "direct-export", quick_proxy: "q" }), deps())).toBe("direct"));
  it("decodable this machine ⇒ bridged", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), deps({ memo: new Map([["m1", "ok"]]) }))).toBe("bridged"));
  it("undecodable + proxy pending ⇒ transcoding", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), deps({ ps: "pending" }))).toBe("transcoding"));
  it("proxy failed ⇒ failed", () =>
    expect(importOptimizeStatus(V({ route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), deps({ ps: "failed" }))).toBe("failed"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/panels/importOptimize.test.ts`
Expected: FAIL (function still reads old flags / not yet route-driven).

- [ ] **Step 3: Rewrite the function**

Replace `importOptimizeStatus` (lines 27-49) with a total function over the route; precedence preserved from the original comments:

```ts
export function importOptimizeStatus(m: MediaSummary, deps: OptimizeDeps): OptimizeStatus {
  if (m.kind !== "Video") return "direct";
  const { route, exportPath } = resolveDecode(m);
  if (route === "bypass") return "direct";
  if (route === "proxied" && exportPath) return "ready"; // full export master on disk
  if (route === "direct-export" && resolveDecode(m).previewPath) return "direct"; // quick landed
  const decodable = deps.memo.get(m.id) === "ok";
  const ps = deps.proxyStateOf(m.id);
  if (ps === "failed") return "failed";
  if (decodable) return "bridged"; // this machine previews the original now
  if (route === "direct-export") return "checking"; // probe unresolved
  if (ps === "pending") return "transcoding"; // undecodable here, proxy building
  return "checking"; // pre-decision window
}
```

Import `resolveDecode` from `../render/decodeRoute`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/panels/importOptimize.test.ts`
Expected: PASS (all six). Confirm the dialog's existing partition/note tests still pass: `npx vitest run src/renderer/panels`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/panels/importOptimize.ts apps/desktop/src/renderer/panels/importOptimize.test.ts
git commit -m "refactor(decode-route): importOptimizeStatus is a total fn over resolveDecode (UX frozen)"
```

---

## Phase E — Cleanup, docs, gate

### Task 12: Delete the dead `with_proxies_substituted`

**Files:**
- Modify/Delete: `apps/desktop/native/src/preview/mod.rs`

- [ ] **Step 1: Confirm no callers**

Run: `git grep -n "with_proxies_substituted" apps/desktop`
Expected: only the definition + its doc comment.

- [ ] **Step 2: Delete the function (and the module if now empty)**

Remove `with_proxies_substituted` from `preview/mod.rs`. If the file is then empty, delete it and remove `mod preview;` from its parent.

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud`
Expected: compiles (dead code removed; no callers).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/native/src
git commit -m "chore(decode-route): delete dead preview::with_proxies_substituted"
```

### Task 13: Update `docs/data-model.md`

**Files:**
- Modify: `docs/data-model.md` (the `MediaItem` struct + the proxy-axes prose ~lines 135-203)

- [ ] **Step 1: Replace the proxy-field documentation**

Edit the `MediaItem` Rust block to show `decode_route: DecodeRoute` instead of the five flat fields, and rewrite the "proxy fields encode a video's decode routing" prose to describe the three folded variants (Bypass / DirectExport / Proxied) and that readiness lives in the variant's `Option` payloads. Reference `CONTEXT.md` and ADR 0028. Keep it evergreen (no dates/phase numbers, per the docs convention).

- [ ] **Step 2: Commit**

```bash
git add docs/data-model.md
git commit -m "docs(decode-route): data-model describes the folded DecodeRoute"
```

### Task 14: Full build + import/export E2E conformance gate

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the native addon + wasm + typecheck + unit tests**

Run: `npm run napi:build && npm run build:wasm && npm run typecheck && npx vitest run`
Expected: all green.

- [ ] **Step 2: Run the import/export E2E conformance gate**

Run: `npx playwright test -c playwright.config.ts` (requires the `VITE_WEFTCUT_E2E=1` build per `docs/conformance.md`).
Expected: the import-routing + export specs pass — a fresh import of an H.264 source (Bypass), a 10-bit source (Proxied), and a DirectExport source each preview and export correctly; route-correction on a forced probe failure flips DirectExport → Proxied and the export waits for the full proxy.

- [ ] **Step 3: Confirm no stale references remain**

Run: `git grep -nE "proxy_bypassed|export_uses_original|proxy_path|quick_proxy_path" apps/desktop/src apps/desktop/native/src`
Expected: only references inside `decode_route.rs` / `decodeRoute.ts` payloads and the patch fold signals — no flat `MediaItem` fields anywhere.

- [ ] **Step 4: Commit (if any doc/test touch-ups)**

```bash
git add -A
git commit -m "test(decode-route): import/export conformance gate green"
```

---

## Self-Review

- **Spec coverage:** B (persist enum) → Tasks 1,3,4; folded variants (iii) → Tasks 1,3,6,7; single resolver + persisted/session split → Tasks 8,9; hand-mirror + wire golden → Tasks 1,2; importStatus rewrite frozen UX → Task 11; route-correction tested → Tasks 1 (`route_corrected` test) + 6; dead-code cleanup → Task 12; schema bump → Task 1; docs/CONTEXT/ADR → ADR 0028 + CONTEXT.md already written, data-model → Task 13. ✔ All design decisions mapped.
- **Placeholder scan:** no TBD/"handle errors"/"similar to" — every code step shows code. ✔
- **Type consistency:** `DecodeRoute` variants (`bypass`/`direct-export`/`proxied`) and payload names (`quick_proxy`, `full_proxy`, `format_version`) identical across Rust (Task 1) and TS (Task 2,8); patch signals (`set_route`, `quick_proxy_landed`, `full_proxy_landed`) identical Rust (Task 6) ↔ TS (Task 7); `resolveDecode` / `previewPathLive` / `importOptimizeStatus` signatures stable across Tasks 8-11. ✔

> **Open dependency note:** Task 5 depends on Task 6's `set_route`. Execute Task 6 before (or together with) Task 5, or merge them into one commit. Flagged so a sequential executor doesn't stall.
