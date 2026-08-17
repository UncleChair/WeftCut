// Protocol seam coverage for the Motif params page host. The "page" here is a
// scripted sender, not a real iframe: the adapter is deliberately
// iframe-agnostic, so every verb can be driven by handing it message events.
//
// The load-bearing claims pinned here are the two the preview lane exists for:
// a drag burst produces ZERO commits and a BOUNDED number of overlay updates
// (each one costs a ~80-100ms serialized CDP recapture), and a gesture end
// produces EXACTLY ONE commit even when it lands several keys at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MotifManifest } from "../render/motifs/catalog";
import {
  motifPreviewProps,
  resetMotifPreview,
  subscribeMotifPreview,
} from "../render/motifs/previewOverlay";
import {
  clampParamsHeight,
  createMotifParamsHost,
  parseParamsPageMessage,
  PARAMS_MAX_HEIGHT_PX,
  PARAMS_MIN_HEIGHT_PX,
  PREVIEW_THROTTLE_MS,
  type MotifParamsHost,
  type MotifParamsHostMessage,
} from "./motifParamsHost";

const MANIFEST: MotifManifest = {
  id: "paramful",
  name: "Paramful",
  version: 1,
  size: [640, 360],
  default_duration_s: 5,
  status: "installed",
  props_schema: {
    title: { type: "string", default: "Hello" },
    bg_color: { type: "color", default: "#000000" },
    speed: { type: "number", default: 1, min: 0, max: 4 },
    effect: { type: "enum", default: "karaoke", options: ["typewriter", "karaoke"] },
  },
};

const LAYER_ID = "layer-1";

/// Stands in for the frame's `contentWindow` — identity is the whole point, so
/// an empty object is enough.
const pageWindow = {} as Window;
const otherWindow = {} as Window;

let host: MotifParamsHost;
let posted: MotifParamsHostMessage[];
let commits: Record<string, unknown>[];
let heights: number[];
let committedProps: Record<string, unknown>;
/// Overlay change notifications = recapture triggers (PixiPreview recomposites
/// on each one), so counting them counts recaptures.
let overlayTicks: number;
let unsubscribe: () => void;

function send(data: unknown, source: Window = pageWindow): void {
  host.handleMessage({ data, source });
}

beforeEach(() => {
  vi.useFakeTimers();
  posted = [];
  commits = [];
  heights = [];
  overlayTicks = 0;
  committedProps = { title: "Hello", bg_color: "#000000", speed: 1, effect: "karaoke" };
  unsubscribe = subscribeMotifPreview(() => {
    overlayTicks += 1;
  });
  host = createMotifParamsHost({
    layerId: LAYER_ID,
    motifId: MANIFEST.id,
    manifest: () => MANIFEST,
    props: () => committedProps,
    frameWindow: () => pageWindow,
    post: (m) => posted.push(m),
    commit: async (patch) => {
      commits.push(patch);
      committedProps = { ...committedProps, ...patch };
    },
    setHeight: (px) => heights.push(px),
    locale: () => "zh-CN",
    themeTokens: () => ({ "--background": "#0c0e12" }),
  });
});

afterEach(() => {
  host.dispose();
  unsubscribe();
  resetMotifPreview();
  vi.useRealTimers();
});

describe("init", () => {
  it("posts props, schema, locale and theme tokens", () => {
    host.sendInit();
    expect(posted).toHaveLength(1);
    const init = posted[0]!;
    expect(init.type).toBe("motif:init");
    if (init.type !== "motif:init") throw new Error("unreachable");
    expect(init.motifId).toBe("paramful");
    expect(init.layerId).toBe(LAYER_ID);
    expect(init.props).toEqual(committedProps);
    expect(init.schema).toBe(MANIFEST.props_schema);
    expect(init.locale).toBe("zh-CN");
    expect(init.themeTokens).toEqual({ "--background": "#0c0e12" });
  });

  it("canonicalizes leniently so a stale stored prop reaches the page as its default", () => {
    committedProps = { title: "Hi", speed: "not-a-number", ghost: 1 };
    host.sendInit();
    const init = posted[0]!;
    if (init.type !== "motif:init") throw new Error("unreachable");
    expect(init.props).toEqual({ bg_color: "#000000", effect: "karaoke", speed: 1, title: "Hi" });
  });
});

