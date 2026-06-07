import { planPrewarmTargets, type PrewarmContent } from "./prewarmPlan";

/// One active template content the prewarmer can rasterize. The planning fields
/// (cacheKey, contentFrame, contentDurationFrames) come from
/// `templateFrameDescriptor`; `render(frame)` rasters an arbitrary content frame
/// of this content.
export interface PrewarmContentSpec extends PrewarmContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface TemplatePrewarmerDeps {
  cap: number;
  hasFrame: (cacheKey: string, frame: number) => boolean;
  setFrame: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  /// Schedule a callback for "later" (idle). Returns a cancel token. Real impl:
  /// requestIdleCallback with a setTimeout fallback. Tests inject a manual one.
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// Max frames to raster per scheduled batch before yielding. Keeps the loop
  /// off the play tick's back.
  batchSize?: number;
  /// Fired after each drained batch so a watcher can recompute cache coverage
  /// (the prewarmer doesn't own status — the Compositor reads L0 coverage).
  /// Never throws. Optional so existing callers/tests don't need it.
  onProgress?: () => void;
}

/// Budget-paced background filler. `setTargets` (re)plans; an idle loop rasters
/// missing frames in priority order until the plan is fully cached, yielding
/// between batches. Never owns bitmaps (the cache does). Preview-only.
export class TemplatePrewarmer {
  private specsByKey = new Map<string, PrewarmContentSpec>();
  private queue: { cacheKey: string; frame: number }[] = [];
  private scheduled: number | null = null;
  private running = false;
  private disposed = false;
  private readonly batchSize: number;

  constructor(private readonly deps: TemplatePrewarmerDeps) {
    this.batchSize = deps.batchSize ?? 3;
  }

  /// Replace the active contents (deduped by cacheKey by the planner) and the
  /// playhead-relative plan, then (re)arm the loop.
  setTargets(specs: PrewarmContentSpec[]): void {
    if (this.disposed) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    this.queue = planPrewarmTargets(specs, this.deps.cap);
    this.arm();
  }

  private arm(): void {
    if (this.disposed || this.running || this.scheduled != null) return;
    if (this.queue.length === 0) return;
    this.scheduled = this.deps.schedule(() => {
      this.scheduled = null;
      void this.drainBatch();
    });
  }

  private async drainBatch(): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    try {
      // Pull up to batchSize FRESH targets (skip already-cached / inactive),
      // then raster them CONCURRENTLY. Renders serialize through the per-
      // templateId harness (microtask-serialized — safe), but rasters parallelize
      // across the RasterPool, so the prewarmer fills at pool speed instead of 1x.
      const batch: { cacheKey: string; frame: number; spec: PrewarmContentSpec }[] = [];
      while (batch.length < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        if (this.deps.hasFrame(target.cacheKey, target.frame)) continue; // already cached
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        batch.push({ cacheKey: target.cacheKey, frame: target.frame, spec });
      }
      await Promise.all(
        batch.map(async ({ cacheKey, frame, spec }) => {
          try {
            const bmp = await spec.render(frame);
            if (this.disposed) {
              // Disposed mid-raster: this bitmap will never be cached, so close
              // it to avoid leaking the decoded image.
              bmp.close();
              return;
            }
            this.deps.setFrame(cacheKey, frame, bmp);
          } catch {
            // Raster failed (e.g. harness/pool disposed) — drop, keep going.
          }
        }),
      );
    } finally {
      this.running = false;
      this.deps.onProgress?.();
      this.arm(); // more to do? reschedule. else idle.
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled != null) {
      this.deps.cancel(this.scheduled);
      this.scheduled = null;
    }
    this.queue = [];
    this.specsByKey.clear();
  }
}
