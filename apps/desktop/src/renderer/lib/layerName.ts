import type { LayerSummary } from "../ipc";

/// The one name a layer is shown under, anywhere it is named: its own label,
/// else the source file it came from, else its translated kind.
///
/// A blank label counts as absent — clearing the inline-rename field must leave
/// a clip named after its media, not nameless. A uuid is NEVER a name: it tells
/// the user nothing and displaces the text that would. Call this instead of
/// `layer.label ?? layer.id`.
///
/// `t` is structurally typed rather than `TFunction` so callers can pass
/// `useTranslation().t` straight through (same pattern as NearbyPanel's
/// `formatOffset`).
export function layerDisplayName(
  layer: LayerSummary,
  t: (key: string, values: Record<string, unknown>) => string,
): string {
  const own = layer.label?.trim();
  if (own) return own;
  const media =
    "media_label" in layer.params ? layer.params.media_label.trim() : "";
  if (media) return media;
  return t(`kinds.${layer.kind.toLowerCase()}`, { defaultValue: layer.kind });
}
