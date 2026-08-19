import { TEXT_NAME_MAX, textSnippet } from "../../shared/textSnippet";
import type { LayerSummary } from "../ipc";

/// The one name a layer is shown under, anywhere it is named: its own label,
/// else the source file it came from, else — for a Text layer — the words it
/// actually renders, else its translated kind.
///
/// The Text rung is there because `kinds.text` is the one kind name that adds
/// nothing: every surface that shows it also shows a Type glyph beside it, and
/// nothing in the app ever WRITES a Text layer's label (`applyAddLayer` stores
/// `label: null`, and an .srt import runs it per cue), so without this rung a
/// hundred imported captions all read "Text". The search palette already names
/// captions by content — search/buildEntries.ts takes the same view from the
/// other end — so this makes the timeline agree with the palette rather than
/// inventing a rule.
///
/// A blank label counts as absent — clearing the inline-rename field must leave
/// a clip named after its media, not nameless. Blank CONTENT is absent for the
/// same reason, so an empty Text layer still reaches its kind rather than
/// rendering a zero-width name. A uuid is NEVER a name: it tells the user
/// nothing and displaces the text that would. Call this instead of
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
  if (layer.params.kind === "Text") {
    const content = textSnippet(layer.params.content, TEXT_NAME_MAX);
    if (content) return content;
  }
  return t(`kinds.${layer.kind.toLowerCase()}`, { defaultValue: layer.kind });
}
