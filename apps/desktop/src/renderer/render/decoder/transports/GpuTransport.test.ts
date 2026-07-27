// @vitest-environment jsdom
//
// GpuTransport.test.ts — port handoff + streamId filtering, with
// `window.api.previewGpu` faked. Mirrors the FakePort + fake-bitmap approach
// the deleted native-GPU handle's test relied on (same environment, same
// helpers) rather than a real `MessageChannel`/`window.postMessage` transfer
// or a real `createImageBitmap`/`ImageData`: verified empirically that this
// repo's jsdom (25.0.1, via vitest 4.1.7) implements neither
// `createImageBitmap` nor `ImageData` as globals, and its `postMessage`
// does not populate `MessageEvent.ports` from a real transfer list — only
// a `MessageEvent` constructed directly with a `ports` init option carries
// them. The sibling test dispatches the handoff exactly that way and invokes
// the fake port's `onmessage` directly for frame delivery; this test does the
// same, preserving the same behavioral contract (streamId-stamped frame
// delivery, foreign-streamId frames dropped) the brief specifies.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GpuTransport } from "./GpuTransport";
import {
  setSlotFenceBackend,
  sharedSlotFenceQueue,
  type SlotFenceBackend,
} from "./slotFenceQueue";

interface FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
  close: () => void;
}

interface FakeBitmap extends ImageBitmap {
  tag: number;
}

function makeFakeBitmap(tag: number): FakeBitmap {
  return { width: 1, height: 1, close: vi.fn(), tag } as unknown as FakeBitmap;
}

/// Dispatch a port handoff the way the preload does: a broadcast
/// `window.postMessage` carrying the target `streamId` plus the port. Returns the
/// fake port so a test can push frame messages into it.
function dispatchHandoff(streamId: string): FakePort {
  const port: FakePort = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { __weftcutPreviewGpu: "port", streamId },
      ports: [port as unknown as MessagePort],
    }),
  );
  return port;
}

/// Builds a mocked `window.api.previewGpu` whose `requestPort(streamId)`
/// synthesizes the preload's per-stream port handoff synchronously (dispatched as
/// a real jsdom `MessageEvent` carrying a minimal fake `MessagePort`), and returns
/// a hook to grab that fake port so the test can push frame messages into it.
function installFakePreviewGpu() {
  let port: FakePort | null = null;
  const api = {
    requestPort: vi.fn((streamId: string) => {
      port = dispatchHandoff(streamId);
    }),
    open: vi.fn(async () => {}),
    requestFrameAt: vi.fn(async () => {}),
    close: vi.fn(() => {}),
  };
  (window as unknown as { api: { previewGpu: typeof api } }).api = { previewGpu: api };
  return { api, getPort: () => port };
}

/// A device stand-in for the shared slot-fence queue, with the completion signal
/// under the test's control. Installed on the module singleton (the real device
/// comes from the Pixi Application, which no unit test has) and removed after.
function installFakeSlotFenceDevice(): { signalAll: () => void } {
  const signals: (() => void)[] = [];
  const backend: SlotFenceBackend = {
    submit(_bmp, onSignal) {
      let done = false;
      signals.push(() => {
        done = true;
        onSignal();
      });
      return { signalled: () => done, dispose: () => {} };
    },
  };
  setSlotFenceBackend(backend);
  return {
    signalAll: () => {
      for (const s of signals) s();
    },
  };
}

/// One delegated frame message — what the preload posts under `rendererFence`:
/// no barrier stamps of its own, `ackDelegated` carrying the obligation.
function delegatedFrame(streamId: string, slot: number, ptsUs: number, bitmap: ImageBitmap) {
  return {
    kind: "frame",
    streamId,
    slot,
    ptsUs,
    durUs: 33,
    bitmap,
    gvfMs: 0.2,
    cibMs: 0.4,
    residentMs: 0.8,
    ackDelegated: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
  setSlotFenceBackend(null);
});

