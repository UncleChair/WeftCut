# Decode-Strategy Benchmark (decode-bench) — Design

**Goal:** Build a permanent, repeatable benchmark that compares the two preview
decode strategies — the shipping WebCodecs pipeline and the native-ffmpeg
GPU/shared-texture pipeline (`poc/shared-texture-import`) — decoding the **same
original file**, across four metrics: sustained decode throughput, seek/scrub
latency, cold-start first-frame latency, and CPU/GPU utilization. The data
pins the open product parameters of the parallel decode option (codec
coverage, concurrency cap, 4K viability, zero-copy-v2 priority) and the
harness stays as the long-term performance regression bed for both paths.

**Relationship to prior work:** the parallel decode option itself is designed
in `poc/shared-texture/INTEGRATION-DESIGN.md` (on branch
`poc/shared-texture-import`) and is **adopted as-is**. That design was proven
feasible end-to-end (FINDINGS.md Results 1–7) but never speed-compared against
WebCodecs — the only perf number on record (~53–75 fps, Result 3) measured a
per-frame-IPC bound that Result 4 already eliminated. This spec adds the
missing measurement infrastructure plus two tiny product-code touches it
needs.

## Settled decisions (from the design dialogue)

1. **Role: permanent benchmark infrastructure** (like
   `e2e/scripts/memory-ratchet.mjs`), not a one-off decision gate and not an
   in-product A/B counter.
2. **Metrics: all four** — throughput, seek latency, cold start, CPU/GPU.
3. **Pairing: same-source only.** Both strategies decode the identical
   original file. No proxy-vs-original pairing: this benchmark answers "which
   decoder is faster", not "which user experience is faster". (The proxy
   path's short-GOP scrub advantage is therefore deliberately out of frame.)
4. **INTEGRATION-DESIGN adopted as baseline** for the parallel option: opt-in
   `AppSettings` switch, preview-only, Proxied-route 8-bit hard codecs,
   `createImageBitmap → FrameRing` join, 3-piece process layout, session
   fallback. This spec changes none of it; benchmark data later refines its
   defaults (see Decision checkpoints).

## Scope

1. **Fixture generator** — `apps/desktop/e2e/scripts/gen-decode-bench-fixtures.mjs`.
2. **Node orchestrator** — `apps/desktop/e2e/scripts/decode-bench.mjs`
   (Playwright `_electron`, local-only, skipped on CI like `media_conformance`).
3. **In-renderer scenario driver** —
   `apps/desktop/src/renderer/render/decoder/decodeBench.ts`, E2E-gated.
4. **Two product-code touches:** an always-on `pushCount` counter on
   `FrameRing`, and an E2E-only `forceStrategy` field consumed by the decode
   strategy selection gate in `SourceDecoderPool.acquire()` (the gate itself
   is built by the INTEGRATION-DESIGN integration, not this spec).
5. **A short evergreen doc** — `docs/decode-bench.md`.

## Non-goals (recorded, deliberate)

- **No proxy-pairing scenarios** (settled decision 3). If a "user-perceived
  latency" comparison is wanted later, it is a new scenario file, not a
  redesign.
- **No pass/fail gating in v1.** The report is informative; cross-strategy
  comparison is a decision input, not a regression assertion. Per-strategy
  ratchets (memory-ratchet style) can be added once baselines stabilize.
- **No decode-core microbenchmark layer** (approach C rejected): the
  `DecoderHandle` seam already captures each path's true end-to-end cost;
  decomposition can be added if attribution questions actually arise.
- **No CI execution.** GPU-decode benchmarks on headless CI runners are
  meaningless (see `reference_electron_ci_gotchas`); the harness is
  local-only by construction.
- **No 10-bit native cells.** Result 7 blocked P010 shared-texture import;
  Hi10P appears as a WebCodecs-only reference row until a native P010→BGRA
  convert exists.

## Section 1 — Architecture

Three components, following the existing `media_conformance` /
`memory-ratchet` patterns:

