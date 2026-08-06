import { expect, test } from "@playwright/test";

import {
  dockPanel,
  dockTab,
  dragDockTab,
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
    // `.weft-dock-panel` prefix required throughout: `[data-panel-kind]` alone
    // also matches each Panel's tab, so a bare selector double-counts.
    await expect(page.locator(".weft-dock-panel[data-panel-kind]")).toHaveCount(7);
    for (const kind of [
      "media",
      "preview",
      "timeline",
      "quick-actions",
      "attribute",
      "effect",
      "nearby",
    ]) {
      await expect(
        page.locator(`.weft-dock-panel[data-panel-kind="${kind}"]`),
      ).toHaveCount(1);
    }
    await expect(
      page.locator('.weft-dock-panel[data-panel-kind="caption"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('.weft-dock-panel[data-panel-kind="role-mixer"]'),
    ).toHaveCount(0);

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
          // `.weft-dock-panel` prefix required: a bare `[data-panel-kind]`
          // matches the Panel's TAB first in document order, so these ratios
          // would silently measure tab strips instead of Panels.
          strip: rect('.weft-dock-panel[data-panel-kind="quick-actions"]'),
          media: rect('.weft-dock-panel[data-panel-kind="media"]'),
          preview: rect('.weft-dock-panel[data-panel-kind="preview"]'),
          attribute: rect('.weft-dock-panel[data-panel-kind="attribute"]'),
          timeline: rect('.weft-dock-panel[data-panel-kind="timeline"]'),
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
    // The Quick Actions strip is a fixed-width full-height edge bar: it sits
    // beside the body branch, so it spans the Timeline row as well as the
    // editor row.
    expect(geometry.strip.width).toBeLessThan(80);
    expect(ratio(geometry.strip.height, geometry.workspace.height)).toBeCloseTo(1, 1);
    expect(geometry.strip.x).toBeLessThan(geometry.media.x);

    // Every group keeps its 28px tab strip with a visible title — except a solo
    // Preview, whose strip (and drag handle) is hidden until another Panel joins
    // its group, and the Quick Actions strip, whose tab is the grip instead.
    await expect(page.locator(".weft-dock-tab--grip")).toBeVisible();
    await expect(
      page.locator('.weft-dock-tab-label:text-is("Quick Actions")'),
    ).toHaveCount(0);
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

    // Tab a11y contract (WAI-ARIA Tabs): Dockview's `.dv-tab` wrapper is the
    // `role="tab"`, and its accessible name is the label we render inside it —
    // so a tab is reachable by role+name.
    //
    // NOTE for locator authors: a standard tab carries no `title` at all, which
    // is why `getByTitle("Move <Panel>")` matches nothing. The Quick Actions
    // grip is the only tab with a `title`, and even there it sits on the inner
    // div, so it does NOT become the `role="tab"`'s accessible name — the grip
    // tab is unnamed. Locate tabs with `dockTab()`, not by title.
    for (const label of ["Media Pool", "Timeline", "Attribute", "Effect", "Nearby"]) {
      await expect(page.getByRole("tab", { name: label })).toHaveCount(1);
    }

    const minimumSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getMinimumSize(),
    );
    expect(minimumSize).toEqual([960, 640]);
  } finally {
    await app.close();
  }
});

/**
 * The Quick Actions strip has no tab: its single tab renders as the six-dot
 * grip, shrunk to grip size and left in normal flow, with the whole group header
 * moved to the strip's leading edge (`headerPosition`) so the grip sits inline
 * with the buttons. The grip the user sees therefore IS Dockview's own drag
 * source.
 *
 * This is the ONE part of the strip that unit tests cannot reach — jsdom has no
 * layout and no real drag — and it is also the part that fails SILENTLY when the
 * arrangement drifts: the grip still paints, it just stops being draggable
 * (exactly what happened when the header was overlaid on the Panel content,
 * which `renderer: "always"` paints in a layer above the entire grid). Hence a
 * real pointer gesture here.
 */
test("the Quick Actions grip drags the strip, which flips axis to match its new shape", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-quick-actions-");
    await newProject(page, {
      parentFolder: parent,
      name: "quick-actions-drag",
      canvas: CANVAS,
    });
    // REQUIRED before any pointer gesture: the splash overlay outlives the
    // first dock render, so the grip is already visible while the splash is
    // still swallowing mousedown — the drag would simply never start.
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

    const grip = page.locator(".weft-dock-tab--grip");
    // The drag must be started from the grip's `.dv-tab` box (what `dockTab`
    // returns) — that is the element Dockview marks `draggable`, and
    // Playwright's synthetic pointer sequence does not reliably promote a
    // mousedown on a descendant into a native HTML5 drag. The two boxes are
    // identical on screen: the tab IS the grip slot.
    const gripTab = dockTab(page, "quick-actions");
    const strip = dockPanel(page, "quick-actions");
    // Scoped by class, not by role: the preview transport is a toolbar too.
    const toolbar = page.locator(".weft-quick-actions");

    // Baseline: a full-height left edge bar, so the strip runs as a column.
    await expect(grip).toBeVisible();
    await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
    const before = await strip.boundingBox();
    if (!before) throw new Error("strip has no layout box");
    expect(before.height).toBeGreaterThan(before.width);

    // Drop below the Timeline: the strip becomes a wide, short row.
    await dragDockTab(page, gripTab, dockPanel(page, "timeline"), "bottom");

    await expect
      .poll(async () => {
        const box = await strip.boundingBox();
        return box ? box.width > box.height : false;
      })
      .toBe(true);
    // Axis follows shape with no user input — and the grip survives the move,
    // which is what proves the repositioned tab really was the drag source.
    await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
    await expect(grip).toBeVisible();
    await expect(grip).toHaveAttribute("data-orientation", "horizontal");
  } finally {
    await app.close();
  }
});

