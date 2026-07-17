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
export class DockWorkspaceAdapter {
  private readonly overlayGuard: Disposable;

  constructor(private readonly api: DockviewApi) {
    this.overlayGuard = api.onWillShowOverlay((event) => {
      if (isBusinessDockDrag(overlayDataTransfer(event))) {
        event.preventDefault();
      }
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
    return true;
  }

  /** Foundation for later View-menu recovery; enforces the singleton now. */
  openPanel(kind: PanelKind): void {
    const existing = this.api.getPanel(kind);
    if (existing) {
      existing.api.setActive();
      return;
    }

    const contextualReference = this.api.getPanel("attribute")
      ? "attribute"
      : this.api.getPanel("preview")
        ? "preview"
        : undefined;

    if (contextualReference) {
      this.addPanel(kind, {
        position: {
          referencePanel: contextualReference,
          direction: contextualReference === "attribute" ? "within" : "right",
        },
      });
    } else {
      this.addPanel(kind);
    }
  }

  hasPanel(kind: PanelKind): boolean {
    return this.api.getPanel(kind) !== undefined;
  }

  dispose(): void {
    this.overlayGuard.dispose();
  }

  private addPanel(
    kind: PanelKind,
    placement: {
      position?:
        | { direction: "below" }
        | {
            referencePanel: string;
            direction: "right" | "within";
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
