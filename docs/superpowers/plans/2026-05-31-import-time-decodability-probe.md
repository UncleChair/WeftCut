# Import-Time Decodability Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Probe DirectExport sources for decodability eagerly at import (background sweep), demote undecodable ones to a full proxy via a route-correcting `ensure_full_proxy`, and make export auto-wait/auto-retry on an in-flight proxy — removing the scary "Can't decode … on this machine" export failure.

**Architecture:** A webview background sweep runs the existing per-file `probeSourceDecodable` over each DirectExport source as it appears; a failure calls `ensureFullProxy`, which now clears `export_uses_original` (route correction) before enqueuing the full proxy. The export path computes the set of timeline-referenced video sources (mirroring the Worker's decode predicate), confirms each is decode-ready, and for any whose proxy is still encoding shows a "preparing" panel that auto-starts the export once the store reflects `proxy_path`. A session-scoped probe memo (shared by sweep + export gate) makes capable machines pay one sub-second probe per source.

**Tech Stack:** Rust (Tauri command + actor patch), TypeScript/React (Zustand store, WebCodecs `probeSourceDecodable`, mediabunny), vitest for unit tests, i18next (en-US + zh-CN).

Spec: `docs/superpowers/specs/2026-05-31-import-time-decodability-probe-design.md`

---

## File Structure

- **Create** `apps/desktop/src/render/activeVideoLayers.ts` — shared pure selection: `selectActiveVideoLayers(summary, aUs, bUs)` (the single predicate for "which VideoClip layers are live"), and `referencedVideoMediaIds(summary, startUs, endUs)`.
- **Create** `apps/desktop/src/render/activeVideoLayers.test.ts` — unit tests for the predicate + referenced helper.
- **Create** `apps/desktop/src/render/exportReadiness.ts` — `sourcesNeedingPreflight` (moved), `ProbeState`/probe memo type, `prepareExportMedia(...)`, `waitForProxies(...)`, `ExportCancelled`/`ExportProxyFailed` errors.
- **Create** `apps/desktop/src/render/exportReadiness.test.ts` — unit tests for `sourcesNeedingPreflight`, `prepareExportMedia`, `waitForProxies` resolution logic.
- **Modify** `apps/desktop/src-tauri/src/commands.rs` — `ensure_full_proxy` clears `export_uses_original` before enqueue.
- **Modify** `apps/desktop/src-tauri/src/state/actor.rs` — add a route-correction-patch test.
- **Modify** `apps/desktop/src/render/worker/exportWorker.ts` — `activeVideoClips` delegates selection to `selectActiveVideoLayers`.
- **Modify** `apps/desktop/src/render/worker/runExport.ts` — remove the in-export probe + scary throw; referenced-scoped defensive check; drop `sourcesNeedingPreflight`/`preflightExportSources` (moved/removed).
- **Delete** `apps/desktop/src/render/worker/runExport.preflight.test.ts` — `sourcesNeedingPreflight` test moves to `exportReadiness.test.ts`; `preflightExportSources` is removed.
- **Modify** `apps/desktop/src/App.tsx` — import sweep effect, `ExportState` `preparing` kind, `ExportPanel` cancel, export gate in `runPixiExport`, `decodeProbeMemo`/`proxyStateRef` refs.
- **Modify** `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts` — `export.preparing`, `export.preparing_cancel`, `export.failed_prepare`.

**Test commands**
- TS: from `apps/desktop/`, `npx vitest run <relative path>` (e.g. `src/render/activeVideoLayers.test.ts`).
- Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`.

---

## Task 1: Rust — `ensure_full_proxy` becomes route-correcting

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs:2247-2264`
- Test: `apps/desktop/src-tauri/src/state/actor.rs` (test module at end of file)

- [ ] **Step 1: Write the test** — append to the `#[cfg(test)] mod tests` in `actor.rs`, right after `set_media_derivatives_patches_in_place_outside_history` (line ~6084). It reuses that module's existing helpers verbatim: `project_with_video_track()`, `spawn(project)`, `dummy_video_media(duration_us)`, `add_media_item`.

```rust
    #[tokio::test]
    async fn route_correction_clears_export_uses_original() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();

        // Seed DirectExport: export from the original, no proxy yet.
        handle
            .set_media_derivatives(
                Actor::User,
                media_id,
                MediaDerivativesPatch {
                    export_uses_original: Some(true),
                    ..Default::default()
                },
            )
            .await
            .expect("seed");

        // The route-correction patch the new `ensure_full_proxy` issues before
        // enqueuing the full proxy.
        handle
            .set_media_derivatives(
                Actor::Agent { client: "jobs".to_string() },
                media_id,
                MediaDerivativesPatch {
                    export_uses_original: Some(false),
                    ..Default::default()
                },
            )
            .await
            .expect("route-correct");

        let snap = handle.snapshot().await;
        let m = snap.media_pool.get(&media_id).unwrap();
        assert!(!m.export_uses_original, "export_uses_original cleared");
        assert!(m.proxy_path.is_none(), "proxy_path untouched by the clear");
    }
```

- [ ] **Step 2: Run the test.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml route_correction_clears_export_uses_original`
Expected: PASSES — this locks the actor patch the command relies on (clearing the flag in place, no proxy_path side effect, no undo entry).

- [ ] **Step 3: Modify the command to clear the flag before enqueue.** Replace the body of `ensure_full_proxy` (`commands.rs:2247-2264`) from the early-return down:

```rust
    let id = Uuid::parse_str(&media_id).map_err(|e| format!("invalid media_id: {e}"))?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    // Already have a full proxy on disk → nothing to do (the proxy already
    // shadows `export_uses_original` in the resolvers).
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    // Route correction: this source was routed to DirectExport
    // (export_uses_original) but cannot be decoded directly on this machine
    // (or the import sweep / export pre-flight decided so). Demote it to a
    // normal full-proxy source BEFORE enqueuing, so the resolvers stop
    // pointing export at the undecodable original and the gentle
    // "preparing" path applies during encoding. See ADR 0010 + the
    // import-time-decodability-probe design.
    handle
        .set_media_derivatives(
            crate::state::Actor::Agent { client: "jobs".to_string() },
            id,
            crate::state::MediaDerivativesPatch {
                export_uses_original: Some(false),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("route-correct {media_id}: {e}"))?;
    crate::jobs::enqueue_full_proxy(app, (*cache).clone(), (*handle).clone(), item);
    Ok(())
```

> Confirm `Actor` and `MediaDerivativesPatch` are reachable at `crate::state::…` (they are re-exported there — `jobs/mod.rs` imports `crate::state::{Actor, MediaDerivativesPatch, …}`). If the command file already `use`s them, drop the `crate::state::` prefix.

- [ ] **Step 4: Update the command doc-comment** (`commands.rs:2243-2246`) to reflect the new behavior:

```rust
/// Enqueue the full export proxy for `media_id` and route-correct it:
/// clears `export_uses_original` so the resolvers stop pointing export at the
/// (undecodable) original while the proxy encodes. No-op if a full proxy is
/// already present. Invoked by the import-time decodability sweep, the export
/// pre-flight, and the future per-clip "Generate proxy" action.
```

- [ ] **Step 5: Build + run tests.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ensure_full_proxy route_correction`
Expected: compiles; route-correction test PASSES.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(proxy): ensure_full_proxy route-corrects (clears export_uses_original)"
```

---

## Task 2: Shared video-layer selection (mirror the Worker's decode set)

**Files:**
- Create: `apps/desktop/src/render/activeVideoLayers.ts`
- Create: `apps/desktop/src/render/activeVideoLayers.test.ts`
- Modify: `apps/desktop/src/render/worker/exportWorker.ts:398-434`

- [ ] **Step 1: Write the failing test** (`activeVideoLayers.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { selectActiveVideoLayers, referencedVideoMediaIds } from "./activeVideoLayers";
import type { ProjectSummary } from "../../ipc";

const layer = (over: Record<string, unknown>) => ({
  id: "L", label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "VideoClip",
  color_hint: "#000", enabled: true, locked: false, effects: [],
  params: { kind: "VideoClip", media_id: "vid", media_label: "", src_in_us: 0, src_out_us: 1_000_000,
    x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, speed: 1, flip_h: false, flip_v: false,
    fade_in_us: 0, fade_out_us: 0 },
  ...over,
});
const summaryOf = (tracks: unknown[]): ProjectSummary =>
  ({ tracks } as unknown as ProjectSummary);

describe("selectActiveVideoLayers", () => {
  it("selects enabled VideoClip layers on enabled tracks overlapping [aUs, bUs]", () => {
    const s = summaryOf([
      { enabled: true, layers: [layer({ id: "A", params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } })] },
    ]);
    expect(selectActiveVideoLayers(s, 0, 999_999).map((l) => l.layerId)).toEqual(["A"]);
  });

  it("skips disabled tracks, disabled layers, and non-VideoClip layers", () => {
    const s = summaryOf([
      { enabled: false, layers: [layer({ id: "offtrack" })] },
      { enabled: true, layers: [layer({ id: "offlayer", enabled: false })] },
      { enabled: true, layers: [layer({ id: "audio", params: { kind: "Audio", media_id: "x" } })] },
      { enabled: true, layers: [layer({ id: "keep", params: { kind: "VideoClip", media_id: "k", src_in_us: 0 } })] },
    ]);
    expect(selectActiveVideoLayers(s, 0, 999_999).map((l) => l.layerId)).toEqual(["keep"]);
  });

  it("excludes layers outside [aUs, bUs] (bUs inclusive)", () => {
    const s = summaryOf([
      { enabled: true, layers: [
        layer({ id: "before", t_start_us: 0, t_end_us: 100 }),   // ends at 100 → excluded when aUs=100
        layer({ id: "after", t_start_us: 200, t_end_us: 300 }),  // starts at 200 → excluded when bUs=199
      ] },
    ]);
    expect(selectActiveVideoLayers(s, 100, 199).map((l) => l.layerId)).toEqual([]);
  });
});

describe("referencedVideoMediaIds", () => {
  it("returns distinct media ids for layers overlapping [startUs, endUs)", () => {
    const s = summaryOf([
      { enabled: true, layers: [
        layer({ id: "A", t_start_us: 0, t_end_us: 500, params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } }),
        layer({ id: "B", t_start_us: 500, t_end_us: 1000, params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } }),
        layer({ id: "C", t_start_us: 2000, t_end_us: 3000, params: { kind: "VideoClip", media_id: "c", src_in_us: 0 } }),
      ] },
    ]);
    // Range [0, 1000): A and B (both media "a"); C excluded.
    expect([...referencedVideoMediaIds(s, 0, 1000)].sort()).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run (from `apps/desktop/`): `npx vitest run src/render/activeVideoLayers.test.ts`
Expected: FAIL — `activeVideoLayers.ts` does not exist.

- [ ] **Step 3: Create the module** (`activeVideoLayers.ts`):

```ts
// The single source of truth for "which VideoClip layers does export decode?"
// Both the export Worker's decode loop (exportWorker.ts `activeVideoClips`)
// and the export-readiness gate (exportReadiness.ts) select from this. They
// MUST stay in lockstep: if the gate selects a different set than the Worker
// decodes, an undecodable source either reaches the Worker un-gated (the scary
// failure returns) or the export hangs on a proxy it never needed.

import type { ProjectSummary } from "../ipc";

export interface ActiveVideoLayer {
  layerId: string;
  mediaId: string;
  tStartUs: number;
  tEndUs: number;
  srcInUs: number;
}

/// Every enabled VideoClip layer on an enabled track whose interval overlaps
/// [aUs, bUs] (bUs INCLUSIVE — matches the Worker's per-chunk call, which
/// passes `chunkEndUs` as an inclusive PTS). Audio/Image/Text/etc. are not
/// WebCodecs-video-decoded and are excluded.
export function selectActiveVideoLayers(
  summary: ProjectSummary,
  aUs: number,
  bUs: number,
): ActiveVideoLayer[] {
  const out: ActiveVideoLayer[] = [];
  for (const track of summary.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled) continue;
      if (layer.params.kind !== "VideoClip") continue;
      if (layer.t_end_us <= aUs) continue;
      if (layer.t_start_us > bUs) continue;
      out.push({
        layerId: layer.id,
        mediaId: layer.params.media_id,
        tStartUs: layer.t_start_us,
        tEndUs: layer.t_end_us,
        srcInUs: layer.params.src_in_us,
      });
    }
  }
  return out;
}

/// Distinct video media ids the export of [startUs, endUs) will decode.
/// `endUs` is the half-open range end; pass `endUs - 1` to the inclusive
/// selector so the boundary matches the Worker's chunk math exactly.
export function referencedVideoMediaIds(
  summary: ProjectSummary,
  startUs: number,
  endUs: number,
): Set<string> {
  return new Set(
    selectActiveVideoLayers(summary, startUs, endUs - 1).map((l) => l.mediaId),
  );
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run src/render/activeVideoLayers.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor the Worker to delegate selection** — replace `exportWorker.ts`'s `activeVideoClips` (lines ~398-434) with a thin wrapper that keeps the PTS math but sources its selection from the shared predicate. Add the import at the top (next to the existing `import { Compositor }`):

```ts
import { selectActiveVideoLayers } from "../activeVideoLayers";
```

Replace the whole `activeVideoClips` function:

```ts
/// Collect every VideoClip live in [chunkStartUs, chunkEndUs] and translate
/// the overlap into source-local PTS bounds. Selection is delegated to
/// `selectActiveVideoLayers` (shared with the export-readiness gate); only the
/// PTS math lives here.
function activeVideoClips(
  summary: ProjectSummary,
  chunkStartUs: number,
  chunkEndUs: number,
): StagedClip[] {
  return selectActiveVideoLayers(summary, chunkStartUs, chunkEndUs).map((l) => {
    const overlapStartUs = Math.max(l.tStartUs, chunkStartUs);
    const overlapEndUs = Math.min(l.tEndUs - 1, chunkEndUs);
    return {
      layerId: l.layerId,
      mediaId: l.mediaId,
      srcAUs: l.srcInUs + (overlapStartUs - l.tStartUs),
      srcBUs: l.srcInUs + (overlapEndUs - l.tStartUs),
      tStartUs: l.tStartUs,
      tEndUs: l.tEndUs,
      srcInUs: l.srcInUs,
    };
  });
}
```

(The `LayerSummary` import in `exportWorker.ts` may now be unused — if the TS build flags it, drop it from the import list. `StagedClip` and `clipSrcPtsAt` are unchanged.)

- [ ] **Step 6: Type-check the Worker change.**

Run: `npx vitest run src/render/activeVideoLayers.test.ts` (still green) and `npx tsc --noEmit -p apps/desktop/tsconfig.json` from repo root (or the project's typecheck script) to confirm `exportWorker.ts` still compiles.
Expected: PASS / no type errors in `exportWorker.ts` or `activeVideoLayers.ts`.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/render/activeVideoLayers.ts apps/desktop/src/render/activeVideoLayers.test.ts apps/desktop/src/render/worker/exportWorker.ts
git commit -m "refactor(export): extract shared selectActiveVideoLayers + referencedVideoMediaIds"
```

---

## Task 3: `exportReadiness` module — preflight selection, prepare, wait

**Files:**
- Create: `apps/desktop/src/render/exportReadiness.ts`
- Create: `apps/desktop/src/render/exportReadiness.test.ts`

- [ ] **Step 1: Write the failing tests** (`exportReadiness.test.ts`):

```ts
import { describe, it, expect, vi } from "vitest";
import {
  sourcesNeedingPreflight,
  prepareExportMedia,
  waitForProxies,
  ExportCancelled,
  ExportProxyFailed,
  type ProbeState,
} from "./exportReadiness";

const vid = (over: Record<string, unknown>) => ({
  id: "m", label: "clip", kind: "Video", path: "/o.mov",
  proxy_path: null, quick_proxy_path: null,
  proxy_bypassed: false, export_uses_original: false,
  width: 1920, height: 1080,
  ...over,
} as unknown);

describe("sourcesNeedingPreflight", () => {
  it("selects DirectExport-from-original video sources only", () => {
    const pool = new Map<string, any>([
      ["m1", vid({ id: "m1", export_uses_original: true })],
      ["m2", vid({ id: "m2", proxy_bypassed: true })],
      ["m3", vid({ id: "m3", export_uses_original: true, proxy_path: "/p.mp4" })],
      ["m4", vid({ id: "m4", kind: "Audio" })],
    ]);
    expect(sourcesNeedingPreflight(pool as any).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("prepareExportMedia", () => {
  const deps = (over: Partial<Parameters<typeof prepareExportMedia>[1]> = {}) => ({
    probe: vi.fn().mockResolvedValue(true),
    ensureFullProxy: vi.fn().mockResolvedValue(undefined),
    proxyStateOf: () => undefined,
    urlForOriginal: (m: any) => `asset://${m.id}`,
    memo: new Map<string, ProbeState>(),
    ...over,
  });

  it("ready: proxy_path or proxy_bypassed sources need nothing", async () => {
    const d = deps();
    const r = await prepareExportMedia(
      [vid({ id: "p", proxy_path: "/p.mp4" }), vid({ id: "b", proxy_bypassed: true })] as any,
      d,
    );
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("decodable DirectExport source probes once and proceeds (export from original)", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue(true) });
    const r = await prepareExportMedia([vid({ id: "ok", export_uses_original: true })] as any, d);
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.probe).toHaveBeenCalledTimes(1);
    expect(d.memo.get("ok")).toBe("ok");
  });

  it("memo skips re-probing a known-decodable source", async () => {
    const memo = new Map<string, ProbeState>([["ok", "ok"]]);
    const d = deps({ memo, probe: vi.fn() });
    const r = await prepareExportMedia([vid({ id: "ok", export_uses_original: true })] as any, d);
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("undecodable DirectExport source route-corrects and waits", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue(false) });
    const r = await prepareExportMedia([vid({ id: "bad", export_uses_original: true })] as any, d);
    expect(r.waiting).toEqual(["bad"]);
    expect(r.failed).toEqual([]);
    expect(d.ensureFullProxy).toHaveBeenCalledWith("bad");
  });

  it("encoding-in-flight source (no path, proxyState pending) waits; failed source fails", async () => {
    const d = deps({ proxyStateOf: (id: string) => (id === "f" ? "failed" : "pending") });
    const r = await prepareExportMedia(
      [vid({ id: "w" }), vid({ id: "f" })] as any, // both: not bypassed, no proxy, not export_uses_original
      d,
    );
    expect(r.waiting).toEqual(["w"]);
    expect(r.failed).toEqual(["f"]);
    expect(d.probe).not.toHaveBeenCalled();
  });
});

