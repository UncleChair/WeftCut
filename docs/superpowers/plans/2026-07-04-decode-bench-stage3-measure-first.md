# decode-bench Stage 3 — native throughput measure-first — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the native GPU-decode per-frame coordination round-trip and add a pool-size sweep to the bench, so the Stage-3 report answers one question — is native 1080p throughput depth-bound (cheap fix) or latency/congestion-bound (expensive fix)? — without building any fix.

**Architecture:** Measure within-process deltas only, no cross-process clock sync. The Rust session thread stamps a slot at `FrameReady` and samples `now − stamp` when the matching `ConsumeAck` returns — capturing the whole JS round-trip (main relay + preload work + ack relay) in one monotonic clock. The preload measures `getVideoFrame`/`createImageBitmap`/resident time locally and piggybacks them on the existing frame `MessagePort` message (zero extra IPC). IPC transit is derived by subtraction. Separately, the native pool size becomes bench-configurable so the orchestrator can sweep N ∈ {3,6,9,12}.

**Tech Stack:** Rust (napi-rs addon, `windows`/`ffmpeg-next` behind the `preview-gpu` cargo feature), TypeScript (Electron main/preload/renderer), Node ESM (`decode-bench.mjs` orchestrator + Playwright `_electron`), Vitest (renderer unit tests).

## Global Constraints

- Node **22.20.0** (fnm default); do not switch to 24 (breaks Electron packaging).
- The native path is Windows-only, behind cargo feature **`preview-gpu`**, which is **OUT** of the CI Rust feature union (`jobs,export,mcp,cloud`). All Rust changes here compile under both `--features preview-gpu` (real impl) and without it (stub arm).
- Local `preview-gpu` build env: `FFMPEG_DIR` = the `Gyan.FFmpeg.Shared` `ffmpeg-8.1.1-full_build-shared` dir; `LIBCLANG_PATH` = `C:\Program Files\LLVM\bin`.
- **Do not** change the product default native pool size (stays **3**); the sweep only *varies* it in the bench.
- **Do not** touch the WebCodecs `SourceHandle` decode path.
- **Do not** build any optimization (bigger default pool, batched/credit acks, SharedArrayBuffer signaling, MessageChannelMain port, zero-copy-v2). This slice only measures.
- napi-rs renames struct fields to camelCase across the boundary: Rust `mean_ms` → JS `meanMs`, `coord_rtt` → `coordRtt`, `decode_copy` → `decodeCopy`.
- Spec: `docs/superpowers/specs/2026-07-04-decode-bench-stage3-measure-first-design.md`.

---

### Task 1: Rust `TimingAccum` + summary types (pure, unit-tested)

**Files:**
- Modify: `apps/desktop/native/src/preview_gpu/session.rs` (add types + `#[cfg(test)]` mod)
- Modify: `apps/desktop/native/src/preview_gpu/mod.rs` (export new types)

**Interfaces:**
- Produces: `TimingAccum` (`Default`; `push_coord_rtt(u64)`, `push_decode_copy(u64)`, `drain() -> TimingReport`), `TimingSummary { count: u32, mean_ms: f64, p50_ms: f64, p95_ms: f64, max_ms: f64 }`, `TimingReport { coord_rtt: TimingSummary, decode_copy: TimingSummary }`, const `TIMING_SAMPLE_CAP: usize = 20_000`. Samples are nanoseconds in; summaries are milliseconds out.

- [ ] **Step 1: Write the failing test**

Add at the very bottom of `apps/desktop/native/src/preview_gpu/session.rs`:

```rust
#[cfg(test)]
mod timing_tests {
    use super::{TimingAccum, TIMING_SAMPLE_CAP};

    #[test]
    fn summary_percentiles_and_mean_over_known_samples() {
        let mut a = TimingAccum::default();
        for ms in [10u64, 20, 30, 40, 50] {
            a.push_coord_rtt(ms * 1_000_000); // ns
        }
        let r = a.drain();
        assert_eq!(r.coord_rtt.count, 5);
        assert!((r.coord_rtt.mean_ms - 30.0).abs() < 1e-6, "mean {}", r.coord_rtt.mean_ms);
        assert!((r.coord_rtt.p50_ms - 30.0).abs() < 1e-6, "p50 {}", r.coord_rtt.p50_ms);
        // linear interp: idx = 0.95*(5-1) = 3.8 -> 40 + (50-40)*0.8 = 48
        assert!((r.coord_rtt.p95_ms - 48.0).abs() < 1e-6, "p95 {}", r.coord_rtt.p95_ms);
        assert!((r.coord_rtt.max_ms - 50.0).abs() < 1e-6, "max {}", r.coord_rtt.max_ms);
    }

    #[test]
    fn drain_clears_buffers() {
        let mut a = TimingAccum::default();
        a.push_decode_copy(5_000_000);
        assert_eq!(a.drain().decode_copy.count, 1);
        assert_eq!(a.drain().decode_copy.count, 0);
    }

    #[test]
    fn empty_summary_is_zeroed() {
        let mut a = TimingAccum::default();
        let r = a.drain();
        assert_eq!(r.coord_rtt.count, 0);
        assert_eq!(r.coord_rtt.p95_ms, 0.0);
    }

    #[test]
    fn sample_cap_holds() {
        let mut a = TimingAccum::default();
        for _ in 0..(TIMING_SAMPLE_CAP + 100) {
            a.push_decode_copy(1_000_000);
        }
        assert_eq!(a.drain().decode_copy.count as usize, TIMING_SAMPLE_CAP);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (Windows, from `apps/desktop/native`): `cargo test --features preview-gpu timing_tests`
Expected: FAIL — `cannot find type TimingAccum` / `TIMING_SAMPLE_CAP` not found.

- [ ] **Step 3: Write minimal implementation**

Add near the top of `apps/desktop/native/src/preview_gpu/session.rs`, after the existing `use` block (add `Instant` to the `std::time` import — change `use std::time::Duration;` to `use std::time::{Duration, Instant};`):

```rust
/// Cap on retained timing samples per metric. A 30s throughput window at native's
/// ~44fps yields ~1300 samples — far under this; the cap is only a runaway backstop
/// (timing is native-only, so WebCodecs frame rates never reach it). Stop-appending
/// once full (keeps the earliest, steady-state samples).
pub const TIMING_SAMPLE_CAP: usize = 20_000;

/// Per-metric millisecond summary handed across the napi boundary (mapped to a
/// `#[napi(object)]` in `napi_backend.rs`). Percentiles use linear interpolation
/// over ascending samples, matching the TS-side `percentile` convention.
#[derive(Clone, Copy)]
pub struct TimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Both metrics drained together.
pub struct TimingReport {
    /// Whole JS coordination round-trip: `FrameReady` emit -> main relay -> preload
    /// getVideoFrame/createImageBitmap -> `consume_ack` relay back to this thread.
    pub coord_rtt: TimingSummary,
    /// Decode + GPU-copy cost for one delivered frame (`next_frame` + `copy_frame_into_slot`).
    pub decode_copy: TimingSummary,
}

