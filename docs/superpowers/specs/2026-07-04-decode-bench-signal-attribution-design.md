# decode-bench signal-attribution — coordination sub-hop measurement — Design

**Goal:** Split the native per-frame coordination round-trip (`coordRtt`) into per-boundary
buckets — **Rust↔main** vs **main↔renderer** — so the Stage-4 throughput fix is chosen from
data rather than guessed: if the main↔renderer IPC hop dominates, a dedicated-port scheme
(lever 3B) is worth trying; if the Rust↔main boundary is also fat or the cost is diffuse,
skip 3B and go straight to shared-memory signalling / a pull model (lever 3A / lever 4).
This is **measure-only** — no fix, no behavior change, just timestamps.

Context (adopted as-is): Stage 3 (`docs/superpowers/specs/2026-07-04-decode-bench-stage3-measure-first-design.md`,
merged to local `main` `14da4d7d`) established native throughput is **latency/congestion-bound,
not depth-bound** (flat across a pool-size sweep while per-frame latency grows ∝ N). But
`coordRtt` is a single Rust-clock `emit→ack` number; we do not yet know *which* boundary the
~22ms/frame dead time lives in. This slice attributes it. The Stage-3 instrument stays as-is:
Rust `TimingAccum` (`coordRtt` + decode/copy) drained via `preview_gpu_take_timings`; preload
`gvfMs`/`cibMs`/`residentMs` piggybacked on the frame `PortFrameMsg`; `decodeBench.buildThroughputTiming`.

## 1. The clock problem and the method

The coordination loop spans **three clock domains** — Rust `Instant`, main `performance.now`,
renderer `performance.now` — with no shared origin, so cross-clock subtraction is invalid.
Rather than calibrate an offset, measure each round-trip **in whichever process sees BOTH its
ends**, entirely within that process's own clock:

- **Rust** sees `emit` and `ack-applied` → `coordRtt` = the whole loop. *(already measured)*
- **Main** sees the `frameReady` `webContents.send` and the `consumeAck` receipt → the
  **renderer round-trip** = main→renderer transit + renderer work + renderer→main transit.
  *(new — main clock)*
- **Renderer** sees `frameReady`-received and `ack`-sent → `residentMs` = renderer work
  (getVideoFrame + createImageBitmap). *(already measured, piggybacked)*

The three buckets, each a within-clock subtraction (no calibration):

| Bucket | Formula (means) | What it is |
| --- | --- | --- |
| **Rust↔main boundary** | `coordRtt − rendererRoundTrip` | tsfn (Rust thread→main loop) + mpsc (main→Rust thread) + main dispatch |
| **main↔renderer transit** | `rendererRoundTrip − residentMs` | pure cross-process IPC + event-loop queue waits (both directions), renderer work removed |
| **renderer work** | `residentMs` (of which `cibMs`) | getVideoFrame + createImageBitmap |

Their sum reconstructs `coordRtt`, and equals the existing `ipcTransitMsDerived`
(`coordRtt − residentMs`) split into its two halves — so `ipcTransitMsDerived` becomes a
sanity check on `rustMainBoundary + mainRendererTransit`.

## 2. Main-side round-trip timestamping

The `frameReady` poke is relayed by the generic Backend `onEvent` catch-all
(`main/index.ts:198`, `webContents.send('evt:' + event, payload)`); `consumeAck` is
`ipcMain.handle('previewGpu:consumeAck', …)` (~`main/index.ts:445`, delegating to
`consumeAckPreviewGpu`). Both carry `{ streamId, slot }`.

New main-side state + logic lives in `main/previewGpu.ts` (a module-level singleton — the
bench runs one session at a time, serially):

- `pendingSend: Map<"streamId:slot", number>` — `t_send`.
- `rtSamplesMs: number[]` — capped (e.g. 20_000, stop-appending, matching the Rust cap).
- `recordFrameReadySent(streamId, slot, nowMs)` — `pendingSend.set(key, nowMs)`.
- `recordConsumeAck(streamId, slot, nowMs)` — if a `t_send` exists for the key, push
  `nowMs − t_send` into `rtSamplesMs` and delete the entry (1:1 pairing, mirrors Rust's
  `slot_emit` `Option::take`).
- `takeMainTimings(): { rendererRoundTripMs: Summary }` — summarize (`count/meanMs/p50Ms/p95Ms/maxMs`,
  linear-interp percentiles matching the Rust/TS convention) and clear `rtSamplesMs`.
- `clearMainTimings(streamId)` — drop any `pendingSend` entries for a stream; called from
  `closePreviewGpu` so an un-acked frame at teardown can't leak a map entry.

`main/index.ts` wires two one-line calls (both using `performance.now()`, available in the
Electron main Node context): a `if (event === 'previewGpu:frameReady')` branch in the
`onEvent` relay calling `recordFrameReadySent(payload.streamId, payload.slot, performance.now())`,
and `recordConsumeAck(a.streamId, a.slot, performance.now())` at the top of the `consumeAck`
handler. Both are cheap and only fire for native preview-gpu sessions (already E2E-gated); the
prod path is otherwise untouched.

