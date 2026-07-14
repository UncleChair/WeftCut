import type { LayerParamsView } from "../ipc";

export interface TimelineLayerTheme {
  surface: string;
  accent: string;
}

const THEMES: Record<
  Exclude<LayerParamsView["kind"], "Color">,
  TimelineLayerTheme
> = {
  VideoClip: { surface: "#1a222d", accent: "#6f91b8" },
  Audio: { surface: "#152723", accent: "#55b09d" },
  ImageOverlay: { surface: "#24212e", accent: "#9786bc" },
  Text: { surface: "#2a251b", accent: "#d2a65d" },
  Motif: { surface: "#28202e", accent: "#b17bc1" },
};

/**
 * Timeline chrome is semantic by media kind, rather than being derived from
 * a layer UUID. Color layers are the deliberate exception: their real fill
 * is the useful preview, so they keep the project-provided color hint.
 */
export function timelineLayerTheme(
  kind: LayerParamsView["kind"],
  colorHint: string,
): TimelineLayerTheme {
  if (kind === "Color") {
    return { surface: colorHint, accent: "transparent" };
  }
  return THEMES[kind];
}
