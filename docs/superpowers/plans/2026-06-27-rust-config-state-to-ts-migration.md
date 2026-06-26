# Rust Config-State → TS Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the remaining *preference/config* state that the Rust addon only persists (it never reads it in any compute path) into the Electron **main** process, so the `@weftcut/core` Rust addon becomes truly compute-only and the cross-language struct twins disappear. First store: `app_settings`.

**Architecture:** Each config store today is a dumb JSON file that Rust reads/writes on behalf of TS. The renderer calls a channel (`invoke('app_settings_set', {patch})`); `main/index.ts` forwards every channel through `routeChannel()` — `'rust'` routes hit the napi `Backend.invoke` dispatcher, everything else hits `tsHost.handleInvoke`. We move a store by: (1) adding a TS store that reads/writes the same on-disk file, (2) re-classifying its channels off the `'rust'` route, (3) handling them in the TS host, (4) deleting the Rust store. The on-disk file path + JSON field names stay byte-identical, so existing users' files carry over and **the renderer is untouched** (same channel + event names).

**Tech Stack:** TypeScript (Electron main, vitest), Rust (napi-rs, cargo test).

## Global Constraints

- On-disk file location and JSON field names MUST stay identical across the move (existing users' files must keep working). `app_settings.json` lives at `<userData>/app_settings.json`; `app.getPath('userData')` is the same dir Rust received as `app_config_dir` (`main/index.ts:157` passes it to `new Backend(...)`).
- Channel names (`app_settings_get`, `app_settings_set`) and the event name (`app_settings:changed`) MUST NOT change — the renderer (`renderer/settings/appSettingsStore.ts`, `renderer/ipc/index.ts`) keys off them and must require zero edits to its call sites.
- The router partition gate (`src/main/state/router.test.ts`) MUST stay green: every renderer channel classified into exactly one bucket; no project-touching channel routes to `'rust'`.
- Windows: edit Rust source with the Edit tool, never PowerShell `Set-Content` (it writes cp1252 and mangles em-dashes — see `feedback_powershell_setcontent_cp1252`).
- After any Rust change, **rebuild the addon before any Electron e2e** — a stale bundle mimics a code bug (`project_effects_subsystem` gotcha).
- Keep migration scope fixed per store; park unrelated issues, don't shrink scope to dodge a bug (`feedback_migration_discipline`).

---

## Migration Roadmap (ordered by ease × payoff)

All five stores are independent subsystems; each lands as its own working, committed change. They share one mechanical pattern (below). Ordering introduces exactly one new wrinkle per store:

| # | Store | On-disk file | Scope | New wrinkle vs. previous | Status |
|---|-------|--------------|-------|--------------------------|--------|
| 1 | **app_settings** | `<userData>/app_settings.json` | config-dir | baseline: clamping + `:changed` event + kills a Rust↔TS struct twin | ✅ DONE (local main) |
| 2 | **view_state** | `<workspace>/view.json` | workspace | workspace-scoped (use `deps.workspaceDir()`); pre-workspace = silent drop; no event | ✅ DONE (local main) |
| 3 | **export_settings** | `<workspace>/export.json` | workspace | opaque `unknown` JSON value (no typed struct) | scope block below — NEXT |
| 4 | **keybindings** | `<userData>/keybindings.json` | config-dir | multi-channel (get/set/reset_all/export/import); file-dialog import/export paths | scope block below |
| 5 | **recents** | `<userData>/recents.json` | config-dir | **dual writer**: the workspace orchestrator also writes it via `napiFacade.pushRecent`/`setLastNewProjectParent` — those must move to the TS store too | scope block below |

**Explicitly NOT in scope (these earn their place in Rust — a Rust compute path reads them synchronously):** `WorkspaceSlot` (read by jobs/cache/export/mcp), `AudioMeterState` (read by MCP tools), cloud keys, `ReadMirror`, and every true actor / heavy-I/O holder (`LogBus`, `ImportQueue`, `VideoSinkState`, `HwEncoderCache`, `CacheLayout`).

### The shared pattern (every store follows this)

1. **TS store module** (`src/main/<store>.ts`): pure logic + an injected `Fs` interface (so tests run in-memory). Ports the Rust read/write incl. atomic temp+rename and defaulting. Types live in `src/shared/<store>.ts` so main and renderer share one definition (no TS↔TS twin).
2. **Router** (`src/main/state/router.ts`): add a route kind, remove the channels from the `'rust'` buckets (`PERSISTENCE`), classify them to the new kind. Update `router.test.ts`.
3. **Host** (`src/main/state/ts-actor-host.ts`): inject the store via deps; add a `handleInvoke` case; emit any `:changed` event via `deps.send`.
4. **Wire** (`src/main/index.ts`): build the concrete node-fs-backed store, inject into `createTsActorHost`. After this the app runs fully on TS and the Rust arm is dead code.
5. **Delete Rust**: the store file, `mod` decl, `Backend` field/init/`use`, the napi dispatch arm(s), the `commands/prefs.rs` fn(s) + Args struct(s), and any Rust unit test for it. `cargo build` + `cargo test` green.

> **Why this order:** app_settings exercises the *whole* pattern (typed struct + clamping + event + a real Rust↔TS twin to delete), so it's the canonical reference. view_state/export_settings are the workspace-scoped variant. keybindings adds breadth. recents is last because it has a second writer that must move with it.

---

# Sub-Plan 1: `app_settings` (full task breakdown)

**Files touched:**
- Create: `apps/desktop/src/shared/app-settings.ts` (shared types + defaults + clamp constants)
- Create: `apps/desktop/src/main/app-settings.ts` (fs-backed store)
- Create: `apps/desktop/src/main/app-settings.test.ts` (unit tests, in-memory fs)
- Modify: `apps/desktop/src/renderer/ipc/index.ts:657-700` (re-export shared types instead of local defs)
- Modify: `apps/desktop/src/main/state/router.ts` (new `appSettings` route)
- Modify: `apps/desktop/src/main/state/router.test.ts` (route assertions)
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (deps + handleInvoke case + emit)
- Modify: `apps/desktop/src/main/state/ts-actor-host.test.ts` (host event test) — create if absent
- Modify: `apps/desktop/src/main/index.ts:235-304` (build + inject store)
- Delete: `apps/desktop/native/src/app_settings.rs`
- Modify (delete refs): `apps/desktop/native/src/lib.rs:10`, `napi_backend.rs:19,42,105,481-485,664-675`, `commands/prefs.rs:23-39,230-236`
- Modify: `docs/architecture.md:185` (app_settings.rs → TS pointer)

---

## Task A1: Shared types + main store module (TDD)

**Files:**
- Create: `apps/desktop/src/shared/app-settings.ts`
- Create: `apps/desktop/src/main/app-settings.ts`
- Test: `apps/desktop/src/main/app-settings.test.ts`
- Modify: `apps/desktop/src/renderer/ipc/index.ts`

**Interfaces:**
- Produces (shared): `type DisplayMode`, `interface AppSettings`, `interface AppSettingsPatch`, `const APP_SETTINGS_DEFAULTS: AppSettings`.
- Produces (main): `interface AppSettingsFs`, `interface AppSettingsStore { get(): AppSettings; apply(patch: AppSettingsPatch): AppSettings }`, `function createAppSettingsStore(deps: { fs: AppSettingsFs; path: string; dir: string }): AppSettingsStore`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/app-settings.test.ts` (ports the Rust tests in `native/src/app_settings.rs`):

```ts
import { describe, it, expect } from 'vitest'
import { createAppSettingsStore, type AppSettingsFs } from './app-settings'
import { APP_SETTINGS_DEFAULTS } from '../shared/app-settings'

const PATH = '/cfg/app_settings.json'
const DIR = '/cfg'

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: AppSettingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}
const store = (seed?: Record<string, string>) => createAppSettingsStore({ ...memFs(seed), path: PATH, dir: DIR })

