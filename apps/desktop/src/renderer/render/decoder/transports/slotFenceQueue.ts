// Deferred slot acks for the hardware preview lane, taken on the renderer's own
// PRESENTED graphics device.
//
// Why this exists at all: the native decode thread overwrites a shared-texture
// slot in place as soon as it is acked, so the ack must not fire until
// Chromium's cross-device read of that slot has GPU-COMPLETED (the race, and why
// `await createImageBitmap` is not that guarantee, is documented once at the
// barrier block in src/preload/index.ts). The preload can express that wait
// itself — mode `fence` — but only on a private offscreen WebGL2 context, where
// on an IDLE GPU the fence does not signal on its own at all: the drain's
// flush-and-poll SPIN is what completes it, ~20ms of renderer thread a time, and
// a single quiet track spends ~2s per 20s window doing it.
//
// What this queue changes is that there is nothing to spin in. The completion
// signal on the renderer's WebGPU device is a PROMISE, so a slot that is not
// ready yet costs nothing to keep waiting for — which is the whole measured win
// (spin 0.088 → 0.000 thread-s/s, tick p99 23.5 → 17.3ms at one track, the
// barrier-less control's own figure). It is NOT that the signal arrives sooner:
// it arrives LATER, ~90ms, and `DEADLINE_MS` is where that tension is arbitrated.
//
// So under `rendererFence` the preload runs NO barrier and delivers the bitmap
// with the ack obligation attached; this queue discharges it.
//
// INVARIANT — every submitted bitmap acks EXACTLY ONCE. `submit` either queues
// the ack or performs it before returning; nothing else may ack, and nothing may
// skip it. `pool_size` stranded slots wedge a session for good, so the ack is
// deliberately independent of PAINT: a frame the ring evicts, or one that arrives
// while the compositor is suspended, still holds a slot and still acks. The one
// exception is a stream tearing down (`dropFor`), where the slots cease to exist
// with the native session and acking into it is the thing to avoid.
//
// TWIN: the poll/deadline/pump discipline mirrors the preload's `fence` queue
// (src/preload/index.ts). The two cannot share code — different realms — so a
// change to the contract here wants a look at that one.

import type { HwBarrierMode } from "../../../../shared/ipc";
import type { FenceHandoffStats } from "./handoffTimings";

/// How long a submitted probe may stay unsignalled before the queue acks anyway
/// and counts it. Two display intervals, matching the preload fence's bound.
///
/// Blowing it costs no thread time here — there is no blocking wait to spin in,
/// so a timeout is a bare "ack and count it". That makes the trade this constant
/// arbitrates unusually stark, and it was measured both ways at 1080p over 1-4
/// hardware tracks:
///
///   deadline           33.3ms              200ms
///   fenceWaitP50       35ms (= deadline)   83-97ms
///   forcedWaits        ~1 per frame        0
///   decode fps         30.0                30.0
///   tick p99           17.3ms              17.3ms
///   slot hold          ~35ms               ~90ms
///
/// So the WebGPU completion signal is REAL — at 200ms nothing force-acks — but it
/// arrives around 90ms, which is 5-6 display intervals and far past this bound.
/// The consequence of waiting for it is the slot hold, and a hold is a throughput
/// ceiling: `poolSize` slots / hold. At ~90ms and the shipped pool of 3 that is
/// ~33 delivered fps per session — fine for the 30fps fixtures, and a HALVING for
/// 60fps media. That is a certain regression, against a residual risk, so the
/// tight bound wins and the ack is usually released on the deadline rather than
/// on the signal.
///
/// What stands behind it: 33ms is well past the copy's actual completion in
/// practice (`none` — acking immediately — reorders ~80% of frames, and
/// `preview-gpu-order.spec.ts` is clean at pool 1/3/5 and on three concurrent
/// sessions at this bound). What would remove the compromise is a deeper pool,
/// which is the one thing this cost is NOT worth paying VRAM for today.
///
/// Ruled out, so nobody re-tries them: prodding the wire with an empty
/// `queue.submit([])` once per drain pass (the WebGPU analogue of the preload's
/// `gl.flush()`) does NOT shorten the ~90ms — measured 82.7/97.0/18.6/90.9ms over
/// 1-4 tracks against 82.7/83.1/96.9/90.3 without it. And widening this bound
/// without also deepening the pool just moves the hold, per the table above.
const DEADLINE_MS = 2 * (1000 / 60);

