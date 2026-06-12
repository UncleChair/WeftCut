import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

// DIAGNOSTIC TOOL (non-gating): export decode colorSpace autopsy. Exports the
// 709full/601full fixtures and dumps ExportColorDiag: the decoder config's
// colorSpace vs what the decoder actually stamped on its output frames.
// (These fixtures DirectExport now that yuvj420p is on the browser-friendly
// whitelist; when this tool found the root cause below they still routed
// through the full proxy. To autopsy a proxy decode today, point it at a
// proxy-routed source — HEVC/VP9/10-bit.)
//
// VERIFIED FINDING (the root cause of the historical full-range squash):
// WebView2's VideoDecoder FOLLOWS THE CONFIG OVER THE BITSTREAM VUI. A proxy
// whose VUI said pc/601 but whose config fell back to the bt709/limited
// resolution default (mediabunny reads only the mp4 colr atom, never the VUI;
// old proxies had no colr) stamped bt709/limited frames — pc data decoded as
// tv (clip+stretch), 601 as 709. Fixed by source_color_args + write_colr in
// the proxy recipes (v7/quick-q4) plus threading ffprobe sourceColor into
// proxy decodes; with the fix this tool reports the source's real
// matrix/range in BOTH configColor and frameColor.
const MEDIA =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const PROJ = path.resolve(os.tmpdir(), "weftcut-e2e-colordiag-proj");

describe("DIAG full-range proxy decode colorSpace", function () {
  before(function () {
    mkdirSync(PROJ, { recursive: true });
  });

  for (const enc of ["709full", "601full"]) {
    const source = path.resolve(MEDIA, `test_1080p_color_${enc}.mp4`);
    const output = path.resolve(os.tmpdir(), `weftcut-e2e-colordiag-${enc}.mp4`);

    it(`${enc}: export via proxy and dump ExportColorDiag`, async function () {
      if (!existsSync(source)) {
        console.warn(`[diag] SKIP ${enc}: fixture not found at ${source}`);
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
      const r1 = await browser.executeAsync((parent, name, done) => {
        window.__weftcutTest
          .newProjectAndEnter({
            parentFolder: parent,
            name,
            canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
          })
          .then(() => done({ ok: true }))
          .catch((e) => done({ ok: false, error: String(e) }));
      }, PROJ, "colordiag-" + Date.now());
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
          settled = await browser.execute(() => window.__e2eExportDone);
          return settled != null;
        },
        { timeout: 170000, interval: 1000, timeoutMsg: "export never settled" },
      );
      if (!settled.ok) throw new Error(`exportClip failed (${enc}): ` + settled.error);

      const perf = await browser.execute(() => window.__weftcutExportPerf);
      console.log(`[diag] ${enc} colorDiag: ${JSON.stringify(perf?.colorDiag ?? null)}`);
      if (!perf?.colorDiag) {
        throw new Error(`${enc}: __weftcutExportPerf.colorDiag missing — was the app built with VITE_WEFTCUT_E2E=1?`);
      }
    });
  }
});