describe('app-settings store', () => {
  it('defaults when no file', () => {
    expect(store().get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('apply persists then reads back (independent reader)', () => {
    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const after = s.apply({ display_mode: 'ShowAll', delta_window_us: 5_000_000, media_pool_drawer_open: true, tail_snap_enabled: false, tail_snap_strength_px: 24 })
    expect(after.display_mode).toBe('ShowAll')
    expect(after.delta_window_us).toBe(5_000_000)
    expect(after.tail_snap_strength_px).toBe(24)
    const reader = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(reader.get()).toEqual(after)
    expect(files.has(PATH + '.tmp')).toBe(false) // tmp promoted, not left behind
  })

  it('missing fields inherit defaults', () => {
    const s = store({ [PATH]: '{ "display_mode": "ShowAll" }' })
    const got = s.get()
    expect(got.display_mode).toBe('ShowAll')
    expect(got.delta_window_us).toBe(10_000_000)
    expect(got.tail_snap_enabled).toBe(true)
    expect(got.tail_snap_strength_px).toBe(12)
  })

  it('corrupt file falls back to defaults (no throw)', () => {
    const s = store({ [PATH]: '{ not valid json at all' })
    expect(s.get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('delta_window clamps to [1s, 5min]', () => {
    expect(store().apply({ delta_window_us: 0 }).delta_window_us).toBe(1_000_000)
    expect(store().apply({ delta_window_us: 10 * 60 * 1_000_000 }).delta_window_us).toBe(300_000_000)
  })

  it('tail_snap_strength clamps to [2, 80]', () => {
    expect(store().apply({ tail_snap_strength_px: 0 }).tail_snap_strength_px).toBe(2)
    expect(store().apply({ tail_snap_strength_px: 200 }).tail_snap_strength_px).toBe(80)
  })

  it('prebake_motifs / preview_effects_enabled round-trip', () => {
    expect(store().get().prebake_motifs).toBe(false)
    expect(store().apply({ prebake_motifs: true }).prebake_motifs).toBe(true)
    expect(store().get().preview_effects_enabled).toBe(true)
    expect(store().apply({ preview_effects_enabled: false }).preview_effects_enabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/app-settings.test.ts`
Expected: FAIL — cannot resolve `./app-settings` / `../shared/app-settings`.

- [ ] **Step 3: Write the shared types module**

Create `apps/desktop/src/shared/app-settings.ts`:

```ts
// App-level preference types, shared by the Electron main process (owner of
// persistence) and the renderer (consumer via ipc). One definition → no
// main↔renderer drift. Mirrors the on-disk JSON shape exactly; field names are
// snake_case to match the file written historically by the Rust addon.

export type DisplayMode = 'AbRoll' | 'ShowAll'

export interface AppSettings {
  display_mode: DisplayMode
  /** Half-width (µs) of the right-panel peek window around the playhead. */
  delta_window_us: number
  media_pool_drawer_open: boolean
  tail_snap_enabled: boolean
  tail_snap_strength_px: number
  prebake_motifs: boolean
  preview_effects_enabled: boolean
}

/** Partial patch over IPC — the UI sends one-field flips, not the whole struct. */
export interface AppSettingsPatch {
  display_mode?: DisplayMode
  delta_window_us?: number
  media_pool_drawer_open?: boolean
  tail_snap_enabled?: boolean
  tail_snap_strength_px?: number
  prebake_motifs?: boolean
  preview_effects_enabled?: boolean
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  display_mode: 'AbRoll',
  delta_window_us: 10_000_000,
  media_pool_drawer_open: false,
  tail_snap_enabled: true,
  tail_snap_strength_px: 12,
  prebake_motifs: false,
  preview_effects_enabled: true,
}

export const DELTA_WINDOW_MIN_US = 1_000_000
export const DELTA_WINDOW_MAX_US = 300_000_000
export const TAIL_SNAP_STRENGTH_MIN_PX = 2
export const TAIL_SNAP_STRENGTH_MAX_PX = 80
```

- [ ] **Step 4: Write the main store module**

Create `apps/desktop/src/main/app-settings.ts`:

```ts
// App-level preferences persisted at <userData>/app_settings.json, owned by the
// Electron main process. One value across every project (no per-project override).
//
// History: persistence used to live in the Rust addon (native/src/app_settings.rs);
// it moved here so the addon is compute-only and the Rust↔TS struct twin is gone.
// The on-disk file path + JSON field names are unchanged, so existing users'
// settings carry over untouched.
//
// Bad-config recovery: a missing / empty / corrupt file degrades to all-defaults
// so a hand-edit mishap can't brick the editor (parity with the old Rust store).

import {
  APP_SETTINGS_DEFAULTS,
  DELTA_WINDOW_MIN_US, DELTA_WINDOW_MAX_US,
  TAIL_SNAP_STRENGTH_MIN_PX, TAIL_SNAP_STRENGTH_MAX_PX,
  type AppSettings, type AppSettingsPatch,
} from '../shared/app-settings'

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface AppSettingsFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface AppSettingsStore {
  get(): AppSettings
  /** Apply a patch atomically; returns the post-patch settings. */
  apply(patch: AppSettingsPatch): AppSettings
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export function createAppSettingsStore(deps: { fs: AppSettingsFs; path: string; dir: string }): AppSettingsStore {
  function read(): AppSettings {
    if (!deps.fs.exists(deps.path)) return { ...APP_SETTINGS_DEFAULTS }
    let body: string
    try { body = deps.fs.readFile(deps.path) }
    catch (e) { console.warn(`[app-settings] read ${deps.path}:`, e); return { ...APP_SETTINGS_DEFAULTS } }
    if (body.trim() === '') return { ...APP_SETTINGS_DEFAULTS }
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(body) as Record<string, unknown> }
    catch (e) { console.warn(`[app-settings] parse ${deps.path}:`, e); return { ...APP_SETTINGS_DEFAULTS } }
    // Per-field defaulting (parity with serde #[serde(default = ...)]): a missing
    // or wrong-typed field falls back to its default; unknown keys are ignored.
    const d = APP_SETTINGS_DEFAULTS
    return {
      display_mode: parsed.display_mode === 'ShowAll' || parsed.display_mode === 'AbRoll' ? parsed.display_mode : d.display_mode,
      delta_window_us: typeof parsed.delta_window_us === 'number' ? parsed.delta_window_us : d.delta_window_us,
      media_pool_drawer_open: typeof parsed.media_pool_drawer_open === 'boolean' ? parsed.media_pool_drawer_open : d.media_pool_drawer_open,
      tail_snap_enabled: typeof parsed.tail_snap_enabled === 'boolean' ? parsed.tail_snap_enabled : d.tail_snap_enabled,
      tail_snap_strength_px: typeof parsed.tail_snap_strength_px === 'number' ? parsed.tail_snap_strength_px : d.tail_snap_strength_px,
      prebake_motifs: typeof parsed.prebake_motifs === 'boolean' ? parsed.prebake_motifs : d.prebake_motifs,
      preview_effects_enabled: typeof parsed.preview_effects_enabled === 'boolean' ? parsed.preview_effects_enabled : d.preview_effects_enabled,
    }
  }

  function write(settings: AppSettings): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(settings, null, 2))
    deps.fs.rename(tmp, deps.path) // atomic promote
  }

  return {
    get: read,
    apply(patch) {
      const current = read()
      if (patch.display_mode !== undefined) current.display_mode = patch.display_mode
      if (patch.delta_window_us !== undefined) current.delta_window_us = clamp(patch.delta_window_us, DELTA_WINDOW_MIN_US, DELTA_WINDOW_MAX_US)
      if (patch.media_pool_drawer_open !== undefined) current.media_pool_drawer_open = patch.media_pool_drawer_open
      if (patch.tail_snap_enabled !== undefined) current.tail_snap_enabled = patch.tail_snap_enabled
      if (patch.tail_snap_strength_px !== undefined) current.tail_snap_strength_px = clamp(patch.tail_snap_strength_px, TAIL_SNAP_STRENGTH_MIN_PX, TAIL_SNAP_STRENGTH_MAX_PX)
      if (patch.prebake_motifs !== undefined) current.prebake_motifs = patch.prebake_motifs
      if (patch.preview_effects_enabled !== undefined) current.preview_effects_enabled = patch.preview_effects_enabled
      write(current)
      return current
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/app-settings.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Point the renderer types at the shared module**

In `apps/desktop/src/renderer/ipc/index.ts`, replace the local `DisplayMode` / `AppSettings` / `AppSettingsPatch` definitions (lines ~657-690) with a re-export from shared. Keep the field doc-comments by moving them into the shared file if desired; the wrappers `appSettingsGet`/`appSettingsSet` and `APP_SETTINGS_EVENTS` stay exactly as-is.

Replace:
```ts
export type DisplayMode = "AbRoll" | "ShowAll";

export interface AppSettings { /* ...fields... */ }
export interface AppSettingsPatch { /* ...fields... */ }
```
with:
```ts
export type { DisplayMode, AppSettings, AppSettingsPatch } from "@/shared/app-settings";
```
(Confirm the `@/` alias resolves to `src/` — it does for `@/bridge/events`. If a different alias/relative path is used elsewhere in this file, match it.)

- [ ] **Step 7: Typecheck the renderer + main**

Run: `cd apps/desktop && npx tsc --noEmit` (or the project's typecheck script, e.g. `npm run typecheck`)
Expected: PASS — no unresolved `AppSettings` references; `renderer/settings/appSettingsStore.ts` still imports the types from `../ipc` unchanged.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/shared/app-settings.ts apps/desktop/src/main/app-settings.ts apps/desktop/src/main/app-settings.test.ts apps/desktop/src/renderer/ipc/index.ts
git commit -m "feat(app-settings): TS app-settings store + shared types"
```

---

## Task A2: Router route + host handler + event (TDD)

**Files:**
- Modify: `apps/desktop/src/main/state/router.ts`
- Modify: `apps/desktop/src/main/state/router.test.ts`
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts`
- Test: `apps/desktop/src/main/state/ts-actor-host.test.ts`

**Interfaces:**
- Consumes: `AppSettingsStore` (Task A1), `createAppSettingsStore`.
- Produces: `Route` union gains `{ kind: 'appSettings' }`; `TsActorHostDeps` gains optional `appSettings?: AppSettingsStore`.

- [ ] **Step 1: Write the failing router test**

In `apps/desktop/src/main/state/router.test.ts`, the `'forwards independent stores ... to rust'` test (lines ~118-123) currently asserts `app_settings_get`/`app_settings_set` route to `'rust'`. Remove those two from that list and add a new assertion:

```ts
  it('routes app_settings_get/set to the appSettings TS handler (migrated off rust)', () => {
    expect(routeChannel('app_settings_get').kind).toBe('appSettings')
    expect(routeChannel('app_settings_set').kind).toBe('appSettings')
  })
```
And edit the existing list so it no longer contains the two app_settings channels:
```ts
    for (const ch of ['view_state_get','export_settings_get','recents_list','keybindings_get','agent_session_get','log_list','ensure_full_proxy','export_video_sink_start','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
```
(Leave `ALL_CHANNELS` and the partition gate unchanged — `app_settings_*` stay listed there; they now classify to `'appSettings'`, which is neither `'reject'` nor `'rust'`, so the gate passes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts`
Expected: FAIL — `app_settings_get` still routes to `'rust'`.

- [ ] **Step 3: Update the router**

In `apps/desktop/src/main/state/router.ts`:

1. Add to the `Route` union:
```ts
  | { kind: 'appSettings' }   // app-level prefs store, owned in TS main (config-dir)
```
2. Remove `'app_settings_get', 'app_settings_set'` from the `PERSISTENCE` set (leave the rest).
3. In `routeChannel`, add cases in the `switch (channel)` block:
```ts
    case 'app_settings_get':
    case 'app_settings_set': return { kind: 'appSettings' }
```

- [ ] **Step 4: Run router test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts`
Expected: PASS (incl. partition gate + disjointness — `PERSISTENCE` no longer contains the two channels).

- [ ] **Step 5: Write the failing host test**

In `apps/desktop/src/main/state/ts-actor-host.test.ts` (create if it doesn't exist; if it exists, reuse its host/deps factory and add this `describe`). Build the host with a minimal deps object plus an in-memory app-settings store and a `send` spy:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost, type TsActorHostDeps } from './ts-actor-host'
import { createAppSettingsStore, type AppSettingsFs } from '../app-settings'

function memAppSettings() {
  const files = new Map<string, string>()
  const fs: AppSettingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a) },
    mkdirp: () => {},
  }
  return createAppSettingsStore({ fs, path: '/cfg/app_settings.json', dir: '/cfg' })
}

function makeHost(over: Partial<TsActorHostDeps> = {}) {
  const send = vi.fn()
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  const deps: TsActorHostDeps = {
    send, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as never, join: (...p) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: async () => {} } as never,
    compute: {} as never, enqueueWorkspaceCopy: async () => {}, readFile: () => '',
    workspaceDir: () => null, appSettings: memAppSettings(),
    ...over,
  }
  return { host: createTsActorHost(deps), send }
}

describe('ts-actor-host app_settings route', () => {
  it('app_settings_set persists, returns after-state, and emits app_settings:changed', async () => {
    const { host, send } = makeHost()
    const after = await host.handleInvoke('app_settings_set', { patch: { display_mode: 'ShowAll' } }) as { display_mode: string }
    expect(after.display_mode).toBe('ShowAll')
    expect(send).toHaveBeenCalledWith('app_settings:changed', expect.objectContaining({ display_mode: 'ShowAll' }))
  })

  it('app_settings_get returns the persisted value', async () => {
    const { host } = makeHost()
    await host.handleInvoke('app_settings_set', { patch: { tail_snap_strength_px: 20 } })
    const got = await host.handleInvoke('app_settings_get', {}) as { tail_snap_strength_px: number }
    expect(got.tail_snap_strength_px).toBe(20)
  })
})
```
> If `makeHost`'s minimal deps don't satisfy the current `TsActorHostDeps` required fields, copy the exact shape from `main/index.ts:286-304` and stub each with a no-op. Reuse an existing helper if `ts-actor-host.test.ts` already has one.

- [ ] **Step 6: Run host test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/state/ts-actor-host.test.ts`
Expected: FAIL — `'appSettings'` route hits the host but has no case (or `appSettings` not in deps type).

- [ ] **Step 7: Implement the host handler**

In `apps/desktop/src/main/state/ts-actor-host.ts`:

1. Add a type-only import near the top:
```ts
import type { AppSettingsStore } from '../app-settings'
import type { AppSettingsPatch } from '../../shared/app-settings'
```
2. Add to `TsActorHostDeps`:
```ts
  /** App-level prefs store (config-dir JSON, owned in TS main). Optional →
   *  the 'appSettings' route throws if a renderer hits it without one wired. */
  appSettings?: AppSettingsStore
```
3. In `handleInvoke`'s `switch (route.kind)`, add before `case 'reject'`:
```ts
      case 'appSettings': {
        const store = deps.appSettings
        if (!store) return reject('app_settings: store not configured')
        if (channel === 'app_settings_get') return store.get()
        const patch = (args as { patch?: AppSettingsPatch }).patch ?? {}
        const after = store.apply(patch)
        deps.send('app_settings:changed', after)
        return after
      }
```

- [ ] **Step 8: Run host + router tests to verify they pass**

Run: `cd apps/desktop && npx vitest run src/main/state/ts-actor-host.test.ts src/main/state/router.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/state/ts-actor-host.test.ts
git commit -m "feat(app-settings): route app_settings_* to the TS host + emit :changed"
```

---

## Task A3: Wire the concrete store in main/index.ts

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `createAppSettingsStore` (A1), `appSettings` dep (A2).

- [ ] **Step 1: Build the node-fs-backed store and inject it**

In `apps/desktop/src/main/index.ts`, after the `nodeFs` adapter (around line 243) and before `tsHost = createTsActorHost({...})` (line 286), add:

```ts
  // App-level prefs: TS-owned (was native/src/app_settings.rs). Same on-disk
  // file (<userData>/app_settings.json) so existing settings carry over.
  const { createAppSettingsStore } = await import('./app-settings.js')
  const appSettings = createAppSettingsStore({
    fs: {
      exists: (p: string) => fs.existsSync(p),
      readFile: (p: string) => fs.readFileSync(p, 'utf8'),
      writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
      rename: (a: string, b: string) => fs.renameSync(a, b),
      mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
    },
    path: path.join(app.getPath('userData'), 'app_settings.json'),
    dir: app.getPath('userData'),
  })
```

Then add `appSettings,` to the `createTsActorHost({ ... })` deps object (alongside `motifStore,`):
```ts
    appSettings,
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Verify the renderer round-trip still works through the new path**

The renderer's `appSettingsSet`/`appSettingsGet` invoke `app_settings_set`/`app_settings_get`; `main/index.ts:360-362` now routes them (route `!== 'rust'`) to `tsHost.handleInvoke`, which serves them from the TS store and emits `app_settings:changed`. No renderer edit needed. (Full manual smoke happens in Task A5.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(app-settings): wire TS app-settings store into the host"
```

---

## Task A4: Delete the Rust AppSettingsStore + all references

At this point the channel is served entirely by TS; the Rust arm is dead. Remove it.

**Files:**
- Delete: `apps/desktop/native/src/app_settings.rs`
- Modify: `apps/desktop/native/src/lib.rs`, `napi_backend.rs`, `commands/prefs.rs`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Confirm nothing else reads it**

Run: `cd apps/desktop/native && rg -n "app_settings|AppSettings" src/`
Expected: only the deletion sites below — no compute/job/mcp/export path references it. (Verified during planning: the only readers are `commands/prefs.rs` and the `Backend` field/init.)

- [ ] **Step 2: Delete the module + references**

- Delete file `apps/desktop/native/src/app_settings.rs`.
- `lib.rs:10` — remove `mod app_settings;`.
- `napi_backend.rs`:
  - line 19 — remove `use crate::app_settings::AppSettingsStore;`
  - line 42 — remove `pub(crate) app_settings: AppSettingsStore,`
  - line 105 — remove `app_settings: AppSettingsStore::new(config_path),` (the *previous* `keybindings: KeybindingsStore::new(config_path.clone())` may now drop its `.clone()` since this was the last consumer — optional cleanup, leaving the clone compiles fine)
  - lines 481-485 — remove the `"app_settings_get" =>` and `"app_settings_set" => { ... }` match arms
  - lines 664-675 — remove the `#[tokio::test] async fn app_settings_set_emits_changed()` test (its TS equivalent now lives in `ts-actor-host.test.ts`)
- `commands/prefs.rs`:
  - lines 23-39 — remove `pub async fn app_settings_get(...)` and `pub async fn app_settings_set(...)`
  - lines 230-236 — remove the `AppSettingsSetArgs` struct + its doc comment

- [ ] **Step 3: Build + test Rust**

Run: `cd apps/desktop/native && cargo build && cargo test`
Expected: PASS — no `app_settings` symbols remain; no unused-import or dead-code warnings introduced. (If `cargo` flags an unused `config_path.clone()`, drop the clone per Step 2.)

- [ ] **Step 4: Update the architecture doc**

In `docs/architecture.md:185`, change the `app_settings.rs ← global preferences` line so it no longer lists a Rust file. Point it at the TS owner instead, e.g.:
```
app-level preferences → TS main (src/main/app-settings.ts); on disk at <userData>/app_settings.json
```
Keep the doc evergreen (no phase numbers / dates — `feedback_evergreen_docs`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/app_settings.rs apps/desktop/native/src/lib.rs apps/desktop/native/src/napi_backend.rs apps/desktop/native/src/commands/prefs.rs docs/architecture.md
git commit -m "refactor(app-settings)!: delete the Rust AppSettingsStore (TS owns it now)"
```

---

## Task A5: End-to-end verification

**Files:** none (verification + optional doc/memory note).

- [ ] **Step 1: Full TS test suite**

Run: `cd apps/desktop && npm test` (or `npx vitest run`)
Expected: PASS — including `app-settings.test.ts`, `router.test.ts`, `ts-actor-host.test.ts`. No regressions.

- [ ] **Step 2: Full Rust test suite + addon rebuild**

Run: `cd apps/desktop/native && cargo test` then rebuild the addon (`cd apps/desktop && npm run build` — match the project's napi build script).
Expected: PASS; addon rebuilt (stale bundle would mimic a code bug in the e2e).

- [ ] **Step 3: Manual smoke (real app)**

Launch the app (`npm run dev`). Then:
1. Toggle display mode (the `T` shortcut / View menu pill) → timeline track filter switches (AbRoll ↔ ShowAll). This proves `app_settings_set` → TS store → `app_settings:changed` event → renderer store → UI all flows.
2. Toggle the MediaPool drawer (`M`).
3. Fully quit and relaunch → both toggles persist (proves the TS store wrote `<userData>/app_settings.json` and `wireAppSettingsStream`'s initial `appSettingsGet()` reads it back).
4. (Optional) Inspect `<userData>/app_settings.json` — same shape/fields as before the migration.

Expected: all persist across restart; no console errors; the timeline reacts live to the toggle (event path intact).

- [ ] **Step 4: Update project memory**

After verification passes, append a note to the `project_state_actor_ts_migration` topic file (or a new `project_config_state_ts_migration` topic) recording: app_settings migrated Rust→TS main, on-disk file unchanged, renderer untouched, Rust↔TS struct twin deleted; roadmap stores 2-5 (view_state, export_settings, keybindings, recents) pending in `docs/superpowers/plans/2026-06-27-rust-config-state-to-ts-migration.md`. Add the one-line pointer to `MEMORY.md`.

---

# Sub-Plans 2-5 (scope blocks — expand to full TDD tasks when started)

> Each follows the shared pattern. These are scoped, not yet step-detailed; expand each into A1-A5-style tasks at execution time.

## Sub-Plan 2: `view_state` (`<workspace>/view.json`)
- **Source of truth:** already TS (renderer mutates view state; Rust only persisted). **Workspace-scoped.**
- **Store:** `src/main/view-state.ts` — same fs-backed shape, but the path is `join(workspaceDir, 'view.json')`. The host already has `deps.workspaceDir()`. Pre-workspace (`workspaceDir() === null`): `get` returns defaults, `set` silently drops (parity with `prefs.rs:43-62`).
- **Types:** there's no rich struct — `ViewState` is opaque-ish; define minimal shared type in `src/shared/view-state.ts` matching `native/src/view_state.rs`.
- **Router:** new `{ kind: 'viewState' }`; remove `view_state_get`/`view_state_set` from `PERSISTENCE`.
- **Host:** `case 'viewState'` reads `deps.workspaceDir()`; no `:changed` event.
- **Delete Rust:** `native/src/view_state.rs`, its `mod` decl, `prefs.rs:43-62` (`view_state_get`/`view_state_set`) + `ViewStateSetArgs` (`prefs.rs:240-244`), `napi_backend.rs:486-490` arms.

## Sub-Plan 3: `export_settings` (`<workspace>/export.json`)
- **Source of truth:** TS (renderer/encoder owns the schema; Rust stores an opaque `serde_json::Value`). **Workspace-scoped.**
- **Store:** `src/main/export-settings.ts` — value is `unknown` JSON (no typed struct). `get` returns `unknown | null`; `set` writes verbatim. Pre-workspace: `get` → `null`, `set` → drop (parity with `prefs.rs:66-84`).
- **Router:** new `{ kind: 'exportSettings' }`; remove `export_settings_get`/`export_settings_set` from `PERSISTENCE`.
- **Host:** `case 'exportSettings'` via `deps.workspaceDir()`; no event.
- **Delete Rust:** `native/src/export_settings_store.rs`, its `mod` decl, `prefs.rs:66-84` + `ExportSettingsSetArgs` (`prefs.rs:247-251`), `napi_backend.rs:491-495` arms.

## Sub-Plan 4: `keybindings` (`<userData>/keybindings.json`)
- **Source of truth:** Rust today; pure override map `Record<string, string[]>` (action id → chord list). Frontend already validates conflicts before calling. **Config-dir.**
- **Store:** `src/main/keybindings.ts` — multi-method: `get()`, `set(action, keys)`, `resetAll()`, `exportTo(dest)`, `importFrom(src)`. The export/import take absolute file paths (file-dialog results) — the store reads/writes those paths via the injected fs. No `:changed` event (renderer re-fetches via `keybindings_get`).
- **Router:** new `{ kind: 'keybindings' }`; remove all 5 `keybindings_*` from `PERSISTENCE`; host switches on the channel.
- **Delete Rust:** `native/src/keybindings.rs`, `mod` decl, `prefs.rs:147-180` + the `KeybindingsSetArgs`/`KeybindingsExportArgs`/`KeybindingsImportArgs` structs (`prefs.rs:267-287`), `napi_backend.rs:509+` arms.

## Sub-Plan 5: `recents` (`<userData>/recents.json`) — **dual writer**
- **Source of truth:** Rust today. **Config-dir.** Channels: `recents_list`, `recents_remove`, `recents_get_reopen_on_launch`, `recents_set_reopen_on_launch`, `recents_most_recent`, `recents_last_new_project_parent`.
- **Extra wrinkle (the reason it's last):** recents has a **second writer** — the workspace orchestrator writes it from main via `napiFacade.pushRecent(path,name)` and `napiFacade.setLastNewProjectParent(p)` (`main/index.ts:248-249`, called inside `workspace-orchestrator.ts`). When recents moves to TS, those two facade methods must call the new TS recents store instead of `backend.pushRecent`/`backend.setLastNewProjectParent`. Audit `workspace-orchestrator.ts` for every call site.
- **Store:** `src/main/recents.ts` — `list()`, `remove(path)`, `getReopenOnLaunch()`, `setReopenOnLaunch(v)`, `mostRecent()`, `lastNewProjectParent()`, plus the orchestrator-facing `push(path,name)`, `setLastNewProjectParent(p)`.
- **Router:** new `{ kind: 'recents' }`; remove all 6 `recents_*` from `PERSISTENCE`.
- **Delete Rust:** `native/src/recents.rs`, `mod` decl, `prefs.rs:100-143` + `RecentsRemoveArgs`/`RecentsSetReopenOnLaunchArgs` (`prefs.rs:254-265`), `napi_backend.rs:497-508` arms, and the `Backend::pushRecent`/`setLastNewProjectParent` napi methods + the `napiFacade` wiring in `main/index.ts`.

> After Sub-Plan 5, `commands/prefs.rs` retains only `ping`, `workspace_dir`, the agent-session/log readers, and the `PERSISTENCE` router bucket shrinks to `workspace_dir`, `agent_session_get`, `log_*` (the genuinely Rust-owned reads). `app_settings`, `view_state`, `export_settings`, `keybindings`, `recents` are all TS.

---

## Self-Review

- **Spec coverage:** ✅ All 5 roadmap stores represented; app_settings has full A1-A5 tasks; 2-5 scoped with files + wrinkle + deletion sites.
- **Renderer-untouched constraint:** ✅ app_settings keeps channel + event names; renderer only swaps local type defs for a shared re-export (call sites unchanged).
- **On-disk-compat constraint:** ✅ TS store writes `<userData>/app_settings.json` (= Rust's `app_config_dir`), same field names.
- **Partition-gate constraint:** ✅ A2 keeps `app_settings_*` in `ALL_CHANNELS`, reclassifies to `'appSettings'` (not `'reject'`/`'rust'`), removes from `PERSISTENCE`.
- **Type consistency:** ✅ `AppSettings`/`AppSettingsPatch`/`DisplayMode` single-sourced in `src/shared/app-settings.ts`; store returns `AppSettings`; host case casts `args.patch` to `AppSettingsPatch`.
- **Build-green-every-commit:** ✅ A2 lands router+host+types together (discriminated-union exhaustiveness stays satisfied); Rust deletion (A4) happens only after TS fully serves the channel (A3).
