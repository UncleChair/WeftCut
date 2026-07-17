import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchApp, newProject } from "./helpers/driver";

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };

test("built-in Editing workspace docks every default Panel at NLE proportions", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-dock-"));
    await newProject(page, {
      parentFolder: parent,
      name: "dock-workspace",
      canvas: CANVAS,
    });

    await expect(page.locator("[data-panel-kind]")).toHaveCount(6);
    for (const kind of [
      "media",
      "preview",
      "timeline",
      "attribute",
      "effect",
      "nearby",
    ]) {
      await expect(page.locator(`[data-panel-kind="${kind}"]`)).toHaveCount(1);
    }
    await expect(page.locator('[data-panel-kind="caption"]')).toHaveCount(0);
    await expect(page.locator('[data-panel-kind="role-mixer"]')).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        workspace: rect(".dock-workspace"),
        media: rect('[data-panel-kind="media"]'),
        preview: rect('[data-panel-kind="preview"]'),
        attribute: rect('[data-panel-kind="attribute"]'),
        timeline: rect('[data-panel-kind="timeline"]'),
      };
    });

    const ratio = (value: number, total: number) => value / total;
    expect(ratio(geometry.timeline.height, geometry.workspace.height)).toBeCloseTo(0.38, 1);
    expect(ratio(geometry.timeline.width, geometry.workspace.width)).toBeCloseTo(1, 1);
    expect(ratio(geometry.media.width, geometry.workspace.width)).toBeCloseTo(0.22, 1);
    expect(ratio(geometry.preview.width, geometry.workspace.width)).toBeCloseTo(0.53, 1);
    expect(ratio(geometry.attribute.width, geometry.workspace.width)).toBeCloseTo(0.25, 1);

    // Single groups expose only the zero-height six-dot overlay. The context
    // group has three visible labels in its compact 28px tab strip.
    for (const label of ["Media Pool", "Preview", "Timeline"]) {
      await expect(
        page.locator(".weft-dock-tab-label", { hasText: label }),
      ).toBeHidden();
    }
    for (const label of ["Attribute", "Effect", "Nearby"]) {
      await expect(
        page.locator(".weft-dock-tab-label", { hasText: label }),
      ).toBeVisible();
    }

    const minimumSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getMinimumSize(),
    );
    expect(minimumSize).toEqual([960, 640]);
  } finally {
    await app.close();
  }
});
