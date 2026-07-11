# Decode-Engine Collapse (Preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the preview decode path's flat four-tier `EngineTier` routing into two public engines (`ffmpeg`/`webcodecs`) × a source axis (`original`/`proxy`), with hardware/software hidden inside one deep `FfmpegSource` module, decoupling decode selection from the Compositor.

**Architecture:** A pure resolver (`resolveDecodeEngine`) chooses `{engine, source}` and never sees a hardware lane. `FfmpegSource` owns a `FrameRing` and a swappable `DecodeTransport` (GPU shared-texture ↔ SW NV12-over-IPC), picks HW/SW from a private capability sub-module, and on HW failure swaps to the SW transport **in place against the same ring** — no external signal, no repaint swap. Only a total FFmpeg failure surfaces one engine-level `onFatalError`. WebCodecs stays as the existing `SourceHandle`. Proxy stops being a routing tier; "unsupported" becomes a first-class, user-visible outcome.

**Tech Stack:** TypeScript, Vitest (unit), Playwright `_electron` (e2e), Electron (preload IPC + MessagePort), WebCodecs `VideoDecoder`, PixiJS v8 preview, i18next.

## Global Constraints

- **Sequencing:** This plan executes only on top of merged Phase D1–D4 (already on local main `ba1af73a`). Do not begin before confirming that commit is the merge base.
- **Preview only.** Do not touch `ExportDecoderPool`/`ExportSourceHandle` decode behavior. The only export-adjacent edit is the `rsFromExportProxy` shape change (Task 8). An export run must stay byte-identical (SSIM 1.0000).
- **Resolver stays pure.** `resolveDecodeEngine` reads no stores, runs no probes, holds no state — a pure function of its inputs (ADR 0030 Risk 4).
- **Engine names (verbatim):** setting values `"auto" | "ffmpeg" | "webcodecs"`; UI labels `Automatic (recommended)` / `Standard` (tag `ffmpeg`) / `Lite` (tag `webcodecs`).
- **i18n:** every user-facing string added/changed in BOTH `en-US.ts` and `zh-CN.ts`.
- **Twin invariant:** `classKeyOfMedia` must stay byte-identical to main's `classKeyOf`; its cross-language golden guard must still pass after the module move.
- **`FfmpegLane` is never exported** from the decode module's public surface — it is internal to `FfmpegSource` (read-only `currentLane()` for diagnostics is allowed).
- Commit after every task. Run the full unit suite (`npm run test:unit` in `apps/desktop`) green before each commit unless a step says otherwise.

---

## File structure

**New files**
- `apps/desktop/src/renderer/render/decoder/FfmpegSource.ts` — the deep module (facade over transports + capability).
- `apps/desktop/src/renderer/render/decoder/transports/DecodeTransport.ts` — the transport interface.
- `apps/desktop/src/renderer/render/decoder/transports/GpuTransport.ts` — extracted from `NativeGpuSourceHandle`.
- `apps/desktop/src/renderer/render/decoder/transports/SwTransport.ts` — extracted from `SwSourceHandle`.
- `apps/desktop/src/renderer/render/decoder/ffmpegCapability.ts` — HW/SW lane state, probes, `hwEligibleCodec`, `classKeyOfMedia`, sticky HW→SW verdict (moved out of `decodeCapability.ts`).
- `apps/desktop/src/renderer/render/decoder/FfmpegSource.test.ts`, `transports/*.test.ts` as noted per task.
- `apps/desktop/src/renderer/render/UnsupportedClipCard.tsx` — the React overlay card.

**Modified files**
- `decoder/decodeEngine.ts` — new types + `resolveDecodeEngine`; delete `EngineTier`/`orderFor`/`resolveEngineTier` (Task 9).
- `decoder/decodeCapability.ts` — keep only the WebCodecs-original memo + `noteResolution`; move the rest to `ffmpegCapability.ts`.
- `decoder/SourceDecoderPool.ts` — `SourceHandleInit` gains `engine`, drops `forceStrategy`; `acquire` branches on `engine`.
- `render/Compositor.ts` — `ResolvedRendererSource` reshape; delete the HW/SW downgrade path; `onUnsupported` callback; `rsFromExportProxy` shape.
- `render/PixiPreview.tsx` — `resolveSource` rewrite; unsupported-set tracking + card render.
- `render/decoder/decodeBench.ts` — `forceLane` instead of `forceStrategy`.
- `shared/app-settings.ts`, `main/app-settings.ts`, `main/app-settings.test.ts` — `"native"→"ffmpeg"` + migration.
- `renderer/settings/*` (the decode-engine `<select>`), `i18n/locales/{en-US,zh-CN}.ts`.
- e2e: `decode-engine.spec.ts`, `preview-gpu-order.spec.ts`, `preview-sw-conformance.spec.ts`, `preview-sw-families.spec.ts`; `testhook/e2eHook.ts`.

**Deleted files (Task 9)**
- `decoder/NativeGpuSourceHandle.ts` (+ `.test.ts`), `decoder/SwSourceHandle.ts` (+ `.test.ts`) — bodies migrated to transports.

---

## STAGE 1 — New model & resolver (additive; build stays green)

### Task 1: New types + `resolveDecodeEngine` (alongside the old resolver)

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/decodeEngine.ts` (append; do NOT delete `EngineTier`/`resolveEngineTier` yet — Task 9 removes them once consumers move)
- Test: `apps/desktop/src/renderer/render/decoder/resolveDecodeEngine.test.ts` (new)

**Interfaces:**
- Produces: the types and function below, consumed by Tasks 5, 6, 7, 8.

- [ ] **Step 1: Write the failing test**

```ts
// resolveDecodeEngine.test.ts
import { describe, expect, it } from "vitest";
import { resolveDecodeEngine, type DecodeResolveInputs } from "./decodeEngine";

function base(over: Partial<DecodeResolveInputs>): DecodeResolveInputs {
  return {
    setting: "auto",
    componentAvailable: true,
    useProxySource: false,
    proxyReady: false,
    proxyUrl: null,
    originalPath: "C:/src/a.mov",
    originalUrl: "weftcut-media://a.mov",
    webcodecsCanDecodeOriginal: "untested",
    ...over,
  };
}

describe("resolveDecodeEngine — engine selection", () => {
  it("auto with component present → ffmpeg on the original", () => {
    expect(resolveDecodeEngine(base({}))).toMatchObject({
      engine: "ffmpeg", source: "original", status: "ok", target: "C:/src/a.mov",
      key: "ffmpeg:original:C:/src/a.mov",
    });
  });
  it("auto with no component → webcodecs", () => {
    const r = resolveDecodeEngine(base({ componentAvailable: false, webcodecsCanDecodeOriginal: "ok" }));
    expect(r).toMatchObject({ engine: "webcodecs", source: "original", status: "ok", target: "weftcut-media://a.mov" });
  });
  it("setting=ffmpeg pins ffmpeg even without component check on the codec", () => {
    expect(resolveDecodeEngine(base({ setting: "ffmpeg" })).engine).toBe("ffmpeg");
  });
  it("setting=webcodecs pins webcodecs", () => {
    expect(resolveDecodeEngine(base({ setting: "webcodecs", webcodecsCanDecodeOriginal: "ok" })).engine).toBe("webcodecs");
  });
});

