import {
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewWillDropEvent,
  type IDockviewPanel,
  type DockviewWillShowOverlayLocationEvent,
} from "dockview-react";

import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  PANEL_REGISTRY,
  STRIP_THICKNESS,
  panelTitle,
  type PanelKind,
} from "./panelRegistry";
import {
  WEFTCUT_LAYOUT_VERSION,
  createEditingLayout,
  normalizeLayout,
  type PanelPlacement,
  type PanelPlacements,
  type WeftCutLayout,
} from "./workspaceLayout";

export const WEFTCUT_MEDIA_MIME_PREFIX = "application/x-weftcut-";

/** How much of the workspace a whole-layout edge drop claims on its axis.
 *  `WORKSPACE_EDGE_DROP_OVERLAY` (DockWorkspace.tsx) draws the drop band at
 *  this same fraction, so the highlight IS the landing size — change one and
 *  the other must follow. */
export const EDGE_DOCK_FRACTION = 0.25;

/** On the host element while the Quick Actions strip is the drag payload.
 *  workspace.css keys off it to pin the drop highlight to the strip's real
 *  44px landing thickness instead of the half-of-target default. */
export const STRIP_DRAG_CLASS = "weft-strip-drag";

export interface DockViewport {
  width: number;
  height: number;
}

interface Disposable {
  dispose(): void;
}

interface DockPanelParams {
  kind: PanelKind;
}

/** Geometry captured just before a split drop lands, used to undo Dockview's
 *  sibling-equalizing relayout. */
interface PendingSplitDropFix {
  axis: "width" | "height";
  /** `null` marks a whole-workspace edge dock: no group gave up space, so
   *  there is nothing to restore — the docked group just gets its promised
   *  `EDGE_DOCK_FRACTION` slice and the rest of the branch absorbs it. */
  targetGroupId: string | null;
  /** Pre-drop on-axis size of every group, target included. */
  sizes: Map<string, number>;
  /** Workspace size on `axis` at capture time; only edge docks read it. */
  containerSize: number;
  draggedPanelId: string | null;
  draggedGroupId: string;
}

export interface DockWorkspaceSnapshot {
  openPanels: ReadonlySet<PanelKind>;
  activePanel: PanelKind | null;
  maximizedPanel: PanelKind | null;
  empty: boolean;
}

/** The app-facing workspace seam. No live Dockview object or API escapes it;
 *  layouts cross only as opaque, validated `WeftCutLayout` snapshots. */
export interface DockWorkspaceController {
  getSnapshot(): DockWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  openPanel(kind: PanelKind): void;
  closePanel(kind: PanelKind): void;
  closeActivePanel(): void;
  focusNextPanel(): void;
  focusPreviousPanel(): void;
  openTabsOverflowMenu(): void;
  setHoveredPanel(kind: PanelKind | null): void;
  toggleMaximize(kind?: PanelKind): void;
  restoreMaximizedPanel(): void;
  resetWorkspace(): void;
  /** Capture the live Dock Tree as a validated, versioned WeftCut layout
   *  snapshot. Transient maximize/focus/hover state is excluded. */
  serialize(): WeftCutLayout;
  /** Replace the live layout from a normalized snapshot, reusing open Panel
   *  instances. Returns false (leaving the tree untouched-or-cleared) if the
   *  snapshot cannot be applied, so callers can fall through to the next
   *  fallback level. */
  restore(layout: WeftCutLayout): boolean;
}

export const EMPTY_DOCK_WORKSPACE_SNAPSHOT: DockWorkspaceSnapshot = {
  openPanels: new Set(),
  activePanel: null,
  maximizedPanel: null,
  empty: true,
};

function positiveSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type SplitAxis = "width" | "height";

function measureOnAxis(group: DockviewGroupPanel, axis: SplitAxis): number {
  const box = group.api.boundingBox;
  return box ? box[axis] : 0;
}

function setSizeOnAxis(
  group: DockviewGroupPanel,
  axis: SplitAxis,
  value: number,
): void {
  if (axis === "width") group.api.setSize({ width: value });
  else group.api.setSize({ height: value });
}

