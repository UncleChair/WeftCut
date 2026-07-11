import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hwEligibleCodec,
  kickSwProbe,
  laneStatesFor,
  markDowngraded,
  resetDecodeCapabilitySession,
  setSwLane,
} from "./decodeCapability";
import { resolveEngineTier, type EngineInputs } from "./decodeEngine";

// Task 19: the HW-lane codec allow-list. The one-frame HW probe tests
// decode-viability, not seek-survival, so eligibility is gated by this static
// seek-validated set (8-bit H.264/HEVC/VP9) — NOT by the probe alone. This is
// what stops MPEG-2 (which some drivers HW-decode) from promoting to tier 1
// where a backward seek hangs.
describe("hwEligibleCodec", () => {
  it("admits 8-bit H.264 / HEVC / VP9", () => {
    expect(hwEligibleCodec("h264", "yuv420p")).toBe(true);
    expect(hwEligibleCodec("hevc", "yuv420p")).toBe(true);
    expect(hwEligibleCodec("vp9", "yuv420p")).toBe(true);
  });

  it("rejects out-of-scope codecs (MPEG-2, AV1) regardless of pixel format", () => {
    // MPEG-2 is the production hang: driver HW-decodes it, one-frame probe
    // passes, backward seek wedges — must never reach the HW lane.
    expect(hwEligibleCodec("mpeg2video", "yuv420p")).toBe(false);
    expect(hwEligibleCodec("av1", "yuv420p")).toBe(false);
    expect(hwEligibleCodec("prores", "yuv422p10le")).toBe(false);
  });

  it("rejects a 10-bit pixel format even for an in-scope codec", () => {
    expect(hwEligibleCodec("hevc", "yuv420p10le")).toBe(false);
    expect(hwEligibleCodec("hevc", "P010")).toBe(false); // case-insensitive
    expect(hwEligibleCodec("h264", "yuv420p10le")).toBe(false);
  });

  it("rejects a null codec (audio/image — no HW video lane)", () => {
    expect(hwEligibleCodec(null, "yuv420p")).toBe(false);
    expect(hwEligibleCodec(null, null)).toBe(false);
  });

  it("admits an in-scope codec with an unknown (null) pixel format", () => {
    // A null pix_fmt is not a KNOWN 10-bit tag, so it isn't excluded here; the
    // resolution/format-class probe still guards the actual open.
    expect(hwEligibleCodec("h264", null)).toBe(true);
  });
});

// D3 renderer-side loop (Task 14): kickSwProbe closes the probe→setSwLane→
// onSettled rhythm without touching `window` — the injectable `probeFn`
// mirrors `loadNativeDecodeWith`'s seam so these run under plain vitest.

describe("kickSwProbe", () => {
  it("single-flight: two rapid kicks for the same media call the probe once and settle once, landing ok", async () => {
    resetDecodeCapabilitySession();
    let calls = 0;
    const probeFn = async (_p: string) => {
      calls++;
      return { ok: true, classKey: "k", reason: null };
    };
    const settled = vi.fn();
    kickSwProbe("m1", "C:/a.mov", settled, probeFn);
    kickSwProbe("m1", "C:/a.mov", settled, probeFn); // deduped while in flight
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(calls).toBe(1);
    expect(
      laneStatesFor("m1", { decode_route: { route: "proxied" } }).nativeSw,
    ).toBe("ok");
  });

  it("a failing probe sets the lane to fail and still settles", async () => {
    resetDecodeCapabilitySession();
    const settled = vi.fn();
    kickSwProbe("m2", "C:/b.mov", settled, async () => ({
      ok: false,
      classKey: null,
      reason: "unsupported",
    }));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(
      laneStatesFor("m2", { decode_route: { route: "proxied" } }).nativeSw,
    ).toBe("fail");
  });

  it("a rejecting probe is treated as fail (never leaves the lane untested)", async () => {
    resetDecodeCapabilitySession();
    const settled = vi.fn();
    kickSwProbe("m3", "C:/c.mov", settled, async () => {
      throw new Error("probe crashed");
    });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(
      laneStatesFor("m3", { decode_route: { route: "proxied" } }).nativeSw,
    ).toBe("fail");
  });

  it("does not re-kick once the lane already holds a verdict", async () => {
    resetDecodeCapabilitySession();
    setSwLane("m4", "ok");
    const probeFn = vi.fn(async () => ({ ok: false, classKey: null, reason: null }));
    const settled = vi.fn();
    kickSwProbe("m4", "C:/d.mov", settled, probeFn);
    expect(probeFn).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });
});

// Task 18: the sticky per-source runtime downgrade. The two native handles'
// `onFatalError` surface (NativeGpuSourceHandle / SwSourceHandle) calls
// `markDowngraded` when a native lane dies at runtime (GPU decode error,
// device loss, session crash, or the `hw-budget-exceeded` open throw from
// Task 17's `MAX_HW_SESSIONS` cap). This closes the loop end to end at the
// resolver: marker -> `laneStatesFor`'s live `downgraded` set -> the pure
// `resolveEngineTier` skipping that tier for the rest of the session — the
// exact effect the Compositor's next `ensureClip` observes and rides via the
// key-based no-flash swap onto the next tier.
describe("markDowngraded -> resolveEngineTier (resolver-visible sticky downgrade)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a runtime downgrade of native-hw makes the resolver fall through to the next usable tier", () => {
    // `markDowngraded` LogBus-emits via `logEmit` (fire-and-forget); stub
    // `window.api.backend.invoke` so that doesn't reject in this plain
    // (non-jsdom) vitest environment — mirrors bridge/metrics.test.ts's
    // `vi.stubGlobal` pattern rather than switching the whole file to jsdom.
    vi.stubGlobal("window", {
      api: { backend: { invoke: vi.fn().mockResolvedValue(undefined) } },
    });
    resetDecodeCapabilitySession();

    markDowngraded("m1", "native-hw", "boom");

    const lanes = laneStatesFor("m1", { decode_route: { route: "bypass" } }, true);
    expect(lanes.downgraded.has("native-hw")).toBe(true);

    const inputs: EngineInputs = {
      setting: "auto",
      componentAvailable: true,
      media: { path: "C:/src/a.mov", decode_route: { route: "bypass" } as never },
      webcodecsOriginal: "ok",
      nativeHw: "ok", // would win tier 1 if it weren't downgraded
      nativeSw: "untested",
      downgraded: lanes.downgraded,
      proxyPreviewPath: null,
    };
    const r = resolveEngineTier(inputs);

    expect(r.tier).toBe("webcodecs-original");
    expect(r.reason).toContain("downgraded");
  });
});