```
decode-bench.mjs (Node orchestrator)
  ├─ launches the real app via Playwright _electron (VITE_WEFTCUT_E2E=1 build)
  ├─ spawns typeperf sampling GPU engine counters (VideoDecode, 3D)
  ├─ polls app.getAppMetrics() via electronApp.evaluate (per-process CPU)
  ├─ page.evaluate → window.__weftcutBench.runScenario({...})
  └─ writes JSON report + prints a markdown comparison table

decodeBench.ts (renderer scenario driver, E2E-gated)
  ├─ owns a private SourceDecoderPool instance (never the app's live pool —
  │    no layer/UI interference, controlled lifecycle)
  ├─ strategy 'webcodecs': acquire() with the ORIGINAL file URL passed as
  │    SourceHandleInit.proxyAssetUrl (that field controls what the handle
  │    decodes — same-source pairing needs no routing change)
  └─ strategy 'native': acquire() with the E2E-only forceStrategy field
       (bypasses the settings switch + route gate)

gen-decode-bench-fixtures.mjs (fixture generator)
  └─ sidecar ffmpeg synthesizes the deterministic matrix into
       apps/desktop/e2e/fixtures/decode-bench/ (gitignored, regenerated on
       demand, ffprobe-validated after generation)
```

Product-code touches (both tiny, both generally useful):

- **`FrameRing.pushCount`** — a monotonically increasing counter incremented
  on every ring push. Always on (one integer increment); the throughput
  scenario reads Δ`pushCount`/Δt; `PerfHUD` may display it.
- **`forceStrategy?: 'webcodecs' | 'native'`** on `SourceHandleInit` —
  honored only under `VITE_WEFTCUT_E2E=1`, ignored otherwise. Lives in the
  selection gate the integration adds to `acquire()`.

## Section 2 — Test matrix & fixtures

All fixtures: 60 s deterministic synthetic content (`testsrc2`), 30 fps,
**GOP 240 frames (8 s)** — long-GOP like real originals, which is where seek
behavior differs most between the strategies.

| fixture | codec | resolution | bitrate | WebCodecs | native |
|---|---|---|---|---|---|
| h264-1080 | H.264 High | 1920×1080 | 12 Mbps | HW | HW (control row) |
| hevc-1080 | HEVC Main 8-bit | 1920×1080 | 8 Mbps | platform codec | HW (headline) |
| hevc-2160 | HEVC Main 8-bit | 3840×2160 | 40 Mbps | platform codec | HW (headline) |
| vp9-1080 | VP9 Profile 0 | 1920×1080 | 8 Mbps | HW/SW | HW |
| av1-1080 | AV1 Main | 1920×1080 | 8 Mbps | SW (omit prefer-hardware) | HW (weakest case) |
| hi10p-1080 | HEVC Main10 | 1920×1080 | 8 Mbps | SW + flush | **N/A** (Result-7 P010 block; reference row) |

A strategy that cannot decode a fixture records the cell as `unsupported`
(with the failure reason) rather than failing the run — the coverage matrix
is itself a deliverable.

## Section 3 — Scenarios & metrics

One strategy per app session; strategies run **serially**, never concurrently.
Each matrix cell runs **3 times; the median is reported** along with spread.

1. **sustained-throughput** — 2 s warm-up excluded, then a 30 s measured
   window. The driver keeps the anchor at the ring frontier (re-anchoring to
   `latestPts` as it advances) so the pump never idles.
   Metrics: `fps = ΔpushCount / wall-seconds`, plus **×realtime**
   (content-seconds decoded per wall-second) — the number that maps directly
   to "how many simultaneous tracks fit". Resource sampling runs only inside
   this window.
2. **seek-latency** — 40 fixed seek targets (a committed constant list
   spanning 5–95 % of duration), four categories: forward-near (+0.2 s),
   forward-far (+15 s), backward-near (−0.5 s), backward-far (−20 s).
   Measure wall time from `requestFrameAt(T)` to `ring.containsPts(T)`
   (tight rAF/microtask poll, `performance.now()`). Report P50/P95/max per
   category. The ring is NOT cleared between seeks (realistic scrub retains
   it); the categories separate in-ring hits from true decode-path seeks.