/** True only for OS Files or WeftCut business drags, never Dockview drags. */
export function isBusinessDockDrag(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  const types = Array.from(dataTransfer?.types ?? []);
  return (
    types.includes("Files") ||
    types.some((type) => type.startsWith(WEFTCUT_MEDIA_MIME_PREFIX))
  );
}

function overlayDataTransfer(
  event: DockviewWillShowOverlayLocationEvent,
): DataTransfer | null {
  const nativeEvent = event.nativeEvent;
  return "dataTransfer" in nativeEvent ? nativeEvent.dataTransfer : null;
}

/** The deepest node under the pointer sits inside a tab strip. Reliable on
 *  the edge band's capture-phase dragover: `target` is that deepest node. */
function overTabStrip(event: DragEvent | PointerEvent): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(".dv-tabs-and-actions-container") !== null
  );
}

/** A drop Dockview itself would silently discard — its own drop handler
 *  no-ops these same-group moves: a panel merged into the group it already
 *  occupies, a group dropped anywhere onto itself, and a group split off its
 *  own sole panel (which recreates the layout it left). Dockview still draws
 *  the full drop preview for them, promising a layout change that can never
 *  happen; suppressing the overlay keeps "highlight = landing layout" true.
 *  Same-group moves that DO land — splitting one panel out of a multi-panel
 *  group, reordering tabs — must keep their preview. Edge-band events carry
 *  no group and fall through untouched. */
function isNoOpSelfDrop(
  viewId: string,
  event: DockviewWillShowOverlayLocationEvent,
): boolean {
  const data = event.getData();
  const group = event.group;
  if (!data || !group) return false;
  if (data.viewId !== viewId || data.groupId !== group.id) return false;
  if (data.panelId === null) return !data.tabGroupId;
  if (event.kind === "content" && event.position === "center") return true;
  return group.panels.length === 1 && group.panels[0]?.id === data.panelId;
}

function isSoleStripGroup(group: DockviewGroupPanel): boolean {
  return group.panels.length === 1 && group.panels[0]?.id === "quick-actions";
}

/** The on-axis size a group can actually land at: the drop preview promises
 *  `proposed`, but the Quick Actions strip is pinned to its bar thickness and
 *  every Panel declares a minimum — a promise below those is a lie the next
 *  layout pass would break anyway. */
function constrainedDropSize(
  group: DockviewGroupPanel,
  axis: SplitAxis,
  proposed: number,
): number {
  if (isSoleStripGroup(group)) return STRIP_THICKNESS;
  let minimum = 0;
  for (const panel of group.panels) {
    if (!isPanelId(panel.id)) continue;
    const definition = PANEL_REGISTRY[panel.id];
    minimum = Math.max(
      minimum,
      axis === "width" ? definition.minimumWidth : definition.minimumHeight,
    );
  }
  return Math.max(proposed, minimum);
}

/**
 * Dockview is deliberately contained here. Callers deal only in PanelKind.
 */
