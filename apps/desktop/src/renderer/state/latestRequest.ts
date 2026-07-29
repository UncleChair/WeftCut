/// Coordinates async reads that publish a snapshot into persistent UI state.
///
/// Issuing a request immediately makes every earlier request stale. This is
/// deliberately stronger than comparing against the last response that
/// finished: an older response must not publish even while the newest request
/// is still pending.
export class LatestRequestCoordinator {
  private generation = 0;

  async run<T>(
    load: () => Promise<T>,
    publish: (value: T) => void,
    reject?: (error: unknown) => void,
  ): Promise<boolean> {
    const requestGeneration = ++this.generation;

    let value: T;
    try {
      value = await load();
    } catch (error) {
      if (requestGeneration !== this.generation) return false;
      if (reject) {
        reject(error);
        return true;
      }
      throw error;
    }

    if (requestGeneration !== this.generation) return false;
    publish(value);
    return true;
  }

  /// Prevent pending work from publishing, typically during teardown.
  invalidate(): void {
    this.generation += 1;
  }
}
