# Template Persisted Pre-bake (L2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the dead L2 disk layer into a disk-first frame path so template playback decodes pre-baked PNGs instead of re-rastering — killing playback stutter and slow cold-start on reload.

**Architecture:** A read-only `resolveTemplateFrame` (disk-first, falls back to raster) is shared by the sprite and prewarmer. A `TemplateBaker` is the *sole* writer: idle-paced, it bakes a content's full frame sequence to `<workspace>/Cache/raster/<hash>/<i>.png`. Two triggers feed the baker — a global "Pre-bake" setting (default off) and a per-layer right-click "Pre-bake now". A baked-key index (built from `readDir` on project load) gates disk reads so un-baked templates never pay an IPC. Centralizing writes in the baker (vs. the spec's fire-and-forget write-through in the resolver) avoids an LRU-eviction race and gives one writer.

**Tech Stack:** TypeScript (webview render path, Pixi v8), Rust (Tauri commands, app settings, fs-scope), Tauri plugin-fs, vitest (Node units), tauri-driver + WebdriverIO (real-WebView2 e2e).

---

## File Structure

**Rust (prerequisite + settings):**
- Modify `apps/desktop/src-tauri/capabilities/default.json` — add the six `fs:allow-*` permissions.
- Modify `apps/desktop/src-tauri/src/workspace.rs` — add `allow_workspace_fs(app, path)` scope-grant helper.
- Modify `apps/desktop/src-tauri/src/commands.rs` — call the helper at the 3 workspace-activation sites.
- Modify `apps/desktop/src-tauri/src/app_settings.rs` — add `prebake_templates: bool` (default false) to struct + patch + apply + tests.

**TypeScript (settings plumbing):**
- Modify `apps/desktop/src/ipc/index.ts` — add `prebake_templates` to `AppSettings` + `AppSettingsPatch`.
- Modify `apps/desktop/src/settings/appSettingsStore.ts` — `FALLBACK` field + `usePrebakeTemplatesEnabled` selector.

**TypeScript (L2 core — new modules):**
- Create `apps/desktop/src/render/templates/pngEncode.ts` — `encodeBitmapToPng`.
- Create `apps/desktop/src/render/templates/bakedKeyIndex.ts` — in-RAM set of baked cacheKeys + load/gc.
- Create `apps/desktop/src/render/templates/bakePlan.ts` — pure full-content, playhead-first, disk-skip planner.
- Create `apps/desktop/src/render/templates/TemplateBaker.ts` — the idle-paced writer.
- Create `apps/desktop/src/render/templates/prebakeBus.ts` — tiny pub/sub for Timeline → Compositor "Pre-bake now".

**TypeScript (L2 core — modified):**
- Modify `apps/desktop/src/render/templates/frameCache.ts` — add `hasPng` (cheap exists-only skip check).
- Modify `apps/desktop/src/render/templates/templateRaster.ts` — add `resolveTemplateFrame` (read-through) + export the shared `bakedKeyIndex`.
- Modify `apps/desktop/src/render/sprite/TemplateSprite.ts` — `captureAndBind` calls `resolveTemplateFrame`.
- Modify `apps/desktop/src/render/Compositor.ts` — own the baker; point the prewarm closure at the resolver; feed the baker's active set; load index + GC on `setProject`.

**TypeScript (UI):**
- Modify `apps/desktop/src/settings/SettingsPanel.tsx` — a "Pre-bake templates" toggle section.
- Modify `apps/desktop/src/timeline/Timeline.tsx` — `LayerContextMenu` "Pre-bake now" item (Template layers only) + handler.
- Modify `apps/desktop/src/i18n/locales/en-US.ts` and `zh-CN.ts` — new keys.

**Tests / docs:**
- Create `apps/desktop/src/render/templates/bakePlan.test.ts`, `bakedKeyIndex.test.ts`, `TemplateBaker.test.ts`.
- Create `apps/desktop/e2e/specs/template_prebake.e2e.js`.
- Modify `docs/templates.md` (L2 section + cache-key table) and create `docs/adr/0016-template-l2-prebake.md`.

---

## Phase 1 — Runtime prerequisite (Rust): make L2 disk writes legal

Nothing downstream can be verified end-to-end until the fs plugin is allowed to touch `<workspace>/Cache/raster/`.

### Task 1: Grant fs permissions

**Files:**
- Modify: `apps/desktop/src-tauri/capabilities/default.json:6-17`

- [ ] **Step 1: Add the six fs permissions**

Edit the `permissions` array — keep the existing entries, add the new ones after `fs:allow-temp-write-recursive`:

```json
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:default",
    "core:window:allow-set-title",
    "core:webview:default",
    "dialog:default",
    "fs:default",
    "fs:allow-temp-write-recursive",
    "fs:allow-mkdir",
    "fs:allow-write-file",
    "fs:allow-read-file",
    "fs:allow-read-dir",
    "fs:allow-remove",
    "fs:allow-exists",
    "shell:default",
    "mcp-bridge:default"
  ]
```

