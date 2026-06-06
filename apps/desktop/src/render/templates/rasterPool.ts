// Pure scheduler for off-main-thread SVG rasterization. It owns no DOM — slots
// are injected (`createSlot`), so the dispatch / queue / recycle / fast-fail
// logic is fully unit-testable. The real slots (sandboxed iframes) live in
// `rasterSlot.ts`. The pool never speeds a single raster; it parallelizes them
// across slots and keeps the work off the main thread.

/// One rasterizer backend. `rasterize` resolves with a transferred ImageBitmap
/// or rejects on timeout/error. `dispose` tears down the backing resource and
/// MUST reject any in-flight `rasterize` (so the pool's callers fall back).
export interface RasterSlot {
  rasterize(svg: string): Promise<ImageBitmap>;
  dispose(): void;
}

export interface RasterPoolDeps {
  size: number;
  /// Factory for a fresh slot. Real impl: an iframe-backed slot. Tests inject a fake.
  createSlot: () => RasterSlot;
  /// After this many CONSECUTIVE failures the pool disables itself: `rasterize`
  /// then rejects immediately (fast-fail) so callers fall back without paying a
  /// per-raster timeout. Reset to 0 on any success. Default 3.
  maxConsecutiveFailures?: number;
}

interface SlotState {
  slot: RasterSlot;
  busy: boolean;
}

interface QueuedJob {
  svg: string;
  resolve: (b: ImageBitmap) => void;
  reject: (e: unknown) => void;
}

export class RasterPool {
  private slots: SlotState[] = [];
  private queue: QueuedJob[] = [];
  private consecutiveFailures = 0;
  private disposed = false;
  private readonly size: number;
  private readonly createSlot: () => RasterSlot;
  private readonly maxConsecutiveFailures: number;

  constructor(deps: RasterPoolDeps) {
    this.size = Math.max(1, deps.size);
    this.createSlot = deps.createSlot;
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? 3;
  }

  /// True once the pool has fast-failed; callers should fall back permanently.
  get disabled(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  /// Queue a raster; resolves with a transferred ImageBitmap. Rejects
  /// immediately when disposed or disabled (so the caller falls back to inline).
  rasterize(svg: string): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(new Error("rasterPool: disposed"));
    if (this.disabled) {
      return Promise.reject(new Error("rasterPool: disabled (too many failures)"));
    }
    return new Promise<ImageBitmap>((resolve, reject) => {
      this.queue.push({ svg, resolve, reject });
      this.pump();
    });
  }

  private ensureSlots(): void {
    while (this.slots.length < this.size) {
      this.slots.push({ slot: this.createSlot(), busy: false });
    }
  }

  private pump(): void {
    if (this.disposed || this.queue.length === 0) return;
    this.ensureSlots();
    for (const state of this.slots) {
      if (this.queue.length === 0) break;
      if (state.busy) continue;
      const job = this.queue.shift()!;
      state.busy = true;
      state.slot
        .rasterize(job.svg)
        .then(
          (bmp) => {
            this.consecutiveFailures = 0;
            job.resolve(bmp);
          },
          (err) => {
            // The slot may be wedged — tear it down and replace it so the next
            // job gets a fresh iframe. The call still rejects → caller falls back.
            this.consecutiveFailures++;
            try {
              state.slot.dispose();
            } catch {
              // ignore
            }
            state.slot = this.createSlot();
            job.reject(err);
          },
        )
        .finally(() => {
          state.busy = false;
          this.pump();
        });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.slots) {
      try {
        s.slot.dispose();
      } catch {
        // ignore
      }
    }
    this.slots = [];
    const err = new Error("rasterPool: disposed");
    for (const j of this.queue) j.reject(err);
    this.queue = [];
  }
}
