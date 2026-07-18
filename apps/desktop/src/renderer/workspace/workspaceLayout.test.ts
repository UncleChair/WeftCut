import { describe, it, expect } from "vitest";

import {
  WEFTCUT_LAYOUT_VERSION,
  normalizeLayout,
  resolveWorkspaceLayout,
} from "./workspaceLayout";
import { DOCK_COMPONENT_ID, DOCK_TAB_COMPONENT_ID } from "./panelRegistry";

/** Build a leaf grid node (a Dock Group) for a set of Panel-kind views. */
function leaf(views: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "leaf",
    data: { views, activeView: views[0], id: `g-${views.join("-")}`, ...extra },
    size: 100,
  };
}

function nonEmpty(root: unknown, grid: Record<string, unknown> = {}) {
  return {
    version: WEFTCUT_LAYOUT_VERSION,
    empty: false,
    dockview: {
      grid: { root, orientation: "HORIZONTAL", width: 1000, height: 720, ...grid },
      panels: {},
      activeGroup: "g-preview",
    },
  };
}

describe("normalizeLayout", () => {
  it("rejects non-objects and wrong versions", () => {
    expect(normalizeLayout(null)).toBeNull();
    expect(normalizeLayout(undefined)).toBeNull();
    expect(normalizeLayout("nope")).toBeNull();
    expect(normalizeLayout({ version: 999, empty: true })).toBeNull();
  });

  it("preserves an intentionally empty layout as a valid, distinct state", () => {
    expect(normalizeLayout({ version: WEFTCUT_LAYOUT_VERSION, empty: true })).toEqual({
      version: WEFTCUT_LAYOUT_VERSION,
      empty: true,
      dockview: null,
      placements: {},
    });
  });

  it("carries closed-Panel placement metadata through, dropping unknown kinds", () => {
    const result = normalizeLayout({
      version: WEFTCUT_LAYOUT_VERSION,
      empty: true,
      placements: {
        caption: { siblings: ["attribute", "caption"], index: 1 },
        bogus: { siblings: ["preview"], index: 0 },
        media: { siblings: [], index: 0 },
      },
    });
    expect(result?.placements).toEqual({
      caption: { siblings: ["attribute", "caption"], index: 1 },
    });
  });

  it("normalizes a simple split and regenerates the panels record from the registry", () => {
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["media"]), leaf(["preview"]), leaf(["timeline"])],
        size: 720,
      }),
    );
    expect(result?.empty).toBe(false);
    const dockview = result!.dockview as unknown as {
      grid: { root: { data: unknown[] } };
      panels: Record<string, { contentComponent: string; tabComponent: string; params: unknown }>;
    };
    expect(Object.keys(dockview.panels).sort()).toEqual(["media", "preview", "timeline"]);
    // Panels are synthesized, not trusted from disk.
    expect(dockview.panels.preview).toMatchObject({
      contentComponent: DOCK_COMPONENT_ID,
      tabComponent: DOCK_TAB_COMPONENT_ID,
      params: { kind: "preview" },
      renderer: "always",
    });
    expect(dockview.grid.root.data).toHaveLength(3);
  });

  it("drops transient focus and maximize metadata", () => {
    const result = normalizeLayout(
      nonEmpty(leaf(["preview"]), {
        maximizedNode: { location: [0] },
      }),
    );
    const dockview = result!.dockview as unknown as {
      activeGroup?: string;
      grid: { maximizedNode?: unknown };
    };
    expect(dockview.activeGroup).toBeUndefined();
    expect(dockview.grid.maximizedNode).toBeUndefined();
  });

  it("drops unknown Panel kinds while keeping the known ones", () => {
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["media", "totally-bogus"]), leaf(["preview"])],
      }),
    );
    const dockview = result!.dockview as unknown as { panels: Record<string, unknown> };
    expect(Object.keys(dockview.panels).sort()).toEqual(["media", "preview"]);
  });

  it("reduces a duplicated singleton to its first placement", () => {
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["preview"]), leaf(["preview", "media"])],
      }),
    );
    const dockview = result!.dockview as unknown as {
      grid: { root: { data: Array<{ data: { views: string[] } }> } };
      panels: Record<string, unknown>;
    };
    expect(Object.keys(dockview.panels).sort()).toEqual(["media", "preview"]);
    // The second group keeps only the not-yet-seen kind.
    const groups = dockview.grid.root.data.map((n) => n.data.views);
    expect(groups).toEqual([["preview"], ["media"]]);
  });

  it("prunes an emptied leaf and collapses its single-child branch", () => {
    // The first leaf is all-unknown → pruned; the branch collapses to the survivor.
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["bogus-a", "bogus-b"]), leaf(["timeline"])],
        size: 500,
      }),
    );
    const dockview = result!.dockview as unknown as {
      grid: { root: { type: string; data: { views: string[] } } };
    };
    expect(dockview.grid.root.type).toBe("leaf");
    expect(dockview.grid.root.data.views).toEqual(["timeline"]);
  });

  it("repairs an activeView that pointed at a dropped kind", () => {
    const result = normalizeLayout(
      nonEmpty(leaf(["media", "preview"], { activeView: "bogus" })),
    );
    const dockview = result!.dockview as unknown as {
      grid: { root: { data: { activeView: string } } };
    };
    expect(dockview.grid.root.data.activeView).toBe("media");
  });

  it("treats a non-empty layout that loses every Panel as corrupt (not empty)", () => {
    expect(normalizeLayout(nonEmpty(leaf(["bogus-1", "bogus-2"])))).toBeNull();
    expect(normalizeLayout(nonEmpty({ type: "branch", data: [] }))).toBeNull();
  });

  it("rejects a structurally broken tree", () => {
    expect(normalizeLayout({ version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview: {} })).toBeNull();
    expect(
      normalizeLayout({ version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview: { grid: {} } }),
    ).toBeNull();
  });
});

describe("resolveWorkspaceLayout", () => {
  const validCurrent = nonEmpty(leaf(["preview"]));
  const validSaved = nonEmpty(leaf(["timeline"]));

  it("returns an empty candidate list for a missing profile", () => {
    expect(resolveWorkspaceLayout(null)).toEqual([]);
    expect(resolveWorkspaceLayout({ current: null, saved: null })).toEqual([]);
  });

  it("orders current before saved when both are valid", () => {
    const candidates = resolveWorkspaceLayout({ current: validCurrent, saved: validSaved });
    expect(candidates.map((c) => c.source)).toEqual(["current", "saved"]);
  });

  it("falls through a corrupt current to a valid saved baseline", () => {
    const candidates = resolveWorkspaceLayout({
      current: { version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview: { grid: {} } },
      saved: validSaved,
    });
    expect(candidates.map((c) => c.source)).toEqual(["saved"]);
  });

  it("includes an intentionally empty current as a valid candidate", () => {
    const candidates = resolveWorkspaceLayout({
      current: { version: WEFTCUT_LAYOUT_VERSION, empty: true },
      saved: null,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "current", layout: { empty: true } });
  });
});