describe("preview", () => {
  it("a burst commits nothing, updates the overlay, and stays bounded", () => {
    for (let i = 0; i < 12; i++) send({ type: "motif:preview", props: { speed: 1 + i * 0.1 } });
    // Leading edge applied immediately; the other 11 coalesced.
    expect(overlayTicks).toBe(1);
    expect(motifPreviewProps(LAYER_ID)).toEqual({ speed: 1 });

    vi.advanceTimersByTime(PREVIEW_THROTTLE_MS);
    // One trailing flush carrying the LAST value of the burst.
    expect(overlayTicks).toBe(2);
    expect(motifPreviewProps(LAYER_ID)?.speed).toBeCloseTo(2.1, 6);

    // The window closes with nothing queued — no further work, and above all
    // no project traffic at any point.
    vi.advanceTimersByTime(PREVIEW_THROTTLE_MS * 4);
    expect(overlayTicks).toBe(2);
    expect(commits).toEqual([]);
  });

  it("re-sending the same value does not tick the overlay again", () => {
    send({ type: "motif:preview", props: { speed: 2 } });
    expect(overlayTicks).toBe(1);
    vi.advanceTimersByTime(PREVIEW_THROTTLE_MS * 2);
    send({ type: "motif:preview", props: { speed: 2 } });
    expect(overlayTicks).toBe(1);
  });

  it("carries several keys and drops values the schema can't hold", () => {
    send({
      type: "motif:preview",
      props: { title: "Live", speed: 99, unknown_key: 1 },
    });
    // `speed` is out of range → lenient fallback to its default; the unknown
    // key never enters the overlay at all.
    expect(motifPreviewProps(LAYER_ID)).toEqual({ title: "Live", speed: 1 });
  });

  it("a preview naming only unknown keys is a no-op", () => {
    send({ type: "motif:preview", props: { nope: 1 } });
    expect(overlayTicks).toBe(0);
    expect(motifPreviewProps(LAYER_ID)).toBeNull();
  });
});

describe("commit", () => {
  it("lands a multi-key patch as exactly one call and clears the overlay", async () => {
    send({ type: "motif:preview", props: { title: "Draft" } });
    expect(motifPreviewProps(LAYER_ID)).toEqual({ title: "Draft" });

    send({ type: "motif:commit", props: { title: "Final", bg_color: "#ff3366" } });
    expect(commits).toEqual([{ title: "Final", bg_color: "#ff3366" }]);
    expect(commits).toHaveLength(1);

    // The overlay is held until the mutation settles, so the canvas never
    // flashes the pre-commit frame during the round-trip.
    await vi.runAllTimersAsync();
    expect(motifPreviewProps(LAYER_ID)).toBeNull();
  });

  it("a committed key supersedes its queued preview but leaves other keys dragging", async () => {
    send({ type: "motif:preview", props: { speed: 2 } }); // leading
    send({ type: "motif:preview", props: { speed: 3, title: "Typing" } }); // queued
    send({ type: "motif:commit", props: { speed: 4 } });
    await vi.runAllTimersAsync();
    expect(commits).toEqual([{ speed: 4 }]);
    // `speed` gone (committed), `title` still pending from the queued preview.
    expect(motifPreviewProps(LAYER_ID)).toEqual({ title: "Typing" });
  });

  it("a commit of only unknown keys reaches the backend not at all", () => {
    send({ type: "motif:commit", props: { ghost: 1 } });
    expect(commits).toEqual([]);
  });

  it("clears the overlay even when the mutation is refused", async () => {
    const failing = createMotifParamsHost({
      layerId: "layer-2",
      motifId: MANIFEST.id,
      manifest: () => MANIFEST,
      props: () => committedProps,
      frameWindow: () => pageWindow,
      post: () => undefined,
      commit: () => Promise.reject(new Error("refused")),
      setHeight: () => undefined,
      locale: () => "en-US",
      themeTokens: () => ({}),
    });
    failing.handleMessage({ data: { type: "motif:preview", props: { speed: 2 } }, source: pageWindow });
    failing.handleMessage({ data: { type: "motif:commit", props: { speed: 3 } }, source: pageWindow });
    await vi.runAllTimersAsync();
    expect(motifPreviewProps("layer-2")).toBeNull();
    failing.dispose();
  });
});

