# Instant Decodable Preview — Plan 2: the preview-from-original bridge (frontend)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For any video source this machine's WebCodecs can decode (the import sweep's `probeSourceDecodable` verdict — including HEVC/AV1/VP9 and Hi10P), show its **original immediately** in preview instead of a blank window, until a proxy lands. Pure-frontend; no Rust, no schema change; session-scoped (driven by the existing `decodeProbeMemo`).

**Architecture:** The decodability verdict already lives in `decodeProbeMemo` (App ref; the import sweep sets `memo.set(id, "ok")` when the probe passes). The bridge is: (1) `previewPlaybackPathFor` returns the original when a `previewDecodable` flag is set + no proxy yet; (2) the import sweep probes the broader "would-be-blank" set (not just DirectExport) so 10-bit/full-proxy sources get a verdict too; (3) the flag is threaded from `decodeProbeMemo` through `PreviewSurface` into `PixiPreview`'s `proxyAssetUrl` resolver; (4) the import notification distinguishes "previewable now, optimizing in background" from "not yet usable, transcoding."

**Tech Stack:** TypeScript / React (`apps/desktop/src`), Vitest. Run unit tests from `apps/desktop/` with `npm test` (= `vitest run`, excludes the broken `*.browser.test.ts` suite — see [[weftcut-toolchain-baseline-red]]; typecheck/prod build are red at baseline, so `npm test` on the touched pure modules + `tauri:dev` smoke are the gates).

**Spec:** `docs/superpowers/specs/2026-06-01-instant-decodable-preview-design.md` (§C, §F). Narrow-proxy (Plan 1) is deferred; this plan delivers the headline alone.

---

## File Structure

- **Modify** `apps/desktop/src/state/projectStore.ts:146-159` — `previewPlaybackPathFor` gains an optional `{ previewDecodable }` arg (Task 1).
- **Modify** `apps/desktop/src/state/projectStore.proxyPaths.test.ts` — bridge cases (Task 1).
- **Modify** `apps/desktop/src/render/exportReadiness.ts` — add `sourcesNeedingPreviewProbe` (Task 2).
- **Modify** `apps/desktop/src/render/exportReadiness.test.ts` — cover the new selector (Task 2).
- **Modify** `apps/desktop/src/App.tsx` — sweep probes `sourcesNeedingPreviewProbe`; failure route-corrects only `export_uses_original`; pass `previewDecodableOf` to `<PreviewSurface>`; nudge preview to re-resolve on a verdict flip (Task 2 + Task 3).
- **Modify** `apps/desktop/src/preview/PreviewSurface.tsx` — forward a `previewDecodableOf` prop + a `refreshSources()` handle method (Task 3).
- **Modify** `apps/desktop/src/render/PixiPreview.tsx:107-111` — `proxyAssetUrl` consults `previewDecodableOf`; add `refreshSources()` to the handle (Task 3).
- **Modify** `apps/desktop/src/panels/importOptimize.ts` — `bridged`/`transcoding` three-state + reason (Task 4).
- **Modify** `apps/desktop/src/panels/importOptimize.test.ts` — classifier + reason cases (Task 4).
- **Modify** `apps/desktop/src/panels/ImportProxyDialog.tsx` — render the `bridged` row (Task 4).
- **Modify** `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts` — bridged/transcoding strings (Task 5).

All verification commands run from `apps/desktop/`.

---

## Task 1: `previewPlaybackPathFor` bridges to the original when probe-decodable

**Files:**
- Modify: `apps/desktop/src/state/projectStore.ts:146-159`
- Test: `apps/desktop/src/state/projectStore.proxyPaths.test.ts`

- [ ] **Step 1: Add the failing bridge tests**

Append to the `describe("direct-export source resolution", ...)` block (or a new `describe`) in `projectStore.proxyPaths.test.ts` (the `video()` helper there builds a `MediaSummary` with `path: "/orig.mp4"`):

