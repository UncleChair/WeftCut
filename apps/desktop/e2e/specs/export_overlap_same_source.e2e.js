import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

// Same-source overlap export gate. Two enabled VideoClips of ONE mediaId
// overlapping on the timeline used to freeze the export frame counter
// mid-run: the export Worker keys decoder handles by mediaId, so both clips
// acquired the SAME handle and raced it —
//
//   - concurrent `decodeRange` calls per chunk interleaved their packet
//     feeds (and a lower-pts range mid-feed reads as a backward jump →
//     decoder reset under the other clip's in-flight dispatch loop), and
//   - the per-frame evict used each clip's OWN next-frame cutoff, so the
//     clip ahead in source time evicted frames the clip behind still
//     needed — its `waitForPts` then waited forever.
//
// The audio-engine specs dodged this by disabling the extra copies' video
// layers (see e2eHook `exportClip`); this spec is the gate for the real
// thing. Three scenarios on the burned-in-counter fixture:
//
//   1. baseline — one clip, the dispatch-count reference.
//   2. stacked — a second enabled copy at the SAME t. Identical per-chunk
//      ranges must be merged into one decode (completion + no extra
//      dispatch vs baseline).
//   3. offset — a second enabled copy 2 s later (the A/B-roll shape). The
//      clips want source times 2 s apart, so their per-chunk ranges
//      overlap but differ; both must decode their OWN frames (completion +
//      shifted alignment in the offset clip's exclusive region).
const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-overlap-proj");
const OUT_BASELINE = path.resolve(os.tmpdir(), "weftcut-e2e-overlap-baseline.mp4");
const OUT_STACKED = path.resolve(os.tmpdir(), "weftcut-e2e-overlap-stacked.mp4");
const OUT_OFFSET = path.resolve(os.tmpdir(), "weftcut-e2e-overlap-offset.mp4");

const SSIM_FLOOR = 0.8;
/// 2 s at the fixture's 30 fps — the offset scenario's placement shift.
const OFFSET_US = 2_000_000;
const OFFSET_FRAMES = 60;

/// Boot a fresh 1080p30 project under PROJECT_PARENT and wait for the editor
/// hooks to mount.
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
    { timeout: 30000, timeoutMsg: "exportTimeline never mounted (editor didn't load?)" },
  );
}

/// Import SOURCE once, place it at t=0, then place `extraStartsUs` more copies
/// of the SAME mediaId (one fresh track each), and wait for export readiness.
async function placeSameSourceClips(extraStartsUs) {
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
      return first.mediaId;
    })()
      .then((mediaId) => done({ ok: true, mediaId }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, SOURCE, extraStartsUs);
  if (!r.ok) throw new Error("placing clips failed: " + r.error);
  return r.mediaId;
}

