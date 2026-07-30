// Renderer-owned schema and validation for opaque Workspace layout slots.
// Canonical snapshots contain only known singleton Panels and durable geometry;
// transient focus/maximize state is excluded, while an intentionally empty
// Workspace remains distinct from missing or corrupt data. Main never interprets
// this shape; the persistence hook owns fallback selection and repair.

import type { SerializedDockview } from "dockview-react";

import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  PANEL_REGISTRY,
  isPanelKind,
  panelTitle,
  type PanelKind,
} from "./panelRegistry";

/** Schema version of a WeftCut layout snapshot. Bump on any incompatible change
 *  to the snapshot shape; a snapshot with a different version is discarded on
 *  read (falls through to the next fallback level) rather than misapplied. */
export const WEFTCUT_LAYOUT_VERSION = 1;

/** Recovery metadata for reopening a Panel: the Dock Group it last lived in
 *  (as sibling kinds) and its tab index there. Mirrors the adapter's in-memory
 *  placement map so a closed Panel reopens at its remembered spot after restart. */
export interface PanelPlacement {
  siblings: PanelKind[];
  index: number;
}

export type PanelPlacements = Partial<Record<PanelKind, PanelPlacement>>;

/** A validated, versioned Dock arrangement. Opaque to everyone but the adapter
 *  (which restores it) and this module (which produces/validates it). The `empty`
 *  discriminant makes an intentionally empty Workspace a distinct valid state. */
export interface WeftCutLayout {
  version: number;
  empty: boolean;
  /** The normalized Dockview tree. Null iff `empty`. */
  dockview: SerializedDockview | null;
  /** Last-known placement of every Panel (open or closed) so a closed Panel
   *  reopens deterministically after restart. May be empty. */
  placements: PanelPlacements;
}

export interface WorkspaceLayoutCandidate {
  source: "current" | "saved";
  layout: WeftCutLayout;
}

// ── Internal loose tree shapes ───────────────────────────────────────────────
// We rebuild the grid tree from untrusted input, so we work with permissive local
// types and cast the finished, canonical object to SerializedDockview once — the
// Dockview enums (Orientation) are nominal and awkward to satisfy field-by-field.

interface NormalizedLeaf {
  type: "leaf";
  data: { views: PanelKind[]; activeView: PanelKind; id: string };
  size?: number;
  visible?: boolean;
}

interface NormalizedBranch {
  type: "branch";
  data: NormalizedNode[];
  size?: number;
  visible?: boolean;
}

type NormalizedNode = NormalizedLeaf | NormalizedBranch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Regenerate a Panel definition from its kind. Panel identity is fully
 *  determined by kind (title, components, params, constraints), so the persisted
 *  `panels` record is derived here rather than trusted — a corrupt or stale
 *  entry can never carry a wrong component id or params into fromJSON. */
function synthesizePanel(kind: PanelKind) {
  const definition = PANEL_REGISTRY[kind];
  return {
    id: kind,
    contentComponent: DOCK_COMPONENT_ID,
    tabComponent: DOCK_TAB_COMPONENT_ID,
    title: panelTitle(kind),
    renderer: "always" as const,
    params: { kind },
    minimumWidth: definition.minimumWidth,
    minimumHeight: definition.minimumHeight,
  };
}

/**
 * Normalize one grid node. `seen` carries the kinds already claimed by earlier
 * leaves so a duplicated singleton is reduced to its first placement. Returns
 * null for a node that contributes nothing (empty leaf / empty branch) so the
 * parent can prune it.
 */
