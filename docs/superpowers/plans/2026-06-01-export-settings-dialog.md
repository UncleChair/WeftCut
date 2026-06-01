# Export Settings Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-click "Export → OS save dialog" flow with a settings dialog where the user picks resolution, frame rate, video codec, quality/bitrate (with VBR/CBR), sees a live estimated file size, and chooses the output path — all persisted per project.

**Architecture:** The dialog lives in the webview and owns the output path (a "Browse…" button opens the OS save dialog). It assembles a `VideoEncoderConfig` + output fps that thread through the existing Pixi export Worker. Container stays MP4 (output is always `.mp4`, the Rust `-c copy` mux is untouched). Codec is encoder-time; resolution is a downscale blit in the Worker; fps is a re-parameterized frame grid. Codecs are runtime-probed (`isConfigSupported` + a 1-frame real-encode smoke for AV1/HEVC) with a fallback to H.264 if encoding fails. Settings persist in a per-workspace `export.json` (separate from `view.json` to avoid the timeline's whole-file write clobbering them).

**Tech Stack:** TypeScript + React (webview), vitest (node unit tests), WebCodecs `VideoEncoder`, mediabunny (MP4 mux, unchanged), Rust + Tauri (persistence command pair + ffmpeg mux, unchanged).

---

## Background: the current export flow (read before starting)

- Menu *Export* → `runPixiExport` in `apps/desktop/src/App.tsx:774` → OS save dialog (`.mp4` only) → readiness gate → `previewRef.current.runPixiExport({ onProgress })`.
- `PreviewSurface.runPixiExport` (`apps/desktop/src/preview/PreviewSurface.tsx:78`) forwards **only** `onProgress` to `PixiPreview.runExport` (`apps/desktop/src/render/PixiPreview.tsx:79`), which calls `handlePixiExport` (`PixiPreview.tsx:252`) → `runExport` (`apps/desktop/src/render/worker/runExport.ts:64`).
- `runExport` **already accepts** an `encoderConfig` override (`runExport.ts:34`) but nothing passes one, so `defaultEncoderConfig` (`runExport.ts:53`: `avc1.640028`, 8 Mbps, `framerate: 30`, prefer-hardware) is always used.
- The Worker (`apps/desktop/src/render/worker/exportWorker.ts:74`) renders the Pixi scene into an `OffscreenCanvas` sized to **composition** width/height, captures each frame with `new VideoFrame(req.canvas, ...)` (`exportWorker.ts:250`), and encodes via `EncoderSink` (`apps/desktop/src/render/worker/encoder.ts`). `EncoderSink` drives everything from `init.config` (the `VideoEncoderConfig`); the extra `width/height/fpsNum/fpsDen` fields in `EncoderInit` are vestigial and unused.
- `muxCodec.ts` already maps `avc/hevc/av1/vp9/vp8` WebCodecs strings to mediabunny codecs, so mediabunny can mux H.264/AV1/HEVC into MP4 today — only the encoder needs to emit them.
- Container is MP4 in two places, but **both stay MP4** in this plan: mediabunny `Mp4OutputFormat` (`encoder.ts:52`) and the Rust `-c copy` output extension (`apps/desktop/src-tauri/src/export/mod.rs:154`). Nothing in Rust changes.

## Key design decisions (resolved during grilling)

1. **Full panel:** resolution + fps + codec + quality + VBR/CBR + estimated-size readout.
2. **Dialog owns the path:** Export menu opens the dialog; a Browse button opens the save dialog seeded with `.mp4`.
3. **Container fixed MP4** (output always `.mp4`); codec selectable.
4. **Codec feasibility = probe-driven + runtime fallback:** `isConfigSupported` populates the dropdown; selecting AV1/HEVC runs a 1-frame real-encode smoke; a thrown encode error during export falls back to H.264.
5. **Resolution = follow-composition + downscale presets** (≤ comp height), even dimensions enforced; implemented as a downscale blit in the Worker — the proven render path is untouched.
6. **fps = follow-composition + downscale presets** (≤ comp fps); time-driven frame grid re-parameterized (touches ~5 sites, see Task 4).
7. **Quality = adaptive bpp presets (low/medium/high) + custom Mbps**, with **codec-aware bpp multipliers** so AV1/HEVC target lower bitrate and the size estimate stays honest.
8. **Rate control = VBR default + CBR toggle** (`bitrateMode`).
9. **Persistence = per-project, no migration:** opaque JSON blob in `<workspace>/export.json`, separate from `view.json`.
10. **Deferred:** audio settings (fixed AAC 192k), named presets, export range (in/out points), MOV/WebM, quantizer/CRF mode.

## File structure

- **Create** `apps/desktop/src/render/exportSettings.ts` — pure logic: `ExportSettings` type, defaults, dim/fps/bitrate/codec/estimate helpers. Fully unit-tested.
- **Create** `apps/desktop/src/render/exportSettings.test.ts` — vitest unit tests for the above.
- **Create** `apps/desktop/src/render/exportCodecProbe.ts` — `probeEncoderSupported` + `smokeEncode`.
- **Create** `apps/desktop/src/render/exportCodecProbe.test.ts` — node-safe branch tests.
- **Create** `apps/desktop/src/panels/ExportSettingsDialog.tsx` — the dialog component.
- **Create** `apps/desktop/src-tauri/src/export_settings_store.rs` — per-workspace opaque-JSON store.
- **Modify** `apps/desktop/src/render/pixiPreviewFlag.ts` — thread `encoderConfig` + `outputFps` through the handle types.
- **Modify** `apps/desktop/src/render/PixiPreview.tsx` — thread args into `handlePixiExport` + `runExport`; return output fps.
- **Modify** `apps/desktop/src/preview/PreviewSurface.tsx` — extend `runPixiExport` signature.
- **Modify** `apps/desktop/src/render/worker/runExport.ts` — accept `outputFps`; stop defaulting `framerate: 30`.
- **Modify** `apps/desktop/src/render/worker/protocol.ts` — add `outputFpsNum/outputFpsDen` to the start request.
- **Modify** `apps/desktop/src/render/worker/exportWorker.ts` — re-parameterize fps grid; downscale blit when target ≠ comp.
- **Modify** `apps/desktop/src/App.tsx` — menu opens dialog; extract `runExportWithSettings`; build config; runtime H.264 fallback.
- **Modify** `apps/desktop/src/ipc/index.ts` — `exportSettingsGet/Set` bindings.
- **Modify** `apps/desktop/src-tauri/src/commands.rs` — `export_settings_get/set` commands.
- **Modify** `apps/desktop/src-tauri/src/lib.rs` — declare module + register commands.
- **Modify** `apps/desktop/src/i18n/locales/en-US.ts` + `zh-CN.ts` — dialog strings.

## Test reality (no automated merge gate)

Per the project's known state, `npm run typecheck` (TS6310), `npm run build` (esbuild), and `npm run fixtures:render` (browser suite) are **all red on clean `main`** — they are NOT gates. What works:

- **`npm test`** (`vitest run --exclude '**/*.browser.test.ts'`, run from `apps/desktop/`) runs node/jsdom unit tests. Use it for all pure-logic tasks.
- **`cargo test`** (from `apps/desktop/src-tauri/`) runs Rust unit tests.
- Worker/dialog integration has no automated test → verified via **`npm run tauri dev`** smoke (Task 11), with "default settings produce the same output as today" as the explicit baseline check.

Run unit tests from `apps/desktop/` (the package with the `test` script). Rust tests from `apps/desktop/src-tauri/`.

---

## Task 1: Pure export-settings logic

**Files:**
- Create: `apps/desktop/src/render/exportSettings.ts`
- Test: `apps/desktop/src/render/exportSettings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/render/exportSettings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_SETTINGS,
  codecString,
  computeBitrate,
  downscaleFpsOptions,
  downscaleHeightOptions,
  estimateBytes,
  formatBytes,
  mergeSettings,
  resolveOutputDims,
  type ExportSettings,
} from "./exportSettings";

const comp = { width: 1920, height: 1080, fps_num: 30, fps_den: 1 };

describe("resolveOutputDims", () => {
  it("follows composition when resolutionHeight is null", () => {
    expect(resolveOutputDims(comp, DEFAULT_EXPORT_SETTINGS)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("downscales preserving aspect, rounding to even", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, resolutionHeight: 720 };
    expect(resolveOutputDims(comp, s)).toEqual({ width: 1280, height: 720 });
  });

  it("never upscales beyond composition height", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, resolutionHeight: 2160 };
    expect(resolveOutputDims(comp, s)).toEqual({ width: 1920, height: 1080 });
  });

  it("forces even dimensions for odd aspect ratios", () => {
    const oddComp = { width: 1080, height: 1349, fps_num: 30, fps_den: 1 };
    const s = { ...DEFAULT_EXPORT_SETTINGS, resolutionHeight: 720 };
    const dims = resolveOutputDims(oddComp, s);
    expect(dims.width % 2).toBe(0);
    expect(dims.height % 2).toBe(0);
  });
});

describe("downscale option lists", () => {
  it("offers only standard heights below composition", () => {
    expect(downscaleHeightOptions(1080)).toEqual([720, 480, 360]);
  });
  it("offers only standard fps below composition", () => {
    expect(downscaleFpsOptions(60)).toEqual([50, 30, 25, 24]);
  });
});

describe("computeBitrate", () => {
  it("medium H.264 at 1080p30 is ~8 Mbps (matches today's default)", () => {
    const s = { ...DEFAULT_EXPORT_SETTINGS, quality: "medium" as const };
    const bps = computeBitrate(s, 1920, 1080, 30);
    expect(bps).toBeGreaterThan(7_500_000);
    expect(bps).toBeLessThan(8_700_000);
  });

  it("AV1 targets roughly half the H.264 bitrate at the same quality", () => {
    const h264 = computeBitrate(
      { ...DEFAULT_EXPORT_SETTINGS, codec: "h264", quality: "high" },
      1920,
      1080,
      30,
    );
    const av1 = computeBitrate(
      { ...DEFAULT_EXPORT_SETTINGS, codec: "av1", quality: "high" },
      1920,
      1080,
      30,
    );
    expect(av1).toBeLessThan(h264 * 0.6);
    expect(av1).toBeGreaterThan(h264 * 0.4);
  });

  it("uses the custom bitrate verbatim when quality is custom", () => {
    const s: ExportSettings = {
      ...DEFAULT_EXPORT_SETTINGS,
      quality: "custom",
      customBitrate: 12_000_000,
    };
    expect(computeBitrate(s, 1920, 1080, 30)).toBe(12_000_000);
  });
});

describe("codecString", () => {
  it("keeps H.264 at the existing baseline string", () => {
    expect(codecString("h264")).toBe("avc1.640028");
  });
  it("returns valid AV1 and HEVC strings", () => {
    expect(codecString("av1")).toMatch(/^av01\./);
    expect(codecString("hevc")).toMatch(/^hev1\./);
  });
});

describe("estimateBytes / formatBytes", () => {
  it("adds audio bitrate when the project has audio", () => {
    const withAudio = estimateBytes(8_000_000, 10_000_000, true);
    const noAudio = estimateBytes(8_000_000, 10_000_000, false);
    expect(withAudio).toBeGreaterThan(noAudio);
  });
  it("formats bytes into human units", () => {
    expect(formatBytes(10_500_000)).toBe("10.5 MB");
    expect(formatBytes(2_100_000_000)).toBe("2.10 GB");
  });
});

describe("mergeSettings", () => {
  it("fills missing fields from defaults", () => {
    expect(mergeSettings({ codec: "av1" })).toEqual({
      ...DEFAULT_EXPORT_SETTINGS,
      codec: "av1",
    });
  });
  it("returns defaults for null", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `apps/desktop/`): `npm test -- exportSettings`
Expected: FAIL — "Cannot find module './exportSettings'".

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/render/exportSettings.ts`:

```ts
// Pure logic for the export settings dialog. No React, no Tauri — every
// function here is unit-tested in exportSettings.test.ts. The webview owns
// this schema end to end; Rust persists it as an opaque JSON blob.

export type CodecId = "h264" | "av1" | "hevc";
export type QualityPreset = "low" | "medium" | "high" | "custom";
export type RateMode = "vbr" | "cbr";

export interface ExportSettings {
  /// Target output height in pixels; null = follow composition. Width is
  /// derived from the composition aspect ratio. Downscale-only.
  resolutionHeight: number | null;
  /// Target output fps (integer); null = follow composition fps.
  fps: number | null;
  codec: CodecId;
  quality: QualityPreset;
  /// Bits per second, used only when quality === "custom".
  customBitrate: number | null;
  rateMode: RateMode;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolutionHeight: null,
  fps: null,
  codec: "h264",
  quality: "medium",
  customBitrate: null,
  rateMode: "vbr",
};

/// Standard heights offered as downscale presets (largest first).
export const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360] as const;
/// Standard fps offered as downscale presets (largest first).
export const STANDARD_FPS = [60, 50, 30, 25, 24] as const;

function makeEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

export interface CompDims {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

/// Resolve the encoder's output width/height. Follows composition when
/// resolutionHeight is null; otherwise downscales (never upscales) preserving
/// aspect, and forces even dimensions (H.264/yuv420p reject odd w/h).
export function resolveOutputDims(
  comp: Pick<CompDims, "width" | "height">,
  settings: ExportSettings,
): { width: number; height: number } {
  if (settings.resolutionHeight == null) {
    return { width: makeEven(comp.width), height: makeEven(comp.height) };
  }
  const targetH = Math.min(settings.resolutionHeight, comp.height);
  const scale = targetH / comp.height;
  return {
    width: makeEven(comp.width * scale),
    height: makeEven(targetH),
  };
}

export function downscaleHeightOptions(compHeight: number): number[] {
  return STANDARD_HEIGHTS.filter((h) => h < compHeight);
}

export function downscaleFpsOptions(compFps: number): number[] {
  return STANDARD_FPS.filter((f) => f < compFps);
}

// Base bits-per-pixel-per-frame tuned for H.264 so medium @ 1080p30 ≈ 8 Mbps
// (matches today's hardcoded default). bitrate = width * height * fps * bpp.
const BASE_BPP: Record<Exclude<QualityPreset, "custom">, number> = {
  low: 0.07,
  medium: 0.129,
  high: 0.24,
};

// Codec efficiency: AV1/HEVC reach the same perceptual quality at a fraction
// of H.264's bitrate. Keeps the size estimate honest per codec.
const CODEC_BPP_MULTIPLIER: Record<CodecId, number> = {
  h264: 1.0,
  hevc: 0.55,
  av1: 0.5,
};

export function computeBitrate(
  settings: ExportSettings,
  width: number,
  height: number,
  fps: number,
): number {
  if (settings.quality === "custom" && settings.customBitrate) {
    return settings.customBitrate;
  }
  const preset = settings.quality === "custom" ? "medium" : settings.quality;
  const bpp = BASE_BPP[preset] * CODEC_BPP_MULTIPLIER[settings.codec];
  return Math.round(width * height * fps * bpp);
}

/// WebCodecs codec strings. H.264 keeps the existing baseline string so a
/// default export matches today byte-for-byte. AV1/HEVC use levels generous
/// enough for up to 4K (downscale-only never exceeds composition size).
export function codecString(codec: CodecId): string {
  switch (codec) {
    case "h264":
      return "avc1.640028"; // High@4.0 — existing default
    case "av1":
      return "av01.0.13M.08"; // Main profile, ~level 5.1, 8-bit
    case "hevc":
      return "hev1.1.6.L153.B0"; // Main profile, level 5.1
  }
}

export function estimateBytes(
  bitrate: number,
  durationUs: number,
  hasAudio: boolean,
): number {
  const audioBitrate = hasAudio ? 192_000 : 0;
  const durationSec = durationUs / 1_000_000;
  return Math.round(((bitrate + audioBitrate) * durationSec) / 8);
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/// Overlay a (possibly partial / null) saved blob onto the defaults so old or
/// missing fields fill in. The webview is the only schema authority.
export function mergeSettings(
  saved: Partial<ExportSettings> | null,
): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...(saved ?? {}) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `apps/desktop/`): `npm test -- exportSettings`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/exportSettings.ts apps/desktop/src/render/exportSettings.test.ts
git commit -m "feat(export): pure export-settings logic (dims/fps/bitrate/codec/estimate)"
```

---

## Task 2: Encoder feasibility probe

**Files:**
- Create: `apps/desktop/src/render/exportCodecProbe.ts`
- Test: `apps/desktop/src/render/exportCodecProbe.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/render/exportCodecProbe.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeEncoderSupported } from "./exportCodecProbe";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeEncoderSupported", () => {
  it("always reports H.264 supported without touching VideoEncoder", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await probeEncoderSupported("h264", 1920, 1080, 30)).toBe(true);
  });

  it("returns false for AV1/HEVC when VideoEncoder is unavailable", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await probeEncoderSupported("av1", 1920, 1080, 30)).toBe(false);
    expect(await probeEncoderSupported("hevc", 1920, 1080, 30)).toBe(false);
  });

  it("delegates AV1/HEVC to isConfigSupported and reads .supported", async () => {
    const isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal("VideoEncoder", { isConfigSupported });
    expect(await probeEncoderSupported("av1", 3840, 2160, 30)).toBe(true);
    expect(isConfigSupported).toHaveBeenCalledOnce();
    const cfg = isConfigSupported.mock.calls[0][0];
    expect(cfg.codec).toMatch(/^av01\./);
    expect(cfg.width).toBe(3840);
  });

  it("returns false when isConfigSupported rejects", async () => {
    const isConfigSupported = vi.fn().mockRejectedValue(new Error("nope"));
    vi.stubGlobal("VideoEncoder", { isConfigSupported });
    expect(await probeEncoderSupported("hevc", 1920, 1080, 30)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `apps/desktop/`): `npm test -- exportCodecProbe`
Expected: FAIL — "Cannot find module './exportCodecProbe'".

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/render/exportCodecProbe.ts`:

```ts
// Runtime encoder feasibility. WebView2's VideoEncoder.isConfigSupported is
// optimistic (it can report `supported: true` for codecs that then fail or
// stall at real encode — same hazard documented for decode in
// reference_webcodecs_hi10p). So the dropdown is populated by
// isConfigSupported, but selecting AV1/HEVC runs a one-frame real-encode
// smoke, and a thrown error during the actual export falls back to H.264.

import { type CodecId, codecString } from "./exportSettings";

/// Fast feasibility check used to populate the codec dropdown. H.264 is the
/// guaranteed baseline. AV1/HEVC delegate to isConfigSupported.
export async function probeEncoderSupported(
  codec: CodecId,
  width: number,
  height: number,
  fps: number,
): Promise<boolean> {
  if (codec === "h264") return true;
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder })
    .VideoEncoder;
  if (!VE || typeof VE.isConfigSupported !== "function") return false;
  try {
    const res = await VE.isConfigSupported({
      codec: codecString(codec),
      width,
      height,
      bitrate: 2_000_000,
      framerate: fps,
    });
    return !!res.supported;
  } catch {
    return false;
  }
}

/// One-frame real-encode smoke. Configures a VideoEncoder, encodes a single
/// blank frame, and resolves true iff an encoded chunk arrives before the
/// deadline or an error. Mirrors raceFirstDecode (probeSourceDecodable.ts).
/// Catches WebView2's "isConfigSupported lied" case for AV1/HEVC.
export async function smokeEncode(
  codec: CodecId,
  width: number,
  height: number,
  fps: number,
  deadlineMs = 4000,
): Promise<boolean> {
  if (codec === "h264") return true;
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder })
    .VideoEncoder;
  if (!VE) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let encoder: VideoEncoder | null = null;
    let canvas: OffscreenCanvas | null = null;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        encoder?.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), deadlineMs);
    try {
      encoder = new VE({
        output: () => finish(true),
        error: () => finish(false),
      });
      encoder.configure({
        codec: codecString(codec),
        width,
        height,
        bitrate: 2_000_000,
        framerate: fps,
        hardwareAcceleration: "prefer-hardware",
      });
      // A small even-sized blank frame keeps the smoke cheap; the real export
      // re-probes nothing, it just encodes at full size.
      canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        finish(false);
        return;
      }
      const frame = new VideoFrame(canvas, { timestamp: 0 });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      void encoder.flush().catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `apps/desktop/`): `npm test -- exportCodecProbe`
Expected: PASS. (`smokeEncode` is not unit-tested — it needs a real `VideoEncoder`; it is exercised in the Task 11 smoke.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/exportCodecProbe.ts apps/desktop/src/render/exportCodecProbe.test.ts
git commit -m "feat(export): runtime encoder feasibility probe + one-frame smoke"
```

---

## Task 3: Thread `outputFps` through the worker protocol + runExport

**Files:**
- Modify: `apps/desktop/src/render/worker/runExport.ts:23-62` and `:64-128`
- Modify: `apps/desktop/src/render/worker/protocol.ts:40-58`

- [ ] **Step 1: Add `outputFps` to the protocol start request**

In `apps/desktop/src/render/worker/protocol.ts`, find the `start` request variant (around line 40-58, the object with `endUs`, `encoderConfig`, `canvas`). Add two fields after `encoderConfig`:

```ts
      encoderConfig: VideoEncoderConfig;
      /// Output frame rate as a rational (overrides composition fps for the
      /// export frame grid). Absent ⇒ use the project's composition fps.
      outputFpsNum?: number;
      outputFpsDen?: number;
      canvas: OffscreenCanvas;
```

- [ ] **Step 2: Add `outputFps` to `RunExportInit` and forward it; stop hardcoding framerate 30**

In `apps/desktop/src/render/worker/runExport.ts`, extend `RunExportInit` (after the `encoderConfig` field, line 34):

```ts
  encoderConfig?: VideoEncoderConfig;
  /// Output frame rate (rational). Overrides composition fps for the frame
  /// grid + capture cadence. Absent ⇒ composition fps.
  outputFps?: { num: number; den: number };
```

Replace `defaultEncoderConfig` (lines 53-62) so the default framerate follows composition fps instead of the hardcoded 30. Change its signature and body:

```ts
/// Default 1080p-style H.264 encoder config used when the caller doesn't
/// supply one. High profile, Level 4.2, yuv420p — universally
/// hardware-decodable downstream. Framerate follows the composition (the
/// hardcoded 30 was a latent bug for non-30fps projects).
function defaultEncoderConfig(
  width: number,
  height: number,
  framerate: number,
): VideoEncoderConfig {
  return {
    codec: "avc1.640028",
    width,
    height,
    bitrate: 8_000_000,
    framerate,
    hardwareAcceleration: "prefer-hardware",
  };
}
```

In `runExport` (lines 64-128), update the encoder-config default call (line 110-111) and add the fps to the start request. Replace:

```ts
  // 3. Encoder config.
  const encoderConfig =
    init.encoderConfig ?? defaultEncoderConfig(comp.width, comp.height);
```

with:

```ts
  // 3. Encoder config. Output fps follows the caller's override, else
  // composition fps. The default config's framerate must match.
  const outFpsNum = init.outputFps?.num ?? fpsNum;
  const outFpsDen = init.outputFps?.den ?? fpsDen;
  const encoderConfig =
    init.encoderConfig ??
    defaultEncoderConfig(comp.width, comp.height, outFpsNum / outFpsDen);
```

Then in the `startReq` object (line 121-128), add the fps fields:

```ts
  const startReq: Extract<ExportRequest, { type: "start" }> = {
    type: "start",
    project: snapshot,
    startUs,
    endUs,
    encoderConfig,
    outputFpsNum: outFpsNum,
    outputFpsDen: outFpsDen,
    canvas: offscreen,
  };
```

- [ ] **Step 2.5: Note on the OffscreenCanvas — leave it at composition size**

Do **not** change the `OffscreenCanvas` allocation (`runExport.ts:107`, `new OffscreenCanvas(comp.width, comp.height)`). The render target stays at composition resolution; resolution scaling is a downscale blit in the Worker (Task 4). The target dimensions live in `encoderConfig.width/height`.

- [ ] **Step 3: Typecheck the worker files compile in isolation**

Run (from `apps/desktop/`): `npx tsc --noEmit src/render/worker/runExport.ts src/render/worker/protocol.ts 2>&1 | Select-String "runExport|protocol"`
Expected: no errors referencing these two files for the new fields. (Project-wide `tsc -b` is red for unrelated reasons; only confirm these edits don't add new errors.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render/worker/runExport.ts apps/desktop/src/render/worker/protocol.ts
git commit -m "feat(export): thread output fps through worker protocol; fix hardcoded framerate"
```

---

## Task 4: Worker — re-parameterize fps grid + downscale blit

**Files:**
- Modify: `apps/desktop/src/render/worker/exportWorker.ts:133-145` (encoder + frame grid), `:221-257` (capture loop)

This is the highest-regression task: every change runs through the one proven H.264 path. Make the edits exactly; the baseline smoke (Task 11) must show default settings still produce a valid MP4.

- [ ] **Step 1: Derive output fps and build the encoder + frame grid from it**

In `exportWorker.ts`, replace the encoder + frame-grid block (lines 133-153). Find:

```ts
  // 4. Encoder pipeline.
  const encoder = new EncoderSink({
    config: req.encoderConfig,
    width: req.project.width,
    height: req.project.height,
    fpsNum: req.project.fpsNum,
    fpsDen: req.project.fpsDen,
  });

  // 5. Frame grid.
  const frameDurUs = Math.round(
    (1_000_000 * req.project.fpsDen) / req.project.fpsNum,
  );
  const startUs = Math.max(0, req.startUs);
  const endUs = Math.min(req.project.durationUs, req.endUs);
  const totalFrames = Math.max(0, Math.ceil((endUs - startUs) / frameDurUs));
  // 1-second IDR cadence to match the master proxy's GOP density.
  const gop = Math.max(
    1,
    Math.round(req.project.fpsNum / Math.max(1, req.project.fpsDen)),
  );
```

Replace with (output fps drives the grid, GOP, and encoder; encoder dims come from the config):

```ts
  // Output fps: caller override (resolution/fps dialog) or composition fps.
  const outFpsNum = req.outputFpsNum ?? req.project.fpsNum;
  const outFpsDen = req.outputFpsDen ?? req.project.fpsDen;

  // Target output dimensions are the ENCODER's dimensions, which may be a
  // downscale of the composition render size. The render target (canvas /
  // compositor / app) stays at composition size; we blit down at capture.
  const outWidth = req.encoderConfig.width;
  const outHeight = req.encoderConfig.height;
  const needsScale =
    outWidth !== req.project.width || outHeight !== req.project.height;

  // 4. Encoder pipeline. Dims/fps come from the encoder config + output fps.
  const encoder = new EncoderSink({
    config: req.encoderConfig,
    width: outWidth,
    height: outHeight,
    fpsNum: outFpsNum,
    fpsDen: outFpsDen,
  });

  // 5. Frame grid — driven by OUTPUT fps. The grid is time-based, so a lower
  // output fps naturally samples fewer composition frames (drops); a higher
  // one duplicates. No frame-resampling machinery needed.
  const frameDurUs = Math.round((1_000_000 * outFpsDen) / outFpsNum);
  const startUs = Math.max(0, req.startUs);
  const endUs = Math.min(req.project.durationUs, req.endUs);
  const totalFrames = Math.max(0, Math.ceil((endUs - startUs) / frameDurUs));
  // 1-second IDR cadence at the OUTPUT fps.
  const gop = Math.max(1, Math.round(outFpsNum / Math.max(1, outFpsDen)));

  // Reusable downscale target — allocated once, drawn into per frame.
  const scaleCanvas = needsScale
    ? new OffscreenCanvas(outWidth, outHeight)
    : null;
  const scaleCtx = scaleCanvas
    ? scaleCanvas.getContext("2d", { alpha: false })
    : null;
```

- [ ] **Step 2: Capture from the scaled canvas when downscaling**

In the per-frame capture (lines 249-257), find:

```ts
      const capT0 = performance.now();
      const captured = new VideoFrame(
        req.canvas as unknown as CanvasImageSource,
        {
          timestamp: tUs - startUs,
          duration: frameDurUs,
        },
      );
      captureMs += performance.now() - capT0;
```

Replace with (blit comp-sized canvas → target-sized canvas before constructing the VideoFrame; the VideoFrame dims MUST match the encoder config):

```ts
      const capT0 = performance.now();
      let source: CanvasImageSource = req.canvas as unknown as CanvasImageSource;
      if (scaleCtx && scaleCanvas) {
        scaleCtx.drawImage(
          req.canvas as unknown as CanvasImageSource,
          0,
          0,
          outWidth,
          outHeight,
        );
        source = scaleCanvas as unknown as CanvasImageSource;
      }
      const captured = new VideoFrame(source, {
        timestamp: tUs - startUs,
        duration: frameDurUs,
      });
      captureMs += performance.now() - capT0;
```

- [ ] **Step 3: Confirm no other site reads composition fps for grid math**

Run: `Grep` for `req.project.fpsNum` and `req.project.fpsDen` in `exportWorker.ts`. Expected remaining uses: only inside the snapshot/compositor setup, NOT in the frame grid, GOP, or capture. If any grid/GOP/capture site still references `req.project.fps*`, switch it to `outFps*`. (The progress-time math in `App.tsx` already derives its own fps from the returned result — handled in Task 5/8.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/render/worker/exportWorker.ts
git commit -m "feat(export): output-fps frame grid + downscale-blit capture in worker"
```

---

## Task 5: Thread `encoderConfig` + `outputFps` through the preview handles

**Files:**
- Modify: `apps/desktop/src/render/pixiPreviewFlag.ts:13-49`
- Modify: `apps/desktop/src/render/PixiPreview.tsx:79-85` and `:252-283`
- Modify: `apps/desktop/src/preview/PreviewSurface.tsx:42-48` and `:78-84`

- [ ] **Step 1: Extend the handle option + result types**

In `apps/desktop/src/render/pixiPreviewFlag.ts`, replace the `runExport` option block (lines 46-48) of `PixiPreviewHandle`:

```ts
  runExport(opts?: {
    onProgress?: (encoded: number, total: number) => void;
    /// Full encoder config (codec/dims/bitrate/bitrateMode/framerate). When
    /// omitted, the worker falls back to its 1080p H.264 default.
    encoderConfig?: VideoEncoderConfig;
    /// Output fps rational (overrides composition fps). Omit ⇒ comp fps.
    outputFps?: { num: number; den: number };
  }): Promise<PixiExportResult>;
```

The `PixiExportResult` already carries `fpsNum/fpsDen` (lines 13-22) — these will now report the **output** fps (set in Step 2) so `App` computes the right duration.

- [ ] **Step 2: Forward the new opts in PixiPreview and return output fps**

In `apps/desktop/src/render/PixiPreview.tsx`, update the handle's `runExport` (lines 79-85):

```ts
      runExport(opts) {
        return handlePixiExport(
          opts,
          compositorRef.current,
          engineRef.current,
        );
      },
```

Then update `handlePixiExport` (lines 252-283). Change its signature and the `runExport` call + return:

```ts
async function handlePixiExport(
  opts:
    | {
        onProgress?: (encoded: number, total: number) => void;
        encoderConfig?: VideoEncoderConfig;
        outputFps?: { num: number; den: number };
      }
    | undefined,
  compositor: Compositor | null,
  engine: PlaybackEngine | null,
): Promise<PixiExportResult> {
  const store = useProjectStore.getState();
  const summary = store.summary;
  if (!summary) {
    throw new Error("No project loaded");
  }
  // Suspend the preview compositor so its VideoDecoder releases the
  // hardware video-decode slot. The export Worker's decoder otherwise
  // wedges fighting for the same slot. Engine is paused first so its
  // rAF loop can't squeeze in another setAnchorTime tick before
  // suspend takes effect.
  const wasPlaying = engine?.isPlaying() ?? false;
  engine?.pause();
  compositor?.setSuspended(true);

  try {
    const result = await runExport({
      summary,
      mediaById: store.mediaById,
      onProgress: opts?.onProgress,
      encoderConfig: opts?.encoderConfig,
      outputFps: opts?.outputFps,
    });
    const outFpsNum = opts?.outputFps?.num ?? summary.composition.fps_num;
    const outFpsDen = opts?.outputFps?.den ?? summary.composition.fps_den;
    return {
      videoBytes: result.videoBytes,
      framesEncoded: result.framesEncoded,
      totalFrames: result.totalFrames,
      fpsNum: outFpsNum,
      fpsDen: outFpsDen,
    };
  } finally {
    compositor?.setSuspended(false);
    // Force re-init: the engine's rAF loop will re-acquire decoders
    // via ensureClip on its next tick, but kick the compositor once
```

(Leave the rest of the `finally` block unchanged; `wasPlaying` keeps its existing use below.)

- [ ] **Step 3: Extend PreviewSurface's handle signature**

In `apps/desktop/src/preview/PreviewSurface.tsx`, update the `runPixiExport` type (lines 45-47):

```ts
  runPixiExport(opts?: {
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
  }): Promise<PixiExportResult>;
```

The implementation (line 78-84) already passes `opts` straight through (`return handle.runExport(opts)`) — no change needed there.

- [ ] **Step 4: Typecheck these files don't add new errors**

Run (from `apps/desktop/`): `npx tsc --noEmit 2>&1 | Select-String "pixiPreviewFlag|PixiPreview|PreviewSurface"`
Expected: no NEW errors referencing the threaded `encoderConfig`/`outputFps` fields. (Pre-existing project-wide errors are unrelated.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/pixiPreviewFlag.ts apps/desktop/src/render/PixiPreview.tsx apps/desktop/src/preview/PreviewSurface.tsx
git commit -m "feat(export): thread encoderConfig + outputFps through preview handles"
```

---

## Task 6: Per-workspace persistence (Rust store + commands + IPC bindings)

**Files:**
- Create: `apps/desktop/src-tauri/src/export_settings_store.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs:1483-1504` (add commands after `view_state_set`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:1` area (declare module) + `:113-114` (register commands)
- Modify: `apps/desktop/src/ipc/index.ts:519-532` (bindings)

Export settings are stored as an **opaque JSON blob** — Rust never interprets them (the encoder config is built in the webview). A separate `export.json` (not `view.json`) avoids the timeline's whole-file `view_state_set` writer clobbering them.

- [ ] **Step 1: Write the Rust store with tests**

Create `apps/desktop/src-tauri/src/export_settings_store.rs`:

```rust
//! Per-workspace export settings persisted as `<workspace>/export.json`.
//!
//! Opaque to Rust: the webview owns the schema (codec/resolution/quality/etc).
//! This is a dumb typed key/value — the encoder config is assembled in the
//! webview and never round-trips through here. Kept in a SEPARATE file from
//! `view.json` so the timeline's whole-file view-state writer can never
//! clobber export settings (two independent writers, one file = data loss).
//!
//! Atomic write pattern mirrors `view_state.rs` (temp file + rename).

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

const EXPORT_FILE: &str = "export.json";

/// Read export settings from `<workspace>/export.json`. Returns `None` if the
/// file is missing, empty, or unreadable — the webview falls back to defaults.
pub fn load(workspace: &Path) -> Option<serde_json::Value> {
    let path = workspace.join(EXPORT_FILE);
    if !path.exists() {
        return None;
    }
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("export_settings read failed ({}): {e:#}", path.display());
            return None;
        }
    };
    if body.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("export_settings parse failed ({}): {e:#}", path.display());
            None
        }
    }
}

/// Atomically write export settings to `<workspace>/export.json`.
pub fn save(workspace: &Path, settings: &serde_json::Value) -> Result<()> {
    fs::create_dir_all(workspace)
        .with_context(|| format!("create {}", workspace.display()))?;
    let path = workspace.join(EXPORT_FILE);
    let json = serde_json::to_string_pretty(settings).context("serialize export settings")?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("promote {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn none_when_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(load(tmp.path()).is_none());
    }

    #[test]
    fn round_trip() {
        let tmp = TempDir::new().unwrap();
        let value = serde_json::json!({ "codec": "av1", "quality": "high" });
        save(tmp.path(), &value).unwrap();
        assert_eq!(load(tmp.path()), Some(value));
    }

    #[test]
    fn none_on_garbage() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(EXPORT_FILE), "{ not json").unwrap();
        assert!(load(tmp.path()).is_none());
    }
}
```

- [ ] **Step 2: Declare the module + register commands in lib.rs**

In `apps/desktop/src-tauri/src/lib.rs`, add the module declaration alongside the other `mod` lines near the top (e.g. next to `mod view_state;` if present, or with the other top-level modules):

```rust
mod export_settings_store;
```

Then in the `generate_handler![...]` list (lines 113-114), add the two new commands after `view_state_set`:

```rust
            commands::view_state_get,
            commands::view_state_set,
            commands::export_settings_get,
            commands::export_settings_set,
```

- [ ] **Step 3: Add the commands in commands.rs**

In `apps/desktop/src-tauri/src/commands.rs`, after `view_state_set` (ends ~line 1504), add:

```rust
#[tauri::command]
pub async fn export_settings_get(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(ws) = workspace.current() else {
        return Ok(None);
    };
    Ok(crate::export_settings_store::load(&ws))
}

#[tauri::command]
pub async fn export_settings_set(
    workspace: State<'_, crate::workspace::WorkspaceSlot>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let Some(ws) = workspace.current() else {
        // Pre-workspace (blank-on-boot): silently drop, like view_state_set.
        return Ok(());
    };
    crate::export_settings_store::save(&ws, &settings).map_err(|e| format!("{e:#}"))
}
```

- [ ] **Step 4: Run the Rust tests**

Run (from `apps/desktop/src-tauri/`): `cargo test export_settings_store`
Expected: PASS — `none_when_missing`, `round_trip`, `none_on_garbage`.

- [ ] **Step 5: Add the TS IPC bindings**

In `apps/desktop/src/ipc/index.ts`, after `viewStateSet` (line 532), add (importing the type from the render module):

```ts
import type { ExportSettings } from "../render/exportSettings";

export async function exportSettingsGet(): Promise<ExportSettings | null> {
  const v = await invoke<ExportSettings | null>("export_settings_get");
  return v ?? null;
}

export async function exportSettingsSet(
  settings: ExportSettings,
): Promise<void> {
  return invoke<void>("export_settings_set", { settings });
}
```

(Place the `import type` with the other top-of-file imports if the file groups them there; otherwise an inline `import type` near the functions is acceptable in this codebase. Match the file's existing import style.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/export_settings_store.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/ipc/index.ts
git commit -m "feat(export): per-workspace export.json persistence (Rust store + IPC)"
```

---

## Task 7: The Export Settings dialog component

**Files:**
- Create: `apps/desktop/src/panels/ExportSettingsDialog.tsx`

This component is presentational + local state. It loads saved settings on mount, probes codecs, owns the path (Browse → save dialog), shows the live estimated size, runs a smoke when AV1/HEVC is selected, persists on confirm, and calls `onConfirm(settings, path)`.

- [ ] **Step 1: Write the component**

Create `apps/desktop/src/panels/ExportSettingsDialog.tsx`:

```tsx
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet } from "../ipc";
import { probeEncoderSupported, smokeEncode } from "../render/exportCodecProbe";
import {
  type CodecId,
  type ExportSettings,
  type QualityPreset,
  type RateMode,
  computeBitrate,
  downscaleFpsOptions,
  downscaleHeightOptions,
  estimateBytes,
  formatBytes,
  mergeSettings,
  resolveOutputDims,
} from "../render/exportSettings";

interface Comp {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

interface Props {
  comp: Comp;
  durationUs: number;
  hasAudio: boolean;
  onCancel: () => void;
  onConfirm: (settings: ExportSettings, path: string) => void;
}

const ALL_CODECS: CodecId[] = ["h264", "av1", "hevc"];

export function ExportSettingsDialog({
  comp,
  durationUs,
  hasAudio,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [path, setPath] = useState<string>("");
  const [supported, setSupported] = useState<Set<CodecId>>(new Set(["h264"]));
  const [smokeFailed, setSmokeFailed] = useState<CodecId | null>(null);
  const [busy, setBusy] = useState(false);

  const compFps = comp.fps_num / comp.fps_den;

  // Load saved settings (per project) on mount.
  useEffect(() => {
    let cancelled = false;
    exportSettingsGet()
      .then((saved) => {
        if (!cancelled) setSettings(mergeSettings(saved));
      })
      .catch(() => {
        if (!cancelled) setSettings(mergeSettings(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe codecs once (uses composition dims as the representative case).
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      ALL_CODECS.map(async (c) => ({
        c,
        ok: await probeEncoderSupported(c, comp.width, comp.height, compFps),
      })),
    ).then((results) => {
      if (cancelled) return;
      setSupported(new Set(results.filter((r) => r.ok).map((r) => r.c)));
    });
    return () => {
      cancelled = true;
    };
  }, [comp.width, comp.height, compFps]);

  const dims = useMemo(
    () => (settings ? resolveOutputDims(comp, settings) : null),
    [comp, settings],
  );
  const outFps = useMemo(
    () => (settings?.fps != null ? settings.fps : compFps),
    [settings, compFps],
  );
  const estimate = useMemo(() => {
    if (!settings || !dims) return 0;
    const bitrate = computeBitrate(settings, dims.width, dims.height, outFps);
    return estimateBytes(bitrate, durationUs, hasAudio);
  }, [settings, dims, outFps, durationUs, hasAudio]);

  if (!settings) return null;

  const patch = (p: Partial<ExportSettings>) =>
    setSettings((s) => (s ? { ...s, ...p } : s));

  async function onSelectCodec(codec: CodecId) {
    patch({ codec });
    setSmokeFailed(null);
    if (codec !== "h264") {
      setBusy(true);
      const ok = await smokeEncode(codec, comp.width, comp.height, compFps);
      setBusy(false);
      if (!ok) setSmokeFailed(codec);
    }
  }

  async function onBrowse() {
    const chosen = await saveDialog({
      title: t("export_dialog.choose_path"),
      defaultPath: "weftcut-export.mp4",
      filters: [{ name: t("dialogs.export_filter"), extensions: ["mp4"] }],
    });
    if (typeof chosen === "string") setPath(chosen);
  }

  async function onExport() {
    if (!path) return;
    await exportSettingsSet(settings!).catch(() => {});
    onConfirm(settings!, path);
  }

  const canExport = !!path && !busy && !smokeFailed;

  return (
    <aside className="export-settings-dialog" role="dialog" aria-modal="true">
      <h2>{t("export_dialog.title")}</h2>

      <label>
        {t("export_dialog.resolution")}
        <select
          value={settings.resolutionHeight ?? ""}
          onChange={(e) =>
            patch({
              resolutionHeight: e.target.value
                ? Number(e.target.value)
                : null,
            })
          }
        >
          <option value="">
            {t("export_dialog.follow_comp")} ({comp.width}×{comp.height})
          </option>
          {downscaleHeightOptions(comp.height).map((h) => (
            <option key={h} value={h}>
              {h}p
            </option>
          ))}
        </select>
      </label>

      <label>
        {t("export_dialog.fps")}
        <select
          value={settings.fps ?? ""}
          onChange={(e) =>
            patch({ fps: e.target.value ? Number(e.target.value) : null })
          }
        >
          <option value="">
            {t("export_dialog.follow_comp")} ({compFps.toFixed(2)})
          </option>
          {downscaleFpsOptions(compFps).map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>

      <label>
        {t("export_dialog.codec")}
        <select
          value={settings.codec}
          onChange={(e) => void onSelectCodec(e.target.value as CodecId)}
        >
          {ALL_CODECS.filter((c) => supported.has(c)).map((c) => (
            <option key={c} value={c}>
              {c === "h264" ? "H.264" : c === "av1" ? "AV1" : "HEVC"}
            </option>
          ))}
        </select>
      </label>
      {busy && <p className="hint">{t("export_dialog.checking_codec")}</p>}
      {smokeFailed && (
        <p className="error">
          {t("export_dialog.codec_unsupported", {
            codec: smokeFailed.toUpperCase(),
          })}
        </p>
      )}

      <label>
        {t("export_dialog.quality")}
        <select
          value={settings.quality}
          onChange={(e) =>
            patch({ quality: e.target.value as QualityPreset })
          }
        >
          <option value="low">{t("export_dialog.quality_low")}</option>
          <option value="medium">{t("export_dialog.quality_medium")}</option>
          <option value="high">{t("export_dialog.quality_high")}</option>
          <option value="custom">{t("export_dialog.quality_custom")}</option>
        </select>
      </label>
      {settings.quality === "custom" && (
        <label>
          {t("export_dialog.custom_bitrate")}
          <input
            type="number"
            min={500}
            step={500}
            value={
              settings.customBitrate ? settings.customBitrate / 1_000_000 : ""
            }
            onChange={(e) =>
              patch({
                customBitrate: e.target.value
                  ? Math.round(Number(e.target.value) * 1_000_000)
                  : null,
              })
            }
          />
          {t("export_dialog.mbps")}
        </label>
      )}

      <label>
        {t("export_dialog.rate_mode")}
        <select
          value={settings.rateMode}
          onChange={(e) => patch({ rateMode: e.target.value as RateMode })}
        >
          <option value="vbr">VBR</option>
          <option value="cbr">CBR</option>
        </select>
      </label>

      <p className="estimate">
        {t("export_dialog.estimated_size", { size: formatBytes(estimate) })}
      </p>

      <label>
        {t("export_dialog.output_path")}
        <input type="text" readOnly value={path} />
        <button onClick={() => void onBrowse()}>
          {t("export_dialog.browse")}
        </button>
      </label>

      <div className="actions">
        <button onClick={onCancel}>{t("export_dialog.cancel")}</button>
        <button disabled={!canExport} onClick={() => void onExport()}>
          {t("export_dialog.export")}
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Sanity-typecheck the component in isolation**

Run (from `apps/desktop/`): `npx tsc --noEmit 2>&1 | Select-String "ExportSettingsDialog"`
Expected: no NEW errors from this file (it depends only on Task 1/2/6 exports + existing i18n/dialog plugins). i18n keys are added in Task 10.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/panels/ExportSettingsDialog.tsx
git commit -m "feat(export): export settings dialog component"
```

---

## Task 8: Wire the dialog into App.tsx (menu, config assembly, fallback)

**Files:**
- Modify: `apps/desktop/src/App.tsx` — imports, new state, menu item (`:1214-1225`), extract `runExportWithSettings`, render the dialog (`:1406-1413` area).

- [ ] **Step 1: Import the dialog + settings helpers**

Add to the imports at the top of `apps/desktop/src/App.tsx` (with the other panel + render imports):

```ts
import { ExportSettingsDialog } from "./panels/ExportSettingsDialog";
import {
  type ExportSettings,
  codecString,
  computeBitrate,
  resolveOutputDims,
} from "./render/exportSettings";
```

- [ ] **Step 2: Add dialog open-state next to `exportState`**

Find `const [exportState, setExportState] = useState<ExportState | null>(null);` (App.tsx:121). Add below it:

```ts
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
```

- [ ] **Step 3: Extract the gate+render body into `runExportWithSettings`**

Replace the current `runPixiExport` (App.tsx:774-955). Keep the entire readiness-gate + temp-file + render + mux body **unchanged**, but: (a) rename it to `runExportWithSettings`, (b) it now takes `(settings, path)` instead of opening the save dialog, (c) build the encoder config and pass it to `previewRef.current.runPixiExport`, (d) wrap the render in a try/catch that falls back to H.264 on a thrown encoder error.

Change the function header — delete the save-dialog block (lines 775-782) and replace with the new signature:

```ts
  // Pixi/WebCodecs export driven by the settings dialog. Three-stage pipeline:
  //   1. PreviewSurface drives the Worker → video-only MP4 bytes.
  //   2. Rust audio-only export → sibling .m4a.
  //   3. Rust stream-copy mux → user-chosen path.
  // AV1/HEVC that throw at encode time fall back to H.264 (codec probe +
  // selection-time smoke catch most failures up front; this is the net).
  const runExportWithSettings = useCallback(
    async (settings: ExportSettings, path: string) => {
      // (the existing readiness-gate block stays here verbatim — it already
      // uses `useProjectStore.getState()` for proj/media, not the deleted
      // save dialog)
```

Keep the readiness-gate block (old lines 784-872) exactly as-is. After the gate, replace the render block (old lines 874-920) with config assembly + fallback-capable render:

```ts
    // Allocate unique temp paths up-front so cleanup in `finally`
    // can hit them whether or not the respective stage completed.
    const tempBase = await tempDir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempVideoPath = await join(tempBase, `weftcut-pixi-${stamp}.mp4`);
    const tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.m4a`);

    const comp = useProjectStore.getState().summary!.composition;

    // Build the encoder config from the dialog settings.
    const buildConfig = (codec: ExportSettings["codec"]): {
      config: VideoEncoderConfig;
      outputFps: { num: number; den: number };
    } => {
      const dims = resolveOutputDims(comp, { ...settings, codec });
      const fpsNum = settings.fps != null ? settings.fps : comp.fps_num;
      const fpsDen = settings.fps != null ? 1 : comp.fps_den;
      const bitrate = computeBitrate(
        { ...settings, codec },
        dims.width,
        dims.height,
        fpsNum / fpsDen,
      );
      return {
        config: {
          codec: codecString(codec),
          width: dims.width,
          height: dims.height,
          bitrate,
          framerate: fpsNum / fpsDen,
          bitrateMode: settings.rateMode === "cbr" ? "constant" : "variable",
          hardwareAcceleration: "prefer-hardware",
        },
        outputFps: { num: fpsNum, den: fpsDen },
      };
    };

    const onProgress = (encoded: number, total: number) => {
      if (total <= 0) return;
      const elapsedSec = (performance.now() - startedAtMs) / 1000;
      const fps = elapsedSec > 0 ? encoded / elapsedSec : 0;
      const summary = useProjectStore.getState().summary;
      const fpsNum = summary?.composition.fps_num ?? 30;
      const fpsDen = summary?.composition.fps_den ?? 1;
      const frameDurUs = Math.round((1_000_000 * fpsDen) / fpsNum);
      const currentTimeUs = encoded * frameDurUs;
      const speed = elapsedSec > 0 ? currentTimeUs / 1e6 / elapsedSec : 0;
      setExportState({
        kind: "progress",
        progress: { progress: encoded / total, currentTimeUs, frame: encoded, fps, speed },
      });
    };

    setExportState({ kind: "starting" });
    const startedAtMs = performance.now();
    let result;
    try {
      const { config, outputFps } = buildConfig(settings.codec);
      result = await previewRef.current?.runPixiExport({
        onProgress,
        encoderConfig: config,
        outputFps,
      });
    } catch (e) {
      // Runtime fallback: a thrown encode error on AV1/HEVC retries once with
      // H.264 (the correctness net behind the up-front probe + smoke).
      if (settings.codec !== "h264") {
        console.warn("[weftcut/export] codec failed, falling back to H.264:", e);
        setExportState({ kind: "starting" });
        try {
          const { config, outputFps } = buildConfig("h264");
          result = await previewRef.current?.runPixiExport({
            onProgress,
            encoderConfig: config,
            outputFps,
          });
        } catch (e2) {
          const msg = e2 instanceof Error ? e2.message : String(e2);
          setExportState({ kind: "error", detail: msg });
          return;
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] export failed:", e);
        setExportState({ kind: "error", detail: msg });
        return;
      }
    }
```

Keep the rest (old lines 914-955: the `if (!result)` guard, the write/audio/mux `try`, the `finally` cleanup, and the final `setExportState({ kind: "complete", ... })`) **unchanged**. Close the `useCallback` with the dependency array:

```ts
    },
    [t],
  );
```

- [ ] **Step 4: Point the menu item at the dialog**

In the export menu item (App.tsx:1214-1225), change `onSelect={runPixiExport}` to open the dialog:

```tsx
            <Menu label={t("menu.export")}>
              <MenuItem
                actionId="export"
                label={t("actions.export")}
                onSelect={() => setExportDialogOpen(true)}
                disabled={
                  exportState?.kind === "starting" ||
                  exportState?.kind === "progress"
                }
              />
```

(If any other call site referenced `runPixiExport` — e.g. a keyboard action map — repoint it to `() => setExportDialogOpen(true)`. Search: `Grep` for `runPixiExport` in `App.tsx`.)

- [ ] **Step 5: Render the dialog**

Near the existing `{exportState && (<ExportPanel .../>)}` block (App.tsx:1406), add the settings dialog above it:

```tsx
      {exportDialogOpen && summary && (
        <ExportSettingsDialog
          comp={summary.composition}
          durationUs={summary.duration_us}
          hasAudio={projectHasAudio(summary)}
          onCancel={() => setExportDialogOpen(false)}
          onConfirm={(settings, path) => {
            setExportDialogOpen(false);
            void runExportWithSettings(settings, path);
          }}
        />
      )}
```

For `hasAudio`: if a helper already exists, use it. Otherwise add a tiny local helper near the top of the module (a project may store audio layers per track):

```ts
function projectHasAudio(summary: ProjectSummary): boolean {
  return summary.tracks.some((tr) =>
    tr.layers.some((l) => l.kind === "Audio" || l.kind === "Video"),
  );
}
```

(Verify the exact `ProjectSummary` track/layer shape and the audio-layer discriminant by reading `apps/desktop/src/ipc/index.ts` for `ProjectSummary`/`LayerSummary` before writing this helper — adjust the predicate to match. If uncertain, default `hasAudio` to `true`: it only nudges the size estimate, never correctness.)

- [ ] **Step 6: Typecheck App.tsx for new errors**

Run (from `apps/desktop/`): `npx tsc --noEmit 2>&1 | Select-String "App.tsx"`
Expected: no NEW errors from the wiring (pre-existing project-wide errors unrelated).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(export): wire settings dialog into App (config assembly + H.264 fallback)"
```

---

## Task 9: Verify the default-export baseline logic is preserved (no-regression unit check)

**Files:**
- Test: `apps/desktop/src/render/exportSettings.test.ts` (append)

A cheap guard that the DEFAULT settings assemble to a config equivalent to today's hardcoded default (`avc1.640028`, ~8 Mbps, comp dims, VBR-by-omission). This catches accidental drift in the bpp constants or codec string.

- [ ] **Step 1: Append the baseline test**

Add to `apps/desktop/src/render/exportSettings.test.ts`:

```ts
import { DEFAULT_EXPORT_SETTINGS as DEF } from "./exportSettings";

describe("default-export baseline", () => {
  it("default settings at 1080p30 H.264 match today's hardcoded config", () => {
    const comp = { width: 1920, height: 1080 };
    const dims = resolveOutputDims(comp, DEF);
    expect(dims).toEqual({ width: 1920, height: 1080 });
    expect(codecString(DEF.codec)).toBe("avc1.640028");
    const bitrate = computeBitrate(DEF, dims.width, dims.height, 30);
    // Today's hardcoded default was a flat 8 Mbps.
    expect(Math.abs(bitrate - 8_000_000)).toBeLessThan(500_000);
    // VBR by default → bitrateMode "variable" (set in App; documented here).
    expect(DEF.rateMode).toBe("vbr");
  });
});
```

- [ ] **Step 2: Run it**

Run (from `apps/desktop/`): `npm test -- exportSettings`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/render/exportSettings.test.ts
git commit -m "test(export): guard default-settings config equals today's baseline"
```

---

## Task 10: i18n strings (en-US + zh-CN)

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` (after the `export:` block, ~line 242)
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts` (mirror the same key path)

- [ ] **Step 1: Add the English strings**

In `apps/desktop/src/i18n/locales/en-US.ts`, after the `export: { ... }` block (closes ~line 242), add a sibling key:

```ts
  export_dialog: {
    title: "Export settings",
    resolution: "Resolution",
    fps: "Frame rate",
    follow_comp: "Follow composition",
    codec: "Codec",
    checking_codec: "Checking codec support…",
    codec_unsupported:
      "{{codec}} can't be encoded on this machine — pick another codec.",
    quality: "Quality",
    quality_low: "Low",
    quality_medium: "Medium",
    quality_high: "High",
    quality_custom: "Custom",
    custom_bitrate: "Bitrate",
    mbps: "Mbps",
    rate_mode: "Rate control",
    estimated_size: "Estimated size: {{size}}",
    output_path: "Output path",
    browse: "Browse…",
    choose_path: "Choose export location",
    cancel: "Cancel",
    export: "Export",
  },
```

- [ ] **Step 2: Add the Chinese strings**

In `apps/desktop/src/i18n/locales/zh-CN.ts`, add the mirroring block at the same key path:

```ts
  export_dialog: {
    title: "导出设置",
    resolution: "分辨率",
    fps: "帧率",
    follow_comp: "跟随合成",
    codec: "编码",
    checking_codec: "正在检测编码支持…",
    codec_unsupported: "本机无法编码 {{codec}}——请换一种编码。",
    quality: "质量",
    quality_low: "低",
    quality_medium: "中",
    quality_high: "高",
    quality_custom: "自定义",
    custom_bitrate: "码率",
    mbps: "Mbps",
    rate_mode: "码率控制",
    estimated_size: "预计大小：{{size}}",
    output_path: "输出路径",
    browse: "浏览…",
    choose_path: "选择导出位置",
    cancel: "取消",
    export: "导出",
  },
```

- [ ] **Step 3: Verify both locale files still parse**

Run (from `apps/desktop/`): `npx tsc --noEmit 2>&1 | Select-String "locales"`
Expected: no NEW errors from the locale files (e.g. no trailing-comma / brace mismatch).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(export): i18n strings for the export settings dialog"
```

---

## Task 11: Manual smoke verification (`tauri dev`, real WebView2)

**There is no automated gate for the worker/dialog integration.** Run the app and walk the checklist. Record pass/fail for each.

- [ ] **Step 1: Launch the app**

Run (from `apps/desktop/`): `npm run tauri dev`
Open a project that has at least one video clip and audio, on a **30 fps, 1920×1080** composition (so the default path is directly comparable to today).

- [ ] **Step 2: Baseline regression — default settings == today**

1. Click *Export*. Dialog opens with: Resolution "Follow composition (1920×1080)", Frame rate "Follow composition (30.00)", Codec "H.264", Quality "Medium", Rate "VBR".
2. Browse → choose `baseline.mp4`. Estimated size shows ~ (8 Mbps × duration).
3. Click Export. The existing progress panel runs; completes.
4. Confirm `baseline.mp4` plays, has audio, correct duration, and looks like a normal H.264 export (this is the "same as today" check).

Expected: PASS — identical behavior to the pre-change export.

- [ ] **Step 3: Codec probe + AV1**

1. Open the dialog again. If AV1 appears in the Codec dropdown, select it (a brief "Checking codec support…" smoke runs).
2. If the smoke passes, export `av1.mp4`. Confirm it plays and is **noticeably smaller** than `baseline.mp4` (codec-aware bitrate).
3. If AV1 is absent or the smoke fails, that machine can't encode AV1 — confirm the dropdown simply doesn't offer it / shows the unsupported message. Expected behavior either way.

- [ ] **Step 4: AV1/HEVC-in-MP4 survives the Rust `-c copy` mux**

This codec-in-MP4-through-`ffmpeg -c copy` combination is unexercised today. After a successful AV1 (or HEVC) export in Step 3, confirm the **final muxed file plays with audio** (not just the temp video). If the mux fails, the error surfaces in the panel — capture the ffmpeg stderr tail from the status log.

- [ ] **Step 5: Resolution downscale**

1. Dialog → Resolution → 720p. Export `720.mp4`.
2. Confirm output is exactly **1280×720** (e.g. `ffprobe 720.mp4` or file properties), even dimensions, content correctly scaled.

- [ ] **Step 6: fps downconvert**

1. On a 30 fps comp, Resolution=follow, Frame rate → 24. Export `fps24.mp4`.
2. Confirm reported frame rate ≈ 24 and **duration matches** the timeline (the frame-grid re-parameterization is correct — a wrong grid shows up as wrong duration).

- [ ] **Step 7: CBR + custom bitrate**

1. Quality → Custom, enter e.g. 12 Mbps; Rate → CBR. Export `cbr.mp4`.
2. Confirm it exports and plays. (Per the design, CBR may be silently ignored by some encoders — note if the measured bitrate isn't constant, but a playable file is still a pass.)

- [ ] **Step 8: Persistence (per project)**

1. Set non-defaults (e.g. AV1 + 720p + High), export.
2. Close and reopen the dialog → fields restore to the last-used values.
3. Confirm `<workspace>/export.json` exists with the blob. Open a **different** project → its dialog shows defaults (or its own saved values), proving per-project scope.

- [ ] **Step 9: Runtime fallback (if a codec can be forced to fail)**

Hard to force on hardware that supports the codec; if you have a machine where `isConfigSupported` lies (reports AV1/HEVC supported but encode throws), select it and export — confirm the export **completes as H.264** (fallback) rather than erroring. Otherwise note this path as "covered by code review only."

- [ ] **Step 10: Record results + commit any fixes**

If any step fails, debug with the systematic-debugging skill, fix, and re-run the affected step. Commit fixes referencing the failing step.

---

## Self-Review checklist (run before handoff)

1. **Spec coverage:** resolution ✓ (T1/T4), fps ✓ (T1/T3/T4), codec ✓ (T1/T2/T8), quality+bpp ✓ (T1), VBR/CBR ✓ (T8 `bitrateMode`), estimated size ✓ (T1/T7), dialog-owns-path ✓ (T7/T8), per-project persistence ✓ (T6), probe+fallback ✓ (T2/T8), i18n ✓ (T10), default-baseline guard ✓ (T9/T11).
2. **Placeholder scan:** every code step has complete code; the two "verify the shape before writing" notes (ProjectSummary audio predicate, import grouping) are explicit verification asks, not hand-waves, with a safe default called out.
3. **Type consistency:** `ExportSettings` shape, `CodecId`, `codecString(codec)` (no resolution arg), `computeBitrate(settings,w,h,fps)`, `resolveOutputDims(comp,settings)`, `runPixiExport({onProgress,encoderConfig,outputFps})`, `outputFps:{num,den}`, worker `outputFpsNum/outputFpsDen` — used identically across T1/T3/T5/T7/T8. `PixiExportResult.fpsNum/fpsDen` now = output fps (T5) feeding `App`'s duration calc.

---

## Execution sequencing note

Build order respects dependencies: T1 (logic) → T2 (probe, uses T1) → T3/T4 (worker, independent of T1/T2) → T5 (handles) → T6 (persistence) → T7 (dialog, uses T1/T2/T6) → T8 (App wiring, uses T3/T5/T7) → T9 (guard) → T10 (i18n) → T11 (smoke). The advisor's priority — **build the runtime H.264 fallback (T8) as the correctness net, the selection-time smoke (T2) as the UX nicety** — is preserved: the fallback in T8 stands alone even if the T2 smoke is skipped.
