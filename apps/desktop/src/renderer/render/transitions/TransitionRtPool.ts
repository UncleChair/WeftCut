// Pooled composition-sized RenderTextures backing the transition node's two
// side captures. LANDMINE: this path is under the playback memory-ratchet
// red line — steady-state playback across a window must never allocate.
// `acquire` reuses freed textures, so capacity settles at max concurrent
// active transitions × 2 and is reused across frames.
//
// The texture factory is injected so the accounting is unit-testable
// without a GL context; TransitionNodes.ts binds the real
// `RenderTexture.create` (with the per-backend format landmine).

export interface RtFactory<T> {
  create(width: number, height: number): T;
  destroy(rt: T): void;
}

export class TransitionRtPool<T extends object> {
  private free: T[] = [];
  /// `"w×h"` each texture was created at — a released texture that no longer
  /// matches the pool's current size (composition resize) is destroyed on
  /// its way back instead of poisoning the free list.
  private sizeOf = new Map<T, string>();
  private outstanding = 0;
  private createdCount = 0;
  private destroyedCount = 0;
  private disposed = false;

  constructor(
    private width: number,
    private height: number,
    private factory: RtFactory<T>,
  ) {}

  acquire(): T {
    const reused = this.free.pop();
    if (reused) {
      this.outstanding += 1;
      return reused;
    }
    const fresh = this.factory.create(this.width, this.height);
    this.sizeOf.set(fresh, `${this.width}x${this.height}`);
    this.createdCount += 1;
    this.outstanding += 1;
    return fresh;
  }

  release(rt: T): void {
    this.outstanding -= 1;
    if (this.disposed || this.sizeOf.get(rt) !== `${this.width}x${this.height}`) {
      this.destroyRt(rt);
      return;
    }
    this.free.push(rt);
  }

  /// Composition resize: every pooled texture is stale. Frees the free list
  /// now; outstanding textures are destroyed as they come back (size check
  /// in `release`).
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.drain();
  }

  /// Destroy the free list (suspend / project unload) — the pool stays
  /// usable and re-fills on demand.
  drain(): void {
    for (const rt of this.free.splice(0)) this.destroyRt(rt);
  }

  dispose(): void {
    this.disposed = true;
    this.drain();
  }

  /// Accounting probe for tests + the perf HUD's pool instrumentation
  /// (`created` stuck flat across a playback window == no per-frame allocation).
  stats(): { free: number; outstanding: number; created: number; destroyed: number } {
    return {
      free: this.free.length,
      outstanding: this.outstanding,
      created: this.createdCount,
      destroyed: this.destroyedCount,
    };
  }

  private destroyRt(rt: T): void {
    this.sizeOf.delete(rt);
    this.factory.destroy(rt);
    this.destroyedCount += 1;
  }
}
