# decode-bench Stage 3 — native throughput measure-first slice — Design

**Goal:** Explain *why* the native GPU-decode path is 16–21× slower than WebCodecs at
1080p throughput despite an idle GPU decoder, and produce the data that decides which
fix to build — WITHOUT building any fix yet. Stage 2 established the *what* (native is
coordination-bound, not decode-bound; seek wins 8–16×; AV1 out; 10-bit out). Stage 3's
first slice localizes the per-frame coordination cost and answers one binary question:
**is throughput depth-bound (cheap fix) or latency/congestion-bound (expensive fix)?**

This is a **measure-first** spec — instrumentation and an experiment, not an
optimization. It changes no product behavior: the shipping WebCodecs path is untouched,
the native default pool size stays 3, and nothing new ships to a production preview
(native remains `preview-gpu` cargo-feature + `forceStrategy` E2E-gated).

Prior context adopted as-is:

- `docs/superpowers/specs/2026-07-03-decode-bench-stage2-native-path-design.md` — the
  native path this instruments; merged to local `main` (`38dd4180`).
- `docs/decode-bench.md` — the evergreen benchmark doc.
- The Stage-2 diagnosis (in the project memory): throughput ≈ pipeline_depth N ÷
  per-slot-cycle-latency L; at N=3, ~44fps ⇒ L≈68ms/slot. The 4K>1080p anomaly
  (native 4K 105fps > native 1080p 44fps) is the congestion tell: L is not constant, it
  inflates when cheap 1080p frames flood the signaling channel + Node event loop.

## 1. What we are measuring, and why it can be measured cheaply

The per-frame coordination loop crosses three clock domains:

1. **Rust session thread** (`native/src/preview_gpu/session.rs`): `pump()` decodes a
   frame, `copy_frame_into_slot` copies it into a shared NV12 slot, then
   `emit(FrameReady{slot, pts, dur})` through the poke sink.
2. **Main process** (`main/index.ts`): receives the poke, `webContents.send('evt:previewGpu:frameReady', …)`.
3. **Renderer process** — two worlds:
   - preload (`preload/index.ts`): `getVideoFrame()` → `await createImageBitmap(vf)` →
     `vf.close()` → `port.postMessage({…, bitmap}, [bmp])` → `consumeAck` invoke.
   - main world (`NativeGpuSourceHandle.ts`): `port.onmessage` → `ring.push(bitmap, …)`.
   The ack returns preload → main → napi → registry → session-thread mpsc
   (`SessionMsg::ConsumeAck`) → `free[slot]=true` → `pump()` refills the slot.

Main is a separate OS process from the renderer, so their `performance.now()` origins
differ — naive cross-process timestamps are not comparable. We avoid clock sync entirely
by measuring only **within-process deltas** and deriving the one cross-process quantity
by subtraction:

| Segment | Measured in | How |
| --- | --- | --- |
| **decode+copy** | Rust thread (its `Instant`) | wrap `next_frame` + `copy_frame_into_slot` per delivered frame |
| **coordination RTT** (main-relay-out + preload work + ack-relay-back) | Rust thread (its `Instant`) | stamp `slot_emit[slot]` at `FrameReady`; on `ConsumeAck(slot)`, sample `now − slot_emit[slot]` |
| **preload-resident** (of which `createImageBitmap` is a sub-part) | preload (`performance.now`) | measure `getVideoFrame`, `createImageBitmap`, and total entry→ack in the `frameReady` handler |
| **IPC transit** (main↔renderer both ways + event-loop scheduling) | derived | `coordinationRTT − preloadResident`, compared at the p50/mean level |

**Why the Rust `emit → ack` delta captures the whole JS round-trip:** the ack for a slot
returns to the *same* thread that emitted `FrameReady` for it, so both endpoints share one
monotonic clock. The protocol guarantees a clean 1:1 pairing — a slot is emitted, then
must be `consume_ack`'d before it is reused (`free[slot]` stays false until the ack); the
`AcquireFailed` and post-seek-discard paths never emit `FrameReady`, so `slot_emit[slot]`
is only ever set for a delivered frame and is read-and-cleared exactly once at its ack.

