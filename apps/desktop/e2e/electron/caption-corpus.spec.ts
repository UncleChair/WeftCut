import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dockPanel,
  invokeCmd,
  launchApp,
  newProject,
  textBoxProbe,
  tmpDir,
  waitForHook,
} from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
// overlapping.srt: cue 1 [0,3] and cue 2 [1,4] overlap → two caption lanes;
// cue 3 [3,5] reuses lane 1. So it seeds TWO caption-role Tracks with three
// cues — exactly the cross-Track corpus the Caption Panel must manage globally.
const SRT_PATH = path.resolve(__dirname, "../fixtures/subtitles/overlapping.srt");
// macOS select-all is Meta+a; Control+a does not select in native text fields.
const MOD = process.platform === "darwin" ? "Meta" : "Control";
/// One cue's worth of text as a single unbroken line of ~220 characters. A
/// machine transcript carries no '\n' — the wrap width a cue is born with is the
/// only thing that keeps such a line inside the frame, and at the default caption
/// size (5% of 360 px) this is several times the box's width. Written at run time
/// rather than committed: the shape is the whole fixture.
const UNBROKEN_LINE = "a transcript sentence that nobody ever broke into lines ".repeat(4).trim();

interface CaptionLayer {
  id: string;
  trackId: string;
  startUs: number;
  size: number;
}

/// Every caption-role Track's Text layers, flattened + sorted by start — the
/// backend truth the Panel presents.
async function captionLayers(page: import("@playwright/test").Page): Promise<CaptionLayer[]> {
  const s = await invokeCmd<{
    tracks: Array<{
      id: string;
      role: string | null;
      layers: Array<{ id: string; t_start_us: number; params: { kind: string; font_size_px?: number } }>;
    }>;
  }>(page, "project_summary", {});
  const out: CaptionLayer[] = [];
  for (const tr of s.tracks) {
    if (tr.role !== "caption") continue;
    for (const l of tr.layers) {
      if (l.params.kind !== "Text") continue;
      out.push({ id: l.id, trackId: tr.id, startUs: l.t_start_us, size: l.params.font_size_px ?? -1 });
    }
  }
  return out.sort((a, b) => a.startUs - b.startUs);
}

/// What the preview actually drew the cue into: the wrap width on the fixed axis
/// and the MEASURED glyph block on the auto one.
async function renderedBlock(
  page: import("@playwright/test").Page,
  layerId: string,
): Promise<{ w: number; h: number }> {
  const p = await textBoxProbe(page, layerId);
  if (!p.natural) throw new Error("textBoxProbe: nothing staged for the caption layer yet");
  return p.natural;
}

interface StoredTextParams {
  kind: string;
  content: string;
  font: { size_px: number };
  box_w: number | null;
  box_h: number | null;
  transform: { x: { value: number }; y: { value: number } };
}

/// The title-safe band the preview actually DRAWS, converted back into
/// composition pixels through the canvas' contain box.
///
/// Measured rather than recomputed on purpose. This is the one cross-check
/// between two modules that each own a delivery margin — the importer insets a
/// cue by `SAFE_AREA_MARGIN` per side (`state/mutations/captions.ts`, twin of
/// `subtitles/layout.rs`) and the overlay draws title-safe at
/// `TITLE_SAFE_FRACTION` (`preview/SafeAreaGuides.tsx`) — and no unit test can
/// hold both: the two projects' tsconfigs make a main↔renderer import of a
/// `.tsx` unresolvable in either direction. Reading the drawn rectangle restates
/// neither constant, and it holds the guides to being a usable answer to "how
/// wide should a caption be".
///
/// The canvas element IS the composition's extent — the preview panel owns both
/// letterbox axes and the canvas is contain-sized inside it
/// (preview-canvas-layout.spec.ts) — so one uniform scale maps between them.
async function titleSafeInCompPx(
  page: import("@playwright/test").Page,
  comp: { width: number; height: number },
): Promise<{ x: number; y: number; w: number; h: number }> {
  const canvas = await page.locator(".pixi-preview-canvas").boundingBox();
  if (!canvas) throw new Error("preview canvas has no layout box");
  // The bright rect, not the group's bounding box: the group's includes the
  // 3 px dark under-stroke, which would inflate the band by half of it per edge.
  // Its x/y are SVG-local (the overlay subtracts its own client origin), so the
  // origin goes back on here to land in the same space as the canvas box.
  const band = (await page.evaluate(() => {
    const g = document.querySelector('[data-testid="safe-area-guide-title"]');
    const rect = g?.children[1] as SVGRectElement | undefined;
    const own = g?.closest("svg")?.getBoundingClientRect();
    if (!rect || !own) return null;
    const n = (a: string) => Number(rect.getAttribute(a));
    return { x: n("x") + own.left, y: n("y") + own.top, w: n("width"), h: n("height") };
  })) as { x: number; y: number; w: number; h: number } | null;
  if (!band) throw new Error("title-safe band is not drawn");
  const perCompPx = canvas.width / comp.width;
  return {
    x: (band.x - canvas.x) / perCompPx,
    y: (band.y - canvas.y) / perCompPx,
    w: band.w / perCompPx,
    h: band.h / perCompPx,
  };
}