export class DockWorkspaceAdapter implements DockWorkspaceController {
  private readonly disposables: Disposable[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly lastPlacements = new Map<PanelKind, PanelPlacement>();
  private hoveredPanel: PanelKind | null = null;
  private pendingSplitDropFix: PendingSplitDropFix | null = null;

  constructor(
    private readonly api: DockviewApi,
    stripDragHost?: HTMLElement,
  ) {
    this.disposables.push(api.onWillShowOverlay((event) => {
      if (isBusinessDockDrag(overlayDataTransfer(event))) {
        event.preventDefault();
        return;
      }
      if (isNoOpSelfDrop(api.id, event)) {
        event.preventDefault();
        return;
      }
      // The whole-workspace edge band listens on the capture phase, so it
      // sees drops aimed at the tab strips sitting inside it first. Bowing
      // out here happens BEFORE the band claims the event (v8 fires this
      // pre-claim), so the strip's own tab target still takes the drop the
      // user actually aimed at.
      if (event.kind === "edge" && overTabStrip(event.nativeEvent)) {
        event.preventDefault();
      }
    }));
    this.disposables.push(
      api.onWillDrop((event) => this.captureSplitDropFix(event)),
    );
    this.disposables.push(
      api.onDidLayoutChange(() => {
        this.applySplitDropFix();
        this.syncPreviewGroupChrome();
        this.captureOpenPlacements();
        this.emitChange();
      }),
      api.onDidActivePanelChange(() => this.emitChange()),
      api.onDidMaximizedGroupChange(() => this.emitChange()),
    );
    if (stripDragHost) this.trackStripDrag(stripDragHost);
    // A StrictMode-ready replay may hand a fresh adapter an API whose Panels
    // were already registered by the first pass. Seed recovery metadata from
    // that live tree instead of waiting for another layout mutation.
    this.syncPreviewGroupChrome();
    this.captureOpenPlacements();
  }

  /** Mirror "the drag payload is the Quick Actions strip" onto the host as
   *  `STRIP_DRAG_CLASS`. A DOM class rather than React state on purpose: a
   *  re-render mid-drag can detach the drag-source node, which cancels an
   *  HTML5 drag outright. */
  private trackStripDrag(host: HTMLElement): void {
    const mark = (active: boolean) =>
      host.classList.toggle(STRIP_DRAG_CLASS, active);
    const end = () => mark(false);
    this.disposables.push(
      this.api.onWillDragPanel((event) =>
        mark(event.panel.id === "quick-actions"),
      ),
      this.api.onWillDragGroup((event) => mark(isSoleStripGroup(event.group))),
      // A drop that moves the strip's tab detaches the drag source, so its
      // `dragend` fires off-document where no listener sees it — the drop
      // event has to close the window instead (same trap as
      // useDockDragInFlight in DockWorkspace.tsx).
      this.api.onWillDrop(() => queueMicrotask(end)),
    );
    document.addEventListener("dragend", end);
    this.disposables.push({
      dispose: () => {
        document.removeEventListener("dragend", end);
        end();
      },
    });
  }

  belongsTo(api: DockviewApi): boolean {
    return this.api === api;
  }

  /**
   * Build the immutable built-in Editing baseline once. Repeated calls are a
   * no-op, which makes Dockview readiness safe under React StrictMode and also
   * avoids replacing a future restored layout.
   */
  initializeEditingLayout(viewport?: Partial<DockViewport>): boolean {
    if (this.api.totalPanels > 0) return false;

    const width = positiveSize(viewport?.width ?? this.api.width, 1_000);
    const height = positiveSize(viewport?.height ?? this.api.height, 720);
    // The Quick Actions strip claims a fixed slice of width; everything else
    // divides the remainder. Mirrors `createEditingLayout`'s `bodyWidth`, so
    // the imperative first-boot tree and the declarative reset baseline agree.
    const stripWidth = STRIP_THICKNESS;
    const bodyWidth = Math.max(1, width - stripWidth);

    const media = this.addPanel("media", {
      initialWidth: Math.round(bodyWidth * 0.22),
    });
    this.addPanel("transitions", {
      position: { referencePanel: "media", direction: "within" },
      inactive: true,
    });
    this.addPanel("preview", {
      position: { referencePanel: "media", direction: "right" },
      initialWidth: Math.round(bodyWidth * 0.53),
    });
    const attribute = this.addPanel("attribute", {
      position: { referencePanel: "preview", direction: "right" },
      initialWidth: Math.round(bodyWidth * 0.25),
    });
    this.addPanel("effect", {
      position: { referencePanel: "attribute", direction: "within" },
      inactive: true,
    });
    this.addPanel("nearby", {
      position: { referencePanel: "attribute", direction: "within" },
      inactive: true,
    });
    const timeline = this.addPanel("timeline", {
      position: { direction: "below" },
      initialHeight: Math.round(height * 0.28),
    });
    // Inserted LAST and root-relative so it ends up beside the whole grid —
    // the editor row and the Timeline row both — giving one full-height edge
    // bar. Inserting it first instead would leave the root-relative Timeline
    // spanning underneath it.
    const strip = this.addPanel("quick-actions", {
      position: { direction: "left" },
      initialWidth: stripWidth,
    });

    // `initialWidth` sizes the newly inserted split, so later insertions can
    // redistribute an earlier sibling. Clamp the anchored columns after the
    // complete tree exists; Preview naturally receives the 53% remainder.
    strip?.api.setSize({ width: stripWidth });
    media?.api.setSize({ width: Math.round(bodyWidth * 0.22) });
    attribute?.api.setSize({ width: Math.round(bodyWidth * 0.25) });
    timeline?.api.setSize({ height: Math.round(height * 0.28) });
    this.captureOpenPlacements();
    this.emitChange();
    return true;
  }

  openPanel(kind: PanelKind): void {
    const existing = this.api.getPanel(kind);
    if (existing) {
      existing.api.setActive();
      this.emitChange();
      return;
    }

    const previous = this.lastPlacements.get(kind);
    const reference = previous?.siblings.find(
      (sibling) => sibling !== kind && this.api.getPanel(sibling),
    );
    if (reference) {
      this.addPanel(kind, {
        position: {
          referencePanel: reference,
          direction: "within",
          ...(previous ? { index: previous.index } : {}),
        },
      });
    } else {
      this.addPanelAtSemanticFallback(kind);
    }
    this.captureOpenPlacements();
    this.emitChange();
  }

  hasPanel(kind: PanelKind): boolean {
    return this.api.getPanel(kind) !== undefined;
  }

  getSnapshot(): DockWorkspaceSnapshot {
    const openPanels = new Set<PanelKind>();
    for (const panel of this.api.panels) {
      if (isPanelId(panel.id)) openPanels.add(panel.id);
    }
    const activePanel = isPanelId(this.api.activePanel?.id)
      ? this.api.activePanel.id
      : null;
    const maximized = this.api.groups.find((group) =>
      group.api.isMaximized(),
    )?.activePanel;
    const maximizedPanel = isPanelId(maximized?.id) ? maximized.id : null;
    return {
      openPanels,
      activePanel,
      maximizedPanel,
      empty: openPanels.size === 0,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  closePanel(kind: PanelKind): void {
    const panel = this.api.getPanel(kind);
    if (!panel) return;
    this.capturePlacement(panel);
    panel.api.close();
    if (this.hoveredPanel === kind) this.hoveredPanel = null;
    this.emitChange();
  }

  closeActivePanel(): void {
    const id = this.api.activePanel?.id;
    if (isPanelId(id)) this.closePanel(id);
  }

  focusNextPanel(): void {
    if (this.api.totalPanels === 0) return;
    this.api.moveToNext({ includePanel: true });
    this.emitChange();
  }

  focusPreviousPanel(): void {
    if (this.api.totalPanels === 0) return;
    this.api.moveToPrevious({ includePanel: true });
    this.emitChange();
  }

  /** Open the active group's tabs-overflow dropdown (Dockview's chevron).
   *  No public Dockview API exposes the overflow control, so this clicks the
   *  button's DOM node with its own geometry — the popover then opens exactly
   *  where a mouse click would put it, and `useTabsOverflowA11y` in
   *  DockWorkspace.tsx takes over for arrow-key navigation. */
  openTabsOverflowMenu(): void {
    const button = this.api.activeGroup?.element.querySelector<HTMLElement>(
      ".dv-tabs-overflow-dropdown-root",
    );
    if (!button) return;
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom + 2,
      }),
    );
  }

