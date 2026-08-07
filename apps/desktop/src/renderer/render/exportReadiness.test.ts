import { describe, it, expect, vi } from "vitest";
import {
  sourcesNeedingPreflight,
  sourcesNeedingPreviewProbe,
  prepareExportMedia,
  waitForProxies,
  createConformTracker,
  ExportCancelled,
  ExportProxyFailed,
  type ProbeState,
} from "./exportReadiness";
import { MEDIA_JOB_EVENTS, type MediaSummary } from "../ipc";

// Route helpers, named for the readiness state they encode.
const directExport = (quick: string | null = null) =>
  ({ route: "direct-export", quick_proxy: quick }) as const;
const bypass = { route: "bypass" } as const;
const proxied = (over: { quick_proxy?: string | null; full_proxy?: string | null } = {}) =>
  ({ route: "proxied", quick_proxy: over.quick_proxy ?? null, full_proxy: over.full_proxy ?? null, format_version: 1 }) as const;

const vid = (over: Record<string, unknown>) => ({
  id: "m", label: "clip", kind: "Video", path: "/o.mov",
  decode_route: proxied(), // proxied, nothing ready (the common "not yet" default)
  width: 1920, height: 1080,
  ...over,
} as unknown);

describe("sourcesNeedingPreflight", () => {
  it("selects DirectExport-from-original video sources only", () => {
    const pool = new Map<string, any>([
      ["m1", vid({ id: "m1", decode_route: directExport() })],
      ["m2", vid({ id: "m2", decode_route: bypass })],
      ["m3", vid({ id: "m3", decode_route: proxied({ full_proxy: "/p.mp4" }) })], // has a master ⇒ proxied, not direct
      ["m4", vid({ id: "m4", kind: "Audio", decode_route: bypass })],
    ]);
    expect(sourcesNeedingPreflight(pool as any).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("sourcesNeedingPreviewProbe", () => {
  const v = (over: Partial<MediaSummary>): MediaSummary =>
    ({
      id: over.id ?? "m",
      kind: "Video",
      label: "",
      path: "/o.mp4",
      available: true,
      decode_route: proxied(), // proxied, nothing ready
      codec: "hevc",
      pix_fmt: "yuv420p",
      ...over,
    }) as MediaSummary;

  const map = (...items: MediaSummary[]) =>
    new Map(items.map((m) => [m.id, m]));

  it("includes a would-be-blank DirectExport source", () => {
    const out = sourcesNeedingPreviewProbe(map(v({ id: "a", decode_route: directExport() })));
    expect(out.map((m) => m.id)).toEqual(["a"]);
  });

  it("includes a would-be-blank full-proxy/10-bit source (not just DirectExport)", () => {
    const out = sourcesNeedingPreviewProbe(map(v({ id: "b", pix_fmt: "yuv420p10le" })));
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  it("excludes sources that already have a preview path or are bypassed", () => {
    const out = sourcesNeedingPreviewProbe(
      map(
        v({ id: "q", decode_route: proxied({ quick_proxy: "/q.mp4" }) }),
        v({ id: "dq", decode_route: directExport("/q.mp4") }),
        v({ id: "byp", decode_route: bypass }),
        v({ id: "gone", available: false }),
      ),
    );
    expect(out).toEqual([]);
  });
});

describe("prepareExportMedia", () => {
  const deps = (over: Partial<Parameters<typeof prepareExportMedia>[1]> = {}) => ({
    probe: vi.fn().mockResolvedValue("ok"),
    ensureFullProxy: vi.fn().mockResolvedValue(undefined),
    proxyStateOf: () => undefined,
    urlForOriginal: (m: any) => `weftcut-media://${m.id}`,
    memo: new Map<string, ProbeState>(),
    ...over,
  });

  it("ready: a landed master or a bypass original needs nothing", async () => {
    const d = deps();
    const r = await prepareExportMedia(
      [vid({ id: "p", decode_route: proxied({ full_proxy: "/p.mp4" }) }), vid({ id: "b", decode_route: bypass })] as any,
      d,
    );
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("decodable DirectExport source probes once and proceeds (export from original)", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue("ok") });
    const r = await prepareExportMedia([vid({ id: "ok", decode_route: directExport() })] as any, d);
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.probe).toHaveBeenCalledTimes(1);
    expect(d.memo.get("ok")).toBe("ok");
  });

  it("memo skips re-probing a known-decodable source", async () => {
    const memo = new Map<string, ProbeState>([["ok", "ok"]]);
    const d = deps({ memo, probe: vi.fn() });
    const r = await prepareExportMedia([vid({ id: "ok", decode_route: directExport() })] as any, d);
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it("definitively unsupported DirectExport source route-corrects and waits", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue("unsupported") });
    const r = await prepareExportMedia([vid({ id: "bad", decode_route: directExport() })] as any, d);
    expect(r.waiting).toEqual(["bad"]);
    expect(r.failed).toEqual([]);
    expect(d.ensureFullProxy).toHaveBeenCalledWith("bad");
  });

  // A transient failure (probe deadline on a loaded machine) must not demote a
  // decodable source onto its lossy proxy — the CI shape: cold decoders lose
  // the 2.5s race, every export silently consumed proxy quality (SSIM ~0.67).
  it("transient 'unknown' verdict exports the original and leaves no memo", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue("unknown") });
    const r = await prepareExportMedia([vid({ id: "busy", decode_route: directExport() })] as any, d);
    expect(r).toEqual({ waiting: [], failed: [] });
    expect(d.ensureFullProxy).not.toHaveBeenCalled();
    expect(d.memo.has("busy")).toBe(false); // next export re-probes
  });

  it("encoding-in-flight source (Proxied, no master, proxyState pending) waits; failed source fails", async () => {
    const d = deps({ proxyStateOf: (id: string) => (id === "f" ? "failed" : "pending") });
    const r = await prepareExportMedia(
      [vid({ id: "w" }), vid({ id: "f" })] as any, // both: Proxied with no master yet
      d,
    );
    expect(r.waiting).toEqual(["w"]);
    expect(r.failed).toEqual(["f"]);
    expect(d.probe).not.toHaveBeenCalled();
  });
});

describe("waitForProxies", () => {
  const makeDeps = () => {
    let storeCb: (() => void) | null = null;
    let errCb: ((id: string) => void) | null = null;
    const ready = new Set<string>();
    return {
      ready,
      fire: () => storeCb?.(),
      failOne: (id: string) => errCb?.(id),
      deps: {
        pathReady: (id: string) => ready.has(id),
        subscribeStore: (cb: () => void) => { storeCb = cb; return () => { storeCb = null; }; },
        onProxyError: (cb: (id: string) => void) => { errCb = cb; return () => { errCb = null; }; },
        signal: new AbortController().signal,
      },
    };
  };

  it("resolves immediately when all paths already ready", async () => {
    const h = makeDeps();
    h.ready.add("a");
    await expect(waitForProxies(["a"], h.deps)).resolves.toBeUndefined();
  });

  it("resolves once the store reflects every export path", async () => {
    const h = makeDeps();
    const p = waitForProxies(["a", "b"], h.deps);
    h.ready.add("a"); h.fire();
    h.ready.add("b"); h.fire();
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects with ExportProxyFailed when a pending proxy errors", async () => {
    const h = makeDeps();
    const p = waitForProxies(["a"], h.deps);
    h.failOne("a");
    await expect(p).rejects.toBeInstanceOf(ExportProxyFailed);
  });

  it("rejects with ExportCancelled when the signal aborts", async () => {
    const ctrl = new AbortController();
    const h = makeDeps();
    const deps = { ...h.deps, signal: ctrl.signal };
    const p = waitForProxies(["a"], deps);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(ExportCancelled);
  });
});

describe("createConformTracker", () => {
  /// Fake `listen`: records handlers by event name; `emit` drives them.
  const makeListen = () => {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    const listen = (<T,>(event: string, cb: (e: { payload: T }) => void) => {
      handlers.set(event, cb as (e: { payload: unknown }) => void);
      return Promise.resolve(unlisten);
    }) as Parameters<typeof createConformTracker>[0];
    const emit = (event: string, payload: unknown) =>
      handlers.get(event)?.({ payload });
    return { listen, emit, unlisten };
  };
  const complete = (id: string) => ({ media_id: id, kind: "conform" });
  const errored = (id: string) => ({ media_id: id, kind: "conform" });
  const signal = () => new AbortController().signal;

  it("resolves once every waited id lands a conform completion", async () => {
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    const p = t.waitFor(["a", "b"], signal());
    h.emit(MEDIA_JOB_EVENTS.complete, complete("a"));
    h.emit(MEDIA_JOB_EVENTS.complete, complete("b"));
    await expect(p).resolves.toBeUndefined();
    t.dispose();
  });

  it("counts completions that arrived before waitFor was called", async () => {
    // The readiness command returns AFTER jobs are enqueued; a fast conform
    // can land between the command and the wait. Registration happens at
    // tracker creation, so that completion must still count.
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    h.emit(MEDIA_JOB_EVENTS.complete, complete("a"));
    await expect(t.waitFor(["a"], signal())).resolves.toBeUndefined();
    t.dispose();
  });

  it("ignores non-conform job kinds", async () => {
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    const p = t.waitFor(["a"], signal());
    let settled = false;
    void p.then(() => { settled = true; });
    h.emit(MEDIA_JOB_EVENTS.complete, { media_id: "a", kind: "proxy" });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.emit(MEDIA_JOB_EVENTS.complete, complete("a"));
    await expect(p).resolves.toBeUndefined();
    t.dispose();
  });

  it("rejects ExportProxyFailed when a pending id's conform errors", async () => {
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    const p = t.waitFor(["a"], signal());
    h.emit(MEDIA_JOB_EVENTS.error, errored("a"));
    await expect(p).rejects.toBeInstanceOf(ExportProxyFailed);
    t.dispose();
  });

  it("an error for an id that already completed is ignored", async () => {
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    h.emit(MEDIA_JOB_EVENTS.complete, complete("a"));
    h.emit(MEDIA_JOB_EVENTS.error, errored("a"));
    await expect(t.waitFor(["a"], signal())).resolves.toBeUndefined();
    t.dispose();
  });

  it("rejects ExportCancelled when the signal aborts", async () => {
    const ctrl = new AbortController();
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    const p = t.waitFor(["a"], ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(ExportCancelled);
    t.dispose();
  });

  it("dispose unsubscribes both listeners", async () => {
    const h = makeListen();
    const t = createConformTracker(h.listen);
    await t.ready;
    t.dispose();
    expect(h.unlisten).toHaveBeenCalledTimes(2);
  });
});
