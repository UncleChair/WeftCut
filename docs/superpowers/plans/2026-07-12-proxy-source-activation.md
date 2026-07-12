# Proxy Source Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the decode overlay's already-modeled `source: proxy` axis into a user-opt-in preview-proxy feature (project-scoped "Prefer Proxies" toggle + per-clip override), so heavy footage can preview off the lightweight 720p quick proxy.

**Architecture:** Feed one computed boolean (`useProxySource = intent && quickProxyReady`) into the pure `resolveDecodeEngine`, which already models the axis. State lives in `ProjectSettings` (undo-immune via the unrecorded `update_project_settings` mutation), mirrored into a small renderer store the resolver reads live. Closing the `ffmpeg × proxy` landmine (proxy ⇒ always WebCodecs) is part of the same resolver edit. An on-demand `generate_quick_proxy` backend command fills gaps, cloned from the existing `ensure_full_proxy`.

**Tech Stack:** TypeScript (Electron main + renderer, React, Zustand), Rust (napi-rs, tokio, anyhow), Vitest (unit), Playwright `_electron` (e2e), i18next (en-US + zh-CN).

## Global Constraints

Every task's requirements implicitly include these (copied from the spec `docs/superpowers/specs/2026-07-12-proxy-source-activation-design.md`):

- **Purely additive.** Do NOT change import-time quick-proxy auto-enqueue, do NOT migrate derivative jobs, do NOT touch the export master or export-side decode.
- **Proxy ⇒ always WebCodecs.** The proxy branch resolves to `engine: "webcodecs"` regardless of the `decode_engine` setting.
- **`Bypass` sources are out of scope** for proxy generation (no `quick_proxy` slot; already light). The per-clip control is hidden for them; the global toggle leaves them on the original.
- **Undo-immune.** All new state is written only through the unrecorded `update_project_settings` mutation; undo must never flip it.
- **i18n both locales.** Every new user-facing string gets an en-US (`i18n/locales/en-US.ts`) and zh-CN (`i18n/locales/zh-CN.ts`) key.
- **Atomic Zustand selectors only** (`feedback_zustand_composite_selector`) — never select a whole object.
- Native-decode Standard engine remains Windows-only; unchanged here.

**Placement note (spec §5 deviation, flagged):** the spec named the preview/transport toolbar as the *primary* home for the global toggle but explicitly deferred exact placement to this plan. This plan places the MVP toggle in the **Settings panel** (an exact clone of the existing per-project `auto_delete_empty_tracks` toggle — lowest risk, real precedent). A preview-toolbar quick-pill and a command-palette "Toggle proxy preview" entry are recommended **fast-follows, out of MVP**.

---

### Task 1: `ProjectSettings` state — `prefer_proxies` + `proxy_overrides`

Adds the two persisted, undo-immune fields end-to-end: TS model, the unrecorded mutation, the renderer IPC view/patch, and Rust deserialize-compat. This is a near-mechanical clone of the existing `auto_delete_empty_tracks` seam.

**Files:**
- Modify: `apps/desktop/src/main/state/model.ts:120-142` (TS `ProjectSettings` + `defaultSettings`)
- Modify: `apps/desktop/src/main/state/actor.ts:351-355,468` (`updateProjectSettings` patch + dispatch arg cast)
- Modify: `apps/desktop/src/renderer/ipc/index.ts:995-1013` (`ProjectSettingsView`, `ProjectSettingsPatch`)
- Modify: the TS `get_project_settings` handler in `apps/desktop/src/main/` (grep `get_project_settings`; it returns `ProjectSettingsView` — add the two fields to its projection)
- Modify: `apps/desktop/native/src/state/project.rs:120-149,160-175` (Rust struct + `ProjectSettingsPatch` + defaults, for load-time deserialize compat)
- Test: `apps/desktop/src/main/state/actor.test.ts` (new `it` beside line 452)