/// The stored (authored) params of the project's single caption Text layer, read
/// back off disk — the serialized form, so the box the importer minted is held
/// to what SURVIVES a save rather than to a projection of live state.
function storedCaptionParams(projectDir: string): StoredTextParams {
  const wire = JSON.parse(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")) as {
    tracks: Array<{ role: string | null; layers: Array<{ params: StoredTextParams }> }>;
  };
  const params = wire.tracks
    .filter((t) => t.role === "Caption")
    .flatMap((t) => t.layers.map((l) => l.params))
    .filter((p) => p.kind === "Text");
  expect(params).toHaveLength(1);
  return params[0]!;
}

/// Both halves of the unbroken-line defect: the cue is born with a wrap width,
/// and the renderer then breaks the glyphs at it. Kept in one test because
/// neither half is worth anything alone — a stored width nothing honours leaves
/// the line running off the frame, and a wrap the importer never asked for would
/// be somebody else's box.
test("an unbroken transcript line is born with a wrap width inside the safe area, and breaks at it", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-caption-wrap-");
    await newProject(page, { parentFolder: parent, name: "caption-wrap", canvas: CANVAS });
    const srt = path.join(tmpDir("weftcut-caption-srt-"), "unbroken.srt");
    fs.writeFileSync(srt, `1\n00:00:00,000 --> 00:00:03,000\n${UNBROKEN_LINE}\n`, "utf8");

    await invokeCmd(page, "import_media", { path: srt });
    await expect.poll(async () => (await captionLayers(page)).length).toBe(1);

    await invokeCmd(page, "project_save");
    const params = storedCaptionParams(path.join(parent, "caption-wrap"));
    // The premise: one line, no newline to break on.
    expect(params.content).not.toContain("\n");
    expect(params.content.length).toBeGreaterThan(200);
    // Auto height — (box_w, null): the cue wraps at the composition width less
    // the 8% safe-area margin per side, and because Auto height never shrinks,
    // the stored size is still the size the cue's style asked for.
    expect(params.box_w).toBeCloseTo(537.6, 3); // 640 - 2 × 8%
    expect(params.box_h).toBeNull();
    expect(params.font.size_px).toBe(Math.round(CANVAS.height * 0.05));

    // The renderer's half. The cue spans [0, 3 s] and the playhead is at 0, so
    // the layer is staged: `naturalSizeOf` reports the box on the fixed axis and
    // the MEASURED glyph block on the auto one, which is what makes the wrap
    // observable at all.
    const layerId = (await captionLayers(page))[0]!.id;
    await expect(page.locator(".pixi-preview-canvas")).toBeVisible();
    await expect(page.getByTestId("pixi-preview-initializing")).toBeHidden();
    await expect
      .poll(async () => (await renderedBlock(page, layerId)).w)
      .toBeCloseTo(params.box_w!, 0);
    const block = await renderedBlock(page, layerId);
    // More than one line, by a margin no leading can explain away: a single line
    // of this font measures ~1.2 × its size tall, so twice the size cannot be
    // reached without a break. The 220-character cue in fact lands on several.
    console.log(
      `[caption] unbroken cue rendered ${block.h.toFixed(1)} px tall in a ` +
        `${block.w.toFixed(1)} px box at ${params.font.size_px} px`,
    );
    expect(block.h, "the imported cue's glyphs break rather than run off the frame").toBeGreaterThan(
      params.font.size_px * 2,
    );

    // ── The safe-area cross-check ──────────────────────────────────────────
    // Turn on the guides and hold the imported box to the rectangle they draw.
    const viewMenu = page.locator(".menu-trigger").nth(2);
    await viewMenu.click();
    await page.locator(".app-menu-item").filter({ hasText: /^Show safe areas$/ }).click();
    await expect(page.getByTestId("safe-area-guides")).toBeAttached();
    const title = await titleSafeInCompPx(page, CANVAS);
    // A styleless cue is bottom-centre: `x` is the box's centre and `y` its
    // bottom, so containment is those two edges against the band.
    const centreX = params.transform.x.value;
    const halfW = params.box_w! / 2;
    console.log(
      `[caption] box [${(centreX - halfW).toFixed(1)}, ${(centreX + halfW).toFixed(1)}] inside ` +
        `title-safe [${title.x.toFixed(1)}, ${(title.x + title.w).toFixed(1)}], ` +
        `baseline ${params.transform.y.value.toFixed(1)} vs ${(title.y + title.h).toFixed(1)}`,
    );
    // A pixel of slack for the rect attributes' rounding through the contain
    // scale; the real margins here are ~19 composition px per side.
    const EPS_COMP_PX = 1;
    expect(centreX - halfW).toBeGreaterThanOrEqual(title.x - EPS_COMP_PX);
    expect(centreX + halfW).toBeLessThanOrEqual(title.x + title.w + EPS_COMP_PX);
    // Auto height, so there is no box bottom to contain — but the baseline it
    // hangs from still has to be inside, or a caption sits legally wide and
    // illegally low.
    expect(params.transform.y.value).toBeLessThanOrEqual(title.y + title.h + EPS_COMP_PX);
  } finally {
    await app.close();
  }
});

