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
  title: string;
  minimumWidth: number;
  minimumHeight: number;
  initiallyOpen: boolean;
}

const TOOL_MINIMUM = { minimumWidth: 240, minimumHeight: 160 } as const;

/**
 * The complete v1 Panel catalogue. Panel identity is the semantic kind: no
 * second instance id exists anywhere above the Dockview adapter boundary.
 */
export const PANEL_REGISTRY: Readonly<Record<PanelKind, PanelDefinition>> = {
  media: {
    kind: "media",
    title: "Media Pool",
    minimumWidth: 240,
    minimumHeight: 160,
    initiallyOpen: true,
  },
  preview: {
    kind: "preview",
    title: "Preview",
    minimumWidth: 320,
    minimumHeight: 180,
    initiallyOpen: true,
  },
  timeline: {
    kind: "timeline",
    title: "Timeline",
    minimumWidth: 420,
    minimumHeight: 180,
    initiallyOpen: true,
  },
  attribute: {
    kind: "attribute",
    title: "Attribute",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  caption: {
    kind: "caption",
    title: "Caption",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  "role-mixer": {
    kind: "role-mixer",
    title: "Role Mixer",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  effect: {
    kind: "effect",
    title: "Effect",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  nearby: {
    kind: "nearby",
    title: "Nearby",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
};

export const EDITING_OPEN_PANEL_KINDS = PANEL_KINDS.filter(
  (kind) => PANEL_REGISTRY[kind].initiallyOpen,
);

export function isPanelKind(value: unknown): value is PanelKind {
  return (
    typeof value === "string" &&
    (PANEL_KINDS as readonly string[]).includes(value)
  );
}