  setHoveredPanel(kind: PanelKind | null): void {
    this.hoveredPanel = kind;
  }

  toggleMaximize(kind?: PanelKind): void {
    if (this.api.hasMaximizedGroup()) {
      this.api.exitMaximizedGroup();
      this.emitChange();
      return;
    }
    const targetKind = kind ?? this.hoveredPanel;
    const target = targetKind
      ? this.api.getPanel(targetKind)
      : this.api.activePanel;
    if (!target) return;
    target.api.maximize();
    this.emitChange();
  }

  restoreMaximizedPanel(): void {
    if (!this.api.hasMaximizedGroup()) return;
    this.api.exitMaximizedGroup();
    this.emitChange();
  }

  refreshPanelTitles(): void {
    for (const panel of this.api.panels) {
      if (isPanelId(panel.id)) panel.api.setTitle(panelTitle(panel.id));
    }
  }

  resetWorkspace(): void {
    const previous = this.serialize();
    const editing = createEditingLayout({
      width: positiveSize(this.api.width, 1_000),
      height: positiveSize(this.api.height, 720),
    });

    try {
      this.applyLayout(editing);
    } catch (resetError) {
      // Dockview clears before deserializing. If that atomic load itself fails,
      // reconstruct the pre-reset snapshot so Reset can never leave a blank or
      // partially rebuilt Workspace behind.
      try {
        this.applyLayout(previous);
      } catch (rollbackError) {
        throw new AggregateError(
          [resetError, rollbackError],
          "Failed to reset Dock Workspace and restore its previous layout",
        );
      }
      throw resetError;
    }
  }

