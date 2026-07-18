import i18n from "../i18n";

/** Dockview component ids for the single WeftCut Panel + tab renderers. Kept
 *  here (not in the adapter) so the persistence layer can synthesize Panel
 *  definitions on restore without importing the adapter — keeping the module
 *  graph one-directional (adapter → workspaceLayout, never the reverse). */
export const DOCK_COMPONENT_ID = "weftcut-panel";
export const DOCK_TAB_COMPONENT_ID = "weftcut-tab";

export const PANEL_KINDS = [
  "media",
  "preview",
  "timeline",
  "attribute",
  "caption",
  "role-mixer",
  "effect",
  "nearby",
] as const;

export type PanelKind = (typeof PANEL_KINDS)[number];

export interface PanelDefinition {
  kind: PanelKind;
  titleKey: `dock_workspace.panels.${PanelKind}`;
  minimumWidth: number;
  minimumHeight: number;
  initiallyOpen: boolean;
}

const TOOL_MINIMUM = { minimumWidth: 240, minimumHeight: 160 } as const;

/**
 * The complete Panel catalogue. Panel identity is the semantic kind: no
 * second instance id exists anywhere above the Dockview adapter boundary.
 */
export const PANEL_REGISTRY: Readonly<Record<PanelKind, PanelDefinition>> = {
  media: {
    kind: "media",
    titleKey: "dock_workspace.panels.media",
    minimumWidth: 240,
    minimumHeight: 160,
    initiallyOpen: true,
  },
  preview: {
    kind: "preview",
    titleKey: "dock_workspace.panels.preview",
    minimumWidth: 320,
    minimumHeight: 180,
    initiallyOpen: true,
  },
  timeline: {
    kind: "timeline",
    titleKey: "dock_workspace.panels.timeline",
    minimumWidth: 420,
    minimumHeight: 180,
    initiallyOpen: true,
  },
  attribute: {
    kind: "attribute",
    titleKey: "dock_workspace.panels.attribute",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  caption: {
    kind: "caption",
    titleKey: "dock_workspace.panels.caption",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  "role-mixer": {
    kind: "role-mixer",
    titleKey: "dock_workspace.panels.role-mixer",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  effect: {
    kind: "effect",
    titleKey: "dock_workspace.panels.effect",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  nearby: {
    kind: "nearby",
    titleKey: "dock_workspace.panels.nearby",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
};

export function panelTitle(kind: PanelKind): string {
  return i18n.t(PANEL_REGISTRY[kind].titleKey);
}

export const EDITING_OPEN_PANEL_KINDS = PANEL_KINDS.filter(
  (kind) => PANEL_REGISTRY[kind].initiallyOpen,
);

export function isPanelKind(value: unknown): value is PanelKind {
  return (
    typeof value === "string" &&
    (PANEL_KINDS as readonly string[]).includes(value)
  );
}
