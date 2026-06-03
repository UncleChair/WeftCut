// ONE-OFF recording utility (NOT a gate): drives the real app to export each of
// the 4 color charts 1:1 to a known temp path, and logs analyzeColor's
// worst_app_max per encoding. Run targeted:
//   npx wdio run wdio.conf.mjs --spec ./tools/record_color_exports.e2e.js
// Then probe the exports from the shell (color-probe-export.mjs) and record
// color_baseline.json. This file is a scaffold for the Stage-0/baseline run; it
// is not part of the committed gate suite.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyzeColor } from "../lib/analyze.mjs";

const MEDIA =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const MANIFEST = path.resolve(MEDIA, "color_manifest.json");
const PROJ = path.resolve(os.tmpdir(), "weftcut-e2e-color-rec-proj");
const DECODE = {
  "709ltd": ["bt709", "tv"],
  "601ltd": ["smpte170m", "tv"],
  "709full": ["bt709", "pc"],
  "601full": ["smpte170m", "pc"],
};

// Stable output paths so the shell probe can read them after the run.
export function recordOutputPath(enc) {
  return path.resolve(os.tmpdir(), `weftcut-record-color-${enc}.mp4`);
}

describe("RECORD color exports (real WebView2, one-off)", function () {
  before(function () {
    mkdirSync(PROJ, { recursive: true });
  });

  for (const enc of Object.keys(DECODE)) {
    const source = path.resolve(MEDIA, `test_1080p_color_${enc}.mp4`);
    const output = path.resolve(os.tmpdir(), `weftcut-record-color-${enc}.mp4`);

    it(`export ${enc}`, async function () {
      if (!existsSync(source)) {
        console.warn(`[rec] SKIP ${enc}: source not found at ${source}`);
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
            name: "e2e-color-rec-" + Date.now(),
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
      let lastDetail = null;
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
            if (snap.detail != null) lastDetail = snap.detail;
            if (snap.done) {
              settled = snap.done;
              return true;
            }
            return false;
          },
          { timeout: 170000, interval: 1000 },
        );
      } catch (e) {
        throw new Error(`export ${enc} never settled (last frame=${lastFrame}, detail=${lastDetail}): ${e.message}`);
      }
      if (!settled.ok) throw new Error(`exportClip ${enc} failed: ${settled.error} (detail=${lastDetail})`);
      if (!existsSync(output)) throw new Error(`export ${enc}: no output at ${output}`);

      const [im, ir] = DECODE[enc];
      const report = analyzeColor({ output, source, manifest: MANIFEST, inMatrix: im, inRange: ir, sample: 10 });
      console.log(`[rec] ${enc}: output=${output} worst_app_max=${report.worst_app_max}`);
      console.log(`[rec] ${enc} per-channel app_error.max: ` +
        JSON.stringify(report.patches.map((p) => ({ id: p.id, max: p.app_error.max }))));
    });
  }
});