**Interfaces:**
- Produces: `ProjectSettings.prefer_proxies: boolean`, `ProjectSettings.proxy_overrides: Record<string, boolean>` (mediaId → forced value; absent = follow global). Patch fields: `prefer_proxies?: boolean`, `proxy_override?: { media_id: string; value: boolean | null }` (`value: null` clears the override).

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/main/state/actor.test.ts`, add beside the existing settings test (line 452):

```ts
  it('update_project_settings sets prefer_proxies + proxy_overrides (unrecorded, survives undo)', () => {
    const { actor, a } = setup()
    actor.dispatch('update_project_settings', { patch: { prefer_proxies: true } })
    actor.dispatch('update_project_settings', { patch: { proxy_override: { media_id: 'm1', value: false } } })
    expect(actor.snapshot().settings.prefer_proxies).toBe(true)
    expect(actor.snapshot().settings.proxy_overrides).toEqual({ m1: false })
    // clearing an override removes the key (Auto = follow global)
    actor.dispatch('update_project_settings', { patch: { proxy_override: { media_id: 'm1', value: null } } })
    expect(actor.snapshot().settings.proxy_overrides).toEqual({})
    // preference survives undo
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo', {})
    expect(actor.snapshot().settings.prefer_proxies).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/state/actor.test.ts -t "prefer_proxies"`
Expected: FAIL — `prefer_proxies`/`proxy_overrides` undefined on settings.

- [ ] **Step 3: Extend the TS model**

In `apps/desktop/src/main/state/model.ts`, extend the interface (line 120-123) and defaults (line 140-143):

```ts
export interface ProjectSettings {
  preview_width: number; preview_height: number; autosave_interval_secs: number | null
  history_capacity: number; auto_pair_audio_on_import: boolean; auto_delete_empty_tracks: boolean
  prefer_proxies: boolean
  proxy_overrides: Record<string, boolean>
}
```
```ts
function defaultSettings(): ProjectSettings {
  return { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
    history_capacity: 200, auto_pair_audio_on_import: true, auto_delete_empty_tracks: true,
    prefer_proxies: false, proxy_overrides: {} }
}
```

- [ ] **Step 4: Extend the mutation**

In `apps/desktop/src/main/state/actor.ts`, replace `updateProjectSettings` (line 351-356) and widen the dispatch cast (line 468):

```ts
  function updateProjectSettings(patch: {
    auto_delete_empty_tracks?: boolean | null
    prefer_proxies?: boolean | null
    proxy_override?: { media_id: string; value: boolean | null } | null
  }): void {
    const next = { ...current().settings, proxy_overrides: { ...current().settings.proxy_overrides } }
    if (typeof patch.auto_delete_empty_tracks === 'boolean') next.auto_delete_empty_tracks = patch.auto_delete_empty_tracks
    if (typeof patch.prefer_proxies === 'boolean') next.prefer_proxies = patch.prefer_proxies
    if (patch.proxy_override) {
      const { media_id, value } = patch.proxy_override
      if (value === null) delete next.proxy_overrides[media_id]
      else next.proxy_overrides[media_id] = value
    }
    history.replaceSettingsEverywhere(next)
    broadcastUnrecorded('Updated project settings', current())
  }
```
Update the dispatch arm cast (line 468):
```ts
        case 'update_project_settings': updateProjectSettings(a.patch as { auto_delete_empty_tracks?: boolean | null; prefer_proxies?: boolean | null; proxy_override?: { media_id: string; value: boolean | null } | null }); return { ok: true, value: null }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/state/actor.test.ts -t "prefer_proxies"`
Expected: PASS.

- [ ] **Step 6: Extend the renderer IPC view + patch**

In `apps/desktop/src/renderer/ipc/index.ts` (lines 995-1001):

```ts
export interface ProjectSettingsView {
  auto_delete_empty_tracks: boolean;
  prefer_proxies: boolean;
  proxy_overrides: Record<string, boolean>;
}

export interface ProjectSettingsPatch {
  auto_delete_empty_tracks?: boolean;
  prefer_proxies?: boolean;
  proxy_override?: { media_id: string; value: boolean | null };
}
```
Then in the TS `get_project_settings` handler (grep `get_project_settings` under `apps/desktop/src/main/`), add `prefer_proxies` and `proxy_overrides` to the returned projection (it currently returns only `auto_delete_empty_tracks`).

- [ ] **Step 7: Extend the Rust deserialize struct**

In `apps/desktop/native/src/state/project.rs`, add the fields to `ProjectSettings` (near line 133) with serde defaults so old saved projects (and the patch) round-trip:

```rust
    #[serde(default)]
    pub prefer_proxies: bool,
    #[serde(default)]
    pub proxy_overrides: std::collections::HashMap<String, bool>,
```
Add to `ProjectSettingsPatch` (line 147-149):
```rust
    pub prefer_proxies: Option<bool>,
    #[serde(default)]
    pub proxy_override: Option<ProxyOverridePatch>,
```
Define the patch sub-struct near it:
```rust
#[derive(Clone, Debug, Deserialize)]
pub struct ProxyOverridePatch {
    pub media_id: String,
    pub value: Option<bool>,
}
```
Add the two fields to the `Default`/constructor impl (line 160-173) — `prefer_proxies: false`, `proxy_overrides: Default::default()`.

- [ ] **Step 8: Verify TS typecheck + Rust build**

Run: `cd apps/desktop && npx tsc -b --noEmit` — Expected: no errors.
Run: `cd apps/desktop && npm run napi:build` — Expected: build succeeds (close the running app first — the `.node` is locked, `reference_napi_build_lock_and_skew`).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/state/model.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/src/renderer/ipc/index.ts apps/desktop/native/src/state/project.rs
git commit -m "feat(decode): ProjectSettings prefer_proxies + per-clip proxy_overrides (unrecorded)"
```

---

### Task 2: Renderer proxy-preference store

A focused Zustand store mirroring the two settings for live reads by `PixiPreview` and the UI, plus imperative setters that write through `updateProjectSettings`. Mirrors the `appSettingsStore` pattern.

**Files:**
- Create: `apps/desktop/src/renderer/state/proxyPreferenceStore.ts`
- Test: `apps/desktop/src/renderer/state/proxyPreferenceStore.test.ts`
- Modify: `apps/desktop/src/renderer/App.tsx` (call `wireProxyPrefStore()` once on mount, beside `wireAppSettingsStream()`)

**Interfaces:**
- Consumes: `getProjectSettings`, `updateProjectSettings` (Task 1), `useProjectStore` (`state/projectStore.ts`).
- Produces: `useProxyPrefStore` (Zustand), `proxyIntent(mediaId: string): boolean`, `setPreferProxies(v: boolean): Promise<void>`, `setProxyOverride(mediaId: string, value: boolean | null): Promise<void>`, `wireProxyPrefStore(): () => void`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/state/proxyPreferenceStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useProxyPrefStore, proxyIntent } from "./proxyPreferenceStore";

describe("proxyPreferenceStore", () => {
  beforeEach(() => {
    useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
  });

  it("proxyIntent follows the global toggle when no override is set", () => {
    useProxyPrefStore.setState({ preferProxies: true, overrides: {} });
    expect(proxyIntent("m1")).toBe(true);
  });

  it("a per-clip override wins over the global toggle", () => {
    useProxyPrefStore.setState({ preferProxies: true, overrides: { m1: false } });
    expect(proxyIntent("m1")).toBe(false);
    useProxyPrefStore.setState({ preferProxies: false, overrides: { m1: true } });
    expect(proxyIntent("m1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/state/proxyPreferenceStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `apps/desktop/src/renderer/state/proxyPreferenceStore.ts`:

```ts
// Renderer mirror of the two proxy-preference ProjectSettings fields
// (prefer_proxies + proxy_overrides). PixiPreview reads it live per
// ensureClip; the UI subscribes via atomic selectors. Setters write
// through the unrecorded update_project_settings mutation, then update
// the store optimistically (updateProjectSettings returns void). Follows
// the appSettingsStore pattern. See docs/preview.md §Proxies.

import { create } from "zustand";

import { getProjectSettings, updateProjectSettings } from "../ipc";
import { useProjectStore } from "./projectStore";

interface ProxyPrefState {
  preferProxies: boolean;
  overrides: Record<string, boolean>;
  hydrate: (v: { preferProxies: boolean; overrides: Record<string, boolean> }) => void;
}

export const useProxyPrefStore = create<ProxyPrefState>((set) => ({
  preferProxies: false,
  overrides: {},
  hydrate: (v) => set({ preferProxies: v.preferProxies, overrides: v.overrides }),
}));

/** Effective per-clip intent: a per-clip override wins over the global toggle. */
export function proxyIntent(mediaId: string): boolean {
  const s = useProxyPrefStore.getState();
  return s.overrides[mediaId] ?? s.preferProxies;
}

export async function setPreferProxies(v: boolean): Promise<void> {
  await updateProjectSettings({ prefer_proxies: v });
  useProxyPrefStore.setState({ preferProxies: v });
}

export async function setProxyOverride(mediaId: string, value: boolean | null): Promise<void> {
  await updateProjectSettings({ proxy_override: { media_id: mediaId, value } });
  useProxyPrefStore.setState((s) => {
    const overrides = { ...s.overrides };
    if (value === null) delete overrides[mediaId];
    else overrides[mediaId] = value;
    return { overrides };
  });
}

async function rehydrate(): Promise<void> {
  try {
    const v = await getProjectSettings();
    useProxyPrefStore.getState().hydrate({ preferProxies: v.prefer_proxies, overrides: v.proxy_overrides });
  } catch {
    // No project loaded yet — keep defaults.
  }
}

/** Hydrate on mount and re-hydrate whenever the project summary swaps
 *  (new project / reload). Call once from App.tsx; returns an unsubscribe. */
export function wireProxyPrefStore(): () => void {
  void rehydrate();
  return useProjectStore.subscribe((s, prev) => {
    if (s.summary !== prev.summary) void rehydrate();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/state/proxyPreferenceStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it in App.tsx**

In `apps/desktop/src/renderer/App.tsx`, find where `wireAppSettingsStream()` is called on mount (an effect that stores an unlisten fn) and add `wireProxyPrefStore()` the same way, calling its returned unsubscribe in the effect cleanup. Add the import: `import { wireProxyPrefStore } from "./state/proxyPreferenceStore";`

- [ ] **Step 6: Verify + commit**

Run: `cd apps/desktop && npx tsc -b --noEmit` — Expected: no errors.
```bash
git add apps/desktop/src/renderer/state/proxyPreferenceStore.ts apps/desktop/src/renderer/state/proxyPreferenceStore.test.ts apps/desktop/src/renderer/App.tsx
git commit -m "feat(decode): renderer proxy-preference store mirroring ProjectSettings"
```

---

### Task 3: `quickProxyPath` accessor + resolver landmine fix (proxy ⇒ WebCodecs)

Adds the quick-proxy-specific path accessor and rewrites the resolver's proxy branch to resolve to WebCodecs unconditionally (closing the inert `ffmpeg × proxy` landmine). Pure, unit-tested.

**Files:**
- Modify: `apps/desktop/src/renderer/render/decodeRoute.ts` (add `quickProxyPath`)
- Modify: `apps/desktop/src/renderer/render/decoder/decodeEngine.ts:51-107`
- Test: `apps/desktop/src/renderer/render/decoder/resolveDecodeEngine.test.ts`

**Interfaces:**
- Produces: `quickProxyPath(media: { decode_route: DecodeRoute }): string | null`. Resolver: when `useProxySource` is true, returns `{ engine: "webcodecs", source: "proxy", ... }` regardless of `setting`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/renderer/render/decoder/resolveDecodeEngine.test.ts`, add to the source-axis describe block:

```ts
  it("proxy source resolves to webcodecs even when setting is ffmpeg", () => {
    expect(resolveDecodeEngine(base({
      setting: "ffmpeg", useProxySource: true, proxyReady: true,
      proxyUrl: "weftcut-media://p.mp4",
    }))).toMatchObject({
      engine: "webcodecs", source: "proxy", status: "ok", target: "weftcut-media://p.mp4",
      key: "webcodecs:proxy:weftcut-media://p.mp4",
    });
  });

  it("proxy source with no component still resolves to webcodecs (rescue path)", () => {
    expect(resolveDecodeEngine(base({
      setting: "ffmpeg", componentAvailable: false, useProxySource: true,
      proxyReady: true, proxyUrl: "weftcut-media://p.mp4",
    }))).toMatchObject({ engine: "webcodecs", source: "proxy", status: "ok" });
  });

  it("proxy requested but not ready → pending on webcodecs", () => {
    expect(resolveDecodeEngine(base({
      useProxySource: true, proxyReady: false, proxyUrl: null,
    }))).toMatchObject({ engine: "webcodecs", source: "proxy", status: "pending", target: null });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/resolveDecodeEngine.test.ts -t "proxy source"`
Expected: FAIL — the no-component case currently returns `unsupported` (engine gate fires before the proxy branch).

- [ ] **Step 3: Rewrite the resolver proxy handling**

In `apps/desktop/src/renderer/render/decoder/decodeEngine.ts`, hoist the proxy branch above the engine gates and strip it out of `forEngine`. Replace the body from line 51 through the `forEngine` definition:

```ts
export function resolveDecodeEngine(i: DecodeResolveInputs): DecodeResolution {
  const source: DecodeSource = i.useProxySource ? "proxy" : "original";

  const done = (
    engine: DecodeEngine,
    status: DecodeResolution["status"],
    target: string | null,
    reason: string,
  ): DecodeResolution => ({
    engine, source, target, status, reason,
    key: target ? `${engine}:${source}:${target}` : null,
  });

  // Proxy is always the 720p H.264 short-GOP quick proxy — WebCodecs-decodable
  // by construction — so it decodes on the Lite engine regardless of the
  // decode_engine setting. ffmpeg-on-proxy would need a file PATH (the proxy
  // branch only has a convertFileSrc URL) and is pointless on a light proxy;
  // routing to webcodecs is both the activation and the landmine fix, and it
  // rescues the no-component / pinned-Standard case. Hoisted ABOVE the engine
  // gates so a pinned-but-unusable engine never blocks a usable proxy.
  if (source === "proxy") {
    return i.proxyReady
      ? done("webcodecs", "ok", i.proxyUrl, "webcodecs on proxy")
      : done("webcodecs", "pending", null, "proxy building");
  }

  // source === "original" from here down.
  const forEngine = (engine: DecodeEngine): DecodeResolution => {
    if (engine === "ffmpeg") return done(engine, "ok", i.originalPath, "ffmpeg on original");
    // webcodecs × original
    switch (i.webcodecsCanDecodeOriginal) {
      case "ok": return done(engine, "ok", i.originalUrl, "webcodecs on original");
      case "fail": return done(engine, "unsupported", null, "webcodecs cannot decode this original");
      default: return done(engine, "pending", null, "webcodecs decodability untested");
    }
  };
```
Leave the rest (the `setting === "webcodecs"` / `"ffmpeg"` / auto blocks, lines 81-107) unchanged — they now only handle `source === "original"`.

- [ ] **Step 4: Add `quickProxyPath` to decodeRoute.ts**

In `apps/desktop/src/renderer/render/decodeRoute.ts`, add after `resolveDecode`:

```ts
/** The 720p quick proxy path for a media, or null if none exists yet or the
 *  route is Bypass (which has no quick_proxy slot). Distinct from
 *  resolveDecode().previewPath, which can be the original (Bypass) or the
 *  source-res full proxy — the proxy AXIS wants the light quick proxy only. */
export function quickProxyPath(media: { decode_route: DecodeRoute }): string | null {
  const r = media.decode_route;
  switch (r.route) {
    case "bypass": return null;
    case "direct-export": return r.quick_proxy;
    case "proxied": return r.quick_proxy;
    case "native-sw": return r.quick_proxy;
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/resolveDecodeEngine.test.ts`
Expected: PASS (all existing + new tests). The existing `webcodecs × proxy` test, if any, still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeEngine.ts apps/desktop/src/renderer/render/decoder/resolveDecodeEngine.test.ts apps/desktop/src/renderer/render/decodeRoute.ts
git commit -m "feat(decode): proxy source resolves to webcodecs; quickProxyPath accessor"
```

---

### Task 4: Feed the axis in PixiPreview

Wire the computed `useProxySource` into the resolver-input gatherer. The single behavioral edit that lights up the feature.

**Files:**
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx:37-38,178-194` (imports + `resolveSource`)

**Interfaces:**
- Consumes: `quickProxyPath` (Task 3), `proxyIntent` (Task 2).

- [ ] **Step 1: Add imports**

In `apps/desktop/src/renderer/render/PixiPreview.tsx`, extend the decodeRoute import (line 37) and add the store import:
```ts
import { resolveDecode, quickProxyPath } from "./decodeRoute";
import { proxyIntent } from "../state/proxyPreferenceStore";
```

- [ ] **Step 2: Compute and feed the axis**

Replace lines 178-194 (the `resolveDecodeEngine({...})` call). Keep `previewPath` for the existing readiness use if present, but source proxy inputs from `quickProxyPath`:
```ts
        const qp = quickProxyPath(m);
        const r = resolveDecodeEngine({
          setting,
          componentAvailable,
          // Gate on availability: intent true but no proxy on disk keeps the
          // original decoding until a build lands (then the swap key flips).
          useProxySource: proxyIntent(mediaId) && qp !== null,
          proxyReady: qp !== null,
          proxyUrl: qp !== null ? convertFileSrc(qp) : null,
          originalPath: m.path,
          originalUrl: convertFileSrc(m.path),
          webcodecsCanDecodeOriginal: (previewDecodableOf?.(mediaId) ?? false) ? "ok" : "untested",
          ffmpegUsable: !isFfmpegUnusable(mediaId),
        });
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/desktop && npx tsc -b --noEmit`
Expected: no errors. (`previewPath` on line 177 may now be unused — remove that line if `tsc`/lint flags it.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/render/PixiPreview.tsx
git commit -m "feat(decode): PixiPreview feeds useProxySource = intent && quickProxyReady"
```

---

### Task 5: Rust `generate_quick_proxy` command

On-demand quick-proxy build, cloned from `ensure_full_proxy`. Idempotent; skips `Bypass` and already-present proxies.

**Files:**
- Modify: `apps/desktop/native/src/jobs/mod.rs` (add `pub fn enqueue_quick_proxy` beside `enqueue_full_proxy` ~line 177)
- Modify: `apps/desktop/native/src/commands/media.rs` (add `generate_quick_proxy` beside `ensure_full_proxy` line 257)
- Modify: `apps/desktop/native/src/napi_backend.rs` (dispatch arm ~line 460; mirror-test list line 956)

**Interfaces:**
- Consumes: `crate::commands::MediaItemArgs { item }`, `spawn_quick_proxy`, `ffmpeg_sem`.
- Produces: dispatch command name `"generate_quick_proxy"` taking `{ item: MediaItem }`; landing `MediaDerivativesPatch.quick_proxy_landed` via the existing `spawn_quick_proxy` success path → `media:derivatives` event.

- [ ] **Step 1: Add the enqueue wrapper**

In `apps/desktop/native/src/jobs/mod.rs`, beside `enqueue_full_proxy` (line 177):

```rust
/// On-demand quick-proxy build (per-clip "Generate proxy" / global Prefer
/// Proxies gap-fill). `then_full: false` — this never chains a full proxy.
/// `source_gop_secs: None` forces a transcode (safe scrub-proxy path); the
/// import fan-out probes the gap for its own build, on-demand keeps it simple.
#[cfg(feature = "jobs")]
pub fn enqueue_quick_proxy(
    events: Arc<dyn EventSink>,
    cache: CacheLayout,
    media: MediaItem,
    source_gop_secs: Option<f64>,
) {
    spawn_quick_proxy(events, cache, media, false, source_gop_secs);
}
```

- [ ] **Step 2: Add the command handler**

In `apps/desktop/native/src/commands/media.rs`, beside `ensure_full_proxy` (line 257):

```rust
/// Ask the backend to build the 720p quick preview proxy for a media item on
/// demand. Idempotent: no-op on Bypass (no quick_proxy slot) or when the quick
/// proxy already exists. See docs/preview.md §Proxies.
#[cfg(feature = "jobs")]
pub async fn generate_quick_proxy(backend: &Backend, item: MediaItem) -> Result<(), String> {
    let existing = match &item.decode_route {
        state::DecodeRoute::DirectExport { quick_proxy } => quick_proxy.clone(),
        state::DecodeRoute::Proxied { quick_proxy, .. } => quick_proxy.clone(),
        state::DecodeRoute::NativeSw { quick_proxy, .. } => quick_proxy.clone(),
        state::DecodeRoute::Bypass => return Ok(()),
    };
    if matches!(existing, Some(ref p) if p.is_file()) {
        return Ok(());
    }
    crate::jobs::enqueue_quick_proxy(backend.events.clone(), backend.cache.clone(), item, None);
    Ok(())
}
```

- [ ] **Step 3: Add the dispatch arm + mirror-test name**

In `apps/desktop/native/src/napi_backend.rs`, beside the `ensure_full_proxy` arm (line 460-464):

```rust
            #[cfg(feature = "jobs")]
            "generate_quick_proxy" => {
                let a: crate::commands::MediaItemArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::generate_quick_proxy(self, a.item).await)
            }
```
Add `"generate_quick_proxy"` to the command-name array in the mirror test at line 956:
```rust
        for cmd in ["get_media_thumbnail", "get_waveform_peaks", "ensure_full_proxy", "ensure_conform", "get_filmstrip_tile", "generate_quick_proxy"] {
```

- [ ] **Step 4: Build + run the Rust mirror test**

Run: `cd apps/desktop/native && cargo test --features jobs generate_quick_proxy` (and the dispatch mirror test).
Expected: PASS / compiles. Then `cd apps/desktop && npm run napi:build` (app closed).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/jobs/mod.rs apps/desktop/native/src/commands/media.rs apps/desktop/native/src/napi_backend.rs
git commit -m "feat(decode): generate_quick_proxy on-demand backend command"
```

---

### Task 6: Main-side forwarding + renderer IPC wrapper

Route `{ mediaId } → { item }` through the single-media-forward seam and expose `generateQuickProxy` to the renderer, exactly as `ensure_full_proxy` is wired.

**Files:**
- Modify: `apps/desktop/src/main/state/router.ts:42-45` (`SLICE_INJECTED_READS`)
- Modify: `apps/desktop/src/main/state/single-media-forward.ts:5-8` (`SINGLE_MEDIA_CHANNELS`)
- Modify: `apps/desktop/src/main/state/router.test.ts:38,122` (add channel to both lists)
- Modify: `apps/desktop/src/renderer/ipc/index.ts:1148-1150` (add `generateQuickProxy`)

**Interfaces:**
- Produces: `generateQuickProxy(mediaId: string): Promise<void>` (renderer).

- [ ] **Step 1: Write the failing router test**

In `apps/desktop/src/main/state/router.test.ts`, add `'generate_quick_proxy'` to the `SLICE_INJECTED_READS` mirror list (line 38 area) and to the `'rust'`-routing assertion loop (line 122):
```ts
    for (const ch of ['agent_session_get','log_list','ensure_full_proxy','generate_quick_proxy','export_video_sink_start','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts`
Expected: FAIL — `generate_quick_proxy` not in the forwarding sets.

- [ ] **Step 3: Register the channel**

In `apps/desktop/src/main/state/router.ts` (line 43), add to `SLICE_INJECTED_READS`:
```ts
  'export_project_audio_only', 'ensure_export_audio_conform', 'ensure_conform', 'ensure_full_proxy', 'generate_quick_proxy',
```
In `apps/desktop/src/main/state/single-media-forward.ts` (line 7), add to `SINGLE_MEDIA_CHANNELS`:
```ts
  'get_waveform_levels', 'get_waveform_tile', 'get_filmstrip_tile', 'ensure_full_proxy', 'ensure_conform', 'generate_quick_proxy',
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the renderer IPC wrapper**

In `apps/desktop/src/renderer/ipc/index.ts`, beside `ensureFullProxy` (line 1148):
```ts
/// Ask the backend to build the 720p quick preview proxy for a media on
/// demand (per-clip "Use proxy" / Unsupported-card recovery). Idempotent;
/// no-op on Bypass or when the quick proxy already exists.
export async function generateQuickProxy(mediaId: string): Promise<void> {
  await invoke("generate_quick_proxy", { mediaId });
}
```

- [ ] **Step 6: Verify + commit**

Run: `cd apps/desktop && npx tsc -b --noEmit` — Expected: no errors.
```bash
git add apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/single-media-forward.ts apps/desktop/src/main/state/router.test.ts apps/desktop/src/renderer/ipc/index.ts
git commit -m "feat(decode): forward generate_quick_proxy + renderer IPC wrapper"
```

---

### Task 7: Unsupported-card "Generate proxy" action

Wire the card's second action. The card must receive the unsupported media id.

**Files:**
- Modify: `apps/desktop/src/renderer/render/UnsupportedClipCard.tsx`
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx` (pass the unsupported `mediaId` prop to the card — grep the `<UnsupportedClipCard` render site and the state that tracks the unsupported media)
- Modify: i18n (Task 10 adds the key `settings.decode_unsupported_generate_proxy`)
- Test: `apps/desktop/src/renderer/render/UnsupportedClipCard.test.tsx`

**Interfaces:**
- Consumes: `generateQuickProxy` (Task 6), `setProxyOverride` (Task 2).
- Produces: `UnsupportedClipCard({ mediaId }: { mediaId: string })`.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/renderer/render/UnsupportedClipCard.test.tsx`, add a test that the Generate-proxy button calls `generateQuickProxy` + `setProxyOverride(id, true)`. Follow the existing test's mocking style (mock `../ipc` and `../state/proxyPreferenceStore`); assert the button with `data-testid` / role fires both. (Copy the existing "Switch to Standard" test's structure verbatim, swapping the assertions.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/desktop && npx vitest run src/renderer/render/UnsupportedClipCard.test.tsx`
Expected: FAIL — no Generate-proxy button / prop.

- [ ] **Step 3: Implement**

Rewrite `apps/desktop/src/renderer/render/UnsupportedClipCard.tsx` to take `mediaId` and add the action below "Switch to Standard":
```tsx
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { setAppSettings } from "../settings/appSettingsStore";
import { useDecodeComponentStore } from "../settings/decodeComponentStore";
import { generateQuickProxy } from "../ipc";
import { setProxyOverride } from "../state/proxyPreferenceStore";

export function UnsupportedClipCard({ mediaId }: { mediaId: string }) {
  const { t } = useTranslation();
  const componentAvailable = useDecodeComponentStore((s) => s.available);
  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black/70 text-center text-sm text-white"
      data-testid="unsupported-clip-card"
    >
      <div className="max-w-sm space-y-3 p-4">
        <div className="font-medium">{t("settings.decode_unsupported_title")}</div>
        <div className="text-white/70">
          {t(componentAvailable ? "settings.decode_unsupported_body" : "settings.decode_unsupported_body_no_component")}
        </div>
        <div className="flex justify-center gap-2">
          {componentAvailable && (
            <Button variant="secondary" onClick={() => { void setAppSettings({ decode_engine: "ffmpeg" }); }}>
              {t("settings.decode_unsupported_switch")}
            </Button>
          )}
          <Button
            variant="secondary"
            data-testid="unsupported-generate-proxy"
            onClick={() => { void generateQuickProxy(mediaId); void setProxyOverride(mediaId, true); }}
          >
            {t("settings.decode_unsupported_generate_proxy")}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Pass the prop from PixiPreview**

Grep `UnsupportedClipCard` in `PixiPreview.tsx`. The Compositor's `onUnsupported(mediaId)` already tracks the unsupported media; pass the representative id: `<UnsupportedClipCard mediaId={unsupportedMediaId} />`. (If multiple clips are unsupported the card targets the tracked one — a known MVP simplification, same as today's single generic overlay.)

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `cd apps/desktop && npx vitest run src/renderer/render/UnsupportedClipCard.test.tsx && npx tsc -b --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/render/UnsupportedClipCard.tsx apps/desktop/src/renderer/render/UnsupportedClipCard.test.tsx apps/desktop/src/renderer/render/PixiPreview.tsx
git commit -m "feat(decode): Unsupported card Generate-proxy action"
```

---

### Task 8: Media-pool per-clip proxy control

A small tri-state pill on each media item (Auto → Proxy → Original → Auto), hidden for `Bypass`. Force-proxy on a source without a built proxy also kicks a build.

**Files:**
- Modify: `apps/desktop/src/renderer/panels/MediaPool.tsx` (add a `<ProxyPill media={m} />` in the `media-item-details` overlay ~line 220-243, and the component)
- Modify: i18n (Task 10 adds `media_pool.proxy_pill_*`)
- Modify: `apps/desktop/src/renderer/index.css` (or the media-pool stylesheet) — a `.media-proxy-pill` style; follow the sibling badge styles

**Interfaces:**
- Consumes: `useProxyPrefStore`, `setProxyOverride` (Task 2), `quickProxyPath` (Task 3), `generateQuickProxy` (Task 6).

- [ ] **Step 1: Implement the pill component**

In `apps/desktop/src/renderer/panels/MediaPool.tsx`, add imports and the component (near the bottom, beside `formatBytes`):
```tsx
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { quickProxyPath } from "../render/decodeRoute";
import { generateQuickProxy } from "../ipc";
```
```tsx
/// Per-clip proxy override: cycles Auto → Force proxy → Force original → Auto.
/// Hidden for Bypass (no quick_proxy slot). Choosing Force-proxy on a source
/// with no built proxy kicks an on-demand build.
function ProxyPill({ media }: { media: MediaSummary }) {
  const { t } = useTranslation();
  const override = useProxyPrefStore((s) => s.overrides[media.id]); // boolean | undefined
  if (media.decode_route.route === "bypass") return null;
  const state: "auto" | "proxy" | "original" =
    override === undefined ? "auto" : override ? "proxy" : "original";
  const next: boolean | null = state === "auto" ? true : state === "proxy" ? false : null;
  return (
    <button
      type="button"
      className={`media-proxy-pill is-${state}`}
      title={t(`media_pool.proxy_pill_${state}_hint`)}
      onClick={(e) => {
        e.stopPropagation();
        if (next === true && quickProxyPath(media) === null) void generateQuickProxy(media.id);
        void setProxyOverride(media.id, next);
      }}
    >
      {t(`media_pool.proxy_pill_${state}`)}
    </button>
  );
}
```
Render it inside the details overlay (after the size line, ~line 242):
```tsx
                  <ProxyPill media={m} />
```

- [ ] **Step 2: Add a minimal style**

In the media-pool stylesheet, add a `.media-proxy-pill` rule (small pill, distinct `.is-proxy` / `.is-original` tint) matching the existing `.media-*-badge` conventions.

- [ ] **Step 3: Verify typecheck + build the app**

Run: `cd apps/desktop && npx tsc -b --noEmit`
Expected: no errors. (Behavior is verified end-to-end in Task 11; a DOM unit test for the pill is optional — if added, follow the `UnsupportedClipCard.test.tsx` render-and-click pattern.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/panels/MediaPool.tsx apps/desktop/src/renderer/index.css
git commit -m "feat(decode): per-clip proxy override pill in the media pool"
```

---

### Task 9: Global "Prefer Proxies" toggle in Settings

Clone the existing per-project `auto_delete_empty_tracks` toggle for `prefer_proxies`.

**Files:**
- Modify: `apps/desktop/src/renderer/settings/SettingsPanel.tsx:394-436` (add a sibling toggle)
- Modify: i18n (Task 10 adds `settings.prefer_proxies` + `_hint`)

**Interfaces:**
- Consumes: `useProxyPrefStore`, `setPreferProxies` (Task 2).

- [ ] **Step 1: Implement the toggle**

In `apps/desktop/src/renderer/settings/SettingsPanel.tsx`, add a toggle beside the `auto_delete_empty_tracks` one (line 394-436). Prefer reading live from the store rather than fetch-on-mount:
```tsx
import { useProxyPrefStore, setPreferProxies } from "../state/proxyPreferenceStore";
```
```tsx
function PreferProxiesToggle({ onError }: { onError: (m: string) => void }) {
  const { t } = useTranslation();
  const enabled = useProxyPrefStore((s) => s.preferProxies);
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={enabled}
        onChange={async (e) => {
          onError("");
          try { await setPreferProxies(e.target.checked); }
          catch (err) { onError(String(err)); }
        }}
      />
      <span>
        <span className="settings-toggle-label">
          {t("settings.prefer_proxies")}
          <ProjectBadge />
        </span>
        <span className="settings-toggle-hint">{t("settings.prefer_proxies_hint")}</span>
      </span>
    </label>
  );
}
```
Render `<PreferProxiesToggle onError={onError} />` beside the existing per-project toggle. Match the surrounding markup exactly (the real class names / `ProjectBadge` usage are at lines 428-436 — copy them).

- [ ] **Step 2: Verify typecheck**

Run: `cd apps/desktop && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/settings/SettingsPanel.tsx
git commit -m "feat(decode): Prefer Proxies project toggle in Settings"
```

---

### Task 10: i18n keys (en-US + zh-CN)

**Files:**
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add keys to en-US**

In `apps/desktop/src/renderer/i18n/locales/en-US.ts`, under the `settings` block (beside line 489) and the `media_pool` block:
```ts
    prefer_proxies: "Prefer proxies for preview",
    prefer_proxies_hint:
      "Play the lightweight 720p proxy in the preview for clips that have one, for smoother scrubbing. Export still uses the original. Saved with the project.",
    decode_unsupported_generate_proxy: "Generate proxy",
```
```ts
    proxy_pill_auto: "Proxy: Auto",
    proxy_pill_auto_hint: "Follow the project's Prefer-proxies setting.",
    proxy_pill_proxy: "Proxy: On",
    proxy_pill_proxy_hint: "Always preview this clip from its 720p proxy.",
    proxy_pill_original: "Proxy: Off",
    proxy_pill_original_hint: "Always preview this clip from the original.",
```

- [ ] **Step 2: Add the same keys to zh-CN**

In `apps/desktop/src/renderer/i18n/locales/zh-CN.ts`, mirror them:
```ts
    prefer_proxies: "预览优先使用代理",
    prefer_proxies_hint:
      "对已生成代理的片段，在预览中播放轻量的 720p 代理以获得更流畅的拖拽体验；导出仍使用原始文件。此选项随工程保存。",
    decode_unsupported_generate_proxy: "生成代理",
```
```ts
    proxy_pill_auto: "代理：自动",
    proxy_pill_auto_hint: "跟随工程的“优先使用代理”设置。",
    proxy_pill_proxy: "代理：开",
    proxy_pill_proxy_hint: "该片段始终使用 720p 代理预览。",
    proxy_pill_original: "代理：关",
    proxy_pill_original_hint: "该片段始终使用原始文件预览。",
```

- [ ] **Step 3: Verify + commit**

Run: `cd apps/desktop && npx tsc -b --noEmit` (locale files are typed) — Expected: no errors.
```bash
git add apps/desktop/src/renderer/i18n/locales/en-US.ts apps/desktop/src/renderer/i18n/locales/zh-CN.ts
git commit -m "i18n(decode): proxy activation strings (en-US + zh-CN)"
```

---

### Task 11: End-to-end swap test

A local-only Playwright spec proving the global toggle swaps a heavy source's preview onto its quick proxy. Gated exactly like the existing decode-engine spec.

**Files:**
- Modify: `apps/desktop/e2e/electron/decode-engine.spec.ts` (add one test in the gated describe)

**Interfaces:**
- Consumes: `launchApp`, `newProject`, `importAndPlaceMedia`, `invokeCmd`, `waitForPreviewBridge`, `seek`, `waitForBuiltKey` (existing helpers in the spec / `helpers/driver.ts`).

- [ ] **Step 1: Write the test**

In the gated describe of `apps/desktop/e2e/electron/decode-engine.spec.ts` (the block guarded by `test.skip(process.env.WEFTCUT_DECODE_E2E !== '1', …)`), add:

```ts
  test('Prefer Proxies: a source with a quick proxy previews from webcodecs:proxy', async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp()
    try {
      await newProject(page, { parentFolder: PROJECT_PARENT, name: 'proxy-toggle-' + Date.now(), canvas: CANVAS })
      const { layerId, mediaId } = await importAndPlaceMedia(page, { mediaAbsPath: H264_FIXTURE })

      // Build the quick proxy on demand, then wait until it lands in the route.
      await invokeCmd(page, 'generate_quick_proxy', { mediaId })
      await page.waitForFunction(
        (id) => {
          const m = (window as any).__weftcutTest?.mediaById?.(id)
          const r = m?.decode_route
          return !!r && r.route !== 'bypass' && !!r.quick_proxy
        },
        mediaId,
        { timeout: 120_000 },
      )

      // Flip the project toggle and assert the preview swaps to the proxy.
      await invokeCmd(page, 'update_project_settings', { patch: { prefer_proxies: true } })
      await waitForPreviewBridge(page)
      await seek(page, SEEK_US)
      const probe = await waitForBuiltKey(page, layerId, 'webcodecs', 'webcodecs:proxy:')
      expect(probe.builtFromKey!.startsWith('webcodecs:proxy:')).toBe(true)
    } finally {
      await app.close()
    }
  })
```
Notes: `H264_FIXTURE` here must be a source that routes to `DirectExport`/`Proxied` (heavy enough not to `Bypass`) so it has a `quick_proxy` slot — reuse or add a fixture accordingly. If `__weftcutTest.mediaById` / `importAndPlaceMedia`'s `mediaId` return aren't exposed, add the minimal hook in `src/renderer/testhook/e2eHook.ts` (behind the existing `VITE_WEFTCUT_E2E` gate) following its sibling hooks.

- [ ] **Step 2: Build the e2e bundle + run (local only)**

Run (from `apps/desktop`):
```bash
npm run napi:build && npm run fetch-ffmpeg && ( cd e2e && npm run fixtures ) && VITE_WEFTCUT_E2E=1 npm run build
WEFTCUT_DECODE_E2E=1 npm run e2e:electron -- decode-engine.spec.ts -g "Prefer Proxies"
```
Expected: the new test PASSES; `builtFromKey` starts with `webcodecs:proxy:`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/electron/decode-engine.spec.ts apps/desktop/src/renderer/testhook/e2eHook.ts
git commit -m "test(decode): e2e Prefer-Proxies swaps preview to webcodecs:proxy"
```

---

### Task 12: Docs — flip preview.md from "inert" to "live"

Update the evergreen decode doc so it no longer describes the axis as unactivated.

**Files:**
- Modify: `apps/desktop/../docs/preview.md` §"Decode engine" (lines 22-24 of `decodeEngine.ts` doc are stale too) and §Proxies (lines 274-289)

- [ ] **Step 1: Update the prose**

In `docs/preview.md` §Proxies, replace the "nothing activates the axis yet / PixiPreview always resolves original" language with the shipped behavior: a project-scoped **Prefer Proxies** toggle + per-clip override, `proxy ⇒ webcodecs`, on-demand `generate_quick_proxy`, `Bypass` excluded. Update the `decodeEngine.ts:22-24` `useProxySource` doc comment (no longer "PixiPreview passes false"). Keep it evergreen — no dates/phases/hashes (`feedback_evergreen_docs`).

- [ ] **Step 2: Commit**

```bash
git add docs/preview.md apps/desktop/src/renderer/render/decoder/decodeEngine.ts
git commit -m "docs(decode): preview.md — proxy source axis is now live"
```

---

## Self-Review

**Spec coverage:**
- §1 core rule (`intent && quickProxyReady`) → Tasks 2, 4. ✓
- §2 state (`prefer_proxies` + `proxy_overrides`, undo-immune) → Task 1. ✓
- §3 resolver feed + landmine (`proxy ⇒ webcodecs`) + `quickProxyPath` → Tasks 3, 4. ✓
- §4 `generate_quick_proxy` (reuse quick_proxy job; Bypass out; idempotent) → Tasks 5, 6. ✓
- §5 UI (global toggle, per-clip override, Unsupported card) → Tasks 7, 8, 9. Indicator badge correctly omitted (spec marks it out-of-MVP). Toolbar placement flagged as fast-follow in Global Constraints. ✓
- §5 i18n → Task 10. ✓
- §6 edge cases: cache-cleaned/pending fallback is structural (`&& quickProxyReady` in Task 4) — no code beyond the gate; build-failure surfacing rides existing LogBus job events (no new work). ✓
- §7 testing → resolver unit (Task 3), persistence unit (Task 1), e2e (Task 11). Store unit (Task 2) is a bonus. ✓
- §8 guardrails honored (no import/export/derivative changes). ✓ Plus Task 12 keeps the evergreen doc honest.

**Placeholder scan:** No "TBD"/"handle edge cases"-style gaps. Two spots reference "grep for X" (the `get_project_settings` handler, the `UnsupportedClipCard` render site, the media-pool stylesheet) — these are locate-the-sibling instructions with the exact code to write once located, not deferred decisions.

**Type consistency:** `prefer_proxies: boolean` and `proxy_overrides: Record<string, boolean>` consistent across model/patch/view/store. Patch override shape `{ media_id: string; value: boolean | null }` consistent in actor.ts (Task 1), IPC (Task 1), and `setProxyOverride` (Task 2). `quickProxyPath` signature consistent between Task 3 (definition) and Tasks 4/8 (consumers). Command name `"generate_quick_proxy"` consistent across Rust dispatch (Task 5), forwarding sets + router test + IPC wrapper (Task 6), and e2e (Task 11). Resolver output `webcodecs:proxy:<url>` key consistent between Task 3 test and Task 11 assertion.