describe("waitForProxies", () => {
  const makeDeps = () => {
    let storeCb: (() => void) | null = null;
    let errCb: ((id: string) => void) | null = null;
    const ready = new Set<string>();
    return {
      ready,
      fire: () => storeCb?.(),
      failOne: (id: string) => errCb?.(id),
      deps: {
        pathReady: (id: string) => ready.has(id),
        subscribeStore: (cb: () => void) => { storeCb = cb; return () => { storeCb = null; }; },
        onProxyError: (cb: (id: string) => void) => { errCb = cb; return () => { errCb = null; }; },
        signal: new AbortController().signal,
      },
    };
  };

  it("resolves immediately when all paths already ready", async () => {
    const h = makeDeps();
    h.ready.add("a");
    await expect(waitForProxies(["a"], h.deps)).resolves.toBeUndefined();
  });

  it("resolves once the store reflects every proxy_path", async () => {
    const h = makeDeps();
    const p = waitForProxies(["a", "b"], h.deps);
    h.ready.add("a"); h.fire();
    h.ready.add("b"); h.fire();
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects with ExportProxyFailed when a pending proxy errors", async () => {
    const h = makeDeps();
    const p = waitForProxies(["a"], h.deps);
    h.failOne("a");
    await expect(p).rejects.toBeInstanceOf(ExportProxyFailed);
  });

  it("rejects with ExportCancelled when the signal aborts", async () => {
    const ctrl = new AbortController();
    const h = makeDeps();
    const deps = { ...h.deps, signal: ctrl.signal };
    const p = waitForProxies(["a"], deps);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(ExportCancelled);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/render/exportReadiness.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module** (`exportReadiness.ts`):

```ts
// Export-readiness gate. Decides, for the video sources an export will decode,
// which are ready, which need a proxy that is still encoding (wait), and which
// have failed. Shares its probe memo with the import-time sweep so a capable
// machine probes each source at most once per session.
//
// See docs/superpowers/specs/2026-05-31-import-time-decodability-probe-design.md

import type { MediaSummary } from "../ipc";

/// Session probe memo value. "ok" = decoded a key frame this session (cache
/// hit, skip re-probe). "pending" = a probe is in flight (avoid double-probe).
export type ProbeState = "ok" | "pending";

/// Proxy lifecycle state mirrored from `media:job_*` events (App `proxyState`).
export type ProxyJobState = "pending" | "ready" | "failed";

export class ExportCancelled extends Error {
  constructor() { super("export cancelled"); this.name = "ExportCancelled"; }
}
export class ExportProxyFailed extends Error {
  constructor(public readonly mediaId: string) {
    super(`proxy generation failed for ${mediaId}`);
    this.name = "ExportProxyFailed";
  }
}

/// Video sources whose export path is the ORIGINAL via DirectExport
/// (export_uses_original, no full proxy yet). DirectBoth (proxy_bypassed) is
/// H.264 and universally decodable, so it is skipped. Used by BOTH the import
/// sweep (whole pool) and the export gate (referenced-scoped via filtering).
export function sourcesNeedingPreflight(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) => m.kind === "Video" && m.export_uses_original && !m.proxy_path,
  );
}

export interface PrepareDeps {
  /// Decode one key frame; true = decodable on this machine.
  probe: (assetUrl: string) => Promise<boolean>;
  /// Route-correct + enqueue the full proxy (Tauri `ensure_full_proxy`).
  ensureFullProxy: (mediaId: string) => Promise<void>;
  /// Session proxy-job state for a media id (App `proxyState`).
  proxyStateOf: (mediaId: string) => ProxyJobState | undefined;
  /// asset:// URL for a source's ORIGINAL file.
  urlForOriginal: (m: MediaSummary) => string;
  /// Shared session probe memo (App-owned ref).
  memo: Map<string, ProbeState>;
}

export interface PrepareResult {
  /// Referenced sources whose full proxy is in flight — export must wait.
  waiting: string[];
  /// Referenced sources whose proxy generation has failed — export errors.
  failed: string[];
}

/// For each referenced VIDEO source, confirm an export-decode path exists.
/// Mirrors `exportPlaybackPathFor`: proxy_path / proxy_bypassed are ready;
/// export_uses_original is "ready" only if it actually decodes (probe);
/// otherwise the source is mid-proxy (wait) or failed.
export async function prepareExportMedia(
  referencedMedia: MediaSummary[],
  deps: PrepareDeps,
): Promise<PrepareResult> {
  const waiting: string[] = [];
  const failed: string[] = [];
  // Sequential: keeps the probe from competing with preview/quick-proxy
  // decoders for the WebCodecs buffer pool (see webcodecs-buffer-pool).
  for (const m of referencedMedia) {
    if (m.kind !== "Video") continue;
    if (m.proxy_path || m.proxy_bypassed) continue; // export path ready
    if (m.export_uses_original) {
      // DirectExport: exportPlaybackPathFor returns the original — confirm it
      // actually decodes before committing.
      if (deps.memo.get(m.id) === "ok") continue; // cached decodable
      deps.memo.set(m.id, "pending");
      const ok = await deps.probe(deps.urlForOriginal(m));
      if (ok) { deps.memo.set(m.id, "ok"); continue; }
      deps.memo.delete(m.id);
      await deps.ensureFullProxy(m.id);
      waiting.push(m.id);
      continue;
    }
    // No proxy, not bypassed, not DirectExport ⇒ exportPlaybackPathFor null:
    // the source was route-corrected and its proxy is in flight, or failed.
    if (deps.proxyStateOf(m.id) === "failed") failed.push(m.id);
    else waiting.push(m.id);
  }
  return { waiting, failed };
}

export interface WaitDeps {
  /// True once the DURABLE store shows a usable export path for this id
  /// (i.e. `exportPlaybackPathFor(store.mediaById.get(id)) != null`). Keying
  /// off the store — not the media:job_complete event — guarantees the store
  /// runExport reads is already fresh when the wait resolves.
  pathReady: (mediaId: string) => boolean;
  /// Subscribe to store changes; returns an unsubscribe fn.
  subscribeStore: (cb: () => void) => () => void;
  /// Subscribe to proxy-job errors by media id; returns an unsubscribe fn.
  onProxyError: (cb: (mediaId: string) => void) => () => void;
  signal: AbortSignal;
}

/// Resolves when every id has a ready export path in the store; rejects with
/// ExportProxyFailed if a still-pending id's proxy errors, or ExportCancelled
/// if the signal aborts.
export function waitForProxies(ids: string[], deps: WaitDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pending = new Set(ids);
    let unsubStore = () => {};
    let unsubErr = () => {};
    const cleanup = () => {
      unsubStore();
      unsubErr();
      deps.signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      for (const id of [...pending]) if (deps.pathReady(id)) pending.delete(id);
      if (pending.size === 0) { cleanup(); resolve(); }
    };
    const onAbort = () => { cleanup(); reject(new ExportCancelled()); };
    if (deps.signal.aborted) { reject(new ExportCancelled()); return; }
    deps.signal.addEventListener("abort", onAbort);
    unsubErr = deps.onProxyError((id) => {
      if (pending.has(id) && !deps.pathReady(id)) {
        cleanup();
        reject(new ExportProxyFailed(id));
      }
    });
    unsubStore = deps.subscribeStore(check);
    check(); // initial snapshot — a proxy may have finished before we subscribed
  });
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run src/render/exportReadiness.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/render/exportReadiness.ts apps/desktop/src/render/exportReadiness.test.ts
git commit -m "feat(export): exportReadiness — preflight selection, prepare, waitForProxies"
```

---

## Task 4: Import-time decodability sweep (App effect)

**Files:**
- Modify: `apps/desktop/src/App.tsx` (add refs near line 163; add the sweep effect near the `media:job_*` listener at ~470)

- [ ] **Step 1: Add the shared refs** — after the `proxyState` state (App.tsx:161-163) add:

```tsx
  // Session decodability probe memo, shared by the import-time sweep and the
  // export-readiness gate. id → "ok" (decoded a key frame this session) /
  // "pending" (probe in flight). A decodable DirectExport source stays
  // export_uses_original forever, so this memo is what stops re-probing it.
  const decodeProbeMemo = useRef<Map<string, ProbeState>>(new Map());
  // Fast mirror of proxyState for use inside callbacks (stale-closure-proof).
  const proxyStateRef = useRef(proxyState);
  useEffect(() => { proxyStateRef.current = proxyState; }, [proxyState]);
```

Add imports at the top of `App.tsx` (next to other render imports):

```tsx
import { convertFileSrc } from "@tauri-apps/api/core";
import { probeSourceDecodable } from "./render/decoder/probeSourceDecodable";
import {
  sourcesNeedingPreflight,
  type ProbeState,
} from "./render/exportReadiness";
import { ensureFullProxy } from "./ipc";
```

> Some of these may already be imported (`convertFileSrc`, `ensureFullProxy`). Merge, don't duplicate.

- [ ] **Step 2: Add the sweep effect** — after the `media:job_*` listener effect (App.tsx ends ~470). It depends on `summary` (App's local project summary, refreshed on every `project:changed`) so it re-runs when the media pool changes, but reads the fresh Zustand pool:

```tsx
  // Import-time decodability sweep. For every DirectExport video source not yet
  // probed this session, decode one key frame in the background; on failure
  // route-correct it (ensureFullProxy clears export_uses_original + enqueues a
  // full proxy). Capable machines pay one sub-second probe and generate no
  // master proxy. Sequential to avoid competing with preview decoders.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const memo = decodeProbeMemo.current;
      const pool = useProjectStore.getState().mediaById;
      const candidates = sourcesNeedingPreflight(pool).filter(
        (m) =>
          m.available &&
          memo.get(m.id) !== "ok" &&
          memo.get(m.id) !== "pending",
      );
      for (const m of candidates) {
        if (cancelled) return;
        memo.set(m.id, "pending");
        let ok = false;
        try {
          ok = await probeSourceDecodable(convertFileSrc(m.path));
        } catch {
          ok = false;
        }
        if (cancelled) return;
        if (ok) {
          memo.set(m.id, "ok");
        } else {
          memo.delete(m.id);
          try {
            await ensureFullProxy(m.id);
          } catch (e) {
            console.error("[weftcut] route-correct failed for", m.id, e);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [summary]);
```

> `useProjectStore` is already imported in `App.tsx` (used elsewhere via `useProjectStore.getState()`); if not, add `import { useProjectStore } from "./state/projectStore";`.

- [ ] **Step 3: Type-check.**

Run (repo root): `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: no errors. (No unit test here — effect wiring is covered by the pure `sourcesNeedingPreflight` test + manual smoke in Task 8.)

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(import): background decodability sweep route-corrects undecodable sources"
```

---

## Task 5: `ExportState` `preparing` kind + panel cancel + i18n

**Files:**
- Modify: `apps/desktop/src/App.tsx` (`ExportState` ~1276, `ExportPanel` ~1282-1349)
- Modify: `apps/desktop/src/i18n/locales/en-US.ts:229-237`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts:227-235`

- [ ] **Step 1: Add the `preparing` variant** to `ExportState` (App.tsx:1276-1280):

```tsx
type ExportState =
  | { kind: "starting" }
  | { kind: "preparing"; labels: string[]; onCancel: () => void }
  | { kind: "progress"; progress: ExportProgress }
  | { kind: "complete"; payload: ExportComplete }
  | { kind: "error"; detail: string };
```

- [ ] **Step 2: Render `preparing` + allow cancel** in `ExportPanel`. Update the `inProgress` guard so `starting`/`progress` still hide dismiss, but `preparing` shows a Cancel button. Add a `case "preparing"` to the body switch (App.tsx ~1299) and a cancel control in the header (~1346):

```tsx
  // `starting`/`progress` hide the dismiss button; `preparing` shows Cancel.
  const inProgress = state.kind === "starting" || state.kind === "progress";
```

Body switch — add before `case "complete"`:

```tsx
    case "preparing":
      body = (
        <span>
          {t("export.preparing", {
            labels: state.labels.join(", "),
            count: state.labels.length,
          })}
        </span>
      );
      break;
```

Header — add next to the dismiss button block (so the user can abort the wait):

```tsx
        {state.kind === "preparing" && (
          <button onClick={state.onCancel}>
            {t("export.preparing_cancel")}
          </button>
        )}
```

- [ ] **Step 3: Add i18n keys (en-US)** — inside the `export:` object (`en-US.ts:229-237`), after `progress_label`:

```ts
    preparing:
      "Preparing optimized media for {{labels}} — export will start automatically.",
    preparing_cancel: "Cancel",
    failed_prepare:
      "Couldn't prepare {{labels}} for export — the file may be corrupt or unsupported. Re-import it and try again.",
```

- [ ] **Step 4: Add i18n keys (zh-CN)** — inside the `export:` object (`zh-CN.ts:227-235`), after `progress_label`:

```ts
    preparing: "正在为 {{labels}} 准备优化媒体 —— 准备好后将自动开始导出。",
    preparing_cancel: "取消",
    failed_prepare:
      "无法为 {{labels}} 准备导出媒体 —— 文件可能损坏或不受支持。请重新导入后再试。",
```

- [ ] **Step 5: Type-check.**

Run (repo root): `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: no errors. (`onCancel` is wired in Task 6; until then `preparing` is just unused — that's fine, it compiles.)

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(export): ExportPanel preparing state + cancel + i18n"
```

---

## Task 6: Export gate — prepare + auto-wait + auto-retry in `runPixiExport`

**Files:**
- Modify: `apps/desktop/src/App.tsx` (`runPixiExport`, App.tsx:609-700)

- [ ] **Step 1: Add imports** at the top of `App.tsx`:

```tsx
import { referencedVideoMediaIds } from "./render/activeVideoLayers";
import {
  prepareExportMedia,
  waitForProxies,
  ExportCancelled,
  ExportProxyFailed,
} from "./render/exportReadiness";
import { exportPlaybackPathFor } from "./state/projectStore";
import { listen } from "@tauri-apps/api/event"; // if not already imported
import { MEDIA_JOB_EVENTS, type MediaJobEvent } from "./ipc"; // match the names used by the existing media:job listener
```

> Reuse whatever symbol the existing `media:job_*` listener uses for the error event + payload type (`MEDIA_JOB_EVENTS.error`, `MediaJobEvent`). Do not introduce new names.

- [ ] **Step 2: Insert the gate** at the start of `runPixiExport`, immediately after the `saveDialog` path check (App.tsx:617, before the temp-path allocation). This computes referenced sources, prepares them, and waits if needed — before any Worker spins up:

```tsx
    // ---- Export-readiness gate -------------------------------------------
    // Confirm every video source the export will decode is ready. Undecodable
    // DirectExport sources are route-corrected here; sources whose proxy is
    // still encoding put the panel into "preparing" and auto-start when ready.
    {
      const store = useProjectStore.getState();
      const proj = store.summary; // block-scoped; avoids shadowing the App `summary` state
      if (!proj) {
        setExportState({ kind: "error", detail: "No project loaded." });
        return;
      }
      const startUs = 0;
      const endUs = proj.duration_us;
      const referencedIds = referencedVideoMediaIds(proj, startUs, endUs);
      const referencedMedia = [...referencedIds]
        .map((id) => store.mediaById.get(id))
        .filter((m): m is NonNullable<typeof m> => !!m);

      setExportState({ kind: "starting" });
      const prep = await prepareExportMedia(referencedMedia, {
        probe: (url) => probeSourceDecodable(url),
        ensureFullProxy: (id) => ensureFullProxy(id),
        proxyStateOf: (id) => proxyStateRef.current.get(id),
        urlForOriginal: (m) => convertFileSrc(m.path),
        memo: decodeProbeMemo.current,
      });

      if (prep.failed.length > 0) {
        const labels = prep.failed
          .map((id) => store.mediaById.get(id)?.label ?? id)
          .join(", ");
        setExportState({
          kind: "error",
          detail: t("export.failed_prepare", { labels }),
        });
        return;
      }

      if (prep.waiting.length > 0) {
        const ctrl = new AbortController();
        const labels = prep.waiting.map(
          (id) => store.mediaById.get(id)?.label ?? id,
        );
        setExportState({
          kind: "preparing",
          labels,
          onCancel: () => ctrl.abort(),
        });
        try {
          await waitForProxies(prep.waiting, {
            pathReady: (id) =>
              exportPlaybackPathFor(
                useProjectStore.getState().mediaById.get(id),
              ) != null,
            subscribeStore: (cb) => useProjectStore.subscribe(cb),
            onProxyError: (cb) => {
              // `listen` is async; guard against it resolving after cleanup
              // (which would leak the listener).
              let off: (() => void) | null = null;
              let disposed = false;
              void listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
                if (e.payload.kind === "proxy") cb(e.payload.media_id);
              }).then((u) => {
                if (disposed) u();
                else off = u;
              });
              return () => {
                disposed = true;
                off?.();
              };
            },
            signal: ctrl.signal,
          });
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          const id = e instanceof ExportProxyFailed ? e.mediaId : "";
          const label = store.mediaById.get(id)?.label ?? id;
          setExportState({
            kind: "error",
            detail: t("export.failed_prepare", { labels: label }),
          });
          return;
        }
      }
    }
    // ---- end gate --------------------------------------------------------
```

> Note: `runPixiExport` later re-declares `summary` inside the `onProgress` closure via `useProjectStore.getState().summary` — the gate's `summary` is block-scoped (wrapped in `{ }`), so there is no redeclaration clash. The existing `setExportState({ kind: "starting" })` call further down (App.tsx:626) is now redundant but harmless; leave it or remove it.

- [ ] **Step 3: Type-check.**

Run (repo root): `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: no errors. Confirm `proxyStateRef`, `decodeProbeMemo`, `probeSourceDecodable`, `convertFileSrc`, `ensureFullProxy` are all in scope (added in Tasks 4/6).

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(export): gate export on decodability — prepare + auto-wait + auto-retry"
```

---

## Task 7: Simplify `runExport` — remove in-export probe + scary throw

**Files:**
- Modify: `apps/desktop/src/render/worker/runExport.ts:51-140`
- Delete: `apps/desktop/src/render/worker/runExport.preflight.test.ts`

- [ ] **Step 1: Delete the stale test file** (its `sourcesNeedingPreflight` coverage now lives in `exportReadiness.test.ts`; `preflightExportSources` is removed).

```bash
git rm apps/desktop/src/render/worker/runExport.preflight.test.ts
```

- [ ] **Step 2: Remove the moved/dead exports and the probe imports.** In `runExport.ts`, delete `sourcesNeedingPreflight` (lines ~51-60), `PreflightDeps` + `preflightExportSources` (lines ~62-80), and the two now-unused imports:

Remove these import lines:
```ts
import { ensureFullProxy } from "../../ipc";
import { probeSourceDecodable } from "../decoder/probeSourceDecodable";
```
Keep `import { exportPlaybackPathFor } from "../../state/projectStore";` (still used in Step 3). Add the referenced-scope import:
```ts
import { referencedVideoMediaIds } from "../activeVideoLayers";
```

- [ ] **Step 3: Replace the per-media URL loop + pre-flight block** (runExport.ts:104-140) with a referenced-scoped resolution. The App gate (Task 6) guarantees referenced sources are ready, so this keeps only a defensive check (a real bug, not the user-facing decodability path):

```ts
  // 1. Pre-resolve asset URLs for every media item. The Worker has no Tauri
  // runtime so it can't call `convertFileSrc` itself. Only REFERENCED video
  // sources must have a ready export path — the export-readiness gate in App
  // guarantees that before calling here; this is a defensive assertion.
  const referenced = referencedVideoMediaIds(summary, startUs, endUs);
  const proxyAssetUrls: Record<string, string> = {};
  const originalAssetUrls: Record<string, string> = {};
  const mediaDims: Record<string, { width: number | null; height: number | null }> = {};
  for (const m of init.mediaById.values()) {
    const proxyPath = exportPlaybackPathFor(m);
    if (m.kind === "Video" && referenced.has(m.id) && !proxyPath) {
      throw new Error(
        `Internal: "${m.label}" has no export-ready source (the readiness gate should have prevented this).`,
      );
    }
    if (proxyPath) proxyAssetUrls[m.id] = convertFileSrc(proxyPath);
    originalAssetUrls[m.id] = convertFileSrc(m.path);
    mediaDims[m.id] = { width: m.width, height: m.height };
  }
```

> Net imports for `runExport.ts`: keep `convertFileSrc`, `exportPlaybackPathFor`, `referencedVideoMediaIds`; drop `ensureFullProxy`, `probeSourceDecodable`. The entire decode pre-flight block (old lines 122-140, including the "Can't decode … directly on this machine" throw) is deleted.

- [ ] **Step 4: Update the file header comment** (runExport.ts:1-10) to drop the pre-flight description — replace the "Callers … get one Promise" paragraph's surrounding context note about pre-flight if present; ensure no comment still claims runExport probes decodability.

- [ ] **Step 5: Type-check + run the remaining render tests.**

Run (repo root): `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Run (from `apps/desktop/`): `npx vitest run src/render/exportReadiness.test.ts src/render/activeVideoLayers.test.ts`
Expected: no type errors; both test files PASS. Confirm `runExport.preflight.test.ts` is gone and nothing imports `preflightExportSources`/`sourcesNeedingPreflight` from `runExport` (grep: `npx grep` or editor search for `from "./runExport"` / `from "../worker/runExport"`).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/render/worker/runExport.ts
git commit -m "refactor(export): remove in-export decodability probe + scary throw (gated in App)"
```

---

## Task 8: Manual smoke verification (capable machine)

**Files:** none (verification only). The browser fixture suite is broken (see project memory `browser-fixture-suite-broken`), so end-to-end is verified manually.

- [ ] **Step 1: Build + launch the app.**

Run: `npm run tauri dev` (from `apps/desktop/`, or the project's dev script).
Expected: app launches, no console errors on boot.

- [ ] **Step 2: Capable-machine happy path.** Import an HEVC/AV1 8-bit clip. Watch the status/console: the sweep probes it (one key frame) and it passes; no master proxy job starts (only the quick proxy). Place it on the timeline and export immediately.
Expected: export runs from the original with **no** "preparing" panel and **no** "Can't decode" message; output MP4 plays.

- [ ] **Step 3: Simulated incapable path.** Temporarily force `probeSourceDecodable` to resolve `false` (e.g. add `return false;` at the top of `probeSourceDecodable` in a scratch edit, or stub via devtools). Re-import an HEVC clip.
Expected: the sweep route-corrects it → a full-proxy job appears (status bar). The media card shows "Preparing…" then becomes usable. Place it and export *while the proxy is still encoding*.
Expected: the export panel shows the **"Preparing optimized media …"** state, then **auto-starts** the export when the proxy lands; no scary message. Cancel during "preparing" dismisses cleanly and the proxy keeps encoding in the background. Revert the scratch edit afterward.

- [ ] **Step 4: Proxy-failure path (optional).** With the probe forced `false`, also make the proxy job fail (e.g. point at a corrupt file).
Expected: the media card shows `proxy_failed`; exporting a timeline that references it shows the **"Couldn't prepare … re-import it"** actionable error (no hang, no scary string).

- [ ] **Step 5: Full test sweep.**

Run (repo root): `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Run (from `apps/desktop/`): `npx vitest run src/render/activeVideoLayers.test.ts src/render/exportReadiness.test.ts`
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: all green.

- [ ] **Step 6: Final commit (if any smoke-driven fixes were made).**

```bash
git add -A
git commit -m "test(export): verify import-time decodability probe end-to-end"
```

---

## Notes for the implementer

- **Drift hazard:** `selectActiveVideoLayers` is the single predicate shared by `exportWorker.ts` and the readiness gate. If you change which layers export decodes, change it there once. This codebase has documented byte-identical-but-drifting helpers (engine source, snap math); this extraction exists to prevent a third.
- **Race the wait closes:** `waitForProxies` resolves on `useProjectStore` reflecting `proxy_path` (durable), not the `media:job_complete` event — because `runExport` reads `useProjectStore.getState().mediaById` and the event/store-refresh are separate async channels.
- **Memo scope:** `decodeProbeMemo` is an App `useRef` shared by the sweep and the gate, so repeat exports of a decodable source don't re-probe.
- **Sweep is source-agnostic** (user drop, MCP, project open) because it reads the media pool, and skips `available === false` sources (a probe against a not-yet-copied original would wrongly route-correct).
