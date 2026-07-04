# Native decode throughput — bottleneck investigation handoff

Living handoff for continuing the native-decode 1080p throughput bottleneck hunt in a fresh
session. Synthesizes three merged measure-first slices (Stage 3 → signal-attribution →
max-throughput probe). The slice-by-slice record is in the project memory
(`project_decode_bench.md`, items 000/00/0); this doc is the *synthesis + the next probe*.

All numbers are RTX 3050, hevc-1080 / hevc-2160 fixtures, native `preview-gpu` path, measured at
the `DecoderHandle` seam via `apps/desktop/e2e/scripts/decode-bench.mjs`. Reports are gitignored
(`e2e/bench-results/`). Current local `main` ≈ `3d003528` (unpushed).

## TL;DR

Native single-track **1080p throughput tops out at ~44fps (~1.47× realtime)** and it is a **real,
fixed ceiling** — not a measurement artifact. The cost that sets it is **~22ms per frame** that we
have **ruled out of every instrumented location** and have **not yet localized**. It is the
**ack → next-frame-delivered gap** — the time from one frame's `consumeAck` (slot freed) to the
*next* frame for that slot landing in the ring — which the existing `coordRtt` (emit→ack)
instrument does **not** cover. That gap, not coordination, is the real 1080p ceiling.

(4K is different and already understood: ~106fps, genuinely coordination/pipeline-limited —
`coordRtt` ≈ pool_depth × frame_interval. The open question is 1080p.)

## What is RULED OUT (with evidence)

| Suspect | Ruled out by | Evidence |
| --- | --- | --- |
| **Decode itself** | Stage 2/3 timing | GPU decoder idle ~1.5%; `decodeCopyMs` (next_frame + GPU copy) ≈ **0.65ms/frame** — decode could do >1000fps. |
| **The coordination round-trip** | signal-attribution | `coordRtt` (emit→ack, the whole main-relay + preload work + ack) ≈ **3.8ms mean** @1080p — only ~16% of the 23ms frame interval. |
| **The driver's pacing delay** (`runThroughput`'s `await sleep(10)`) | max-throughput probe | `--throttle-ms 10 → 0`: fps **flat ~44** (44.1→43.3 at pool 3). Removing the throttle did nothing. |
| **Pool depth** (undelivered-frame parallelism) | Stage 3 + max-throughput probe | pool **3 → 12**: fps **flat ~44** at both throttle settings. `coordRtt`/`rustMainBoundary` *grow* with pool while fps stays fixed = Little's Law (in-flight↑ → latency↑, throughput fixed). |
| **A dedicated main↔renderer transport (lever 3B)** would be the fix | signal-attribution | Within `coordRtt`, **Rust↔main (2.0ms) > main↔renderer (1.4ms) > renderer-work (0.4ms)** — 3B targets the *smaller* half, and `coordRtt` isn't the ceiling anyway. |

## What is CONFIRMED

