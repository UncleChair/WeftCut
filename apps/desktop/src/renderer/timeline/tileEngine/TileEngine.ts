import { listen } from "@/bridge/events";
import { MEDIA_JOB_EVENTS } from "../../ipc";

export interface TileKey {
  mediaId: string;
  kind: string;
  lod: number;
  index: number;
}

export type TileEntry<T> =
  | { state: "pending" }
  | { state: "ready"; value: T }
  | { state: "not_ready" }
  | { state: "error"; message: string };

export interface TileProducer<T> {
  /// Matches `media:job_complete.kind` and `TileKey.kind`.
  kind: string;
  fetch(key: TileKey): Promise<T>;
  bytes(value: T): number;
  /// Called when an entry is evicted or invalidated. Use for ImageBitmap.close().
  dispose?(value: T): void;
}

export const DEFAULT_TILE_BUDGET_BYTES = 192 * 1024 * 1024;

function keyStr(k: TileKey): string {
  return `${k.mediaId} ${k.kind} ${k.lod} ${k.index}`;
}

interface Slot<T> {
  key: TileKey;
  entry: TileEntry<T>;
  bytes: number;
  /// Monotonic touch counter for LRU; also the request version for stale-drop.
  version: number;
}

export class TileEngine {
  private producers = new Map<string, TileProducer<unknown>>();
  private slots = new Map<string, Slot<unknown>>();
  private listeners = new Map<string, Set<() => void>>();
  private totalBytes = 0;
  private clock = 0;
  private jobListenerInstalled = false;

  constructor(private budgetBytes = DEFAULT_TILE_BUDGET_BYTES) {
    void this.installJobListenerOnce();
  }

  register<T>(producer: TileProducer<T>): void {
    this.producers.set(producer.kind, producer as TileProducer<unknown>);
  }

  get<T>(key: TileKey): TileEntry<T> | undefined {
    const slot = this.slots.get(keyStr(key));
    if (!slot) return undefined;
    slot.version = ++this.clock; // touch for LRU
    return slot.entry as TileEntry<T>;
  }

  request(key: TileKey): void {
    const ks = keyStr(key);
    const existing = this.slots.get(ks);
    if (existing && (existing.entry.state === "pending" || existing.entry.state === "ready" || existing.entry.state === "error")) {
      return; // coalesce: pending/ready/error slots are left as-is. not_ready is deliberately
      // NOT short-circuited — a later request() re-fetches it (e.g. after invalidateMedia
      // clears the slot, or a consumer explicit retry).
    }
    const producer = this.producers.get(key.kind);
    if (!producer) return;
    const version = ++this.clock;
    this.slots.set(ks, { key, entry: { state: "pending" }, bytes: 0, version });
    producer
      .fetch(key)
      .then((value) => {
        const slot = this.slots.get(ks);
        if (!slot || slot.version !== version) {
          // Stale: a newer request/invalidation replaced this slot. Drop, but
          // dispose the just-fetched value so we don't leak it.
          producer.dispose?.(value);
          return;
        }
        const bytes = producer.bytes(value);
        slot.entry = { state: "ready", value };
        slot.bytes = bytes;
        this.totalBytes += bytes;
        this.evictToBudget(ks);
        this.notify(key.mediaId);
      })
      .catch((e: unknown) => {
        const slot = this.slots.get(ks);
        if (!slot || slot.version !== version) return;
        const message = typeof e === "string" ? e : String(e);
        slot.entry = message.includes("not_ready")
          ? { state: "not_ready" }
          : { state: "error", message };
        this.notify(key.mediaId);
      });
  }

  subscribe(mediaId: string, cb: () => void): () => void {
    let set = this.listeners.get(mediaId);
    if (!set) { set = new Set(); this.listeners.set(mediaId, set); }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.listeners.delete(mediaId);
    };
  }

  invalidateMedia(mediaId: string, kind: string): void {
    for (const [ks, slot] of this.slots) {
      if (slot.key.mediaId === mediaId && slot.key.kind === kind) {
        this.freeSlot(ks, slot);
      }
    }
    this.notify(mediaId);
  }

  private freeSlot(ks: string, slot: Slot<unknown>): void {
    if (slot.entry.state === "ready") {
      this.producers.get(slot.key.kind)?.dispose?.(slot.entry.value);
      this.totalBytes -= slot.bytes;
    }
    this.slots.delete(ks);
  }

  private evictToBudget(protectKs: string): void {
    if (this.totalBytes <= this.budgetBytes) return;
    const ready = [...this.slots.entries()]
      .filter(([ks, s]) => ks !== protectKs && s.entry.state === "ready")
      .sort((a, b) => a[1].version - b[1].version); // oldest touch first
    for (const [ks, slot] of ready) {
      if (this.totalBytes <= this.budgetBytes) break;
      this.freeSlot(ks, slot);
    }
  }

  private notify(mediaId: string): void {
    this.listeners.get(mediaId)?.forEach((cb) => cb());
  }

  private async installJobListenerOnce(): Promise<void> {
    if (this.jobListenerInstalled) return;
    this.jobListenerInstalled = true;
    await listen<{ media_id: string; kind: string }>(
      MEDIA_JOB_EVENTS.complete,
      (event) => {
        const kind = event.payload?.kind;
        const mediaId = event.payload?.media_id;
        if (!kind || !mediaId) return;
        // Only kinds that map to a registered producer are ours.
        if (!this.producers.has(kind)) return;
        this.invalidateMedia(mediaId, kind);
      },
    );
  }
}

export const tileEngine = new TileEngine();
