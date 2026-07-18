import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  invokeCmd,
  launchFreshApp,
  newProject,
  waitForHook,
} from "./helpers/driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Two overlapping caption Tracks, three cues — the same corpus fixture the
// Caption Panel spec seeds from (see caption-corpus.spec.ts).
const SRT_PATH = path.resolve(__dirname, "../fixtures/subtitles/overlapping.srt");

// Cross-Panel Electron integration acceptance. This file exercises the Dock
// Workspace as one editor workflow and protects the integration seams: focus,
// maximize, empty recovery, edge splits, Preview
// resource continuity across the dock op matrix, and the invariant that layout
// mutations never touch the Project or its undo history.
//
// Every test launches over a fresh, empty userData (launchFreshApp) so it boots
// the pristine built-in Editing baseline; the app-level Workspace document
// otherwise persists layout across launches and would leak between specs.
//
// Observability is WeftCut-owned: `dockWorkspaceProbe()` reports open Panels,
// the focused/active Panel, the maximized Panel, and emptiness; `data-panel-*`
// attributes and `project_summary` carry the rest. No test asserts on Dockview's
// private DOM, group classes, or serialized JSON.

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
const DEFAULT_PANELS = [
  "attribute",
  "effect",
  "media",
  "nearby",
  "preview",
  "timeline",
];

interface DockProbe {
  openPanels: string[];
  activePanel: string | null;
  maximizedPanel: string | null;
  empty: boolean;
}

const probe = (page: Page): Promise<DockProbe | null> =>
  page.evaluate(
    () =>
      (window as { __weftcutTest?: { dockWorkspaceProbe?: () => DockProbe | null } })
        .__weftcutTest?.dockWorkspaceProbe?.() ?? null,
  );

const activePanel = async (page: Page): Promise<string | null> =>
  (await probe(page))?.activePanel ?? null;
const maximizedPanel = async (page: Page): Promise<string | null> =>
  (await probe(page))?.maximizedPanel ?? null;

const panelKinds = async (page: Page): Promise<string[]> =>
  (
    await page
      .locator("[data-panel-kind]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-panel-kind")))
  )
    .filter((k): k is string => k !== null)
    .sort();

/// The tab labels currently visible in a compact multi-Panel tab strip. A
/// single-Panel group shows none (its header is a compact drag-handle overlay).
const visibleTabLabels = async (page: Page): Promise<string[]> =>
  page
    .locator(".weft-dock-tab-label")
    .evaluateAll((els) =>
      els.filter((el) => el.checkVisibility()).map((el) => el.textContent ?? ""),
    );

const panelVisible = (page: Page, kind: string): Promise<boolean> =>
  page
    .locator(`[data-panel-kind="${kind}"]`)
    .evaluate((el) => el.getAttribute("data-panel-visible") === "true");

interface HistoryView {
  len: number;
  cursor: number;
}
const history = async (page: Page): Promise<HistoryView> => {
  const s = await invokeCmd<{ history: HistoryView }>(page, "project_summary", {});
  return s.history;
};

const rect = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`missing ${sel}`);
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, selector);

/// Read a number until two consecutive reads agree — waits out Dockview's
/// post-relayout size settling (maximize/restore re-applies the grid across a
/// couple of frames) before a geometry assertion measures it.
async function settled(read: () => Promise<number>): Promise<number> {
  let last = Number.NaN;
  for (let i = 0; i < 40; i++) {
    const value = await read();
    if (Math.abs(value - last) < 0.5) return value;
    last = value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}
const settledWidth = (page: Page, selector: string) =>
  settled(async () => (await rect(page, selector)).width);

const viewMenuTrigger = (page: Page) => page.locator(".menu-trigger").nth(2);
const CLOSE_ACTIVE = /Close Active Panel|关闭活动面板/;

async function setupEditor(page: Page, name: string): Promise<void> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `weftcut-${name}-proj-`));
  await newProject(page, { parentFolder: parent, name, canvas: CANVAS });
  await expect(page.locator("[data-panel-kind]")).toHaveCount(6);
}