- [ ] **Step 2: Verify it builds**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: exit 0. (Permissions are validated against the generated schema at build; an unknown permission name fails here.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat(templates): grant fs permissions for L2 raster cache"
```

### Task 2: Grant the dynamic workspace fs-scope on project activation

The permissions above are inert until the runtime scope includes the user-chosen workspace path. `default.json` can't express it (only `$TEMP/**` ships statically), so grant it imperatively wherever the workspace becomes active.

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs` (add helper near the top, after imports)
- Modify: `apps/desktop/src-tauri/src/commands.rs:1092,1135,1217` (3 call sites)

- [ ] **Step 1: Add the scope-grant helper to `workspace.rs`**

At the top of `workspace.rs`, ensure these imports exist (add what's missing):

```rust
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;
```

Add the helper function (module scope):

```rust
/// Allow the fs plugin to read/write under the open workspace folder.
/// L2 template raster frames live at `<workspace>/Cache/raster/...`, a
/// user-chosen path the static `default.json` scope can't express. Grant it
/// at every workspace-activation site. Best-effort: a scope error is logged,
/// not fatal — the editor still runs, L2 just degrades to live rastering.
pub fn allow_workspace_fs(app: &AppHandle, workspace: &Path) {
    if let Err(e) = app.fs_scope().allow_directory(workspace, true) {
        tracing::warn!("fs_scope allow {}: {e:#}", workspace.display());
    }
}
```

> NOTE: confirm the `allow_directory` signature against the installed
> `tauri-plugin-fs` version. In some 2.x releases it is
> `allow_directory(&self, path, recursive) -> Result<(), Error>` (used above);
> if your version returns `()`, drop the `if let Err`.

- [ ] **Step 2: Call it at the 3 activation sites in `commands.rs`**

Each site currently reads:

```rust
    cache
        .set_workspace(&path)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    workspace.set(path.clone());
```

Immediately AFTER `workspace.set(...)` at **each** site (lines ~1092, ~1135, and the `target` variant at ~1217), add:

```rust
    crate::workspace::allow_workspace_fs(&app, &path);
```

(At the `project_new_workspace` site ~1217 the variable is `target`, not `path`:
`crate::workspace::allow_workspace_fs(&app, &target);`)

All three commands already have `app: AppHandle` in scope (they call
`crate::agent_session::end_and_emit(&app, ...)` nearby).

- [ ] **Step 3: Verify it builds**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/workspace.rs apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(templates): grant workspace fs-scope on project activation"
```

---

## Phase 2 — The global "Pre-bake" setting

### Task 3: Add `prebake_templates` to the Rust app settings

**Files:**
- Modify: `apps/desktop/src-tauri/src/app_settings.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module (and extend the existing `defaults_when_no_file` / `apply_persists_then_reads_back` assertions):

```rust
    #[test]
    fn prebake_templates_defaults_off_and_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = fresh(&tmp);
        assert!(!store.get().prebake_templates); // default OFF
        let after = store
            .apply(AppSettingsPatch {
                prebake_templates: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert!(after.prebake_templates);
        // Independent reader sees it persisted.
        assert!(AppSettingsStore::new(tmp.path().to_path_buf()).get().prebake_templates);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test app_settings::tests::prebake_templates_defaults_off_and_round_trips`
Expected: FAIL — `prebake_templates` is not a field of `AppSettings`/`AppSettingsPatch`.

- [ ] **Step 3: Add the field, the patch field, the default, and the apply arm**

In `AppSettings` (after `tail_snap_strength_px`):

```rust
    #[serde(default)]
    pub prebake_templates: bool,
```

In `Default for AppSettings`, add `prebake_templates: false,`.

In `AppSettingsPatch`, add `pub prebake_templates: Option<bool>,`.

In `apply`, before `self.write(&current)?;`:

```rust
        if let Some(v) = patch.prebake_templates {
            current.prebake_templates = v;
        }
```

Also add `prebake_templates: false` to the constructed expectations in `defaults_when_no_file`-style tests if they build a full struct literal (they assert fields, so only add an `assert!(!s.prebake_templates);` line there).

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop/src-tauri && cargo test app_settings`
Expected: PASS (all app_settings tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/app_settings.rs
git commit -m "feat(settings): add prebake_templates app setting (default off)"
```

### Task 4: Mirror the setting in the TS IPC types + store

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts:615-638`
- Modify: `apps/desktop/src/settings/appSettingsStore.ts:39-68`

- [ ] **Step 1: Extend the IPC interfaces**

In `AppSettings` (after `tail_snap_strength_px`):

```ts
  /// When true, every template layer's full frame sequence is pre-baked
  /// to disk in the background (L2). Default false. See docs/templates.md.
  prebake_templates: boolean;
```

In `AppSettingsPatch`:

```ts
  prebake_templates?: boolean;
```

- [ ] **Step 2: Extend the store**

In `appSettingsStore.ts` `FALLBACK`, add `prebake_templates: false,`. After `useTailSnapStrengthPx`, add the atomic selector:

```ts
export const usePrebakeTemplatesEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.prebake_templates);
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck` (or `npx tsc -b`)
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/settings/appSettingsStore.ts
git commit -m "feat(settings): mirror prebake_templates in TS ipc + store"
```

---

## Phase 3 — Pure L2 building blocks (Node-testable, TDD)

### Task 5: `bakePlan` — full-content, playhead-first, disk-skip planner

Mirrors `prewarmPlan.ts` but plans the WHOLE content (disk isn't RAM-bounded), skips frames already on disk, and is playhead-first.

**Files:**
- Create: `apps/desktop/src/render/templates/bakePlan.ts`
- Test: `apps/desktop/src/render/templates/bakePlan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { planBakeTargets, type BakeContent } from "./bakePlan";

const content = (cacheKey: string, contentFrame: number, n: number): BakeContent => ({
  cacheKey,
  contentFrame,
  contentDurationFrames: n,
});

describe("planBakeTargets", () => {
  it("plans the WHOLE content (not capped), playhead-first then backfill", () => {
    const out = planBakeTargets([content("a", 2, 5)], () => false);
    expect(out).toEqual([
      { cacheKey: "a", frame: 2 },
      { cacheKey: "a", frame: 3 },
      { cacheKey: "a", frame: 4 },
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
    ]);
  });

  it("skips frames already on disk", () => {
    const onDisk = new Set(["a#0", "a#1"]);
    const out = planBakeTargets([content("a", 0, 3)], (k, f) => onDisk.has(`${k}#${f}`));
    expect(out).toEqual([{ cacheKey: "a", frame: 2 }]);
  });

  it("dedups by cacheKey and round-robins across contents", () => {
    const out = planBakeTargets([content("a", 0, 2), content("a", 0, 2), content("b", 0, 2)], () => false);
    // 'a' appears once (deduped); round-robin interleaves a,b then a,b.
    expect(out).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "b", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "b", frame: 1 },
    ]);
  });

  it("returns empty for no contents", () => {
    expect(planBakeTargets([], () => false)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/templates/bakePlan.test.ts`
Expected: FAIL — module `./bakePlan` not found.

- [ ] **Step 3: Implement `bakePlan.ts`**

```ts
export interface BakeContent {
  cacheKey: string;
  /// Content frame at the current playhead (0-based; clamped to the content).
  contentFrame: number;
  contentDurationFrames: number;
}

export interface BakeTarget {
  cacheKey: string;
  frame: number;
}

/// Plan every (cacheKey, frame) to persist to disk, in priority order. Unlike
/// `planPrewarmTargets` this is NOT capped — disk holds the whole content. Per
/// content the order is playhead-first: contentFrame → forward → backfill
/// earlier. Contents dedup by cacheKey and round-robin so one long content
/// can't starve others. `isOnDisk(cacheKey, frame)` drops already-baked frames
/// so a resumed/partial bake doesn't redo work.
export function planBakeTargets(
  contents: BakeContent[],
  isOnDisk: (cacheKey: string, frame: number) => boolean,
): BakeTarget[] {
  const seen = new Set<string>();
  const uniq: BakeContent[] = [];
  for (const c of contents) {
    if (seen.has(c.cacheKey)) continue;
    seen.add(c.cacheKey);
    uniq.push(c);
  }
  if (uniq.length === 0) return [];

  const perContent: number[][] = uniq.map((c) => {
    const n = c.contentDurationFrames;
    const start = Math.max(0, Math.min(c.contentFrame, n - 1));
    const order: number[] = [];
    for (let f = start; f < n; f++) {
      if (!isOnDisk(c.cacheKey, f)) order.push(f); // current → forward
    }
    for (let f = 0; f < start; f++) {
      if (!isOnDisk(c.cacheKey, f)) order.push(f); // backfill earlier
    }
    return order;
  });

  const out: BakeTarget[] = [];
  const maxLen = perContent.reduce((m, a) => Math.max(m, a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < uniq.length; c++) {
      const frames = perContent[c]!;
      if (i < frames.length) out.push({ cacheKey: uniq[c]!.cacheKey, frame: frames[i]! });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/desktop && npx vitest run src/render/templates/bakePlan.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/bakePlan.ts apps/desktop/src/render/templates/bakePlan.test.ts
git commit -m "feat(templates): bakePlan pure full-content disk-skip planner"
```

### Task 6: `bakedKeyIndex` — in-RAM set of baked cacheKeys

Gates disk reads: `resolveTemplateFrame` only attempts a `readPng` when the content's `cacheKey` is known-baked, so an un-baked template never pays an `exists`/`readFile` IPC. The pure set logic is unit-tested; the async `loadFromDisk` / `gc` are exercised by e2e (Task 14).

**Files:**
- Create: `apps/desktop/src/render/templates/bakedKeyIndex.ts`
- Test: `apps/desktop/src/render/templates/bakedKeyIndex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { BakedKeyIndex } from "./bakedKeyIndex";

describe("BakedKeyIndex", () => {
  it("add / has by cacheKey", () => {
    const idx = new BakedKeyIndex();
    expect(idx.has("a")).toBe(false);
    idx.add("a");
    expect(idx.has("a")).toBe(true);
  });

  it("hydrate replaces the set from a known set of hashes", () => {
    const idx = new BakedKeyIndex();
    idx.add("stale");
    idx.hydrateFromHashes(new Set(["deadbeef"]), (k) => (k === "live" ? "deadbeef" : "00000000"));
    expect(idx.has("live")).toBe(true);
    expect(idx.has("stale")).toBe(false);
  });

  it("clear empties the set", () => {
    const idx = new BakedKeyIndex();
    idx.add("a");
    idx.clear();
    expect(idx.has("a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/templates/bakedKeyIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bakedKeyIndex.ts`**

```ts
import { hashCacheKey } from "./frameCache";

/// Tracks which template cacheKeys have at least one frame baked on disk, so
/// the read path can skip a per-frame `exists` IPC for never-baked content.
/// Membership is by RAW cacheKey; on-disk dirs are named by `hashCacheKey`,
/// so `hydrateFromHashes` maps a set of live cacheKeys onto the dir names a
/// `readDir(Cache/raster)` returned.
export class BakedKeyIndex {
  private keys = new Set<string>();

  has(cacheKey: string): boolean {
    return this.keys.has(cacheKey);
  }

  /// Mark a cacheKey baked (called after a successful `writePng`).
  add(cacheKey: string): void {
    this.keys.add(cacheKey);
  }

  clear(): void {
    this.keys.clear();
  }

  /// Replace the set: of the supplied live cacheKeys, keep those whose
  /// `hashCacheKey` is among the dir names found on disk. `hashOf` is injected
  /// for testability (defaults to the real `hashCacheKey`).
  hydrateFromHashes(
    diskHashes: Set<string>,
    hashOf: (cacheKey: string) => string = hashCacheKey,
  ): void {
    // We can't invert the hash, so membership is recomputed against the live
    // keys the caller knows about. (A baked dir with no live key is an orphan
    // GC reclaims; it never needs to be in this index.)
    this.keys.clear();
    for (const k of this.liveCandidates) {
      if (diskHashes.has(hashOf(k))) this.keys.add(k);
    }
  }

  /// The set of cacheKeys the caller considers "live" this project (active
  /// template layers). Set by the Compositor before `hydrateFromHashes`.
  private liveCandidates: string[] = [];
  setLiveCandidates(keys: string[]): void {
    this.liveCandidates = keys;
  }
}
```

> NOTE for the implementer: `hydrateFromHashes` needs the live cacheKeys
> (you can't reverse a hash). The Compositor calls `setLiveCandidates(activeKeys)`
> from the descriptors it already computes, THEN `hydrateFromHashes(diskHashes)`.
> The test above seeds `liveCandidates` via the second `hydrateFromHashes`
> arg path — adjust the test to call `idx.setLiveCandidates(["live","stale"])`
> before `hydrateFromHashes` so it exercises the real flow:

Revise the second test to:

```ts
  it("hydrate keeps only live keys whose hash is on disk", () => {
    const idx = new BakedKeyIndex();
    idx.setLiveCandidates(["live", "stale"]);
    idx.hydrateFromHashes(new Set(["deadbeef"]), (k) => (k === "live" ? "deadbeef" : "00000000"));
    expect(idx.has("live")).toBe(true);
    expect(idx.has("stale")).toBe(false);
  });
```

- [ ] **Step 4: Run the test**

Run: `cd apps/desktop && npx vitest run src/render/templates/bakedKeyIndex.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/bakedKeyIndex.ts apps/desktop/src/render/templates/bakedKeyIndex.test.ts
git commit -m "feat(templates): bakedKeyIndex gates L2 disk reads"
```

---

## Phase 4 — frameCache cheap skip-check + PNG encode

### Task 7: Add `hasPng` (exists-only) to `TemplateFrameCache`

The baker skips already-baked frames without reading bytes.

**Files:**
- Modify: `apps/desktop/src/render/templates/frameCache.ts` (after `readPng`, ~line 227)

- [ ] **Step 1: Add the method**

```ts
  /// True if the PNG for (cacheKey, frameIndex) exists on disk. Cheaper than
  /// `readPng` (no byte read) — the baker uses it to skip already-baked frames.
  /// Null project / not-found → false; permission errors propagate.
  async hasPng(cacheKey: string, frameIndex: number): Promise<boolean> {
    const dir = await rasterDirFor(cacheKey);
    if (dir === null) return false;
    const { join } = await import("@tauri-apps/api/path");
    const { exists } = await import("@tauri-apps/plugin-fs");
    const path = await join(dir, `${frameIndex}.png`);
    return exists(path);
  }
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck`
Expected: exit 0. (No unit test — it's a thin Tauri-fs wrapper, exercised in the e2e in Task 14.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/templates/frameCache.ts
git commit -m "feat(templates): TemplateFrameCache.hasPng exists-only skip check"
```

### Task 8: `encodeBitmapToPng`

**Files:**
- Create: `apps/desktop/src/render/templates/pngEncode.ts`

- [ ] **Step 1: Implement**

```ts
// Encode an SVG-rastered ImageBitmap to lossless PNG bytes for the L2 disk
// cache. PNG (not WebP) because the Canvas WebP encoder is lossy and crisp
// template text edges matter (ADR 0015). The SVG raster path is untainted
// (no <foreignObject>), so `convertToBlob` succeeds — unlike the dead
// foreignObject path that SecurityError'd here.
//
// Reading the bitmap via drawImage does NOT consume or neuter it, so the same
// ImageBitmap can be bound as a texture and encoded for disk.

/// Encode `bitmap` to a PNG `Blob`. Main-thread or worker (OffscreenCanvas is
/// available in both); the baker calls it on the main thread.
export async function encodeBitmapToPng(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encodeBitmapToPng: no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck`
Expected: exit 0. (No Node unit — `OffscreenCanvas` isn't in the vitest env; verified in the e2e, Task 14.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/templates/pngEncode.ts
git commit -m "feat(templates): encodeBitmapToPng for L2 PNG frames"
```

---

## Phase 5 — Read-through resolver + the baker

### Task 9: `resolveTemplateFrame` (read-through) + shared `bakedKeyIndex`

**Files:**
- Modify: `apps/desktop/src/render/templates/templateRaster.ts`

- [ ] **Step 1: Add the shared index + the resolver**

Add imports at the top:

```ts
import { BakedKeyIndex } from "./bakedKeyIndex";
```

After `export const sharedTemplateFrameCache = new TemplateFrameCache();` add:

```ts
/// Process-wide index of which cacheKeys have frames baked on disk. The
/// Compositor hydrates it on project load; the baker `add`s on each write.
export const sharedBakedKeyIndex = new BakedKeyIndex();
```

After `rasterTemplateFrame`, add:

```ts
/// Obtain one template frame, preferring a pre-baked PNG on disk over a live
/// raster. Read-only: writing is the TemplateBaker's job (single writer →
/// no LRU-eviction race on a fire-and-forget encode). Shared by the on-demand
/// sprite path and the prewarmer, so disk-first is uniform.
///
/// Disk read is attempted only when `sharedBakedKeyIndex.has(cacheKey)` — so an
/// un-baked template never pays an IPC. Any read/permission error is swallowed
/// and falls through to a live raster, so an fs hiccup can never blank preview.
export async function resolveTemplateFrame(
  template: Template,
  cacheKey: string,
  frame: number,
  tSec: number,
  durationSec: number,
  canonicalProps: Record<string, unknown>,
): Promise<ImageBitmap> {
  if (sharedBakedKeyIndex.has(cacheKey)) {
    try {
      const png = await sharedTemplateFrameCache.readPng(cacheKey, frame);
      if (png) return await createImageBitmap(png);
    } catch {
      // permission/io hiccup — fall through to live raster.
    }
  }
  return rasterTemplateFrame(template, tSec, durationSec, canonicalProps);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/templates/templateRaster.ts
git commit -m "feat(templates): resolveTemplateFrame disk-first read-through"
```

### Task 10: `TemplateBaker` — the idle-paced writer (TDD)

Sibling to `TemplatePrewarmer`. Dependency-injected so the drain loop is Node-testable with fakes.

**Files:**
- Create: `apps/desktop/src/render/templates/TemplateBaker.ts`
- Test: `apps/desktop/src/render/templates/TemplateBaker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { TemplateBaker, type BakeContentSpec } from "./TemplateBaker";

function makeFakeBitmap(): ImageBitmap {
  return { close: vi.fn(), width: 1, height: 1 } as unknown as ImageBitmap;
}

/// Manual scheduler: capture callbacks, run them on demand so the test drives
/// the idle loop deterministically (mirrors TemplatePrewarmer.test.ts).
function manualScheduler() {
  const cbs: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => {
      cbs.push(cb);
      return cbs.length;
    },
    cancel: vi.fn(),
    flush: async () => {
      while (cbs.length) {
        const cb = cbs.shift()!;
        cb();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe("TemplateBaker", () => {
  it("renders + persists every frame of the active content, skipping on-disk", async () => {
    const sched = manualScheduler();
    const persisted: string[] = [];
    const render = vi.fn(async (_f: number) => makeFakeBitmap());
    const baker = new TemplateBaker({
      schedule: sched.schedule,
      cancel: sched.cancel,
      isOnDisk: async (k, f) => k === "a" && f === 0, // frame 0 already baked
      persist: async (k, f, _bmp) => {
        persisted.push(`${k}#${f}`);
      },
      warm: vi.fn(),
      batchSize: 2,
    });
    const spec: BakeContentSpec = {
      cacheKey: "a",
      contentFrame: 0,
      contentDurationFrames: 3,
      render,
    };
    baker.setTargets([spec]);
    await sched.flush();
    // frame 0 skipped (on disk); 1 and 2 baked.
    expect(persisted.sort()).toEqual(["a#1", "a#2"]);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does nothing when targets is empty", async () => {
    const sched = manualScheduler();
    const persist = vi.fn();
    const baker = new TemplateBaker({
      schedule: sched.schedule,
      cancel: sched.cancel,
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([]);
    await sched.flush();
    expect(persist).not.toHaveBeenCalled();
  });

  it("dispose stops further work", async () => {
    const sched = manualScheduler();
    const persist = vi.fn(async () => {});
    const baker = new TemplateBaker({
      schedule: sched.schedule,
      cancel: sched.cancel,
      isOnDisk: async () => false,
      persist,
      warm: vi.fn(),
    });
    baker.setTargets([{ cacheKey: "a", contentFrame: 0, contentDurationFrames: 4, render: async () => makeFakeBitmap() }]);
    baker.dispose();
    await sched.flush();
    expect(persist).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/desktop && npx vitest run src/render/templates/TemplateBaker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TemplateBaker.ts`**

```ts
import { planBakeTargets, type BakeContent } from "./bakePlan";

/// One content the baker should persist in full. `render(frame)` rasters an
/// arbitrary content frame (the Compositor's closure → `rasterTemplateFrame`).
export interface BakeContentSpec extends BakeContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface TemplateBakerDeps {
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// True if (cacheKey, frame) PNG already on disk → skip.
  isOnDisk: (cacheKey: string, frame: number) => Promise<boolean>;
  /// Encode + write the PNG, then mark the cacheKey baked. Throws are caught.
  persist: (cacheKey: string, frame: number, bmp: ImageBitmap) => Promise<void>;
  /// Optionally warm L0 with the freshly-baked bitmap (so the just-baked frame
  /// is instantly available without a disk round-trip). The cache OWNS the
  /// bitmap after this; if `warm` declines it, the baker closes the bitmap.
  warm: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  batchSize?: number;
}

/// Idle-paced, full-content writer for L2. `setTargets` (re)plans; an idle loop
/// renders+persists missing frames in priority order, yielding between batches.
/// The SOLE writer of L2 (the resolver is read-only), so there's no
/// fire-and-forget eviction race. Preview-only (DOM-gated by the Compositor).
export class TemplateBaker {
  private specsByKey = new Map<string, BakeContentSpec>();
  private queue: { cacheKey: string; frame: number }[] = [];
  private scheduled: number | null = null;
  private running = false;
  private disposed = false;
  private readonly batchSize: number;

  constructor(private readonly deps: TemplateBakerDeps) {
    this.batchSize = deps.batchSize ?? 2;
  }

  /// Replace the active bake set and re-plan. `isOnDisk` is async, so planning
  /// resolves the skip-set first, then arms the loop.
  setTargets(specs: BakeContentSpec[]): void {
    if (this.disposed) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    void this.replan(specs);
  }

  private async replan(specs: BakeContentSpec[]): Promise<void> {
    // Resolve the disk-skip predicate for each candidate frame up front. We
    // pass a synchronous predicate to the pure planner, backed by a Set we fill
    // here. Frames not pre-checked default to "not on disk" (the baker's
    // per-frame guard re-checks before rendering, so this is just a fast-path).
    const onDisk = new Set<string>();
    await Promise.all(
      specs.flatMap((s) => {
        const frames: Promise<void>[] = [];
        for (let f = 0; f < s.contentDurationFrames; f++) {
          frames.push(
            this.deps.isOnDisk(s.cacheKey, f).then((hit) => {
              if (hit) onDisk.add(`${s.cacheKey}#${f}`);
            }),
          );
        }
        return frames;
      }),
    );
    if (this.disposed) return;
    this.queue = planBakeTargets(specs, (k, f) => onDisk.has(`${k}#${f}`));
    this.arm();
  }

  private arm(): void {
    if (this.disposed || this.running || this.scheduled != null) return;
    if (this.queue.length === 0) return;
    this.scheduled = this.deps.schedule(() => {
      this.scheduled = null;
      void this.drainBatch();
    });
  }

  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    try {
      const batch: { cacheKey: string; frame: number; spec: BakeContentSpec }[] = [];
      while (batch.length < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        batch.push({ cacheKey: target.cacheKey, frame: target.frame, spec });
      }
      await Promise.all(
        batch.map(async ({ cacheKey, frame, spec }) => {
          try {
            // Re-check disk right before rendering — a sibling content or a
            // prior session may have written it since the plan was built.
            if (await this.deps.isOnDisk(cacheKey, frame)) return;
            const bmp = await spec.render(frame);
            if (this.disposed) {
              bmp.close();
              return;
            }
            await this.deps.persist(cacheKey, frame, bmp);
            this.deps.warm(cacheKey, frame, bmp);
          } catch {
            // Raster/encode/write failed — drop this frame, keep going. The
            // next setTargets (or session) will retry the missing frame.
          }
        }),
      );
    } finally {
      this.running = false;
      this.arm();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled != null) {
      this.deps.cancel(this.scheduled);
      this.scheduled = null;
    }
    this.queue = [];
    this.specsByKey.clear();
  }
}
```

> NOTE: the test's `dispose` case calls `setTargets` then `dispose` synchronously;
> `replan` is async (awaits `isOnDisk`), so `this.queue` is still empty when
> `dispose` runs and `replan`'s `if (this.disposed) return` guard prevents arming.
> The `warm` fake in the tests is a no-op; the real `warm` (Task 11) hands the
> bitmap to `sharedTemplateFrameCache.setFrame`.

- [ ] **Step 4: Run the test**

Run: `cd apps/desktop && npx vitest run src/render/templates/TemplateBaker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/templates/TemplateBaker.ts apps/desktop/src/render/templates/TemplateBaker.test.ts
git commit -m "feat(templates): TemplateBaker idle-paced L2 writer"
```

### Task 11: `prebakeBus` — Timeline → Compositor "Pre-bake now" channel

The context menu lives in `Timeline.tsx`; the baker lives in the webview `Compositor`. A tiny module-level pub/sub bridges them without threading a Compositor ref through React.

**Files:**
- Create: `apps/desktop/src/render/templates/prebakeBus.ts`

- [ ] **Step 1: Implement**

```ts
// Decouples the timeline's "Pre-bake now" context-menu action (React) from the
// webview Compositor that owns the TemplateBaker. The Compositor subscribes on
// construction; the menu calls `requestPrebake(layerId)`. Module-level singleton
// — there is one Compositor and one timeline per window.

type Listener = (layerId: string) => void;

const listeners = new Set<Listener>();

/// Request an immediate full pre-bake of a single template layer. No-op if no
/// Compositor is subscribed (e.g. before the preview mounts).
export function requestPrebake(layerId: string): void {
  for (const l of listeners) l(layerId);
}

/// Subscribe (Compositor). Returns an unsubscribe fn for teardown.
export function onPrebakeRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/templates/prebakeBus.ts
git commit -m "feat(templates): prebakeBus bridges Pre-bake-now to the Compositor"
```

---

## Phase 6 — Wire it into the live path

### Task 12: Sprite reads disk-first

**Files:**
- Modify: `apps/desktop/src/render/sprite/TemplateSprite.ts:24,181`

- [ ] **Step 1: Swap the import + call**

Change the import (line 24) from:

```ts
import { rasterTemplateFrame, sharedTemplateFrameCache } from "../templates/templateRaster";
```

to:

```ts
import { resolveTemplateFrame, sharedTemplateFrameCache } from "../templates/templateRaster";
```

In `captureAndBind` (line ~181), change:

```ts
      const bitmap = await rasterTemplateFrame(this.template, tSec, durationSec, canonicalProps);
```

to:

```ts
      const bitmap = await resolveTemplateFrame(
        this.template, cacheKey, frame, tSec, durationSec, canonicalProps,
      );
```

(`cacheKey` and `frame` are already parameters of `captureAndBind`.)

- [ ] **Step 2: Verify typecheck + existing sprite-adjacent tests**

Run: `cd apps/desktop && npm run -s typecheck && npx vitest run src/render/templates`
Expected: exit 0; template unit tests green.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/sprite/TemplateSprite.ts
git commit -m "feat(templates): sprite on-demand miss reads L2 disk-first"
```

### Task 13: Compositor owns the baker; prewarm + index + GC wiring

**Files:**
- Modify: `apps/desktop/src/render/Compositor.ts` (imports; prewarmer closure ~945; new baker field; `setProject` ~485; `updatePrewarmTargets` ~919; dispose ~826)

- [ ] **Step 1: Point the prewarm render closure at the resolver**

In `updatePrewarmTargets` (~line 945), change the spec's `render`:

```ts
          render: (frame: number) =>
            resolveTemplateFrame(
              template,
              desc.cacheKey,
              frame,
              (frame * fpsDen) / fpsNum,
              durationSec,
              canonicalProps,
            ),
```

Update the import (line 29) to add `resolveTemplateFrame`, `sharedBakedKeyIndex`:

```ts
import {
  resolveTemplateFrame,
  rasterTemplateFrame,
  sharedBakedKeyIndex,
  sharedTemplateFrameCache,
} from "./templates/templateRaster";
```

(`rasterTemplateFrame` stays imported only if still referenced; remove if not.)

- [ ] **Step 2: Add the baker field (DOM-gated, like the prewarmer)**

Near the `prewarmer` field (~263), add:

```ts
  /// L2 writer. DOM-gated like the prewarmer (never in the export Worker).
  /// Null until `setProject` constructs it with the encode/write deps.
  private baker: TemplateBaker | null =
    typeof document !== "undefined"
      ? new TemplateBaker({
          schedule: (cb) => scheduleIdle(cb),
          cancel: (t) => cancelIdle(t),
          isOnDisk: (k, f) => sharedTemplateFrameCache.hasPng(k, f),
          persist: async (k, f, bmp) => {
            const png = await encodeBitmapToPng(bmp);
            await sharedTemplateFrameCache.writePng(k, f, png);
            sharedBakedKeyIndex.add(k);
          },
          warm: (k, f, bmp) => {
            // Warm L0 with the just-baked bitmap (cache takes ownership).
            sharedTemplateFrameCache.setFrame(k, f, bmp);
          },
        })
      : null;
  /// LayerIds the user manually "Pre-bake now"'d this session — baked even
  /// when the global setting is off.
  private manualPrebakeLayers = new Set<string>();
  /// Unsubscribe handle for the prebake bus.
  private prebakeUnsub: (() => void) | null = null;
```

Add imports at the top:

```ts
import { TemplateBaker, type BakeContentSpec } from "./templates/TemplateBaker";
import { encodeBitmapToPng } from "./templates/pngEncode";
import { onPrebakeRequest } from "./templates/prebakeBus";
import { usePrebakeTemplatesEnabled } from "../settings/appSettingsStore";
import { useAppSettingsStore } from "../settings/appSettingsStore";
```

> NOTE: read the setting imperatively (the Compositor isn't a React component):
> `useAppSettingsStore.getState().settings.prebake_templates`.

- [ ] **Step 2b: Subscribe to the prebake bus once (constructor or first setProject)**

Where the Compositor initializes preview-mode wiring (after the baker field is set, e.g. in the constructor body or guarded in `setProject`), subscribe:

```ts
    if (this.baker && !this.prebakeUnsub) {
      this.prebakeUnsub = onPrebakeRequest((layerId) => {
        this.manualPrebakeLayers.add(layerId);
        this.updateBakeTargets(this.lastTUs);
      });
    }
```

- [ ] **Step 3: Build the baker's active set + the live index hydration**

Add a method beside `updatePrewarmTargets`:

```ts
  /// Feed the baker the contents to persist: ALL active template contents when
  /// the global "Pre-bake" setting is on, plus any manually-requested layers'
  /// contents regardless. Reuses the same descriptors `updatePrewarmTargets`
  /// builds. No-op (clears) when neither trigger applies.
  private updateBakeTargets(tUs: number): void {
    if (!this.baker || !this.projectSummary) return;
    const globalOn = useAppSettingsStore.getState().settings.prebake_templates;
    const specs: BakeContentSpec[] = [];
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        if (layer.params.kind !== "Template") continue;
        const wanted = globalOn || this.manualPrebakeLayers.has(layer.id);
        if (!wanted) continue;
        const template = getTemplate(layer.params.template_id);
        if (!template) continue;
        const tInLayerUs = tUs - layer.t_start_us;
        const desc = templateFrameDescriptor(
          layer.params, tInLayerUs, (layer.t_end_us - layer.t_start_us),
          this.fpsNum, this.fpsDen, template,
        );
        if (!desc) continue;
        const { fpsNum, fpsDen } = this;
        const durationSec = desc.durationSec;
        const canonicalProps = desc.canonicalProps;
        specs.push({
          cacheKey: desc.cacheKey,
          contentFrame: desc.contentFrame,
          contentDurationFrames: desc.contentDurationFrames,
          render: (frame: number) =>
            rasterTemplateFrame(template, (frame * fpsDen) / fpsNum, durationSec, canonicalProps),
        });
      }
    }
    this.baker.setTargets(specs);
  }
```

> NOTE: the baker's `render` uses `rasterTemplateFrame` directly (NOT
> `resolveTemplateFrame`) — the baker is the writer; reading disk-first here
> would be pointless (it just rendered to write). Keep `rasterTemplateFrame`
> imported for this path. Confirm `templateFrameDescriptor`'s signature matches
> the call (it's the same one `updatePrewarmTargets` uses — copy that call shape
> exactly, including how it derives `tInLayerUs`/`durationSec`).

- [ ] **Step 4: Call `updateBakeTargets` everywhere `updatePrewarmTargets` is called**

In `setProject` (~485) after `this.updatePrewarmTargets(this.lastTUs);` add `this.updateBakeTargets(this.lastTUs);`.
In `compositeFrame`'s per-frame refresh (~639) after the prewarm re-plan, add `this.updateBakeTargets(tUsSnapped);`.

- [ ] **Step 5: Hydrate the baked-key index + GC on project load**

In `setProject`, after the summary is applied and BEFORE `updatePrewarmTargets`, add a fire-and-forget hydration (collect the active cacheKeys from descriptors, hydrate, then GC orphans):

```ts
    if (this.baker) {
      void this.hydrateBakedIndexAndGc();
    }
```

Add the method:

```ts
  /// Build the set of active template cacheKeys, tell the index which keys are
  /// live, hydrate it from the on-disk dir names, then sweep orphan dirs.
  /// Best-effort: any fs error is logged, never thrown (preview must still run).
  private async hydrateBakedIndexAndGc(): Promise<void> {
    if (!this.projectSummary) return;
    const activeKeys: string[] = [];
    for (const track of this.projectSummary.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "Template") continue;
        const template = getTemplate(layer.params.template_id);
        if (!template) continue;
        const tInLayerUs = 0;
        const desc = templateFrameDescriptor(
          layer.params, tInLayerUs, (layer.t_end_us - layer.t_start_us),
          this.fpsNum, this.fpsDen, template,
        );
        if (desc) activeKeys.push(desc.cacheKey);
      }
    }
    sharedBakedKeyIndex.setLiveCandidates(activeKeys);
    try {
      const hashes = await sharedTemplateFrameCache.listBakedHashes();
      sharedBakedKeyIndex.hydrateFromHashes(hashes);
      await sharedTemplateFrameCache.gcUnreferenced(activeKeys);
    } catch (e) {
      console.warn("[weftcut/templates] baked-index hydrate/gc failed", e);
    }
  }
```

> This calls a new `listBakedHashes()` on the cache — add it in Step 6.

- [ ] **Step 6: Add `listBakedHashes` to `frameCache.ts`**

After `gcUnreferenced`, add:

```ts
  /// The set of `<hash>` dir names currently under `Cache/raster`. Empty when
  /// no project is open or the dir doesn't exist. Used to hydrate the
  /// in-RAM baked-key index on project load.
  async listBakedHashes(): Promise<Set<string>> {
    const root = await rasterRootDir();
    if (root === null) return new Set();
    const { readDir, exists } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(root))) return new Set();
    const entries = await readDir(root);
    const out = new Set<string>();
    for (const e of entries) if (e.isDirectory) out.add(e.name);
    return out;
  }
```

- [ ] **Step 7: Dispose the baker + unsubscribe**

In `dispose` (~826), beside `this.prewarmer?.dispose(); this.prewarmer = null;`, add:

```ts
    this.baker?.dispose();
    this.baker = null;
    this.prebakeUnsub?.();
    this.prebakeUnsub = null;
    this.manualPrebakeLayers.clear();
    sharedBakedKeyIndex.clear();
```

- [ ] **Step 8: Verify typecheck + template units + no-regression render units**

Run: `cd apps/desktop && npm run -s typecheck && npx vitest run src/render`
Expected: exit 0; all green.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/render/Compositor.ts apps/desktop/src/render/templates/frameCache.ts
git commit -m "feat(templates): Compositor wires L2 baker, disk-first prewarm, index+GC on load"
```

---

## Phase 7 — UI

### Task 14: Settings "Pre-bake templates" toggle + i18n

**Files:**
- Modify: `apps/desktop/src/settings/SettingsPanel.tsx`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`, `zh-CN.ts`

- [ ] **Step 1: Add the i18n keys**

In `en-US.ts`, under the `settings` object, add:

```ts
    prebake_templates: "Pre-bake templates",
    prebake_templates_hint:
      "Render template animation frames to disk in the background so playback stays smooth and reopening the project is instant. Uses disk space under the project's Cache folder.",
```

In `zh-CN.ts`, the same keys:

```ts
    prebake_templates: "预烘焙模板",
    prebake_templates_hint:
      "在后台将模板动画帧渲染到磁盘，使播放更流畅、重新打开项目时即时加载。会在项目的 Cache 文件夹下占用磁盘空间。",
```

In `Timeline`'s namespace (same files, under `timeline`):

```ts
    prebake_now: "Pre-bake now",
```

```ts
    prebake_now: "立即预烘焙",
```

- [ ] **Step 2: Add the toggle section to `SettingsPanel.tsx`**

Import the selector + setter (top of file, extend the `./appSettingsStore` import):

```ts
import {
  setAppSettings,
  usePrebakeTemplatesEnabled,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "./appSettingsStore";
```

Add a section in the body, after `<TimelineSnapSection .../>` (~line 133):

```tsx
        <h3>{t("settings.templates_heading", { defaultValue: "Templates" })}</h3>
        <PrebakeSection onError={setError} />
```

Add the component (beside `TimelineSnapSection`):

```tsx
function PrebakeSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const enabled = usePrebakeTemplatesEnabled();
  return (
    <label className="settings-toggle-row">
      <input
        type="checkbox"
        checked={enabled}
        onChange={async (e) => {
          const next = e.target.checked;
          onError("");
          try {
            await setAppSettings({ prebake_templates: next });
          } catch (err) {
            onError(String(err));
          }
        }}
      />
      <span>
        <span className="settings-toggle-label">{t("settings.prebake_templates")}</span>
        <span className="settings-toggle-hint">{t("settings.prebake_templates_hint")}</span>
      </span>
    </label>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/settings/SettingsPanel.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(settings): Pre-bake templates toggle + i18n"
```

### Task 15: "Pre-bake now" context-menu item

**Files:**
- Modify: `apps/desktop/src/timeline/Timeline.tsx` (`LayerContextMenu` ~1152; the menu open state passes `layerKind`; add a handler + prop)

- [ ] **Step 1: Add an `onPrebakeNow` handler in `Timeline`**

Near `onSeparateAudio` (~977), add:

```tsx
  const onPrebakeNow = useCallback((layerId: string) => {
    setContextMenu(null);
    requestPrebake(layerId);
  }, []);
```

Import at the top of the file:

```ts
import { requestPrebake } from "../render/templates/prebakeBus";
```

- [ ] **Step 2: Pass it to `LayerContextMenu` + render the item for Template layers**

At the `<LayerContextMenu .../>` usage (~1132) add the prop:

```tsx
        onPrebakeNow={onPrebakeNow}
```

In `LayerContextMenu`'s signature add `onPrebakeNow: (id: string) => void;` and render the item. Replace the body so a Template layer shows "Pre-bake now":

```tsx
      {layerKind === "Audio" ? (
        <button
          type="button"
          className="layer-context-menu-item"
          onClick={() => onSeparateAudio(layerId)}
        >
          {t("timeline.separate_audio", { defaultValue: "Separate audio to new track" })}
        </button>
      ) : layerKind === "Template" ? (
        <button
          type="button"
          className="layer-context-menu-item"
          onClick={() => onPrebakeNow(layerId)}
        >
          {t("timeline.prebake_now", { defaultValue: "Pre-bake now" })}
        </button>
      ) : (
        <span className="layer-context-menu-disabled">
          {t("timeline.no_actions_here", { defaultValue: "(no actions for this layer)" })}
        </span>
      )}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/desktop && npm run -s typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/timeline/Timeline.tsx
git commit -m "feat(timeline): Pre-bake now context-menu action for template layers"
```

---

## Phase 8 — Real-WebView2 e2e (the disk path can't be faked)

### Task 16: e2e — bake writes disk, reload reads disk, GC sweeps orphans

**Files:**
- Create: `apps/desktop/e2e/specs/template_prebake.e2e.js`

> Follow the existing `templates.e2e.js` / `template_export.e2e.js` setup
> (tauri-driver + WebdriverIO; msedgedriver MUST match the WebView2 148.x or it
> hangs — see the media-conformance harness note). Open a workspace with a known
> path, add a `countdown` template layer, and drive via `webview_execute_js`.

- [ ] **Step 1: Write the e2e spec**

```js
// Verifies L2 pre-bake end to end in the real WebView2:
//  (1) enabling the global setting (or "Pre-bake now") writes PNG frames to
//      <workspace>/Cache/raster/<hash>/<i>.png;
//  (2) after re-applying the project the read path binds frames from disk
//      (no fresh raster for baked frames);
//  (3) gcUnreferenced removes an orphan dir after a prop change.
describe("template L2 pre-bake", () => {
  it("bakes a template layer's frames to disk", async () => {
    // - open the test workspace
    // - add a countdown template layer (add_template IPC)
    // - flip prebake_templates on (appSettingsSet) OR fire requestPrebake(layerId)
    // - poll the workspace Cache/raster dir until N PNG files exist
    //   (use the Rust fs / a read_dir IPC or webview plugin-fs readDir)
    // - assert >= contentDurationFrames PNGs for the layer's hash dir
  });

  it("reads baked frames from disk on reload without re-rastering", async () => {
    // - instrument: spy/count harness.renderFrameSvg calls (window.__weftcutTemplatePerf)
    // - re-apply the project summary (simulating reload) so the index rehydrates
    // - scrub the playhead across the layer
    // - assert the render count stays 0 for already-baked frames (disk hits)
  });

  it("GC removes an orphan hash dir after a prop change", async () => {
    // - bake, note the hash dir
    // - patch a prop (new cacheKey → new hash)
    // - trigger setProject (hydrate+gc)
    // - assert the old hash dir is gone, the new one appears once baked
  });
});
```

- [ ] **Step 2: Add the render-count instrument**

In `templateRaster.ts` (or the harness), behind a test hook, increment
`window.__weftcutTemplatePerf.renders` in `rasterTemplateFrame` so the e2e can
assert "0 fresh rasters for baked frames". Gate it on `typeof window !== "undefined"`
and a test flag so it's inert in production. (Mirror `window.__weftcutExportPerf`.)

- [ ] **Step 3: Run the e2e**

Run: `cd apps/desktop && npm run -s e2e -- --spec e2e/specs/template_prebake.e2e.js`
Expected: 3/3 pass in real WebView2. (If msedgedriver/WebView2 mismatch hangs, align versions per the harness note.)

- [ ] **Step 4: Run the full template e2e for no-regression**

Run: `cd apps/desktop && npm run -s e2e -- --spec e2e/specs/templates.e2e.js && npm run -s e2e -- --spec e2e/specs/template_export.e2e.js`
Expected: existing specs still green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/specs/template_prebake.e2e.js apps/desktop/src/render/templates/templateRaster.ts
git commit -m "test(templates): real-WebView2 e2e for L2 pre-bake disk round-trip"
```

---

## Phase 9 — Docs

### Task 17: Reconcile `docs/templates.md` + add ADR 0016

**Files:**
- Modify: `docs/templates.md` (the "L2" bullet ~224-230, the escalation paragraph ~231-238, the cache-key table line ~253)
- Create: `docs/adr/0016-template-l2-prebake.md`

- [ ] **Step 1: Rewrite the L2 trigger description**

In the escalation section, replace the "measurement-driven" L2 paragraph with the
shipped behavior: L2 is driven by **two explicit triggers** — a global "Pre-bake"
setting (default off) that bakes every active template content in the background,
and a per-layer **"Pre-bake now"** right-click action; there is no hardware-timing
auto-escalation. Reads are disk-first (a `resolveTemplateFrame` shared by sprite +
prewarmer); writes are centralized in a `TemplateBaker`. Keep the L0/L1 text as-is.

- [ ] **Step 2: Fix the cache-key table line**

Change the row:

```
| composition width / height | no persisted-key change (L0/L1 raster at composite res) |
```

to:

```
| composition width / height | re-key (bake/render resolution tracks display size, never below — so a resize re-bakes; GC reclaims the orphan) |
```

- [ ] **Step 3: Write ADR 0016**

```markdown
# 0016 — Template L2 persisted pre-bake

Status: accepted

## Context
L1 (in-RAM lookahead) can't keep up when raster throughput is the bottleneck
(stacked templates / 4K / weak GPU): playback stutters and reopening a project
re-rasters every frame. The L2 disk layer existed in `frameCache.ts` but was
unwired and runtime-blocked (the fs scope excluded the user-chosen workspace).

## Decision
- Grant the fs plugin the workspace dir at project-open
  (`app.fs_scope().allow_directory(ws, true)`) + the six `fs:allow-*` perms.
- `resolveTemplateFrame` is a read-only disk-first path shared by the sprite and
  prewarmer; a `TemplateBaker` is the sole writer (centralized → no
  fire-and-forget LRU-eviction race).
- Two explicit triggers: a global "Pre-bake" setting (default off) and a
  per-layer "Pre-bake now". No measurement-driven auto-escalation (rejected:
  a single-raster timing mispredicts the stacked-template case).
- PNG, not WebP (Canvas WebP is lossy; ADR 0015). Bake at display resolution.
- A baked-key index (readDir on load) gates disk reads so un-baked templates
  pay no IPC.

## Consequences
- Manual pre-bakes persist: PNGs are the state, honored on reload even with the
  global toggle off.
- Export reading PNGs directly is a near-free follow-up, not in this change.
- User-facing name is "Pre-bake", never "cache to disk".
```

- [ ] **Step 4: Verify links/build (if docs are linted) and commit**

```bash
git add docs/templates.md docs/adr/0016-template-l2-prebake.md
git commit -m "docs(templates): reconcile L2 to shipped pre-bake design + ADR 0016"
```

---

## Final verification

- [ ] **Run the full gate.**

```bash
cd apps/desktop && npm run -s typecheck && npx vitest run
cd apps/desktop/src-tauri && cargo test
cd apps/desktop && npm run -s e2e -- --spec e2e/specs/template_prebake.e2e.js
```
Expected: typecheck exit 0; vitest all green (incl. bakePlan/bakedKeyIndex/TemplateBaker); cargo tests green (incl. `prebake_templates_*`); e2e 3/3.

- [ ] **Manual smoke (`tauri dev`):** the running app is an older build — rebuild.
  Open a project, add a countdown template, toggle Settings → "Pre-bake templates"
  on, confirm `<workspace>/Cache/raster/<hash>/` fills with PNGs, scrub smoothly,
  reopen the project and confirm instant template paint. Right-click a template
  layer → "Pre-bake now" with the global toggle off and confirm it bakes.

---

## Self-Review notes (addressed)

- **Spec coverage:** fs prereq (T1–T2), baked-key index (T6, T13), resolver
  read-through (T9, T12), full-content baker (T5, T10, T13), global toggle
  (T3–T4, T14), "Pre-bake now" (T11, T15), PNG encode (T8), GC-on-load (T13),
  per-layer status — *deferred* (the spec lists it as reuse of an existing
  surface; no `rastering{progress}` plumbing exists yet, so it's out of this
  plan's scope; the context-menu action + disk artifacts give sufficient
  feedback for v1). Export read-from-disk — out of scope per spec.
- **Refinement vs spec:** writes are centralized in `TemplateBaker` (not
  fire-and-forget in the resolver) — documented in Architecture + ADR.
- **Type consistency:** `resolveTemplateFrame(template, cacheKey, frame, tSec,
  durationSec, canonicalProps)` is used identically in T9/T12/T13;
  `BakeContentSpec` fields (`cacheKey/contentFrame/contentDurationFrames/render`)
  match `bakePlan.BakeContent` + the baker; `sharedBakedKeyIndex` /
  `listBakedHashes` / `hasPng` / `encodeBitmapToPng` names are consistent across
  tasks.