test("Caption Panel manages the whole corpus: aggregate, seek, restyle-all, one undo", async () => {
  test.skip(!fs.existsSync(SRT_PATH), `subtitle fixture missing: ${SRT_PATH}`);
  // This test opens the normally-closed Caption Panel, whose arrangement the
  // app autosaves — the bare launchApp()'s per-launch throwaway userData keeps
  // that layout mutation from leaking into the dock-workspace baseline specs
  // that assert the default Panel set.
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-caption-");
    await newProject(page, { parentFolder: parent, name: "caption-corpus", canvas: CANVAS });

    // Seed captions via the real subtitle-import path (consumes the .srt into
    // caption Tracks, not the media pool).
    await invokeCmd(page, "import_media", { path: SRT_PATH });
    await expect
      .poll(async () => new Set((await captionLayers(page)).map((l) => l.trackId)).size)
      .toBeGreaterThanOrEqual(2);

    const seeded = await captionLayers(page);
    expect(seeded.length).toBe(3);

    // Open the initially-closed Caption Panel from the View menu.
    const viewMenu = page.locator(".menu-trigger").nth(2);
    await viewMenu.click();
    await page.locator(".app-menu-item").filter({ hasText: /^Caption$/ }).click();
    await expect(dockPanel(page, "caption")).toHaveCount(1);

    // Aggregation: cues from BOTH caption Tracks appear as one flattened list.
    const captionPanel = dockPanel(page, "caption");
    await expect(captionPanel.locator(".caption-row")).toHaveCount(3);

    // Cue activation seeks the playhead. Pick the latest cue (start > 0) so the
    // move off the default 0 position is observable; its row is last in order.
    await waitForHook(page, "getPlayheadUs");
    const target = seeded[seeded.length - 1]!;
    expect(target.startUs).toBeGreaterThan(0);
    await captionPanel.locator(".caption-seek").last().click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__weftcutTest.getPlayheadUs()))
      .toBe(target.startUs);
    // Activation also SELECTS the cue's Text Layer through the host: the shared
    // selection flows back and the activated row (the last one) is marked.
    const rows = captionPanel.locator(".caption-row");
    await expect(captionPanel.locator(".caption-row.is-selected")).toHaveCount(1);
    await expect(rows.last()).toHaveClass(/is-selected/);

    // Project-wide restyle: change the corpus font size once; EVERY caption
    // Track's Text layers move together.
    const baseSize = seeded[0]!.size;
    expect(seeded.every((l) => l.size === baseSize)).toBe(true);
    const newSize = baseSize + 22;
    // Base UI's NumberField tracks its value through real keystrokes (a raw
    // .fill() is ignored), and a Dockview sash overlaps the click point — so
    // focus without hit-testing, then type + Enter to commit.
    const sizeInput = captionPanel.locator('.captions-style-section input[type="number"]');
    await sizeInput.focus();
    await sizeInput.press(`${MOD}+a`);
    await sizeInput.pressSequentially(String(newSize));
    await sizeInput.press("Enter");
    await expect
      .poll(async () => (await captionLayers(page)).every((l) => l.size === newSize), { timeout: 10_000 })
      .toBe(true);

    // One atomic command ⇒ a single undo reverts the whole corpus.
    await invokeCmd(page, "project_undo", {});
    await expect
      .poll(async () => (await captionLayers(page)).every((l) => l.size === baseSize))
      .toBe(true);
  } finally {
    await app.close();
  }
});