`takeMainTimings` returns a `PreviewGpuTimingSummary` (the napi-style `count/meanMs/p50Ms/p95Ms/maxMs`
shape, so the bridge is uniform with `takeTimings`), so main needs a `msSummary(samples: number[]):
PreviewGpuTimingSummary` helper. Its percentile formula must match the linear-interp convention
already used by `decodeBench.percentile` and the Rust `summarize`. To avoid a third copy of that
formula, hoist the shared `percentile` core to a small pure module both main and the bench import
(the bench's `statsOf` still produces its own `MsStats` shape — only the percentile/mean core is
shared, not the summary type).

## 3. `takeMainTimings` bridge

Mirrors the existing `takeTimings` wiring:

- `shared/ipc.ts`: `PreviewGpuMainTiming = { rendererRoundTripMs: PreviewGpuTimingSummary }`
  (reuses the existing `PreviewGpuTimingSummary` shape); add
  `takeMainTimings(): Promise<PreviewGpuMainTiming>` to `WeftcutApi.previewGpu`.
- `preload/index.ts`: `takeMainTimings()` → `ipcRenderer.invoke('previewGpu:takeMainTimings')`.
- `main/index.ts`: `ipcMain.handle('previewGpu:takeMainTimings', () => takeMainTimingsPreviewGpu())`.
- `main/previewGpu.ts`: `takeMainTimingsPreviewGpu()` returns the drained accumulator. No
  `backend`/napi round-trip — this is pure main-process state (unlike `takeTimings`, which
  drains the Rust registry). No `streamId` arg: the accumulator is a main-relay singleton and
  the bench is serial (documented assumption).

## 4. decodeBench assembly

- `ThroughputTiming` gains: `rendererRoundTripMs: MsStats`, `rustMainBoundaryMs: number`,
  `mainRendererTransitMs: number` (keep `ipcTransitMsDerived` as the sanity-check sum).
- `buildThroughputTiming(poolSize, rust, pre, main)` gains a `main: PreviewGpuMainTiming` param;
  computes `rendererRoundTripMs = summaryToStats(main.rendererRoundTripMs)`,
  `rustMainBoundaryMs = rust.coordRtt.meanMs − main.rendererRoundTripMs.meanMs`,
  `mainRendererTransitMs = main.rendererRoundTripMs.meanMs − preloadResidentMs.mean`.
- In `runThroughput`'s native branch, also `await window.api.previewGpu.takeMainTimings()`
  (alongside the existing `takeTimings`), before the pool disposes — pass it to
  `buildThroughputTiming`.

## 5. Orchestrator + confirmation run

No new CLI. The buckets ride the existing `timing` block, so the `--pool-sweep` table and the
single-run report both surface them (add the new columns to the sweep table:
`rendererRT p50`, `rustMain`, `mainRend`). The attribution is what we're after — not the sweep
shape (already known flat in N) — so the confirmation run is a **single N=3 run** (product
default, no artificial congestion) per fixture:

```
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-1080 --pool-size 3 --runs 3
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-2160 --pool-size 3 --runs 3
```

Read the three buckets from `throughput.timing`. **Decision:** `mainRendererTransitMs`
dominant → 3B worth trying; `rustMainBoundaryMs` comparable/larger or the split diffuse → skip
3B, go 3A / lever 4.

## 6. Testing

- Extract `msSummary(samples)` as a pure helper; unit-test its percentile/mean/cap against a
  known vector (reuse the Stage-3 `[10..50]ms → p50 30 / p95 48 / max 50 / mean 30` fixture).
- Unit-test the main pairing logic as a pure function `pairRoundTrip(sendMs, ackMs)` (or by
  driving `recordFrameReadySent`/`recordConsumeAck`/`takeMainTimings` with injected `nowMs`):
  one send+ack → one sample = `ackMs − sendMs`; an ack with no prior send → no sample; drain
  clears; a second stream's key doesn't collide.
- Extend the `buildThroughputTiming` test for the two derived buckets: given `coordRtt.mean`,
  `rendererRoundTrip.mean`, and `residentMs`, assert `rustMainBoundaryMs` and
  `mainRendererTransitMs` equal the expected subtractions.

## 7. Scope guard (measure-first discipline)

- Measure-only: build NO fix (no dedicated port, no SharedArrayBuffer, no pull model). This
  slice chooses between them.
- No behavior change: main adds two `performance.now()` calls + a small Map on the existing
  relay/handler; nothing about frame delivery, acking, or the WebCodecs path changes.
- Main timing is a bench/native-session concern; the prod path (no native session) never
  populates it, and the `takeMainTimings` bridge is bench-only usage.
- Serial-only assumption (one native session at a time) is inherent to the bench and matches
  the existing per-frame `mainWindow`-targeted relay (a known single-window constraint).

**Terminal deliverable:** the three-bucket attribution (Rust↔main / main↔renderer / renderer
work) for hevc-1080 + hevc-2160 at N=3, plus a one-line verdict naming the dominant boundary
and the lever it selects (3B vs 3A/lever 4).
