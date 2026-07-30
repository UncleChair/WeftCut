import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioView } from "../../ipc";
import type { AudioGraph } from "./AudioGraph";

const conform = vi.hoisted(() => {
  interface PendingRead {
    resolve: () => void;
    reject: () => void;
  }
  return {
    pending: [] as PendingRead[],
    /// When set, `ConformSource.open` parks on it — lets a test land dispose()
    /// inside the open's in-flight window.
    openGate: null as Promise<void> | null,
  };
});

vi.mock("./conformSource", () => ({
  ConformSource: class {
    readonly header = { channels: 1 };

    static async open(): Promise<unknown> {
      if (conform.openGate) await conform.openGate;
      return new this();
    }

    readWindow(
      _startFrame: number,
      frameCount: number,
    ): Promise<Float32Array<ArrayBuffer>[]> {
      return new Promise((resolve, reject) => {
        conform.pending.push({
          resolve: () =>
            resolve([
              new Float32Array(
                new ArrayBuffer(frameCount * Float32Array.BYTES_PER_ELEMENT),
              ),
            ]),
          reject: () => reject(new Error("controlled stale read failure")),
        });
      });
    }
  },
}));

import { AudioMixer } from "./AudioMixer";

class FakeAudioParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  setValueCurveAtTime = vi.fn();
}

class FakeNode {
  gain = new FakeAudioParam();
  connected = false;
  connect = vi.fn(() => {
    this.connected = true;
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });
}

class FakeBuffer {
  copyToChannel = vi.fn();
}

class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start = vi.fn(() => {
    this.started = true;
  });
  stop = vi.fn(() => {
    this.stopped = true;
  });
}

class FakeAudioContext {
  currentTime = 10;
  readonly sources: FakeBufferSource[] = [];

  createGain = (): FakeNode => new FakeNode();
  createChannelMerger = (): FakeNode => new FakeNode();
  createChannelSplitter = (): FakeNode => new FakeNode();
  createBuffer = (): FakeBuffer => new FakeBuffer();
  createBufferSource = (): FakeBufferSource => {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  };
}

const view: AudioView = {
  media_id: "media",
  media_label: "media",
  src_in_us: 0,
  src_out_us: 1_000_000,
  gain_db: { mode: "Static", value: 0 },
  pan: { mode: "Static", value: 0 },
  fade_in_us: 0,
  fade_out_us: 0,
  mute: false,
  role: "dialogue",
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createMixer(): { ctx: FakeAudioContext; mixer: AudioMixer } {
  const ctx = new FakeAudioContext();
  const graph = {
    ctx,
    input: new FakeNode(),
    resume: vi.fn(async () => {}),
  } as unknown as AudioGraph;
  const mixer = new AudioMixer(
    {
      layerId: "layer",
      conformUrl: "weftcut-media://audio.conform",
      view,
      layerTStartUs: 0,
      layerTEndUs: 1_000_000,
    },
    graph,
  );
  return { ctx, mixer };
}

afterEach(() => {
  conform.pending.length = 0;
  conform.openGate = null;
  vi.restoreAllMocks();
});

describe("AudioMixer dispose racing the conform open", () => {
  it("a dispose during the conform fetch must not resurrect the mixer", async () => {
    // The ctor fires `openSource` and the conform header fetch can outlive the
    // layer that asked for it (delete an Audio layer within the fetch's
    // latency). Before the disposed latch, the continuation re-assigned
    // `source` and rebuilt + reconnected a pan graph on the severed output —
    // leaked AudioNodes, and a disposed mixer one stray tick away from
    // scheduling audio out of a dead object.
    let releaseOpen!: () => void;
    conform.openGate = new Promise<void>((r) => { releaseOpen = r; });
    const { mixer } = createMixer();
    mixer.dispose(); // open still in flight
    releaseOpen();
    await flush();
    // A resurrected source would schedule reads; a disposed mixer stays inert.
    mixer.tick(0, true, 1_000_000, { compUs: 0, ctxTime: 10 });
    expect(conform.pending).toHaveLength(0);
  });
});

describe("AudioMixer seek scheduling", () => {
  it.each(["resolves", "rejects"] as const)(
    "keeps the current chunk reserved when a stale read %s after seek",
    async (staleOutcome) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ctx, mixer } = createMixer();
      await flush();

      mixer.tick(0, true, 1_000_000, { compUs: 0, ctxTime: 10 });
      expect(conform.pending).toHaveLength(1);

      const anchorAfterSeek = { compUs: 100_000, ctxTime: 10 };
      mixer.tick(100_000, true, 1_000_000, anchorAfterSeek);
      expect(conform.pending).toHaveLength(2);

      conform.pending[0]![staleOutcome === "resolves" ? "resolve" : "reject"]();
      await flush();

      // A render tick lands while the replacement read is still pending.
      // A stale completion must not release that replacement's reservation.
      mixer.tick(100_000, true, 1_000_000, anchorAfterSeek);

      // Resolve every current-generation read. The buggy implementation
      // launched two of them, producing two simultaneously audible nodes.
      for (const read of conform.pending.slice(1)) read.resolve();
      await flush();

      const audible = ctx.sources.filter(
        (source) => source.started && !source.stopped && source.connected,
      );
      expect(audible).toHaveLength(1);
      expect(conform.pending).toHaveLength(2);
    },
  );
});