/**
 * Tab chrome is deliberately bare. A Panel tab carries NO close button and no
 * right-click menu: the workspace passes no `getTabContextMenuItems`, so
 * Dockview's own Close / Close All / Close Others menu never renders
 * (`DockWorkspace.test.tsx` asserts the prop stays undefined). Closing goes
 * through View > Close Active Panel, a middle-click on an overflow row, or —
 * for the tabless Quick Actions strip — the grip's own menu.
 *
 * Both halves are here because both are upgrade-fragile: a dockview release that
 * starts rendering its default tab actions would silently put close buttons back
 * on every tab, and the grip menu is the strip's ONLY in-place dismissal (it has
 * no tab to close from).
 */
test("tabs carry no close chrome, and the Quick Actions grip closes its strip", async () => {
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir("weftcut-dock-menu-");
    await newProject(page, {
      parentFolder: parent,
      name: "dock-tab-menu",
      canvas: CANVAS,
    });
    // REQUIRED before any pointer gesture: the splash overlay outlives the
    // first dock render and swallows mousedown while the target is visible.
    await expect(page.locator(".splash-screen")).toHaveCount(0, { timeout: 15_000 });

    // No tab exposes a close control, solo or grouped.
    await expect(page.locator(".dv-tab button")).toHaveCount(0);
    await expect(page.locator(".dv-default-tab-action")).toHaveCount(0);

    // Right-clicking a tab opens nothing at all — neither Dockview's menu nor
    // one of ours. Checked on a solo tab and on a tab inside a shared group —
    // the solo and grouped tab shapes.
    for (const kind of ["media", "attribute"]) {
      await dockTab(page, kind).click({ button: "right" });
      await expect(page.locator(".dv-context-menu-item")).toHaveCount(0);
      await expect(page.locator(".app-menu-list")).toHaveCount(0);
    }

    // The grip DOES have a menu, holding exactly one item, and it closes the
    // strip. Every other Panel is left alone.
    await dockTab(page, "quick-actions").click({ button: "right" });
    const gripItems = page.locator(".app-menu-list .app-menu-item");
    await expect(gripItems).toHaveCount(1);
    await expect(gripItems).toHaveText(/Close Panel|关闭面板/);
    await gripItems.click();
    await expect(dockPanel(page, "quick-actions")).toHaveCount(0);
    await expect(dockPanel(page)).toHaveCount(6);
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

    await expect(page.locator('.weft-dock-panel[data-panel-kind="preview"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__weftcutTest.previewResourceProbe(),
        ),
      )
      .toBeNull();

    await viewMenu.click();
    await page.locator(".app-menu-item").filter({ hasText: /^Preview$/ }).click();
    await expect(page.locator('.weft-dock-panel[data-panel-kind="preview"]')).toHaveCount(1);
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
    await dockTab(page, "effect").dragTo(dockPanel(page, "preview"));

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

    await dockTab(page, "preview").click();
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
        .locator(".weft-dock-panel[data-panel-kind]")
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
    const defaultPanelSet = ["attribute", "effect", "media", "nearby", "preview", "quick-actions", "timeline"];
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
    await dockTab(page, "effect").dragTo(dockPanel(page, "preview"));
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
    await expect(page.locator(".weft-dock-panel[data-panel-kind]")).toHaveCount(7);

    const viewMenu = page.locator(".menu-trigger").nth(2);
    // Menu labels are localized (the e2e runtime may be en-US or zh-CN); match
    // both. Panel titles and the user-typed Workspace name are not localized.
    // The built-in profile is presented as "Default Layout", not by its
    // "editing" id.
    const builtinItem = /^(Default Layout|默认布局)$/;
    const cuttingItem = /^Cutting$/;
    const menuItem = (text: RegExp) =>
      page.locator(".app-menu-item").filter({ hasText: text });
    /// Profile switching and the Save/Rename/Delete/Reset ops live one level
    /// down, under the Workspaces submenu. Its trigger reuses `.app-menu-item`,
    /// so items are always matched by text, never by index.
    const openWorkspaces = async () => {
      await viewMenu.click();
      await page
        .locator(".app-submenu-trigger")
        .filter({ hasText: /Workspaces|工作区/ })
        .click();
    };

    // Save as New Workspace… → name dialog → a custom Workspace becomes active.
    await openWorkspaces();
    await menuItem(/Save as New Workspace|另存为新工作区/).click();
    await page.getByLabel(/Workspace name|工作区名称/).fill("Cutting");
    await page.getByRole("button", { name: /^(Save|保存)$/ }).click();

    // Close a Panel so the two Workspaces diverge, then confirm it persisted.
    await viewMenu.click();
    await menuItem(/^Nearby$/).click(); // focus Nearby
    await viewMenu.click();
    await menuItem(/Close Active Panel|关闭活动面板/).click();
    await expect(dockPanel(page, "nearby")).toHaveCount(0);

    // The Workspaces submenu now lists both Workspaces.
    await openWorkspaces();
    await expect(menuItem(cuttingItem)).toHaveCount(1);
    await expect(menuItem(builtinItem)).toHaveCount(1);

    // Switch to the built-in layout — no save prompt — and the full default set
    // returns.
    await menuItem(builtinItem).click();
    await expect(dockPanel(page, "nearby")).toHaveCount(1);

    // Switch back to Cutting: its diverged arrangement (Nearby closed) is restored.
    await openWorkspaces();
    await menuItem(cuttingItem).click();
    await expect(dockPanel(page, "nearby")).toHaveCount(0);
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