  serialize(): WeftCutLayout {
    const placements = this.serializePlacements();
    // An intentionally empty Workspace is a first-class, valid snapshot —
    // distinct from missing (null) or corrupt data on the persistence side. Its
    // placements still carry the closed Panels' remembered spots.
    if (this.api.totalPanels === 0) {
      return { version: WEFTCUT_LAYOUT_VERSION, empty: true, dockview: null, placements };
    }
    const normalized = normalizeLayout({
      version: WEFTCUT_LAYOUT_VERSION,
      empty: false,
      dockview: this.api.toJSON(),
      placements,
    });
    if (!normalized) {
      throw new Error("Dockview produced an invalid live layout");
    }
    return normalized;
  }

  restore(layout: WeftCutLayout): boolean {
    try {
      this.applyLayout(layout);
      return true;
    } catch (error) {
      console.warn("[dock-workspace] layout restore failed:", error);
      return false;
    }
  }

  private applyLayout(layout: WeftCutLayout): void {
    if (this.api.hasMaximizedGroup()) this.api.exitMaximizedGroup();
    // Seed the recovery map from persisted placements first; captureOpenPlacements
    // then refreshes the entries for Panels the restored tree actually opens,
    // leaving closed Panels' remembered spots intact.
    this.lastPlacements.clear();
    for (const [kind, placement] of Object.entries(layout.placements)) {
      if (placement) this.lastPlacements.set(kind as PanelKind, placement);
    }
    if (layout.empty || !layout.dockview) {
      this.api.clear();
    } else {
      this.api.fromJSON(layout.dockview, { reuseExistingPanels: true });
    }
    this.hoveredPanel = null;
    this.captureOpenPlacements();
    this.emitChange();
  }

  private serializePlacements(): PanelPlacements {
    const placements: PanelPlacements = {};
    for (const [kind, placement] of this.lastPlacements) {
      placements[kind] = { siblings: [...placement.siblings], index: placement.index };
    }
    return placements;
  }

  dispose(): void {
    this.pendingSplitDropFix = null;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.listeners.clear();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }

  private captureOpenPlacements(): void {
    for (const panel of this.api.panels) this.capturePlacement(panel);
  }

  /** A group left holding only Preview loses its tab strip — no strip means
   *  no drag handle, so a solo Preview stays put. Re-evaluated on every layout
   *  change: once another Panel joins the group the strip (and tab switching)
   *  returns. Uses Dockview's own hideHeader, which normalizeLayout keeps out
   *  of persisted snapshots — the state is derived, never stored. */
  private syncPreviewGroupChrome(): void {
    for (const group of this.api.groups) {
      const soloPreview =
        group.panels.length === 1 && group.panels[0]?.id === "preview";
      group.model.header.hidden = soloPreview;
    }
  }

