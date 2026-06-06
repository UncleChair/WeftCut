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
      let done = 0;
      while (done < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        if (this.deps.hasFrame(target.cacheKey, target.frame)) continue; // already cached
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        try {
          const bmp = await spec.render(target.frame);
          if (this.disposed) return;
          this.deps.setFrame(target.cacheKey, target.frame, bmp);
        } catch {
          // Raster failed (e.g. harness disposed) — drop this target, keep going.
        }
        done++;
      }
    } finally {
      this.running = false;
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
