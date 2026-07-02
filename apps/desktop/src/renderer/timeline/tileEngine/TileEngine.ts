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
  /// Extra `media:job_complete` kinds that also invalidate this producer's
  /// tiles — for producers whose pixels derive from another job's output
  /// (filmstrip tiles decode from the proxy the "proxy"/"quick_proxy" jobs
  /// produce). The waveform producer needs no entry: its own kind matches.
  invalidateOn?: string[];
  fetch(key: TileKey): Promise<T>;
  bytes(value: T): number;
  /// Called when an entry is evicted or invalidated. Use for ImageBitmap.close().
  dispose?(value: T): void;
  /// Called on invalidateMedia so producers can drop their own per-media state
  /// (e.g. cached level tables) — the engine only owns tile slots.
  invalidate?(mediaId: string): void;
}

export const DEFAULT_TILE_BUDGET_BYTES = 192 * 1024 * 1024;

/// A failed fetch parks the slot as `error`; `request()` retries it once this
/// cooldown has elapsed, so a transient failure (file mid-promote, ffmpeg
/// hiccup) heals without an invalidation, but a persistent one can't hot-loop.
export const ERROR_RETRY_COOLDOWN_MS = 5000;

function keyStr(k: TileKey): string {
  return `${k.mediaId} ${k.kind} ${k.lod} ${k.index}`;
}

interface Slot<T> {
  key: TileKey;
  entry: TileEntry<T>;
  bytes: number;
  /// Monotonic touch counter for LRU; also the request version for stale-drop.
  version: number;
  /// Set alongside an `error` entry; drives the ERROR_RETRY_COOLDOWN_MS gate.
  erroredAtMs?: number;
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
    // LRU-touch READY slots only. For a pending slot `version` is the in-flight
    // fetch's identity: bumping it here would make the eventual resolve look
    // stale and get dropped, wedging the tile as pending forever (a sibling
    // tile's arrival notify re-runs window assembly, which polls this slot
    // mid-flight). Eviction only ever considers ready slots, so pending slots
    // need no recency.
    if (slot.entry.state === "ready") slot.version = ++this.clock;
    return slot.entry as TileEntry<T>;
  }

  request(key: TileKey): void {
    const ks = keyStr(key);
    const existing = this.slots.get(ks);
    if (existing) {
      const { state } = existing.entry;
      // pending/ready always coalesce. not_ready is deliberately NOT
      // short-circuited — a later request() re-fetches it (e.g. after
      // invalidateMedia clears the slot, or a consumer explicit retry).
      // error also falls through once ERROR_RETRY_COOLDOWN_MS has elapsed, so
      // a transient failure heals on the next request() instead of wedging.
      if (state === "pending" || state === "ready") return;
      if (state === "error" && Date.now() - (existing.erroredAtMs ?? 0) < ERROR_RETRY_COOLDOWN_MS) {
        return;
      }
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
        if (message.includes("not_ready")) {
          slot.entry = { state: "not_ready" };
        } else {
          slot.entry = { state: "error", message };
          slot.erroredAtMs = Date.now();
        }
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
    this.producers.get(kind)?.invalidate?.(mediaId);
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

  /** Route one media:job_complete to every producer it invalidates. Exposed for
   *  tests — the bridge listener is inert under vitest. */
  handleJobComplete(mediaId: string, kind: string): void {
    for (const producer of this.producers.values()) {
      if (producer.kind === kind || producer.invalidateOn?.includes(kind)) {
        this.invalidateMedia(mediaId, producer.kind);
      }
    }
  }

  private async installJobListenerOnce(): Promise<void> {
    if (this.jobListenerInstalled) return;
    this.jobListenerInstalled = true;
    try {
      await listen<{ media_id: string; kind: string }>(
        MEDIA_JOB_EVENTS.complete,
        (event) => {
          const kind = event.payload?.kind;
          const mediaId = event.payload?.media_id;
          if (!kind || !mediaId) return;
          this.handleJobComplete(mediaId, kind);
        },
      );
    } catch {
      // Bridge unavailable (non-Electron: Vitest / headless / SSR). The renderer
      // always has window.api, so this only trips in tests — job-complete
      // auto-invalidation is simply inert there.
    }
  }
}

export const tileEngine = new TileEngine();
