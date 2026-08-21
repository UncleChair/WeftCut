import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dockPanel,
  invokeCmd,
  launchApp,
  newProject,
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

interface StoredTextParams {
  kind: string;
  content: string;
  font: { size_px: number };
  box_w: number | null;
  box_h: number | null;
}

/// The stored (authored) params of the project's single caption Text layer, read
/// back off disk. `project_summary`'s Text view projects no box, so the saved
/// project is what a spec can hold the importer to.
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

/// The importer's half of the unbroken-line defect: the cue is born with a wrap
/// width, in the state the renderer reads. That the glyphs then break at that
/// width is `TextSprite`'s half and belongs to the box/wrap gate, not here.
test("an unbroken transcript line is born with a wrap width inside the safe area", async () => {
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