/// Session-thread timing accumulator. Nanosecond samples in; drained to ms summaries.
#[derive(Default)]
pub struct TimingAccum {
    coord_rtt_ns: Vec<u64>,
    decode_copy_ns: Vec<u64>,
}

impl TimingAccum {
    fn push_capped(buf: &mut Vec<u64>, ns: u64) {
        if buf.len() < TIMING_SAMPLE_CAP {
            buf.push(ns);
        }
    }
    pub fn push_coord_rtt(&mut self, ns: u64) {
        Self::push_capped(&mut self.coord_rtt_ns, ns);
    }
    pub fn push_decode_copy(&mut self, ns: u64) {
        Self::push_capped(&mut self.decode_copy_ns, ns);
    }
    /// Compute both summaries and clear the buffers.
    pub fn drain(&mut self) -> TimingReport {
        let report = TimingReport {
            coord_rtt: summarize(&self.coord_rtt_ns),
            decode_copy: summarize(&self.decode_copy_ns),
        };
        self.coord_rtt_ns.clear();
        self.decode_copy_ns.clear();
        report
    }
}

fn summarize(samples: &[u64]) -> TimingSummary {
    if samples.is_empty() {
        return TimingSummary { count: 0, mean_ms: 0.0, p50_ms: 0.0, p95_ms: 0.0, max_ms: 0.0 };
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    let ns_to_ms = |ns: f64| ns / 1_000_000.0;
    let sum: f64 = sorted.iter().map(|&x| x as f64).sum();
    TimingSummary {
        count: n as u32,
        mean_ms: ns_to_ms(sum / n as f64),
        p50_ms: percentile_ms(&sorted, 50.0),
        p95_ms: percentile_ms(&sorted, 95.0),
        max_ms: ns_to_ms(sorted[n - 1] as f64),
    }
}

/// Linear-interpolated percentile over an ASCENDING-sorted ns slice, returned in ms.
fn percentile_ms(sorted: &[u64], p: f64) -> f64 {
    let n = sorted.len();
    if n == 1 {
        return sorted[0] as f64 / 1_000_000.0;
    }
    let idx = (p / 100.0) * (n as f64 - 1.0);
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    let frac = idx - lo as f64;
    let v = sorted[lo] as f64 + (sorted[hi] as f64 - sorted[lo] as f64) * frac;
    v / 1_000_000.0
}
```

Then export the types — in `apps/desktop/native/src/preview_gpu/mod.rs`, change the `pub use` line to:

```rust
#[allow(unused_imports)]
pub use session::{OpenInfo, PreviewGpuPoke, PreviewGpuRegistry, TimingReport, TimingSummary};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --features preview-gpu timing_tests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/native/src/preview_gpu/session.rs apps/desktop/native/src/preview_gpu/mod.rs
git commit -m "feat(preview-gpu): TimingAccum + ms summaries for Stage-3 instrumentation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire timing into the session thread + registry `take_timings`

**Files:**
- Modify: `apps/desktop/native/src/preview_gpu/session.rs` (`SessionState`, `Session`, `pump`, `session_thread`, `init_session`, `open`, add `take_timings`)

**Interfaces:**
- Consumes: `TimingAccum`, `TimingReport` (Task 1).
- Produces: `PreviewGpuRegistry::take_timings(&self, stream_id: &str) -> Result<TimingReport, String>`.

- [ ] **Step 1: Add the shared accumulator + slot-stamp state**

In `SessionState` (the `struct SessionState { … }` block), add two fields after `eof: bool,`:

```rust
    /// Shared with the registry so `take_timings` can drain from the Node thread.
    timing: Arc<Mutex<TimingAccum>>,
    /// `Instant` the frame in each slot was announced via `FrameReady`; taken and
    /// turned into a coord-RTT sample when that slot's `ConsumeAck` returns. `None`
    /// when the slot is free or unacked-but-never-emitted. Sized to the pool.
    slot_emit: Vec<Option<Instant>>,
```

In the `Session` registry-side struct (`struct Session { … }`), add after `height: u32,`:

```rust
    /// Same `Arc` the session thread appends to; `take_timings` drains it.
    timing: Arc<Mutex<TimingAccum>>,
```

- [ ] **Step 2: Thread the accumulator through `init_session` + `session_thread`**

Change `init_session`'s signature and its `Ok(SessionState { … })` tail:

```rust
fn init_session(
    path: &str,
    pool_size: u32,
    timing: Arc<Mutex<TimingAccum>>,
) -> Result<SessionState, String> {
```

and in the returned struct literal, add (after `eof: false,`):

```rust
            timing,
            slot_emit: vec![None; pool.len()],
```

Change `session_thread`'s signature to accept the timing arc and pass it in:

```rust
fn session_thread(
    stream_id: String,
    path: String,
    pool_size: u32,
    rx: Receiver<SessionMsg>,
    init_tx: Sender<Result<OpenInfo, String>>,
    poke: PokeSink,
    timing: Arc<Mutex<TimingAccum>>,
) {
    let mut state = match init_session(&path, pool_size, timing) {
```

- [ ] **Step 3: Record decode+copy and stamp the slot at emit**

In `SessionState::pump`, wrap the decode+copy and stamp the slot. Replace the block that begins `let decoded = match self.stream.next_frame() {` through the `FrameReady` emit at the end of the loop body. Specifically:

Add a timer immediately before `let decoded = match self.stream.next_frame() {`:

```rust
            let decode_start = Instant::now();
```

And replace the final delivery block — currently:

```rust
            self.free[slot_idx] = false;
            self.frontier_pts = decoded.pts_us;
            self.last_delivered_pts = decoded.pts_us;
            emit(
                poke,
                PreviewGpuPoke::FrameReady {
                    stream_id: stream_id.to_string(),
                    slot: slot_idx as u32,
                    pts_us: decoded.pts_us,
                    dur_us: decoded.dur_us,
                },
            );
```

with:

```rust
            let decode_copy_ns = decode_start.elapsed().as_nanos() as u64;
            self.free[slot_idx] = false;
            self.frontier_pts = decoded.pts_us;
            self.last_delivered_pts = decoded.pts_us;
            // Stamp the slot BEFORE emit so the matching ack can measure the full
            // round-trip; record decode+copy for this delivered frame.
            self.slot_emit[slot_idx] = Some(Instant::now());
            if let Ok(mut t) = self.timing.lock() {
                t.push_decode_copy(decode_copy_ns);
            }
            emit(
                poke,
                PreviewGpuPoke::FrameReady {
                    stream_id: stream_id.to_string(),
                    slot: slot_idx as u32,
                    pts_us: decoded.pts_us,
                    dur_us: decoded.dur_us,
                },
            );
```

- [ ] **Step 4: Sample coord-RTT on ack**

Add a method on `SessionState` (next to `free_slot`):

```rust
    /// Turn a slot's `FrameReady`->`ConsumeAck` gap into a coord-RTT sample.
    /// `Option::take` guarantees at most one sample per emit; an ack with no
    /// prior emit (shouldn't happen given the free-flag protocol) is ignored.
    fn record_ack(&mut self, slot: usize) {
        if let Some(emit_at) = self.slot_emit.get_mut(slot).and_then(Option::take) {
            let rtt_ns = emit_at.elapsed().as_nanos() as u64;
            if let Ok(mut t) = self.timing.lock() {
                t.push_coord_rtt(rtt_ns);
            }
        }
    }
```

In `session_thread`'s message loop, change the `ConsumeAck` arm from:

```rust
            Ok(SessionMsg::ConsumeAck(slot)) => {
                if let Some(f) = state.free.get_mut(slot as usize) {
                    *f = true;
                }
                state.pump(&poke, &stream_id);
            }
```

to:

```rust
            Ok(SessionMsg::ConsumeAck(slot)) => {
                state.record_ack(slot as usize);
                if let Some(f) = state.free.get_mut(slot as usize) {
                    *f = true;
                }
                state.pump(&poke, &stream_id);
            }
```

- [ ] **Step 5: Create + share the arc in `open`, and add `take_timings`**

In `PreviewGpuRegistry::open`, after `let pool_size = pool_size.max(1);` add:

```rust
        let timing = Arc::new(Mutex::new(TimingAccum::default()));
        let timing_thread = Arc::clone(&timing);
```

Change the spawn closure to pass `timing_thread`:

```rust
        let join = thread::Builder::new()
            .name(format!("preview-gpu-{sid}"))
            .spawn(move || session_thread(sid, path_owned, pool_size, cmd_rx, init_tx, poke, timing_thread))
            .map_err(|e| format!("spawn preview-gpu session thread failed: {e}"))?;
```

In the `Ok(Ok(info))` arm's `sessions.insert(...)`, add `timing,` to the `Session { … }` literal (after `height,`):

```rust
                sessions.insert(
                    stream_id.to_string(),
                    Session {
                        tx: cmd_tx,
                        join: Some(join),
                        width,
                        height,
                        timing,
                    },
                );
```

Add the registry method (next to `consume_ack`):

```rust
    /// Drain the session's accumulated timing samples into a summary report.
    /// Called once at the end of a bench window (before `close`), from the Node
    /// main thread via the addon.
    pub fn take_timings(&self, stream_id: &str) -> Result<TimingReport, String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(stream_id)
            .ok_or_else(|| format!("no preview-gpu session '{stream_id}'"))?;
        Ok(session.timing.lock().unwrap().drain())
    }
```

- [ ] **Step 6: Build to verify it compiles + existing tests pass**

Run (Windows, from `apps/desktop/native`): `cargo test --features preview-gpu`
Expected: PASS (the Task-1 `timing_tests` still pass; the crate compiles with the new wiring).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/native/src/preview_gpu/session.rs
git commit -m "feat(preview-gpu): sample coord-RTT (emit->ack) + decode/copy per delivered frame

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: napi `preview_gpu_take_timings` (real + stub) + wire objects

**Files:**
- Modify: `apps/desktop/native/src/napi_backend.rs`

**Interfaces:**
- Consumes: `PreviewGpuRegistry::take_timings` (Task 2), `TimingReport`/`TimingSummary` (Task 1).
- Produces: napi objects `PreviewGpuTimingSummary { count: u32, mean_ms: f64, p50_ms: f64, p95_ms: f64, max_ms: f64 }`, `PreviewGpuTimingReport { coord_rtt: PreviewGpuTimingSummary, decode_copy: PreviewGpuTimingSummary }`; addon method `preview_gpu_take_timings(stream_id: String) -> napi::Result<PreviewGpuTimingReport>` (present in both the real and the stub `impl Backend`).

- [ ] **Step 1: Add the napi object types (unconditional)**

Immediately after the existing `#[napi(object)] pub struct PreviewGpuOpenInfo { … }` block, add:

```rust
/// Per-metric ms summary of native preview timing (decode-bench Stage 3). Field
/// names cross to JS as camelCase: `mean_ms` -> `meanMs`, etc.
#[napi(object)]
pub struct PreviewGpuTimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Both native timing metrics returned by `preview_gpu_take_timings`.
#[napi(object)]
pub struct PreviewGpuTimingReport {
    pub coord_rtt: PreviewGpuTimingSummary,
    pub decode_copy: PreviewGpuTimingSummary,
}
```

- [ ] **Step 2: Add the real method + a plain→napi mapper**

Inside the `#[cfg(all(windows, feature = "preview-gpu"))] #[napi] impl Backend { … }` block, after `preview_gpu_close`, add:

```rust
    /// Drain + return this session's Stage-3 timing samples (coord-RTT + decode/copy).
    #[napi]
    pub fn preview_gpu_take_timings(&self, stream_id: String) -> napi::Result<PreviewGpuTimingReport> {
        let rep = self
            .preview_gpu
            .take_timings(&stream_id)
            .map_err(napi::Error::from_reason)?;
        Ok(PreviewGpuTimingReport {
            coord_rtt: to_napi_timing_summary(rep.coord_rtt),
            decode_copy: to_napi_timing_summary(rep.decode_copy),
        })
    }
```

And add a free helper (guarded to the same cfg — place it right after that `impl` block closes):

```rust
#[cfg(all(windows, feature = "preview-gpu"))]
fn to_napi_timing_summary(s: crate::preview_gpu::TimingSummary) -> PreviewGpuTimingSummary {
    PreviewGpuTimingSummary {
        count: s.count,
        mean_ms: s.mean_ms,
        p50_ms: s.p50_ms,
        p95_ms: s.p95_ms,
        max_ms: s.max_ms,
    }
}
```

- [ ] **Step 3: Add the stub method**

Inside the `#[cfg(not(all(windows, feature = "preview-gpu")))] #[napi] impl Backend { … }` block (the one whose methods return `Err("preview-gpu not built")`), after `preview_gpu_close`, add:

```rust
    #[napi]
    pub fn preview_gpu_take_timings(&self, _stream_id: String) -> napi::Result<PreviewGpuTimingReport> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }
```

- [ ] **Step 4: Build both arms**

Run (Windows, from `apps/desktop/native`):
```
cargo build --features preview-gpu
cargo build
```
Expected: both succeed (real impl with the feature; stub arm without it).

- [ ] **Step 5: Rebuild the addon so the TS type surface picks up the new method**

Run (from `apps/desktop`, per the Stage-2 build recipe, with `FFMPEG_DIR`/`LIBCLANG_PATH` set): `npm run napi:build` (must include `--features preview-gpu` as the local build does). Close any running dev app first — it locks the `.node`.
Expected: regenerates `index.d.ts` with `previewGpuTakeTimings`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/src/napi_backend.rs apps/desktop/native/index.d.ts
git commit -m "feat(preview-gpu): preview_gpu_take_timings napi command (+ stub)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Configurable native pool size (handle + init + acquire)

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts`
- Modify: `apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts`
- Test: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`

**Interfaces:**
- Produces: `new NativeGpuSourceHandle(layerId, mediaId, sourcePath, sourceColor?, poolSize = 3)` with `readonly poolSize: number`; `SourceHandleInit.poolSize?: number`.

- [ ] **Step 1: Write the failing test**

Add to `NativeGpuSourceHandle.test.ts`, inside `describe("NativeGpuSourceHandle.ensureReady", …)`:

```typescript
  it("opens with the configured poolSize when provided", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-1p", "media-1p", "/fake/p.mp4", undefined, 12);

    await h.ensureReady();

    const arg = mock.previewGpu.open.mock.calls[0]![0] as { poolSize: number };
    expect(arg.poolSize).toBe(12);
    expect(h.poolSize).toBe(12);

    h.dispose();
  });

  it("defaults poolSize to 3 when unspecified", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-1q", "media-1q", "/fake/q.mp4");

    await h.ensureReady();

    const arg = mock.previewGpu.open.mock.calls[0]![0] as { poolSize: number };
    expect(arg.poolSize).toBe(3);
    expect(h.poolSize).toBe(3);

    h.dispose();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts -t "configured poolSize"`
Expected: FAIL — `open` is called with `poolSize: 3` (hardcoded), and `h.poolSize` is `undefined`.

- [ ] **Step 3: Add the constructor param + field**

In `NativeGpuSourceHandle.ts`, add a public field near the other `readonly`s (after `readonly streamId: string;`):

```typescript
  /// Native pool size this session opens with. Default 3 mirrors the WebCodecs
  /// lookahead headroom; decode-bench overrides it for the Stage-3 pool sweep.
  readonly poolSize: number;
```

Change the constructor signature and body:

```typescript
  constructor(
    layerId: string,
    mediaId: string,
    sourcePath: string,
    sourceColor?: VideoColorSpaceInit,
    poolSize = 3,
  ) {
    this.layerId = layerId;
    this.mediaId = mediaId;
    this.sourcePath = sourcePath;
    this.sourceColor = sourceColor;
    this.poolSize = poolSize;
    this.streamId = `native-gpu:${layerId}:${nextStreamSeq++}`;
    this.ring = new FrameRing();
  }
```

In `_doEnsureReady`, change the hardcoded `poolSize: 3` in the `previewGpu.open` call to `poolSize: this.poolSize` (and update the adjacent comment that says "poolSize 3 mirrors…" to note it is now the configured value, default 3).

- [ ] **Step 4: Add `poolSize` to the init type + acquire wiring**

In `SourceDecoderPool.ts`, add to `SourceHandleInit` (after the `sourcePath?: string;` field):

```typescript
  /// E2E-only: native pool size (slot count) for a `forceStrategy: 'native'`
  /// handle. Decode-bench Stage 3 varies this to sweep pipeline depth; the
  /// product default (3) applies when unset. Ignored by the WebCodecs path.
  poolSize?: number;
```

In `acquire`, change the native-handle construction to pass it:

```typescript
      const nativeHandle = new NativeGpuSourceHandle(
        init.layerId,
        init.mediaId,
        init.sourcePath ?? "",
        init.sourceColor,
        init.poolSize,
      );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`
Expected: PASS (all existing tests + the two new ones).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts apps/desktop/src/renderer/render/decoder/SourceDecoderPool.ts apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.test.ts
git commit -m "feat(decode-bench): configurable native poolSize (default 3) for the Stage-3 sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `takeTimings` bridge (ipc type + preload + main + previewGpu.ts)

**Files:**
- Modify: `apps/desktop/src/shared/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/previewGpu.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `backend.previewGpuTakeTimings(streamId)` (Task 3).
- Produces: type `PreviewGpuTimingSummary = { count: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number }`, `PreviewGpuTimingReport = { coordRtt: PreviewGpuTimingSummary; decodeCopy: PreviewGpuTimingSummary }`; `window.api.previewGpu.takeTimings(streamId: string): Promise<PreviewGpuTimingReport>`.

- [ ] **Step 1: Add the shared types + bridge method signature**

In `shared/ipc.ts`, after the `PreviewGpuOpenReply` type, add:

```typescript
/// Per-metric ms summary from the native preview timing accumulator (decode-bench
/// Stage 3). Field names are the napi camelCase of the Rust `TimingSummary`.
export type PreviewGpuTimingSummary = {
  count: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}
/// Both native timing metrics: the coord round-trip (emit->ack) and decode+copy.
export type PreviewGpuTimingReport = {
  coordRtt: PreviewGpuTimingSummary
  decodeCopy: PreviewGpuTimingSummary
}
```

In the same file, add to the `previewGpu: { … }` member of `WeftcutApi`, after `close(...)`:

```typescript
    /// E2E/bench-only: drain this session's Stage-3 timing samples. Rejects for
    /// an unknown stream, or with "preview-gpu not built" off the native path.
    takeTimings(streamId: string): Promise<PreviewGpuTimingReport>
```

(Import/re-export note: `PreviewGpuTimingReport` must be importable by `preload/index.ts` and the renderer; it lives in `shared/ipc.ts` alongside the other `PreviewGpu*` types, so add it to the existing import in `preload/index.ts` — see Step 2.)

- [ ] **Step 2: Implement the preload bridge method**

In `preload/index.ts`, add `PreviewGpuTimingReport` to the type import from `../shared/ipc` (the block that already imports `PreviewGpuColorSpace`, `PreviewGpuOpenReply`).

In the `previewGpu: { … }` object, after the `requestPort()` method, add:

```typescript
    takeTimings(streamId: string): Promise<PreviewGpuTimingReport> {
      return ipcRenderer.invoke('previewGpu:takeTimings', { streamId }) as Promise<PreviewGpuTimingReport>
    },
```

- [ ] **Step 3: Implement the main-process delegate + IPC handler**

In `main/previewGpu.ts`, add (after `consumeAckPreviewGpu`):

```typescript
/// Drain a session's Stage-3 timing samples. Delegates straight to the addon;
/// the registry drains its accumulator and returns the ms summaries.
export function takeTimingsPreviewGpu(backend: Backend, streamId: string) {
  return backend.previewGpuTakeTimings(streamId)
}
```

In `main/index.ts`, add `takeTimingsPreviewGpu` to the import from `./previewGpu.js`, and register the handler right after the `previewGpu:close` handler:

```typescript
  ipcMain.handle('previewGpu:takeTimings', (_e, a: { streamId: string }) => takeTimingsPreviewGpu(backend!, a.streamId))
```

- [ ] **Step 4: Typecheck**

Run (from `apps/desktop`): `npm run typecheck`
Expected: PASS — `previewGpuTakeTimings` resolves on `Backend` (from Task 3's regenerated `index.d.ts`), and the new bridge method type-checks against `WeftcutApi`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/previewGpu.ts apps/desktop/src/main/index.ts
git commit -m "feat(preview-gpu): previewGpu.takeTimings bridge (ipc + preload + main)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Preload timing piggyback + handle aggregation

**Files:**
- Modify: `apps/desktop/src/preload/index.ts` (measure gvf/cib/resident, attach to frame message)
- Modify: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts` (`PortFrameMsg` fields, aggregate, `drainBenchTiming`)
- Test: `apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`

**Interfaces:**
- Produces: `PortFrameMsg` gains optional `gvfMs?: number; cibMs?: number; residentMs?: number`; `NativeGpuSourceHandle.drainBenchTiming(): { gvfMs: number[]; cibMs: number[]; residentMs: number[] }`.

- [ ] **Step 1: Write the failing test**

Add to `NativeGpuSourceHandle.test.ts`, a new `describe` block:

```typescript
describe("NativeGpuSourceHandle.drainBenchTiming", () => {
  it("accumulates per-frame preload timings and clears on drain", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-7", "media-7", "/fake/o.mp4");
    await h.ensureReady();
    const port = mock.getPort()!;

    port.onmessage!({
      data: { kind: "frame", streamId: h.streamId, slot: 0, ptsUs: 0, durUs: 1, bitmap: makeFakeBitmap(1), gvfMs: 1, cibMs: 4, residentMs: 6 },
    });
    port.onmessage!({
      data: { kind: "frame", streamId: h.streamId, slot: 1, ptsUs: 1, durUs: 1, bitmap: makeFakeBitmap(2), gvfMs: 2, cibMs: 5, residentMs: 8 },
    });

    const t = h.drainBenchTiming();
    expect(t.gvfMs).toEqual([1, 2]);
    expect(t.cibMs).toEqual([4, 5]);
    expect(t.residentMs).toEqual([6, 8]);

    // Drained — a second call is empty.
    expect(h.drainBenchTiming()).toEqual({ gvfMs: [], cibMs: [], residentMs: [] });

    h.dispose();
  });

  it("ignores a frame with no timing fields (WebCodecs-shaped or pre-instrumentation)", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-7b", "media-7b", "/fake/r.mp4");
    await h.ensureReady();
    const port = mock.getPort()!;

    port.onmessage!({
      data: { kind: "frame", streamId: h.streamId, slot: 0, ptsUs: 0, durUs: 1, bitmap: makeFakeBitmap(1) },
    });

    expect(h.drainBenchTiming()).toEqual({ gvfMs: [], cibMs: [], residentMs: [] });
    expect(h.ring.pushCount).toBe(1);

    h.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts -t "drainBenchTiming"`
Expected: FAIL — `h.drainBenchTiming is not a function`.

- [ ] **Step 3: Add fields + aggregation + drain to the handle**

In `NativeGpuSourceHandle.ts`, extend the `PortFrameMsg` interface:

```typescript
interface PortFrameMsg {
  kind: "frame";
  streamId: string;
  slot: number;
  ptsUs: number;
  durUs: number;
  bitmap: ImageBitmap;
  /// Bench-only per-frame preload timings (ms), attached by the preload receiver.
  /// Absent on a non-instrumented message.
  gvfMs?: number;
  cibMs?: number;
  residentMs?: number;
}
```

Add capped accumulators + a cap const near the top of the class (after `private eof = false;`):

```typescript
  /// Bench-only: per-frame preload timings, aggregated for decode-bench Stage 3.
  /// Capped so a long session can't grow them unbounded (native-only; the cap is
  /// never approached at native frame rates over a 30s window). Drained by the bench.
  private benchGvfMs: number[] = [];
  private benchCibMs: number[] = [];
  private benchResidentMs: number[] = [];
```

At module scope near `IDLE_DISPOSE_MS`, add:

```typescript
/// Cap on retained per-frame bench-timing samples (see NativeGpuSourceHandle).
const BENCH_TIMING_CAP = 20_000;
```

In `handlePortMessage`, inside the `if (data.kind === "frame")` branch, after `this.ring.push(...)` (still inside the non-disposed path), add:

```typescript
      if (typeof data.residentMs === "number" && this.benchResidentMs.length < BENCH_TIMING_CAP) {
        this.benchGvfMs.push(data.gvfMs ?? 0);
        this.benchCibMs.push(data.cibMs ?? 0);
        this.benchResidentMs.push(data.residentMs);
      }
```

Add the drain method (near `isLookaheadFull`):

```typescript
  /// Bench-only: return and clear the accumulated per-frame preload timings.
  /// decode-bench calls this at the end of a throughput window.
  drainBenchTiming(): { gvfMs: number[]; cibMs: number[]; residentMs: number[] } {
    const out = { gvfMs: this.benchGvfMs, cibMs: this.benchCibMs, residentMs: this.benchResidentMs };
    this.benchGvfMs = [];
    this.benchCibMs = [];
    this.benchResidentMs = [];
    return out;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`
Expected: PASS.

- [ ] **Step 5: Measure + attach in the preload receiver**

In `preload/index.ts`, in the `evt:previewGpu:frameReady` handler, replace the inner `try { … }` bitmap block. Currently:

```typescript
    try {
      let bmp: ImageBitmap
      let vf: VideoFrame | undefined
      try {
        vf = imp.getVideoFrame()
        bmp = await createImageBitmap(vf)
      } finally {
        vf?.close?.()
      }
      port.postMessage({ kind: 'frame', streamId, slot, ptsUs, durUs, bitmap: bmp }, [bmp])
    } catch (err) {
```

Replace with:

```typescript
    const tEntry = performance.now()
    try {
      let bmp: ImageBitmap
      let gvfMs = 0
      let cibMs = 0
      let vf: VideoFrame | undefined
      try {
        const tGvf = performance.now()
        vf = imp.getVideoFrame()
        gvfMs = performance.now() - tGvf
        const tCib = performance.now()
        bmp = await createImageBitmap(vf)
        cibMs = performance.now() - tCib
      } finally {
        vf?.close?.()
      }
      const residentMs = performance.now() - tEntry
      port.postMessage({ kind: 'frame', streamId, slot, ptsUs, durUs, bitmap: bmp, gvfMs, cibMs, residentMs }, [bmp])
    } catch (err) {
```

(The `catch`/`finally` that follow — error relay + `consumeAck` — are unchanged.)

- [ ] **Step 6: Typecheck (preload) + re-run handle tests**

Run (from `apps/desktop`): `npm run typecheck && npx vitest run src/renderer/render/decoder/NativeGpuSourceHandle.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.ts apps/desktop/src/renderer/render/decoder/NativeGpuSourceHandle.test.ts
git commit -m "feat(decode-bench): preload per-frame timing piggyback + handle aggregation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: decodeBench — poolSize arg + throughput timing assembly

**Files:**
- Modify: `apps/desktop/src/renderer/render/decoder/decodeBench.ts`
- Test: `apps/desktop/src/renderer/render/decoder/decodeBench.test.ts`

**Interfaces:**
- Consumes: `NativeGpuSourceHandle.drainBenchTiming` (Task 6), `window.api.previewGpu.takeTimings` (Task 5), `PreviewGpuTimingReport` (Task 5), `SourceHandleInit.poolSize` (Task 4), `percentile` (existing, in this file).
- Produces: `BenchArgs.poolSize?: number`; `BenchResult` throughput variant gains `timing?: ThroughputTiming`; exported pure fn `buildThroughputTiming(poolSize, rust, pre): ThroughputTiming`; types `MsStats`, `ThroughputTiming`.

- [ ] **Step 1: Write the failing test**

Add to `decodeBench.test.ts` (import `buildThroughputTiming` from `./decodeBench`):

```typescript
import { buildThroughputTiming } from "./decodeBench";

describe("buildThroughputTiming", () => {
  it("maps the Rust summaries, summarizes preload arrays, and derives IPC transit", () => {
    const rust = {
      coordRtt: { count: 2, meanMs: 68, p50Ms: 66, p95Ms: 90, maxMs: 92 },
      decodeCopy: { count: 2, meanMs: 3, p50Ms: 3, p95Ms: 4, maxMs: 4 },
    };
    const pre = { gvfMs: [1, 1], cibMs: [10, 10], residentMs: [20, 20] };

    const t = buildThroughputTiming(6, rust, pre);

    expect(t.poolSize).toBe(6);
    expect(t.coordRttMs).toEqual({ p50: 66, p95: 90, max: 92, mean: 68, n: 2 });
    expect(t.decodeCopyMs.mean).toBe(3);
    expect(t.preloadResidentMs).toEqual({ p50: 20, p95: 20, max: 20, mean: 20, n: 2 });
    expect(t.createImageBitmapMs.mean).toBe(10);
    // 68 (coord mean) - 20 (resident mean)
    expect(t.ipcTransitMsDerived).toBe(48);
  });

  it("yields NaN stats for empty preload arrays without throwing", () => {
    const rust = {
      coordRtt: { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
      decodeCopy: { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    };
    const t = buildThroughputTiming(3, rust, { gvfMs: [], cibMs: [], residentMs: [] });
    expect(t.preloadResidentMs.n).toBe(0);
    expect(Number.isNaN(t.preloadResidentMs.mean)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/render/decoder/decodeBench.test.ts -t "buildThroughputTiming"`
Expected: FAIL — `buildThroughputTiming` is not exported.

- [ ] **Step 3: Add types, the pure builder, and thread poolSize**

In `decodeBench.ts`, add the import for the Rust report type at the top (with the other imports):

```typescript
import type { PreviewGpuTimingReport } from "../../../shared/ipc";
```

Add the timing types + builder (near the top, after the `BenchResult` type union):

```typescript
/// Millisecond stats for one metric. Mirrors the Rust `TimingSummary` shape plus
/// the raw sample count, so preload-derived and Rust-derived metrics report alike.
export interface MsStats { p50: number; p95: number; max: number; mean: number; n: number }

/// The Stage-3 throughput timing breakdown attached to a native throughput result.
export interface ThroughputTiming {
  poolSize: number;
  decodeCopyMs: MsStats;
  coordRttMs: MsStats;
  preloadResidentMs: MsStats;
  createImageBitmapMs: MsStats;
  /// coordRtt.mean − preloadResident.mean: the main<->renderer IPC + event-loop
  /// scheduling cost, isolated by subtraction (see the Stage-3 spec §1).
  ipcTransitMsDerived: number;
}

function statsOf(xs: number[]): MsStats {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1]! : NaN,
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN,
    n: xs.length,
  };
}

function summaryToStats(s: PreviewGpuTimingReport["coordRtt"]): MsStats {
  return { p50: s.p50Ms, p95: s.p95Ms, max: s.maxMs, mean: s.meanMs, n: s.count };
}

/// Assemble the throughput timing block from the Rust summaries (coord-RTT +
/// decode/copy) and the preload-piggybacked per-frame samples. Pure — unit-tested.
export function buildThroughputTiming(
  poolSize: number,
  rust: PreviewGpuTimingReport,
  pre: { gvfMs: number[]; cibMs: number[]; residentMs: number[] },
): ThroughputTiming {
  const preloadResidentMs = statsOf(pre.residentMs);
  return {
    poolSize,
    decodeCopyMs: summaryToStats(rust.decodeCopy),
    coordRttMs: summaryToStats(rust.coordRtt),
    preloadResidentMs,
    createImageBitmapMs: statsOf(pre.cibMs),
    ipcTransitMsDerived: rust.coordRtt.meanMs - preloadResidentMs.mean,
  };
}
```

Extend `BenchArgs`:

```typescript
export interface BenchArgs {
  sourcePath: string;
  durationUs: number;
  scenario: BenchScenario;
  strategy: BenchStrategy;
  /// Native-only: pool size (slot count) for the Stage-3 sweep. Default 3.
  poolSize?: number;
}
```

Add `timing?` to the throughput variant of `BenchResult`:

```typescript
  | { kind: "throughput"; measuredMs: number; frames: number; fps: number; xRealtime: number; endedAtEof: boolean; timing?: ThroughputTiming }
```

In `decodeBenchRun`, extend the native branch of `mkInit`:

```typescript
      ...(args.strategy === "native"
        ? { forceStrategy: "native" as const, sourcePath: args.sourcePath, poolSize: args.poolSize }
        : {}),
```

- [ ] **Step 4: Collect timing at the end of the throughput window**

In `decodeBench.ts`, add a duck-typed native guard (after the `BenchHandle` type):

```typescript
/// Native handles carry a `streamId` + `drainBenchTiming`; the WebCodecs
/// `SourceHandle` has neither. Structural, so no value import of the class.
function asNative(h: BenchHandle): (NativeGpuSourceHandle & { streamId: string }) | null {
  return "streamId" in h && typeof (h as NativeGpuSourceHandle).drainBenchTiming === "function"
    ? (h as NativeGpuSourceHandle & { streamId: string })
    : null;
}
```

In `runThroughput`, just before the final `return { kind: "throughput", … }`, assemble the timing when the handle is native:

```typescript
  let timing: ThroughputTiming | undefined;
  const native = asNative(h);
  if (native) {
    const pre = native.drainBenchTiming();
    // takeTimings must run BEFORE the pool disposes the handle (which closes the
    // native session); decodeBenchRun's finally disposes only after we return.
    const rust = await window.api.previewGpu.takeTimings(native.streamId);
    timing = buildThroughputTiming(native.poolSize, rust, pre);
  }
  return {
    kind: "throughput",
    measuredMs,
    frames,
    fps: frames / (measuredMs / 1000),
    xRealtime: contentUs / 1000 / measuredMs,
    endedAtEof,
    timing,
  };
```

- [ ] **Step 5: Run tests + typecheck**

Run (from `apps/desktop`): `npx vitest run src/renderer/render/decoder/decodeBench.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/render/decoder/decodeBench.ts apps/desktop/src/renderer/render/decoder/decodeBench.test.ts
git commit -m "feat(decode-bench): assemble native throughput timing breakdown + poolSize arg

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Orchestrator — `--pool-size` / `--pool-sweep` + report

**Files:**
- Create: `apps/desktop/e2e/scripts/bench-cli.mjs` (pure arg helpers)
- Modify: `apps/desktop/e2e/scripts/decode-bench.mjs`

**Interfaces:**
- Produces: `parsePoolSize(raw) -> { ok: true, value: number | undefined } | { ok: false, error: string }`, `SWEEP_POOL_SIZES = [3, 6, 9, 12]`; `runSession(fixture, wantScenarios, poolSize?)` passing `poolSize` into the driver args; a `poolSweep` report section.

- [ ] **Step 1: Write the pure arg helpers**

Create `apps/desktop/e2e/scripts/bench-cli.mjs`:

```javascript
// Pure, side-effect-free CLI helpers for decode-bench.mjs — extracted so they can
// be unit-checked without importing the orchestrator (which launches Electron on
// import). See docs/superpowers/plans/2026-07-04-decode-bench-stage3-measure-first.md.

/// The native pool sizes swept in --pool-sweep mode (Stage 3). 12 x 1080p NV12 ~= 48MB.
export const SWEEP_POOL_SIZES = [3, 6, 9, 12];

/// Validate a --pool-size value. `undefined`/absent is allowed (product default 3
/// applies downstream). Rejects non-integers, zero, and negatives.
export function parsePoolSize(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: `invalid --pool-size '${raw}' (expected a positive integer)` };
  }
  return { ok: true, value: n };
}
```

- [ ] **Step 2: Verify the helper (automated, no vitest glob needed)**

Run (from repo root):

```bash
node --input-type=module -e "import {parsePoolSize, SWEEP_POOL_SIZES} from './apps/desktop/e2e/scripts/bench-cli.mjs'; const A=console.assert; A(parsePoolSize('0').ok===false,'0'); A(parsePoolSize('-1').ok===false,'-1'); A(parsePoolSize('x').ok===false,'x'); A(parsePoolSize('1.5').ok===false,'1.5'); A(parsePoolSize('12').value===12,'12'); A(parsePoolSize(undefined).value===undefined,'undef'); A(JSON.stringify(SWEEP_POOL_SIZES)==='[3,6,9,12]','sweep'); console.log('bench-cli OK')"
```

Expected: prints `bench-cli OK` with no assertion failures.

- [ ] **Step 3: Thread poolSize into `runSession` + validate the flag**

In `decode-bench.mjs`, add the import (with the other imports):

```javascript
import { parsePoolSize, SWEEP_POOL_SIZES } from "./bench-cli.mjs";
```

After the existing `--strategy` validation block, add:

```javascript
const POOL_SWEEP = process.argv.includes("--pool-sweep");
const poolSizeParsed = parsePoolSize(arg("pool-size", undefined));
if (!poolSizeParsed.ok) {
  console.error(`[decode-bench] ${poolSizeParsed.error}`);
  process.exit(1);
}
const POOL_SIZE = poolSizeParsed.value; // undefined => native default (3)
if ((POOL_SWEEP || POOL_SIZE !== undefined) && STRATEGY !== "native") {
  console.error("[decode-bench] --pool-size / --pool-sweep only apply to --strategy native");
  process.exit(1);
}
```

Change `runSession` to accept a pool size and put it in the driver args. Signature:

```javascript
async function runSession(fixture, wantScenarios, poolSize) {
```

and in the `const args = { … }` literal inside the scenario loop, add `poolSize` (only meaningful for native; harmless undefined otherwise):

```javascript
      const args = {
        sourcePath: benchFixturePath(fixture.name),
        durationUs: fixture.durationUs,
        scenario,
        strategy: STRATEGY,
        poolSize,
      };
```

- [ ] **Step 4: Add the pool-sweep main path**

In `decode-bench.mjs`, right after the `if (selfCheck) { … }` block (before `const env = await envBlock();`), add:

```javascript
if (POOL_SWEEP) {
  log(`pool-sweep (native throughput): N = ${SWEEP_POOL_SIZES.join(", ")}`);
  const env = await envBlock();
  const report = { env, strategy: STRATEGY, mode: "pool-sweep", runs, poolSweep: [] };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${env.date.slice(0, 10)}-${env.gitSha}-poolsweep.json`);
  for (const fixture of fixtures) {
    for (const N of SWEEP_POOL_SIZES) {
      const perRun = [];
      for (let run = 0; run < runs; run++) {
        log(`${fixture.name} N=${N} run ${run + 1}/${runs} …`);
        try {
          const out = await runSession(fixture, ["throughput"], N);
          perRun.push(out.throughput);
        } catch (e) {
          perRun.push({ kind: "error", error: String(e) });
        }
      }
      const tp = perRun.filter((t) => t?.kind === "throughput");
      report.poolSweep.push({
        fixture: fixture.name,
        poolSize: N,
        fps: median(tp.map((t) => t.fps)),
        xRealtime: median(tp.map((t) => t.xRealtime)),
        // Timing is identical in shape across runs; keep the median run's block.
        timing: tp.length ? tp[Math.floor((tp.length - 1) / 2)].timing : undefined,
        errors: perRun.filter((t) => t?.kind === "error").map((t) => t.error),
      });
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    }
  }
  log(`report → ${outFile}`);
  console.log(`\n| fixture | N | fps | ×realtime | coordRtt p50 | cib p50 | resident p50 | ipcTransit(mean) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  for (const r of report.poolSweep) {
    const t = r.timing;
    console.log(
      `| ${r.fixture} | ${r.poolSize} | ${fmt(r.fps)} | ${fmt(r.xRealtime)} ` +
      `| ${fmt(t?.coordRttMs?.p50)} | ${fmt(t?.createImageBitmapMs?.p50)} ` +
      `| ${fmt(t?.preloadResidentMs?.p50)} | ${fmt(t?.ipcTransitMsDerived)} |`,
    );
  }
  process.exit(0);
}
```

- [ ] **Step 5: Verify the orchestrator parses (dry, no GPU) + the flag guards work**

Run (from `apps/desktop`) — these exercise the validation/exit paths without needing the built app or a GPU:

```bash
node e2e/scripts/decode-bench.mjs --pool-size 0 ; echo "exit=$?"
node e2e/scripts/decode-bench.mjs --strategy webcodecs --pool-sweep ; echo "exit=$?"
```

Expected: the first prints the `invalid --pool-size '0'` error and `exit=1`; the second prints the `only apply to --strategy native` error and `exit=1`. (Both fail fast before any Electron launch.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/e2e/scripts/bench-cli.mjs apps/desktop/e2e/scripts/decode-bench.mjs
git commit -m "feat(decode-bench): --pool-size / --pool-sweep native throughput sweep + report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Run the sweep, record the verdict (terminal deliverable)

**Files:**
- Modify: `docs/decode-bench.md` (append a Stage-3 results + verdict subsection)

**Interfaces:**
- Consumes: everything above. This task produces the data + the depth-bound-vs-latency-bound decision — the reason Stage 3 exists.

- [ ] **Step 1: Build the E2E app with the native path**

From `apps/desktop`, with `FFMPEG_DIR`/`LIBCLANG_PATH` set (see Global Constraints), and no dev app running (it locks the `.node`):

```bash
npm run napi:build   # local script builds with --features preview-gpu
VITE_WEFTCUT_E2E=1 npm run build
```

Expected: `out/main/index.js` present; addon includes `previewGpuTakeTimings`.

- [ ] **Step 2: Ensure fixtures exist**

```bash
node e2e/scripts/gen-decode-bench-fixtures.mjs
```

Expected: the `hevc-1080` and `hevc-2160` fixtures exist on disk (idempotent if already generated).

- [ ] **Step 3: Run the pool sweep on 1080p + 4K**

On the quiet dev machine (RTX 3050), from `apps/desktop`:

```bash
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-1080 --pool-sweep --runs 3
node e2e/scripts/decode-bench.mjs --strategy native --scenario throughput --fixture hevc-2160 --pool-sweep --runs 3
```

Expected: each prints the `| fixture | N | fps | … |` table and writes `e2e/bench-results/<date>-<sha>-poolsweep.json`.

- [ ] **Step 4: Interpret + record the verdict**

Read the tables against these criteria (Stage-3 spec §3):
- fps rises ~linearly with N **and** `coordRtt p50` stays roughly flat ⇒ **depth-bound** ⇒ next slice = levers 1+2 (bigger default pool + batched/credit acks); zero-copy-v2 NOT needed.
- fps plateaus **and/or** `coordRtt p50` inflates with N ⇒ **latency/congestion-bound** ⇒ next slice = lever 3 (SharedArrayBuffer/Atomics or dedicated MessageChannelMain port) or lever 4 (zero-copy-v2 pull model).
- Sanity: `coordRtt` breakdown should show whether `createImageBitmap` (cib) or `ipcTransit` dominates the ~68ms.

Append a short **Stage 3 — throughput measure-first results** subsection to `docs/decode-bench.md` with: the two tables (or their headline rows), the observed dominant cost, and the one-line verdict. Commit:

```bash
git add docs/decode-bench.md
git commit -m "docs(decode-bench): Stage 3 pool-sweep results + throughput verdict

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Update the project memory**

Update `project_decode_bench.md`'s "Next work" resume point with the verdict and the chosen next-slice direction (depth-bound → levers 1+2, or latency-bound → lever 3/4), so a fresh session resumes from the decision, not the open question.

---

## Self-Review

**1. Spec coverage:**
- Spec §2.1 (Rust TimingAccum, slot_emit, record_ack, decode_copy, Arc<Mutex>, take_timings) → Tasks 1, 2. ✓
- Spec §2.2 (napi + main + bridge takeTimings) → Tasks 3, 5. ✓
- Spec §2.3 (preload piggyback, handle aggregation, unconditional perf.now) → Task 6. ✓
- Spec §3 (poolSize configurable end-to-end + N∈{3,6,9,12} sweep) → Tasks 4, 7, 8. ✓
- Spec §4 (BenchResult.timing, ipcTransitMsDerived, poolSweep report + table, 4K-anomaly criterion) → Tasks 7, 8, 9. ✓
- Spec §5 (Rust TimingAccum tests; poolSize handle test; poolSize threading; --pool-size parse test) → Tasks 1, 4, 7, 8. Note: the `--pool-size` "parse test" is realized as an automated `node -e` assertion over the extracted pure `parsePoolSize` (Task 8 Step 2) rather than a vitest case — the orchestrator has no vitest coverage and its existing `--strategy` validation is likewise inline; extracting the validator keeps it unit-checkable without importing the Electron-launching script. ✓
- Spec §6 (scope guard: default poolSize 3, WebCodecs untouched, no optimization built, feature-gated near-zero cost) → enforced in Global Constraints + Tasks 4/6 comments. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:**
- Rust `TimingSummary`/`TimingReport` (Task 1) ← consumed by `take_timings` (Task 2) and mapped in `preview_gpu_take_timings` (Task 3). ✓
- napi camelCase: Rust `coord_rtt`/`decode_copy`/`mean_ms`/`p50_ms`/`p95_ms`/`max_ms` → JS `coordRtt`/`decodeCopy`/`meanMs`/`p50Ms`/`p95Ms`/`maxMs`; `shared/ipc.ts` `PreviewGpuTimingReport`/`PreviewGpuTimingSummary` (Task 5) match exactly; `summaryToStats`/`buildThroughputTiming` (Task 7) read `meanMs`/`p50Ms`/`p95Ms`/`maxMs`/`count`. ✓
- `drainBenchTiming()` returns `{ gvfMs, cibMs, residentMs }` (Task 6) ← consumed with those exact keys in Task 7. ✓
- `NativeGpuSourceHandle` ctor `(…, poolSize = 3)` + `readonly poolSize` (Task 4) ← `acquire` passes `init.poolSize`; `buildThroughputTiming(native.poolSize, …)` (Task 7). ✓
- `PortFrameMsg` optional `gvfMs/cibMs/residentMs` (Task 6) written by preload with those exact keys (Task 6 Step 5). ✓
- `parsePoolSize`/`SWEEP_POOL_SIZES` (Task 8) consumed in decode-bench.mjs with matching names. ✓

No inconsistencies found.
