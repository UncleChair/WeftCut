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

// Axis-A color round-trip gate. Per encoding, export 1:1 and measure app-only
// color error (output vs decoded-source, both forced to the source's matrix).
//
// Landed 2026-06-03 as a "709-green / 601·full-expected-fail" gate: 709-limited
// round-trips faithfully today, but BT.601 and full-range sources mis-convert
// (ROOT CAUSE: getDecoderConfig() yields no colorSpace for these files, so
// withDefaultColorSpace defaults every HD source to bt709/limited — the decoder
// is fed the wrong matrix/range before the encoder ever runs). Rather than
// enshrine the broken error magnitudes as "acceptable", the known-bad encodings
// ASSERT THE BUG IS STILL PRESENT (worst_app_max > faithfulMax); the moment the
// color-management fix lands, their error drops and those assertions go RED —
// the signal to flip expectFaithful:true in color_baseline.json. See the design
// doc (docs/superpowers/specs/2026-06-03-color-conformance-axis-design.md).

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
