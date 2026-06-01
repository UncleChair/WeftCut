# Import Proxy Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At import, pop a non-blocking dialog listing which just-imported clips will be optimized for export (with codec-named reasons), updating live as the background decodability probe settles.

**Architecture:** A pure per-clip classifier + reason helpers (webview) drive a presentational `<aside>` dialog. App wires it: the import sweep records route-corrected ids, `importQueue` Completed entries form the dialog batch, and App classifies the batch live (re-running on store/proxyState/sweep changes) and auto-closes when nothing needs optimizing. One small Rust change exposes `codec`/`pix_fmt` on `MediaSummary`.

**Tech Stack:** Rust (Tauri command serialization), TypeScript/React (Zustand store, i18next), vitest.

Spec: `docs/superpowers/specs/2026-06-01-import-proxy-notification-design.md`

## File Structure

- **Modify** `apps/desktop/src-tauri/src/commands.rs` — add `codec`/`pix_fmt` to the `MediaSummary` struct + its build site.
- **Modify** `apps/desktop/src/ipc/index.ts` — add `codec`/`pix_fmt` to the TS `MediaSummary` interface.
- **Create** `apps/desktop/src/panels/importOptimize.ts` — pure: `importOptimizeStatus`, `codecDisplayName`, `is10bit`, `optimizeReason`.
- **Create** `apps/desktop/src/panels/importOptimize.test.ts` — unit tests.
- **Create** `apps/desktop/src/panels/ImportProxyDialog.tsx` — presentational `<aside>` dialog.
- **Modify** `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts` — `import_proxy.*` keys.
- **Modify** `apps/desktop/src/App.tsx` — `routeCorrected` ref + sweep records + `sweepTick`; `importQueue` trigger; classify batch + mount dialog + auto-close.

**Test commands**
- TS unit: from repo root, `npm --prefix apps/desktop run test -- <relative path>`.
- TS typecheck (baseline is red — diff per file): `npm --prefix apps/desktop exec tsc -- -b apps/desktop/tsconfig.json --force` then grep your files; assert no NEW errors.
- Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`.

---

## Task 1: Expose `codec` + `pix_fmt` on `MediaSummary`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (struct ~232-241; build site ~390-404)
- Modify: `apps/desktop/src/ipc/index.ts:42-49`

- [ ] **Step 1: Add the Rust struct fields.** In `commands.rs`, after the `export_uses_original` field of the `MediaSummary` struct (line ~240):

```rust
    pub export_uses_original: bool,
    /// Source video codec (e.g. "h264", "hevc", "prores"), `None` for
    /// audio/image. Raw passthrough from `metadata.video` — display-only.
    pub codec: Option<String>,
    /// Source pixel format (e.g. "yuv420p", "yuv420p10le"), `None` for
    /// audio/image. Raw passthrough — display-only.
    pub pix_fmt: Option<String>,
```

- [ ] **Step 2: Populate them at the build site.** In the `MediaSummary { … }` literal (~line 402), after `export_uses_original: m.export_uses_original,`:

```rust
                export_uses_original: m.export_uses_original,
                codec: m.metadata.video.as_ref().map(|v| v.codec.clone()),
                pix_fmt: m.metadata.video.as_ref().map(|v| v.pix_fmt.clone()),
```

- [ ] **Step 3: Build to verify it compiles.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml route_correction_clears_export_uses_original`
Expected: compiles (the filter just forces a build); PASS.

- [ ] **Step 4: Add the TS interface fields.** In `ipc/index.ts`, after `export_uses_original: boolean;` (line 49):

```ts
  export_uses_original: boolean;
  /// Source video codec ("h264"/"hevc"/"prores"/…), null for audio/image.
  codec: string | null;
  /// Source pixel format ("yuv420p"/"yuv420p10le"/…), null for audio/image.
  pix_fmt: string | null;
```

- [ ] **Step 5: Typecheck — find the `MediaSummary` literal sites that now need the fields.** The fields are required, so any non-test code building a `MediaSummary` object literal will error until updated.