```ts
  it("preview bridges to the original when probe-decodable and no proxy yet", () => {
    expect(
      previewPlaybackPathFor(video({ export_uses_original: true }), {
        previewDecodable: true,
      }),
    ).toBe("/orig.mp4");
  });

  it("preview stays blank when not probe-decodable and no proxy", () => {
    expect(
      previewPlaybackPathFor(video({ export_uses_original: true }), {
        previewDecodable: false,
      }),
    ).toBeNull();
    expect(previewPlaybackPathFor(video({ export_uses_original: true }))).toBeNull();
  });

  it("preview prefers the quick proxy over the bridge once it lands", () => {
    expect(
      previewPlaybackPathFor(video({ quick_proxy_path: "/q.mp4" }), {
        previewDecodable: true,
      }),
    ).toBe("/q.mp4");
  });

  it("preview bridges a 10-bit full-proxy source when probe-decodable", () => {
    expect(
      previewPlaybackPathFor(
        video({ codec: "hevc", pix_fmt: "yuv420p10le" }),
        { previewDecodable: true },
      ),
    ).toBe("/orig.mp4");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- projectStore.proxyPaths`
Expected: FAIL — `previewPlaybackPathFor` ignores the 2nd arg, so the bridge cases return `null` instead of `/orig.mp4`.

- [ ] **Step 3: Add the `previewDecodable` arg**

Replace `previewPlaybackPathFor` (lines 146-159) with:

```ts
/// Returns the effective preview path for a media item. Preview may use a
/// quick proxy while the full proxy is still rendering; export must not.
/// `opts.previewDecodable` is the session bridge flag: when this machine's
/// WebCodecs confirmed it can decode the original (import probe), preview reads
/// the original directly until a proxy lands. Session-scoped, never persisted.
export function previewPlaybackPathFor(
  media: MediaSummary | undefined,
  opts?: { previewDecodable?: boolean },
): string | null {
  if (!media) return null;
  if (media.kind === "Video") {
    // Prefer the light quick proxy for preview. The full proxy is a
    // source-resolution EXPORT master (heavy to scrub); last-resort preview
    // source only if no quick proxy exists (ADR 0011).
    if (media.quick_proxy_path) return media.quick_proxy_path;
    if (media.proxy_path) return media.proxy_path;
    // Preview from the original for DirectBoth (proxy_bypassed = H.264) OR,
    // via the bridge, any source this machine probed as decodable (incl.
    // HEVC/AV1/Hi10P) while its proxy is still building.
    if (media.proxy_bypassed) return media.path;
    if (opts?.previewDecodable) return media.path;
    return null;
  }
  return media.path;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- projectStore.proxyPaths`
Expected: PASS — bridge cases return `/orig.mp4`; the no-flag/`false` cases stay `null`; the quick-proxy case still wins. Existing `exportPlaybackPathFor` cases unaffected (separate function).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/state/projectStore.ts apps/desktop/src/state/projectStore.proxyPaths.test.ts
git commit -m "feat(preview): previewPlaybackPathFor bridges to the original when probe-decodable"
```

---

## Task 2: Probe the broader "would-be-blank" set + sweep wiring

**Files:**
- Modify: `apps/desktop/src/render/exportReadiness.ts`
- Test: `apps/desktop/src/render/exportReadiness.test.ts`
- Modify: `apps/desktop/src/App.tsx` (the import sweep effect, ~lines 520-555)

`sourcesNeedingPreflight` is export-gate-scoped (DirectExport only). The bridge needs a superset — every video that would currently show a blank preview (no quick proxy, no full proxy, not bypassed), incl. full-proxy/10-bit sources — so their decodability lands in the shared memo. Add a new selector rather than widen the export-gate one.

- [ ] **Step 1: Add the failing selector test**

Append to `exportReadiness.test.ts`:

```ts
import { sourcesNeedingPreviewProbe } from "./exportReadiness";

