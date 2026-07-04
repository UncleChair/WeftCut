# decode-bench max-throughput probe — is 1080p feed-paced or a real ceiling? — Design

**Goal:** Determine native's *true* maximum single-track 1080p decode throughput by removing the
bench driver's feed pacing (and varying the pool), to resolve the open question the
signal-attribution slice left: **is the observed ~1.4× realtime (~43fps) 1080p ceiling a harness
feed-pacing artifact, or native's real capacity ceiling?** Measure-only, TypeScript-only (no Rust),
no product behavior change.

Context (adopted as-is): signal-attribution (merged local `main` `024829e0`) showed that at N=3,
1080p the whole coordination round-trip (`coordRtt` ≈ 3.8ms) is a *small fraction* of the delivered
frame interval (~23ms) — so ~93% of each per-slot cycle is idle, and the 1080p throughput is set by
how fast the driver *feeds* the pump, not by decode or coordination. The bench's throughput driver
(`runThroughput` in `apps/desktop/src/renderer/render/decoder/decodeBench.ts`) currently paces itself
with `await sleep(10)` per loop iteration while nudging the decode anchor to the ring frontier. This
probe tests whether that `sleep(10)` (and/or the 3-slot pool) is what caps 1080p.

## 1. Why "unthrottle" means *drop the driver sleep*, not *set a far anchor*

The obvious "run flat out" idea — point the anchor at the clip end so the pump always has work — is
**wrong here**: the native session's `on_request` (`native/src/preview_gpu/session.rs`) **seeks** on
any forward jump more than `SEEK_FORWARD_THRESHOLD_US` (1s) beyond the decoded frontier. A far anchor
would seek to EOF and decode only a few frames near the end, not drive the whole clip. So the driver
must keep the anchor **tracking the frontier** (exactly what `requestFrameAt(last)` already does) and
the only safe "unthrottle" is removing the driver-side pacing delay.

Because analysis can't predict whether the cap is the driver cadence or the 3-slot pool (the measured
`coordRtt` of ~3.8ms implies a pool-cycle ceiling of ~600fps, yet we observe ~43fps — something
serializes delivery), the probe varies **both** knobs: driver throttle × pool size.

## 2. Configurable driver throttle

- `BenchArgs` gains `throttleMs?: number` (default **10** — the current behavior, so the baseline is
  unchanged when the flag is absent).
- `runThroughput` takes the throttle from args and uses `await sleep(throttleMs)` in place of the
  hardcoded `await sleep(10)` in its measuring loop. Everything else — the `requestFrameAt(last)`
  frontier-tracking nudge, the warm-up, the window/EOF logic, the `pushCount`-based fps — is unchanged.
- `throttleMs: 0` yields to the event loop via `setTimeout(0)` (~1ms clamp in the renderer), which is
  enough to let the `MessagePort` frame messages (macrotasks) deliver into the ring, but removes the
  10ms cap. It is a *yield*, not a busy-spin (a microtask-only yield would starve port delivery).

`runThroughput`'s signature threads the throttle through (it currently takes `(h, durationUs, token)`;
add the throttle as a parameter sourced from `args.throttleMs ?? 10` at the call site in
`decodeBenchRun`).

## 3. CLI flag

- `apps/desktop/e2e/scripts/bench-cli.mjs` gains `parseThrottleMs(raw)` — mirrors `parsePoolSize`:
  `undefined`/absent → `{ ok: true, value: undefined }` (driver default 10 applies); rejects
  non-integer and negative; **allows 0** (that's the whole point). Returns `{ ok, value } | { ok, error }`.
- `decode-bench.mjs` parses `--throttle-ms <n>`, validates via `parseThrottleMs` (exit 1 on bad, same
  fail-fast placement as `--pool-size`), and threads the value into the driver `args` (like `poolSize`).

## 4. The grid + run

Run the existing `--pool-sweep` (which already loops pool {3,6,9,12}) **twice** — once
`--throttle-ms 10` (baseline) and once `--throttle-ms 0` (unthrottled) — on hevc-1080, ×3 runs each.
That yields the full **throttle {10,0} × pool {3,6,9,12}** grid (read pool 3 and 12 as the endpoints),
with the timing buckets (`coordRttMs`, `rendererRoundTripMs`, etc.) per cell. Optionally repeat on
hevc-2160 for contrast (4K was coordination-limited, so it should be *less* sensitive to the driver
throttle).

**Interpretation:**

| Observation | Conclusion | Implication |
| --- | --- | --- |
| unthrottled@pool3 ≫ throttled@pool3 | driver-cadence artifact | native *can* do higher single-track fps; the ceiling was the bench feed |
| flat vs throttle, jumps vs pool | pool-bound | raise the native default pool for high-fps use |
| flat across both knobs | real decode/coordination ceiling | ~43fps is native's true single-track max; higher-fps single-track needs the coordination rework |

If pool=12 gets gated by the Rust 0.5s lookahead window (~15 frames), that surfaces as a plateau at
pool=12 and is recorded as a finding — the Rust `LOOKAHEAD_US` const is **not** touched (keeps this slice
TS-only).

## 5. Testing

- `parseThrottleMs` — a `node --input-type=module -e` assertion (like the Stage-3 `parsePoolSize` check):
  rejects `-1` and `1.5`, **accepts `0`** and `12` and `undefined`.
- `runThroughput` throttle threading — a `decodeBench` test asserting the default is 10 when
  `throttleMs` is absent (e.g. via `buildBenchArgs`/`mkInit` shape, or a focused unit around the arg
  plumbing). Typecheck covers the signature change.
- The grid run itself needs the GPU/E2E build (controller-run, like the prior confirmation runs) — not a
  unit test.

## 6. Scope guard (measure-first discipline)

- Measure-only: build NO throughput fix. This probe only characterizes the ceiling.
- No product/baseline behavior change: `throttleMs` defaults to 10, so the shipping-irrelevant native
  path and the existing bench baseline are byte-equivalent when the flag is absent. Only the experiment
  varies it.
- No Rust: the `on_request` seek logic and `LOOKAHEAD_US` are untouched; a pool=12 lookahead plateau is a
  *finding*, not something to fix here.
- Evergreen comments; `docs/decode-bench.md` update (if the result warrants one) stays qualitative.

**Terminal deliverable:** the throttle×pool grid for hevc-1080 (+ optional 4K) + a one-line verdict —
*driver-artifact* (native can go faster; the coordination rework is not needed for single-track 1080p),
*pool-bound* (raise the default pool), or *real ceiling* (higher-fps single-track needs the coordination
rework) — recorded to the project memory and, if it changes the picture, to `docs/decode-bench.md`.
