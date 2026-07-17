import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { invokeCmd, launchApp, newProject } from "./helpers/driver";

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };

const EDITING_WORKSPACE_ID = "editing";

interface WorkspaceProfile {
  id: string;
  name: string;
  current: unknown | null;
  saved: unknown | null;
}
interface WorkspaceDocument {
  version: number;
  activeId: string;
  profiles: WorkspaceProfile[];
}

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

test("View menu creates a custom Workspace from the current arrangement and switches without a save prompt", async () => {
  // Own userData dir: this test mutates the app-level Workspace document, so it
  // must not read from or pollute the shared default userData.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-ws-ui-data-"));
  const { app, page } = await launchApp({ userDataDir });
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-ws-ui-"));
    await newProject(page, {
      parentFolder: parent,
      name: "workspace-ui",
      canvas: CANVAS,
    });
    await expect(page.locator("[data-panel-kind]")).toHaveCount(6);

    const viewMenu = page.locator(".menu-trigger").nth(2);
    // Menu labels are localized (the e2e runtime may be en-US or zh-CN); match
    // both. Panel titles and the user-typed Workspace name are not localized.
    const editingItem = /^(Editing|编辑)$/;
    const cuttingItem = /^Cutting$/;

    // Save Workspace As… → name dialog → a custom Workspace becomes active.
    await viewMenu.click();
    await page
      .locator(".menu-item")
      .filter({ hasText: /Save Workspace As|工作区另存为/ })
      .click();
    await page.getByLabel(/Workspace name|工作区名称/).fill("Cutting");
    await page.getByRole("button", { name: /^(Save|保存)$/ }).click();

    // Close a Panel so the two Workspaces diverge, then confirm it persisted.
    await viewMenu.click();
    await page.locator(".menu-item").filter({ hasText: /^Nearby$/ }).click(); // focus Nearby
    await viewMenu.click();
    await page
      .locator(".menu-item")
      .filter({ hasText: /Close Active Panel|关闭活动面板/ })
      .click();
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(0);

    // The View menu now lists both Workspaces.
    await viewMenu.click();
    await expect(page.locator(".menu-item").filter({ hasText: cuttingItem })).toHaveCount(1);
    await expect(page.locator(".menu-item").filter({ hasText: editingItem })).toHaveCount(1);

    // Switch to Editing — no save prompt — and the full default set returns.
    await page.locator(".menu-item").filter({ hasText: editingItem }).click();
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(1);

    // Switch back to Cutting: its diverged arrangement (Nearby closed) is restored.
    await viewMenu.click();
    await page.locator(".menu-item").filter({ hasText: cuttingItem }).click();
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("named Workspaces, active selection, and baselines survive a restart", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-ws-restart-"));
  const layout = (kind: string) => ({
    version: 1,
    empty: false,
    dockview: {
      grid: {
        root: { type: "leaf", data: { views: [kind], activeView: kind, id: `g-${kind}` }, size: 100 },
        orientation: "HORIZONTAL",
        width: 1000,
        height: 720,
      },
      panels: {},
      activeGroup: `g-${kind}`,
    },
    placements: {},
  });

  const first = await launchApp({ userDataDir });
  let cutId: string;
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-ws-r1-"));
    await newProject(first.page, {
      parentFolder: parent,
      name: "workspace-restart",
      canvas: CANVAS,
    });

    // Save As → a custom profile; then Save promotes a diverged current to baseline.
    const created = await invokeCmd<WorkspaceDocument>(first.page, "workspace_create_profile", {
      name: "Cutting",
      current: layout("timeline"),
    });
    expect(created.profiles.map((p) => p.name)).toEqual(["Editing", "Cutting"]);
    cutId = created.activeId;
    expect(cutId).not.toBe(EDITING_WORKSPACE_ID);

    await invokeCmd(first.page, "workspace_set_current", { current: layout("media") });
    const saved = await invokeCmd<WorkspaceDocument>(first.page, "workspace_save_baseline", {});
    const savedCut = saved.profiles.find((p) => p.id === cutId)!;
    expect(savedCut.saved).toEqual(layout("media"));

    // Switch back to Editing before quitting.
    const switched = await invokeCmd<WorkspaceDocument>(first.page, "workspace_set_active", {
      id: EDITING_WORKSPACE_ID,
    });
    expect(switched.activeId).toBe(EDITING_WORKSPACE_ID);
  } finally {
    await first.app.close();
  }

  // Relaunch over the same userData: the profile, its baseline, and the active
  // selection are all restored from <userData>/workspaces.json.
  const second = await launchApp({ userDataDir });
  try {
    const doc = await invokeCmd<WorkspaceDocument>(second.page, "workspace_get", {});
    expect(doc.activeId).toBe(EDITING_WORKSPACE_ID);
    const cutting = doc.profiles.find((p) => p.id === cutId)!;
    expect(cutting.name).toBe("Cutting");
    expect(cutting.saved).toEqual(layout("media"));

    // Deleting the custom profile leaves only the immutable built-in Editing.
    const afterDelete = await invokeCmd<WorkspaceDocument>(
      second.page,
      "workspace_delete_profile",
      { id: cutId },
    );
    expect(afterDelete.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID]);
  } finally {
    await second.app.close();
  }
});