For a "depth-bound vs latency-bound" diagnosis, p50/mean precision is sufficient — we do
not need per-frame cross-process alignment, so the fragile clock-sync infrastructure is
unnecessary.

## 2. Part A — timing instrumentation

### 2.1 Rust side (`preview_gpu/session.rs` + `mod.rs`)

- New `TimingAccum` struct: two sample vectors (`coord_rtt_ns`, `decode_copy_ns`), each
  capped at 20_000 samples with a **stop-appending-once-full** policy (a 30s window at
  native's ~44fps yields ~1300 samples — far under the cap; the cap is only a runaway
  backstop, and timing is native-only so WebCodecs frame rates never reach it) so a long
  run cannot grow unbounded. Methods: `push_*`,
  and `drain() -> TimingSummary` returning `{count, mean, p50, p95, max}` (ms) per metric,
  clearing the buffers.
- Shared as `Arc<Mutex<TimingAccum>>` between the session thread and the registry. The
  thread appends under the lock once per delivered frame and once per ack — one extra
  mutex acquire beside the poke-sink mutex already taken per frame; negligible next to a
  D3D11 `CopySubresourceRegion` + `Flush`.
- `SessionState` gains `slot_emit: Vec<Option<Instant>>` (thread-local, sized to the
  pool) and a `decode_copy` timer around the pump's decode+copy. On `FrameReady`, set
  `slot_emit[slot]`. On `ConsumeAck(slot)`, if `slot_emit[slot]` is `Some`, push the RTT
  sample and clear it.
- Registry: `take_timings(stream_id) -> TimingSummaryPair` locks the session's
  `Arc<Mutex<TimingAccum>>` and drains it. Read-at-end-of-window is enough (the throughput
  scenario reads before dispose), so no reply-channel plumbing is needed.

### 2.2 napi + main + bridge

- napi: `preview_gpu_take_timings(stream_id) -> { coordRtt: Summary, decodeCopy: Summary }`
  on the addon (`napi_backend.rs`), delegating to the registry.
- main (`main/previewGpu.ts` + `main/index.ts`): a `previewGpu:takeTimings` IPC handler
  calling `backend.previewGpuTakeTimings(streamId)`.
- bridge (`preload/index.ts` + `shared/ipc.ts`): `window.api.previewGpu.takeTimings(streamId)`.
  This matches the existing dedicated-method pattern for `previewGpu.*` (rather than the
  generic `backend.invoke`), keeping the native session surface consistent.

### 2.3 Preload side (piggyback — zero extra IPC)

- In the `evt:previewGpu:frameReady` handler, measure `getVideoFrame` ms, `createImageBitmap`
  ms, and total resident ms (handler entry → just before the `consumeAck` invoke).
- Attach `gvfMs`, `cibMs`, `residentMs` to the existing `PortFrameMsg` — they ride the
  frame message already crossing to the main world; no new channel.
- `NativeGpuSourceHandle.handlePortMessage` aggregates these into per-handle accumulators
  (running count + sums + a capped sample buffer for p50/p95). The three `performance.now()`
  calls per frame are computed unconditionally (trivially cheap) but only *consumed* by the
  bench, so there is no meaningful prod cost even after Slice B ships native.

## 3. Part B — pool-size sweep

- `NativeGpuSourceHandle` currently hardcodes `poolSize: 3` in `_doEnsureReady`. Add a
  constructor parameter `poolSize` (default 3) and use it in the `previewGpu.open` call.