test("focus cycles Panels in both directions and maximize/restore leaves the Dock Tree unchanged", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-focus-");
  try {
    await setupEditor(page, "dock-focus");

    // Click a Panel so the window holds keyboard focus on a non-editable surface
    // (the global focus-cycle shortcuts suppress inside text fields).
    await page.locator('[data-panel-kind="preview"]').click();
    const before = await activePanel(page);
    expect(before).not.toBeNull();

    // Ctrl+Shift+Period cycles focus forward; Ctrl+Shift+Comma is its inverse.
    // (Named punctuation keys match on event.code — see shortcuts/match.ts.)
    await page.keyboard.press("Control+Shift+Period");
    await expect.poll(() => activePanel(page)).not.toBe(before);
    await page.keyboard.press("Control+Shift+Comma");
    await expect.poll(() => activePanel(page)).toBe(before);

    // Double-click a Panel's drag handle to maximize it: the Dock Tree is
    // untouched (still six Panels), the snapshot reports the runtime maximize
    // overlay, and Preview fills the workspace while the others go non-visible.
    const workspaceWidth = (await rect(page, ".dock-workspace")).width;
    await page.getByTitle("Move Preview").dblclick();
    await expect.poll(() => maximizedPanel(page)).toBe("preview");
    expect(await panelKinds(page)).toEqual(DEFAULT_PANELS);
    const maximized = await settledWidth(page, '[data-panel-kind="preview"]');
    expect(maximized / workspaceWidth).toBeGreaterThan(0.9);

    // A second double-click reverses the overlay: no Panel is maximized, the tree
    // is still the six built-in Panels (maximize never persisted), and the layout
    // is a genuine multi-column split again — Preview back to a shared column
    // alongside Media and Timeline (both single-Panel groups, so robustly visible).
    await page.getByTitle("Move Preview").dblclick();
    await expect.poll(() => maximizedPanel(page)).toBeNull();
    expect(await panelKinds(page)).toEqual(DEFAULT_PANELS);
    const restored = await settledWidth(page, '[data-panel-kind="preview"]');
    expect(restored / workspaceWidth).toBeLessThan(0.8);
    for (const kind of ["media", "timeline"]) {
      expect(await panelVisible(page, kind)).toBe(true);
      expect((await rect(page, `[data-panel-kind="${kind}"]`)).width).toBeGreaterThan(0);
    }

    // The backquote command maximizes the Panel under the pointer, not just the
    // focused one, and toggles back off.
    await page.locator('[data-panel-kind="timeline"]').hover();
    await page.keyboard.press("Backquote");
    await expect.poll(() => maximizedPanel(page)).toBe("timeline");
    await page.keyboard.press("Backquote");
    await expect.poll(() => maximizedPanel(page)).toBeNull();
  } finally {
    await app.close();
  }
});

test("closing every Panel shows the recovery view, and Open Panel + Reset restore the workspace", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-empty-");
  try {
    await setupEditor(page, "dock-empty");

    // Close every Panel through View > Close Active Panel. Closing the active
    // Panel promotes a new one; six passes empties the whole workspace.
    for (let i = 0; i < 6; i++) {
      await viewMenuTrigger(page).click();
      await page.locator(".app-menu-item").filter({ hasText: CLOSE_ACTIVE }).click();
    }
    await expect(page.locator("[data-panel-kind]")).toHaveCount(0);
    await expect.poll(() => probe(page).then((p) => p?.empty ?? false)).toBe(true);

    // The empty workspace is a valid state, not a corrupt one: it renders the
    // recovery region with Open Panel + Reset Workspace instead of a blank hole.
    const recovery = page.getByRole("region", { name: /Empty workspace/i });
    await expect(recovery).toBeVisible();
    await expect(recovery.getByRole("button", { name: /Reset Workspace/i })).toBeVisible();

    // Open Panel → Timeline reopens exactly that one Panel.
    await recovery.locator(".menu-trigger").click();
    await page.locator(".app-menu-item").filter({ hasText: /^Timeline$/ }).click();
    await expect(page.locator('[data-panel-kind="timeline"]')).toHaveCount(1);
    await expect(page.locator("[data-panel-kind]")).toHaveCount(1);

    // Close it again and Reset Workspace from the recovery view rebuilds the
    // full built-in Editing set.
    await viewMenuTrigger(page).click();
    await page.locator(".app-menu-item").filter({ hasText: CLOSE_ACTIVE }).click();
    await expect(page.locator("[data-panel-kind]")).toHaveCount(0);
    await page
      .getByRole("region", { name: /Empty workspace/i })
      .getByRole("button", { name: /Reset Workspace/i })
      .click();
    await expect(page.locator("[data-panel-kind]")).toHaveCount(6);
    expect(await panelKinds(page)).toEqual(DEFAULT_PANELS);
  } finally {
    await app.close();
  }
});