  /** Dockview answers every split drop by inserting the new group with no
   *  explicit size, which makes Splitview *distribute*: every sibling in the
   *  branch is resized to an equal share. The drop preview therefore lies —
   *  carefully sized columns jump to equal widths. Capture the pre-drop
   *  geometry here (synchronously before the move) and repair it right
   *  after, to what the preview promised: on a group split, untouched groups
   *  keep their size and the target yields half to the newcomer; on a
   *  whole-workspace edge dock, the newcomer takes the band's
   *  `EDGE_DOCK_FRACTION`. Both bow to `constrainedDropSize` — a Panel never
   *  lands below its minimum, and the Quick Actions strip stays a 44px bar. */
  private captureSplitDropFix(event: DockviewWillDropEvent): void {
    this.pendingSplitDropFix = null;
    const { position, group, kind } = event;
    if (
      position !== "left" &&
      position !== "right" &&
      position !== "top" &&
      position !== "bottom"
    ) {
      return; // merges and tab insertions don't rebalance siblings
    }
    const data = event.getData();
    if (!data || data.viewId !== this.api.id) return; // not a layout move
    const axis: SplitAxis =
      position === "left" || position === "right" ? "width" : "height";
    if (kind === "edge") {
      // A whole-workspace edge dock: no target group exists, distribute
      // squeezes every branch sibling. The repair promises the docked group
      // the fraction the edge band displayed.
      this.pendingSplitDropFix = {
        axis,
        targetGroupId: null,
        sizes: new Map(),
        containerSize: axis === "width" ? this.api.width : this.api.height,
        draggedPanelId: data.panelId ?? null,
        draggedGroupId: data.groupId,
      };
    } else if (kind === "content" || kind === "header_space") {
      if (!group) return;
      const sizes = new Map<string, number>();
      for (const candidate of this.api.groups) {
        const size = measureOnAxis(candidate, axis);
        if (size > 0) sizes.set(candidate.id, size);
      }
      if (!sizes.has(group.id)) return;
      this.pendingSplitDropFix = {
        axis,
        targetGroupId: group.id,
        sizes,
        containerSize: 0,
        draggedPanelId: data.panelId ?? null,
        draggedGroupId: data.groupId,
      };
    } else {
      return;
    }
    // The move is processed synchronously right after this event, so a
    // microtask still beats the next paint: the repair is invisible.
    queueMicrotask(() => this.applySplitDropFix());
  }

  private applySplitDropFix(): void {
    const fix = this.pendingSplitDropFix;
    this.pendingSplitDropFix = null;
    if (!fix) return;
    const dragged = fix.draggedPanelId
      ? this.api.getPanel(fix.draggedPanelId)?.group
      : this.api.groups.find(
          (candidate) => candidate.id === fix.draggedGroupId,
        );
    if (!dragged) return;
    if (fix.targetGroupId === null) {
      // Edge dock: one explicit resize is enough — setSize reclaims the
      // delta from the rest of the branch proportionally, which is exactly
      // the squeeze a "dock to the workspace edge" should cost.
      setSizeOnAxis(
        dragged,
        fix.axis,
        constrainedDropSize(
          dragged,
          fix.axis,
          Math.round(fix.containerSize * EDGE_DOCK_FRACTION),
        ),
      );
      return;
    }
    const target = this.api.groups.find(
      (candidate) => candidate.id === fix.targetGroupId,
    );
    // Merges, reorders, and rejected drops leave the dragged item inside the
    // target group; only a real split lands it beside the target.
    if (!target || dragged === target) return;
    for (const candidate of this.api.groups) {
      if (candidate === target || candidate === dragged) continue;
      const size = fix.sizes.get(candidate.id);
      if (size !== undefined && size > 0) {
        setSizeOnAxis(candidate, fix.axis, size);
      }
    }
    const combined =
      measureOnAxis(target, fix.axis) + measureOnAxis(dragged, fix.axis);
    if (combined <= 0) return;
    const draggedSize = constrainedDropSize(
      dragged,
      fix.axis,
      Math.round(combined / 2),
    );
    setSizeOnAxis(target, fix.axis, combined - draggedSize);
    setSizeOnAxis(dragged, fix.axis, draggedSize);
  }

