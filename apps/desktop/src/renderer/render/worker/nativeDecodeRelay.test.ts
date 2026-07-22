// Unit tests for the Worker-side native-decode relay, driven through its
// PUBLIC message-listener seam: a stubbed Worker `self` (addEventListener
// capture + postMessage recorder) stands in for the real Worker global, and
// synthetic MessageEvents play the renderer main thread. The point is to pin
// what the single-channel design promises at THIS seam:
//   1. inbound `nd:*` messages reach the registered sink in EXACT arrival
//      order — frames and control signals share one ordered queue, the in-band
//      guarantee the export tail depends on (an `ended` overtaking its tail
//      frames would corrupt the export);
//   2. demux by sessionId is airtight (unknown/foreign messages never cross,
//      never throw) and `nd:openResult` correlates strictly by reqId; and
//   3. outbound commands post the exact ExportEvent shapes runExport forwards
//      to `window.api.exportSw.*`.
// The relay is a LAZY module singleton (its class is deliberately unexported),
// so each test resets the module registry and re-imports to bind a fresh
// instance to the current `self` stub.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeDecodeRelayClient, NativeDecodeSink } from "./nativeDecodeRelay";
import type { ExportEvent, ExportRequest, NativeDecodeFrameMsg } from "./protocol";

/// Minimal Worker-global stand-in. The relay subscribes via `addEventListener`
/// (never `self.onmessage` — exportWorker.ts owns that) and emits via
/// `self.postMessage`; nothing else of `self` is touched.
class SelfStub {
  listeners: Array<(e: MessageEvent) => void> = [];
  posted: unknown[] = [];
  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    if (type === "message") this.listeners.push(cb);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
}

let stub: SelfStub;
let savedSelfDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  // Install the stub BEFORE the relay is constructed (its constructor wires
  // the message listener), and reset the module registry so this test's
  // dynamic import builds a fresh singleton bound to THIS stub.
  savedSelfDesc = Object.getOwnPropertyDescriptor(globalThis, "self");
  stub = new SelfStub();
  Object.defineProperty(globalThis, "self", {
    value: stub,
    configurable: true,
    writable: true,
  });
  vi.resetModules();
});

afterEach(() => {
  // Restore whatever `self` was (absent in node) so other suites see a clean
  // global.
  if (savedSelfDesc) Object.defineProperty(globalThis, "self", savedSelfDesc);
  else delete (globalThis as { self?: unknown }).self;
});

async function makeRelay(): Promise<NativeDecodeRelayClient> {
  const mod = await import("./nativeDecodeRelay");
  return mod.getNativeDecodeRelay();
}

/// Play one renderer-main → Worker message into the relay's captured listener.
function dispatch(data: ExportRequest): void {
  for (const cb of stub.listeners) cb({ data } as MessageEvent);
}

function frameMsg(sessionId: string, ptsUs: number): NativeDecodeFrameMsg {
  return {
    sessionId,
    ptsUs,
    durUs: 33_333,
    width: 4,
    height: 2,
    format: "NV12",
    data: new ArrayBuffer(12),
  };
}

/// Sink whose every callback appends to one shared log — the unified record
/// that makes cross-kind ordering observable.
function loggingSink(log: string[], tag = ""): NativeDecodeSink {
  return {
    onFrame: (f) => log.push(`${tag}frame@${f.ptsUs}`),
    onRangeEnd: (aUs, bUs) => log.push(`${tag}rangeEnd[${aUs}..${bUs}]`),
    onEnded: () => log.push(`${tag}ended`),
    onError: (m) => log.push(`${tag}error:${m}`),
  };
}