test("dragging a tab past another reorders it within the multi-Panel group", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-tabreorder-");
  try {
    await setupEditor(page, "dock-tabreorder");

    // The contextual group tabs Attribute, Effect, Nearby in that DOM order.
    const before = await visibleTabLabels(page);
    expect(before).toEqual(["Attribute", "Effect", "Nearby"]);

    // Drag the Attribute tab onto the Nearby tab. Dropping on a tab (not a
    // content region) reorders within the group rather than restacking: Attribute
    // is no longer first, the group still holds the same three tabs, and nothing
    // opened or closed.
    await page
      .getByTitle("Move Attribute")
      .dragTo(page.getByTitle("Move Nearby"));
    await expect.poll(async () => (await visibleTabLabels(page))[0]).not.toBe("Attribute");
    expect((await visibleTabLabels(page)).slice().sort()).toEqual(before.slice().sort());
    expect(await panelKinds(page)).toEqual(DEFAULT_PANELS);
  } finally {
    await app.close();
  }
});

test("an edge drop splits a Panel into its own group beside the target", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-split-");
  try {
    await setupEditor(page, "dock-split");

    // Nearby starts tabbed with Attribute and Effect in the contextual group, so
    // only the active contextual tab is visible; Nearby's content is hidden.
    expect(await panelVisible(page, "nearby")).toBe(false);
    expect((await visibleTabLabels(page)).sort()).toEqual([
      "Attribute",
      "Effect",
      "Nearby",
    ]);

    // Drag Nearby's tab to the LEFT edge of Timeline. An edge drop must create a
    // new split, not a tab stack: after it, Nearby is its own group beside
    // Timeline and BOTH are visible simultaneously (a center/tab drop would keep
    // only one of a shared group visible at a time).
    const timeline = await rect(page, '[data-panel-kind="timeline"]');
    await page
      .getByTitle("Move Nearby")
      .dragTo(page.locator('[data-panel-kind="timeline"]'), {
        targetPosition: { x: 8, y: Math.round(timeline.height / 2) },
      });

    await expect.poll(() => panelVisible(page, "nearby")).toBe(true);
    expect(await panelVisible(page, "timeline")).toBe(true);
    // Still the six built-in Panels open, just re-split into a new group.
    expect(await panelKinds(page)).toEqual(DEFAULT_PANELS);
    // Nearby left the contextual strip; Attribute and Effect remain tabbed there.
    await expect
      .poll(async () => (await visibleTabLabels(page)).filter((l) => l !== "").sort())
      .toEqual(["Attribute", "Effect"]);
    // Nearby now sits to the left of Timeline.
    const nearby = await rect(page, '[data-panel-kind="nearby"]');
    const timelineAfter = await rect(page, '[data-panel-kind="timeline"]');
    expect(nearby.x).toBeLessThan(timelineAfter.x);
  } finally {
    await app.close();
  }
});

test("Preview keeps its resource identity through maximize, restore, and a dock move", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-preview-matrix-");
  try {
    await setupEditor(page, "dock-preview-matrix");
    await invokeCmd(page, "add_color_layer", { tStartUs: 0, durationUs: 3_000_000 });

    const readProbe = () =>
      page.evaluate(
        () =>
          (
            window as {
              __weftcutTest?: {
                previewResourceProbe?: () => {
                  generation: number;
                  positionUs: number;
                } | null;
              };
            }
          ).__weftcutTest?.previewResourceProbe?.() ?? null,
      );
    await expect.poll(readProbe).not.toBeNull();

    // Start playback so the clock is advancing — a resource re-create would reset
    // generation and stall the position.
    await page.locator(".transport-buttons button").nth(1).click();
    const start = (await readProbe())!;

    // Maximize Preview and restore it. The Playback Engine + Compositor must
    // survive: same generation, position still advancing.
    await page.getByTitle("Move Preview").dblclick();
    await expect.poll(() => maximizedPanel(page)).toBe("preview");
    await page.getByTitle("Move Preview").dblclick();
    await expect.poll(() => maximizedPanel(page)).toBeNull();
    const afterMaximize = (await readProbe())!;
    expect(afterMaximize.generation).toBe(start.generation);

    // Move a tool Panel into Preview's group (Preview becomes a hidden tab), then
    // reactivate Preview. Docking must never recreate the resource.
    await page
      .getByTitle("Move Effect")
      .dragTo(page.locator('[data-panel-kind="preview"]'), {
        targetPosition: { x: 240, y: 140 },
      });
    await page.getByTitle("Move Preview").click();
    const afterMove = (await readProbe())!;
    expect(afterMove.generation).toBe(start.generation);

    await expect
      .poll(async () => (await readProbe())!.positionUs)
      .toBeGreaterThan(start.positionUs);
  } finally {
    await app.close();
  }
});