  private capturePlacement(panel: IDockviewPanel): void {
    if (!isPanelId(panel.id)) return;
    const siblings = panel.group.panels
      .map((candidate) => candidate.id)
      .filter(isPanelId);
    this.lastPlacements.set(panel.id, {
      siblings,
      index: Math.max(0, siblings.indexOf(panel.id)),
    });
  }

  private addPanelAtSemanticFallback(kind: PanelKind): void {
    const firstOpen = (...kinds: PanelKind[]) =>
      kinds.find((candidate) => this.api.getPanel(candidate));
    if (kind === "media") {
      const reference = firstOpen(
        "preview", "attribute", "effect", "nearby", "caption", "role-mixer", "timeline",
      );
      this.addPanel(kind, reference
        ? { position: { referencePanel: reference, direction: "left" } }
        : {});
      return;
    }
    if (kind === "preview") {
      const media = firstOpen("media");
      const reference = media ?? firstOpen(
        "attribute", "effect", "nearby", "caption", "role-mixer", "timeline",
      );
      this.addPanel(kind, reference
        ? {
            position: {
              referencePanel: reference,
              direction: media ? "right" : "left",
            },
          }
        : {});
      return;
    }
    if (kind === "timeline") {
      const reference = firstOpen(
        "preview", "media", "attribute", "effect", "nearby", "caption", "role-mixer",
      );
      this.addPanel(kind, reference
        ? { position: { referencePanel: reference, direction: "below" } }
        : {});
      return;
    }
    if (kind === "quick-actions") {
      // The tool strip is an edge bar, never a tabbed tool Panel — it must
      // NOT reach the contextual-group fallback below, which would merge it
      // into Attribute/Effect/Nearby as a 240-wide tab. `left` of the
      // leftmost open Panel reproduces its baseline slot; the narrow
      // initialWidth keeps a fresh split from claiming half the editor.
      const reference = firstOpen(
        "media", "preview", "timeline", "attribute", "effect", "nearby", "caption", "role-mixer",
      );
      this.addPanel(kind, reference
        ? {
            position: { referencePanel: reference, direction: "left" },
            initialWidth: STRIP_THICKNESS,
          }
        : {});
      return;
    }

    const contextual = firstOpen(
      "attribute", "effect", "nearby", "caption", "role-mixer",
    );
    if (contextual) {
      this.addPanel(kind, {
        position: { referencePanel: contextual, direction: "within" },
      });
      return;
    }
    const reference = firstOpen("preview", "media", "timeline");
    this.addPanel(kind, reference
      ? { position: { referencePanel: reference, direction: "right" } }
      : {});
  }

  private addPanel(
    kind: PanelKind,
    placement: {
      position?:
        // Root-relative: splits the whole grid rather than one Panel's cell.
        // `below` gives the full-width Timeline row; `left` gives the
        // full-height Quick Actions edge strip.
        | { direction: "below" | "left" }
        | {
            referencePanel: string;
            direction: "left" | "right" | "above" | "below" | "within";
            index?: number;
          };
      initialWidth?: number;
      initialHeight?: number;
      inactive?: boolean;
    } = {},
  ): IDockviewPanel | undefined {
    if (this.api.getPanel(kind)) return undefined;
    const definition = PANEL_REGISTRY[kind];
    const params: DockPanelParams = { kind };
    return this.api.addPanel({
      id: kind,
      title: panelTitle(kind),
      component: DOCK_COMPONENT_ID,
      tabComponent: DOCK_TAB_COMPONENT_ID,
      renderer: "always",
      params,
      minimumWidth: definition.minimumWidth,
      minimumHeight: definition.minimumHeight,
      ...placement,
    });
  }
}

function isPanelId(value: unknown): value is PanelKind {
  return typeof value === "string" && value in PANEL_REGISTRY;
}