/// Fire-and-forget `exportTimeline`, then poll the mirrored frame counter to
/// settlement — a regression hang reports its exact stall frame (the wedge
/// class pins the counter instead of erroring).
async function runTimelineExport(output, timeout = 170000) {
  rmSync(output, { force: true });
  await browser.execute((out) => {
    window.__e2eExportDone = null;
    window.__weftcutExportPerf = null;
    window.__weftcutTest
      .exportTimeline({ outputAbsPath: out })
      .then(() => {
        window.__e2eExportDone = { ok: true };
      })
      .catch((e) => {
        window.__e2eExportDone = { ok: false, error: String(e) };
      });
  }, output);

  let lastFrame = -1;
  let lastKind = null;
  let settled = null;
  try {
    await browser.waitUntil(
      async () => {
        const snap = await browser.execute(() => {
          const st = window.__weftcutExportState;
          return {
            done: window.__e2eExportDone,
            kind: st?.kind ?? null,
            frame: st?.progress?.frame ?? null,
          };
        });
        if (snap.frame != null && snap.frame !== lastFrame) {
          lastFrame = snap.frame;
        }
        if (snap.kind != null) lastKind = snap.kind;
        if (snap.done) {
          settled = snap.done;
          return true;
        }
        return false;
      },
      { timeout, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `export never settled (last kind=${lastKind}, last frame=${lastFrame}): ${e.message}`,
    );
  }
  if (!settled.ok) throw new Error("exportTimeline failed: " + settled.error);

  const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
  if (!perf) throw new Error("export settled but __weftcutExportPerf is missing");
  console.log(
    `[e2e] export perf: dispatched=${perf.totalDispatched} for ${perf.totalFrames} frames ` +
      `(${(perf.totalDispatched / Math.max(1, perf.totalFrames)).toFixed(2)}x) | ` +
      `decode=${perf.decodeMs}ms wait=${perf.waitMs}ms total=${perf.totalMs}ms`,
  );
  return perf;
}

function assertIdentityAligned(report) {
  const misaligned = report.samples.filter((s) => !s.aligned);
  if (misaligned.length > 0) {
    throw new Error(
      "frames not aligned: " +
        JSON.stringify(
          misaligned.map((s) => ({ index: s.index, best: s.best_match_index, ssim: s.ssim })),
        ),
    );
  }
  const lowSsim = report.samples.filter((s) => s.ssim < SSIM_FLOOR);
  if (lowSsim.length > 0) {
    throw new Error(
      `SSIM below ${SSIM_FLOOR}: ` +
        JSON.stringify(lowSsim.map((s) => ({ index: s.index, ssim: Number(s.ssim.toFixed(4)) }))),
    );
  }
}

describe("same-source overlapping clips export (real WebView2)", function () {
  /// Dispatch-count reference from the single-clip baseline run; the stacked
  /// scenario asserts against it. Mocha runs the its in order.
  let baselineDispatched = null;

  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP: source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("baseline: a single clip exports clean (dispatch reference)", async () => {
    await bootProject("e2e-overlap-base-");
    await placeSameSourceClips([]);
    const perf = await runTimelineExport(OUT_BASELINE);

    if (perf.totalFrames !== 300) {
      throw new Error(`expected 300 planned frames (10s @ 30fps), got ${perf.totalFrames}`);
    }
    baselineDispatched = perf.totalDispatched;

    const report = analyze({
      output: OUT_BASELINE,
      source: SOURCE,
      samples: [30, 150, 290],
      ssimMin: SSIM_FLOOR,
    });
    console.log("[e2e] baseline conformance report:", JSON.stringify(report));
    assertIdentityAligned(report);
  });

  it("two stacked enabled clips of one source export without wedging or extra decode", async () => {
    await bootProject("e2e-overlap-stack-");
    await placeSameSourceClips([0]);
    const perf = await runTimelineExport(OUT_STACKED);

    // Both copies span [0, 10s) — the composition stays 300 frames.
    if (perf.totalFrames !== 300) {
      throw new Error(`expected 300 planned frames, got ${perf.totalFrames}`);
    }

    // Output must still be the source, frame-for-frame (a stacked copy is
    // visually idempotent) — this catches the stale/garbage-frame corruption
    // class, not just the freeze.
    const report = analyze({
      output: OUT_STACKED,
      source: SOURCE,
      samples: [30, 150, 290],
      ssimMin: SSIM_FLOOR,
    });
    console.log("[e2e] stacked conformance report:", JSON.stringify(report));
    assertIdentityAligned(report);

    // The decode-redundancy half of the gate: identical per-chunk ranges of
    // one source must be served by ONE merged decode, so a stacked copy costs
    // (almost) nothing. Pre-merge this is ~2x baseline.
    if (baselineDispatched == null) {
      throw new Error("baseline dispatch reference missing (did the baseline test run?)");
    }
    const ceiling = Math.ceil(baselineDispatched * 1.25);
    if (perf.totalDispatched > ceiling) {
      throw new Error(
        `stacked export dispatched ${perf.totalDispatched} packets — over the ` +
          `${ceiling} ceiling (1.25x the single-clip baseline ${baselineDispatched}); ` +
          `the same-source ranges were not merged`,
      );
    }
  });

  it("a 2s-offset overlap of one source exports complete with both clips on their own frames", async function () {
    // The shifted-alignment check below best-matches across a ±62-frame
    // window (125 ffmpeg frame extractions, ~1-2 min) on top of the export
    // itself — the suite-wide 180 s mocha timeout is too tight for this one
    // test. The export stall detector stays at 170 s inside
    // runTimelineExport; this only buys the analyzer time.
    this.timeout(330000);
    await bootProject("e2e-overlap-offset-");
    await placeSameSourceClips([OFFSET_US]);
    const perf = await runTimelineExport(OUT_OFFSET);

    // The offset copy runs [2s, 12s) — composition autofits to 12s = 360
    // frames.
    if (perf.totalFrames !== 360) {
      throw new Error(`expected 360 planned frames (12s composition), got ${perf.totalFrames}`);
    }

    // [0, 2s): only the t=0 clip is live — identity alignment.
    const headReport = analyze({
      output: OUT_OFFSET,
      source: SOURCE,
      samples: [30],
      ssimMin: SSIM_FLOOR,
    });
    console.log("[e2e] offset head conformance report:", JSON.stringify(headReport));
    assertIdentityAligned(headReport);

    // Overlap region [2s, 10s): the offset clip sits on the LATER track and
    // renders on top, so output frame n carries ITS source frame n-60 —
    // shifted alignment here proves the offset clip decoded its OWN frames
    // rather than stale ones from the other clip's range. An overlap-region
    // sample (not one from the [10s, 12s) exclusive tail) keeps the widened
    // best-match window inside the source's 300 frames; identity-ssim is
    // meaningless under the shift, so assert only the match index.
    const tail = analyze({
      output: OUT_OFFSET,
      source: SOURCE,
      samples: [200],
      window: OFFSET_FRAMES + 2,
    });
    const s = tail.samples[0];
    console.log("[e2e] offset overlap-region sample:", JSON.stringify(s));
    if (s.best_match_index !== 200 - OFFSET_FRAMES) {
      throw new Error(
        `offset clip misaligned: output frame 200 best-matches source ` +
          `${s.best_match_index}, expected ${200 - OFFSET_FRAMES}`,
      );
    }
  });
});