/// One in-flight completion probe over one delivered bitmap.
export interface SlotFenceProbe {
  /// Non-blocking: has the GPU finished the copy this probe was taken after?
  signalled(): boolean;
  /// Release whatever GPU object the probe holds.
  dispose(): void;
}

/// The graphics device the probes are taken on. Injected rather than reached for
/// so this queue is testable without a GPU, and so "no device registered yet"
/// is a state the fallback ladder handles rather than a crash.
export interface SlotFenceBackend {
  /// Submit the completion-forcing copy and start its probe. `onSignal` is a
  /// WAKE-UP, not the ack — the queue re-reads `signalled()` itself, so a
  /// backend that over-fires it is harmless. Null = this backend could not run,
  /// and the caller must fall back to a barrier that does.
  submit(bmp: ImageBitmap, onSignal: () => void): SlotFenceProbe | null;
}

/// What actually ran for one submitted bitmap. `applied` is the rung of the
/// fallback ladder that ran, never the mode that was configured: a
/// `rendererFence` session whose device is missing runs the CPU readback
/// instead, and a bench leg that reported its label rather than its outcome
/// would publish the readback's cost under the fence's name. `drawMs`/`readMs`
/// split the blocking cost the same way the preload's `BarrierCost` does.
export interface SlotFenceSubmission {
  applied: HwBarrierMode;
  drawMs: number;
  readMs: number;
}

type PendingSlot = {
  streamId: string;
  slot: number;
  probe: SlotFenceProbe;
  submittedAt: number;
  ack: () => void;
};

type StreamStats = {
  pending: number;
  pendingPeak: number;
  forcedWaits: number;
  lastWaitMs: number | null;
};

/// CPU-readback fallback: rasterize 1px of the bitmap and read it back, which
/// blocks until Chromium materializes the `createImageBitmap` copy. Correct but
/// synchronous (~20ms of renderer thread per frame per session) — the barrier
/// `fence` replaced. Reached only when no device is registered, so that a
/// missing device degrades to SLOW rather than to INCORRECT.
///
/// Null = not even a 2D context, so nothing ran. Reported as `none`, which is an
/// alarm and not a cost.
let cpuBarrierCtx: OffscreenCanvasRenderingContext2D | null | undefined;
function forceReadCompleteOnCpu(bmp: ImageBitmap): { drawMs: number; readMs: number } | null {
  if (cpuBarrierCtx === undefined) {
    cpuBarrierCtx =
      typeof OffscreenCanvas === "undefined"
        ? null
        : new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  }
  if (!cpuBarrierCtx) return null;
  const tDraw = performance.now();
  cpuBarrierCtx.drawImage(bmp, 0, 0, 1, 1);
  const tRead = performance.now();
  cpuBarrierCtx.getImageData(0, 0, 1, 1);
  return { drawMs: tRead - tDraw, readMs: performance.now() - tRead };
}

export class SlotFenceQueue {
  private backend: SlotFenceBackend | null = null;
  private readonly pending: PendingSlot[] = [];
  private readonly statsByStream = new Map<string, StreamStats>();
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  /// `deadlineMs` is a seam for tests only (a zero deadline forces on the first
  /// drain); production always runs `DEADLINE_MS`.
  constructor(private readonly deadlineMs: number = DEADLINE_MS) {}

  /// Point the queue at a device, or at nothing. Entries already pending keep
  /// their own probes — those are self-contained objects, so a re-registration
  /// (a StrictMode remount, a renderer rebuild) never strands a slot.
  setBackend(backend: SlotFenceBackend | null): void {
    this.backend = backend;
  }

