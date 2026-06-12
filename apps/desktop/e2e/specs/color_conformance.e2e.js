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

// Axis-A color conformance gate. Per encoding, export 1:1 and measure app-only
// color loss under a PERCEPTUAL metric: the analyzer decodes the OUTPUT by its
// own embedded color tag and the SOURCE forced to its matrix/range (the DECODE
// map below), then asks "does the export SHOW the same colors as the source?".
//
// Why perceptual (not matrix-roundtrip): WebView2's WebCodecs H.264 encoder
// (HW and SW, verified) ignores the input frame's colorSpace and tags every HD
// output bt709 — it CANNOT emit a 601-tagged HD file. So a faithful 601 export
// is legitimately bt709-tagged (normalized to 709). A matrix-roundtrip check
// (force-decode the output as the source matrix) measured the relabel, not the
// colors, and reported the same error whether the pixels were right or wrong.
//
// All four encodings are FAITHFUL. The decode side honors the source
// matrix/range from EITHER decode target: the decoder config is tagged via
// withDefaultColorSpace (decode target's own colr tag > ffprobe sourceColor >
// resolution default), then a colorSpace-honoring 2D drawImage in
// VideoClipSprite (Pixi's copyExternalImageToTexture upload ignores
// VideoFrame.colorSpace). 709ltd/601ltd decode the original (DirectExport);
// 709full/601full decode a PROXY (yuvj420p is off the DirectExport whitelist)
// that the recipe makes self-describing (source_color_args + write_colr, proxy
// v7/quick-q4) — mediabunny reads only colr, never the SPS VUI, and the
// decoder follows the config over the VUI, so a colr-less proxy used to be
// misread as bt709/limited (the old known-bad pc→tv squash + 601-as-709).
// 601→709 normalization and full→limited range conversion cost only codec
// round-trip. ADR docs/adr/0014-export-color-perceptual-conformance.md.

// Reference matrix/range each encoding's SOURCE is decoded with (its tags are
// incomplete — only a matrix is present). The OUTPUT is decoded by its own tag.
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

    it(`${enc} color round-trip`, async function () {
      if (!existsSync(source)) {
        console.warn(`[e2e] SKIP ${enc}: source fixture not found at ${source}`);
        this.skip();
      }
      if (!BASELINE || !BASELINE[enc]) {
        console.warn(
          `[e2e] SKIP ${enc}: baseline not recorded — record ${BASELINE_PATH} ` +
            `(faithfulMax + per-encoding expectFaithful); see record_color_exports.tool.mjs.`,
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
      const expectFaithful = BASELINE[enc].expectFaithful;
      console.log(`[e2e] color ${enc}: worst_app_max=${report.worst_app_max} (expectFaithful=${expectFaithful}, faithfulMax=${BASELINE.faithfulMax})`);

      if (expectFaithful) {
        // Faithful round-trip: app-only color error must be ~0 across all patches
        // (flat patches, matching matrix). 709-limited is the app's native space.
        const offenders = report.patches.filter((p) => Math.max(...p.app_error.max) > BASELINE.faithfulMax);
        if (offenders.length) {
          throw new Error(
            `${enc} patches exceed faithfulMax=${BASELINE.faithfulMax}: ` +
              JSON.stringify(offenders.map((p) => ({ id: p.id, max: p.app_error.max }))),
          );
        }
        expect(report.worst_app_max).toBeLessThanOrEqual(BASELINE.faithfulMax);
      } else {
        // KNOWN BUG: this encoding mis-converts (see header). Assert the bug is
        // STILL present so the suite stays green until the fix lands; when the
        // color-management fix lands, worst_app_max drops <= faithfulMax and THIS
        // ASSERTION FAILS (red) — flip expectFaithful:true for ${enc} then.
        expect(report.worst_app_max).toBeGreaterThan(BASELINE.faithfulMax);
      }
    });
  }
});