- Thread the override end-to-end for the bench only: `SourceHandleInit`'s native branch
  (the `forceStrategy: "native"` shape) gains an optional `poolSize`; `SourceDecoderPool.acquire`
  passes it to the handle constructor; `decodeBench.ts` `BenchArgs` gains `poolSize?: number`;
  `decodeBench`'s `mkInit` forwards it; `e2e/scripts/decode-bench.mjs` gains a `--pool-size <n>`
  CLI flag validated as a positive integer.
- The orchestrator runs the `throughput` scenario for `strategy:'native'` at
  **N ∈ {3, 6, 9, 12}** on the chosen fixture(s), tabulating fps / ×realtime and the Part-A
  timing summary at each N.
- Interpretation (the binary answer):
  - fps rises ~linearly with N **and** coordination RTT per frame stays flat ⇒ **depth-bound**
    ⇒ cheap fix suffices (lever 1 bigger pool + lever 2 batched/credit acks); **skip
    zero-copy-v2.**
  - fps plateaus **and/or** coordination RTT inflates with N ⇒ **latency/congestion-bound**
    ⇒ needs lever 3 (SharedArrayBuffer/Atomics or a dedicated MessageChannelMain port) or
    lever 4 (zero-copy-v2 pull model).
- VRAM: 12×1080p NV12 ≈ 48MB — safe on the RTX 3050 dev GPU.

## 4. Part C — reporting

- `BenchResult`'s `throughput` variant gains an optional
  `timing?: { poolSize, decodeCopyMs, coordRttMs, preloadResidentMs, createImageBitmapMs, ipcTransitMsDerived }`,
  where each `*Ms` (except the derived scalar) is `{ p50, p95, max, mean, n }`.
- `decodeBenchRun` collects the preload-piggybacked aggregates off the handle and, for the
  native strategy, calls `previewGpu.takeTimings(handle.streamId)` at the end of the
  throughput window (before dispose) to fetch the Rust coord-RTT + decode/copy summaries.
  `ipcTransitMsDerived = coordRttMs.mean − preloadResidentMs.mean`.
- `e2e/scripts/decode-bench.mjs` writes a `poolSweep: [{ poolSize, fps, xRealtime, timing }]`
  section into the report JSON and logs a human-readable table to stdout.
- The report also restates the **4K-anomaly success criterion** so the downstream slice's
  bar is explicit: any future fix must make 1080p throughput jump *and* restore the normal
  1080p > 4K ordering. Stage 3 only produces the data supporting that criterion; it does
  not attempt the fix.

## 5. Testing

- Rust unit tests: `TimingAccum` percentile math (known input → known p50/p95/max),
  `drain()` clears the buffers, the sample cap holds; the `slot_emit`→`ack` pairing records
  exactly one sample per emit/ack pair and no sample for an ack with no prior emit.
- TS: extend `NativeGpuSourceHandle.test.ts` to assert `previewGpu.open` is called with the
  configured `poolSize` (default 3 when unspecified); a `decodeBench` test that `poolSize`
  threads into the native `mkInit`; a `decode-bench.mjs` parse test for `--pool-size`
  (rejects `0`, non-integer, negative).

## 6. Scope guard (measure-first discipline)

- Do **not** change the product default pool size (stays 3); the sweep only *varies* it in
  the bench.
- Do **not** touch the WebCodecs path.
- Do **not** build SharedArrayBuffer/Atomics signaling, credit/batched acks, a dedicated
  MessageChannelMain port, or the zero-copy-v2 pull model. Those are the *candidate fixes*
  this slice's data will choose between — building any of them now is exactly the premature
  commitment measure-first exists to prevent.
- Rust timing accumulation is always-on within the `preview-gpu` feature but near-zero cost
  and drained only by a bench-only call; native stays E2E-gated in prod, so a shipping
  preview never exercises it.

**Terminal deliverable:** the Stage-3 report JSON's `poolSweep` + `timing` blocks, plus a
one-line verdict — *depth-bound → levers 1+2* or *latency/congestion-bound → lever 3/4* —
recorded as the input to the next (build-the-fix) slice.