  /// Take responsibility for one delivered bitmap's slot. Returns the rung that
  /// ran; the ack is either queued (fence) or already done (fallback).
  submit(streamId: string, slot: number, bmp: ImageBitmap, ack: () => void): SlotFenceSubmission {
    const t0 = performance.now();
    // The copy is what forces completion; the probe only reports it. Both are
    // the backend's business, and either failing means the ladder must catch it.
    //
    // A THROW is caught as well as a null, so the invariant below does not rest on
    // a backend honouring its contract: the shipped one converts its own failures
    // to null, but an escaping throw here would skip the ack entirely and strand
    // the slot — the one outcome this queue must never produce.
    let probe: SlotFenceProbe | null = null;
    try {
      probe = this.backend?.submit(bmp, () => this.drain()) ?? null;
    } catch {
      probe = null;
    }
    if (probe) {
      const drawMs = performance.now() - t0;
      this.pending.push({ streamId, slot, probe, submittedAt: performance.now(), ack });
      const stats = this.statsFor(streamId);
      stats.pending += 1;
      stats.pendingPeak = Math.max(stats.pendingPeak, stats.pending);
      this.schedulePump();
      return { applied: "rendererFence", drawMs, readMs: 0 };
    }
    // The fallback may THROW where the backend merely returns null — `drawImage`
    // rejects a detached bitmap. Swallowed rather than propagated so the ack below
    // is unconditional: an escaping throw would strand this slot, and `pool_size`
    // stranded slots wedge the session for good. A frame that forced nothing
    // reports `none`, which is an alarm and not a cost.
    let cost: { drawMs: number; readMs: number } | null = null;
    try {
      cost = forceReadCompleteOnCpu(bmp);
    } catch {
      cost = null;
    }
    ack();
    return cost
      ? { applied: "readback", ...cost }
      : { applied: "none", drawMs: 0, readMs: 0 };
  }

  /// Ack every pending slot whose probe has signalled, plus any that blew the
  /// deadline. Cheap enough to call opportunistically — a frame arriving is the
  /// wake-up the queue was waiting for anyway.
  drain(): void {
    if (this.pending.length === 0) return;
    const now = performance.now();
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      const done = p.probe.signalled();
      if (!done && now - p.submittedAt < this.deadlineMs) continue;
      p.probe.dispose();
      this.pending.splice(i, 1);
      const stats = this.statsFor(p.streamId);
      stats.pending = Math.max(0, stats.pending - 1);
      stats.lastWaitMs = performance.now() - p.submittedAt;
      if (!done) stats.forcedWaits += 1;
      // Acked even when the probe never signalled: a slot that is never acked
      // is a permanent leak and `pool_size` of them wedge the session for good,
      // so one possibly-torn frame is strictly the smaller harm. `forcedWaits`
      // is what keeps that trade visible instead of silent.
      p.ack();
    }
  }

  /// Drop a closing stream's pending slots WITHOUT acking. The renderer's
  /// teardown calls `previewGpu.close` right after, and main's close joins the
  /// native decode thread — so the slots cease to exist and an ack into a
  /// mid-closing session is exactly what the ordering on both sides exists to
  /// prevent (see `GpuTransport.dispose` and the preload's
  /// `closePreviewGpuStream`).
  dropFor(streamId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.streamId !== streamId) continue;
      p.probe.dispose();
      this.pending.splice(i, 1);
    }
    this.statsByStream.delete(streamId);
  }

  /// This stream's fence health in the shape the handoff window records, or
  /// undefined before its first submit. `forcedWaitMsTotal` is structurally 0
  /// here — see `DEADLINE_MS`: this path has no spin to burn thread time in, and
  /// reporting a fabricated cost would make the two fence variants look alike
  /// where they differ most.
  stats(streamId: string): FenceHandoffStats | undefined {
    const s = this.statsByStream.get(streamId);
    if (!s) return undefined;
    return {
      pendingPeak: s.pendingPeak,
      forcedWaits: s.forcedWaits,
      forcedWaitMsTotal: 0,
      ...(s.lastWaitMs !== null ? { waitMs: s.lastWaitMs } : {}),
    };
  }

  /// Un-acked slots still held, across every stream. Diagnostics + tests.
  pendingCount(): number {
    return this.pending.length;
  }

  private statsFor(streamId: string): StreamStats {
    let s = this.statsByStream.get(streamId);
    if (!s) {
      s = { pending: 0, pendingPeak: 0, forcedWaits: 0, lastWaitMs: null };
      this.statsByStream.set(streamId, s);
    }
    return s;
  }

  /// Drain driver for the gaps between frames and between signals. Runs only
  /// while something is pending and stops the moment the queue empties.
  ///
  /// `setTimeout`, NOT requestAnimationFrame, for the same reason the preload's
  /// pump avoids it: rAF is frozen while the window is OCCLUDED, so acks would
  /// stop, the pool would starve, and preview would wedge — reproducible only
  /// when something covers the window. (Occlusion also stops Pixi presenting,
  /// which brings back the very idle-signal problem this queue moved away from;
  /// the deadline above is what keeps that case correct rather than stuck.)
  private schedulePump(): void {
    if (this.pumpTimer !== null || this.pending.length === 0) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.drain();
      this.schedulePump();
    }, 0);
  }
}

