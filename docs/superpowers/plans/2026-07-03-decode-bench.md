# decode-bench (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Stage 1 of the permanent decode-strategy benchmark from
`docs/superpowers/specs/2026-07-03-decode-bench-design.md`: fixture generator,
Playwright-`_electron` orchestrator, E2E-gated renderer scenario driver, the
WebCodecs measurement path, CPU/GPU resource sampling, and the `--self-check`
instrument calibration.

**Architecture:** A Node orchestrator (`e2e/scripts/decode-bench.mjs`) launches
the real app (E2E build), calls a renderer-side driver through the existing
`window.__weftcutTest` hook surface, and samples resources from outside. The
driver owns a **private** `SourceDecoderPool` and measures at the
`DecoderHandle` seam (`ensureReady` / `requestFrameAt` / `ring`). Fixtures are
deterministic ffmpeg-synthesized clips. One product-code touch:
`FrameRing.pushCount`.

**Tech Stack:** TypeScript (renderer driver), Node ESM `.mjs` (orchestrator +
fixture gen), Playwright `_electron`, vitest (unit tests), ffmpeg CLI
(fixtures), Windows `typeperf` (GPU counters), Electron `app.getAppMetrics()`.

## Global Constraints

- Fixtures: 60 s `testsrc2`, 30 fps, GOP 240 frames, tagged bt709/limited, no audio.
- Throughput: 2 s warm-up excluded, 30 s measured window (or EOF guard at `durationUs − 1_500_000`), report fps AND ×realtime.
- Seek: 40 fixed targets from a deterministic plan; categories forward-near +0.2 s / forward-far +15 s / backward-near −0.5 s / backward-far −20 s; report P50/P95/max per category.
- Cold start: 10 iterations; iteration 1 reported separately from 2–10.
- Repeats: 3 runs per cell, median reported with spread.
- Self-check: two WebCodecs throughput runs on `h264-1080`; |Δfps|/mean < 5 %.
- Timebox: 90 s per scenario; timeouts recorded, run continues.
- Exit code: non-zero only on harness failure or self-check failure — never on slow results.
- Local-only; never wired into CI.
- Strategy `native` is **Stage 2**: the driver must accept the value and return a structured `error: 'strategy native not integrated (Stage 2)'` result.
- Windows dev-machine commands assume Git Bash (inline `VITE_WEFTCUT_E2E=1` prefix), per `apps/desktop/e2e/README.md`.
- All paths below are relative to the repo root unless absolute.

**Precondition for Tasks 4/6 (one-time, dev machine):** `apps/desktop` must
have a built native addon and an E2E build:

```bash
cd apps/desktop
npm run napi:build        # skip if native/*.node is current; close any running app first (file lock)
npm run fetch-ffmpeg      # ffmpeg on PATH for fixture generation
VITE_WEFTCUT_E2E=1 npm run build
```

---

### Task 1: `FrameRing.pushCount` counter

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/FrameRing.ts`
- Test: `apps/desktop/src/renderer/render/decoder/FrameRing.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FrameRing.pushCount: number` (getter) — monotonic count of frames
  **accepted** into the ring since construction; drops on the
  behind-lookbehind fast-return path do NOT count; never reset by
  `setAnchor`/eviction/`flush`. Task 3's throughput scenario diffs it.
  `SourceHandle.ring` is declared as the concrete `FrameRing`
  (`SourceDecoderPool.ts:267`), so no `FrameStore` interface change — do NOT
  widen `FrameStore` (the export-side store doesn't need this; YAGNI).

- [ ] **Step 1: Write the failing test**

Open `apps/desktop/src/renderer/render/decoder/FrameRing.test.ts`, reuse its
existing ImageBitmap fake (the file already fabricates bitmaps for push tests —
match whatever helper it defines; if none fits, add locally):

```ts
const fakeBitmap = () => ({ close: () => {} }) as unknown as ImageBitmap;

