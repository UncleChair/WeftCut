import path from "node:path";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { analyzeColor } from "../../lib/analyze.mjs";
import { newProject } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { MEDIA_DIR, fixture, tmpOut, tmpProjectParent } from "../../helpers/media.mjs";

const MANIFEST = fixture("color_manifest.json");
const BASELINE_PATH = path.resolve(MEDIA_DIR, "..", "color_baseline.json");
const PROJ = tmpProjectParent("weftcut-e2e-color-proj");

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
// All four encodings are FAITHFUL and DirectExport from the original
// (yuvj420p — full-range yuv420p — is on the browser-friendly whitelist). The
// decode side honors the source matrix/range: the decoder config is tagged
// via withDefaultColorSpace (decode target's own colr tag > ffprobe
// sourceColor > resolution default), then a colorSpace-honoring 2D drawImage
// in VideoClipSprite (Pixi's copyExternalImageToTexture upload ignores
// VideoFrame.colorSpace). Proxy-routed sources (HEVC/VP9/10-bit) rely on the
// self-describing proxy recipes (source_color_args + write_colr, proxy
// v7/quick-q4 — mediabunny reads only colr, never the SPS VUI, and the
// decoder follows the config over the VUI); that machinery is guarded by the
// Rust integration test proxy_carries_source_color_tags_and_colr_atom.
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
    const source = fixture(`test_1080p_color_${enc}.mp4`);
    const output = tmpOut(`weftcut-e2e-color-${enc}.mp4`);

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

      await newProject({
        parentFolder: PROJ,
        name: "e2e-color-" + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      });

      const r = await driveExport(
        { mediaAbsPath: source, outputAbsPath: output },
        { label: "color_conformance" },
      );
      if (!r.done.ok) throw new Error(`exportClip failed (${enc}): ` + r.done.error);

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
