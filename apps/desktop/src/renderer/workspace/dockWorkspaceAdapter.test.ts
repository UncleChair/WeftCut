import { describe, expect, it, vi } from "vitest";
import { type DockviewApi } from "dockview-react";

import {
  DockWorkspaceAdapter,
  isBusinessDockDrag,
} from "./dockWorkspaceAdapter";
import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  EDITING_OPEN_PANEL_KINDS,
  PANEL_KINDS,
  PANEL_REGISTRY,
} from "./panelRegistry";

interface AddedPanel {
  id: string;
  group: FakeGroup;
  api: {
    setActive: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    maximize: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
    exitMaximized: ReturnType<typeof vi.fn>;
  };
}

interface FakeGroup {
  id: string;
  panels: AddedPanel[];
  activePanel: AddedPanel | undefined;
  api: { isMaximized: ReturnType<typeof vi.fn> };
}

function signal<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    event(listener: (event: T) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(event: T) {
      for (const listener of listeners) listener(event);
    },
  };
}

function fakeDockview(width = 1_000, height = 800) {
  const panels = new Map<string, AddedPanel>();
  const groups: FakeGroup[] = [];
  const added: Record<string, unknown>[] = [];
  let groupSequence = 0;
  let activeGroup: FakeGroup | undefined;
  let activePanel: AddedPanel | undefined;
  let maximizedGroup: FakeGroup | undefined;
  let overlayListener:
    | ((event: {
        nativeEvent: { dataTransfer?: Pick<DataTransfer, "types"> };
        preventDefault(): void;
      }) => void)
    | null = null;
  const disposeOverlay = vi.fn();
  const layout = signal<void>();
  const active = signal<{ panel: AddedPanel | undefined; origin: "api" }>();
  const maximized = signal<{ group: FakeGroup; isMaximized: boolean }>();

  function activate(panel: AddedPanel | undefined) {
    activePanel = panel;
    activeGroup = panel?.group;
    if (panel) panel.group.activePanel = panel;
    active.fire({ panel, origin: "api" });
  }

  function close(panel: AddedPanel) {
    panels.delete(panel.id);
    const index = panel.group.panels.indexOf(panel);
    if (index >= 0) panel.group.panels.splice(index, 1);
    if (panel.group.activePanel === panel) {
      panel.group.activePanel = panel.group.panels[Math.min(index, panel.group.panels.length - 1)];
    }
    if (panel.group.panels.length === 0) {
      const groupIndex = groups.indexOf(panel.group);
      if (groupIndex >= 0) groups.splice(groupIndex, 1);
      if (maximizedGroup === panel.group) maximizedGroup = undefined;
    }
    if (activePanel === panel) {
      const next = panel.group.activePanel ?? groups.at(-1)?.activePanel;
      activate(next);
    }
    layout.fire();
  }

  const api = {
    width,
    height,
    get totalPanels() {
      return panels.size;
    },
    get panels() {
      return [...panels.values()];
    },
    get groups() {
      return groups;
    },
    get activePanel() {
      return activePanel;
    },
    get activeGroup() {
      return activeGroup;
    },
    getPanel: vi.fn((id: string) => panels.get(id)),
    addPanel: vi.fn((options: Record<string, unknown>) => {
      const position = options.position as
        | { referencePanel?: string; direction?: string; index?: number }
        | undefined;
      const reference = position?.referencePanel
        ? panels.get(position.referencePanel)
        : undefined;
      let group = position?.direction === "within" && reference
        ? reference.group
        : undefined;
      if (!group) {
        group = {
          id: `group-${++groupSequence}`,
          panels: [],
          activePanel: undefined,
          api: {
            isMaximized: vi.fn(() => maximizedGroup === group),
          },
        };
        groups.push(group);
      }
      const panel: AddedPanel = {
        id: String(options.id),
        group,
        api: {} as AddedPanel["api"],
      };
      panel.api = {
        setActive: vi.fn(() => activate(panel)),
        setSize: vi.fn(),
        close: vi.fn(() => close(panel)),
        maximize: vi.fn(() => {
          maximizedGroup = panel.group;
          maximized.fire({ group: panel.group, isMaximized: true });
        }),
        isMaximized: vi.fn(() => maximizedGroup === panel.group),
        exitMaximized: vi.fn(() => {
          maximizedGroup = undefined;
          maximized.fire({ group: panel.group, isMaximized: false });
        }),
      };
      const index = position?.index ?? group.panels.length;
      group.panels.splice(Math.min(index, group.panels.length), 0, panel);
      if (!group.activePanel || options.inactive !== true) group.activePanel = panel;
      added.push(options);
      panels.set(panel.id, panel);
      if (options.inactive !== true) activate(panel);
      layout.fire();
      return panel;
    }),
    onWillShowOverlay: vi.fn((listener: typeof overlayListener) => {
      overlayListener = listener;
      return { dispose: disposeOverlay };
    }),
    onDidLayoutChange: vi.fn(layout.event),
    onDidActivePanelChange: vi.fn(active.event),
    onDidMaximizedGroupChange: vi.fn(maximized.event),
    moveToNext: vi.fn((options?: { includePanel?: boolean }) => {
      if (groups.length === 0) return;
      if (options?.includePanel && activeGroup && activeGroup.panels.length > 1) {
        const index = activePanel ? activeGroup.panels.indexOf(activePanel) : -1;
        activate(activeGroup.panels[(index + 1) % activeGroup.panels.length]);
        return;
      }
      const index = activeGroup ? groups.indexOf(activeGroup) : -1;
      activate(groups[(index + 1) % groups.length]?.activePanel);
    }),
    moveToPrevious: vi.fn((options?: { includePanel?: boolean }) => {
      if (groups.length === 0) return;
      if (options?.includePanel && activeGroup && activeGroup.panels.length > 1) {
        const index = activePanel ? activeGroup.panels.indexOf(activePanel) : 0;
        activate(
          activeGroup.panels[
            (index - 1 + activeGroup.panels.length) % activeGroup.panels.length
          ],
        );
        return;
      }
      const index = activeGroup ? groups.indexOf(activeGroup) : 0;
      activate(groups[(index - 1 + groups.length) % groups.length]?.activePanel);
    }),
    hasMaximizedGroup: vi.fn(() => maximizedGroup !== undefined),
    exitMaximizedGroup: vi.fn(() => {
      const group = maximizedGroup;
      maximizedGroup = undefined;
      if (group) maximized.fire({ group, isMaximized: false });
    }),
    clear: vi.fn(() => {
      panels.clear();
      groups.splice(0);
      activePanel = undefined;
      activeGroup = undefined;
      maximizedGroup = undefined;
      layout.fire();
    }),
    toJSON: vi.fn(() => ({
      grid: {
        root: {
          type: "branch",
          data: groups.map((group) => ({
            type: "leaf",
            data: {
              views: group.panels.map((panel) => panel.id),
              activeView: group.activePanel?.id,
              id: group.id,
            },
            size: 100,
          })),
          size: 100,
        },
        orientation: "HORIZONTAL",
        width,
        height,
      },
      panels: Object.fromEntries(
        [...panels.keys()].map((id) => [id, { id }]),
      ),
      activeGroup: activeGroup?.id,
    })),
    fromJSON: vi.fn(
      (data: { grid?: { root?: unknown } }, _options?: { reuseExistingPanels: boolean }) => {
        panels.clear();
        groups.splice(0);
        activePanel = undefined;
        activeGroup = undefined;
        maximizedGroup = undefined;
        const walk = (node: unknown) => {
          if (!node || typeof node !== "object") return;
          const n = node as { type?: string; data?: unknown };
          if (n.type === "branch") {
            for (const child of (n.data as unknown[]) ?? []) walk(child);
            return;
          }
          const leaf = n.data as { views?: string[]; activeView?: string; id?: string };
          const group: FakeGroup = {
            id: leaf.id ?? `group-${++groupSequence}`,
            panels: [],
            activePanel: undefined,
            api: { isMaximized: vi.fn(() => maximizedGroup === group) },
          };
          groups.push(group);
          for (const id of leaf.views ?? []) {
            const panel: AddedPanel = { id, group, api: {} as AddedPanel["api"] };
            panel.api = {
              setActive: vi.fn(() => activate(panel)),
              setSize: vi.fn(),
              close: vi.fn(() => close(panel)),
              maximize: vi.fn(),
              isMaximized: vi.fn(() => maximizedGroup === group),
              exitMaximized: vi.fn(),
            };
            group.panels.push(panel);
            panels.set(id, panel);
          }
          group.activePanel =
            group.panels.find((panel) => panel.id === leaf.activeView) ??
            group.panels[0];
        };
        walk(data?.grid?.root);
        activePanel = groups[0]?.activePanel;
        activeGroup = groups[0];
        layout.fire();
      },
    ),
  };

  return {
    api: api as unknown as DockviewApi,
    panels,
    groups,
    added,
    rawApi: api,
    disposeOverlay,
    showOverlay(types: string[]) {
      const preventDefault = vi.fn();
      overlayListener?.({
        nativeEvent: { dataTransfer: { types } },
        preventDefault,
      });
      return preventDefault;
    },
  };
}

