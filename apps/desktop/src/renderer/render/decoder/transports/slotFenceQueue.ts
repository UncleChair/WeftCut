// Deferred slot acks for the hardware preview lane, taken on the renderer's own
// PRESENTED graphics device.
//
// Why this exists at all: the native decode thread overwrites a shared-texture
// slot in place as soon as it is acked, so the ack must not fire until
// Chromium's cross-device read of that slot has GPU-COMPLETED (the race, and why
// `await createImageBitmap` is not that guarantee, is documented once at the
// barrier block in src/preload/index.ts). The preload can express that wait
// itself — mode `fence` — but only on a private offscreen WebGL2 context, which
// offers no blocking wait (`MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is 0 on Chromium):
// on an IDLE GPU the fence does not signal on its own at all, so the drain's
// flush-and-poll SPIN is what completes it, ~20ms of renderer thread a time, and
// a single quiet track spends ~2s per 20s window doing it.
//
// What this queue changes is that there is nothing to spin in. The completion
// signal on the renderer's WebGPU device is a PROMISE, so a slot that is not
// ready yet costs nothing on the renderer thread to keep waiting for. It is NOT
// that the signal arrives sooner: it arrives around 90ms. That hold can limit
// decode throughput with a shallow native pool, but completion is the ownership
// boundary — elapsed wall time is not evidence that native may safely overwrite
// the shared texture.
//
// So under `rendererFence` the preload runs NO barrier and delivers the bitmap
// with the ack obligation attached; this queue discharges it.
//
// INVARIANT — every live submitted bitmap acks EXACTLY ONCE, and only after its
// probe signals. `submit` either queues the ack or performs a completed fallback
// before returning; nothing else may ack. The ack is deliberately independent
// of PAINT: a frame the ring evicts, or one that arrives while the compositor is
// suspended, still holds a slot and still acks. The one exception is a stream
// tearing down (`dropFor`), where the slots cease to exist with the native
// session and acking into it is the thing to avoid.
//
// TWIN: the preload's `fence` queue (src/preload/index.ts) protects the same
// ownership boundary in another realm. Its WebGL sync requires polling; this
// WebGPU path is callback-driven. A change to either completion contract wants
// a look at the other.

import type { HwBarrierMode } from "../../../../shared/ipc";
import type { FenceHandoffStats } from "./handoffTimings";

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
/// fallback ladder that ran, never the configured mode — see
/// `barrierModeObserved` in handoffTimings.ts. `drawMs`/`readMs` split the
/// blocking cost the same way the preload's `BarrierCost` does.
export interface SlotFenceSubmission {
  applied: HwBarrierMode;
  drawMs: number;
  readMs: number;
}

export type SlotFenceReleasePolicy =
  | { mode: "signal-only" }
  | { mode: "unsafe-deadline"; deadlineMs: number };

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
/// synchronous (~20ms of renderer thread per frame per session). Reached only
/// when no device is registered, so that a missing device degrades to SLOW
/// rather than to INCORRECT.
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

  /// Production uses `signal-only`: an unsignalled probe retains ownership until
  /// it signals or its stream closes. `unsafe-deadline` releases on a timer and
  /// exists only for diagnostics/tests; it may recycle a shared texture while
  /// Chromium is still reading it.
  constructor(
    private readonly releasePolicy: SlotFenceReleasePolicy = { mode: "signal-only" },
  ) {}

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

  /// Ack every pending slot whose probe has signalled. In the explicit unsafe
  /// compatibility mode, a blown deadline is also released and counted.
  /// Cheap enough to call opportunistically — a frame arriving is a wake-up the
  /// queue may already have been waiting for.
  drain(): void {
    if (this.pending.length === 0) return;
    const now = performance.now();
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      let done = false;
      try {
        done = p.probe.signalled();
      } catch {
        // An unreadable probe is not proof of completion. Retain its slot for
        // stream teardown, but keep draining independent slots.
        continue;
      }
      const unsafeDeadlineExpired =
        this.releasePolicy.mode === "unsafe-deadline" &&
        now - p.submittedAt >= this.releasePolicy.deadlineMs;
      if (!done && !unsafeDeadlineExpired) continue;
      // Completion owns the slot release, not successful destruction of the
      // probe wrapper. A lost device can make cleanup throw after the work has
      // already settled; do not let that strand this or earlier ready slots.
      try {
        p.probe.dispose();
      } catch {
        // Best-effort GPU-object cleanup; ownership release continues below.
      }
      this.pending.splice(i, 1);
      const stats = this.statsFor(p.streamId);
      stats.pending = Math.max(0, stats.pending - 1);
      stats.lastWaitMs = performance.now() - p.submittedAt;
      if (!done) stats.forcedWaits += 1;
      // `!done` is reachable only through the explicitly unsafe constructor
      // option. Keep it observable rather than silently presenting that result
      // as a completed fence.
      try {
        p.ack();
      } catch {
        // The production callback owns its transport-failure response (it closes
        // the native session). Do not let one failed delivery strand other
        // independently completed slots in this drain pass.
      }
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
      // Device teardown may make destroying its probe throw. Closing the stream
      // still has to forget every local ownership record; native joins and
      // destroys the slots independently, so retaining this entry cannot help.
      try {
        p.probe.dispose();
      } catch {
        // Best-effort GPU-object cleanup; local queue cleanup is unconditional.
      }
      this.pending.splice(i, 1);
    }
    this.statsByStream.delete(streamId);
    if (this.pending.length === 0 && this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  /// This stream's fence health in the shape the handoff window records, or
  /// undefined before its first submit. `forcedWaitMsTotal` is structurally 0
  /// here: this path has no blocking spin to burn thread time in, and reporting
  /// a fabricated cost would make the two fence variants look alike where they
  /// differ most.
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
  /// The safe production path is woken directly by the backend's completion
  /// callback and does not poll. Only the explicit unsafe deadline mode needs a
  /// timer so its compatibility timeout can elapse between frames.
  private schedulePump(): void {
    if (this.releasePolicy.mode !== "unsafe-deadline") return;
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
/// matters: it is a promise, so there is no polling and no spin (the header
/// carries the contrast with the preload's WebGL2 variant). This one resolves on
/// its own; it is just slow to.
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
      // A rejected promise (device lost) settles as signalled: there can be no
      // remaining device work to protect, and leaving it pending would retain
      // the native slot until stream teardown.
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