/// Minimal structural view of a Pixi renderer, so this module needs no pixi
/// import: the WebGPU renderer exposes `gpu.device`, the WebGL one does not.
type MaybeWebgpuRenderer = { gpu?: { device?: GPUDevice | null } | null };

/// The completion probe on a WebGPU device: copy one pixel out of the bitmap on
/// the queue Pixi presents from, then ask that queue when its submitted work is
/// done.
///
/// Why one pixel and not the whole frame (which is what the preload's WebGL
/// `texImage2D` ends up doing): GPU synchronization is per-RESOURCE, so reading
/// any part of the bitmap orders after the whole pending write into it — and
/// that write IS the read of the shared slot. A full-frame copy would add real
/// bandwidth (8MB at 1080p, 33MB at 4K) to the device we are trying not to
/// disturb, every frame, to establish the same dependency.
///
/// `onSubmittedWorkDone` is the fence equivalent, and better in the way that
/// matters: it is a promise, so there is no polling and no spin. WebGL2 has no
/// blocking wait to offer (`MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is 0 on Chromium), so
/// the preload's variant must flush-and-poll at its deadline — and on an idle GPU
/// that spin is what completes the fence rather than merely observing it. This
/// one resolves on its own; it is just slow to (see `DEADLINE_MS`).
class WebgpuSlotFence implements SlotFenceBackend {
  /// One 1×1 destination, created lazily and reused for the whole session. The
  /// pixels are never read — only the dependency matters.
  private tex: GPUTexture | null = null;

  constructor(private readonly device: GPUDevice) {}

  submit(bmp: ImageBitmap, onSignal: () => void): SlotFenceProbe | null {
    try {
      // RENDER_ATTACHMENT is required of a copyExternalImageToTexture
      // destination, COPY_DST of any copy destination.
      this.tex ??= this.device.createTexture({
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: this.tex },
        [1, 1],
      );
      let done = false;
      // A rejected promise (device lost) settles as signalled: preview is over
      // either way, and a probe that can never resolve would hold its slot to
      // the deadline on every frame.
      const settle = (): void => {
        done = true;
        onSignal();
      };
      void this.device.queue.onSubmittedWorkDone().then(settle, settle);
      return { signalled: () => done, dispose: () => {} };
    } catch {
      // A detached bitmap or a dead device — report "could not run" so the
      // caller's ladder puts a real barrier in place instead.
      return null;
    }
  }

}

/// Derive a backend from the host's Pixi renderer, or null when it offers none.
///
/// WebGPU only, DELIBERATELY. Taking the fence on a Pixi WebGL2 context would
/// mean `bindTexture` on a context whose bound-texture cache Pixi maintains
/// itself, so the barrier would corrupt compositing state to measure it; the
/// WebGPU device hands out a private texture and a queue with no such shared
/// state. The preview renderer prefers WebGPU (see PixiPreview), so this is also
/// the path that actually runs; a WebGL preview falls back to the CPU readback,
/// which is slow but correct and reports itself as `readback` rather than
/// blending in.
export function slotFenceBackendForRenderer(renderer: unknown): SlotFenceBackend | null {
  const device = (renderer as MaybeWebgpuRenderer | null)?.gpu?.device;
  return device ? new WebgpuSlotFence(device) : null;
}

/// The one queue every `GpuTransport` shares. Module-level because the device is
/// the host application's, not any one session's, and because the ack obligation
/// outlives the frame that created it.
const shared = new SlotFenceQueue();

export function sharedSlotFenceQueue(): SlotFenceQueue {
  return shared;
}

/// Point the shared queue at the host's device. Called by the preview host when
/// its Pixi Application initializes, and with null on teardown.
export function setSlotFenceBackend(backend: SlotFenceBackend | null): void {
  shared.setBackend(backend);
}
