// ONE-OFF diagnostic (NOT a gate): read the REAL decoded export frame's
// colorSpace vs the config we passed. The 方案B drawImage snapshot (proven to
// honor an explicitly-tagged frame, even in a Worker on an OffscreenCanvas) did
// NOT move the export error — so either the decoder isn't stamping our
// config.colorSpace onto its output frames, or the frame arrives untagged. This
// reads `window.__weftcutExportPerf.colorDiag` (captured off the first decoded
// frame in ExportDecoderPool) for 601ltd (601 expected) and 709ltd (control).
//   npx wdio run wdio.conf.mjs --spec ./tools/iso_export_framecolor.e2e.js
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const MEDIA =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const PROJ = path.resolve(os.tmpdir(), "weftcut-e2e-framecolor-proj");

describe("export frame colorSpace diagnostic (real WebView2, one-off)", function () {
  for (const enc of ["601ltd", "709ltd"]) {
    const source = path.resolve(MEDIA, `test_1080p_color_${enc}.mp4`);
    const output = path.resolve(os.tmpdir(), `weftcut-e2e-framecolor-${enc}.mp4`);

    it(`${enc} reports first-frame colorSpace`, async function () {
      if (!existsSync(source)) {
        console.warn(`[fc] SKIP ${enc}: fixture missing ${source}`);
        this.skip();
      }
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
            name: "fc-" + Date.now(),
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
          window.__weftcutExportPerf = null;
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

      let settled = null;
      await browser.waitUntil(
        async () => {
          const snap = await browser.execute(() => window.__e2eExportDone);
          if (snap) {
            settled = snap;
            return true;
          }
          return false;
        },
        { timeout: 170000, interval: 1000 },
      );
      if (!settled.ok) throw new Error(`export failed (${enc}): ` + settled.error);

      const diag = await browser.execute(() => {
        const p = window.__weftcutExportPerf;
        return p ? p.colorDiag : "NO_PERF";
      });
      console.log(`[fc] ${enc} colorDiag:`, JSON.stringify(diag));
      expect(true).toBe(true);
    });
  }
});
