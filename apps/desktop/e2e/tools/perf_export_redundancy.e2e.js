import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

// MEASUREMENT TOOL (non-gating): export decode-dispatch ratios across the
// timeline shapes the roadmap's "export decode redundancy" entry worries
// about, post phase-keyed pipelines. Each scenario logs
// dispatched/totalFrames from __weftcutExportPerf next to its inherent
// floor; the only assertions are completion (a wedge should still fail
// loudly). Fixture GOP layout: keys at 0s and 8.333s (keyint 250), so a
// mid-GOP entry pays a long prefix by construction.
//
//   S1 baseline      one clip [0,10s)                  floor 300/300 = 1.00x
//   S2 replay        + copy at t=10s (phase -10s)      floor 600/~600 = 1.00x
//   S3 offset-2s     + copy at t=2s (phase -2s)        floor 600/360 = 1.67x
//   S4 range 5..10s  one clip, export range [5s,10s)   floor 300/150 = 2.00x
//                    (GOP prefix from key@0 — the inherent mid-GOP cost)
const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-redundancy-proj");
const OUT = (name) => path.resolve(os.tmpdir(), `weftcut-e2e-redundancy-${name}.mp4`);

async function bootProject(namePrefix) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
  );
  const name = namePrefix + Date.now();
  const r1 = await browser.executeAsync((parent, projName, done) => {
    window.__weftcutTest
      .newProjectAndEnter({
        parentFolder: parent,
        name: projName,
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, PROJECT_PARENT, name);
  if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.exportTimeline === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "exportTimeline never mounted" },
  );
}

async function placeClips(extraStartsUs) {
  const r = await browser.executeAsync((media, extras, done) => {
    (async () => {
      const first = await window.__weftcutTest.importAndPlaceMedia({
        mediaAbsPath: media,
        tStartUs: 0,
      });
      for (const tStartUs of extras) {
        await window.__weftcutTest.placeMediaLayer({
          mediaId: first.mediaId,
          tStartUs,
        });
      }
      await window.__weftcutTest.waitMediaExportReady({ mediaId: first.mediaId });
    })()
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, SOURCE, extraStartsUs);
  if (!r.ok) throw new Error("placing clips failed: " + r.error);
}

async function runExport(output, range) {
  rmSync(output, { force: true });
  await browser.execute(
    (out, rng) => {
      window.__e2eExportDone = null;
      window.__weftcutExportPerf = null;
      const args = { outputAbsPath: out };
      if (rng) args.range = rng;
      window.__weftcutTest
        .exportTimeline(args)
        .then(() => {
          window.__e2eExportDone = { ok: true };
        })
        .catch((e) => {
          window.__e2eExportDone = { ok: false, error: String(e) };
        });
    },
    output,
    range ?? null,
  );

  let lastFrame = -1;
  let settled = null;
  try {
    await browser.waitUntil(
      async () => {
        const snap = await browser.execute(() => ({
          done: window.__e2eExportDone,
          frame: window.__weftcutExportState?.progress?.frame ?? null,
        }));
        if (snap.frame != null) lastFrame = snap.frame;
        if (snap.done) {
          settled = snap.done;
          return true;
        }
        return false;
      },
      { timeout: 170000, interval: 1000 },
    );
  } catch (e) {
    throw new Error(`export never settled (last frame=${lastFrame}): ${e.message}`);
  }
  if (!settled.ok) throw new Error("exportTimeline failed: " + settled.error);
  const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
  if (!perf) throw new Error("export settled but __weftcutExportPerf is missing");
  return perf;
}

describe("export decode-dispatch measurement (non-gating)", function () {
  const rows = [];

  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[perf] SKIP: source media not found at ${SOURCE}`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  after(function () {
    if (rows.length === 0) return;
    console.log("[perf] ===== export decode-dispatch summary =====");
    for (const r of rows) {
      console.log(
        `[perf] ${r.name.padEnd(12)} dispatched=${String(r.dispatched).padStart(5)} ` +
          `frames=${String(r.frames).padStart(4)} ratio=${(r.dispatched / r.frames).toFixed(2)}x ` +
          `(floor ${r.floor}) decode=${r.decodeMs}ms wait=${r.waitMs}ms total=${r.totalMs}ms`,
      );
    }
  });

  it("S1 baseline: one clip", async () => {
    await bootProject("perf-s1-");
    await placeClips([]);
    const p = await runExport(OUT("s1"));
    rows.push({ name: "S1 baseline", dispatched: p.totalDispatched, frames: p.totalFrames, floor: "1.00x", decodeMs: p.decodeMs, waitMs: p.waitMs, totalMs: p.totalMs });
  });

  it("S2 replay: second copy at t=10s (sequential source re-use)", async () => {
    await bootProject("perf-s2-");
    await placeClips([10_000_000]);
    const p = await runExport(OUT("s2"));
    rows.push({ name: "S2 replay", dispatched: p.totalDispatched, frames: p.totalFrames, floor: "1.00x", decodeMs: p.decodeMs, waitMs: p.waitMs, totalMs: p.totalMs });
  });

  it("S3 offset: second copy at t=2s (different-phase overlap)", async () => {
    await bootProject("perf-s3-");
    await placeClips([2_000_000]);
    const p = await runExport(OUT("s3"));
    rows.push({ name: "S3 offset-2s", dispatched: p.totalDispatched, frames: p.totalFrames, floor: "1.67x", decodeMs: p.decodeMs, waitMs: p.waitMs, totalMs: p.totalMs });
  });

  it("S4 range export [5s,10s): mid-GOP entry pays the key@0 prefix", async () => {
    await bootProject("perf-s4-");
    await placeClips([]);
    const p = await runExport(OUT("s4"), { startUs: 5_000_000, endUs: 10_000_000 });
    rows.push({ name: "S4 range-tail", dispatched: p.totalDispatched, frames: p.totalFrames, floor: "2.00x", decodeMs: p.decodeMs, waitMs: p.waitMs, totalMs: p.totalMs });
  });
});
