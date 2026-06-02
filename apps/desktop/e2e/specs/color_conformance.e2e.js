import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { analyzeColor } from "../lib/analyze.mjs";

const MEDIA =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const MANIFEST = path.resolve(MEDIA, "color_manifest.json");
const BASELINE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "color_baseline.json",
);
const PROJ = path.resolve(os.tmpdir(), "weftcut-e2e-color-proj");

// source matrix/range each encoding must be DECODED with (the gate asks: is the
// output, interpreted as the source's encoding, the same color as the source?).
const DECODE = {
  "709ltd": ["bt709", "tv"],
  "601ltd": ["smpte170m", "tv"],
  "709full": ["bt709", "pc"],
  "601full": ["smpte170m", "pc"],
};

// Guarded baseline load — absent until recorded from a real Stage-0/1 run.
const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : null;

describe("color round-trip conformance (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJ, { recursive: true });
  });

  for (const enc of Object.keys(DECODE)) {
    const source = path.resolve(MEDIA, `test_1080p_color_${enc}.mp4`);
    const output = path.resolve(os.tmpdir(), `weftcut-e2e-color-${enc}.mp4`);

    it(`${enc} round-trips within baseline`, async function () {
      if (!existsSync(source)) {
        console.warn(`[e2e] SKIP ${enc}: source fixture not found at ${source}`);
        this.skip();
      }
      if (!BASELINE || !BASELINE[enc]) {
        console.warn(
          `[e2e] SKIP ${enc}: baseline not recorded — run scripts/color-probe-export.mjs on a real ` +
            `export and record ${BASELINE_PATH} (per-encoding worst_app_max + a tolerance) first.`,
        );
        this.skip();
      }
      rmSync(output, { force: true });

      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
          )) === true,
        { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
      );
      const r1 = await browser.executeAsync((parent, done) => {
        window.__weftcutTest
          .newProjectAndEnter({
            parentFolder: parent,
            name: "e2e-color-" + Date.now(),
            canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
          })
          .then(() => done({ ok: true }))
          .catch((e) => done({ ok: false, error: String(e) }));
      }, PROJ);
      if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => typeof window.__weftcutTest?.exportClip === "function",
          )) === true,
        { timeout: 30000, timeoutMsg: "exportClip never mounted" },
      );

      await browser.execute(
        (media, out) => {
          window.__e2eExportDone = null;
          window.__weftcutTest
            .exportClip({ mediaAbsPath: media, outputAbsPath: out })
            .then(() => {
              window.__e2eExportDone = { ok: true };
            })
            .catch((e) => {
              window.__e2eExportDone = { ok: false, error: String(e) };
            });
        },
        source,
        output,
      );

      let lastFrame = -1;
      let settled = null;
      try {
        await browser.waitUntil(
          async () => {
            const snap = await browser.execute(() => {
              const st = window.__weftcutExportState;
              return {
                done: window.__e2eExportDone,
                frame: st?.progress?.frame ?? null,
                detail: st?.detail ?? null,
              };
            });
            if (snap.frame != null && snap.frame !== lastFrame) lastFrame = snap.frame;
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
      if (!settled.ok) throw new Error(`exportClip failed (${enc}): ` + settled.error);

      const [im, ir] = DECODE[enc];
      const report = analyzeColor({ output, source, manifest: MANIFEST, inMatrix: im, inRange: ir, sample: 10 });
      console.log(`[e2e] color ${enc}: worst_app_max=${report.worst_app_max}`);

      const limit = BASELINE[enc].worst_app_max + BASELINE.tolerance;
      const offenders = report.patches.filter((p) => Math.max(...p.app_error.max) > limit);
      if (offenders.length) {
        throw new Error(
          `${enc} patches exceed ${limit}: ` +
            JSON.stringify(offenders.map((p) => ({ id: p.id, max: p.app_error.max }))),
        );
      }
      expect(report.worst_app_max).toBeLessThanOrEqual(limit);
    });
  }
});
