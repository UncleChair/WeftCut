// The premise of ADR 0049, driven through the real gizmo: a text layer's box
// lays glyphs out, it does not scale them. Both gates grab a resize handle with
// a real pointer gesture and then read BOTH sides of that sentence — what
// reached the frame, and what the project still says.
//
// The second half is the one that regresses silently. Handles that went back to
// writing `scale_x`/`scale_y` would still make the box look right on screen, so
// every assertion here is paired: a rendered change AND an untouched
// `font_size_px`/`scale` in the project.
//
// `project_preview_gizmo` recorded that no e2e covered the transform gizmo at
// all; this is the first, so it also carries the drag primitive.

import { expect, test, type Page } from "@playwright/test";

import {
  invokeCmd,
  launchApp,
  newProject,
  summary,
  textBoxProbe,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

const CANVAS = { width: 1280, height: 720, fpsNum: 30, fpsDen: 1 };
/// Shaped against the gizmo, not against the text. Two opposing constraints:
///  - the auto-width block must measure well under the composition width, or the
///    side handles land off-canvas where no pointer can reach them;
///  - the right EDGE must be longer than `EDGE_HANDLE_MIN_PX` in CLIENT pixels,
///    or the `r` handle is hidden as inseparable from the two corners it sits
///    between — and that edge is the block's height.
///
/// Both are ratios against the composition, so the only lever is the block's own
/// aspect: `boxHeightClient = (blockH / blockW) × (blockW / compW) × canvasW`.
/// Hence the explicit newline — it triples the block's height-to-width ratio, so
/// the edge handle survives a preview panel a third the size of this machine's
/// rather than sitting just above the threshold on it.
const CONTENT = "wrap these\nwords now";
/// Lines the fixture starts on, so the ratio below reads as a line COUNT.
const BASELINE_LINES = 2;
const FONT_PX = 64;
const DURATION_US = 4_000_000;

interface StoredText {
  font_size_px: number;
  box_w: number | null;
  box_h: number | null;
  scale_x: number;
  scale_y: number;
}

/// The layer as the PROJECT holds it. `scale_x`/`scale_y` ride along because
/// they are what a regression would write instead of the box, and a gate that
/// only checked the font size would miss that.
async function stored(page: Page, layerId: string): Promise<StoredText> {
  const s = (await summary(page)) as unknown as {
    tracks: Array<{
      layers: Array<{
        id: string;
        params: {
          kind: string;
          font_size_px?: number;
          box_w?: number | null;
          box_h?: number | null;
          scale_x?: { mode: string; value: number };
          scale_y?: { mode: string; value: number };
        };
      }>;
    }>;
  };
  const layer = s.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId);
  if (!layer || layer.params.kind !== "Text") throw new Error(`no Text layer ${layerId} in summary`);
  const p = layer.params;
  return {
    font_size_px: p.font_size_px!,
    box_w: p.box_w ?? null,
    box_h: p.box_h ?? null,
    scale_x: p.scale_x!.value,
    scale_y: p.scale_y!.value,
  };
}

/// Add a boxless text layer at the composition centre, select it so the gizmo
/// mounts, and wait until the preview has measured it.
async function textLayerUnderGizmo(page: Page): Promise<string> {
  const layerId = await invokeCmd<string>(page, "add_text_layer", {
    tStartUs: 0,
    durationUs: DURATION_US,
    content: CONTENT,
  });
  await invokeCmd(page, "update_layer_params", {
    layerId,
    patch: { kind: "Text", font_size_px: FONT_PX },
  });
  await expect(page.locator(".pixi-preview-canvas")).toBeVisible();
  await expect(page.getByTestId("pixi-preview-initializing")).toBeHidden();
  await waitForHook(page, "revealLayer");
  await page.evaluate((id) => (window as any).__weftcutTest.revealLayer({ layerId: id }), layerId);
  await expect(page.getByTestId("transform-gizmo-box")).toBeVisible();
  await expect
    .poll(async () => (await textBoxProbe(page, layerId)).natural?.w ?? 0)
    .toBeGreaterThan(0);
  return layerId;
}

