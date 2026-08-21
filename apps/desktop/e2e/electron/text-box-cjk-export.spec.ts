// The export-realm gate for `CanvasTextMetrics.canBreakWords`.
//
// Pixi's wrap unit is a space-delimited token and the stock hook returns the
// style's `breakWords`, so an unspaced Chinese sentence is ONE token that never
// wraps at any `wordWrapWidth`. `fonts/lineBreak.ts` overrides that hook, and
// the override is realm-GLOBAL — a class static. There is ONE install site, the
// `Compositor` constructor, which is realm-complete because every realm that
// rasterizes text builds a Compositor, the export Worker included. This gate is
// what makes that site load-bearing: narrow it to the preview (gate it on
// `mode`, on `document`, on a FontFaceSet) and preview wraps CJK where the
// burned-in export does not. Unit tests can prove the rule and prove it
// survives a fresh realm; only an export can prove it reached the realm that
// burns pixels, and that defect is invisible until someone exports.
//
// Shape: a SAME-REALM differential. Export the same boxed CJK layer twice —
// once relying on auto-wrap, once with explicit '\n' at the break points
// auto-wrap should produce — and SSIM-compare the two videos. Both legs run
// through the identical encoder, so this needs none of the
// environment-calibrated SSIM floors the 1:1 export gates carry
// (e2e/README.md): a raster that rounds differently rounds both legs the same
// way. If the Worker wraps, the two files are the same frames; if it does not,
// the auto-wrap leg is one long clipped line and they diverge.
//
// Preview-vs-export pixel extraction was the other candidate. This is
// preferred because it compares two files of the same kind through the existing
// conformance analyzer instead of matching a readback PNG against a decoded
// frame, and because the wrap it asserts is authored rather than inferred.

import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

import { analyze } from "../lib/analyze.mjs";
import {
  driveExport,
  invokeCmd,
  launchApp,
  newProject,
  textBoxProbe,
  tmpDir,
} from "./helpers/driver";

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
const DURATION_US = 1_000_000;
/// The frame both files are compared at — mid-file, so a leading-frame quirk in
/// either encode cannot be what the gate reads.
const SAMPLE_FRAME = 15;

const FONT_PX = 48;
/// Eighteen Han characters, no spaces: one Pixi token, which is exactly the
/// defect's shape.
const CJK_18 = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来";
const CHARS_PER_LINE = 6;
/// Half a glyph of slack over six full-width advances. Noto Sans SC gives every
/// Han ideograph the same 1 em advance, so six of them are exactly `6 × FONT_PX`
/// and the slack is what keeps the split unambiguous: a seventh cannot fit, and
/// the explicitly-broken variant's six-character lines cannot re-wrap on a float
/// tail. Derived from the font size rather than written as a pixel number, so
/// changing the size cannot silently change the expected line count.
const BOX_W = FONT_PX * (CHARS_PER_LINE + 0.5);
/// The same 18 characters with the breaks auto-wrap is expected to produce.
const CJK_18_BROKEN = (CJK_18.match(new RegExp(`.{1,${CHARS_PER_LINE}}`, "gu")) ?? []).join("\n");
const EXPECTED_LINES = 3;

/// The rendered block's extent. In Auto height the probe's height is the
/// measured glyph block's, so it is the main thread's own answer to "how many
/// lines did this wrap to".
async function blockOf(page: Page, layerId: string): Promise<{ w: number; h: number }> {
  const p = await textBoxProbe(page, layerId);
  if (!p.natural) throw new Error("textBoxProbe: nothing staged for the text layer yet");
  return p.natural;
}

async function setContent(page: Page, layerId: string, content: string): Promise<void> {
  await invokeCmd(page, "update_layer_params", { layerId, patch: { kind: "Text", content } });
}