Run: `npm --prefix apps/desktop exec tsc -- -b apps/desktop/tsconfig.json --force 2>&1 | grep -iE "codec|pix_fmt|missing the following properties"`
Expected: new errors only at object-literal construction sites. The known one is `exportWorker.ts`'s synthetic `MediaSummary`. Test mocks use `as any`/`as unknown` and are unaffected.

- [ ] **Step 6: Add the two fields to every flagged literal.** The known site is `exportWorker.ts`'s `mediaById` shim (~line 110):

```ts
        proxy_bypassed: false,
        export_uses_original: false,
        codec: null,
        pix_fmt: null,
      };
```

Apply the same two lines to any other site the typecheck flagged. Re-run:
`npm --prefix apps/desktop exec tsc -- -b apps/desktop/tsconfig.json --force 2>&1 | grep -iE "codec|pix_fmt"` → no output. Total error count is back to the baseline (31).

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src-tauri/src/commands.rs apps/desktop/src/ipc/index.ts apps/desktop/src/render/worker/exportWorker.ts
git commit -m "feat(media): expose codec + pix_fmt on MediaSummary (display-only passthrough)"
```

---

## Task 2: Pure classifier + reason helpers

**Files:**
- Create: `apps/desktop/src/panels/importOptimize.ts`
- Create: `apps/desktop/src/panels/importOptimize.test.ts`

- [ ] **Step 1: Write the failing tests** (`importOptimize.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import {
  importOptimizeStatus,
  codecDisplayName,
  is10bit,
  optimizeReason,
  partitionImportItems,
  type OptimizeDeps,
  type ImportItem,
} from "./importOptimize";

const vid = (over: Record<string, unknown>) => ({
  id: "m", label: "clip", kind: "Video", path: "/o.mov",
  duration_us: 1, width: 1920, height: 1080, size_bytes: 1, available: true,
  proxy_path: null, quick_proxy_path: null,
  proxy_bypassed: false, export_uses_original: false,
  codec: "hevc", pix_fmt: "yuv420p",
  ...over,
} as unknown);

const deps = (over: Partial<OptimizeDeps> = {}): OptimizeDeps => ({
  memo: new Map(),
  proxyStateOf: () => undefined,
  routeCorrected: new Set(),
  ...over,
});

describe("importOptimizeStatus", () => {
  it("ready when proxy_path set", () => {
    expect(importOptimizeStatus(vid({ proxy_path: "/p.mp4" }) as any, deps())).toBe("ready");
  });
  it("direct when proxy_bypassed", () => {
    expect(importOptimizeStatus(vid({ proxy_bypassed: true }) as any, deps())).toBe("direct");
  });
  it("direct when DirectExport probed ok", () => {
    const d = deps({ memo: new Map([["m", "ok"]]) });
    expect(importOptimizeStatus(vid({ export_uses_original: true }) as any, d)).toBe("direct");
  });
  it("checking when DirectExport not yet probed", () => {
    expect(importOptimizeStatus(vid({ export_uses_original: true }) as any, deps())).toBe("checking");
  });
  it("checking in the pre-decision window (no routing, no proxyState)", () => {
    expect(importOptimizeStatus(vid({}) as any, deps())).toBe("checking");
  });
  it("optimizing when a proxy job is pending", () => {
    const d = deps({ proxyStateOf: () => "pending" });
    expect(importOptimizeStatus(vid({}) as any, d)).toBe("optimizing");
  });
  it("failed when the proxy job failed", () => {
    const d = deps({ proxyStateOf: () => "failed" });
    expect(importOptimizeStatus(vid({}) as any, d)).toBe("failed");
  });
  it("direct for non-video media", () => {
    expect(importOptimizeStatus(vid({ kind: "Audio" }) as any, deps())).toBe("direct");
  });
});