describe("Dock Panel registry", () => {
  it("registers exactly the eight semantic singleton kinds", () => {
    expect(PANEL_KINDS).toHaveLength(8);
    expect(new Set(PANEL_KINDS).size).toBe(8);
    expect(Object.keys(PANEL_REGISTRY)).toEqual([...PANEL_KINDS]);
    expect(EDITING_OPEN_PANEL_KINDS).toEqual([
      "media",
      "preview",
      "timeline",
      "attribute",
      "effect",
      "nearby",
    ]);
  });
});

describe("DockWorkspaceAdapter", () => {
  it("builds the built-in 62/38 Editing layout once with Panel constraints", () => {
    const dock = fakeDockview(1_000, 800);
    const adapter = new DockWorkspaceAdapter(dock.api);

    expect(adapter.initializeEditingLayout()).toBe(true);
    expect(adapter.initializeEditingLayout()).toBe(false);
    expect(dock.added.map((panel) => panel.id)).toEqual([
      "media",
      "preview",
      "attribute",
      "effect",
      "nearby",
      "timeline",
    ]);

    const byId = new Map(dock.added.map((panel) => [panel.id, panel]));
    expect(byId.get("media")).toMatchObject({
      initialWidth: 220,
      minimumWidth: 240,
      minimumHeight: 160,
    });
    expect(byId.get("preview")).toMatchObject({
      initialWidth: 530,
      minimumWidth: 320,
      minimumHeight: 180,
      position: { referencePanel: "media", direction: "right" },
    });
    expect(byId.get("attribute")).toMatchObject({
      initialWidth: 250,
      position: { referencePanel: "preview", direction: "right" },
    });
    expect(byId.get("effect")).toMatchObject({
      inactive: true,
      position: { referencePanel: "attribute", direction: "within" },
    });
    expect(byId.get("nearby")).toMatchObject({
      inactive: true,
      position: { referencePanel: "attribute", direction: "within" },
    });
    expect(byId.get("timeline")).toMatchObject({
      initialHeight: 304,
      minimumWidth: 420,
      minimumHeight: 180,
      position: { direction: "below" },
    });
    expect(dock.panels.get("media")?.api.setSize).toHaveBeenCalledWith({
      width: 220,
    });
    expect(dock.panels.get("attribute")?.api.setSize).toHaveBeenCalledWith({
      width: 250,
    });
    expect(dock.panels.get("timeline")?.api.setSize).toHaveBeenCalledWith({
      height: 304,
    });

    for (const panel of dock.added) {
      expect(panel).toMatchObject({
        component: DOCK_COMPONENT_ID,
        tabComponent: DOCK_TAB_COMPONENT_ID,
        renderer: "always",
      });
    }
    expect(dock.panels.has("caption")).toBe(false);
    expect(dock.panels.has("role-mixer")).toBe(false);
  });

  it("focuses an existing singleton instead of constructing a duplicate", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    const preview = dock.panels.get("preview");

    adapter.openPanel("preview");

    expect(dock.added.filter((panel) => panel.id === "preview")).toHaveLength(1);
    expect(preview?.api.setActive).toHaveBeenCalledOnce();
  });

  it("opens a closed tool into the contextual group and still enforces one instance", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();

    adapter.openPanel("caption");
    adapter.openPanel("caption");

    expect(dock.added.filter((panel) => panel.id === "caption")).toHaveLength(1);
    expect(dock.added.find((panel) => panel.id === "caption")).toMatchObject({
      position: { referencePanel: "attribute", direction: "within" },
    });
    expect(dock.panels.get("caption")?.api.setActive).toHaveBeenCalledOnce();
  });

  it("destroys a closed Panel and recreates it at its last tab placement", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    const firstEffect = dock.panels.get("effect");

    adapter.closePanel("effect");
    expect(firstEffect?.api.close).toHaveBeenCalledOnce();
    expect(adapter.hasPanel("effect")).toBe(false);

    adapter.openPanel("effect");
    const effects = dock.added.filter((panel) => panel.id === "effect");
    expect(effects).toHaveLength(2);
    expect(effects.at(-1)).toMatchObject({
      position: {
        referencePanel: "attribute",
        direction: "within",
        index: 1,
      },
    });
    expect(dock.panels.get("effect")).not.toBe(firstEffect);
  });

  it("uses semantic right-side fallback after the former tool group disappears", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    adapter.openPanel("caption");
    adapter.closePanel("caption");
    adapter.closePanel("attribute");
    adapter.closePanel("effect");
    adapter.closePanel("nearby");

    adapter.openPanel("caption");

    expect(dock.added.filter((panel) => panel.id === "caption").at(-1)).toMatchObject({
      position: { referencePanel: "preview", direction: "right" },
    });
  });

  it("cycles focused Panels through tabs and groups in both directions", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    adapter.openPanel("attribute");
    expect(adapter.getSnapshot().activePanel).toBe("attribute");

    adapter.focusNextPanel();
    expect(dock.rawApi.moveToNext).toHaveBeenCalledWith({ includePanel: true });
    expect(adapter.getSnapshot().activePanel).toBe("effect");
    adapter.focusPreviousPanel();
    expect(dock.rawApi.moveToPrevious).toHaveBeenCalledWith({ includePanel: true });
    expect(adapter.getSnapshot().activePanel).toBe("attribute");
  });

  it("maximizes the hovered Panel and restores through Dockview without resizing the tree", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    const sizesBefore = dock.panels.get("preview")?.api.setSize.mock.calls.length;

    adapter.setHoveredPanel("preview");
    adapter.toggleMaximize();
    expect(dock.panels.get("preview")?.api.maximize).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().maximizedPanel).toBe("preview");

    adapter.toggleMaximize();
    expect(dock.rawApi.exitMaximizedGroup).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().maximizedPanel).toBeNull();
    expect(dock.panels.get("preview")?.api.setSize).toHaveBeenCalledTimes(sizesBefore ?? 0);
  });

  it("allows an intentional empty state and resets it to Editing", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    for (const kind of EDITING_OPEN_PANEL_KINDS) adapter.closePanel(kind);

    expect(adapter.getSnapshot()).toMatchObject({
      activePanel: null,
      maximizedPanel: null,
      empty: true,
    });

    adapter.resetWorkspace();
    expect(dock.rawApi.clear).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot().empty).toBe(false);
    expect(adapter.getSnapshot().openPanels).toEqual(
      new Set(EDITING_OPEN_PANEL_KINDS),
    );
  });

  it("serializes the live Editing tree as a versioned, non-empty snapshot", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();

    const snapshot = adapter.serialize();
    expect(snapshot.empty).toBe(false);
    expect(snapshot.version).toBe(1);
    expect(Object.keys((snapshot.dockview as { panels: object }).panels).sort()).toEqual(
      [...EDITING_OPEN_PANEL_KINDS].sort(),
    );
    expect(snapshot.dockview).not.toHaveProperty("activeGroup");
    expect(snapshot.dockview).not.toHaveProperty("grid.maximizedNode");
  });

  it("serializes an all-closed workspace as the intentionally empty state, keeping closed placements", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    for (const kind of EDITING_OPEN_PANEL_KINDS) adapter.closePanel(kind);

    const snapshot = adapter.serialize();
    expect(snapshot).toMatchObject({ version: 1, empty: true, dockview: null });
    // Closed Panels keep their last placement so they reopen deterministically.
    expect(Object.keys(snapshot.placements).sort()).toEqual(
      [...EDITING_OPEN_PANEL_KINDS].sort(),
    );
  });

  it("restores a non-empty snapshot through Dockview panel reuse", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    const snapshot = adapter.serialize();

    expect(adapter.restore(snapshot)).toBe(true);
    expect(dock.rawApi.fromJSON).toHaveBeenCalledWith(snapshot.dockview, {
      reuseExistingPanels: true,
    });
    expect(adapter.getSnapshot().openPanels).toEqual(
      new Set(EDITING_OPEN_PANEL_KINDS),
    );
  });

  it("restores the intentionally empty state by clearing the tree", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();

    expect(
      adapter.restore({ version: 1, empty: true, dockview: null, placements: {} }),
    ).toBe(true);
    expect(dock.rawApi.clear).toHaveBeenCalledOnce();
    expect(dock.rawApi.fromJSON).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().empty).toBe(true);
  });

  it("round-trips serialize → restore back to the same open Panels", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    adapter.closePanel("effect");
    adapter.openPanel("caption");
    const before = adapter.getSnapshot().openPanels;

    const snapshot = adapter.serialize();
    adapter.restore(snapshot);

    expect(adapter.getSnapshot().openPanels).toEqual(before);
  });

  it("reports a failed restore without leaving the caller stranded", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    dock.rawApi.fromJSON.mockImplementationOnce(() => {
      throw new Error("corrupt tree");
    });

    expect(
      adapter.restore({
        version: 1,
        empty: false,
        dockview: { grid: { root: {} } } as never,
        placements: {},
      }),
    ).toBe(false);
  });

  it("restores closed-Panel placement so a reopened Panel returns to its remembered spot", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);
    adapter.initializeEditingLayout();
    // Effect's remembered spot is the attribute tab group at index 1.
    adapter.closePanel("effect");
    const snapshot = adapter.serialize();

    // Simulate a restart into a fresh adapter over a cleared dock.
    dock.rawApi.clear();
    const restarted = new DockWorkspaceAdapter(dock.api);
    expect(restarted.restore(snapshot)).toBe(true);
    dock.added.length = 0;

    restarted.openPanel("effect");
    expect(dock.added.find((panel) => panel.id === "effect")).toMatchObject({
      position: { referencePanel: "attribute", direction: "within", index: 1 },
    });
  });

  it("suppresses Dock overlays for Files and business MIME without consuming panel drags", () => {
    const dock = fakeDockview();
    const adapter = new DockWorkspaceAdapter(dock.api);

    expect(dock.showOverlay(["Files"])).toHaveBeenCalledOnce();
    expect(
      dock.showOverlay(["application/x-weftcut-media"]),
    ).toHaveBeenCalledOnce();
    expect(dock.showOverlay(["text/plain"])).not.toHaveBeenCalled();

    adapter.dispose();
    expect(dock.disposeOverlay).toHaveBeenCalledOnce();
  });
});

describe("dock drag classification", () => {
  it("keeps OS Files and every WeftCut business payload outside docking", () => {
    expect(isBusinessDockDrag({ types: ["Files"] })).toBe(true);
    expect(
      isBusinessDockDrag({ types: ["application/x-weftcut-media"] }),
    ).toBe(true);
    expect(
      isBusinessDockDrag({ types: ["application/x-weftcut-effect-order"] }),
    ).toBe(true);
    expect(isBusinessDockDrag({ types: ["text/plain"] })).toBe(false);
    expect(isBusinessDockDrag(null)).toBe(false);
  });
});