test("Workspace mutations never change Project undo depth, and a business edit adds exactly one entry", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-undo-");
  try {
    await setupEditor(page, "dock-undo");

    const layerCount = async (): Promise<number> => {
      const s = await invokeCmd<{ tracks: Array<{ layers: unknown[] }> }>(
        page,
        "project_summary",
        {},
      );
      return s.tracks.reduce((n, t) => n + t.layers.length, 0);
    };

    const layers0 = await layerCount();

    // A business mutation advances the Project undo history and adds content.
    await invokeCmd(page, "add_color_layer", { tStartUs: 0, durationUs: 1_000_000 });
    await expect.poll(layerCount).toBe(layers0 + 1);
    const layers1 = layers0 + 1;
    // Let any trailing commit (composition autofit) settle, then take the
    // post-edit history as the baseline the layout ops must not disturb.
    await settled(async () => (await history(page)).cursor);
    const h1 = await history(page);
    expect(h1.cursor).toBeGreaterThan(0);

    // Layout mutations — open a Panel, close it, maximize/restore, reset — go to
    // the app-level Workspace document only. None may dirty the Project or move
    // its undo cursor/depth.
    await viewMenuTrigger(page).click();
    await page.locator(".app-menu-item").filter({ hasText: /^Caption$/ }).click();
    await expect(page.locator('[data-panel-kind="caption"]')).toHaveCount(1);

    await viewMenuTrigger(page).click();
    await page.locator(".app-menu-item").filter({ hasText: CLOSE_ACTIVE }).click();
    await expect(page.locator('[data-panel-kind="caption"]')).toHaveCount(0);

    await page.getByTitle("Move Preview").dblclick();
    await expect.poll(() => maximizedPanel(page)).toBe("preview");
    await page.getByTitle("Move Preview").dblclick();
    await expect.poll(() => maximizedPanel(page)).toBeNull();

    const h2 = await history(page);
    expect(h2.len).toBe(h1.len);
    expect(h2.cursor).toBe(h1.cursor);
    // The layout churn changed no Project content.
    expect(await layerCount()).toBe(layers1);

    // The business edit still sits on the undo stack — the layout churn neither
    // dirtied nor consumed history. Undoing returns the Project to its pre-edit
    // layer set (bounded loop: the add is agnostic about its exact commit count).
    for (let i = 0; i < 3 && (await layerCount()) > layers0; i++) {
      await invokeCmd(page, "project_undo", {});
    }
    expect(await layerCount()).toBe(layers0);
    expect((await history(page)).cursor).toBeLessThan(h2.cursor);
  } finally {
    await app.close();
  }
});