describe("sourcesNeedingPreviewProbe", () => {
  const v = (over: Partial<MediaSummary>): MediaSummary =>
    ({
      id: over.id ?? "m",
      kind: "Video",
      label: "",
      path: "/o.mp4",
      available: true,
      proxy_path: null,
      quick_proxy_path: null,
      proxy_bypassed: false,
      export_uses_original: false,
      codec: "hevc",
      pix_fmt: "yuv420p",
      ...over,
    }) as MediaSummary;

  const map = (...items: MediaSummary[]) =>
    new Map(items.map((m) => [m.id, m]));

  it("includes a would-be-blank DirectExport source", () => {
    const out = sourcesNeedingPreviewProbe(map(v({ id: "a", export_uses_original: true })));
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });

  it("includes a would-be-blank full-proxy/10-bit source (not just DirectExport)", () => {
    const out = sourcesNeedingPreviewProbe(map(v({ id: "b", pix_fmt: "yuv420p10le" })));
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  it("excludes sources that already have a preview path or are bypassed", () => {
    const out = sourcesNeedingPreviewProbe(
      map(
        v({ id: "q", quick_proxy_path: "/q.mp4" }),
        v({ id: "p", proxy_path: "/p.mp4" }),
        v({ id: "byp", proxy_bypassed: true }),
        v({ id: "gone", available: false }),
      ),
    );
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- exportReadiness`
Expected: FAIL — `sourcesNeedingPreviewProbe` is not exported.

- [ ] **Step 3: Add `sourcesNeedingPreviewProbe`**

In `exportReadiness.ts`, add below `sourcesNeedingPreflight`:

```ts
/// Video sources that would show a BLANK preview right now (no quick proxy, no
/// full proxy, not bypassed) — candidates for the preview-from-original bridge.
/// A SUPERSET of `sourcesNeedingPreflight`: it also includes full-proxy/10-bit
/// sources, so a decodable Hi10P/HEVC gets a verdict in the shared memo and can
/// bridge while its proxy builds. The import sweep probes these; the export gate
/// keeps using the narrower `sourcesNeedingPreflight`.
export function sourcesNeedingPreviewProbe(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) =>
      m.kind === "Video" &&
      m.available &&
      !m.quick_proxy_path &&
      !m.proxy_path &&
      !m.proxy_bypassed,
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- exportReadiness`
Expected: PASS — the new selector cases pass; existing `sourcesNeedingPreflight`/`prepareExportMedia`/`waitForProxies` tests unaffected.

- [ ] **Step 5: Broaden the import sweep + guard the route-correction**

In `App.tsx`, the import-sweep effect (~lines 520-555): change the candidate source and guard the failure branch so it only route-corrects DirectExport sources (a full-proxy source that fails the probe already has the right route — it just gets no bridge).

Replace the import in the `exportReadiness` import block — add `sourcesNeedingPreviewProbe` alongside `sourcesNeedingPreflight`.

Change the candidate line:

```ts
      const candidates = sourcesNeedingPreviewProbe(pool).filter(
```

(was `sourcesNeedingPreflight(pool).filter(`).

Replace the failure branch (the `else { memo.delete(...); routeCorrected...; await ensureFullProxy(...) }` block) with:

```ts
        } else {
          memo.delete(m.id);
          // Only DirectExport sources need route-correction (they were
          // pointing export at an original this machine can't decode). A
          // full-proxy source that fails the probe already routes correctly;
          // it just gets no bridge — preview waits for its proxy as before.
          if (m.export_uses_original) {
            routeCorrected.current.add(m.id);
            try {
              await ensureFullProxy(m.id);
            } catch (e) {
              console.error("[weftcut] route-correct failed for", m.id, e);
            }
          }
        }
```

- [ ] **Step 6: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS for the touched pure modules; no new failures (the broken `*.browser.test.ts` suite is excluded by the `test` script).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/exportReadiness.ts apps/desktop/src/render/exportReadiness.test.ts apps/desktop/src/App.tsx
git commit -m "feat(preview): probe would-be-blank sources for the bridge; guard route-correction to DirectExport"
```

---

## Task 3: Thread the verdict into the preview resolver + re-resolve on flip

**Files:**
- Modify: `apps/desktop/src/render/PixiPreview.tsx:107-111` (+ the handle)
- Modify: `apps/desktop/src/preview/PreviewSurface.tsx`
- Modify: `apps/desktop/src/App.tsx` (render `<PreviewSurface>` + sweep nudge)

This wiring is exercised by `tauri:dev` smoke (the headless render suite is broken); the steps below are the exact edits. No new unit test — the logic under test (`previewPlaybackPathFor`) is covered in Task 1.

- [ ] **Step 1: `PixiPreview` resolver consults `previewDecodableOf`**

In `PixiPreview.tsx`, add `previewDecodableOf?: (mediaId: string) => boolean;` to the component's props interface (next to `onTimeUpdate`/`onPausedChange`). Then replace the `proxyAssetUrl` resolver (lines 107-111) with:

```ts
      const proxyAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        // Bridge flag is session-scoped (App's decodeProbeMemo via the prop);
        // read live each call so a mid-session probe flip takes effect on the
        // next ensureClip.
        const previewDecodable = previewDecodableOf?.(mediaId) ?? false;
        const path = previewPlaybackPathFor(m, { previewDecodable });
        return path ? convertFileSrc(path) : null;
      };
```

- [ ] **Step 2: Add a `refreshSources()` handle to `PixiPreview`**

`PixiPreview` already does a manual re-kick (the `setProject` + `setAnchorTime` + `compositeFrame` sequence around lines 276-278). Expose it on the handle so App can nudge a re-resolve when a paused clip's verdict flips. Add to `PixiPreviewHandle` (in `pixiPreviewFlag.ts`) a `refreshSources(): void;` member, and in `PixiPreview`'s `useImperativeHandle` add:

```ts
        refreshSources() {
          const compositor = compositorRef.current;
          const engine = engineRef.current;
          if (!compositor) return;
          const t = engine?.positionUs() ?? 0;
          compositor.setProject(useProjectStore.getState().summary);
          compositor.setAnchorTime(t);
          compositor.compositeFrame(t);
        },
```

(Mirror the existing re-kick — `ensureClip` re-runs and now resolves to the original for the freshly-decodable source.)

- [ ] **Step 3: `PreviewSurface` forwards the prop + the handle**

In `PreviewSurface.tsx`: add `previewDecodableOf?: (mediaId: string) => boolean;` to `Props`; add `refreshSources(): void;` to `PreviewSurfaceHandle`; in the `useImperativeHandle` body add `refreshSources() { pixiRef.current?.refreshSources(); }`; and pass the prop through to `<PixiPreview ... previewDecodableOf={previewDecodableOf} />`.

- [ ] **Step 4: App passes the memo accessor + nudges on flip**

In `App.tsx`, on the `<PreviewSurface>` element, add:

```tsx
            previewDecodableOf={(id) => decodeProbeMemo.current.get(id) === "ok"}
```

And in the import-sweep effect, in the **success** branch (right after `memo.set(m.id, "ok")`), nudge the preview so a paused, currently-blank clip of this source picks up the original immediately:

```ts
          memo.set(m.id, "ok");
          // A paused clip already on the timeline won't re-run ensureClip on
          // its own; nudge the compositor to re-resolve now that the bridge is
          // live for this source.
          previewRef.current?.refreshSources();
```

- [ ] **Step 5: Smoke (`tauri:dev`)**

Run the app (`npm run tauri dev` from `apps/desktop`). Import an 8-bit HEVC clip, drop it on the timeline: preview shows the frame **immediately** (no blank wait). Import a Hi10P MKV: preview shows it (software decode). Confirm a plain unsupported file (e.g. ProRes) still shows blank until its proxy.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/render/PixiPreview.tsx apps/desktop/src/render/pixiPreviewFlag.ts apps/desktop/src/preview/PreviewSurface.tsx apps/desktop/src/App.tsx
git commit -m "feat(preview): thread decodability verdict into the preview resolver + re-resolve on flip"
```

---

## Task 4: Notification — "previewable now, optimizing" vs "transcoding"

**Files:**
- Modify: `apps/desktop/src/panels/importOptimize.ts`
- Test: `apps/desktop/src/panels/importOptimize.test.ts`
- Modify: `apps/desktop/src/panels/ImportProxyDialog.tsx`

A decodable source is previewable NOW via the bridge while its proxy builds — it should read reassuringly ("可即时预览·后台优化"), not "需优化". An undecodable source stays "暂不可用·转码中". A no-proxy bypass (H.264) stays silent.

- [ ] **Step 1: Update the failing classifier/reason tests**

In `importOptimize.test.ts`, replace the `importOptimizeStatus` truth-table cases with (and add a `bridged` reason case):

```ts
  // memo "ok" = this machine decoded it → previewable now via the bridge.
  it("classifies a decodable source (memo ok) as bridged", () => {
    expect(
      importOptimizeStatus(video({ export_uses_original: true }), {
        memo: new Map([["m", "ok"]]),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }),
    ).toBe("bridged");
  });

  it("classifies a decodable 10-bit full-proxy source as bridged", () => {
    expect(
      importOptimizeStatus(video({ pix_fmt: "yuv420p10le" }), {
        memo: new Map([["m", "ok"]]),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }),
    ).toBe("bridged");
  });

  it("classifies an undecodable, proxy-building source as transcoding", () => {
    expect(
      importOptimizeStatus(video({ export_uses_original: false }), {
        memo: new Map(),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }),
    ).toBe("transcoding");
  });

  it("keeps a DirectExport source checking while its probe is in flight", () => {
    expect(
      importOptimizeStatus(video({ export_uses_original: true }), {
        memo: new Map([["m", "pending"]]),
        proxyStateOf: () => undefined,
        routeCorrected: new Set(),
      }),
    ).toBe("checking");
  });

  it("keeps bypass silent and a finished proxy ready", () => {
    const deps = { memo: new Map(), proxyStateOf: () => undefined, routeCorrected: new Set() };
    expect(importOptimizeStatus(video({ proxy_bypassed: true }), deps)).toBe("direct");
    expect(importOptimizeStatus(video({ proxy_path: "/p.mp4" }), deps)).toBe("ready");
  });

  it("gives a reassuring reason for a bridged clip", () => {
    expect(
      optimizeReason(video({ export_uses_original: true }), {
        memo: new Map([["m", "ok"]]),
        proxyStateOf: () => "pending",
        routeCorrected: new Set(),
      }).key,
    ).toBe("reason_bridged");
  });
```

(The `video()` helper in this test file sets `id: "m"`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- importOptimize`
Expected: FAIL — `OptimizeStatus` has no `bridged`/`transcoding`; `optimizeReason` has no `reason_bridged`.

- [ ] **Step 3: Rewrite `importOptimizeStatus`, `OptimizeStatus`, `optimizeReason`, `partitionImportItems`**

In `importOptimize.ts`:

Replace the `OptimizeStatus` type:

```ts
export type OptimizeStatus =
  | "ready" // export proxy already on disk
  | "direct" // exports without a proxy (H.264 bypass); not shown
  | "checking" // probe in flight, or routing not yet decided
  | "bridged" // decodable here → previewable NOW; a proxy builds in the background
  | "transcoding" // NOT decodable here → blank until the proxy lands
  | "failed"; // the proxy job failed
```

Replace `importOptimizeStatus`:

```ts
export function importOptimizeStatus(m: MediaSummary, deps: OptimizeDeps): OptimizeStatus {
  if (m.kind !== "Video") return "direct";
  if (m.proxy_path) return "ready";
  if (m.proxy_bypassed) return "direct";
  const decodable = deps.memo.get(m.id) === "ok";
  const ps = deps.proxyStateOf(m.id);
  if (ps === "failed") return "failed";
  // This machine decoded it → the bridge previews the original now; whatever
  // proxy is building is a background scroll/export upgrade.
  if (decodable) return "bridged";
  // DirectExport whose probe hasn't resolved yet.
  if (m.export_uses_original) return "checking";
  // Confirmed undecodable here (or route-corrected); blank until the proxy.
  if (ps === "pending") return "transcoding";
  return "checking"; // pre-decision window — resolves shortly
}
```

Add `reason_bridged` to the `OptimizeReason` key union and update `optimizeReason` to return it for bridged clips:

```ts
export interface OptimizeReason {
  key: "reason_bridged" | "reason_undecodable" | "reason_transcode" | "reason_10bit";
  codec: string;
}

/// Why this clip appears, given its classification. A bridged clip is already
/// previewable; everything else is waiting on a proxy.
export function optimizeReason(m: MediaSummary, deps: OptimizeDeps): OptimizeReason {
  const codec = codecDisplayName(m.codec);
  if (deps.memo.get(m.id) === "ok") return { key: "reason_bridged", codec };
  if (deps.routeCorrected.has(m.id)) return { key: "reason_undecodable", codec };
  if (is10bit(m.pix_fmt)) return { key: "reason_10bit", codec };
  return { key: "reason_transcode", codec };
}
```

Update `partitionImportItems` to list `bridged` too:

```ts
export function partitionImportItems(items: ImportItem[]): Partitioned {
  const listed = items.filter(
    (i) => i.status === "bridged" || i.status === "transcoding" || i.status === "failed",
  );
  const checkingCount = items.filter((i) => i.status === "checking").length;
  return { listed, checkingCount, hasAttention: listed.length > 0 || checkingCount > 0 };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- importOptimize`
Expected: PASS — all the rewritten classifier/reason/partition cases pass.

- [ ] **Step 5: Render the `bridged` row in the dialog**

In `ImportProxyDialog.tsx`, the list renders `listed` items with a label + `reason`. Ensure a `bridged` item renders with its reassuring reason (it flows through `optimizeReason → "reason_bridged"`), and is NOT styled as an error (only `failed` is red). If the dialog currently hard-codes a single heading ("导出优化中"), change the per-item line to render the i18n reason for the item's key (added in Task 5) so `bridged` reads "可即时预览·后台优化" while `transcoding` reads its codec reason. No new logic — just route each item's `reason.key` through `t()`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/panels/importOptimize.ts apps/desktop/src/panels/importOptimize.test.ts apps/desktop/src/panels/ImportProxyDialog.tsx
git commit -m "feat(import): notify 'previewable now, optimizing' vs 'transcoding'"
```

---

## Task 5: i18n strings

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add the new `import_proxy.*` keys**

In both locale files, under the existing `import_proxy` block, add `reason_bridged` and a heading that fits "previewable now." zh-CN:

```ts
    reason_bridged: "{{codec}} · 可即时预览,后台优化滚动",
```

en-US:

```ts
    reason_bridged: "{{codec}} · usable now, optimizing scroll in background",
```

Keep the existing `reason_undecodable` / `reason_transcode` / `reason_10bit` (now used only for the `transcoding`/route-corrected items). If the dialog title is import-batch-wide, leave it; the per-row reason now carries the distinction.

- [ ] **Step 2: Verify the keys resolve (smoke)**

Run `tauri:dev`, import a decodable HEVC and a ProRes together: the HEVC row reads "HEVC · 可即时预览…", the ProRes row reads "ProRes · 需转码". No raw `import_proxy.reason_bridged` key text leaks (would mean a missing translation).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n(import): add reason_bridged string (en-US + zh-CN)"
```

---

## Self-Review

**Spec coverage (§C, §F):**
- Preview returns original until a proxy lands, gated by a session signal → Task 1 (`previewDecodable` arg) + Task 3 (wired from `decodeProbeMemo`). ✅
- Session-scoped, not persisted → the flag is `decodeProbeMemo.current.get(id) === "ok"`, an App ref; no `MediaItem`/`MediaSummary` field added. ✅
- Bridge covers all decodable incl 10-bit/Hi10P → Task 2 broadens the probe set to full-proxy sources; Task 1 10-bit test. ✅
- Three-state notification (bridged / transcoding / silent bypass) → Task 4. ✅
- Reactivity (paused blank clip picks up on verdict) → Task 3 `refreshSources()` nudge. ✅
- No Rust / no schema change → all files are `apps/desktop/src/**`. ✅

**Placeholder scan:** Every code step shows full code; exact files/lines (`projectStore.ts:146-159`, `PixiPreview.tsx:107-111`, sweep ~520-555). Task 3 Step 2/5 (`refreshSources` handle, `tauri:dev` smoke) name the exact existing re-kick to mirror + the smoke procedure rather than inventing untested wiring — acceptable because the render path can't run headless ([[weftcut-toolchain-baseline-red]]). ✅

**Type consistency:** `previewPlaybackPathFor(media, opts?)` 2nd arg used identically in Task 1 (def + tests) and Task 3 Step 1 (caller). `previewDecodableOf: (mediaId: string) => boolean` consistent across App (Task 3 Step 4), `PreviewSurface` Props (Step 3), and `PixiPreview` props (Step 1). `refreshSources()` consistent across `PixiPreviewHandle` / `PreviewSurfaceHandle` (Steps 2-3) and the App call (Step 4). `OptimizeStatus` `bridged`/`transcoding` consistent across the type, `importOptimizeStatus`, `partitionImportItems`, and the tests (Task 4). `reason_bridged` consistent across `OptimizeReason`, `optimizeReason`, the test, and both locale files (Tasks 4-5). ✅

---

## Notes for the executor

- Plan 2 ships the **bridge** (instant preview). For a **long-GOP** decodable source, scrub stays original-quality (and may stutter, per spec §3) until its quick proxy lands; the no-flash original→proxy upgrade is **Plan 3 (overlap-swap)**. Within Plan 2, once the quick proxy lands the resolver returns it, but a clip already bound to the original is only re-acquired on idle-dispose or a `refreshSources()` nudge — acceptable; Plan 3 makes the swap seamless.
- **Narrow-proxy (Plan 1) is NOT a dependency** — every decodable source here still gets its normal proxy in the background; the bridge just covers the wait.
