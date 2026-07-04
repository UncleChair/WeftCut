# Native decode throughput — RESOLVED (was: bottleneck hunt)

**Status: RESOLVED.** This document previously guided an ongoing hunt for a "native
single-track 1080p throughput ceiling of ~44fps." **That ceiling did not exist — it
was a decode-bench harness artifact.** The corrected, evergreen verdict now lives in
`docs/decode-bench.md` (Native strategy §). This file is kept only as the record of
the correction; do not resurrect the ruled-out coordination-rework hypotheses below.

## The actual finding

Native GPU decode at 1080p runs at **~1340fps** (RTX 3050, hevc-1080) — *faster* than
the in-process WebCodecs path (~900fps) — and ~384fps at 4K (vs WebCodecs ~317fps),
on top of native's 8–16× seek advantage. Native is the faster strategy on **every**
axis measured. There is no fixed throughput ceiling and no case for a per-frame
coordination rework (shared-memory signalling / zero-copy pull); the per-frame
coordination round-trip is a minor fraction of the frame interval, and decode itself
is the floor.

## Root cause of the phantom "44fps"

`runThroughput` (in `decodeBench.ts`) drove the pump but **never evicted the ring**.
`FrameRing` only evicts on `setAnchor`, which the bench never called. So the ring
accumulated every decoded frame as a ~8 MB (1080p) ImageBitmap. After ~1300 frames
that exhausted GPU VRAM; because the native path runs its own `d3d11va` device
alongside Chromium's GPU process, the decoder's next surface allocation failed with
`"Operation not permitted"`, `next_frame()` returned `Err`, the session set `eof` and
halted ~⅔ through the fixture. The driver never saw a clean EOF, so its 30 s window
ran to completion and reported `frames_decoded ÷ 30 s ≈ 44fps`. WebCodecs escaped the
trap because it reaches true EOF fast enough that the driver's `endedAtEof` break
fires (measuredMs ≈ 2 s) before VRAM pressure bit.

**Fix:** `runThroughput` now calls `h.ring.setAnchor(last)` each tick (the same
eviction the Compositor does in production). One line; native immediately decodes to
true EOF at burst rate.

## How it was found (measure-first, in the session's own single clock)

Three rounds of Rust-side `preview_gpu` instrumentation, drained via
`preview_gpu_take_timings` and surfaced in the sweep tables:
1. **ack→next-emit gap + lookahead-gate counter** — *refuted* the prescribed
   hypothesis (the ack→emit gap is sub-ms, not the missing ~22ms).
2. **thread time-budget** (`interEmit`/`interAck` cadence, `recvBlock` distribution,
   wake-reason tallies) — showed the session thread was ~100% idle in `recv_timeout`
   and, critically, that emits spanned only ~3.7 s of the 30 s window: production
   *halts*, it doesn't run slow.
3. **pump-stop attribution** (`eofReturns` / `poolFullReturns` / `acquireFailed` +
   `finalEof` / `finalFreeSlots`) — named the halt as `eof`, and the renderer console
   surfaced the `"Operation not permitted"` decode error behind it.

These instruments are permanent, E2E-gated bench diagnostics (never in a shipping
preview). `eofReturns` / `finalEof` are the standing regression guard: if native
throughput ever reads low with `endedAtEof` false, they flag a mid-stream halt.

## Consequences for prior conclusions (all superseded)

Stage 2/3, signal-attribution, and the max-throughput probe all measured native
throughput through the unbounded-ring bug, so every native throughput number and the
"coordination-bound / 16–21× slower / needs zero-copy-v2" narrative is void. The
**seek** results (native 8–16× faster) are unaffected — seek decodes few frames, so
the ring never grew. Native remains the recommended strategy where the `preview-gpu`
feature is available.

Pointers: `docs/decode-bench.md` (Native strategy § — the evergreen verdict + the
harness-contract note); memory topic `project_decode_bench.md`.