describe("resolveDecodeEngine — webcodecs × original verdict", () => {
  it("fail → unsupported, null target", () => {
    const r = resolveDecodeEngine(base({ setting: "webcodecs", webcodecsCanDecodeOriginal: "fail" }));
    expect(r).toMatchObject({ status: "unsupported", target: null, key: null });
  });
  it("untested → pending", () => {
    const r = resolveDecodeEngine(base({ setting: "webcodecs", webcodecsCanDecodeOriginal: "untested" }));
    expect(r).toMatchObject({ status: "pending", target: null });
  });
  it("auto+no-component+unsupported original → unsupported (NO auto-proxy)", () => {
    const r = resolveDecodeEngine(base({ componentAvailable: false, webcodecsCanDecodeOriginal: "fail", proxyReady: true, proxyUrl: "weftcut-media://p.mp4" }));
    expect(r.status).toBe("unsupported"); // proxy exists but is NOT auto-routed
  });
});

describe("resolveDecodeEngine — source axis", () => {
  it("useProxySource + proxyReady → decodes the proxy on either engine", () => {
    const r = resolveDecodeEngine(base({ useProxySource: true, proxyReady: true, proxyUrl: "weftcut-media://p.mp4" }));
    expect(r).toMatchObject({ engine: "ffmpeg", source: "proxy", status: "ok", target: "weftcut-media://p.mp4" });
  });
  it("useProxySource but proxy not built → pending", () => {
    expect(resolveDecodeEngine(base({ useProxySource: true, proxyReady: false })).status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/resolveDecodeEngine.test.ts`
Expected: FAIL — `resolveDecodeEngine is not exported`.

- [ ] **Step 3: Append the types + function to `decodeEngine.ts`**

```ts
// --- Collapsed decode model (2026-07-12). Coexists with the legacy EngineTier
// resolver until Task 9 removes the old one; both are pure. ---
export type DecodeEngine = "ffmpeg" | "webcodecs";
export type DecodeSource = "original" | "proxy";
/// PRIVATE to FfmpegSource — declared here only so the module shares one vocabulary.
/// Never surfaced in a resolver input/output.
export type FfmpegLane = "hardware" | "software";
export type WebcodecsOriginalVerdict = "ok" | "fail" | "untested";

export interface DecodeResolveInputs {
  setting: DecodeEngineSetting;
  /// FFmpeg native-decode component DLLs loaded on this machine.
  componentAvailable: boolean;
  /// User opt-in to decode the proxy instead of the original (per media). No
  /// activation path in this bite — PixiPreview passes false; the Generate-proxy
  /// follow-up wires it.
  useProxySource: boolean;
  proxyReady: boolean;
  proxyUrl: string | null;
  originalPath: string;
  originalUrl: string;
  /// Consulted ONLY on webcodecs × original. FFmpeg decodes any original.
  webcodecsCanDecodeOriginal: WebcodecsOriginalVerdict;
}

export interface DecodeResolution {
  engine: DecodeEngine;
  source: DecodeSource;
  /// File path (ffmpeg) or convertFileSrc URL (webcodecs); null = pending/unsupported.
  target: string | null;
  /// Swap identity `${engine}:${source}:${target}`; null when nothing acquirable.
  key: string | null;
  status: "ok" | "pending" | "unsupported";
  reason: string;
}

export function resolveDecodeEngine(i: DecodeResolveInputs): DecodeResolution {
  const engine: DecodeEngine =
    i.setting === "webcodecs" ? "webcodecs"
    : i.setting === "ffmpeg" ? "ffmpeg"
    : i.componentAvailable ? "ffmpeg" : "webcodecs"; // auto
  const source: DecodeSource = i.useProxySource ? "proxy" : "original";

  const done = (
    status: DecodeResolution["status"],
    target: string | null,
    reason: string,
  ): DecodeResolution => ({
    engine, source, target, status, reason,
    key: target ? `${engine}:${source}:${target}` : null,
  });

  if (source === "proxy") {
    return i.proxyReady
      ? done("ok", i.proxyUrl, `${engine} on proxy`)
      : done("pending", null, "proxy building");
  }
  // source === "original"
  if (engine === "ffmpeg") return done("ok", i.originalPath, "ffmpeg on original");
  // webcodecs × original
  switch (i.webcodecsCanDecodeOriginal) {
    case "ok": return done("ok", i.originalUrl, "webcodecs on original");
    case "fail": return done("unsupported", null, "webcodecs cannot decode this original");
    default: return done("pending", null, "webcodecs decodability untested");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/resolveDecodeEngine.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeEngine.ts apps/desktop/src/renderer/render/decoder/resolveDecodeEngine.test.ts
git commit -m "feat(decode): add collapsed resolveDecodeEngine (engine x source), coexisting with EngineTier"
```

---

## STAGE 2 — The FFmpeg deep module (new files, not yet wired)

### Task 2: `DecodeTransport` interface + `GpuTransport` extraction

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/transports/DecodeTransport.ts`
- Create: `apps/desktop/src/renderer/render/decoder/transports/GpuTransport.ts`
- Source to move FROM: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts` (keep the original file in place until Task 9 — copy, don't cut)
- Test: `apps/desktop/src/renderer/render/decoder/transports/GpuTransport.test.ts`

**Interfaces:**
- Produces `DecodeTransport` (consumed by Tasks 3, 5) and `GpuTransport` (consumed by Task 5).

- [ ] **Step 1: Write `DecodeTransport.ts`**

```ts
// The single seam between FfmpegSource and a concrete native decode transport.
// Frames arrive as ready-to-ring ImageBitmaps; the transport hides IPC shape,
// color-space derivation, and per-frame coalescing.
export interface DecodeTransportOpen {
  streamId: string;
  path: string;
  /// Source ffprobe color tags; each transport derives its own wire shape
  /// (GPU: PreviewGpuColorSpace, SW: VideoColorSpaceInit), defaulting bt709/limited.
  sourceColor?: VideoColorSpaceInit;
  /// Native GPU pool size (GPU transport only; SW ignores). Default 3.
  poolSize?: number;
}

export interface DecodeTransport {
  open(o: DecodeTransportOpen): Promise<void>;
  requestFrameAt(tUs: number): void;
  onFrame(cb: (bitmap: ImageBitmap, ptsUs: number, durUs: number) => void): void;
  /// Terminal transport failure (GPU decode error / device loss / budget reject;
  /// SW: open failure only). FfmpegSource decides whether this is recoverable.
  onError(cb: (reason: string) => void): void;
  onEof(cb: () => void): void;
  dispose(): void;
}
```

- [ ] **Step 2: Write the failing test** (behavioral contract the extraction must preserve)

```ts
// GpuTransport.test.ts — port handoff + streamId filtering, with window/api faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GpuTransport } from "./GpuTransport";

// Minimal window.api.previewGpu + MessageChannel harness.
function installFakePreviewGpu() {
  const channel = new MessageChannel();
  const api = {
    requestPort: vi.fn(() => {
      // Preload hands the port via window.postMessage with the marker.
      window.postMessage({ __weftcutPreviewGpu: "port" }, "*", [channel.port2]);
    }),
    open: vi.fn(async () => {}),
    requestFrameAt: vi.fn(async () => {}),
    close: vi.fn(() => {}),
  };
  (window as unknown as { api: { previewGpu: typeof api } }).api = { previewGpu: api };
  return { api, producer: channel.port1 };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("GpuTransport", () => {
  it("delivers frames stamped with its streamId and drops foreign ones", async () => {
    const { producer } = installFakePreviewGpu();
    const t = new GpuTransport();
    const frames: number[] = [];
    t.onFrame((_b, ptsUs) => frames.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mp4" });
    const bmp = await createImageBitmap(new ImageData(1, 1));
    producer.postMessage({ kind: "frame", streamId: "s2", slot: 0, ptsUs: 10, durUs: 33, bitmap: bmp });
    producer.postMessage({ kind: "frame", streamId: "s1", slot: 0, ptsUs: 20, durUs: 33, bitmap: await createImageBitmap(new ImageData(1, 1)) });
    await new Promise((r) => setTimeout(r, 0));
    expect(frames).toEqual([20]); // foreign s2 dropped
    t.dispose();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/transports/GpuTransport.test.ts`
Expected: FAIL — `Cannot find module './GpuTransport'`.

- [ ] **Step 4: Create `GpuTransport.ts` by extracting the transport body of `NativeGpuSourceHandle`**

Copy from `NativeGpuSourceHandle.ts` and transform:
- Move verbatim: the `PortFrameMsg`/`PortEofMsg`/`PortErrorMsg`/`PortMsg` types (lines 37-59), `nextStreamSeq` (65), `deriveColorSpace` (70-77), the port-handoff listener + `waitForPort` (200-262), `handlePortMessage` (267-306), the coalescing `pumpRequests`/`requestFrameAt` (313-333).
- **Transform the class shell**: `GpuTransport implements DecodeTransport`. Drop everything that belonged to the *handle* (the `FrameRing`, `onFirstFrame`/`firstFrame`, `onFatalError`/`fireFatal`, `isIdle`/`lastUseMs`, bench-timing arrays, `mediaId`/`layerId`, `disposed`-as-handle). Keep a private `_disposed` for the late-frame guard only.
- `streamId` becomes an arg to `open()` (not ctor-derived): `this.streamId = o.streamId`. Keep the `native-gpu:` prefixing only if a caller wants uniqueness — FfmpegSource supplies a fresh id per open (Task 5), so `open` uses `o.streamId` directly.
- `handlePortMessage`: `kind:"frame"` → `this.frameCb?.(data.bitmap, data.ptsUs, data.durUs)` (drop the ring push, first-frame, and bench-timing capture). `kind:"eof"` → `this.eofCb?.()`. `kind:"error"` → `this.errorCb?.(data.message)`.
- `open()`: attach the `window.addEventListener("message", ...)` listener, `window.api.previewGpu.requestPort()`, `await this.waitForPort()`, then `await window.api.previewGpu.open({ streamId: o.streamId, path: o.path, poolSize: o.poolSize ?? 3, colorSpace: deriveColorSpace(o.sourceColor) })`. Throw on failure (FfmpegSource catches).
- `dispose()`: remove the message listener, null the port, `window.api.previewGpu.close({ streamId })`, set `_disposed`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/transports/GpuTransport.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/transports/
git commit -m "feat(decode): extract GpuTransport from NativeGpuSourceHandle (transport seam)"
```

---

### Task 3: `SwTransport` extraction

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/transports/SwTransport.ts`
- Source to move FROM: `apps/desktop/src/renderer/render/decoder/SwSourceHandle.ts` (copy, don't cut)
- Test: `apps/desktop/src/renderer/render/decoder/transports/SwTransport.test.ts`

**Interfaces:**
- Produces `SwTransport` implementing `DecodeTransport` (consumed by Task 5).

- [ ] **Step 1: Write the failing test**

```ts
// SwTransport.test.ts — NV12 → ImageBitmap conversion + streamId filter, api faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwTransport } from "./SwTransport";

afterEach(() => vi.restoreAllMocks());

describe("SwTransport", () => {
  it("converts NV12 frames for its stream and ignores foreign ones", async () => {
    let onFrameCb: ((f: unknown) => void) | null = null;
    const api = {
      open: vi.fn(async () => {}),
      requestFrameAt: vi.fn(() => {}),
      close: vi.fn(() => {}),
      onFrame: vi.fn((cb: (f: unknown) => void) => { onFrameCb = cb; return () => {}; }),
    };
    (window as unknown as { api: { previewSw: typeof api } }).api = { previewSw: api };
    const t = new SwTransport();
    const got: number[] = [];
    t.onFrame((_b, ptsUs) => got.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    const nv12 = new Uint8Array(2 * 2 + 2); // 2x2 NV12 = 4 Y + 2 UV
    onFrameCb!({ streamId: "s2", data: nv12, width: 2, height: 2, ptsUs: 5, durUs: 33 });
    onFrameCb!({ streamId: "s1", data: nv12, width: 2, height: 2, ptsUs: 15, durUs: 33 });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([15]);
    t.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/transports/SwTransport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `SwTransport.ts` by extracting the transport body of `SwSourceHandle`**

Copy from `SwSourceHandle.ts` and transform:
- Move verbatim: `nextStreamSeq` (31), the `onFrame` subscribe + `handleFrame` NV12→VideoFrame→ImageBitmap conversion (130-192), `colorSpaceFor` (210-218), `requestFrameAt` incl. the `lastSentTargetUs` dedup (224-241) — but drop the `this.ring.setAnchor(tUs)` call (the ring lives on FfmpegSource now; see Task 5 Step 4 where FfmpegSource sets the anchor).
- **Transform the class shell**: `SwTransport implements DecodeTransport`. Drop the handle-only members (`ring`, `onFirstFrame`, `onFatalError`/`fireFatal`, `isIdle`/`lastUseMs`, `mediaId`/`layerId`). Keep `_disposed` for the late-frame guard.
- `streamId` becomes `o.streamId` on `open()`.
- `handleFrame`: on success → `this.frameCb?.(bmp, f.ptsUs, f.durUs)` (drop ring push + first-frame). Keep the non-fatal per-frame conversion `catch` (log + drop).
- `open()`: subscribe via `window.api.previewSw.onFrame(...)` BEFORE `await window.api.previewSw.open({ streamId, path })`; on open throw, call `this.errorCb?.(reason)` then rethrow (open-failure is the ONLY SW error signal — preserve the v1 note).
- `dispose()`: `unsub()`, `window.api.previewSw.close({ streamId })`, set `_disposed`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/transports/SwTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/transports/SwTransport.ts apps/desktop/src/renderer/render/decoder/transports/SwTransport.test.ts
git commit -m "feat(decode): extract SwTransport from SwSourceHandle"
```

---

### Task 4: `ffmpegCapability.ts` — move the lane machinery out of `decodeCapability.ts`

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/ffmpegCapability.ts`
- Modify: `apps/desktop/src/renderer/render/decoder/decodeCapability.ts` (leave `noteResolution` + a slim WebCodecs-original memo helper; the HW/SW consumers still import from the OLD names until Task 9 — so in this task, RE-EXPORT the moved symbols from `decodeCapability.ts` to keep the build green)
- Test: `apps/desktop/src/renderer/render/decoder/ffmpegCapability.test.ts`

**Interfaces:**
- Produces (consumed by Task 5's `FfmpegSource`):
  - `hwEligibleCodec(codec: string | null, pixFmt: string | null): boolean`
  - `classKeyOfMedia(m: {codec,pix_fmt,width?,height?}): string | null`
  - `pickInitialLane(input: { mediaId: string; codec: string | null; pixFmt: string | null; componentAvailable: boolean }): Promise<FfmpegLane>` — consults the cache + probe; returns `"hardware"` only for a passed HW probe on an eligible codec, else `"software"`.
  - `markHwUnusable(mediaId: string, reason: string): void` — sticky; future `pickInitialLane` for this media returns `"software"`.

- [ ] **Step 1: Write the failing test**

```ts
// ffmpegCapability.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hwEligibleCodec, pickInitialLane, markHwUnusable, resetFfmpegCapabilitySession } from "./ffmpegCapability";

beforeEach(() => resetFfmpegCapabilitySession());

describe("hwEligibleCodec", () => {
  it("accepts 8-bit h264/hevc/vp9, rejects 10-bit and others", () => {
    expect(hwEligibleCodec("h264", "yuv420p")).toBe(true);
    expect(hwEligibleCodec("hevc", "yuv420p10le")).toBe(false);
    expect(hwEligibleCodec("mpeg2video", "yuv420p")).toBe(false);
  });
});

describe("pickInitialLane", () => {
  it("returns software for an ineligible codec without probing", async () => {
    const probe = vi.fn();
    const lane = await pickInitialLane({ mediaId: "m", codec: "mpeg2video", pixFmt: "yuv420p", componentAvailable: true }, probe);
    expect(lane).toBe("software");
    expect(probe).not.toHaveBeenCalled();
  });
  it("returns hardware when an eligible codec's probe passes", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    expect(await pickInitialLane({ mediaId: "m", codec: "h264", pixFmt: "yuv420p", componentAvailable: true }, probe)).toBe("hardware");
  });
  it("returns software after markHwUnusable, even for an eligible codec", async () => {
    markHwUnusable("m", "device-lost");
    const probe = vi.fn(async () => ({ ok: true }));
    expect(await pickInitialLane({ mediaId: "m", codec: "h264", pixFmt: "yuv420p", componentAvailable: true }, probe)).toBe("software");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/ffmpegCapability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `ffmpegCapability.ts`**

Move verbatim from `decodeCapability.ts`: `hwLaneByMedia`, `swLaneByMedia`, `hwProbeInFlight`, `swProbeInFlight` (10-12, 89, 117), `classKeyOfMedia` (155-165), `hwEligibleCodec` (183-188). Fold the probe kicks into `pickInitialLane` (default `probeFn = (p,k)=>window.api.decodeCap.probeHw(p,k)`):

```ts
import type { FfmpegLane } from "./decodeEngine";
const hwUnusable = new Set<string>();

export function markHwUnusable(mediaId: string, _reason: string): void {
  hwUnusable.add(mediaId);
}

export async function pickInitialLane(
  input: { mediaId: string; codec: string | null; pixFmt: string | null; componentAvailable: boolean },
  probeFn: (path: string, classKey: string) => Promise<{ ok: boolean }> = (p, k) => window.api.decodeCap.probeHw(p, k),
  path?: string,
): Promise<FfmpegLane> {
  if (!input.componentAvailable) return "software";     // caller shouldn't ask, but be safe
  if (hwUnusable.has(input.mediaId)) return "software";
  if (!hwEligibleCodec(input.codec, input.pixFmt)) return "software";
  const classKey = classKeyOfMedia(input);
  if (classKey === null || !path) return "software";
  try {
    const r = await probeFn(path, classKey);
    return r.ok ? "hardware" : "software";
  } catch {
    return "software";
  }
}

export function resetFfmpegCapabilitySession(): void {
  hwUnusable.clear();
  // plus the moved hw/sw lane maps + in-flight sets
}
```

Keep the byte-identical `classKeyOfMedia` (do not alter the string form — the twin guard covers it). In `decodeCapability.ts`, re-export `hwEligibleCodec`, `classKeyOfMedia` from `./ffmpegCapability` so current importers (PixiPreview) keep compiling until Task 7/9.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/ffmpegCapability.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the twin guard**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/decodeCapability.test.ts`
Expected: PASS (classKey twin unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/ffmpegCapability.ts apps/desktop/src/renderer/render/decoder/ffmpegCapability.test.ts apps/desktop/src/renderer/render/decoder/decodeCapability.ts
git commit -m "feat(decode): move HW/SW lane machinery into ffmpegCapability (re-exported for now)"
```

---

### Task 5: `FfmpegSource` — the deep module (with the in-place fallback state machine)

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/FfmpegSource.ts`
- Test: `apps/desktop/src/renderer/render/decoder/FfmpegSource.test.ts`

**Interfaces:**
- Consumes: `DecodeTransport`/`GpuTransport`/`SwTransport` (Tasks 2-3), `pickInitialLane`/`markHwUnusable` (Task 4), `FfmpegLane` + `FrameRing` + `DecoderHandle`.
- Produces `FfmpegSource implements DecoderHandle` (consumed by Task 8's pool). Ctor:
  `new FfmpegSource(init: { layerId; mediaId; sourcePath; sourceColor?; codec?; pixFmt?; componentAvailable; poolSize?; forceLane?: FfmpegLane }, deps?: { makeGpu?: () => DecodeTransport; makeSw?: () => DecodeTransport; pickLane?: typeof pickInitialLane })`.
- Public methods: `ring`, `mediaId`, `disposed`, `ensureReady()`, `requestFrameAt(tUs)`, `onFirstFrame(cb)`, `onFatalError(cb)`, `isIdle(nowMs)`, `isLookaheadFull()`, `isDowngraded()`, `currentLane(): FfmpegLane`, `dispose()`.

- [ ] **Step 1: Write the failing test** (the fallback state machine, with injected fake transports)

```ts
// FfmpegSource.test.ts
import { describe, expect, it, vi } from "vitest";
import { FfmpegSource } from "./FfmpegSource";
import type { DecodeTransport } from "./transports/DecodeTransport";

function fakeTransport() {
  let frameCb: ((b: ImageBitmap, p: number, d: number) => void) | null = null;
  let errorCb: ((r: string) => void) | null = null;
  return {
    t: {
      open: vi.fn(async () => {}),
      requestFrameAt: vi.fn(),
      onFrame: (cb) => { frameCb = cb; },
      onError: (cb) => { errorCb = cb; },
      onEof: () => {},
      dispose: vi.fn(),
    } as DecodeTransport,
    emitFrame: (p: number) => frameCb?.({ close() {} } as unknown as ImageBitmap, p, 33),
    fail: (r: string) => errorCb?.(r),
  };
}

describe("FfmpegSource — internal HW→SW fallback", () => {
  it("starts on hardware, and on HW error swaps to software in place keeping the ring", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => "hardware" },
    );
    src.onFatalError(onFatal);
    await src.ensureReady();
    expect(src.currentLane()).toBe("hardware");
    gpu.emitFrame(1000);
    expect(src.ring.size()).toBe(1);

    gpu.fail("gpu-device-lost");                // HW dies mid-playback
    await new Promise((r) => setTimeout(r, 0));  // allow the in-place swap
    expect(gpu.t.dispose).toHaveBeenCalled();
    expect(sw.t.open).toHaveBeenCalled();
    expect(src.currentLane()).toBe("software");
    expect(src.isDowngraded()).toBe(true);
    expect(onFatal).not.toHaveBeenCalled();      // fully internal — no external signal
    sw.emitFrame(1033);
    expect(src.ring.size()).toBe(2);             // SAME ring kept its earlier frame
  });

  it("fires onFatalError only when SW also fails (total failure)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => "hardware" },
    );
    src.onFatalError(onFatal);
    await src.ensureReady();
    gpu.fail("gpu-error");
    await new Promise((r) => setTimeout(r, 0));
    sw.fail("sw-decode-error");                  // SW dies too
    await new Promise((r) => setTimeout(r, 0));
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("sw-decode-error"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/FfmpegSource.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `FfmpegSource.ts`**

```ts
import type { DecoderHandle } from "./SourceDecoderPool";
import type { FfmpegLane } from "./decodeEngine";
import { FrameRing } from "./FrameRing";
import type { DecodeTransport } from "./transports/DecodeTransport";
import { GpuTransport } from "./transports/GpuTransport";
import { SwTransport } from "./transports/SwTransport";
import { pickInitialLane, markHwUnusable } from "./ffmpegCapability";

const IDLE_DISPOSE_MS = 5_000;
let nextStreamSeq = 0;

export interface FfmpegSourceInit {
  layerId: string;
  mediaId: string;
  sourcePath: string;
  sourceColor?: VideoColorSpaceInit;
  codec?: string | null;
  pixFmt?: string | null;
  componentAvailable: boolean;
  poolSize?: number;
  /// Bench-only: pin the lane (decode-bench Stage 3). Skips capability probing.
  forceLane?: FfmpegLane;
}

interface FfmpegSourceDeps {
  makeGpu?: () => DecodeTransport;
  makeSw?: () => DecodeTransport;
  pickLane?: typeof pickInitialLane;
}

export class FfmpegSource implements DecoderHandle {
  readonly ring = new FrameRing();
  readonly mediaId: string;
  readonly layerId: string;
  private readonly init: FfmpegSourceInit;
  private readonly deps: FfmpegSourceDeps;
  private transport: DecodeTransport | null = null;
  private lane: FfmpegLane = "software";
  private startedHardware = false;
  private readyP: Promise<void> | null = null;
  private ready = false;
  private _disposed = false;
  private lastUseMs = 0;
  private lastTargetUs: number | null = null;
  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;
  private fatalCb: ((reason: string) => void) | null = null;
  private fatalFired = false;

  constructor(init: FfmpegSourceInit, deps: FfmpegSourceDeps = {}) {
    this.init = init;
    this.deps = deps;
    this.mediaId = init.mediaId;
    this.layerId = init.layerId;
  }

  get disposed(): boolean { return this._disposed; }
  currentLane(): FfmpegLane { return this.lane; }
  isDowngraded(): boolean { return this.startedHardware && this.lane === "software"; }
  isLookaheadFull(): boolean { return this.ring.isLookaheadFull(); }
  isIdle(nowMs: number): boolean { return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS; }

  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) { cb(); return; }
    this.onFirstFrameCb = cb;
  }
  onFatalError(cb: (reason: string) => void): void { this.fatalCb = cb; }

  async ensureReady(): Promise<void> {
    this.lastUseMs = performance.now();
    if (this.ready) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    const pick = this.deps.pickLane ?? pickInitialLane;
    this.lane = this.init.forceLane
      ?? await pick(
        { mediaId: this.mediaId, codec: this.init.codec ?? null, pixFmt: this.init.pixFmt ?? null, componentAvailable: this.init.componentAvailable },
        undefined,
        this.init.sourcePath,
      );
    if (this._disposed) return;
    this.startedHardware = this.lane === "hardware";
    await this.openLane(this.lane);
    this.ready = true;
  }

  /// Open a transport for `lane`, wiring frames into the ring and errors into
  /// the recovery path. Used by initial ready AND the in-place fallback.
  private async openLane(lane: FfmpegLane): Promise<void> {
    const t = lane === "hardware"
      ? (this.deps.makeGpu?.() ?? new GpuTransport())
      : (this.deps.makeSw?.() ?? new SwTransport());
    t.onFrame((bitmap, ptsUs, durUs) => {
      if (this._disposed) { bitmap.close(); return; }
      this.ring.push(bitmap, ptsUs, durUs);
      if (!this.firedFirstFrame) {
        this.firedFirstFrame = true;
        this.onFirstFrameCb?.();
        this.onFirstFrameCb = null;
      }
    });
    t.onError((reason) => this.onTransportError(lane, reason));
    t.onEof(() => {/* eof handled implicitly — no more nudges needed */});
    this.transport = t;
    this.lane = lane;
    // A fresh streamId per open so late frames from a swapped-out transport
    // (still draining on the old streamId) can never land in the ring.
    const streamId = `ffmpeg:${lane}:${this.layerId}:${nextStreamSeq++}`;
    await t.open({ streamId, path: this.init.sourcePath, sourceColor: this.init.sourceColor, poolSize: this.init.poolSize });
    if (this.lastTargetUs !== null) t.requestFrameAt(this.lastTargetUs);
  }

  /// Recovery. A hardware-transport failure is recoverable ONCE: swap to SW in
  /// place, keeping the ring (frames just resume). A software failure — or a
  /// second failure after we already fell to SW — is a total FFmpeg failure and
  /// surfaces the single engine-level fatal.
  private onTransportError(lane: FfmpegLane, reason: string): void {
    if (this._disposed) return;
    if (lane === "hardware" && this.startedHardware && this.transport) {
      markHwUnusable(this.mediaId, reason);
      const dead = this.transport;
      this.transport = null;
      dead.dispose();
      void this.openLane("software").catch((e) => this.fireFatal(`${reason}; sw recovery failed: ${String(e)}`));
      return;
    }
    this.fireFatal(reason);
  }

  private fireFatal(reason: string): void {
    if (this.fatalFired || this._disposed) return;
    this.fatalFired = true;
    this.fatalCb?.(reason);
  }

  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.ready) await this.ensureReady();
    this.lastUseMs = performance.now();
    if (this._disposed) return;
    this.lastTargetUs = tUs;
    this.ring.setAnchor(tUs);      // SW transport no longer sets the anchor; the source does
    this.transport?.requestFrameAt(tUs);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.transport?.dispose();
    this.transport = null;
    this.ring.dispose();
    this.onFirstFrameCb = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/FfmpegSource.test.ts`
Expected: PASS (both fallback and total-failure cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/FfmpegSource.ts apps/desktop/src/renderer/render/decoder/FfmpegSource.test.ts
git commit -m "feat(decode): FfmpegSource deep module with in-place HW->SW fallback"
```

---

## STAGE 3 — Switchover & dead-code removal

### Task 6: Pool `acquire` branches on `engine`

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts`
- Test: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.test.ts`

**Interfaces:**
- `SourceHandleInit` change: **add** `engine?: DecodeEngine` and `forceLane?: FfmpegLane`; **remove** `forceStrategy`. Keep `poolSize`, `sourcePath`, `codec`/`pixFmt` (add `codec?`/`pixFmt?` if absent — needed by `FfmpegSource`). Export pool ignores `engine`.
- `acquire` returns `SourceHandle | FfmpegSource` (union updated; drop `NativeGpuSourceHandle | SwSourceHandle`).

- [ ] **Step 1: Write the failing test**

```ts
it("acquire(engine:'ffmpeg') builds an FfmpegSource decoding sourcePath", () => {
  const pool = new SourceDecoderPool();
  const h = pool.acquire({
    layerId: "L", mediaId: "m", proxyAssetUrl: "", engine: "ffmpeg",
    sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true,
  } as never);
  expect(h.constructor.name).toBe("FfmpegSource");
});
it("acquire(engine:'webcodecs') builds the WebCodecs SourceHandle via SourceMedia", () => {
  const pool = new SourceDecoderPool();
  const h = pool.acquire({ layerId: "L2", mediaId: "m2", proxyAssetUrl: "weftcut-media://p.mp4", engine: "webcodecs" } as never);
  expect(h.constructor.name).toBe("SourceHandle");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/SourceDecoderPool.test.ts`
Expected: FAIL — `engine` not accepted / branch missing.

- [ ] **Step 3: Update `SourceHandleInit` and `acquire`**

In `SourceHandleInit`: remove the `forceStrategy` field (lines 68-77) and its doc; add:
```ts
  /// Resolved engine (preview). Export ignores it. Absent ⇒ webcodecs (legacy callers).
  engine?: import("./decodeEngine").DecodeEngine;
  /// Source codec/pixFmt — FfmpegSource needs them for lane selection.
  codec?: string | null;
  pixFmt?: string | null;
  /// FFmpeg component available on this machine (gates the HW lane).
  componentAvailable?: boolean;
  /// Bench-only lane pin.
  forceLane?: import("./decodeEngine").FfmpegLane;
```
Replace the `acquire` native branches (lines 711-733) with:
```ts
  if (init.engine === "ffmpeg") {
    const existing = this.handles.get(init.layerId);
    if (existing) return existing;
    const h = new FfmpegSource({
      layerId: init.layerId, mediaId: init.mediaId, sourcePath: init.sourcePath ?? "",
      sourceColor: init.sourceColor, codec: init.codec, pixFmt: init.pixFmt,
      componentAvailable: init.componentAvailable ?? false, poolSize: init.poolSize, forceLane: init.forceLane,
    });
    this.handles.set(init.layerId, h);
    this.startSweeperIfNeeded();
    return h;
  }
```
Update the `handles` map type and `acquire` return type to `SourceHandle | FfmpegSource`. Add `import { FfmpegSource } from "./FfmpegSource";`; remove the `NativeGpuSourceHandle`/`SwSourceHandle` imports.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/desktop && npx vitest run src/renderer/render/decoder/SourceDecoderPool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts apps/desktop/src/renderer/render/decoder/SourceDecoderPool.test.ts
git commit -m "feat(decode): pool acquire branches on engine (FfmpegSource | SourceHandle)"
```

---

### Task 7: Reshape `ResolvedRendererSource` + Compositor consumption

**Files:**
- Modify: `apps/desktop/src/renderer/render/Compositor.ts`

**Interfaces:**
- New `ResolvedRendererSource`:
```ts
export interface ResolvedRendererSource {
  engine: import("./decoder/decodeEngine").DecodeEngine;
  source: import("./decoder/decodeEngine").DecodeSource;
  status: "ok" | "pending" | "unsupported";
  target: string | null;   // path (ffmpeg) or convertFileSrc URL (webcodecs)
  key: string | null;
}
```
- New Compositor option `onUnsupported?: (mediaId: string) => void` (consumed by Task 10's PixiPreview).

- [ ] **Step 1: Update the type** (lines 183-199) to the shape above; delete `tier`/`forceStrategy`/`assetUrl`/`sourcePath` fields.

- [ ] **Step 2: Update `ensureClip`/`acquire` call sites** (around 1530-1543 and 1632-1636). Replace the `proxyAssetUrl: rs.assetUrl ?? ""` + `...(rs.forceStrategy ? {...})` spread with an engine-driven init:

```ts
const rs = /* resolved */;
if (rs.status === "unsupported") { this.opts.onUnsupported?.(mediaId); return; } // skip acquire
if (rs.status !== "ok" || rs.target === null) return;                            // pending: wait
const init: SourceHandleInit = {
  layerId, mediaId, sourceColor, sourceStartPtsUs,
  engine: rs.engine,
  proxyAssetUrl: rs.engine === "webcodecs" ? rs.target : "",
  sourcePath: rs.engine === "ffmpeg" ? rs.target : undefined,
  codec: media?.codec, pixFmt: media?.pix_fmt, componentAvailable: this.componentAvailable,
  ...(mode === "export" ? { handleKey: exportHandleKey(mediaId, layer.params.src_in_us, layer.t_start_us) } : {}),
};
```
(Read `media` from the existing `mediaById` lookup already in scope; `this.componentAvailable` is a value PixiPreview already passes — thread it through the Compositor options if not present.)

- [ ] **Step 3: Delete the HW/SW downgrade path** (lines 1551-1567). `FfmpegSource` handles HW→SW internally now, so `onFatalError` means a **total** engine failure. Replace with:
```ts
if (source.onFatalError) {
  source.onFatalError((reason) => {
    markEngineFailed(mediaId, reason);   // see Task 9: engine-level, not tier
    this.scheduleRepaint();              // re-resolve → auto falls to webcodecs, or unsupported
  });
}
```
(`markEngineFailed` is defined in Task 9's capability trim; for now, until Task 9, keep calling the existing `markDowngraded` with the resolved engine string to stay green — Task 9 renames it.)

- [ ] **Step 4: Update `rsFromExportProxy`** (line 195):
```ts
function rsFromExportProxy(url: string | null): ResolvedRendererSource | null {
  return url ? { engine: "webcodecs", source: "proxy", status: "ok", target: url, key: `webcodecs:proxy:${url}` } : null;
}
```

- [ ] **Step 5: Typecheck + unit**

Run: `cd apps/desktop && npm run typecheck && npx vitest run src/renderer/render/`
Expected: PASS (PixiPreview still feeds the OLD shape → Task 8 fixes it; if typecheck fails only in PixiPreview, proceed — Task 8 is the paired change; commit them together if needed).

- [ ] **Step 6: Commit** (may be combined with Task 8 if the build isn't green alone)

```bash
git add apps/desktop/src/renderer/render/Compositor.ts
git commit -m "refactor(decode): reshape ResolvedRendererSource to engine x source; drop tier from Compositor"
```

---

### Task 8: PixiPreview `resolveSource` rewrite

**Files:**
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx`

- [ ] **Step 1: Replace the `resolveSource` body** (lines 197-268) with a call to `resolveDecodeEngine`. Remove the HW/SW probe kicks (`kickSwProbe`/`kickHwProbe`/`hwEligibleCodec`/`classKeyOfMedia`/`laneStatesFor`/`nativeSwCouldPreempt`/`nativeHwCouldPreempt`) — that machinery now lives inside `FfmpegSource`/`ffmpegCapability`.

```ts
const resolveSource = (mediaId: string): ResolvedRendererSource | null => {
  const m = useProjectStore.getState().mediaById.get(mediaId);
  if (!m) return null;
  const setting = useAppSettingsStore.getState().settings.decode_engine;
  const componentAvailable = useDecodeComponentStore.getState().available;
  const proxyUrl = resolveDecode(m).previewPath;
  const r = resolveDecodeEngine({
    setting,
    componentAvailable,
    useProxySource: false,                 // no activation path this bite (Generate-proxy follow-up)
    proxyReady: proxyUrl !== null,
    proxyUrl,
    originalPath: m.path,
    originalUrl: convertFileSrc(m.path),   // same helper the old webcodecs-original tier used
    webcodecsCanDecodeOriginal: (previewDecodableOf?.(mediaId) ?? false) ? "ok" : "untested",
  });
  noteResolution(mediaId, r);
  return r;
};
```
Update imports: drop `orderFor`, `EngineTier`, `laneStatesFor`, `kickHwProbe`, `kickSwProbe`, `classKeyOfMedia`, `hwEligibleCodec`; add `resolveDecodeEngine`. Confirm `convertFileSrc` (or the app's URL helper) matches how the old tier-2 built its URL — reuse that exact call (grep `convertFileSrc`/`originalAssetUrl` in this file).

- [ ] **Step 2: `noteResolution` signature** — it took the old `ResolvedSource`. Update it (in `decodeCapability.ts`) to accept `{ key: string | null; reason: string }` (both shapes satisfy) so it compiles for the new type. Keep its one-line-per-change LogBus behavior.

- [ ] **Step 3: Typecheck + full unit**

Run: `cd apps/desktop && npm run typecheck && npm run test:unit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/render/PixiPreview.tsx apps/desktop/src/renderer/render/decoder/decodeCapability.ts
git commit -m "refactor(decode): PixiPreview resolveSource uses resolveDecodeEngine; lane probes now internal"
```

---

### Task 9: Delete dead code

**Files:**
- Delete: `NativeGpuSourceHandle.ts` (+ `.test.ts`), `SwSourceHandle.ts` (+ `.test.ts`)
- Modify: `decodeEngine.ts` (remove `EngineTier`, `LaneState`, `orderFor`, `resolveEngineTier`, old `EngineInputs`/`ResolvedSource`); delete `decodeEngine.test.ts` (the OLD one — `resolveDecodeEngine.test.ts` replaces it)
- Modify: `decodeCapability.ts` (remove `laneStatesFor`'s `nativeHw`/`nativeSw`; remove the re-exports added in Task 4; rename `markDowngraded`→`markEngineFailed` for engine-level use, or delete if unused)
- Modify: `testhook/e2eHook.ts`, `decodeBench.ts` (Task 11 handles bench) — drop `EngineTier` references

- [ ] **Step 1: Delete the two handle files + old tests**

```bash
git rm apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.test.ts \
       apps/desktop/src/renderer/render/decoder/SwSourceHandle.ts apps/desktop/src/renderer/render/decoder/SwSourceHandle.test.ts \
       apps/desktop/src/renderer/render/decoder/decodeEngine.test.ts
```

- [ ] **Step 2: Strip the legacy exports from `decodeEngine.ts`** — delete `EngineTier`, `LaneState`, `EngineInputs`, `ResolvedSource`, `orderFor`, `resolveEngineTier` (lines 8-107 of the original), keeping only `DecodeEngineSetting` + the collapsed model from Task 1.

- [ ] **Step 3: Trim `decodeCapability.ts`** — remove `hwLaneByMedia`/`swLaneByMedia`/`kickHwProbe`/`kickSwProbe`/`setHwLane`/`setSwLane`/`laneStatesFor`/`markDowngraded` (now in `ffmpegCapability.ts` or obsolete). Keep `noteResolution` + the WebCodecs-original memo. Add `export function markEngineFailed(mediaId, reason)` if Task 7 referenced it (LogBus warn, session-sticky Set) — else drop that call in Compositor.

- [ ] **Step 4: Grep for stragglers**

Run: `cd apps/desktop && grep -rn "EngineTier\|resolveEngineTier\|forceStrategy\|NativeGpuSourceHandle\|SwSourceHandle\|orderFor" src/ e2e/`
Expected: only e2e specs remain (Task 12) — fix any src/ hit before committing.

- [ ] **Step 5: Full typecheck + unit**

Run: `cd apps/desktop && npm run typecheck && npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/desktop/src/renderer/render/decoder apps/desktop/src/renderer/render/Compositor.ts apps/desktop/src/renderer/testhook/e2eHook.ts
git commit -m "refactor(decode): delete NativeGpuSourceHandle/SwSourceHandle + EngineTier (subsumed by FfmpegSource)"
```

---

## STAGE 4 — Settings, i18n, unsupported UI

### Task 10: Settings value rename `native → ffmpeg` + migration

**Files:**
- Modify: `apps/desktop/src/shared/app-settings.ts`, `apps/desktop/src/main/app-settings.ts`
- Test: `apps/desktop/src/main/app-settings.test.ts`

- [ ] **Step 1: Write the failing migration test**

```ts
it("migrates a persisted decode_engine 'native' to 'ffmpeg'", () => {
  const fs = memFs({ "/s.json": JSON.stringify({ decode_engine: "native" }) });
  const store = createAppSettingsStore({ fs, path: "/s.json", dir: "/" });
  expect(store.get().decode_engine).toBe("ffmpeg");
});
it("accepts 'ffmpeg' | 'webcodecs' | 'auto' and defaults others to auto", () => {
  const fs = memFs({ "/s.json": JSON.stringify({ decode_engine: "bogus" }) });
  expect(createAppSettingsStore({ fs, path: "/s.json", dir: "/" }).get().decode_engine).toBe("auto");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/app-settings.test.ts`
Expected: FAIL (type still `"native"`; no migration).

- [ ] **Step 3: Update the shared type** — in `app-settings.ts`, change both `decode_engine` unions (lines 30, 45) to `"auto" | "ffmpeg" | "webcodecs"`. Default stays `"auto"`.

- [ ] **Step 4: Update `main/app-settings.ts` read()** (line 57):
```ts
decode_engine:
  parsed.decode_engine === "native" ? "ffmpeg"           // migration
  : parsed.decode_engine === "ffmpeg" || parsed.decode_engine === "webcodecs" || parsed.decode_engine === "auto"
    ? parsed.decode_engine
    : d.decode_engine,
```
Leave `apply()`'s pass-through as-is (typed by the union now).

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/app-settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/app-settings.ts apps/desktop/src/main/app-settings.ts apps/desktop/src/main/app-settings.test.ts
git commit -m "feat(settings): rename decode_engine 'native'->'ffmpeg' with on-load migration"
```

---

### Task 11: i18n labels + hint + unsupported copy; settings `<select>`; decodeBench `forceLane`

**Files:**
- Modify: `i18n/locales/en-US.ts`, `i18n/locales/zh-CN.ts`
- Modify: the decode-engine `<select>` component (grep `decode_engine_native` in `src/renderer/settings/` / panels)
- Modify: `decoder/decodeBench.ts`

- [ ] **Step 1: en-US settings keys** (lines 533-540) →
```ts
    decode_engine: "Preview decode engine",
    decode_engine_hint:
      "Automatic picks the best engine per clip. Standard (FFmpeg) plays every format; Lite (WebCodecs) is lightweight but supports fewer formats.",
    decode_engine_auto: "Automatic (recommended)",
    decode_engine_ffmpeg: "Standard",
    decode_engine_ffmpeg_tag: "ffmpeg",
    decode_engine_webcodecs: "Lite",
    decode_engine_webcodecs_tag: "webcodecs",
    decode_engine_unavailable: "Standard engine unavailable: {{reason}}",
    decode_engine_unavailable_suffix: "unavailable",
    decode_unsupported_title: "Unsupported format",
    decode_unsupported_body: "The Lite engine can't decode this clip. Switch to the Standard engine to play it.",
    decode_unsupported_switch: "Switch to Standard",
    decode_unsupported_body_no_component: "This clip's format isn't supported by the Lite engine, and the Standard engine isn't installed.",
```
Remove `decode_engine_native`.

- [ ] **Step 2: zh-CN settings keys** (lines 520-527) →
```ts
    decode_engine: "预览解码引擎",
    decode_engine_hint:
      "自动模式按素材选择最合适的引擎。标准（FFmpeg）可解码所有格式；轻量（WebCodecs）更省资源但支持的格式较少。",
    decode_engine_auto: "自动（推荐）",
    decode_engine_ffmpeg: "标准",
    decode_engine_ffmpeg_tag: "ffmpeg",
    decode_engine_webcodecs: "轻量",
    decode_engine_webcodecs_tag: "webcodecs",
    decode_engine_unavailable: "标准引擎不可用：{{reason}}",
    decode_engine_unavailable_suffix: "不可用",
    decode_unsupported_title: "不支持的格式",
    decode_unsupported_body: "轻量引擎无法解码该片段。切换到标准引擎即可播放。",
    decode_unsupported_switch: "切换到标准",
    decode_unsupported_body_no_component: "轻量引擎不支持该片段的格式，且未安装标准引擎。",
```

- [ ] **Step 3: Update the `<select>`** — replace the three options to use `decode_engine_auto`/`decode_engine_ffmpeg`/`decode_engine_webcodecs`, and the `<option value>`s from `"native"`→`"ffmpeg"`. Render the tag key beside the label if the component supports a secondary label; else append ` (ffmpeg)` / ` (webcodecs)`. Update any `value === "native"` comparisons to `"ffmpeg"`.

- [ ] **Step 4: decodeBench `forceLane`** — replace `forceStrategy: "native" | "software"` usage with `forceLane: "hardware" | "software"` passed through to `acquire({ engine: "ffmpeg", forceLane, ... })`. The Stage-3 pool sweep now varies `poolSize` on the ffmpeg engine; the HW-vs-SW comparison sets `forceLane`.

- [ ] **Step 5: Typecheck + unit + i18n key-parity check**

Run: `cd apps/desktop && npm run typecheck && npm run test:unit`
Expected: PASS. If the repo has an i18n key-parity test, it must stay green (same keys in both locales).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/i18n apps/desktop/src/renderer/settings apps/desktop/src/renderer/render/decoder/decodeBench.ts
git commit -m "feat(decode): Standard/Lite/Automatic engine labels + unsupported copy; bench forceLane"
```

---

### Task 12: Unsupported placeholder card + Switch-to-Standard

**Files:**
- Create: `apps/desktop/src/renderer/render/UnsupportedClipCard.tsx`
- Modify: `apps/desktop/src/renderer/render/PixiPreview.tsx` (track the unsupported set via the Compositor `onUnsupported` callback; render the card)

- [ ] **Step 1: Write `UnsupportedClipCard.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useDecodeComponentStore } from "../settings/decodeComponentStore"; // the store PixiPreview already reads

export function UnsupportedClipCard(): JSX.Element {
  const { t } = useTranslation();
  const componentAvailable = useDecodeComponentStore((s) => s.available);
  const apply = useAppSettingsStore((s) => s.apply); // grep the store's patch action name
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/70 text-center text-sm text-white">
      <div className="max-w-sm space-y-3 p-4">
        <div className="font-medium">{t("settings.decode_unsupported_title")}</div>
        <div className="text-white/70">
          {t(componentAvailable ? "settings.decode_unsupported_body" : "settings.decode_unsupported_body_no_component")}
        </div>
        {componentAvailable && (
          <button className="rounded bg-white/15 px-3 py-1 hover:bg-white/25"
            onClick={() => apply({ decode_engine: "ffmpeg" })}>
            {t("settings.decode_unsupported_switch")}
          </button>
        )}
      </div>
    </div>
  );
}
```
(Confirm the settings store's apply/patch action name and the decode-component store path by grepping `useAppSettingsStore` / `useDecodeComponentStore` in PixiPreview.)

- [ ] **Step 2: Wire `onUnsupported` in PixiPreview** — pass `onUnsupported: (mediaId) => setUnsupportedIds((s) => new Set(s).add(mediaId))` into the Compositor options (near `resolveSource`, line 297). Clear the set when the setting or component availability changes (a `useEffect` on `decode_engine`/`available` that resets it — so switching to Standard removes the card on the next resolve). Track whether any unsupported media is currently on-screen; when so, render `<UnsupportedClipCard />` as an overlay sibling of the canvas.

- [ ] **Step 3: Manual/e2e verification is in Task 13** (React unit render is optional — a shallow render assert that the button dispatches `apply({decode_engine:"ffmpeg"})` is a good cheap test):

```tsx
// UnsupportedClipCard.test.tsx (optional but recommended)
// render with componentAvailable=true, click the button, assert apply called with {decode_engine:"ffmpeg"}.
```

- [ ] **Step 4: Typecheck + unit**

Run: `cd apps/desktop && npm run typecheck && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/UnsupportedClipCard.tsx apps/desktop/src/renderer/render/PixiPreview.tsx
git commit -m "feat(decode): unsupported-clip placeholder card + Switch to Standard"
```

---

## STAGE 5 — e2e retarget + the fallback gate

### Task 13: e2e retarget + internal HW→SW fallback gate + export regression

**Files:**
- Modify: `e2e/electron/decode-engine.spec.ts`, `preview-gpu-order.spec.ts`, `preview-sw-conformance.spec.ts`, `preview-sw-families.spec.ts`
- Modify (as needed): `render/decoder/decodeBench.ts` test hooks referenced by the specs

- [ ] **Step 1: Retarget assertions off `EngineTier`.** Replace `tier: "native-hw"|"native-sw"|"webcodecs-original"|"proxy"` expectations with `{engine, source}` + `currentLane()` where a spec asserted a lane. The LogBus `decode resolution` line now reads `→ ffmpeg on original` etc. (from `resolveDecodeEngine.reason`); update the grep patterns in the spec helpers.

- [ ] **Step 2: Internal HW→SW fallback gate (the key new e2e).** Extend `preview-gpu-order.spec.ts`: drive continuous forward decode of the index-encoded barcode clip on the ffmpeg engine starting hardware; inject a GPU error mid-stream (add a `decodeBenchInjectGpuError()` hook that calls the transport's `onError`), then assert: (a) `currentLane()` flips `hardware`→`software`; (b) frames keep arriving into the same ring (ring size keeps growing); (c) delivered barcodes still equal their pts-derived index across the switch (no gap/dupe); (d) no source-swap fired (the swap counter stays flat). This is the behavior-observed gate.

- [ ] **Step 3: No-auto-proxy check.** A WebCodecs-unsupported original on `auto`+component previews via ffmpeg (assert `currentLane()` is `software`, no proxy job started for it); on `webcodecs` it reaches `status: "unsupported"` and the card renders.

- [ ] **Step 4: Export regression.** Run the existing export e2e (the SSIM matrix) and confirm SSIM 1.0000 vs baseline — the `rsFromExportProxy` shape change must be behavior-neutral.

Run: `cd apps/desktop && WEFTCUT_DECODE_E2E=1 npm run e2e:electron -- preview-gpu-order.spec.ts decode-engine.spec.ts`
Expected: all green, including the new fallback gate.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e apps/desktop/src/renderer/render/decoder/decodeBench.ts
git commit -m "test(decode): retarget e2e to engine model + internal HW->SW fallback gate"
```

---

## Verification checklist (run before declaring done)

- [ ] `cd apps/desktop && npm run typecheck` — clean.
- [ ] `npm run test:unit` — full suite green (was 1958 tests pre-change; expect a small net change from the resolver/handle test swaps).
- [ ] `grep -rn "EngineTier\|forceStrategy\|NativeGpuSourceHandle\|SwSourceHandle\|resolveEngineTier" src/` — no hits in `src/`.
- [ ] `WEFTCUT_DECODE_E2E=1 npm run e2e:electron -- preview-gpu-order.spec.ts` — fallback gate passes.
- [ ] Launch the dev app, load an HEVC clip on `auto`, confirm it plays in order on the ffmpeg engine (watch the counter clip); flip to `Lite`, confirm an unsupported clip shows the card + "Switch to Standard" restores it.
- [ ] Export a project, confirm SSIM 1.0000 vs a pre-change baseline.
