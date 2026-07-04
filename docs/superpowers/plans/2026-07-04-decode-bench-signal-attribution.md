# decode-bench signal-attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the native per-frame coordination round-trip (`coordRtt`) into per-boundary buckets — Rust↔main vs main↔renderer vs renderer-work — so the Stage-4 throughput fix (lever 3B dedicated-port vs 3A/lever4 shared-mem/pull) is chosen from data. Measure-only: no fix, no behavior change.

**Architecture:** The main process sees both ends of the renderer round-trip (it dispatches `frameReady` and receives `consumeAck`), so it times that round-trip in its OWN `performance.now()` clock — no cross-process clock sync, no ablation. Combined with the existing Rust `coordRtt` (whole loop) and preload `residentMs` (renderer work), three within-clock subtractions give the buckets. Pure timing logic lives in an electron-free module so it's unit-testable.

**Tech Stack:** TypeScript (Electron main + preload + renderer), Node ESM orchestrator, Vitest. NO Rust changes — `coordRtt` comes from the existing (unchanged) `preview_gpu_take_timings`; the Stage-3 preview-gpu `.node` stays valid, so there is NO `napi:build`/cargo step in any code task.

## Global Constraints

- Node **22.20.0** (fnm default).
- **Measure-only:** build NO fix (no dedicated MessageChannelMain port, no SharedArrayBuffer, no pull model). This slice chooses between them.
- **No behavior change:** main adds two `performance.now()` calls + a small `Map` on the existing relay/handler; frame delivery, acking, and the WebCodecs path are untouched. Default native poolSize stays 3.
- Pure timing logic must NOT import `electron` (it can't load under Vitest — see `vitest.config.ts:18-19`); electron wiring stays in `previewGpu.ts`/`index.ts`.
- `msSummary` returns the napi-uniform `PreviewGpuTimingSummary` shape (`count/meanMs/p50Ms/p95Ms/maxMs`); percentiles are linear-interpolated over ascending samples, matching the existing `decodeBench.percentile` and Rust `summarize`. Empty samples → all-zero summary.
- Main timing is a bench/native-session concern; the `takeMainTimings` accumulator is a **relay singleton** relying on the bench running one native session at a time (serial) — documented assumption.
- Evergreen comments (no dates/hashes/changelog in source). `docs/decode-bench.md` is evergreen/qualitative (no fps numbers or dates).
- Staging: EXPLICIT paths only, never `git add -A`. Re-check `git status` before each commit (parallel sessions). Do NOT push. No formatter, no codex delegation. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Test command: `npm run test -- <pattern>` (cwd `apps/desktop`; the script is `vitest run`). Typecheck: `npm run typecheck` (`tsc -b`).
- Spec: `docs/superpowers/specs/2026-07-04-decode-bench-signal-attribution-design.md`.

---

### Task 1: Shared `percentile` + `msSummary` helper

**Files:**
- Create: `apps/desktop/src/shared/msStats.ts`
- Create (test): `apps/desktop/src/shared/msStats.test.ts`
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts` (drop local `percentile`, import + re-export from shared)

**Interfaces:**
- Consumes: `PreviewGpuTimingSummary` (type from `shared/ipc.ts`, added in Stage 3: `{ count: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number }`).
- Produces: `percentile(sorted: number[], p: number): number`; `msSummary(samples: number[]): PreviewGpuTimingSummary`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/shared/msStats.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { percentile, msSummary } from "./msStats";

describe("percentile", () => {
  it("linear-interpolates over ascending samples", () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 50)).toBe(30);
    expect(percentile(s, 95)).toBeCloseTo(48, 6);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe("msSummary", () => {
  it("summarizes known samples", () => {
    const s = msSummary([10, 20, 30, 40, 50]);
    expect(s.count).toBe(5);
    expect(s.meanMs).toBe(30);
    expect(s.p50Ms).toBe(30);
    expect(s.p95Ms).toBeCloseTo(48, 6);
    expect(s.maxMs).toBe(50);
  });
  it("returns an all-zero summary for empty input", () => {
    expect(msSummary([])).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- msStats`
Expected: FAIL — cannot resolve `./msStats` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/shared/msStats.ts`:

```typescript
// Pure ms-summary helpers shared across processes (main + renderer) so the
// percentile formula isn't copied per caller. Linear-interp percentiles over
// ascending samples; empty -> all-zero (matching the Rust `summarize` empty case,
// so a session with no samples reports 0/0 across the bridge rather than NaN).
import type { PreviewGpuTimingSummary } from "./ipc";

/// Linear-interpolated percentile over an ASCENDING-sorted array.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/// Summarize ms samples into the napi-uniform PreviewGpuTimingSummary shape.
export function msSummary(samples: number[]): PreviewGpuTimingSummary {
  if (samples.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    meanMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1]!,
  };
}
```

Then re-wire `decodeBench.ts` to use the shared `percentile` instead of its own. In `decodeBench.ts`, the current local definition is:

```typescript
/// Linear-interpolated percentile over an ASCENDING-sorted array.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
```

Delete that block and, near the other imports at the top of `decodeBench.ts`, add:

```typescript
import { percentile } from "../../../shared/msStats";
```

To preserve `percentile`'s existing export from `decodeBench.ts` (other modules/tests may import it from here), add a re-export line beside that import:

```typescript
export { percentile } from "../../../shared/msStats";
```

(The `import` makes it usable internally in `decodeBench.ts`; the `export ... from` re-publishes it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- msStats decodeBench`
Expected: PASS — `msStats` tests pass, and the existing `decodeBench` tests still pass (percentile behavior unchanged).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/msStats.ts apps/desktop/src/shared/msStats.test.ts apps/desktop/src/renderer/render/decoder/decodeBench.ts
git commit -m "refactor(decode-bench): hoist percentile + add msSummary to shared/msStats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure main-side timing accumulator (`previewGpuTiming.ts`)

