import { expect, test } from "@playwright/test";

import {
  invokeCmd,
  launchApp,
  newProject,
  summary,
  tmpDir,
} from "./helpers/driver";

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
  // Fresh userData: the built-in baseline assertions require the pristine
  // Editing layout, not whatever a previous default-userData spec autosaved.
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-dock-");
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

    const geometryOf = () =>
      page.evaluate(() => {
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

    // Panels exist in the DOM before their render overlays are positioned
    // (a few startup frames); until then an overlay still measures as the
    // whole workspace. Wait for the timeline share to settle at the baseline
    // proportion, then assert the full geometry in one read.
    const ratio = (value: number, total: number) => value / total;
    await expect
      .poll(async () => {
        const g = await geometryOf();
        return ratio(g.timeline.height, g.workspace.height);
      })
      .toBeCloseTo(0.28, 1);

    const geometry = await geometryOf();
    expect(ratio(geometry.timeline.height, geometry.workspace.height)).toBeCloseTo(0.28, 1);
    expect(ratio(geometry.timeline.width, geometry.workspace.width)).toBeCloseTo(1, 1);
    expect(ratio(geometry.media.width, geometry.workspace.width)).toBeCloseTo(0.22, 1);
    expect(ratio(geometry.preview.width, geometry.workspace.width)).toBeCloseTo(0.53, 1);
    expect(ratio(geometry.attribute.width, geometry.workspace.width)).toBeCloseTo(0.25, 1);

    // Every group keeps its 28px tab strip with a visible title — except a
    // solo Preview, whose strip (and drag handle) is hidden until another
    // Panel joins its group.
    for (const label of [
      "Media Pool",
      "Timeline",
      "Attribute",
      "Effect",
      "Nearby",
    ]) {
      await expect(
        page.locator(".weft-dock-tab-label", { hasText: label }),
      ).toBeVisible();
    }
    await expect(
      page.locator(".weft-dock-tab-label", { hasText: "Preview" }),
    ).not.toBeVisible();

    const minimumSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getMinimumSize(),
    );
    expect(minimumSize).toEqual([960, 640]);
  } finally {
    await app.close();
  }
});

