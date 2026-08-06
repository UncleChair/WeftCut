import { planBakeTargets, type BakeContent } from "./bakePlan";

export type BakePhase = "baking" | "ready" | "error";
export interface BakeStatus { phase: BakePhase; done: number; total: number; }

/// One content the baker should persist in full. `render(frame)` rasters an
/// arbitrary content frame (the Compositor's closure → `bakeMotifFrame`, CDP).
export interface BakeContentSpec extends BakeContent {
  render: (frame: number) => Promise<ImageBitmap>;
}

export interface MotifBakerDeps {
  schedule: (cb: () => void) => number;
  cancel: (token: number) => void;
  /// True if (cacheKey, frame) PNG already on disk → skip. Consulted ONCE per
  /// frame (when the frame is pulled into a batch), so the whole bake is O(N).
  isOnDisk: (cacheKey: string, frame: number) => Promise<boolean>;
  /// Encode + write the PNG, then mark the cacheKey baked. Throws are caught.
  persist: (cacheKey: string, frame: number, bmp: ImageBitmap) => Promise<void>;
  /// Optionally warm L0 with the freshly-baked bitmap (so the just-baked frame
  /// is instantly available without a disk round-trip). The cache OWNS the
  /// bitmap after this.
  warm: (cacheKey: string, frame: number, bmp: ImageBitmap) => void;
  /// Report coarse per-content status. Called immediately on setTargets
  /// (baking) and once per drain batch for touched keys (progress / ready /
  /// error). Never throws. Optional so existing callers/tests don't need it.
  onStatus?: (cacheKey: string, status: BakeStatus) => void;
  batchSize?: number;
}

/// Idle-paced, full-content writer for L2. `setTargets` (re)plans synchronously
/// and arms; an idle loop renders+persists missing frames in priority order,
/// yielding between batches. The SOLE writer of L2 (the resolver is read-only),
/// so there's no fire-and-forget eviction race. Preview-only (DOM-gated by the
/// Compositor). Mirrors `MotifPrewarmer`'s idle-loop discipline.
export class MotifBaker {
  private specsByKey = new Map<string, BakeContentSpec>();
  private queue: { cacheKey: string; frame: number }[] = [];
  private scheduled: number | null = null;
  private running = false;
  private disposed = false;
  private readonly batchSize: number;
  /// Per-cacheKey bake progress. total = contentDurationFrames; done counts
  /// frames persisted OR skipped-as-already-on-disk. Reset each setTargets.
  private status = new Map<string, BakeStatus>();

  constructor(private readonly deps: MotifBakerDeps) {
    this.batchSize = deps.batchSize ?? 2;
  }

  /// Replace the active bake set, plan the whole content (playhead-first), and
  /// arm — all synchronously, like `MotifPrewarmer.setTargets`, so a caller
  /// (and the unit test's settle loop) sees a scheduled callback immediately.
  setTargets(specs: BakeContentSpec[]): void {
    if (this.disposed) return;
    this.specsByKey = new Map(specs.map((s) => [s.cacheKey, s]));
    this.queue = planBakeTargets(specs, () => false);
    // Preserve status across re-plans: re-calling setTargets with an unchanged
    // active set (every frame, as the playhead moves) must NOT reset a ready
    // content back to baking — that flickers the UI dot. Keep the prior status
    // object for keys still present; announce "baking" only for NEW keys.
    const prev = this.status;
    this.status = new Map();
    for (const s of specs) {
      const old = prev.get(s.cacheKey);
      if (old) {
        this.status.set(s.cacheKey, old);
      } else {
        const st: BakeStatus = { phase: "baking", done: 0, total: s.contentDurationFrames };
        this.status.set(s.cacheKey, st);
        this.deps.onStatus?.(s.cacheKey, { ...st });
      }
    }
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
    const touched = new Set<string>();
    try {
      // Pull up to batchSize targets (drop inactive contents), then process
      // them CONCURRENTLY. The disk-skip check runs per-frame inside the map —
      // a skipped (already-baked) frame just consumes a slot; skips are the
      // cheap case. Each frame's `isOnDisk` is consulted exactly once.
      const batch: { cacheKey: string; frame: number; spec: BakeContentSpec }[] = [];
      while (batch.length < this.batchSize && this.queue.length > 0) {
        const target = this.queue.shift()!;
        const spec = this.specsByKey.get(target.cacheKey);
        if (!spec) continue; // content no longer active
        batch.push({ cacheKey: target.cacheKey, frame: target.frame, spec });
      }
      await Promise.all(
        batch.map(async ({ cacheKey, frame, spec }) => {
          try {
            if (await this.deps.isOnDisk(cacheKey, frame)) { this.bump(cacheKey, touched); return; }
            const bmp = await spec.render(frame);
            if (this.disposed) {
              bmp.close();
              return;
            }
            await this.deps.persist(cacheKey, frame, bmp);
            this.deps.warm(cacheKey, frame, bmp);
            this.bump(cacheKey, touched);
          } catch {
            this.markError(cacheKey, touched);
          }
        }),
      );
    } finally {
      for (const k of touched) {
        const st = this.status.get(k);
        if (st) this.deps.onStatus?.(k, { ...st });
      }
      this.running = false;
      this.arm(); // more queued? reschedule. else idle.
    }
  }

  /// A frame completed (persisted or already-on-disk). Advance done; flip to
  /// ready when complete. No-op if the content is not in the "baking" phase —
  /// a re-planned queue can re-process already-counted frames; a ready content
  /// must stay put and must not overshoot.
  private bump(cacheKey: string, touched: Set<string>): void {
    const st = this.status.get(cacheKey);
    if (!st || st.phase !== "baking") return;
    st.done = Math.min(st.total, st.done + 1);
    if (st.done >= st.total) st.phase = "ready";
    touched.add(cacheKey);
  }

  private markError(cacheKey: string, touched: Set<string>): void {
    const st = this.status.get(cacheKey);
    if (!st) return;
    st.phase = "error";
    touched.add(cacheKey);
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled != null) {
      this.deps.cancel(this.scheduled);
      this.scheduled = null;
    }
    this.queue = [];
    this.specsByKey.clear();
    this.status.clear();
  }
}