describe("NativeDecodeRelay", () => {
  it("delivers interleaved frames and control signals in exact arrival order", async () => {
    const relay = await makeRelay();
    const log: string[] = [];
    relay.register("s", loggingSink(log));
    dispatch({ type: "nd:frame", frame: frameMsg("s", 0) });
    dispatch({ type: "nd:frame", frame: frameMsg("s", 33_333) });
    dispatch({ type: "nd:ended", sessionId: "s" });
    dispatch({ type: "nd:rangeEnd", sessionId: "s", aUs: 0, bUs: 500_000 });
    expect(log).toEqual(["frame@0", "frame@33333", "ended", "rangeEnd[0..500000]"]);
  });

  it("demuxes by sessionId — each sink sees only its own frames and controls", async () => {
    const relay = await makeRelay();
    const logA: string[] = [];
    const logB: string[] = [];
    relay.register("a", loggingSink(logA, "a:"));
    relay.register("b", loggingSink(logB, "b:"));
    dispatch({ type: "nd:frame", frame: frameMsg("a", 0) });
    dispatch({ type: "nd:frame", frame: frameMsg("b", 100) });
    dispatch({ type: "nd:rangeEnd", sessionId: "a", aUs: 0, bUs: 500_000 });
    dispatch({ type: "nd:error", sessionId: "b", message: "boom" });
    dispatch({ type: "nd:ended", sessionId: "a" });
    expect(logA).toEqual(["a:frame@0", "a:rangeEnd[0..500000]", "a:ended"]);
    expect(logB).toEqual(["b:frame@100", "b:error:boom"]);
  });

  it("drops unknown-session and foreign-protocol messages without throwing", async () => {
    const relay = await makeRelay();
    const log: string[] = [];
    relay.register("known", loggingSink(log));
    expect(() => {
      dispatch({ type: "nd:frame", frame: frameMsg("ghost", 0) });
      dispatch({ type: "nd:rangeEnd", sessionId: "ghost", aUs: 0, bUs: 500_000 });
      dispatch({ type: "nd:ended", sessionId: "ghost" });
      dispatch({ type: "nd:error", sessionId: "ghost", message: "boom" });
      // An openResult with no pending reqId is likewise ignored.
      dispatch({
        type: "nd:openResult",
        reqId: 999,
        ok: true,
        info: { width: 4, height: 2, startPtsUs: 0 },
      });
      // The Worker's own protocol shares the channel; the relay must ignore it.
      dispatch({ type: "cancel" });
      dispatch({ type: "chunk-ack" });
    }).not.toThrow();
    expect(log).toEqual([]);
  });

  it("unregister stops delivery to that session's sink", async () => {
    const relay = await makeRelay();
    const log: string[] = [];
    relay.register("s", loggingSink(log));
    dispatch({ type: "nd:frame", frame: frameMsg("s", 0) });
    relay.unregister("s");
    dispatch({ type: "nd:frame", frame: frameMsg("s", 33_333) });
    dispatch({ type: "nd:rangeEnd", sessionId: "s", aUs: 0, bUs: 500_000 });
    expect(log).toEqual(["frame@0"]);
  });

  it("nd:openResult resolves/rejects the matching pending open by reqId", async () => {
    const relay = await makeRelay();
    const p1 = relay.open("s1", "C:/orig/a.mov", "NV12", 6);
    const p2 = relay.open("s2", "C:/orig/b.mov", "NV12", 6);
    const opens = stub.posted.filter(
      (m): m is Extract<ExportEvent, { type: "nd:open" }> =>
        (m as { type?: string }).type === "nd:open",
    );
    expect(opens).toHaveLength(2);
    expect(opens[0]!.reqId).not.toBe(opens[1]!.reqId);
    const info = { width: 4, height: 2, startPtsUs: 0 };
    // Answer the SECOND open first — correlation is by reqId, not call order.
    dispatch({ type: "nd:openResult", reqId: opens[1]!.reqId, ok: true, info });
    await expect(p2).resolves.toEqual(info);
    dispatch({ type: "nd:openResult", reqId: opens[0]!.reqId, ok: false, error: "no decoder" });
    await expect(p1).rejects.toThrow("no decoder");
  });

  it("posts the exact ExportEvent shapes for outbound commands", async () => {
    const relay = await makeRelay();
    // Never answered in this test — the pending open just parks, no rejection.
    void relay.open("s", "C:/orig/tiny.mov", "NV12", 6);
    relay.decodeRange("s", 0, 500_000);
    relay.returnCredit("s", 3);
    relay.close("s");
    expect(stub.posted).toEqual([
      {
        type: "nd:open",
        reqId: expect.any(Number),
        sessionId: "s",
        path: "C:/orig/tiny.mov",
        outFormat: "NV12",
        creditWindow: 6,
      },
      { type: "nd:decodeRange", sessionId: "s", aUs: 0, bUs: 500_000 },
      { type: "nd:returnCredit", sessionId: "s", credits: 3 },
      { type: "nd:close", sessionId: "s" },
    ]);
  });
});
