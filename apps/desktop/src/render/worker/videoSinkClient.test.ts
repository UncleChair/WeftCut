import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoSinkClient } from "./videoSinkClient";

const HIGH_WATER = 32 * 1024 * 1024;

/// Minimal controllable WebSocket stand-in. The real client only touches
/// `binaryType`, `bufferedAmount`, `send`, `close`, and the `onopen`/
/// `onclose`/`onerror` handlers — tests fire those handlers by hand to drive
/// the connection state machine deterministically (no real socket, no I/O).
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }

  binaryType = "";
  bufferedAmount = 0;
  readonly url: string;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn<(data: unknown) => void>();
  close = vi.fn<(code?: number, reason?: string) => void>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

/// Resolve `connect()` by firing the fake socket's `onopen` on the next tick.
async function connectOpened(): Promise<VideoSinkClient> {
  const p = VideoSinkClient.connect(9223, "TOK");
  // The fake WS was constructed synchronously inside connect().
  FakeWebSocket.last().onopen?.();
  return p;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("VideoSinkClient.connect", () => {
  it("opens, sets arraybuffer, sends the token first, then resolves", async () => {
    const p = VideoSinkClient.connect(9223, "TOK");
    const ws = FakeWebSocket.last();
    expect(ws.url).toBe("ws://127.0.0.1:9223");
    expect(ws.binaryType).toBe("arraybuffer");
    // Not resolved until onopen fires.
    ws.onopen?.();
    const client = await p;
    expect(client).toBeInstanceOf(VideoSinkClient);
    // Token text is the FIRST thing sent on the wire.
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith("TOK");
  });

  it("rejects + closes the socket on connect timeout", async () => {
    const p = VideoSinkClient.connect(9223, "TOK", 5000);
    const rejected = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(FakeWebSocket.last().close).toHaveBeenCalled();
  });

  it("rejects on a pre-open socket error", async () => {
    const p = VideoSinkClient.connect(9223, "TOK");
    const rejected = expect(p).rejects.toThrow(/connect failed/);
    FakeWebSocket.last().onerror?.();
    await rejected;
  });

  it("a post-open error does NOT reject connect (only marks the client dead)", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    // onerror is now the post-open handler; firing it must not throw here.
    expect(() => ws.onerror?.()).not.toThrow();
    // The deadness surfaces on the next write.
    await expect(client.write(new Uint8Array(4))).rejects.toThrow(/socket error/);
  });
});

describe("VideoSinkClient.write", () => {
  it("sends immediately when bufferedAmount is below the high-water mark", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    ws.bufferedAmount = HIGH_WATER - 1;
    const bytes = new Uint8Array([1, 2, 3]);
    await client.write(bytes);
    expect(ws.send).toHaveBeenCalledTimes(2); // token + this frame
    expect(ws.send).toHaveBeenLastCalledWith(bytes);
  });

  it("backpressures while bufferedAmount is over the mark, then sends once it drains", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    ws.bufferedAmount = HIGH_WATER + 1;
    const sendCallsBefore = ws.send.mock.calls.length;
    const wp = client.write(new Uint8Array(8));
    // One poll cycle with the buffer still full: no send yet.
    await vi.advanceTimersByTimeAsync(2);
    expect(ws.send.mock.calls.length).toBe(sendCallsBefore);
    // Buffer drains below the mark → next poll exits the loop and sends.
    ws.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(2);
    await wp;
    expect(ws.send.mock.calls.length).toBe(sendCallsBefore + 1);
  });

  it("throws (without sending) when the socket died while backpressured", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    ws.bufferedAmount = HIGH_WATER + 1;
    const sendCallsBefore = ws.send.mock.calls.length;
    const wp = client.write(new Uint8Array(8));
    // Register the rejection handler before advancing the clock so the
    // rejection is never momentarily unhandled.
    const rejected = expect(wp).rejects.toThrow(/closed \(code 1006\)/);
    // ffmpeg dies → TCP drop → CLOSED with a non-1000 code.
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(2);
    await rejected;
    expect(ws.send.mock.calls.length).toBe(sendCallsBefore);
  });
});

describe("VideoSinkClient.finish", () => {
  it("drains then closes 1000 (clean EOF)", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    ws.bufferedAmount = 100;
    const fp = client.finish();
    await vi.advanceTimersByTimeAsync(2); // still draining
    expect(ws.close).not.toHaveBeenCalled();
    ws.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(2);
    await fp;
    expect(ws.close).toHaveBeenCalledWith(1000);
  });

  it("throws and does NOT close 1000 if the socket died mid-drain", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    ws.bufferedAmount = 100;
    const fp = client.finish();
    const rejected = expect(fp).rejects.toThrow(/closed \(code 1011\)/);
    ws.onclose?.({ code: 1011 });
    await vi.advanceTimersByTimeAsync(2);
    await rejected;
    expect(ws.close).not.toHaveBeenCalledWith(1000);
  });
});

describe("VideoSinkClient.abort", () => {
  it("closes with 4000 and makes subsequent writes throw", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    client.abort();
    expect(ws.close).toHaveBeenCalledWith(4000, "cancelled");
    await expect(client.write(new Uint8Array(4))).rejects.toThrow(/aborted/);
  });

  it("is safe to call when the socket close() throws (already closed)", async () => {
    const client = await connectOpened();
    const ws = FakeWebSocket.last();
    ws.close.mockImplementationOnce(() => {
      throw new Error("already closed");
    });
    expect(() => client.abort()).not.toThrow();
  });
});