test("selection and business Panels keep working after a Panel move and a Workspace switch", async () => {
  const { app, page } = await launchFreshApp("weftcut-dock-xpanel-");
  try {
    await setupEditor(page, "dock-xpanel");

    // A visual Layer with a two-Effect chain, selected as the primary Layer.
    const layerId = await invokeCmd<string>(page, "add_color_layer", {
      tStartUs: 0,
      durationUs: 3_000_000,
    });
    const effectIds: string[] = [];
    for (const kind of ["blur", "chromakey"]) {
      effectIds.push(await invokeCmd<string>(page, "add_effect", { layerId, kind }));
    }
    await page.evaluate(
      (id) =>
        (
          window as { __weftcutTest?: { revealLayer?: (a: { layerId: string }) => void } }
        ).__weftcutTest?.revealLayer?.({ layerId: id }),
      layerId,
    );

    const effectOrder = async (): Promise<string[]> => {
      const s = await invokeCmd<{
        tracks: Array<{ layers: Array<{ id: string; effects?: Array<{ id: string }> }> }>;
      }>(page, "project_summary", {});
      for (const track of s.tracks) {
        for (const layer of track.layers) {
          if (layer.id === layerId) return (layer.effects ?? []).map((e) => e.id);
        }
      }
      throw new Error("layer missing from summary");
    };

    // The shared selection model reaches every Panel: Effect shows the chain and
    // Attribute leaves its no-selection placeholder.
    await page.locator(".weft-dock-tab-label", { hasText: "Effect" }).click();
    await expect(page.getByTestId("effect-drag-0")).toBeVisible();
    await expect(page.getByTestId("effect-drag-1")).toBeVisible();
    await page.locator(".weft-dock-tab-label", { hasText: "Attribute" }).click();
    await expect(page.locator('[data-panel-kind="attribute"] .placeholder')).toHaveCount(0);
    // Attribute is bound to the primary Layer: the Start timing field (whose edits
    // route through the same move/trim commands Timeline gestures use) is present
    // for the selection.
    await expect(
      page
        .locator('[data-panel-kind="attribute"]')
        .getByRole("textbox", { name: /^(Start|开始)$/ }),
    ).toBeVisible();

    // Move the Effect Panel into Preview's group. Selection and the chain survive
    // the dock move, and the keyboard move-down command still reorders (one undo).
    await page
      .getByTitle("Move Effect")
      .dragTo(page.locator('[data-panel-kind="preview"]'), {
        targetPosition: { x: 240, y: 140 },
      });
    await page.getByTitle("Move Effect").click();
    await expect(page.getByTestId("effect-drag-0")).toBeVisible();
    expect(await effectOrder()).toEqual(effectIds);

    const undoBefore = (await history(page)).len;
    await page.getByTestId("effect-down-0").click();
    const reordered = [effectIds[1]!, effectIds[0]!];
    await expect.poll(effectOrder).toEqual(reordered);
    expect((await history(page)).len).toBe(undoBefore + 1);

    // Save the moved arrangement as a custom Workspace, bounce to Editing and
    // back. The layout round-trips through persistence with reuse-existing-panels,
    // so the selected Layer and its reordered chain are still there afterwards.
    await viewMenuTrigger(page).click();
    await page
      .locator(".app-menu-item")
      .filter({ hasText: /Save Workspace As|工作区另存为/ })
      .click();
    await page.getByLabel(/Workspace name|工作区名称/).fill("Grading");
    await page.getByRole("button", { name: /^(Save|保存)$/ }).click();

    await viewMenuTrigger(page).click();
    await page.locator(".app-menu-item").filter({ hasText: /^(Editing|编辑)$/ }).click();
    await viewMenuTrigger(page).click();
    await page.locator(".app-menu-item").filter({ hasText: /^Grading$/ }).click();

    // Effect still owns the reordered chain and the primary Layer is still edited
    // in Attribute after the Workspace switch.
    await page.getByTitle("Move Effect").click();
    await expect(page.getByTestId("effect-drag-0")).toBeVisible();
    expect(await effectOrder()).toEqual(reordered);
    await page.locator(".weft-dock-tab-label", { hasText: "Attribute" }).click();
    await expect(page.locator('[data-panel-kind="attribute"] .placeholder')).toHaveCount(0);
    // Attribute is bound to the primary Layer: the Start timing field (whose edits
    // route through the same move/trim commands Timeline gestures use) is present
    // for the selection.
    await expect(
      page
        .locator('[data-panel-kind="attribute"]')
        .getByRole("textbox", { name: /^(Start|开始)$/ }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("Caption cue navigation still selects and seeks after the Caption Panel moves", async () => {
  test.skip(!fs.existsSync(SRT_PATH), `subtitle fixture missing: ${SRT_PATH}`);
  const { app, page } = await launchFreshApp("weftcut-dock-caption-move-");
  try {
    await setupEditor(page, "dock-caption-move");

    // Seed the corpus via the real subtitle-import path (two caption Tracks).
    await invokeCmd(page, "import_media", { path: SRT_PATH });

    // Open the initially-closed Caption Panel.
    await viewMenuTrigger(page).click();
    await page.locator(".app-menu-item").filter({ hasText: /^Caption$/ }).click();
    const caption = page.locator('[data-panel-kind="caption"]');
    await expect(caption).toHaveCount(1);
    await expect(caption.locator(".caption-row")).toHaveCount(3);

    // Move the Caption Panel into Preview's group (it becomes a tab there), then
    // reactivate it — the Panel instance is reused, so its cue list persists.
    await page
      .getByTitle("Move Caption")
      .dragTo(page.locator('[data-panel-kind="preview"]'), {
        targetPosition: { x: 240, y: 140 },
      });
    await page.getByTitle("Move Caption").click();
    await expect(caption.locator(".caption-row")).toHaveCount(3);

    // After the move, activating a cue still drives the shared selection model:
    // it seeks the playhead off 0 to the cue start and marks the cue's row (its
    // Text Layer becomes the primary selection through the same host wiring).
    await waitForHook(page, "getPlayheadUs");
    await caption.locator(".caption-seek").last().click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as { __weftcutTest?: { getPlayheadUs?: () => number } })
              .__weftcutTest?.getPlayheadUs?.() ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    await expect(caption.locator(".caption-row.is-selected")).toHaveCount(1);
    await expect(caption.locator(".caption-row").last()).toHaveClass(/is-selected/);
  } finally {
    await app.close();
  }
});