/// Drag handle `id` toward the box's centre until it sits at `fraction` of its
/// original distance from that centre.
///
/// The centre IS the resize pivot: a fresh text layer carries the default
/// 0.5/0.5 anchor and `x`/`y` is the anchor point for Text, so the box is
/// centred on it. Reading the pivot off the drawn box rather than computing it
/// keeps the gesture in client pixels the way a user's is, with no assumption
/// about the canvas' contain-fit scale.
async function dragHandleInward(page: Page, id: string, fraction: number): Promise<void> {
  // Named explicitly so "the handle is hidden" fails as itself rather than as a
  // missing layout box: an edge handle disappears when its edge is shorter than
  // `EDGE_HANDLE_MIN_PX` client px, which is a property of the fixture's size.
  await expect(page.getByTestId(`transform-gizmo-scale-${id}`)).toBeVisible();
  const handle = await page.getByTestId(`transform-gizmo-scale-${id}`).boundingBox();
  const box = await page.getByTestId("transform-gizmo-box").boundingBox();
  if (!handle || !box) throw new Error(`gizmo handle ${id} or box has no layout box`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  // Several steps, not one jump: the gesture's own solve runs per pointermove,
  // and a single move would exercise a path a user never takes.
  await page.mouse.move(cx + (hx - cx) * fraction, cy + (hy - cy) * fraction, { steps: 12 });
  await page.mouse.up();
}

test("an edge drag re-wraps the glyphs and leaves the stored font size alone", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-textbox-edge-"),
      name: `textbox-edge-${Date.now()}`,
      canvas: CANVAS,
    });
    const layerId = await textLayerUnderGizmo(page);

    // Auto width to begin with: no box at all, so the natural size IS the
    // measured block — `BASELINE_LINES` lines of it, the yardstick below.
    const before = await stored(page, layerId);
    expect([before.box_w, before.box_h]).toEqual([null, null]);
    const baseline = (await textBoxProbe(page, layerId)).natural!;

    // 0.6 rather than a harder squeeze: the box must stay wider than the widest
    // WORD, because `breakWords` is off by design and Auto height does not
    // shrink — a narrower box would overflow horizontally instead of wrapping,
    // which is a different behaviour with its own unit coverage.
    await dragHandleInward(page, "r", 0.6);

    // A horizontal edge owns `box_w` alone. It must NOT invent a height — that
    // would drag the layer into Fixed, switching shrink-to-fit on from a
    // gesture that only asked for a wrap width.
    await expect.poll(async () => (await stored(page, layerId)).box_w).not.toBeNull();
    const after = await stored(page, layerId);
    expect(after.box_h, "a right-edge drag leaves the height Auto").toBeNull();
    expect(after.box_w!).toBeLessThan(baseline.w * 0.8);

    // Wait for the box the drag committed to be the one the sprite measured
    // against, so the block height below is not read a frame early.
    await expect
      .poll(async () => (await textBoxProbe(page, layerId)).natural?.w ?? 0)
      .toBeCloseTo(after.box_w!, 0);
    const wrapped = (await textBoxProbe(page, layerId)).natural!;

    // The rendered half: at a fixed font size a block's height is its line count
    // times its leading, so scaling the baseline's known line count by the height
    // ratio counts the lines. Bounded on both sides — near a whole number, and
    // strictly more than it started with — so this asserts "whole lines were
    // added" rather than merely "something got taller".
    const lines = BASELINE_LINES * (wrapped.h / baseline.h);
    console.log(
      `[text-box] edge drag: box_w ${baseline.w.toFixed(1)} → ${after.box_w!.toFixed(1)}, ` +
        `block ${baseline.h.toFixed(1)} → ${wrapped.h.toFixed(1)} px = ${lines.toFixed(3)} lines`,
    );
    expect(Math.abs(lines - Math.round(lines)), `block height is ${lines} lines`).toBeLessThan(0.15);
    expect(Math.round(lines), "the box re-wrapped the text onto more lines").toBeGreaterThan(
      BASELINE_LINES,
    );

    // The ADR's half, asserted on the PROJECT: a narrower box wraps, and that
    // is ALL it does. Nothing about the glyphs' size moved — not the authored
    // size, not the scale a pre-ADR gizmo would have written instead, and not
    // the size that reached the frame (Auto height never shrinks).
    expect(after.font_size_px).toBe(FONT_PX);
    expect([after.scale_x, after.scale_y]).toEqual([1, 1]);
    const fit = (await textBoxProbe(page, layerId)).fit!;
    expect(fit).toMatchObject({ authoredPx: FONT_PX, effectivePx: FONT_PX, overflowing: false });
  } finally {
    await app.close();
  }
});

test("a corner drag compresses the rendered glyphs and still stores one font size", async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, {
      parentFolder: tmpDir("weftcut-e2e-textbox-corner-"),
      name: `textbox-corner-${Date.now()}`,
      canvas: CANVAS,
    });
    const layerId = await textLayerUnderGizmo(page);
    expect((await textBoxProbe(page, layerId)).fit).toMatchObject({
      authoredPx: FONT_PX,
      effectivePx: FONT_PX,
    });

    // Half the box on both axes. Narrower splits each authored line in two, and
    // twice the lines cannot fit in half the height — so the box is past
    // capacity on both axes at once and Fixed has to shrink.
    await dragHandleInward(page, "br", 0.5);

    await expect.poll(async () => (await stored(page, layerId)).box_h).not.toBeNull();
    const after = await stored(page, layerId);
    expect(after.box_w, "a corner owns both axes ⇒ Fixed").not.toBeNull();

    // The rendered half: the size the sprite drew with, which is the only place
    // shrink-to-fit exists. Bounded below by the 8 px floor, because "shrank"
    // must not be satisfiable by an unbounded collapse.
    await expect
      .poll(async () => (await textBoxProbe(page, layerId)).fit?.effectivePx ?? FONT_PX)
      .toBeLessThan(FONT_PX);
    const fit = (await textBoxProbe(page, layerId)).fit!;
    console.log(
      `[text-box] corner drag: box ${after.box_w!.toFixed(1)}×${after.box_h!.toFixed(1)}, ` +
        `font ${fit.authoredPx} → ${fit.effectivePx} px, overflowing=${fit.overflowing}`,
    );
    expect(fit.authoredPx, "the fit echoes back the size state holds").toBe(FONT_PX);
    expect(fit.effectivePx).toBeGreaterThanOrEqual(8);

    // The stored half. This is the acceptance test for the whole feature: the
    // renderer compressed the glyphs and the state layer still keeps exactly
    // one font size — the one the user set — with no `scale` written behind it.
    expect(after.font_size_px).toBe(FONT_PX);
    expect([after.scale_x, after.scale_y]).toEqual([1, 1]);
  } finally {
    await app.close();
  }
});
