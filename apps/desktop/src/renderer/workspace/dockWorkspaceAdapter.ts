import {
  type DockviewApi,
  type IDockviewPanel,
  type DockviewWillShowOverlayLocationEvent,
} from "dockview-react";

import {
  PANEL_REGISTRY,
  type PanelKind,
} from "./panelRegistry";

export const DOCK_COMPONENT_ID = "weftcut-panel";
export const DOCK_TAB_COMPONENT_ID = "weftcut-tab";
export const WEFTCUT_MEDIA_MIME_PREFIX = "application/x-weftcut-";

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

interface PanelPlacement {
  siblings: PanelKind[];
  index: number;
}

export interface DockWorkspaceSnapshot {
  openPanels: ReadonlySet<PanelKind>;
  activePanel: PanelKind | null;
  maximizedPanel: PanelKind | null;
  empty: boolean;
}

/** The app-facing workspace seam. No Dockview object or JSON escapes it. */
export interface DockWorkspaceController {
  getSnapshot(): DockWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  openPanel(kind: PanelKind): void;
  closePanel(kind: PanelKind): void;
  closeActivePanel(): void;
  focusNextPanel(): void;
  focusPreviousPanel(): void;
  setHoveredPanel(kind: PanelKind | null): void;
  toggleMaximize(kind?: PanelKind): void;
  restoreMaximizedPanel(): void;
  resetWorkspace(): void;
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

/**
 * Dockview is deliberately contained here. Callers deal only in PanelKind;
 * no group, panel, API, placement, or serialized Dockview object escapes.
 */
export class DockWorkspaceAdapter implements DockWorkspaceController {
  private readonly disposables: Disposable[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly lastPlacements = new Map<PanelKind, PanelPlacement>();
  private hoveredPanel: PanelKind | null = null;

  constructor(private readonly api: DockviewApi) {
    this.disposables.push(api.onWillShowOverlay((event) => {
      if (isBusinessDockDrag(overlayDataTransfer(event))) {
        event.preventDefault();
      }
    }));
    this.disposables.push(
      api.onDidLayoutChange(() => {
        this.captureOpenPlacements();
        this.emitChange();
      }),
      api.onDidActivePanelChange(() => this.emitChange()),
      api.onDidMaximizedGroupChange(() => this.emitChange()),
    );
    // A StrictMode-ready replay may hand a fresh adapter an API whose Panels
    // were already registered by the first pass. Seed recovery metadata from
    // that live tree instead of waiting for another layout mutation.
    this.captureOpenPlacements();
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

    const media = this.addPanel("media", {
      initialWidth: Math.round(width * 0.22),
    });
    this.addPanel("preview", {
      position: { referencePanel: "media", direction: "right" },
      initialWidth: Math.round(width * 0.53),
    });
    const attribute = this.addPanel("attribute", {
      position: { referencePanel: "preview", direction: "right" },
      initialWidth: Math.round(width * 0.25),
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
      initialHeight: Math.round(height * 0.38),
    });

    // `initialWidth` sizes the newly inserted split, so later insertions can
    // redistribute an earlier sibling. Clamp the two anchored columns after
    // the complete tree exists; Preview naturally receives the 53% remainder.
    media?.api.setSize({ width: Math.round(width * 0.22) });
    attribute?.api.setSize({ width: Math.round(width * 0.25) });
    timeline?.api.setSize({ height: Math.round(height * 0.38) });
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

  resetWorkspace(): void {
    if (this.api.hasMaximizedGroup()) this.api.exitMaximizedGroup();
    this.api.clear();
    this.lastPlacements.clear();
    this.hoveredPanel = null;
    this.initializeEditingLayout();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.listeners.clear();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }

  private captureOpenPlacements(): void {
    for (const panel of this.api.panels) this.capturePlacement(panel);
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
        | { direction: "below" }
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
      title: definition.title,
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
