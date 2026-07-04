# decode-bench max-throughput probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find native's true maximum single-track 1080p decode throughput by making the bench throughput driver's pacing delay configurable (`--throttle-ms`, default 10 = current) and running the pool-sweep at throttle {10, 0}, to resolve whether the ~43fps 1080p ceiling is a harness feed-pacing artifact, pool-bound, or a real decode/coordination ceiling. Measure-only, TypeScript/Node-only (no Rust).

**Architecture:** The throughput driver (`runThroughput` in `decodeBench.ts`) paces its measuring loop with `await sleep(10)` while nudging the decode anchor to the ring frontier. This plan parameterizes that delay so a run can drop it to ~0 (yield-only), keeping the anchor tracking the frontier (a far anchor would trip the native `on_request` >1s forward-seek). Combined with the existing `--pool-size`/`--pool-sweep`, a throttle×pool grid localizes the ceiling.

**Tech Stack:** TypeScript (renderer bench driver), Node ESM orchestrator (`decode-bench.mjs` + pure `bench-cli.mjs`), Vitest. NO Rust — the Stage-3 `preview-gpu` `.node` is reused unchanged; `npm run build` (electron-vite) does not touch it.

## Global Constraints

- Node **22.20.0**.
- **Measure-only:** build NO throughput fix; this probe only characterizes the ceiling.
- **No product/baseline behavior change:** `throttleMs` defaults to **10** everywhere, so the existing bench baseline is byte-equivalent when the flag is absent. Only the experiment varies it.
- **No Rust:** the `on_request` seek logic and `LOOKAHEAD_US` are untouched; a pool=12 lookahead plateau is a *finding*, not a fix.
- `parseThrottleMs` **allows 0** (that's the point) but rejects negative and non-integer.
- The driver keeps `requestFrameAt(last)` (anchor tracks the frontier) — do not change the anchor logic; only the sleep delay is parameterized.
- Evergreen comments (no dates/hashes). Any `docs/decode-bench.md` update stays qualitative.
- Staging: EXPLICIT paths only, never `git add -A`. Re-check `git status` before each commit (parallel sessions). No push, no formatter, no codex delegation. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Test: `npm run test -- <pattern>` (cwd `apps/desktop`, script = `vitest run`). Typecheck: `npm run typecheck` (`tsc -b`). mjs syntax: `node --check <file>`.
- Spec: `docs/superpowers/specs/2026-07-04-decode-bench-max-throughput-probe-design.md`.

## Interface carry-forward (existing code this touches)

- `apps/desktop/e2e/scripts/bench-cli.mjs` already exports `parsePoolSize(raw)` (returns `{ok:true,value}|{ok:false,error}`) and `SWEEP_POOL_SIZES=[3,6,9,12]`.
- `apps/desktop/src/renderer/render/decoder/decodeBench.ts`: `const sleep = (ms:number) => new Promise<void>((r)=>setTimeout(r,ms))`; `interface BenchArgs { sourcePath; durationUs; scenario; strategy; poolSize? }`; `async function runThroughput(h: BenchHandle, durationUs: number, token: CancelToken): Promise<BenchResult>` whose measuring loop calls `void h.requestFrameAt(last); await sleep(10);`; `decodeBenchRun`'s throughput case: `return runThroughput(livePool.acquire(mkInit("bench-0")), args.durationUs, token);`.
- `apps/desktop/e2e/scripts/decode-bench.mjs`: `arg(name,dflt)` reader; a `--pool-size` validation block (via `parsePoolSize`) placed after the `--strategy` check and before the fixtures/MAIN existence checks; `async function runSession(fixture, wantScenarios, poolSize)` building `const args = { sourcePath, durationUs, scenario, strategy, poolSize }`; single-run call `runSession(fixture, scenarios, POOL_SIZE)`; sweep-path call `runSession(fixture, ["throughput"], N)`.

---

### Task 1: `parseThrottleMs` in bench-cli.mjs

**Files:**
- Modify: `apps/desktop/e2e/scripts/bench-cli.mjs`

**Interfaces:**
- Produces: `parseThrottleMs(raw) -> { ok: true, value: number | undefined } | { ok: false, error: string }` — `undefined`/absent → `{ok:true,value:undefined}`; rejects non-integer and negative; **allows 0**.

- [ ] **Step 1: Add the helper**

Append to `apps/desktop/e2e/scripts/bench-cli.mjs`:

```javascript
/// Validate a --throttle-ms value: the throughput driver's per-loop pacing delay.
/// `undefined`/absent → default (10) applies downstream. Rejects non-integers and
/// negatives; ALLOWS 0 (the unthrottled/yield-only driver — the point of the probe).
export function parseThrottleMs(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `invalid --throttle-ms '${raw}' (expected a non-negative integer)` }
  }
  return { ok: true, value: n }
}
```

- [ ] **Step 2: Verify the helper (automated, no build)**

Run (from repo root `C:\Users\jonny\Desktop\learning\videtor`):

```bash
node --input-type=module -e "import {parseThrottleMs} from './apps/desktop/e2e/scripts/bench-cli.mjs'; const A=console.assert; A(parseThrottleMs('-1').ok===false,'-1'); A(parseThrottleMs('1.5').ok===false,'1.5'); A(parseThrottleMs('x').ok===false,'x'); A(parseThrottleMs('0').value===0,'0'); A(parseThrottleMs('10').value===10,'10'); A(parseThrottleMs(undefined).value===undefined,'undef'); console.log('parseThrottleMs OK')"
```

Expected: prints `parseThrottleMs OK` with no assertion failures. (Note the `0` case: `value===0` must hold — a naive `raw || default` would wrongly treat 0 as absent; this returns `value:0`.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/scripts/bench-cli.mjs
git commit -m "feat(decode-bench): parseThrottleMs helper (allows 0 for the unthrottled driver)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Configurable throttle in the bench driver

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts`

**Interfaces:**
- Produces: `BenchArgs.throttleMs?: number`; `runThroughput(h, durationUs, token, throttleMs = 10)` (4th param, default 10).

- [ ] **Step 1: Add `throttleMs` to `BenchArgs`**

In `decodeBench.ts`, extend the `BenchArgs` interface — add after the `poolSize?` field:

```typescript
  /// Throughput driver's per-loop pacing delay (ms). Default 10 (current behavior).
  /// 0 = yield-only (unthrottled) — the max-throughput probe. Baseline stays 10 when absent.
  throttleMs?: number;
```

- [ ] **Step 2: Thread it into `runThroughput`**

Change `runThroughput`'s signature to take the throttle as a 4th parameter defaulting to 10:

```typescript
async function runThroughput(
  h: BenchHandle,
  durationUs: number,
  token: CancelToken,
  throttleMs = 10,
): Promise<BenchResult> {
```

In its measuring loop, change the pacing delay from the hardcoded `await sleep(10)` to:

```typescript
    void h.requestFrameAt(last);
    await sleep(throttleMs);
```

(Leave the warm-up `await sleep(WARMUP_MS)` and the `requestFrameAt(last)` anchor nudge exactly as they are — only the loop's pacing `sleep` argument changes.)

- [ ] **Step 3: Pass it at the call site**

In `decodeBenchRun`, change the throughput case to forward `args.throttleMs` (undefined → the default 10 in `runThroughput`):

```typescript
        case "throughput":
          return runThroughput(livePool.acquire(mkInit("bench-0")), args.durationUs, token, args.throttleMs);
```

- [ ] **Step 4: Typecheck + existing tests**

Run (from `apps/desktop`): `npm run typecheck && npm run test -- decodeBench`
Expected: PASS. There is no new unit test — `throttleMs` is a pass-through default parameter with no branching logic; its *effect* is measured empirically in Task 4, and the value parsing is unit-checked in Task 1. Confirm the existing `decodeBench` tests still pass (the signature change is additive/defaulted, so `buildThroughputTiming` etc. are unaffected).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeBench.ts
git commit -m "feat(decode-bench): configurable throughput driver throttle (BenchArgs.throttleMs, default 10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `--throttle-ms` CLI flag + runSession threading

**Files:**
- Modify: `apps/desktop/e2e/scripts/decode-bench.mjs`

**Interfaces:**
- Consumes: `parseThrottleMs` (Task 1); `BenchArgs.throttleMs` (Task 2).
- Produces: `runSession(fixture, wantScenarios, poolSize, throttleMs)` passing `throttleMs` into the driver `args`.

- [ ] **Step 1: Import + validate the flag**

In `decode-bench.mjs`, add `parseThrottleMs` to the existing import from `./bench-cli.mjs`:

```javascript
import { parsePoolSize, parseThrottleMs, SWEEP_POOL_SIZES } from "./bench-cli.mjs";
```

Immediately after the existing `--pool-size` validation block (the `poolSizeParsed`/`POOL_SIZE` block that ends before the fixtures-existence check), add:

```javascript
const throttleParsed = parseThrottleMs(arg("throttle-ms", undefined));
if (!throttleParsed.ok) {
  console.error(`[decode-bench] ${throttleParsed.error}`);
  process.exit(1);
}
const THROTTLE_MS = throttleParsed.value; // undefined => driver default (10)
```

- [ ] **Step 2: Thread `throttleMs` through `runSession`**

Change `runSession`'s signature to accept the throttle and put it in the driver args:

```javascript
async function runSession(fixture, wantScenarios, poolSize, throttleMs) {
```

and in the `const args = { … }` literal inside the scenario loop, add `throttleMs` (only meaningful for the throughput scenario; harmless undefined otherwise):

```javascript
      const args = {
        sourcePath: benchFixturePath(fixture.name),
        durationUs: fixture.durationUs,
        scenario,
        strategy: STRATEGY,
        poolSize,
        throttleMs,
      };
```

- [ ] **Step 3: Pass `THROTTLE_MS` at both call sites**

Update the two `runSession` call sites to forward `THROTTLE_MS`:

- Single-run main loop: `perRun.push(await runSession(fixture, scenarios, POOL_SIZE, THROTTLE_MS));`
- Pool-sweep loop: `const out = await runSession(fixture, ["throughput"], N, THROTTLE_MS);`

(Match the exact surrounding code — these are the only two `runSession(...)` invocations.)

- [ ] **Step 4: Verify (syntax + fail-fast smokes, no build)**

Run (from repo root):

```bash
node --check apps/desktop/e2e/scripts/decode-bench.mjs ; echo "check exit=$?"
node apps/desktop/e2e/scripts/decode-bench.mjs --throttle-ms -1 ; echo "neg exit=$?"
node apps/desktop/e2e/scripts/decode-bench.mjs --strategy native --throttle-ms 0 --pool-sweep ; echo "zero exit=$?"
```

Expected: `node --check` exit 0 (valid syntax); `--throttle-ms -1` prints the invalid error and `neg exit=1` (fail-fast, before any Electron launch); `--throttle-ms 0 … --pool-sweep` passes the throttle validation — it will then proceed toward the sweep (do NOT let it run a full GPU sweep here; it's fine if it starts launching — Ctrl-C / kill it, the point is only that `0` is ACCEPTED, not rejected). If you can't safely interrupt it, instead assert acceptance with a unit check: `node --input-type=module -e "import {parseThrottleMs} from './apps/desktop/e2e/scripts/bench-cli.mjs'; console.assert(parseThrottleMs('0').ok===true); console.log('0 accepted')"`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/scripts/decode-bench.mjs
git commit -m "feat(decode-bench): --throttle-ms flag threaded into the throughput driver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Run the throttle×pool grid + verdict (controller-run, needs GPU)

**Files:**
- Modify: `docs/decode-bench.md` (only if the result changes the picture) + project memory.

**Interfaces:**
- Consumes: everything above. Produces native's max single-track 1080p throughput + a one-line ceiling verdict.

- [ ] **Step 1: Build the E2E app (no napi:build — Rust unchanged)**

From `apps/desktop`, no dev app running:

```bash
VITE_WEFTCUT_E2E=1 npm run build
```

Expected: `out/main/index.js` present. The Stage-3 `preview-gpu` `.node` is reused as-is.

- [ ] **Step 2: Run the grid (baseline throttle 10, then unthrottled 0), hevc-1080**

On the quiet dev machine (RTX 3050), from `apps/desktop` — each `--pool-sweep` loops pool {3,6,9,12}:

```bash
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-1080 --pool-sweep --throttle-ms 10 --runs 3
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-1080 --pool-sweep --throttle-ms 0  --runs 3
```

(Each writes `e2e/bench-results/<date>-<sha>-poolsweep.json` — the second overwrites the first, so copy the first aside between runs, e.g. `cp` to `maxtp-throttle10.json` / `maxtp-throttle0.json`. Optionally repeat both on `--fixture hevc-2160` for the 4K contrast.) Read the printed table's `fps` column across the throttle×pool grid, plus the timing buckets.

- [ ] **Step 3: Interpret + record the verdict**

Decision (spec §4):
- unthrottled@pool3 ≫ throttled@pool3 (≈43) ⇒ **driver-cadence artifact** — native can do higher single-track fps; the coordination rework is NOT needed for single-track 1080p.
- flat vs throttle but jumps vs pool ⇒ **pool-bound** — raise the native default pool for high-fps.
- flat across both knobs ⇒ **real decode/coordination ceiling** — ~43fps is native's true single-track max; higher-fps single-track needs the coordination rework (lever 3A/4).
- (A plateau specifically at pool=12 while pool=3→9 rose ⇒ the Rust 0.5s `LOOKAHEAD_US` window binds — record as a finding, no Rust change here.)

If the result changes the doc's characterization, update `docs/decode-bench.md`'s Native-strategy section (qualitative, evergreen). Commit if changed:

```bash
git add docs/decode-bench.md
git commit -m "docs(decode-bench): 1080p max-throughput probe — <verdict>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Update the project memory**

Update `project_decode_bench.md` (topic) + the `MEMORY.md` index line with the max-throughput verdict and its implication for the Stage-4 lever decision (does single-track 1080p need the coordination fix at all?).

---

## Self-Review

**1. Spec coverage:**
- §1 (unthrottle = drop driver sleep, anchor tracks frontier; both knobs) → Tasks 2 (throttle) + 4 (grid uses existing pool sweep). ✓
- §2 (`BenchArgs.throttleMs` default 10, `runThroughput` uses it, call-site threads `args.throttleMs`) → Task 2. ✓
- §3 (`parseThrottleMs` allows 0; `--throttle-ms` CLI + runSession threading) → Tasks 1, 3. ✓
- §4 (grid = `--pool-sweep` × throttle {10,0} on hevc-1080; interpretation table) → Task 4. ✓
- §5 (parseThrottleMs unit check incl. 0; throttle threading via typecheck; run is controller-run) → Tasks 1, 2, 4. ✓
- §6 (measure-only, default-10 no-behavior-change, no Rust) → Global Constraints + Task-2 default. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. Task 3 Step 4's `--throttle-ms 0 --pool-sweep` smoke has a documented fallback (unit check) if the sweep can't be safely interrupted. Task 4's commit-message `<verdict>` is intentionally filled from the run result.

**3. Type consistency:**
- `throttleMs` name identical across `BenchArgs` (Task 2), `runThroughput`'s param (Task 2), the `decodeBenchRun` call site (Task 2), `runSession` param + `args` (Task 3), and `THROTTLE_MS`/`--throttle-ms` (Task 3). ✓
- `parseThrottleMs` return shape `{ok,value}|{ok,error}` matches `parsePoolSize`'s and its consumption in Task 3. ✓
- Default 10 is expressed once as `runThroughput`'s param default; every upstream layer passes `undefined` when the flag is absent, resolving to 10. ✓

No inconsistencies found.