3. **cold-start** — 10 iterations of fresh `acquire()` →
   `requestFrameAt(5 s)` → first `containsPts` → `release()`. Iteration 1
   reported separately (unamortized decoder init) from iterations 2–10
   (distribution).
4. **resource sampling** — during the throughput window only:
   - `app.getAppMetrics()` at 2 Hz → per-process CPU% (mean/max). Attribution
     matters and is reported per process: native decode CPU lands in the
     **main** process (the napi addon); WebCodecs decode lands in renderer +
     GPU process. Totals are reported alongside the breakdown.
   - `typeperf "\GPU Engine(*engtype_VideoDecode)\Utilization Percentage"
     "\GPU Engine(*engtype_3D)\Utilization Percentage" -si 1` → mean/max.
     The 3D engine is where `createImageBitmap` conversion cost shows up.
     Caveat (documented in the report): these counters are machine-wide;
     runs require a quiet machine.

**Fairness controls:**

- Same file URL both sides; serial execution; fixed window sizes.
- **`--self-check` mode**: WebCodecs vs WebCodecs on the same fixture, twice;
  |Δfps| must be < 5 % — calibrate the instrument before trusting readings.
- Report carries an environment block: GPU name, driver version, Electron/
  Chromium version, ffmpeg version, git SHA, fixture generator version.
- Known, accepted asymmetry (measured, not noise): the WebCodecs side reads
  via `weftcut-media://` HTTP-Range (`MediaRangeSource`), the native side
  reads the OS path directly. That is each path's real I/O cost structure
  and is part of the measurement; the report notes it.

**Output:** JSON to `apps/desktop/e2e/bench-results/<ISO-date>-<gitsha>.json`
(gitignored) + a printed markdown table. Timebox 90 s per scenario; a hung
cell records `timeout` and the run continues. Exit code is non-zero only on
harness failure, never on "slow" results.

## Section 4 — Staging

- **Stage 1 (buildable now, before any integration):** fixture generator,
  orchestrator, driver, WebCodecs side, resource sampling, self-check.
  `forceStrategy` is not needed here — WebCodecs is the only strategy and the
  default. Deliverable: baseline numbers for WebCodecs decoding originals,
  and a validated instrument.
- **Stage 2 (after INTEGRATION-DESIGN steps 2–4 land `NativeGpuSourceHandle`):**
  the same driver lights up `forceStrategy: 'native'`; the full matrix runs.
  The benchmark doubles as the integration's acceptance tool.

## Section 5 — Decision checkpoints (data → product parameters)

Once Stage 2 data exists, resolve each of these explicitly (in the
integration's follow-up, not this spec):

1. **Native default codec set** — drop AV1 from the native set if it shows no
   advantage over WebCodecs software decode.
2. **Concurrent native-decoder cap** — replace the guessed 3–4 with the
   measured knee (NVDEC session limits / throughput collapse point).
3. **4K-in-v1** — does hevc-2160 sustain ≥ 1.0× realtime on representative
   hardware? If not, gate 4K originals out of the native route.
4. **Zero-copy v2 priority** — if native throughput already clears multi-track
   budgets with headroom, the `createImageBitmap` copy stays; if the 3D-engine
   utilization or per-frame cost is the visible ceiling, v2 rises.

## Section 6 — Acceptance

- `--self-check` variance < 5 %.
- Every matrix cell yields data or an explicit `unsupported`/`timeout` with
  reason.
- Stage-1 baseline run completes on the dev machine (RTX 3050) and the report
  renders.
- `docs/decode-bench.md` added (evergreen style: what it measures, how to run,
  how to read the report; no dates/phases).
- Existing suites unaffected (`FrameRing` counter is add-only;
  `forceStrategy` is inert outside E2E builds).