describe("pushCount", () => {
  it("counts accepted pushes and ignores dropped-behind ones", () => {
    const ring = new FrameRing();
    ring.setAnchor(10_000_000);
    // Ends before anchor - lookbehind (10s - 0.5s) → the drop path.
    ring.push(fakeBitmap(), 0, 33_333);
    expect(ring.pushCount).toBe(0);
    ring.push(fakeBitmap(), 10_000_000, 33_333);
    ring.push(fakeBitmap(), 10_033_333, 33_333);
    expect(ring.pushCount).toBe(2);
  });

  it("is not reset by eviction", () => {
    const ring = new FrameRing();
    ring.push(fakeBitmap(), 0, 33_333);
    ring.push(fakeBitmap(), 33_333, 33_333);
    ring.setAnchor(5_000_000); // evicts both
    expect(ring.size()).toBe(0);
    expect(ring.pushCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `npm run test -- FrameRing`
Expected: FAIL — `pushCount` does not exist / is undefined.

- [ ] **Step 3: Implement the counter**

In `FrameRing.ts`, add a private field next to `entries` and a getter; in
`push()` increment **after** the drop check (the early `return` at the top of
`push` must not count):

```ts
  private _pushCount = 0;

  /// Monotonic count of frames accepted into the ring since construction.
  /// Drops (behind the lookbehind window) don't count; eviction and flush
  /// don't reset it. The decode-bench throughput scenario diffs this.
  get pushCount(): number {
    return this._pushCount;
  }
```

```ts
  push(bitmap: ImageBitmap, ptsUs: number, durationUs: number): void {
    // If this frame is already behind the lookbehind window, drop it.
    if (ptsUs + durationUs < this.anchorUs - this.lookbehindUs) {
      bitmap.close();
      return;
    }
    this._pushCount += 1;
    // ... existing body unchanged ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- FrameRing`
Expected: PASS (all pre-existing FrameRing tests too).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/FrameRing.ts apps/desktop/src/renderer/render/decoder/FrameRing.test.ts
git commit -m "feat(decoder): FrameRing.pushCount counter for decode-bench throughput"
```

---

### Task 2: Fixture generator

**Files:**
- Create: `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs`
- Modify: `.gitignore` (repo root, next to the existing e2e-media block at lines 61–63)

**Interfaces:**
- Consumes: `ffmpeg`/`ffprobe` on PATH.
- Produces: fixture files in `apps/desktop/e2e/fixtures/decode-bench/` named
  `<name>.<ext>`, and an exported `BENCH_MATRIX` array
  (`{ name, ext, codec, width, height, durationUs }`) that Task 4 imports to
  know paths and `durationUs`.

- [ ] **Step 1: Write the generator**

```js
// Idempotent decode-bench fixture generator. Synthesizes the spec §2 matrix
// (docs/superpowers/specs/2026-07-03-decode-bench-design.md) with ffmpeg:
// 60 s testsrc2, 30 fps, GOP 240, bt709/limited, no audio. Skips existing
// outputs (delete a file or pass --force to regenerate). Requires ffmpeg +
// ffprobe on PATH (`npm run fetch-ffmpeg` from apps/desktop).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_MEDIA_DIR = path.resolve(HERE, "../fixtures/decode-bench");

const DUR_S = 60;
const COLOR = ["-color_primaries", "bt709", "-color_trc", "bt709",
  "-colorspace", "bt709", "-color_range", "tv"];
const X265_GOP = "keyint=240:min-keyint=240:scenecut=0";

/// One row per spec §2 matrix line. `encoder` is checked against
/// `ffmpeg -encoders` so a lean ffmpeg build degrades to a skip, not a crash.
export const BENCH_MATRIX = [
  { name: "h264-1080", ext: "mp4", codec: "h264", width: 1920, height: 1080, durationUs: DUR_S * 1_000_000, encoder: "libx264",
    args: ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-b:v", "12M",
      "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", "-pix_fmt", "yuv420p"] },
  { name: "hevc-1080", ext: "mp4", codec: "hevc", width: 1920, height: 1080, durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-b:v", "8M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"] },
  { name: "hevc-2160", ext: "mp4", codec: "hevc", width: 3840, height: 2160, durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-b:v", "40M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"] },
  { name: "vp9-1080", ext: "webm", codec: "vp9", width: 1920, height: 1080, durationUs: DUR_S * 1_000_000, encoder: "libvpx-vp9",
    args: ["-c:v", "libvpx-vp9", "-b:v", "8M", "-g", "240",
      "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p"] },
  { name: "av1-1080", ext: "mp4", codec: "av1", width: 1920, height: 1080, durationUs: DUR_S * 1_000_000, encoder: "libsvtav1",
    args: ["-c:v", "libsvtav1", "-preset", "8", "-b:v", "8M",
      "-svtav1-params", "keyint=240", "-pix_fmt", "yuv420p"] },
  // WebCodecs-only reference row (native N/A: Result-7 P010 import block).
  { name: "hi10p-1080", ext: "mp4", codec: "hevc", width: 1920, height: 1080, durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-profile:v", "main10", "-b:v", "8M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"] },
];

export const benchFixturePath = (name) => {
  const row = BENCH_MATRIX.find((r) => r.name === name);
  if (!row) throw new Error(`unknown fixture ${name}`);
  return path.join(BENCH_MEDIA_DIR, `${row.name}.${row.ext}`);
};

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

function availableEncoders() {
  const r = run("ffmpeg", ["-hide_banner", "-encoders"]);
  if (r.status !== 0) throw new Error("ffmpeg not on PATH — run `npm run fetch-ffmpeg` from apps/desktop");
  return r.stdout;
}

function validate(row, file) {
  const r = run("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration",
    "-of", "json", file]);
  if (r.status !== 0) return `ffprobe failed: ${r.stderr}`;
  const j = JSON.parse(r.stdout);
  const s = j.streams?.[0];
  if (s?.codec_name !== row.codec) return `codec ${s?.codec_name} != ${row.codec}`;
  if (s?.width !== row.width || s?.height !== row.height) return `size ${s?.width}x${s?.height}`;
  const dur = Number(j.format?.duration ?? 0);
  if (Math.abs(dur - DUR_S) > 1) return `duration ${dur}s`;
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes("--force");
  mkdirSync(BENCH_MEDIA_DIR, { recursive: true });
  const encoders = availableEncoders();
  let failures = 0;
  for (const row of BENCH_MATRIX) {
    const out = path.join(BENCH_MEDIA_DIR, `${row.name}.${row.ext}`);
    if (existsSync(out) && !force) { console.log(`skip   ${row.name} (exists)`); continue; }
    if (!encoders.includes(row.encoder)) {
      console.warn(`SKIP   ${row.name}: encoder ${row.encoder} not in this ffmpeg build`);
      failures += 1; continue;
    }
    console.log(`encode ${row.name} …`);
    const r = run("ffmpeg", ["-y", "-f", "lavfi",
      "-i", `testsrc2=size=${row.width}x${row.height}:rate=30`,
      "-t", String(DUR_S), "-an", ...row.args, ...COLOR, out]);
    if (r.status !== 0) { console.error(`FAIL   ${row.name}:\n${r.stderr.slice(-2000)}`); rmSync(out, { force: true }); failures += 1; continue; }
    const bad = validate(row, out);
    if (bad) { console.error(`INVALID ${row.name}: ${bad}`); rmSync(out, { force: true }); failures += 1; continue; }
    console.log(`ok     ${row.name}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}
```

- [ ] **Step 2: Add the gitignore block**

Append to the repo-root `.gitignore`, right after the existing
`apps/desktop/e2e/fixtures/media` block (lines 61–63):

```gitignore
# Generated decode-bench fixtures + results (gen-decode-bench-fixtures.mjs / decode-bench.mjs)
apps/desktop/e2e/fixtures/decode-bench/
apps/desktop/e2e/bench-results/
```

- [ ] **Step 3: Run the generator and validate**

Run: `node apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs`
Expected: six `encode <name> … ok <name>` lines (x265 4K and AV1 take a few
minutes on first run), exit 0, six files under
`apps/desktop/e2e/fixtures/decode-bench/`. If an encoder is missing the row
prints `SKIP` and the exit code is 1 — resolve by using the full ffmpeg build
(`npm run fetch-ffmpeg`).

- [ ] **Step 4: Verify idempotency**

Run the same command again.
Expected: six `skip <name> (exists)` lines, exit 0, runs in <1 s.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs .gitignore
git commit -m "feat(e2e): decode-bench fixture generator (spec matrix, idempotent)"
```

---

### Task 3: Renderer scenario driver + hook registration

**Files:**
- Create: `apps/desktop/src/renderer/render/decoder/decodeBench.ts`
- Create: `apps/desktop/src/renderer/render/decoder/decodeBench.test.ts`
- Modify: `apps/desktop/src/renderer/testhook/e2eHook.ts` (new installer + `E2EHook` fields)
- Modify: `apps/desktop/src/renderer/main.tsx:115-128` (call the installer)

**Interfaces:**
- Consumes: `SourceDecoderPool`, `SourceHandle` (`../render/decoder/SourceDecoderPool`
  — `acquire(init: SourceHandleInit): SourceHandle`, `release(layerId)`,
  `dispose()`; `SourceHandle.ring: FrameRing` with `pushCount` from Task 1,
  `lastPtsUs()`, `containsPts(tUs)`); `convertFileSrc(filePath: string): string`
  from `@/bridge/ipc`.
- Produces (Task 4 depends on these exact names via `window.__weftcutTest`):
  - `decodeBenchRun(args: BenchArgs): Promise<BenchResult>`
  - `decodeBenchPhase(): string` — `'idle' | 'setup' | 'warmup' | 'measuring'` (returns to `'idle'` when the run settles)
  - `BenchArgs = { sourcePath: string; durationUs: number; scenario: 'throughput'|'seek'|'coldstart'; strategy: 'webcodecs'|'native' }`
  - `BenchResult` variants as coded below (`kind` discriminant; `kind:'error'` for unsupported/timeout).

- [ ] **Step 1: Write failing unit tests for the pure helpers**

`decodeBench.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { percentile, seekPlan } from "./decodeBench";

describe("percentile", () => {
  it("interpolates on sorted input", () => {
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 95)).toBeCloseTo(3.85, 5);
  });
});

describe("seekPlan", () => {
  const DUR = 60_000_000;
  it("emits exactly 40 targets cycling the four categories", () => {
    const plan = seekPlan(DUR);
    expect(plan).toHaveLength(40);
    expect(plan.map((p) => p.category).slice(0, 4)).toEqual([
      "forward-near", "forward-far", "backward-near", "backward-far",
    ]);
  });
  it("is deterministic and clamped to [0.5s, dur-2s]", () => {
    const a = seekPlan(DUR);
    const b = seekPlan(DUR);
    expect(a).toEqual(b);
    for (const p of a) {
      expect(p.targetUs).toBeGreaterThanOrEqual(500_000);
      expect(p.targetUs).toBeLessThanOrEqual(DUR - 2_000_000);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/desktop`): `npm run test -- decodeBench`
Expected: FAIL — module `./decodeBench` not found.

- [ ] **Step 3: Implement `decodeBench.ts`**

```ts
// E2E-only decode-strategy benchmark driver. Measures at the DecoderHandle
// seam against a PRIVATE SourceDecoderPool (never the Compositor's live one),
// so scenarios are deterministic and UI-independent. Installed on
// window.__weftcutTest by e2eHook.installDecodeBenchHooks; imported only from
// there, so prod bundles tree-shake it out with the rest of the hook surface.
// Spec: docs/superpowers/specs/2026-07-03-decode-bench-design.md
import { convertFileSrc } from "@/bridge/ipc";
import { SourceDecoderPool, type SourceHandle } from "./SourceDecoderPool";

export type BenchStrategy = "webcodecs" | "native";
export type BenchScenario = "throughput" | "seek" | "coldstart";
export interface BenchArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media:// (unconfined by design)
  durationUs: number;
  scenario: BenchScenario;
  strategy: BenchStrategy;
}

export type SeekCategory = "forward-near" | "forward-far" | "backward-near" | "backward-far";
interface CategoryStats { p50: number; p95: number; max: number; n: number }

export type BenchResult =
  | { kind: "throughput"; measuredMs: number; frames: number; fps: number; xRealtime: number; endedAtEof: boolean }
  | { kind: "seek"; perCategory: Record<SeekCategory, CategoryStats> }
  | { kind: "coldstart"; firstMs: number; restP50: number; restMax: number; iterationsMs: number[] }
  | { kind: "error"; error: string };

const WARMUP_MS = 2_000;
const WINDOW_MS = 30_000;
const EOF_GUARD_US = 1_500_000;
const SCENARIO_TIMEBOX_MS = 90_000;
const SEEK_WAIT_TIMEOUT_MS = 30_000;
const COLD_ITERATIONS = 10;

/// Linear-interpolated percentile over an ASCENDING-sorted array.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/// The committed, deterministic 40-step seek plan (spec §3.2): starting from
/// 10 s, cycle the four category deltas ten times, clamping each target into
/// [0.5 s, durationUs − 2 s]; the clamped target becomes the next "current".
const SEEK_DELTAS: Array<[SeekCategory, number]> = [
  ["forward-near", 200_000],
  ["forward-far", 15_000_000],
  ["backward-near", -500_000],
  ["backward-far", -20_000_000],
];
export function seekPlan(durationUs: number): Array<{ category: SeekCategory; targetUs: number }> {
  const lo = 500_000;
  const hi = durationUs - 2_000_000;
  let cur = 10_000_000;
  const plan: Array<{ category: SeekCategory; targetUs: number }> = [];
  for (let round = 0; round < 10; round++) {
    for (const [category, delta] of SEEK_DELTAS) {
      const targetUs = Math.min(hi, Math.max(lo, cur + delta));
      plan.push({ category, targetUs });
      cur = targetUs;
    }
  }
  return plan;
}

let phase = "idle";
export function decodeBenchPhase(): string {
  return phase;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitContains(h: SourceHandle, tUs: number): Promise<void> {
  const t0 = performance.now();
  while (!h.ring.containsPts(tUs)) {
    if (performance.now() - t0 > SEEK_WAIT_TIMEOUT_MS) {
      throw new Error(`frame at ${tUs}us not available after ${SEEK_WAIT_TIMEOUT_MS}ms`);
    }
    await sleep(1);
  }
}

async function runThroughput(h: SourceHandle, durationUs: number): Promise<BenchResult> {
  phase = "warmup";
  await h.ensureReady();
  void h.requestFrameAt(0);
  await sleep(WARMUP_MS);
  phase = "measuring";
  const startFrames = h.ring.pushCount;
  const startPts = h.ring.lastPtsUs() ?? 0;
  const t0 = performance.now();
  let endedAtEof = false;
  for (;;) {
    if (performance.now() - t0 >= WINDOW_MS) break;
    const last = h.ring.lastPtsUs() ?? 0;
    if (last >= durationUs - EOF_GUARD_US) { endedAtEof = true; break; }
    // Advance the anchor to the decode frontier so the pump never idles —
    // the unthrottled analogue of the Compositor's per-tick nudge.
    void h.requestFrameAt(last);
    await sleep(10);
  }
  const measuredMs = performance.now() - t0;
  const frames = h.ring.pushCount - startFrames;
  const contentUs = (h.ring.lastPtsUs() ?? startPts) - startPts;
  // A short window that ended at EOF is VALID data (fast decoders drain the
  // 60s fixture early — the fps over that span is still the throughput).
  // Only a near-empty window is unusable: it means decode outran the fixture
  // during the 2s warm-up, so nothing was left to measure.
  if (frames < 60 || measuredMs < 1_000) {
    return {
      kind: "error",
      error: `window too small (frames=${frames}, ${measuredMs.toFixed(0)}ms) — decode outran the 60s fixture during warm-up`,
    };
  }
  return {
    kind: "throughput",
    measuredMs,
    frames,
    fps: frames / (measuredMs / 1000),
    xRealtime: contentUs / 1000 / measuredMs,
    endedAtEof,
  };
}

async function runSeek(h: SourceHandle, durationUs: number): Promise<BenchResult> {
  phase = "warmup";
  await h.ensureReady();
  void h.requestFrameAt(10_000_000);
  await waitContains(h, 10_000_000);
  phase = "measuring";
  const samples = new Map<SeekCategory, number[]>();
  for (const step of seekPlan(durationUs)) {
    const t0 = performance.now();
    void h.requestFrameAt(step.targetUs);
    await waitContains(h, step.targetUs);
    const ms = performance.now() - t0;
    (samples.get(step.category) ?? samples.set(step.category, []).get(step.category)!).push(ms);
  }
  const perCategory = {} as Record<SeekCategory, CategoryStats>;
  for (const [cat, arr] of samples) {
    const sorted = [...arr].sort((a, b) => a - b);
    perCategory[cat] = {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1]!,
      n: sorted.length,
    };
  }
  return { kind: "seek", perCategory };
}

async function runColdstart(
  pool: SourceDecoderPool,
  mkInit: (layerId: string) => Parameters<SourceDecoderPool["acquire"]>[0],
): Promise<BenchResult> {
  phase = "measuring";
  const iterationsMs: number[] = [];
  for (let i = 0; i < COLD_ITERATIONS; i++) {
    const layerId = `bench-cold-${i}`;
    const h = pool.acquire(mkInit(layerId));
    const t0 = performance.now();
    await h.ensureReady();
    void h.requestFrameAt(5_000_000);
    await waitContains(h, 5_000_000);
    iterationsMs.push(performance.now() - t0);
    // Releasing the only handle drops the SourceMedia refcount to 0 → the
    // demuxer is disposed, so the next acquire re-opens genuinely cold.
    pool.release(layerId);
  }
  const rest = [...iterationsMs.slice(1)].sort((a, b) => a - b);
  return {
    kind: "coldstart",
    firstMs: iterationsMs[0]!,
    restP50: percentile(rest, 50),
    restMax: rest[rest.length - 1]!,
    iterationsMs,
  };
}

export async function decodeBenchRun(args: BenchArgs): Promise<BenchResult> {
  if (args.strategy !== "webcodecs") {
    return { kind: "error", error: `strategy ${args.strategy} not integrated (Stage 2)` };
  }
  phase = "setup";
  const pool = new SourceDecoderPool();
  const url = convertFileSrc(args.sourcePath);
  const mkInit = (layerId: string) => ({
    layerId,
    mediaId: `bench:${args.sourcePath}`,
    proxyAssetUrl: url,
  });
  const scenario = async (): Promise<BenchResult> => {
    switch (args.scenario) {
      case "throughput":
        return runThroughput(pool.acquire(mkInit("bench-0")), args.durationUs);
      case "seek":
        return runSeek(pool.acquire(mkInit("bench-0")), args.durationUs);
      case "coldstart":
        return runColdstart(pool, mkInit);
    }
  };
  const timeout = sleep(SCENARIO_TIMEBOX_MS).then(
    (): BenchResult => ({ kind: "error", error: `timeout after ${SCENARIO_TIMEBOX_MS}ms in phase ${phase}` }),
  );
  try {
    return await Promise.race([scenario(), timeout]);
  } catch (e) {
    return { kind: "error", error: String(e) };
  } finally {
    phase = "idle";
    pool.dispose();
  }
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `npm run test -- decodeBench`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the hooks**

In `e2eHook.ts`: add to the imports
`import { decodeBenchRun, decodeBenchPhase, type BenchArgs, type BenchResult } from "../render/decoder/decodeBench";`,
add the two members to the `E2EHook` interface:

```ts
  /// decode-bench (docs/decode-bench.md): run one benchmark scenario against
  /// a private decoder pool. Orchestrated by e2e/scripts/decode-bench.mjs.
  decodeBenchRun(args: BenchArgs): Promise<BenchResult>;
  /// Current decode-bench phase ('idle'|'setup'|'warmup'|'measuring');
  /// the orchestrator gates its resource samplers on 'measuring'.
  decodeBenchPhase(): string;
```

and add a new installer function (module scope, near `installBootstrapHook` —
follow its shape; `hookSlot()` is the existing internal helper):

```ts
export function installDecodeBenchHooks(): void {
  if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
  hookSlot().decodeBenchRun = decodeBenchRun;
  hookSlot().decodeBenchPhase = decodeBenchPhase;
}
```

In `main.tsx` (the effect at lines 115–128), add `installDecodeBenchHooks` to
the destructured import list and call it alongside the others:

```ts
      ({ installBootstrapHook, installMotifTestHooks, installMotifHook, installAudioTestHooks, installDecodeBenchHooks }) => {
        installBootstrapHook(
          () => setStage("editor"),
          () => setStage("startup"),
        );
        installMotifTestHooks();
        installMotifHook();
        installAudioTestHooks();
        installDecodeBenchHooks();
      },
```

- [ ] **Step 6: Typecheck + full unit suite**

Run (from `apps/desktop`): `npm run typecheck && npm run test`
Expected: both clean. (The driver's end-to-end behavior is exercised by the
orchestrator in Task 4 against the real app — per the project's
invoke-the-downstream-tool testing rule, there is no mocked pipeline test.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeBench.ts apps/desktop/src/renderer/render/decoder/decodeBench.test.ts apps/desktop/src/renderer/testhook/e2eHook.ts apps/desktop/src/renderer/main.tsx
git commit -m "feat(e2e): decode-bench renderer scenario driver on the __weftcutTest hook surface"
```

---

### Task 4: Orchestrator with resource sampling and self-check

**Files:**
- Create: `apps/desktop/e2e/scripts/decode-bench.mjs`
- Modify: `apps/desktop/e2e/package.json` (two script entries)

**Interfaces:**
- Consumes: `window.__weftcutTest.decodeBenchRun/decodeBenchPhase` (Task 3),
  `BENCH_MATRIX`/`benchFixturePath` (Task 2), a `VITE_WEFTCUT_E2E=1` build at
  `apps/desktop/out/main/index.js`.
- Produces: `apps/desktop/e2e/bench-results/<ISO-date>-<gitsha>.json` + a
  markdown table on stdout; exit 0 on success, 1 on harness/self-check failure.

- [ ] **Step 1: Write the orchestrator**

```js
// decode-bench orchestrator. LOCAL-ONLY (GPU-dependent; meaningless on
// headless CI). Launches the real E2E-built app per (fixture × run), drives
// window.__weftcutTest.decodeBenchRun, samples per-process CPU
// (app.getAppMetrics) and GPU engine utilization (typeperf) during the
// throughput measuring phase, and writes an informative JSON report — the
// exit code never encodes "slow", only harness/self-check failure.
//
//   node apps/desktop/e2e/scripts/decode-bench.mjs [--fixture <name>|all]
//     [--scenario throughput|seek|coldstart|all] [--runs 3] [--self-check]
//
// Prereqs: `VITE_WEFTCUT_E2E=1 npm run build` (apps/desktop) and generated
// fixtures (gen-decode-bench-fixtures.mjs). Run on a quiet machine — the GPU
// counters are machine-wide.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { BENCH_MATRIX, benchFixturePath } from "./gen-decode-bench-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const MAIN = path.join(DESKTOP, "out/main/index.js");
const RESULTS_DIR = path.join(DESKTOP, "e2e/bench-results");
const STRATEGY = "webcodecs"; // Stage 2 adds 'native'
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const log = (m) => console.log(`[decode-bench] ${m}`);

// ── CLI ──────────────────────────────────────────────────────────────────────
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const selfCheck = process.argv.includes("--self-check");
const fixtureArg = arg("fixture", "all");
const scenarioArg = arg("scenario", "all");
const runs = Number(arg("runs", "3"));
const scenarios = scenarioArg === "all" ? ["throughput", "seek", "coldstart"] : [scenarioArg];
const fixtures = (fixtureArg === "all" ? BENCH_MATRIX : BENCH_MATRIX.filter((r) => r.name === fixtureArg))
  .filter((r) => fs.existsSync(benchFixturePath(r.name)));
if (fixtures.length === 0) {
  console.error(`[decode-bench] no fixtures matching '${fixtureArg}' on disk — run gen-decode-bench-fixtures.mjs first`);
  process.exit(1);
}
if (!fs.existsSync(MAIN)) {
  console.error("[decode-bench] out/main/index.js missing — run `VITE_WEFTCUT_E2E=1 npm run build` in apps/desktop first");
  process.exit(1);
}

// ── GPU engine sampler (Windows typeperf; machine-wide) ─────────────────────
function startGpuSampler() {
  if (process.platform !== "win32") return { stop: () => ({ videoDecode: [], gpu3d: [] }) };
  const counters = [
    "\\GPU Engine(*engtype_VideoDecode)\\Utilization Percentage",
    "\\GPU Engine(*engtype_3D)\\Utilization Percentage",
  ];
  const child = spawn("typeperf", [...counters, "-si", "1"], { windowsHide: true });
  let header = null;
  const videoDecode = [];
  const gpu3d = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('"')) continue;
      const cells = line.split('","').map((c) => c.replaceAll('"', ""));
      if (header === null) { header = cells; continue; } // first CSV line = column names
      let vd = 0, d3 = 0;
      for (let i = 1; i < cells.length; i++) {
        const v = Number(cells[i]);
        if (Number.isNaN(v)) continue;
        if (header[i]?.includes("engtype_VideoDecode")) vd += v;
        else if (header[i]?.includes("engtype_3D")) d3 += v;
      }
      videoDecode.push(Math.min(100, vd));
      gpu3d.push(Math.min(100, d3));
    }
  });
  return {
    stop: () => {
      child.kill();
      return { videoDecode, gpu3d };
    },
  };
}

// ── One app session: run the scenario list for one fixture ─────────────────
async function runSession(fixture, wantScenarios) {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: "1" },
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => typeof window.__weftcutTest?.decodeBenchRun === "function",
    undefined,
    { timeout: 30_000 },
  );
  const out = {};
  try {
    for (const scenario of wantScenarios) {
      const args = {
        sourcePath: benchFixturePath(fixture.name),
        durationUs: fixture.durationUs,
        scenario,
        strategy: STRATEGY,
      };
      if (scenario !== "throughput") {
        out[scenario] = await page.evaluate((a) => window.__weftcutTest.decodeBenchRun(a), args);
        continue;
      }
      // Throughput: gate the samplers on the driver's 'measuring' phase.
      const resultP = page.evaluate((a) => window.__weftcutTest.decodeBenchRun(a), args);
      let ph = "setup";
      const tGate = Date.now();
      while (ph !== "measuring" && ph !== "idle" && Date.now() - tGate < 30_000) {
        ph = await page.evaluate(() => window.__weftcutTest.decodeBenchPhase());
        await new Promise((r) => setTimeout(r, 100));
      }
      const gpu = startGpuSampler();
      const metricSamples = [];
      const metricsTimer = setInterval(() => {
        void app.evaluate(({ app: a }) => a.getAppMetrics()).then((m) => metricSamples.push(m)).catch(() => {});
      }, 500);
      const result = await resultP;
      clearInterval(metricsTimer);
      const gpuS = gpu.stop();
      const byType = {};
      for (const sample of metricSamples) {
        for (const p of sample) {
          (byType[p.type] ??= []).push(p.cpu.percentCPUUsage);
        }
      }
      out[scenario] = {
        ...result,
        resources: {
          cpuByProcess: Object.fromEntries(
            Object.entries(byType).map(([t, xs]) => [t, { mean: mean(xs), max: Math.max(...xs) }]),
          ),
          gpuVideoDecode: { mean: mean(gpuS.videoDecode), max: Math.max(0, ...gpuS.videoDecode) },
          gpu3d: { mean: mean(gpuS.gpu3d), max: Math.max(0, ...gpuS.gpu3d) },
          samples: { appMetrics: metricSamples.length, gpu: gpuS.videoDecode.length },
        },
      };
    }
  } finally {
    await app.close().catch(() => {});
  }
  return out;
}

// ── Environment block ────────────────────────────────────────────────────────
async function envBlock() {
  const app = await electron.launch({ args: [MAIN], env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: "1" } });
  try {
    const versions = await app.evaluate(() => process.versions);
    const gpu = await app.evaluate(({ app: a }) => a.getGPUInfo("basic"));
    let ffmpeg = "unknown";
    try { ffmpeg = execSync("ffmpeg -version", { encoding: "utf8" }).split("\n")[0]; } catch {}
    let sha = "unknown";
    try { sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}
    return {
      electron: versions.electron, chrome: versions.chrome,
      gpu: gpu?.gpuDevice?.map((d) => `${d.vendorId?.toString(16)}:${d.deviceId?.toString(16)}`) ?? [],
      ffmpeg, gitSha: sha, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString(),
    };
  } finally {
    await app.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
if (selfCheck) {
  log("self-check: WebCodecs throughput twice on h264-1080 …");
  const fixture = BENCH_MATRIX.find((r) => r.name === "h264-1080");
  const a = (await runSession(fixture, ["throughput"])).throughput;
  const b = (await runSession(fixture, ["throughput"])).throughput;
  if (a.kind !== "throughput" || b.kind !== "throughput") {
    console.error(`[decode-bench] self-check runs errored: ${JSON.stringify([a, b])}`);
    process.exit(1);
  }
  const rel = Math.abs(a.fps - b.fps) / ((a.fps + b.fps) / 2);
  log(`fps ${a.fps.toFixed(1)} vs ${b.fps.toFixed(1)} → Δ ${(rel * 100).toFixed(2)}%`);
  if (rel >= 0.05) { console.error("[decode-bench] SELF-CHECK FAIL: variance >= 5%"); process.exit(1); }
  log("SELF-CHECK PASS");
  process.exit(0);
}

const env = await envBlock();
const report = { env, strategy: STRATEGY, runs, cells: [] };
for (const fixture of fixtures) {
  const perRun = [];
  for (let run = 0; run < runs; run++) {
    log(`${fixture.name} run ${run + 1}/${runs} …`);
    perRun.push(await runSession(fixture, scenarios));
  }
  report.cells.push({ fixture: fixture.name, perRun });
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = path.join(RESULTS_DIR, `${env.date.slice(0, 10)}-${env.gitSha}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
log(`report → ${outFile}`);

// Markdown summary: median across runs for the headline numbers.
console.log(`\n| fixture | fps (median) | ×realtime | seek ffar P95 ms | cold first ms | GPU dec mean % |`);
console.log(`|---|---|---|---|---|---|`);
for (const cell of report.cells) {
  const tp = cell.perRun.map((r) => r.throughput).filter((t) => t?.kind === "throughput");
  const sk = cell.perRun.map((r) => r.seek).filter((s) => s?.kind === "seek");
  const cs = cell.perRun.map((r) => r.coldstart).filter((c) => c?.kind === "coldstart");
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  console.log(
    `| ${cell.fixture} | ${fmt(median(tp.map((t) => t.fps)))} | ${fmt(median(tp.map((t) => t.xRealtime)))} ` +
    `| ${fmt(median(sk.map((s) => s.perCategory["forward-far"]?.p95)))} ` +
    `| ${fmt(median(cs.map((c) => c.firstMs)))} | ${fmt(median(tp.map((t) => t.resources?.gpuVideoDecode.mean)))} |`,
  );
  for (const [i, r] of cell.perRun.entries()) {
    for (const s of scenarios) {
      if (r[s]?.kind === "error") console.log(`  ↳ run ${i + 1} ${s}: ${r[s].error}`);
    }
  }
}
```

- [ ] **Step 2: Add the npm scripts**

In `apps/desktop/e2e/package.json`, extend `scripts`:

```json
    "bench:decode": "node scripts/decode-bench.mjs",
    "bench:decode:fixtures": "node scripts/gen-decode-bench-fixtures.mjs"
```

(Note: `e2e/package.json`'s cwd is `e2e/`, and these scripts live in
`e2e/scripts/` — the relative path is correct as written.)

- [ ] **Step 3: Run the self-check (instrument calibration)**

Precondition: the Task-header build steps ran (E2E build present, fixtures
generated), no other heavy processes running.

Run: `node apps/desktop/e2e/scripts/decode-bench.mjs --self-check`
Expected: two app windows appear sequentially (~45 s each), then
`fps <a> vs <b> → Δ <x>%` and `SELF-CHECK PASS`, exit 0.
If variance ≥ 5 %: re-run on a quiet machine; if it persists, investigate
before trusting any numbers (that is the point of the gate).

- [ ] **Step 4: Run one full single-fixture cell**

Run: `node apps/desktop/e2e/scripts/decode-bench.mjs --fixture h264-1080 --runs 1`
Expected: one session (~2 min: 30 s throughput + 40 seeks + 10 cold starts),
a JSON file in `apps/desktop/e2e/bench-results/`, and a one-row markdown
table with plausible values (h264-1080 HW decode: fps well above 30,
×realtime > 1, cold first ms in the hundreds; `endedAtEof: true` with a
measured window shorter than 30 s is normal for this fast row — the fixture
drains early). All three scenario objects in the JSON must have their `kind`
(no `error` rows).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/scripts/decode-bench.mjs apps/desktop/e2e/package.json
git commit -m "feat(e2e): decode-bench orchestrator — sessions, resource sampling, self-check"
```

---

### Task 5: Evergreen doc + e2e README wiring

**Files:**
- Create: `docs/decode-bench.md`
- Modify: `apps/desktop/e2e/README.md` (Layout section + a run bullet)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–4.
- Produces: operator documentation; no code.

- [ ] **Step 1: Write `docs/decode-bench.md`**

Evergreen style (reads as authored today; no dates/phases/commit hashes —
see the docs conventions the repo enforces). Content requirements:

- **What it measures:** the two preview decode strategies decoding the same
  original at the `DecoderHandle` seam; the four metrics and their exact
  definitions (fps = ring pushes per wall-second over the measured window;
  ×realtime = content-seconds per wall-second; seek latency =
  `requestFrameAt` → `containsPts` wall time per distance category;
  cold start = `acquire` → first frame at 5 s; CPU per process via
  `app.getAppMetrics` — native decode lands in main, WebCodecs in
  renderer + GPU process; GPU engine utilization via `typeperf`,
  machine-wide caveat).
- **What it deliberately is not:** no proxy pairing (same-source only), not
  a CI gate, informative-only exit semantics, `native` strategy pending its
  integration.
- **How to run:** the four commands (napi:build / fetch-ffmpeg / E2E build /
  fixtures) + `npm run bench:decode` and `--self-check`, `--fixture`,
  `--runs` flags; quiet-machine requirement.
- **How to read the report:** the JSON layout (`env`, `cells[].perRun[]`),
  median-of-3 convention, the `unsupported`/`timeout`/`error` cell semantics,
  and the known asymmetry note (WebCodecs reads via `weftcut-media://`
  Range; native reads the OS path — part of the measurement, not noise).

- [ ] **Step 2: Wire into `apps/desktop/e2e/README.md`**

In the Layout block, extend the `scripts/` line to mention decode-bench, and
add one bullet under the run section:

```markdown
npm run bench:decode        # decode-strategy benchmark (see ../../../docs/decode-bench.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/decode-bench.md apps/desktop/e2e/README.md
git commit -m "docs: decode-bench operator guide + e2e README wiring"
```

---

### Task 6: Stage-1 baseline matrix run (acceptance)

**Files:** none created in-repo (results land in the gitignored
`apps/desktop/e2e/bench-results/`).

**Interfaces:**
- Consumes: the complete Stage-1 harness.
- Produces: the first WebCodecs-originals baseline report + a pass/fail
  reading of the spec's acceptance criteria.

- [ ] **Step 1: Full self-check**

Run: `node apps/desktop/e2e/scripts/decode-bench.mjs --self-check`
Expected: `SELF-CHECK PASS`, exit 0.

- [ ] **Step 2: Full matrix, 3 runs**

Run: `node apps/desktop/e2e/scripts/decode-bench.mjs`
Expected (~35–45 min: 6 fixtures × 3 runs × ~2 min): a report JSON + a
6-row markdown table. Acceptance per spec §6:

- every fixture row yields data or an explicit `error` line with a reason
  (hi10p-1080 must yield DATA on WebCodecs — it software-decodes; a
  hard-codec row erroring with a decoder-config rejection is a legitimate
  `unsupported` datum, not a harness bug);
- resource numbers present for every throughput cell (`samples.appMetrics ≥ 50`,
  `samples.gpu ≥ 25`);
- plausibility: h264-1080 ×realtime > 1; hevc-2160 fps lower than hevc-1080;
  forward-near seeks P50 ≪ backward-far P50.

- [ ] **Step 3: Record the outcome**

Summarize the table (plus any `error` cells and their reasons) in the session
for the user — this baseline is the Stage-2 comparison anchor and feeds the
spec §5 decision checkpoints once the native side exists. Do not commit
result files.

---

## Self-Review Notes (already applied)

- Spec §1 architecture / §2 matrix / §3 scenarios+fairness / §4 Stage 1 / §6
  acceptance all map to Tasks 1–6; §5 decision checkpoints and `forceStrategy`
  are Stage 2 by design and intentionally absent here.
- The spec's illustrative `window.__weftcutBench` global is reconciled to the
  codebase's real hook surface (`window.__weftcutTest.decodeBenchRun`) — the
  spec's acceptance criteria don't reference the global's name.
- Type names used across tasks are consistent: `BenchArgs`, `BenchResult`,
  `SeekCategory`, `pushCount`, `decodeBenchRun`, `decodeBenchPhase`,
  `BENCH_MATRIX`, `benchFixturePath`.
