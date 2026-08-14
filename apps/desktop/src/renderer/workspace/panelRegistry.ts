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
  "quick-actions",
  "attribute",
  "caption",
  "role-mixer",
  "effect",
  "nearby",
  "agent",
  "history",
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
 * The Quick Actions bar's thickness across its short axis, and equally the
 * floor on both axes: one button plus the drag grip is all the strip ever needs
 * in either direction, and `TOOL_MINIMUM`'s 240 px would pin the bar ~5.5× too
 * wide. Overflow scrolls, so this never hides a command permanently.
 *
 * Floor and thickness are ONE number on purpose: the strip's short axis is
 * pinned by holding its Group to `minimum === maximum` (see
 * `useFixedStripThickness` in DockWorkspace.tsx), which is only legal while the
 * thickness is not below the floor.
 */
export const STRIP_THICKNESS = 44;

const STRIP_MINIMUM = {
  minimumWidth: STRIP_THICKNESS,
  minimumHeight: STRIP_THICKNESS,
} as const;

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
  "quick-actions": {
    kind: "quick-actions",
    titleKey: "dock_workspace.panels.quick-actions",
    ...STRIP_MINIMUM,
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
  agent: {
    kind: "agent",
    titleKey: "dock_workspace.panels.agent",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  // Closed by default like the other on-demand tool Panels: the edit stack is
  // pulled over its own IPC channel (`project_history_view`), so a closed
  // History Panel costs exactly zero refetches — see spec decision 5.
  history: {
    kind: "history",
    titleKey: "dock_workspace.panels.history",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
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
