import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
// overlapping.srt: cue 1 [0,3] and cue 2 [1,4] overlap → two caption lanes;
// cue 3 [3,5] reuses lane 1. So it seeds TWO caption-role Tracks with three
// cues — exactly the cross-Track corpus the Caption Panel must manage globally.
const SRT_PATH = path.resolve(__dirname, "../fixtures/subtitles/overlapping.srt");
// macOS select-all is Meta+a; Control+a does not select in native text fields.
const MOD = process.platform === "darwin" ? "Meta" : "Control";

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

test("Caption Panel manages the whole corpus: aggregate, seek, restyle-all, one undo", async () => {
  test.skip(!fs.existsSync(SRT_PATH), `subtitle fixture missing: ${SRT_PATH}`);
  // This test opens the normally-closed Caption Panel, whose arrangement the
  // app autosaves — the bare launchApp()'s per-launch throwaway userData keeps
  // that layout mutation from leaking into the dock-workspace baseline specs
  // that assert the default six-Panel set.
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
    await expect(page.locator('[data-panel-kind="caption"]')).toHaveCount(1);

    // Aggregation: cues from BOTH caption Tracks appear as one flattened list.
    const captionPanel = page.locator('[data-panel-kind="caption"]');
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