- **Native single-track 1080p ~44fps is ADEQUATE for 1× real-time 30fps preview** (1.47× headroom),
  and the **seek win stands** (native `av_seek_frame` + short decode-forward is **8–16× faster**
  than WebCodecs — native's durable, unconditional advantage).
- The **~22ms/frame is invariant** to driver throttle and pool depth → a fixed per-frame serial cost.
- It is a **HARD cap** for anything above ~44fps single-track: **60fps content, 2×+ fast-scrub,
  multi-track**. Those need either the real fix (below) or a WebCodecs fallback (~900fps in-process).

## The OPEN question: where is the ~22ms?

The per-frame chain is: Rust `pump` decodes into a free slot → `emit(FrameReady{slot})` → [tsfn →
main → `webContents.send`] → preload `getVideoFrame`+`createImageBitmap` → `postMessage` to renderer
main-world → `ring.push` (**delivered**) → preload fires `consumeAck` → [invoke → main → napi → mpsc]
→ Rust marks slot free → `pump` decodes the slot's **next** frame.

`coordRtt` measures **emit → ack** (≈3.8ms, and it *includes* the delivery + preload work). So the
missing ~17–19ms is **between one frame's ack and the next frame's emit/delivery for that slot** —
uninstrumented.

### Prime hypothesis + the sharpest next probe

**Measure the ack→next-emit gap IN RUST'S CLOCK** — the same single-clock trick that made `coordRtt`
clean. The Rust session thread (`apps/desktop/native/src/preview_gpu/session.rs`) sees **both**
`SessionMsg::ConsumeAck(slot)` and the subsequent `emit(FrameReady{slot})` for that slot, on the same
thread. Add a per-slot timestamp at `ConsumeAck` and sample `now − that` at the next `FrameReady` for
the slot. This splits the mystery cleanly:

- **gap ≈ 17ms in Rust** ⇒ the pump is **idle between freeing a slot and refilling it** — the cost is
  Rust-side. Then chase *why the pump idles*: it runs only on `ConsumeAck` / `RequestFrameAt` messages
  and a `RECV_TIMEOUT` (4ms) tick; suspects: (a) it's **lookahead-gated** (`frontier ≥ anchor +
  LOOKAHEAD_US`, 0.5s) and the **anchor isn't advancing** because the renderer's `requestFrameAt`
  nudges arrive too slowly (the `NativeGpuSourceHandle` coalescer sends ≤1 in-flight
  `previewGpu.requestFrameAt` invoke — a full renderer→main→napi→mpsc round-trip per anchor update);
  (b) the `recv_timeout(4ms)` loop cadence. Check whether the pump decodes on `ConsumeAck` alone or
  actually stalls waiting for the next `RequestFrameAt`.
- **gap ≈ 0 in Rust** ⇒ the ~17ms is **renderer/delivery-side** — but note that path is inside
  `coordRtt` (emit→ack), so this would instead point at the pump emitting slowly, contradicting a
  small gap. (I.e. the Rust gap is the discriminator; start there.)

This is a tiny, TS-free, single-clock instrument — cheap, and it's the direct analogue of the
`coordRtt`/`rendererRoundTrip` measurements already in place.

### Secondary hypotheses to keep in mind (if the Rust gap is small)

- The `NativeGpuSourceHandle.requestFrameAt` **coalescer** (≤1 in-flight invoke): if the pump only
  un-gates on a fresh `RequestFrameAt`, delivery is paced by that invoke's round-trip rate. Testable
  by making the bench driver nudge the anchor far-enough-ahead-but-under-the-1s-seek-threshold, or by
  measuring `requestFrameAt` invoke frequency vs delivery.
- Renderer **event-loop scheduling** of `port.onmessage` deliveries (argued *against* by throttle 0
  not helping, but not fully excluded).
- A ~16.7ms **vsync/compositor coupling** on the renderer (44fps isn't a clean 60Hz divisor, so weak,
  but worth a glance — e.g. does the delivery rate change if the window is hidden/occluded?).

## Instruments & knobs already built (reuse these)

- **Per-boundary timing:** `coordRtt` + `decodeCopy` (Rust, via `preview_gpu_take_timings` napi);
  `rendererRoundTrip` (main-clock, via `previewGpu.takeMainTimings`); preload `gvf`/`cib`/`resident`
  piggybacked on the frame `PortFrameMsg`. Assembled into the three buckets by
  `decodeBench.buildThroughputTiming` (`rustMainBoundaryMs`, `mainRendererTransitMs`,
  `rendererRoundTripMs`). The ack→next-emit gap is the one segment NOT yet covered — add it in the
  same style (`msSummary` in `shared/msStats.ts`).
- **Bench knobs:** `--strategy native`, `--fixture <hevc-1080|hevc-2160|…>`, `--pool-sweep`,
  `--pool-size <n>`, `--throttle-ms <n>` (0 = unthrottled), `--runs <n>`. Pure CLI parsers in
  `apps/desktop/e2e/scripts/bench-cli.mjs`.
- **Run recipe:** `VITE_WEFTCUT_E2E=1 npm run build` (no `napi:build` needed unless Rust changes —
  the `preview-gpu` `.node` is current); fixtures via `gen-decode-bench-fixtures.mjs`; run on a
  **quiet machine** (GPU counters are machine-wide). Build env for a `preview-gpu` addon rebuild:
  `FFMPEG_DIR` + `LIBCLANG_PATH` (see the memory's build-env note); feature is OUT of the CI union.

## Scope reminder

This whole line is **measure-first**: characterize before building. The coordination rework (lever
3A shared-memory / lever 4 zero-copy pull) is now scoped to **higher-fps single-track + 4K +
multi-track** — and even then, **only after** the ack→next-emit gap probe confirms *what* the fix must
attack (it may be the pump/anchor path, not the transport). Do not build a transport rework before
that probe. Native single-track 1× 30fps preview is adequate today; seek is a clear win.

Pointers: evergreen product doc `docs/decode-bench.md` (Native strategy §); specs/plans under
`docs/superpowers/{specs,plans}/2026-07-04-decode-bench-*`; memory topic `project_decode_bench.md`.