describe("GpuTransport", () => {
  it("forwards renderer-probed coded dimensions to main admission", async () => {
    const { api } = installFakePreviewGpu();
    const t = new GpuTransport();
    await t.open({
      streamId: "budget-size",
      path: "C:/x.mp4",
      codedWidth: 3840,
      codedHeight: 2160,
    });
    expect(api.open).toHaveBeenCalledWith({
      streamId: "budget-size",
      path: "C:/x.mp4",
      poolSize: 3,
      colorSpace: {
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        range: "limited",
      },
      codedWidth: 3840,
      codedHeight: 2160,
    });
    t.dispose();
  });

  it("requests its port BY streamId and delivers only its own frames", async () => {
    const { api, getPort } = installFakePreviewGpu();
    const t = new GpuTransport();
    const frames: number[] = [];
    t.onFrame((_b, ptsUs) => frames.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mp4" });
    // The port is per-stream: the request must name the stream it's for, or the
    // preload can't route that stream's frames to this channel.
    expect(api.requestPort).toHaveBeenCalledWith("s1");
    const port = getPort();
    expect(port).not.toBeNull();

    const foreign = makeFakeBitmap(1);
    port!.onmessage!({
      data: { kind: "frame", streamId: "s2", slot: 0, ptsUs: 10, durUs: 33, bitmap: foreign },
    });
    port!.onmessage!({
      data: { kind: "frame", streamId: "s1", slot: 0, ptsUs: 20, durUs: 33, bitmap: makeFakeBitmap(2) },
    });

    expect(frames).toEqual([20]); // foreign s2 dropped
    // ...and dropped WITHOUT leaking. A 4K ImageBitmap per foreign frame is not a
    // survivable leak, and the drop path used to just `return`.
    expect(foreign.close).toHaveBeenCalled();
    t.dispose();
  });

  it("ignores another stream's port handoff", async () => {
    // THE WEDGE REGRESSION. `window.postMessage` is a broadcast, so every live
    // transport sees every handoff. When this transport adopted a foreign handoff,
    // it re-pointed `this.port` (and its `onmessage`) at the newest session's
    // channel — so its own frames arrived at a handler that filtered them out by
    // streamId. Measured effect with 2+ concurrent 4K GPU sessions: every session
    // but the newest went permanently dark, rings frozen, picture stuck on a
    // 12-second-stale frame.
    const { getPort } = installFakePreviewGpu();
    const t = new GpuTransport();
    const frames: number[] = [];
    t.onFrame((_b, ptsUs) => frames.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mp4" });
    const mine = getPort()!;

    // A second session opens and its handoff broadcasts to us too.
    const theirs = dispatchHandoff("s2");
    expect(theirs.onmessage).toBeNull(); // we must not have claimed it

    // Our own port must still be the live one.
    mine.onmessage!({
      data: { kind: "frame", streamId: "s1", slot: 0, ptsUs: 40, durUs: 33, bitmap: makeFakeBitmap(3) },
    });
    expect(frames).toEqual([40]);
    t.dispose();
  });

  // ── rendererFence: the ack obligation crosses the port ──────────────────────
  //
  // Under this mode the preload runs no barrier and does NOT ack. The obligation
  // arrives with the bitmap, and `pool_size` unmet obligations wedge the session
  // for good — so these assert the OBLIGATION, not the timing.

  it("acks a delegated slot back up the port once the device signals", async () => {
    const { getPort } = installFakePreviewGpu();
    const device = installFakeSlotFenceDevice();
    const t = new GpuTransport();
    t.onFrame(() => {});
    await t.open({ streamId: "rf1", path: "C:/x.mp4" });
    const port = getPort()!;

    port.onmessage!({ data: delegatedFrame("rf1", 2, 10, makeFakeBitmap(1)) });
    // Deferred: nothing has completed yet, so the slot is still held.
    expect(port.postMessage).not.toHaveBeenCalled();

    device.signalAll();
    sharedSlotFenceQueue().drain();
    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "consumeAck",
      streamId: "rf1",
      slot: 2,
    });
    t.dispose();
  });

  // The sharp one. A frame the ring evicts, or one that arrives with nothing
  // subscribed, still holds a slot — so the ack may not be tied to paint.
  it("acks a delegated frame nothing ever painted", async () => {
    const { getPort } = installFakePreviewGpu();
    const device = installFakeSlotFenceDevice();
    const t = new GpuTransport();
    // Deliberately NO onFrame: nothing consumes, nothing paints.
    await t.open({ streamId: "rf2", path: "C:/x.mp4" });
    const port = getPort()!;

    port.onmessage!({ data: delegatedFrame("rf2", 1, 10, makeFakeBitmap(1)) });
    device.signalAll();
    sharedSlotFenceQueue().drain();

    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "consumeAck",
      streamId: "rf2",
      slot: 1,
    });
    t.dispose();
  });

  it("acks each delegated slot exactly once", async () => {
    const { getPort } = installFakePreviewGpu();
    const device = installFakeSlotFenceDevice();
    const t = new GpuTransport();
    t.onFrame(() => {});
    await t.open({ streamId: "rf3", path: "C:/x.mp4" });
    const port = getPort()!;

    for (let slot = 0; slot < 3; slot++) {
      port.onmessage!({ data: delegatedFrame("rf3", slot, slot * 33, makeFakeBitmap(slot)) });
    }
    device.signalAll();
    sharedSlotFenceQueue().drain();
    sharedSlotFenceQueue().drain();

    const acked = (port.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => (c[0] as { slot: number }).slot,
    );
    expect(acked.sort()).toEqual([0, 1, 2]);
    t.dispose();
  });

  // Teardown ordering from this side: dispose drops the pending slots before the
  // port goes and before main is asked to close, so a signal that lands after
  // teardown cannot ack into a session main is mid-closing.
  it("drops a disposed stream's pending slots without acking", async () => {
    const { getPort } = installFakePreviewGpu();
    const device = installFakeSlotFenceDevice();
    const t = new GpuTransport();
    t.onFrame(() => {});
    await t.open({ streamId: "rf4", path: "C:/x.mp4" });
    const port = getPort()!;
    port.onmessage!({ data: delegatedFrame("rf4", 0, 10, makeFakeBitmap(1)) });

    t.dispose();
    device.signalAll();
    sharedSlotFenceQueue().drain();

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(sharedSlotFenceQueue().pendingCount()).toBe(0);
  });

  // The applied mode must name what RAN here, not what the preload delegated: a
  // session with no device runs the fallback, and a leg that reported its label
  // would publish the fallback's behaviour under the fence's name.
  it("reports the barrier the renderer applied, not the delegation itself", async () => {
    const { getPort } = installFakePreviewGpu();
    const device = installFakeSlotFenceDevice();
    const t = new GpuTransport();
    t.onFrame(() => {});
    await t.open({ streamId: "rf5", path: "C:/x.mp4" });
    const port = getPort()!;
    port.onmessage!({ data: delegatedFrame("rf5", 0, 10, makeFakeBitmap(1)) });
    expect(t.handoffTimings()!.barrierModeObserved).toBe("rendererFence");
    device.signalAll();
    sharedSlotFenceQueue().drain();
    t.dispose();
  });

  it("does not report a fence when there is no device to take one on", async () => {
    const { getPort } = installFakePreviewGpu();
    // No device registered — jsdom has no OffscreenCanvas either, so the ladder
    // bottoms out and reports `none`, which is the correctness alarm.
    const t = new GpuTransport();
    t.onFrame(() => {});
    await t.open({ streamId: "rf6", path: "C:/x.mp4" });
    const port = getPort()!;
    port.onmessage!({ data: delegatedFrame("rf6", 0, 10, makeFakeBitmap(1)) });

    expect(t.handoffTimings()!.barrierModeObserved).not.toBe("rendererFence");
    // ...and the slot is still released, synchronously.
    expect(port.postMessage).toHaveBeenCalledWith({
      kind: "consumeAck",
      streamId: "rf6",
      slot: 0,
    });
    t.dispose();
  });

  // A non-delegated frame (every other barrier mode) must not touch the queue —
  // the preload already acked it, and a second ack frees a slot twice.
  it("never acks a frame the preload kept ownership of", async () => {
    const { getPort } = installFakePreviewGpu();
    installFakeSlotFenceDevice();
    const t = new GpuTransport();
    t.onFrame(() => {});
    await t.open({ streamId: "rf7", path: "C:/x.mp4" });
    const port = getPort()!;
    port.onmessage!({
      data: {
        kind: "frame",
        streamId: "rf7",
        slot: 0,
        ptsUs: 10,
        durUs: 33,
        bitmap: makeFakeBitmap(1),
        gvfMs: 0.2,
        cibMs: 0.4,
        residentMs: 20,
        barrierMs: 19,
        barrierDrawMs: 0.1,
        barrierReadMs: 18.9,
        barrierApplied: "readback",
      },
    });

    expect(port.postMessage).not.toHaveBeenCalled();
    expect(sharedSlotFenceQueue().pendingCount()).toBe(0);
    const s = t.handoffTimings()!;
    expect(s.barrierModeObserved).toBe("readback");
    expect(s.barrierP50).toBeCloseTo(19);
    t.dispose();
  });
});