test("every tab closes directly, and its right-click menu carries batch close actions", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-dock-menu-");
    await newProject(page, {
      parentFolder: parent,
      name: "dock-tab-menu",
      canvas: CANVAS,
    });

    // A solo tab has its own close button, and its menu offers Close plus
    // Close All — no Close Others while it is alone in its group.
    const mediaTab = page.getByTitle("Move Media Pool");
    await expect(
      mediaTab.getByRole("button", { name: "Close Media Pool" }),
    ).toBeVisible();
    await mediaTab.click({ button: "right" });
    const soloItems = page.locator(".dv-context-menu-item");
    await expect(soloItems).toHaveCount(2);
    await expect(soloItems.nth(0)).toHaveText("Close");
    await expect(soloItems.nth(1)).toHaveText("Close All");
    await soloItems.nth(0).click();
    await expect(page.locator('[data-panel-kind="media"]')).toHaveCount(0);

    // In a multi-Panel group the menu gains Close Others, which closes the
    // group's other tabs and keeps the right-clicked one.
    await page.getByTitle("Move Attribute").click({ button: "right" });
    const groupItems = page.locator(".dv-context-menu-item");
    await expect(groupItems).toHaveCount(3);
    await expect(groupItems.nth(1)).toHaveText("Close Others");
    await groupItems.nth(1).click();
    await expect(page.locator('[data-panel-kind="attribute"]')).toHaveCount(1);
    await expect(page.locator('[data-panel-kind="effect"]')).toHaveCount(0);
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("closing Preview destroys its resources and reopening creates a new instance", async () => {
  // Fresh userData: this test reopens Preview into its remembered spot, which
  // requires the pristine built-in layout rather than a leaked prior arrangement.
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-dock-life-");
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
    await page.locator(".app-menu-item").filter({ hasText: /^Preview$/ }).click();
    await viewMenu.click();
    await page
      .locator(".app-menu-item")
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
    await page.locator(".app-menu-item").filter({ hasText: /^Preview$/ }).click();
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
  // Fresh userData: the test drags the Effect tab onto Preview from the known
  // built-in positions; a leaked layout would move those drag targets.
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-dock-hide-");
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
    // Center-merge onto Preview's content. Native dragTo: the manual
    // mouse-gesture helper does not reliably drive HTML5 center drops on
    // Windows (edge drops are fine — see dragDockTab).
    await page
      .getByTitle("Move Effect")
      .dragTo(page.locator('[data-panel-kind="preview"]'));

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

test("Effect card pointer reordering never disturbs the Dock Tree, and Panel tabs never reorder Effects", async () => {
  // Own userData dir: the test moves Panels, and the autosaved current layout
  // must neither read from nor pollute the shared default userData.
  const userDataDir = tmpDir("weftcut-dock-fx-data-");
  const { app, page } = await launchApp({ userDataDir });
  try {
    const parent = tmpDir("weftcut-dock-fx-");
    await newProject(page, {
      parentFolder: parent,
      name: "dock-effect-reorder",
      canvas: CANVAS,
    });

    // A visual Layer carrying a three-effect chain; blur/chromakey are the two
    // catalog kinds, so the chromakey card's color-pick button doubles as a
    // visual order marker inside the Panel.
    const layerId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0,
      durationUs: 3_000_000,
    });
    const effectIds: string[] = [];
    for (const kind of ["blur", "chromakey", "blur"]) {
      effectIds.push(await invokeCmd<string>(page, "add_effect", { layerId, kind }));
    }
    await page.evaluate(
      (id) => (window as any).__weftcutTest.revealLayer({ layerId: id }),
      layerId,
    );

    const effectOrder = async (): Promise<string[]> => {
      const s = await summary(page);
      for (const track of s.tracks) {
        for (const layer of track.layers as Array<{ id: string; effects?: Array<{ id: string }> }>) {
          if (layer.id === layerId) return (layer.effects ?? []).map((e) => e.id);
        }
      }
      throw new Error("layer not found in summary");
    };
    const panelKinds = async () =>
      (await page
        .locator("[data-panel-kind]")
        .evaluateAll((panels) => panels.map((p) => p.getAttribute("data-panel-kind")))).sort();
    const visibleTabLabels = async () =>
      page
        .locator(".weft-dock-tab-label")
        .evaluateAll((els) =>
          els.filter((el) => el.checkVisibility()).map((el) => el.textContent),
        );

    // Effect opens inactive in the contextual tab group; activate its tab.
    await page.locator(".weft-dock-tab-label", { hasText: "Effect" }).click();
    await page.getByTestId("effect-drag-0").waitFor({ state: "visible" });
    expect(await effectOrder()).toEqual(effectIds);

    // Pointer drag: card 0 (blur) below card 2. The gesture shows a live
    // target but issues no command before the pointer is released.
    const grip = await page.getByTestId("effect-drag-0").boundingBox();
    const lastRow = await page.getByTestId("effect-row-2").boundingBox();
    if (!grip || !lastRow) throw new Error("effect cards not laid out");
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(lastRow.x + 30, lastRow.y + lastRow.height - 2, { steps: 8 });
    await expect(page.getByTestId("effect-row-2")).toHaveClass(/prop-effect-row--drop-after/);
    expect(await effectOrder()).toEqual(effectIds); // nothing committed mid-gesture
    await page.mouse.up();

    const reordered = [effectIds[1]!, effectIds[2]!, effectIds[0]!];
    await expect.poll(effectOrder).toEqual(reordered);

    // One gesture = one undo entry: a single undo restores the original chain.
    await invokeCmd(page, "project_undo", {});
    await expect.poll(effectOrder).toEqual(effectIds);
    await invokeCmd(page, "project_redo", {});
    await expect.poll(effectOrder).toEqual(reordered);

    // The card gesture never touched the Dock Tree. Preview sits solo, so its
    // tab strip (and label) is hidden; every other group's tab shows.
    const defaultPanelSet = ["attribute", "effect", "media", "nearby", "preview", "timeline"];
    expect(await panelKinds()).toEqual(defaultPanelSet);
    expect(await visibleTabLabels()).toEqual([
      "Media Pool",
      "Attribute",
      "Effect",
      "Nearby",
      "Timeline",
    ]);

    // The converse isolation: docking the Effect Panel tab must not reorder
    // the chain. Drop the Effect tab onto Preview's group center — a real
    // merge, which also brings Preview's strip back for tab switching.
    // (Native dragTo: the manual gesture helper is unreliable for HTML5
    // center drops on Windows.)
    await page
      .getByTitle("Move Effect")
      .dragTo(page.locator('[data-panel-kind="preview"]'));
    await expect.poll(async () => (await visibleTabLabels()).sort()).toEqual([
      "Attribute",
      "Effect",
      "Media Pool",
      "Nearby",
      "Preview",
      "Timeline",
    ]);
    expect(await panelKinds()).toEqual(defaultPanelSet);
    expect(await effectOrder()).toEqual(reordered);
  } finally {
    await app.close();
  }
});

test("View menu creates a custom Workspace from the current arrangement and switches without a save prompt", async () => {
  // Own userData dir: this test mutates the app-level Workspace document, so it
  // must not read from or pollute the shared default userData.
  const userDataDir = tmpDir("weftcut-ws-ui-data-");
  const { app, page } = await launchApp({ userDataDir });
  try {
    const parent = tmpDir("weftcut-ws-ui-");
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
      .locator(".app-menu-item")
      .filter({ hasText: /Save Workspace As|工作区另存为/ })
      .click();
    await page.getByLabel(/Workspace name|工作区名称/).fill("Cutting");
    await page.getByRole("button", { name: /^(Save|保存)$/ }).click();

    // Close a Panel so the two Workspaces diverge, then confirm it persisted.
    await viewMenu.click();
    await page.locator(".app-menu-item").filter({ hasText: /^Nearby$/ }).click(); // focus Nearby
    await viewMenu.click();
    await page
      .locator(".app-menu-item")
      .filter({ hasText: /Close Active Panel|关闭活动面板/ })
      .click();
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(0);

    // The View menu now lists both Workspaces.
    await viewMenu.click();
    await expect(page.locator(".app-menu-item").filter({ hasText: cuttingItem })).toHaveCount(1);
    await expect(page.locator(".app-menu-item").filter({ hasText: editingItem })).toHaveCount(1);

    // Switch to Editing — no save prompt — and the full default set returns.
    await page.locator(".app-menu-item").filter({ hasText: editingItem }).click();
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(1);

    // Switch back to Cutting: its diverged arrangement (Nearby closed) is restored.
    await viewMenu.click();
    await page.locator(".app-menu-item").filter({ hasText: cuttingItem }).click();
    await expect(page.locator('[data-panel-kind="nearby"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("named Workspaces, active selection, and baselines survive a restart", async () => {
  const userDataDir = tmpDir("weftcut-ws-restart-");
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
    const parent = tmpDir("weftcut-ws-r1-");
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
