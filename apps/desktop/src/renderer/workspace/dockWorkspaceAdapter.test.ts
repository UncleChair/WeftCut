import { describe, expect, it, vi } from "vitest";
import { type DockviewApi } from "dockview-react";

import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  DockWorkspaceAdapter,
  isBusinessDockDrag,
} from "./dockWorkspaceAdapter";
import {
  EDITING_OPEN_PANEL_KINDS,
  PANEL_KINDS,
  PANEL_REGISTRY,
} from "./panelRegistry";

interface AddedPanel {
  id: string;
  api: {
    setActive: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
  };
}

function fakeDockview(width = 1_000, height = 800) {
  const panels = new Map<string, AddedPanel>();
  const added: Record<string, unknown>[] = [];
  let overlayListener:
    | ((event: {
        nativeEvent: { dataTransfer?: Pick<DataTransfer, "types"> };
        preventDefault(): void;
      }) => void)
    | null = null;
  const disposeOverlay = vi.fn();

  const api = {
    width,
    height,
    get totalPanels() {
      return panels.size;
    },
    getPanel: vi.fn((id: string) => panels.get(id)),
    addPanel: vi.fn((options: Record<string, unknown>) => {
      const panel: AddedPanel = {
        id: String(options.id),
        api: { setActive: vi.fn(), setSize: vi.fn() },
      };
      added.push(options);
      panels.set(panel.id, panel);
      return panel;
    }),
    onWillShowOverlay: vi.fn((listener: typeof overlayListener) => {
      overlayListener = listener;
      return { dispose: disposeOverlay };
    }),
  };

  return {
    api: api as unknown as DockviewApi,
    panels,
    added,
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