describe("codecDisplayName", () => {
  it("maps known codecs", () => {
    expect(codecDisplayName("hevc")).toBe("HEVC");
    expect(codecDisplayName("h264")).toBe("H.264");
    expect(codecDisplayName("av01")).toBe("AV1");
    expect(codecDisplayName("vp09")).toBe("VP9");
    expect(codecDisplayName("prores")).toBe("ProRes");
    expect(codecDisplayName("mpeg2video")).toBe("MPEG-2");
  });
  it("uppercases unknown, handles null", () => {
    expect(codecDisplayName("dnxhd")).toBe("DNXHD");
    expect(codecDisplayName(null)).toBe("未知");
  });
});

describe("is10bit", () => {
  it("true for 10/12-bit pixfmts, false otherwise", () => {
    expect(is10bit("yuv420p10le")).toBe(true);
    expect(is10bit("yuv422p12le")).toBe(true);
    expect(is10bit("yuv420p")).toBe(false);
    expect(is10bit(null)).toBe(false);
  });
});

describe("optimizeReason", () => {
  it("undecodable for route-corrected ids", () => {
    const d = deps({ routeCorrected: new Set(["m"]) });
    expect(optimizeReason(vid({ codec: "hevc" }) as any, d)).toEqual({ key: "reason_undecodable", codec: "HEVC" });
  });
  it("10bit for static 10-bit sources", () => {
    expect(optimizeReason(vid({ codec: "hevc", pix_fmt: "yuv420p10le" }) as any, deps()))
      .toEqual({ key: "reason_10bit", codec: "HEVC" });
  });
  it("transcode for static 8-bit non-family sources", () => {
    expect(optimizeReason(vid({ codec: "prores", pix_fmt: "yuv422p" }) as any, deps()))
      .toEqual({ key: "reason_transcode", codec: "ProRes" });
  });
});