**Files:**
- Create: `apps/desktop/src/main/previewGpuTiming.ts`
- Create (test): `apps/desktop/src/main/previewGpuTiming.test.ts`

**Interfaces:**
- Consumes: `msSummary` (Task 1); `PreviewGpuTimingSummary` (type, `shared/ipc.ts`).
- Produces: `recordFrameReadySent(streamId: string, slot: number, nowMs: number): void`; `recordConsumeAck(streamId: string, slot: number, nowMs: number): void`; `takeMainTimings(): { rendererRoundTripMs: PreviewGpuTimingSummary }`; `clearMainPendingFor(streamId: string): void`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/previewGpuTiming.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordFrameReadySent,
  recordConsumeAck,
  takeMainTimings,
  clearMainPendingFor,
} from "./previewGpuTiming";

// The accumulator is a module singleton; drain before each test to reset it.
beforeEach(() => {
  takeMainTimings();
});

describe("previewGpuTiming", () => {
  it("records one round-trip sample (ms) per send+ack pair", () => {
    recordFrameReadySent("s1", 0, 100);
    recordConsumeAck("s1", 0, 105);
    recordFrameReadySent("s1", 1, 200);
    recordConsumeAck("s1", 1, 208);
    const t = takeMainTimings();
    expect(t.rendererRoundTripMs.count).toBe(2);
    expect(t.rendererRoundTripMs.meanMs).toBe(6.5); // (5 + 8) / 2
    expect(t.rendererRoundTripMs.maxMs).toBe(8);
  });

  it("ignores an ack with no prior send", () => {
    recordConsumeAck("s1", 0, 105);
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(0);
  });

  it("drains: a second take is empty", () => {
    recordFrameReadySent("s1", 0, 100);
    recordConsumeAck("s1", 0, 110);
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(1);
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(0);
  });

  it("keys by (streamId, slot) so streams do not collide", () => {
    recordFrameReadySent("s1", 0, 100);
    recordFrameReadySent("s2", 0, 200);
    recordConsumeAck("s2", 0, 210); // s2 slot0 -> 10
    recordConsumeAck("s1", 0, 130); // s1 slot0 -> 30
    expect(takeMainTimings().rendererRoundTripMs.meanMs).toBe(20);
  });

  it("clearMainPendingFor drops un-acked stamps for a stream", () => {
    recordFrameReadySent("s1", 0, 100);
    clearMainPendingFor("s1");
    recordConsumeAck("s1", 0, 110); // no pending -> no sample
    expect(takeMainTimings().rendererRoundTripMs.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- previewGpuTiming`
Expected: FAIL — cannot resolve `./previewGpuTiming`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/previewGpuTiming.ts`:

```typescript
// Pure main-side per-frame coordination timing for decode-bench signal
// attribution. The MAIN process sees both ends of the renderer round-trip — it
// dispatches `frameReady` and receives `consumeAck` — so it times that round-trip
// in its OWN clock, with no cross-process clock sync. No `electron` import, so this
// is unit-testable (see vitest.config.ts note); the electron wiring lives in
// previewGpu.ts / index.ts. Accumulator is a relay singleton — the bench runs one
// native session at a time (serial).
import { msSummary } from '../shared/msStats'
import type { PreviewGpuTimingSummary } from '../shared/ipc'

/// Cap on retained samples; a 30s window at native frame rates stays far under it
/// (matches the Rust-side cap). Stop-appending once full.
const CAP = 20_000

const pendingSendMs = new Map<string, number>()
let rtSamplesMs: number[] = []

const key = (streamId: string, slot: number): string => `${streamId}:${slot}`

/// Stamp the moment main dispatched a frame to the renderer (just before send).
export function recordFrameReadySent(streamId: string, slot: number, nowMs: number): void {
  pendingSendMs.set(key(streamId, slot), nowMs)
}

/// On the matching consumeAck, record the renderer round-trip (main->renderer->main)
/// and clear the pending stamp. 1:1 by (streamId, slot); an ack with no prior send
/// records nothing.
export function recordConsumeAck(streamId: string, slot: number, nowMs: number): void {
  const k = key(streamId, slot)
  const sent = pendingSendMs.get(k)
  if (sent === undefined) return
  pendingSendMs.delete(k)
  if (rtSamplesMs.length < CAP) rtSamplesMs.push(nowMs - sent)
}

/// Drain the accumulated round-trip samples into a summary and clear them.
export function takeMainTimings(): { rendererRoundTripMs: PreviewGpuTimingSummary } {
  const summary = msSummary(rtSamplesMs)
  rtSamplesMs = []
  return { rendererRoundTripMs: summary }
}

/// Drop any un-acked pending stamps for a stream (called on session close so a
/// frame in flight at teardown can't leak a Map entry).
export function clearMainPendingFor(streamId: string): void {
  const prefix = `${streamId}:`
  for (const k of pendingSendMs.keys()) {
    if (k.startsWith(prefix)) pendingSendMs.delete(k)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- previewGpuTiming`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/previewGpuTiming.ts apps/desktop/src/main/previewGpuTiming.test.ts
git commit -m "feat(decode-bench): pure main-side renderer-round-trip timing accumulator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire main timing (relay + consumeAck + bridge)

**Files:**
- Modify: `apps/desktop/src/main/previewGpu.ts` (call `clearMainPendingFor` in `closePreviewGpu`)
- Modify: `apps/desktop/src/main/index.ts` (stamp on frameReady relay; record on consumeAck; `takeMainTimings` handler)
- Modify: `apps/desktop/src/shared/ipc.ts` (`PreviewGpuMainTiming` type + bridge method)
- Modify: `apps/desktop/src/preload/index.ts` (`takeMainTimings` bridge)

**Interfaces:**
- Consumes: `recordFrameReadySent`, `recordConsumeAck`, `takeMainTimings`, `clearMainPendingFor` (Task 2); `PreviewGpuTimingSummary` (type).
- Produces: type `PreviewGpuMainTiming = { rendererRoundTripMs: PreviewGpuTimingSummary }`; `window.api.previewGpu.takeMainTimings(): Promise<PreviewGpuMainTiming>`; IPC channel `previewGpu:takeMainTimings`.

- [ ] **Step 1: Add the shared type + bridge method signature**

In `apps/desktop/src/shared/ipc.ts`, after the existing `PreviewGpuTimingReport` type, add:

```typescript
/// Main-measured renderer round-trip (decode-bench signal attribution): the time
/// from main dispatching `frameReady` to receiving the matching `consumeAck` —
/// main<->renderer transit + renderer work, measured in main's own clock.
export type PreviewGpuMainTiming = { rendererRoundTripMs: PreviewGpuTimingSummary }
```

In the same file, in the `previewGpu: { ... }` member of `WeftcutApi`, after the `takeTimings(streamId: string): Promise<PreviewGpuTimingReport>` line, add:

```typescript
    /// E2E/bench-only: drain the MAIN-measured renderer round-trip samples.
    takeMainTimings(): Promise<PreviewGpuMainTiming>
```

- [ ] **Step 2: Implement the preload bridge method**

In `apps/desktop/src/preload/index.ts`, add `PreviewGpuMainTiming` to the existing `import type { ... } from '../shared/ipc'` block. Then, in the `previewGpu: { ... }` object, after the `takeTimings(...)` method, add:

```typescript
    takeMainTimings(): Promise<PreviewGpuMainTiming> {
      return ipcRenderer.invoke('previewGpu:takeMainTimings') as Promise<PreviewGpuMainTiming>
    },
```

- [ ] **Step 3: Wire `clearMainPendingFor` into `closePreviewGpu`**

In `apps/desktop/src/main/previewGpu.ts`, add the import at the top:

```typescript
import { clearMainPendingFor } from './previewGpuTiming.js'
```

In `closePreviewGpu`, at the very top of the function body (before the `sessions.get` line), add:

```typescript
  // Drop any un-acked send stamps for this stream so a frame in flight at
  // teardown can't leak a pending-map entry (decode-bench signal attribution).
  clearMainPendingFor(streamId)
```

- [ ] **Step 4: Stamp on the frameReady relay + record on consumeAck + add the handler**

In `apps/desktop/src/main/index.ts`, add to the existing import from `./previewGpu.js`? No — the timing functions live in `previewGpuTiming.js`. Add a new import near the `./previewGpu.js` import:

```typescript
import { recordFrameReadySent, recordConsumeAck, takeMainTimings } from './previewGpuTiming.js'
```

In the Backend `onEvent` relay, immediately before the generic `mainWindow?.webContents.send('evt:' + event, payload)` line (~`index.ts:198`), add:

```typescript
      if (event === 'previewGpu:frameReady') {
        const p = payload as { streamId: string; slot: number }
        recordFrameReadySent(p.streamId, p.slot, performance.now())
      }
```

Change the `previewGpu:consumeAck` handler (~`index.ts:445`) from:

```typescript
  ipcMain.handle('previewGpu:consumeAck', (_e, a: { streamId: string; slot: number }) =>
    consumeAckPreviewGpu(backend!, a.streamId, a.slot),
  )
```

to:

```typescript
  ipcMain.handle('previewGpu:consumeAck', (_e, a: { streamId: string; slot: number }) => {
    // Record the round-trip at handler entry (t_ack_received) BEFORE forwarding.
    recordConsumeAck(a.streamId, a.slot, performance.now())
    return consumeAckPreviewGpu(backend!, a.streamId, a.slot)
  })
```

Add the drain handler right after the `previewGpu:close` handler:

```typescript
  ipcMain.handle('previewGpu:takeMainTimings', () => takeMainTimings())
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`performance.now()` resolves via the Node global in the Electron main context; the bridge method type-checks against `WeftcutApi`.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/previewGpu.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/preload/index.ts
git commit -m "feat(decode-bench): main-side frameReady/consumeAck timing + takeMainTimings bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Assemble the three-bucket split in decodeBench

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts`
- Test: `apps/desktop/src/renderer/render/decoder/decodeBench.test.ts`

**Interfaces:**
- Consumes: `window.api.previewGpu.takeMainTimings()` + `PreviewGpuMainTiming` (Task 3); existing `buildThroughputTiming`, `MsStats`, `ThroughputTiming`, `summaryToStats`, `statsOf` (in `decodeBench.ts`).
- Produces: `ThroughputTiming` gains `rendererRoundTripMs: MsStats`, `rustMainBoundaryMs: number`, `mainRendererTransitMs: number`; `buildThroughputTiming` gains a 4th param `main: PreviewGpuMainTiming`.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/renderer/render/decoder/decodeBench.test.ts`, update the existing `buildThroughputTiming` describe block. Replace its first test with this (it adds the `main` arg and asserts the two derived buckets):

```typescript
  it("maps the Rust summaries, summarizes preload arrays, and derives the boundary buckets", () => {
    const rust = {
      coordRtt: { count: 2, meanMs: 68, p50Ms: 66, p95Ms: 90, maxMs: 92 },
      decodeCopy: { count: 2, meanMs: 3, p50Ms: 3, p95Ms: 4, maxMs: 4 },
    };
    const pre = { gvfMs: [1, 1], cibMs: [10, 10], residentMs: [20, 20] };
    const main = { rendererRoundTripMs: { count: 2, meanMs: 50, p50Ms: 49, p95Ms: 60, maxMs: 62 } };

    const t = buildThroughputTiming(6, rust, pre, main);

    expect(t.poolSize).toBe(6);
    expect(t.coordRttMs).toEqual({ p50: 66, p95: 90, max: 92, mean: 68, n: 2 });
    expect(t.preloadResidentMs.mean).toBe(20);
    expect(t.rendererRoundTripMs).toEqual({ p50: 49, p95: 60, max: 62, mean: 50, n: 2 });
    // rustMain = coordRtt.mean - rendererRoundTrip.mean = 68 - 50
    expect(t.rustMainBoundaryMs).toBe(18);
    // mainRend = rendererRoundTrip.mean - preloadResident.mean = 50 - 20
    expect(t.mainRendererTransitMs).toBe(30);
    // sanity: the two buckets sum to the existing ipcTransitMsDerived (48)
    expect(t.ipcTransitMsDerived).toBe(48);
  });
```

If the block's second test (the empty-arrays case) calls `buildThroughputTiming(3, rust, {...})` with 3 args, update that call to pass a 4th `main` arg:

```typescript
    const main = { rendererRoundTripMs: { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 } };
    const t = buildThroughputTiming(3, rust, { gvfMs: [], cibMs: [], residentMs: [] }, main);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- decodeBench`
Expected: FAIL — `buildThroughputTiming` takes 3 args / `rustMainBoundaryMs` is undefined.

- [ ] **Step 3: Extend the types + builder + collection**

In `decodeBench.ts`, add the import for the main-timing type at the top (extend the existing `import type { ... } from "../../../shared/ipc"`):

```typescript
import type { PreviewGpuTimingReport, PreviewGpuMainTiming } from "../../../shared/ipc";
```

Extend the `ThroughputTiming` interface — add three fields after `ipcTransitMsDerived`:

```typescript
  /// Main-measured renderer round-trip (main<->renderer transit + renderer work).
  rendererRoundTripMs: MsStats;
  /// Rust<->main boundary (tsfn + mpsc + main dispatch) = coordRtt.mean - rendererRoundTrip.mean.
  rustMainBoundaryMs: number;
  /// Pure main<->renderer IPC/queue = rendererRoundTrip.mean - preloadResident.mean.
  mainRendererTransitMs: number;
```

Change `buildThroughputTiming`'s signature and body:

```typescript
export function buildThroughputTiming(
  poolSize: number,
  rust: PreviewGpuTimingReport,
  pre: { gvfMs: number[]; cibMs: number[]; residentMs: number[] },
  main: PreviewGpuMainTiming,
): ThroughputTiming {
  const preloadResidentMs = statsOf(pre.residentMs);
  const rendererRoundTripMs = summaryToStats(main.rendererRoundTripMs);
  return {
    poolSize,
    decodeCopyMs: summaryToStats(rust.decodeCopy),
    coordRttMs: summaryToStats(rust.coordRtt),
    preloadResidentMs,
    createImageBitmapMs: statsOf(pre.cibMs),
    ipcTransitMsDerived: rust.coordRtt.meanMs - preloadResidentMs.mean,
    rendererRoundTripMs,
    rustMainBoundaryMs: rust.coordRtt.meanMs - main.rendererRoundTripMs.meanMs,
    mainRendererTransitMs: main.rendererRoundTripMs.meanMs - preloadResidentMs.mean,
  };
}
```

In `runThroughput`, in the native-timing collection block (where it currently does `const rust = await window.api.previewGpu.takeTimings(native.streamId);` and `timing = buildThroughputTiming(native.poolSize, rust, pre);`), add the main-timing fetch and pass it through:

```typescript
    const pre = native.drainBenchTiming();
    const rust = await window.api.previewGpu.takeTimings(native.streamId);
    const main = await window.api.previewGpu.takeMainTimings();
    timing = buildThroughputTiming(native.poolSize, rust, pre, main);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- decodeBench && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeBench.ts apps/desktop/src/renderer/render/decoder/decodeBench.test.ts
git commit -m "feat(decode-bench): three-bucket coordination split (Rust<->main / main<->renderer / work)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Surface the buckets in the pool-sweep table

**Files:**
- Modify: `apps/desktop/e2e/scripts/decode-bench.mjs`

**Interfaces:**
- Consumes: the `timing` block's new fields (Task 4): `rendererRoundTripMs.p50`, `rustMainBoundaryMs`, `mainRendererTransitMs`.

- [ ] **Step 1: Add the columns to the pool-sweep table**

In `decode-bench.mjs`, in the `POOL_SWEEP` block's markdown table, extend the header and the row. Change the header line from:

```javascript
  console.log(`\n| fixture | N | fps | ×realtime | coordRtt p50 | cib p50 | resident p50 | ipcTransit(mean) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
```

to:

```javascript
  console.log(`\n| fixture | N | fps | ×realtime | coordRtt p50 | cib p50 | resident p50 | rendererRT p50 | rustMain(mean) | mainRend(mean) |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|`);
```

And change the row template from:

```javascript
    console.log(
      `| ${r.fixture} | ${r.poolSize} | ${fmt(r.fps)} | ${fmt(r.xRealtime)} ` +
      `| ${fmt(t?.coordRttMs?.p50)} | ${fmt(t?.createImageBitmapMs?.p50)} ` +
      `| ${fmt(t?.preloadResidentMs?.p50)} | ${fmt(t?.ipcTransitMsDerived)} |`,
    );
```

to:

```javascript
    console.log(
      `| ${r.fixture} | ${r.poolSize} | ${fmt(r.fps)} | ${fmt(r.xRealtime)} ` +
      `| ${fmt(t?.coordRttMs?.p50)} | ${fmt(t?.createImageBitmapMs?.p50)} ` +
      `| ${fmt(t?.preloadResidentMs?.p50)} | ${fmt(t?.rendererRoundTripMs?.p50)} ` +
      `| ${fmt(t?.rustMainBoundaryMs)} | ${fmt(t?.mainRendererTransitMs)} |`,
    );
```

(Match the actual variable names in the file — `r` is the sweep cell, `t = r.timing`, `fmt` is the existing formatter.)

- [ ] **Step 2: Verify syntax**

Run: `node --check apps/desktop/e2e/scripts/decode-bench.mjs`
Expected: no output, exit 0 (valid syntax). The buckets are already present in the report JSON regardless of the table; this task only improves the sweep's stdout readability.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/scripts/decode-bench.mjs
git commit -m "feat(decode-bench): surface the three coordination buckets in the pool-sweep table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Confirmation run + verdict (controller-run, needs GPU)

**Files:**
- Modify: `docs/decode-bench.md` (append the boundary-attribution finding to the Native-strategy section)

**Interfaces:**
- Consumes: everything above. Produces the three-bucket attribution + a one-line verdict naming the dominant boundary and the lever it selects.

- [ ] **Step 1: Build the E2E app (no napi:build — Rust unchanged)**

From `apps/desktop`, with no dev app running:

```bash
VITE_WEFTCUT_E2E=1 npm run build
```

Expected: `out/main/index.js` present. The Stage-3 `preview-gpu` `.node` is reused as-is (this slice changed no Rust); `npm run build` is `electron-vite build` and does not touch the `.node`.

- [ ] **Step 2: Confirm fixtures exist**

```bash
node e2e/scripts/gen-decode-bench-fixtures.mjs
```

Expected: `hevc-1080` and `hevc-2160` present (idempotent).

- [ ] **Step 3: Run the single-N=3 confirmation on both fixtures**

On the quiet dev machine (RTX 3050), from `apps/desktop`:

```bash
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-1080 --pool-size 3 --runs 3
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-2160 --pool-size 3 --runs 3
```

Each writes `e2e/bench-results/<date>-<sha>.json`. Read `cells[0].perRun[i].throughput.timing` and inspect the three buckets: `rendererRoundTripMs`, `rustMainBoundaryMs`, `mainRendererTransitMs` (and the existing `coordRttMs`, `preloadResidentMs`, `createImageBitmapMs`).

- [ ] **Step 4: Interpret + record the verdict**

Decision criteria (spec §5):
- `mainRendererTransitMs` dominant ⇒ the main↔renderer IPC hop is the cost ⇒ **lever 3B (dedicated MessageChannelMain port) is worth trying**.
- `rustMainBoundaryMs` comparable/larger, or the cost split diffuse ⇒ 3B won't help ⇒ **go straight to lever 3A (SharedArrayBuffer/Atomics) or lever 4 (zero-copy pull)**.

Append a short subsection to `docs/decode-bench.md`'s Native-strategy section recording the qualitative finding (which boundary dominates; the lever it selects) — evergreen, no fps/date numbers. Commit:

```bash
git add docs/decode-bench.md
git commit -m "docs(decode-bench): coordination boundary attribution — <dominant boundary> dominates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Update the project memory**

Update `project_decode_bench.md` (topic) + the `MEMORY.md` index line with the boundary attribution result and the selected Stage-4 lever, so a fresh session resumes from the decision.

---

## Self-Review

**1. Spec coverage:**
- §1 (method: main-clock renderer round-trip; three buckets) → Tasks 2, 3, 4. ✓
- §2 (main-side timestamping; pendingSend Map; record*/take/clear; msSummary; shared percentile) → Tasks 1, 2, 3. ✓
- §3 (`takeMainTimings` bridge: ipc type + preload + main handler; no streamId; pure main state) → Task 3. ✓
- §4 (decodeBench: 3 new fields, `buildThroughputTiming` +main param + 2 derived buckets, `runThroughput` fetch) → Task 4. ✓
- §5 (no new CLI; sweep-table columns; single N=3 confirmation run + decision) → Tasks 5, 6. ✓
- §6 (tests: msSummary/percentile; main pairing; buildThroughputTiming buckets) → Tasks 1, 2, 4. ✓
- §7 (scope: measure-only, no behavior change, gated, serial-only) → Global Constraints + Task-2/3 comments. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The one non-literal is Task 6's commit-message `<dominant boundary>` — intentional, filled from the run's result.

**3. Type consistency:**
- `msSummary(samples): PreviewGpuTimingSummary` (Task 1) ← consumed by `previewGpuTiming.takeMainTimings` (Task 2) returning `{ rendererRoundTripMs: PreviewGpuTimingSummary }`, matching `PreviewGpuMainTiming` (Task 3) and `buildThroughputTiming`'s `main` param (Task 4). ✓
- Bridge camelCase: `rendererRoundTripMs` used identically in ipc type (Task 3), main accumulator (Task 2), decodeBench (Task 4), and the mjs table (Task 5). ✓
- `recordFrameReadySent`/`recordConsumeAck`/`takeMainTimings`/`clearMainPendingFor` names identical across Tasks 2 and 3. ✓
- `buildThroughputTiming(poolSize, rust, pre, main)` 4-arg signature (Task 4) matches the test (Task 4 Step 1) and the `runThroughput` call site. ✓
- `rustMainBoundaryMs` / `mainRendererTransitMs` field names identical in `ThroughputTiming` (Task 4), the test (Task 4), and the mjs table (Task 5). ✓

No inconsistencies found.
