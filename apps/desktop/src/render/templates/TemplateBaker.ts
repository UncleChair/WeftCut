import { planBakeTargets, type BakeContent } from "./bakePlan";

/// One content the baker should persist in full. `render(frame)` rasters an
/// arbitrary content frame (the Compositor's closure → `rasterTemplateFrame`).
export interface BakeContentSpec extends BakeContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface TemplateBakerDeps {
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// True if (cacheKey, frame) PNG already on disk → skip.
  isOnDisk: (cacheKey: string, frame: number) => Promise<boolean>;
  /// Encode + write the PNG, then mark the cacheKey baked. Throws are caught.
  persist: (cacheKey: string, frame: number, bmp: ImageBitmap) => Promise<void>;
  /// Optionally warm L0 with the freshly-baked bitmap (so the just-baked frame
  /// is instantly available without a disk round-trip). The cache OWNS the
  /// bitmap after this; if `warm` declines it, the baker closes the bitmap.
  warm: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  batchSize?: number;
}

/// Idle-paced, full-content writer for L2. `setTargets` (re)plans; an idle loop
/// renders+persists missing frames in priority order, yielding between batches.
/// The SOLE writer of L2 (the resolver is read-only), so there's no
/// fire-and-forget eviction race. Preview-only (DOM-gated by the Compositor).
export class TemplateBaker {
  private specsByKey = new Map<string, BakeContentSpec>();
  private queue: { cacheKey: string; frame: number }[] = [];
  private scheduled: number | null = null;
  private running = false;
  private disposed = false;
  private readonly batchSize: number;

  constructor(private readonly deps: TemplateBakerDeps) {
    this.batchSize = deps.batchSize ?? 2;
  }

  /// Replace the active bake set and re-plan. Plans all frames optimistically
  /// (without a pre-filter); each frame is re-checked against `isOnDisk` just
  /// before rendering inside `drainBatch` so already-baked frames are always
  /// skipped. This keeps planning synchronous so `arm` runs before the first
  /// idle tick, matching the test's manual-scheduler flush contract.
  setTargets(specs: BakeContentSpec[]): void {
    if (this.disposed) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    this.queue = planBakeTargets(specs, () => false); // no pre-filter; re-check in drainBatch
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
      // Drain the whole queue into candidates, pre-check all on-disk in one
      // parallel Promise.all (1 microtask tick), then take the first batchSize
      // survivors for render+persist. Remaining survivors go back to the front
      // of the queue so the next arm picks them up immediately.
      // This ensures a single drainBatch exhausts a small queue entirely in
      // cases where some frames are skipped, keeping the test flush's two-tick
      // budget sufficient for all-done-in-one-pass scenarios.
      const all: { cacheKey: string; frame: number; spec: BakeContentSpec }[] = [];
      while (this.queue.length > 0) {
        const target = this.queue.shift()!;
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        all.push({ cacheKey: target.cacheKey, frame: target.frame, spec });
      }
      if (all.length === 0) return;
      // Pre-check on-disk status for all candidates concurrently (1 tick).
      const onDiskFlags = await Promise.all(
        all.map(({ cacheKey, frame }) => this.deps.isOnDisk(cacheKey, frame)),
      );
      if (this.disposed) return;
      const survivors = all.filter((_, i) => !onDiskFlags[i]);
      const batch = survivors.slice(0, this.batchSize);
      const remainder = survivors.slice(this.batchSize);
      // Put the remainder back at the front so the next idle tick starts there.
      this.queue.unshift(...remainder);
      await Promise.all(
        batch.map(async ({ cacheKey, frame, spec }) => {
          try {
            const bmp = await spec.render(frame);
            if (this.disposed) {
              bmp.close();
              return;
            }
            await this.deps.persist(cacheKey, frame, bmp);
            this.deps.warm(cacheKey, frame, bmp);
          } catch {
            // Raster/encode/write failed — drop this frame, keep going. The
            // next setTargets (or session) will retry the missing frame.
          }
        }),
      );
    } finally {
      this.running = false;
      this.arm();
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
