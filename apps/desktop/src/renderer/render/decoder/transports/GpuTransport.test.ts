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

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe("GpuTransport", () => {
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
});