function normalizeNode(
  node: unknown,
  seen: Set<PanelKind>,
): NormalizedNode | null {
  if (!isRecord(node)) return null;

  const size = sizeOf(node.size);

  if (node.type === "branch") {
    if (!Array.isArray(node.data)) return null;
    const children: NormalizedNode[] = [];
    for (const child of node.data) {
      const normalized = normalizeNode(child, seen);
      if (normalized) children.push(normalized);
    }
    if (children.length === 0) return null;
    // A branch with a single surviving child is degenerate; hoist the child and
    // carry this branch's size so the remaining split keeps its proportion.
    if (children.length === 1) {
      const only = children[0]!;
      const kept = size ?? only.size;
      return kept === undefined ? only : { ...only, size: kept };
    }
    return { type: "branch", data: children, ...(size === undefined ? {} : { size }) };
  }

  // Leaf (default): a Dock Group with one or more tabbed Panels.
  const data = node.data;
  if (!isRecord(data)) return null;
  const rawViews = Array.isArray(data.views) ? data.views : [];
  const views: PanelKind[] = [];
  for (const view of rawViews) {
    if (isPanelKind(view) && !seen.has(view)) {
      views.push(view);
      seen.add(view);
    }
  }
  const first = views[0];
  if (first === undefined) return null;
  const activeView =
    isPanelKind(data.activeView) && views.includes(data.activeView)
      ? data.activeView
      : first;
  const id = typeof data.id === "string" && data.id ? data.id : `group-${first}`;
  return {
    type: "leaf",
    data: { views, activeView, id },
    ...(size === undefined ? {} : { size }),
    ...(node.visible === false ? { visible: false } : {}),
  };
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeDockview(raw: unknown): SerializedDockview | null {
  if (!isRecord(raw)) return null;
  const grid = raw.grid;
  if (!isRecord(grid)) return null;

  const seen = new Set<PanelKind>();
  const root = normalizeNode(grid.root, seen);
  // A layout that claimed to be non-empty but lost every Panel to
  // unknown-kind/duplicate pruning is corrupt, not intentionally empty — reject
  // it so the caller falls through to the next fallback level.
  if (!root || seen.size === 0) return null;

  const panels: Record<string, ReturnType<typeof synthesizePanel>> = {};
  for (const kind of seen) panels[kind] = synthesizePanel(kind);

  const orientation = grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  const width = sizeOf(grid.width) ?? 1_000;
  const height = sizeOf(grid.height) ?? 720;
  const normalized = {
    grid: { root, orientation, width, height },
    panels,
  };
  return normalized as unknown as SerializedDockview;
}

function normalizePlacements(raw: unknown): PanelPlacements {
  const out: PanelPlacements = {};
  if (!isRecord(raw)) return out;
  for (const [kind, value] of Object.entries(raw)) {
    if (!isPanelKind(kind) || !isRecord(value)) continue;
    const siblings = Array.isArray(value.siblings)
      ? value.siblings.filter(isPanelKind)
      : [];
    if (siblings.length === 0) continue;
    const index =
      typeof value.index === "number" && value.index >= 0
        ? Math.floor(value.index)
        : 0;
    out[kind] = { siblings, index };
  }
  return out;
}

/**
 * Validate + normalize an untrusted persisted layout value. Returns a canonical
 * WeftCutLayout, or null when the value is missing/corrupt/unrecoverable.
 */
export function normalizeLayout(raw: unknown): WeftCutLayout | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== WEFTCUT_LAYOUT_VERSION) return null;
  const placements = normalizePlacements(raw.placements);
  if (raw.empty === true) {
    return { version: WEFTCUT_LAYOUT_VERSION, empty: true, dockview: null, placements };
  }
  const dockview = normalizeDockview(raw.dockview);
  if (!dockview) return null;
  return { version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview, placements };
}

/**
 * Produce the immutable, code-owned Editing baseline as a complete Dockview
 * snapshot. Reset applies this snapshot in one Dockview load transaction; it
 * must not clear the tree and then rebuild Panels one at a time because a
 * transiently missing reference Panel would strand the Workspace half-built.
 */
export function createEditingLayout(
  viewport: { width?: number; height?: number } = {},
): WeftCutLayout {
  const width = sizeOf(viewport.width) ?? 1_000;
  const height = sizeOf(viewport.height) ?? 720;
  const contextual: PanelKind[] = ["attribute", "effect", "nearby"];
  const placements: PanelPlacements = {
    media: { siblings: ["media"], index: 0 },
    preview: { siblings: ["preview"], index: 0 },
    timeline: { siblings: ["timeline"], index: 0 },
    attribute: { siblings: contextual, index: 0 },
    effect: { siblings: contextual, index: 1 },
    nearby: { siblings: contextual, index: 2 },
  };
  const layout = normalizeLayout({
    version: WEFTCUT_LAYOUT_VERSION,
    empty: false,
    dockview: {
      grid: {
        // Grid branches alternate axes. A vertical root gives the 62/38
        // editor/timeline rows; its first child then lays out the three editor
        // columns horizontally.
        orientation: "VERTICAL",
        width,
        height,
        root: {
          type: "branch",
          size: height,
          data: [
            {
              type: "branch",
              size: Math.round(height * 0.72),
              data: [
                {
                  type: "leaf",
                  size: Math.round(width * 0.22),
                  data: {
                    id: "editing-media",
                    views: ["media"],
                    activeView: "media",
                  },
                },
                {
                  type: "leaf",
                  size: Math.round(width * 0.53),
                  data: {
                    id: "editing-preview",
                    views: ["preview"],
                    activeView: "preview",
                  },
                },
                {
                  type: "leaf",
                  size: Math.round(width * 0.25),
                  data: {
                    id: "editing-context",
                    views: contextual,
                    activeView: "attribute",
                  },
                },
              ],
            },
            {
              type: "leaf",
              size: Math.round(height * 0.28),
              data: {
                id: "editing-timeline",
                views: ["timeline"],
                activeView: "timeline",
              },
            },
          ],
        },
      },
      // normalizeLayout derives trusted definitions for every referenced Panel.
      panels: {},
    },
    placements,
  });
  if (!layout) throw new Error("Built-in Editing layout is invalid");
  return layout;
}

/**
 * Turn a Workspace profile's opaque layout slots into the ordered restore
 * candidates: `current` first, then the saved baseline. Each is included only
 * when it normalizes to a valid layout. An empty result means the caller should
 * fall back to the built-in Editing baseline.
 */
export function resolveWorkspaceLayout(
  slots: { current?: unknown; saved?: unknown } | null | undefined,
): WorkspaceLayoutCandidate[] {
  const candidates: WorkspaceLayoutCandidate[] = [];
  const current = normalizeLayout(slots?.current);
  if (current) candidates.push({ source: "current", layout: current });
  const saved = normalizeLayout(slots?.saved);
  if (saved) candidates.push({ source: "saved", layout: saved });
  return candidates;
}