test("CJK wraps in the export Worker's realm, not only the preview's", async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === "1",
    "both legs drive a real WebCodecs encode; the wrap rule itself is unit-covered",
  );
  test.setTimeout(300_000);
  const outDir = tmpDir("weftcut-e2e-cjk-out-");
  const autoWrap = path.join(outDir, "auto-wrap.mp4");
  const explicitBreaks = path.join(outDir, "explicit-breaks.mp4");

  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-cjk-proj-"),
      name: `textbox-cjk-${Date.now()}`,
      canvas: CANVAS,
    });
    const layerId = await invokeCmd<string>(page, "add_text_layer", {
      tStartUs: 0,
      durationUs: DURATION_US,
      content: CJK_18,
    });
    await invokeCmd(page, "update_layer_params", {
      layerId,
      patch: { kind: "Text", font_size_px: FONT_PX },
    });
    await expect(page.locator(".pixi-preview-canvas")).toBeVisible();
    await expect(page.getByTestId("pixi-preview-initializing")).toBeHidden();

    // Auto width first, purely to measure ONE line of this string at this size.
    // The 18 characters run far wider than the frame here; nothing is asserted
    // about that, it is the yardstick the line count below is counted in.
    await expect.poll(async () => (await blockOf(page, layerId)).h).toBeGreaterThan(0);
    const oneLine = await blockOf(page, layerId);

    // Now the box. This assertion is what makes the differential MEAN something:
    // it pins that auto-wrap really produces the 3 × 6 split the explicit
    // variant spells out, in the realm whose wrapping is already unit-covered.
    // Without it, a fixture whose font metrics had drifted would compare two
    // files that agree on the wrong layout.
    await invokeCmd(page, "update_layer_params", {
      layerId,
      patch: { kind: "Text", box_w: BOX_W },
    });
    await expect
      .poll(async () => (await blockOf(page, layerId)).w)
      .toBeCloseTo(BOX_W, 0);
    const autoWrapped = await blockOf(page, layerId);
    const lines = autoWrapped.h / oneLine.h;
    console.log(
      `[text-box] CJK auto-wrap in the preview realm: block ${oneLine.h.toFixed(1)} → ` +
        `${autoWrapped.h.toFixed(1)} px = ${lines.toFixed(3)} lines at box_w ${BOX_W}`,
    );
    expect(Math.round(lines), `auto-wrap must split ${CJK_18.length} Han chars into ${EXPECTED_LINES} lines`).toBe(
      EXPECTED_LINES,
    );
    expect(Math.abs(lines - EXPECTED_LINES)).toBeLessThan(0.15);

    const autoWrapExport = await driveExport(
      page,
      { outputAbsPath: autoWrap },
      { hook: "exportTimeline", timeout: 150_000 },
    );
    if (!autoWrapExport.done.ok) {
      throw new Error("auto-wrap export failed: " + autoWrapExport.done.error);
    }

    // Same layer, same box, same size — only the newlines are added. Pixi always
    // splits on '\n', so this leg needs no break rule at all, which is what
    // makes it the reference.
    await setContent(page, layerId, CJK_18_BROKEN);
    await expect
      .poll(async () => (await blockOf(page, layerId)).h)
      .toBeCloseTo(autoWrapped.h, 0);

    const explicitExport = await driveExport(
      page,
      { outputAbsPath: explicitBreaks },
      { hook: "exportTimeline", timeout: 150_000 },
    );
    if (!explicitExport.done.ok) {
      throw new Error("explicit-break export failed: " + explicitExport.done.error);
    }
    expect(existsSync(autoWrap) && existsSync(explicitBreaks)).toBe(true);

    // `window: 0` because there is nothing to align: both files are the same
    // static frame repeated, so the analyzer's default ±2-frame search would be
    // choosing between identical candidates. Index-for-index is the comparison.
    const report = analyze({
      output: autoWrap,
      source: explicitBreaks,
      samples: [SAMPLE_FRAME],
      ssimMin: 0.99,
      window: 0,
    });
    console.log("[text-box] CJK export differential:", JSON.stringify(report));
    const sample = report.samples[0];
    if (!sample) throw new Error("analyzer returned no sample: " + JSON.stringify(report));
    if (!sample.pass) {
      throw new Error(
        `the auto-wrapped export does NOT match the explicitly-broken one ` +
          `(ssim ${sample.ssim.toFixed(4)}, psnr ${sample.psnr_db.toFixed(1)} dB). ` +
          `The export Worker's realm is not wrapping CJK: installCjkLineBreaking() ` +
          `did not reach it. Its one install site is the Compositor constructor ` +
          `(render/Compositor.ts) — check that nothing has narrowed it to preview mode.`,
      );
    }
    expect(report.pass).toBe(true);
  } finally {
    await app.close();
  }
});