describe("partitionImportItems", () => {
  const item = (over: Partial<ImportItem>): ImportItem => ({
    id: "m", label: "clip", status: "optimizing",
    reason: { key: "reason_transcode", codec: "ProRes" }, ...over,
  });
  it("lists optimizing + failed, counts checking, drops direct/ready", () => {
    const r = partitionImportItems([
      item({ id: "a", status: "optimizing" }),
      item({ id: "b", status: "failed" }),
      item({ id: "c", status: "checking" }),
      item({ id: "d", status: "checking" }),
      item({ id: "e", status: "direct" }),
      item({ id: "f", status: "ready" }),
    ]);
    expect(r.listed.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r.checkingCount).toBe(2);
    expect(r.hasAttention).toBe(true);
  });
  it("hasAttention false when nothing optimizing/failed/checking", () => {
    const r = partitionImportItems([item({ id: "e", status: "direct" })]);
    expect(r.listed).toEqual([]);
    expect(r.checkingCount).toBe(0);
    expect(r.hasAttention).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm --prefix apps/desktop run test -- src/panels/importOptimize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module** (`importOptimize.ts`):

```ts
// Per-clip "will this need optimizing before export?" classification + the
// codec-named reason shown in the import notification dialog. Pure; the dialog
// (ImportProxyDialog) is presentational and App does the classification.
//
// See docs/superpowers/specs/2026-06-01-import-proxy-notification-design.md

import type { MediaSummary } from "../ipc";
import type { ProbeState, ProxyJobState } from "../render/exportReadiness";

export type OptimizeStatus =
  | "ready" // export proxy already on disk
  | "direct" // exports without a proxy (bypass or confirmed DirectExport); not shown
  | "checking" // probe in flight, or routing not yet decided
  | "optimizing" // a full proxy is being generated
  | "failed"; // the proxy job failed

export interface OptimizeDeps {
  /// Session decodability memo (App `decodeProbeMemo`).
  memo: ReadonlyMap<string, ProbeState>;
  /// Session proxy-job state (App `proxyState`).
  proxyStateOf: (id: string) => ProxyJobState | undefined;
  /// Ids the import sweep route-corrected because this machine can't decode them.
  routeCorrected: ReadonlySet<string>;
}

export function importOptimizeStatus(m: MediaSummary, deps: OptimizeDeps): OptimizeStatus {
  if (m.kind !== "Video") return "direct";
  if (m.proxy_path) return "ready";
  if (m.proxy_bypassed) return "direct";
  if (m.export_uses_original) {
    return deps.memo.get(m.id) === "ok" ? "direct" : "checking";
  }
  // Not bypass, not DirectExport, no proxy yet.
  const ps = deps.proxyStateOf(m.id);
  if (ps === "failed") return "failed";
  if (ps === "pending") return "optimizing";
  return "checking"; // pre-decision window — resolves shortly
}

const CODEC_NAMES: Record<string, string> = {
  h264: "H.264",
  avc1: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  hvc1: "HEVC",
  av1: "AV1",
  av01: "AV1",
  vp9: "VP9",
  vp09: "VP9",
  vp8: "VP8",
  prores: "ProRes",
  mpeg2video: "MPEG-2",
  dnxhd: "DNxHD",
};

export function codecDisplayName(codec: string | null): string {
  if (!codec) return "未知";
  const key = codec.toLowerCase();
  return CODEC_NAMES[key] ?? codec.toUpperCase();
}

export function is10bit(pixFmt: string | null): boolean {
  return pixFmt != null && /1[02]/.test(pixFmt);
}

export interface OptimizeReason {
  key: "reason_undecodable" | "reason_transcode" | "reason_10bit";
  codec: string;
}

/// Why this clip is being optimized. Route-corrected ⇒ machine can't decode an
/// 8-bit family codec (never 10-bit — 10-bit routes to a static proxy, not
/// DirectExport). Static proxies are either 10-bit/HDR or a non-family codec.
export function optimizeReason(m: MediaSummary, deps: OptimizeDeps): OptimizeReason {
  const codec = codecDisplayName(m.codec);
  if (deps.routeCorrected.has(m.id)) return { key: "reason_undecodable", codec };
  if (is10bit(m.pix_fmt)) return { key: "reason_10bit", codec };
  return { key: "reason_transcode", codec };
}

/// A classified clip for the dialog. App builds these; the dialog renders them.
export interface ImportItem {
  id: string;
  label: string;
  status: OptimizeStatus;
  reason: OptimizeReason;
}

export interface Partitioned {
  listed: ImportItem[]; // optimizing + failed (shown in the list)
  checkingCount: number; // shown as "checking N…"
  hasAttention: boolean; // gates dialog visibility + auto-close in App
}

export function partitionImportItems(items: ImportItem[]): Partitioned {
  const listed = items.filter((i) => i.status === "optimizing" || i.status === "failed");
  const checkingCount = items.filter((i) => i.status === "checking").length;
  return { listed, checkingCount, hasAttention: listed.length > 0 || checkingCount > 0 };
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `npm --prefix apps/desktop run test -- src/panels/importOptimize.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/panels/importOptimize.ts apps/desktop/src/panels/importOptimize.test.ts
git commit -m "feat(import): pure classifier + codec-named reason for the proxy notification"
```

---

## Task 3: i18n keys

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` (after the `export:` block, ~line 240)
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts` (after the `export:` block, ~line 238)

- [ ] **Step 1: Add the en-US block.** In `en-US.ts`, immediately after the closing `},` of the `export: { … }` object, add:

```ts
  import_proxy: {
    title: "Some clips need optimizing",
    optimizing_heading: "Optimizing for export",
    checking: "Checking {{n}} clip(s)…",
    reason_undecodable: "{{codec}} · can't be decoded on this machine",
    reason_transcode: "{{codec}} · needs transcoding",
    reason_10bit: "{{codec}} 10-bit/HDR · needs optimizing",
    failed: "Preparation failed — re-import to retry",
    editable_note: "You can edit now; export will wait automatically.",
    dismiss: "Got it",
  },
```

- [ ] **Step 2: Add the zh-CN block.** In `zh-CN.ts`, immediately after the closing `},` of the `export: { … }` object, add:

```ts
  import_proxy: {
    title: "部分素材需要优化",
    optimizing_heading: "导出优化中",
    checking: "正在检测 {{n}} 个素材…",
    reason_undecodable: "{{codec}} · 本机无法直接解码",
    reason_transcode: "{{codec}} · 需转码",
    reason_10bit: "{{codec}} 10-bit/HDR · 需优化",
    failed: "准备失败,请重新导入",
    editable_note: "仍可立即编辑;导出会自动等待。",
    dismiss: "知道了",
  },
```

- [ ] **Step 3: Typecheck (i18n resource shape must match between locales).**

Run: `npm --prefix apps/desktop exec tsc -- -b apps/desktop/tsconfig.json --force 2>&1 | grep -E "en-US|zh-CN"`
Expected: no output (no locale errors). If the project derives a resource type from en-US, zh-CN must carry the identical keys — it does.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "i18n(import): import_proxy notification strings (en + zh)"
```

---

## Task 4: `ImportProxyDialog` presentational component

**Files:**
- Create: `apps/desktop/src/panels/ImportProxyDialog.tsx`

No unit test: this is a presentational component with no logic of its own
(partitioning lives in `importOptimize.ts`, tested in Task 2). It's verified by
the `tauri:dev` smoke in Task 6. (Component-render tests would need a jsdom +
@testing-library setup the project's node test suite doesn't have.)

- [ ] **Step 1: Create the component** (`ImportProxyDialog.tsx`):

```tsx
import { useTranslation } from "react-i18next";
import { partitionImportItems, type ImportItem } from "./importOptimize";

export function ImportProxyDialog({
  items,
  onDismiss,
}: {
  items: ImportItem[];
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { listed, checkingCount } = partitionImportItems(items);

  return (
    <aside className="export-panel import-proxy-dialog">
      <header>
        <span>{t("import_proxy.title")}</span>
        <button onClick={onDismiss}>{t("import_proxy.dismiss")}</button>
      </header>
      {listed.length > 0 && (
        <>
          <p className="import-proxy-heading">{t("import_proxy.optimizing_heading")}</p>
          <ul className="import-proxy-list">
            {listed.map((i) => (
              <li key={i.id} className={i.status === "failed" ? "is-failed" : ""}>
                <span className="import-proxy-clip">{i.label}</span>
                <span className="import-proxy-reason">
                  {i.status === "failed"
                    ? t("import_proxy.failed")
                    : t(`import_proxy.${i.reason.key}`, { codec: i.reason.codec })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {checkingCount > 0 && (
        <p className="import-proxy-checking">
          {t("import_proxy.checking", { n: checkingCount })}
        </p>
      )}
      <p className="import-proxy-note">{t("import_proxy.editable_note")}</p>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck the component (no new errors).**

Run: `npm --prefix apps/desktop exec tsc -- -b apps/desktop/tsconfig.json --force 2>&1 | grep -E "ImportProxyDialog"`
Expected: no output. (`partitionImportItems`/`ImportItem` resolve from `./importOptimize`; `useTranslation` from react-i18next is already used elsewhere.)

- [ ] **Step 3: Commit.**

```bash
git add apps/desktop/src/panels/ImportProxyDialog.tsx
git commit -m "feat(import): ImportProxyDialog presentational component"
```

---

## Task 5: App wiring — sweep records, trigger, live classify, mount, auto-close

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Add imports** (next to the existing `./render/exportReadiness` import and `./panels/mediaReadiness`):

```tsx
import {
  importOptimizeStatus,
  optimizeReason,
  type OptimizeDeps,
  type ImportItem,
} from "./panels/importOptimize";
import { ImportProxyDialog } from "./panels/ImportProxyDialog";
```

- [ ] **Step 2: Add the refs + state.** After the `proxyStateRef` block (added by the prior feature, near `decodeProbeMemo`):

```tsx
  // Ids the sweep route-corrected (machine can't decode) — drives the dialog's
  // "本机无法直接解码" reason vs the static "格式/10-bit" reasons.
  const routeCorrected = useRef<Set<string>>(new Set());
  // Bumped whenever the sweep mutates decodeProbeMemo/routeCorrected (refs, so
  // they don't re-render on their own) to force the dialog to reclassify.
  const [sweepTick, setSweepTick] = useState(0);
  // Completed import media_ids already routed into a dialog batch (session).
  const notifiedImportIds = useRef<Set<string>>(new Set());
  // The current dialog batch (media_ids); empty = closed.
  const [dialogBatch, setDialogBatch] = useState<string[]>([]);
```

- [ ] **Step 3: Make the sweep record route-corrected ids + bump the tick.** In the import sweep effect (added by the prior feature), update the success/failure branches:

```tsx
        if (ok) {
          memo.set(m.id, "ok");
        } else {
          memo.delete(m.id);
          routeCorrected.current.add(m.id);
          try {
            await ensureFullProxy(m.id);
          } catch (e) {
            console.error("[weftcut] route-correct failed for", m.id, e);
          }
        }
        setSweepTick((x) => x + 1);
```

(The `setSweepTick` runs after each probe resolves — including the `ok` branch — so a clip leaving "checking" for "direct" reclassifies even when no store event fires.)

- [ ] **Step 4: Add the import trigger effect.** After the sweep effect:

```tsx
  // Open/extend the import-proxy dialog batch when an import batch completes.
  // Add ALL completed ids (audio/direct included); the classifier filters them
  // out, so non-attention imports never render the dialog.
  useEffect(() => {
    const completed = importQueue.filter((e) => e.status.kind === "Completed");
    const fresh = completed
      .map((e) => e.media_id)
      .filter((id) => !notifiedImportIds.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) notifiedImportIds.current.add(id);
    setDialogBatch((prev) => [...new Set([...prev, ...fresh])]);
  }, [importQueue]);
```

- [ ] **Step 5: Classify the batch + auto-close.** After the trigger effect:

```tsx
  // Deps recreated each render; they read `.current` refs so they're always
  // live. `sweepTick` is what forces re-eval when only a ref changed.
  const dialogDeps: OptimizeDeps = {
    memo: decodeProbeMemo.current,
    proxyStateOf: (id) => proxyStateRef.current.get(id),
    routeCorrected: routeCorrected.current,
  };

  // Live classification of the dialog batch.
  const dialogItems: ImportItem[] = useMemo(() => {
    const store = useProjectStore.getState();
    return dialogBatch
      .map((id) => store.mediaById.get(id))
      .filter((m): m is MediaSummary => !!m)
      .map((m) => ({
        id: m.id,
        label: m.label,
        status: importOptimizeStatus(m, dialogDeps),
        reason: optimizeReason(m, dialogDeps),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogBatch, summary, proxyState, sweepTick]);

  const dialogHasAttention = dialogItems.some(
    (i) => i.status === "optimizing" || i.status === "failed" || i.status === "checking",
  );

  // Auto-close ONLY once every batch member is loaded in the store AND resolved
  // to direct/ready. Never clears while a member is still absent (the import
  // Completed event can beat the store update) or still needs attention — that
  // would close the dialog before the clips even appear.
  useEffect(() => {
    if (dialogBatch.length === 0) return;
    const store = useProjectStore.getState();
    const allSettledDirect = dialogBatch.every((id) => {
      const m = store.mediaById.get(id);
      if (!m) return false;
      const s = importOptimizeStatus(m, dialogDeps);
      return s === "direct" || s === "ready";
    });
    if (allSettledDirect) setDialogBatch([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogBatch, summary, proxyState, sweepTick]);
```

- [ ] **Step 6: Mount the dialog.** Next to the `{exportState && (<ExportPanel … />)}` render (App.tsx ~line 1150):

```tsx
      {dialogHasAttention && (
        <ImportProxyDialog
          items={dialogItems}
          onDismiss={() => setDialogBatch([])}
        />
      )}
```

- [ ] **Step 7: Typecheck — assert no NEW errors vs the App.tsx baseline (1: unused `error`).**

Run: `npm --prefix apps/desktop exec tsc -- -b apps/desktop/tsconfig.json --force 2>&1 | grep -E "App\.tsx\("`
Expected: only `App.tsx(NNN,10): error TS6133: 'error' is declared but its value is never read.` (the pre-existing one). No new App.tsx errors. Confirm `MediaSummary`, `useMemo`, `useProjectStore`, `decodeProbeMemo`, `proxyStateRef` are all in scope (added by the prior feature / existing imports).

- [ ] **Step 8: Run the full unit suite (nothing regressed).**

Run: `npm --prefix apps/desktop test 2>&1 | tail -4`
Expected: all test files pass (prior 187 + the new importOptimize/ImportProxyDialog tests).

- [ ] **Step 9: Commit.**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(import): wire live proxy-notification dialog (sweep records, trigger, classify, auto-close)"
```

---

## Task 6: Manual smoke verification (`tauri:dev`)

**Files:** none. Behavior verification — the live dialog wiring has no automated coverage (the fixture/browser suite can't run headless; typecheck + prod build are red at baseline).

- [ ] **Step 1: Launch.** `npm --prefix apps/desktop run tauri:dev` (your own terminal).

- [ ] **Step 2: Static-proxy clip.** Import a ProRes (or MPEG-2) clip.
Expected: dialog pops, lists it under "导出优化中" as **"ProRes · 需转码"**, stays open; the clip becomes editable in the pool meanwhile.

- [ ] **Step 3: 10-bit clip.** Import a 10-bit HEVC clip.
Expected: listed as **"HEVC 10-bit/HDR · 需优化"**.

- [ ] **Step 4: Simulated-incapable.** Temporarily add `return false;` at the top of `probeSourceDecodable` (`render/decoder/probeSourceDecodable.ts`); import an 8-bit HEVC clip.
Expected: dialog shows **"正在检测 1 个素材…"** briefly, then moves the clip to the list as **"HEVC · 本机无法直接解码"**. Revert the edit afterward.

- [ ] **Step 5: All-direct import (no flash lingering).** Import a plain 8-bit H.264 clip (and/or an audio file).
Expected: dialog either doesn't appear or shows "checking" for a beat then **auto-closes** (H.264 resolves to bypass/DirectExport; audio is never attention).

- [ ] **Step 6: Dismiss + non-blocking.** During Step 2/4 while the dialog is open, confirm you can still drag clips / edit the timeline (non-blocking), and that **[知道了]** closes it; background proxies keep running.

- [ ] **Step 7: Full sweep.**

Run: `npm --prefix apps/desktop test` and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: all green.

---

## Notes for the implementer

- **Reclassification depends on `sweepTick`.** `decodeProbeMemo` and `routeCorrected` are refs (no re-render). The sweep bumps `sweepTick` after every probe so the `useMemo` re-runs — without it, a clip that probes decodable would stay stuck on "checking" in the dialog (no store event fires for a no-op decodable source).
- **Trigger adds all Completed ids, classifier filters.** Audio/H.264 ids enter the batch but never become "attention," so the dialog never renders for them (no visible flash for pure-audio imports; H.264 flashes "checking" briefly by design).
- **`routeCorrected` is session-scoped** (a ref) — a reopened project's already-corrected clips read as "format" not "machine"; cosmetic, per spec.
- **Reasons never combine route-corrected + 10-bit:** a 10-bit source is non-browser-friendly → static FullProxy, never DirectExport, so never route-corrected. `optimizeReason` checks `routeCorrected` first; the 10-bit branch only applies to static proxies.