describe("propsChanged", () => {
  it("pushes fresh props on an external change", () => {
    host.sendInit();
    posted.length = 0;
    host.syncProps({ ...committedProps, title: "Undone" });
    expect(posted).toHaveLength(1);
    const msg = posted[0]!;
    if (msg.type !== "motif:propsChanged") throw new Error("unreachable");
    expect(msg.props.title).toBe("Undone");
  });

  it("does not echo the page's own commit back at it", async () => {
    host.sendInit();
    posted.length = 0;
    send({ type: "motif:commit", props: { title: "Final" } });
    await vi.runAllTimersAsync();
    // The round-trip arrives carrying exactly what the page asked for.
    host.syncProps(committedProps);
    expect(posted).toEqual([]);
    // A genuine change after it still gets through.
    host.syncProps({ ...committedProps, title: "From an agent" });
    expect(posted).toHaveLength(1);
  });

  it("stays quiet when the props are unchanged (the panel re-renders constantly)", () => {
    host.sendInit();
    posted.length = 0;
    host.syncProps({ ...committedProps });
    host.syncProps({ ...committedProps });
    expect(posted).toEqual([]);
  });
});

describe("resize", () => {
  it("clamps at both ends and rounds", () => {
    send({ type: "motif:resize", height: 0 });
    send({ type: "motif:resize", height: 10_000 });
    send({ type: "motif:resize", height: 321.4 });
    expect(heights).toEqual([PARAMS_MIN_HEIGHT_PX, PARAMS_MAX_HEIGHT_PX, 321]);
  });

  it("clampParamsHeight is total over hostile input", () => {
    expect(clampParamsHeight(-1e9)).toBe(PARAMS_MIN_HEIGHT_PX);
    expect(clampParamsHeight(PARAMS_MIN_HEIGHT_PX)).toBe(PARAMS_MIN_HEIGHT_PX);
    expect(clampParamsHeight(PARAMS_MAX_HEIGHT_PX)).toBe(PARAMS_MAX_HEIGHT_PX);
  });
});

describe("hostile and malformed traffic", () => {
  it("ignores messages from any window that is not the frame", () => {
    send({ type: "motif:commit", props: { title: "Injected" } }, otherWindow);
    send({ type: "motif:preview", props: { title: "Injected" } }, otherWindow);
    send({ type: "motif:resize", height: 500 }, otherWindow);
    expect(commits).toEqual([]);
    expect(heights).toEqual([]);
    expect(motifPreviewProps(LAYER_ID)).toBeNull();
  });

  it("ignores garbage payloads", () => {
    for (const data of [
      null,
      undefined,
      "motif:commit",
      42,
      [],
      { type: 7 },
      { type: "motif:commit" },
      { type: "motif:commit", props: null },
      { type: "motif:preview", props: ["speed", 2] },
      { type: "motif:resize", height: Number.NaN },
      { type: "motif:resize", height: "tall" },
      { type: "motif:unknown", props: { title: "x" } },
      { type: "webpackHotUpdate" },
    ]) {
      send(data);
    }
    expect(commits).toEqual([]);
    expect(heights).toEqual([]);
    expect(motifPreviewProps(LAYER_ID)).toBeNull();
    expect(overlayTicks).toBe(0);
  });

  it("parseParamsPageMessage accepts only the five known shapes", () => {
    expect(parseParamsPageMessage({ type: "motif:preview", props: {} })).toEqual({
      type: "preview",
      props: {},
    });
    expect(parseParamsPageMessage({ type: "motif:commit", props: { a: 1 } })).toEqual({
      type: "commit",
      props: { a: 1 },
    });
    expect(parseParamsPageMessage({ type: "motif:resize", height: 100 })).toEqual({
      type: "resize",
      height: 100,
    });
    expect(parseParamsPageMessage({ type: "motif:init", props: {} })).toBeNull();
  });
});

describe("dispose", () => {
  it("drops the pending overlay and stops the throttle", () => {
    send({ type: "motif:preview", props: { speed: 2 } });
    send({ type: "motif:preview", props: { speed: 3 } });
    host.dispose();
    expect(motifPreviewProps(LAYER_ID)).toBeNull();
    const ticksAfterDispose = overlayTicks;
    vi.advanceTimersByTime(PREVIEW_THROTTLE_MS * 4);
    expect(overlayTicks).toBe(ticksAfterDispose);
    // A late message from a page that hasn't torn down yet is inert.
    send({ type: "motif:commit", props: { title: "Too late" } });
    expect(commits).toEqual([]);
  });
});
