import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { invokeCmd, launchApp, newProject } from "./helpers/driver";

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

test("closing Preview destroys its resources and reopening creates a new instance", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-dock-life-"));
    await newProject(page, {
      parentFolder: parent,
      name: "dock-preview-lifecycle",
      canvas: CANVAS,
    });
    await invokeCmd(page, "add_color_layer", {
      tStartUs: 0,
      durationUs: 1_000_000,
    });

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest?.previewResourceProbe?.() ?? null,
        ),
      )
      .not.toBeNull();
    const before = await page.evaluate(() =>
      (window as any).__weftcutTest.previewResourceProbe(),
    );

    const viewMenu = page.locator(".menu-trigger").nth(2);
    await viewMenu.click();
    await page.locator(".menu-item").filter({ hasText: /^Preview$/ }).click();
    await viewMenu.click();
    await page
      .locator(".menu-item")
      .filter({ hasText: /Close Active Panel|关闭活动面板/ })
      .click();

    await expect(page.locator('[data-panel-kind="preview"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe(),
        ),
      )
      .toBeNull();

    await viewMenu.click();
    await page.locator(".menu-item").filter({ hasText: /^Preview$/ }).click();
    await expect(page.locator('[data-panel-kind="preview"]')).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()?.generation ?? null,
        ),
      )
      .not.toBe(before.generation);
  } finally {
    await app.close();
  }
});

test("hidden Preview keeps clock resources alive while presentation sleeps", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-dock-hide-"));
    await newProject(page, {
      parentFolder: parent,
      name: "dock-preview-hidden",
      canvas: CANVAS,
    });
    await invokeCmd(page, "add_color_layer", {
      tStartUs: 0,
      durationUs: 3_000_000,
    });

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest?.previewResourceProbe?.() ?? null,
        ),
      )
      .not.toBeNull();
    await page.locator(".transport-buttons button").nth(1).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()?.playing ?? false,
        ),
      )
      .toBe(true);

    const before = await page.evaluate(() =>
      (window as any).__weftcutTest.previewResourceProbe(),
    );
    await page
      .getByTitle("Move Effect")
      .locator(".weft-dock-six-dot")
      .dragTo(page.locator('[data-panel-kind="preview"]'), {
        targetPosition: { x: 240, y: 140 },
      });

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()?.visible ?? true,
        ),
      )
      .toBe(false);
    const hidden = await page.evaluate(() =>
      (window as any).__weftcutTest.previewResourceProbe(),
    );
    expect(hidden.generation).toBe(before.generation);

    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()?.ownerCompositeCount ?? 0,
        ),
      )
      .toBeGreaterThan(hidden.ownerCompositeCount);
    expect(
      await page.evaluate(() =>
        (window as any).__weftcutTest.previewResourceProbe()
          ?.presentedCompositeCount,
      ),
    ).toBe(hidden.presentedCompositeCount);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()?.positionUs ?? 0,
        ),
      )
      .toBeGreaterThan(hidden.positionUs);

    await page.getByTitle("Move Preview").click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()?.visible ?? false,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe()
            ?.presentedCompositeCount ?? 0,
        ),
      )
      .toBeGreaterThan(hidden.presentedCompositeCount);
    expect(
      await page.evaluate(() =>
        (window as any).__weftcutTest.previewResourceProbe()?.generation,
      ),
    ).toBe(before.generation);
  } finally {
    await app.close();
  }
});
