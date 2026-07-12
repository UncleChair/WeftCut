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

/// Builds a mocked `window.api.previewGpu` whose `requestPort()` synthesizes
/// the preload's one-time port handoff synchronously (dispatched as a real
/// jsdom `MessageEvent` carrying a minimal fake `MessagePort`), and returns a
/// hook to grab that fake port so the test can push frame messages into it.
function installFakePreviewGpu() {
  let port: FakePort | null = null;
  const api = {
    requestPort: vi.fn(() => {
      port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { __weftcutPreviewGpu: "port" },
          ports: [port as unknown as MessagePort],
        }),
      );
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
  it("delivers frames stamped with its streamId and drops foreign ones", async () => {
    const { getPort } = installFakePreviewGpu();
    const t = new GpuTransport();
    const frames: number[] = [];
    t.onFrame((_b, ptsUs) => frames.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mp4" });
    const port = getPort();
    expect(port).not.toBeNull();

    port!.onmessage!({
      data: { kind: "frame", streamId: "s2", slot: 0, ptsUs: 10, durUs: 33, bitmap: makeFakeBitmap(1) },
    });
    port!.onmessage!({
      data: { kind: "frame", streamId: "s1", slot: 0, ptsUs: 20, durUs: 33, bitmap: makeFakeBitmap(2) },
    });

    expect(frames).toEqual([20]); // foreign s2 dropped
    t.dispose();
  });
});
