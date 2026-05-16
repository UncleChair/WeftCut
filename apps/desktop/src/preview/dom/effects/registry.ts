/// Phase B.4 — effect catalog scaffolding.
///
/// One entry per effect kind. Export consumers use `ffmpegLavfi` to
/// produce filter-graph snippets at lower time; preview consumers
/// use `css` to produce a per-frame CSSStyleDeclaration patch that
/// the layer handle applies on top of its base rendering. `supported`
/// flags which side of the divide an entry sits on.
///
/// **No live consumer today.** The `LayerSummary` IPC view does not
/// expose a layer's `effects: imbl::Vector<Effect>` field; effects
/// land via Phase 4's keyframe MCP work. This file is the
/// architectural contract — when effects are surfaced, both the
/// export lowering and the preview compositor consult the same
/// registry so divergence is caught at the boundary, not at runtime.
///
/// Why scaffold now: every new effect must add both a `ffmpegLavfi`
/// (required for export) and a `css?` (best-effort preview). The
/// registry shape makes that contract explicit so a contributor
/// adding a Phase 4 effect can't silently ship an export-only or
/// preview-only path.

/// A single per-frame CSS patch the preview applies on top of a
/// layer's base style. Keys are camelCase CSSStyleDeclaration
/// properties (`filter`, `backgroundColor`, etc.) — `Partial`
/// because most effects touch one or two properties.
export type CssPatch = Partial<CSSStyleDeclaration>;

/// Effect kind identifiers. Mirror the future Rust enum variants
/// (placeholder for now). Add to this union as effects ship.
export type EffectId = "Blur" | "Brightness";

/// Catalog entry. The `supported` flag enforces the Q1 fidelity
/// contract: export-only effects render the layer in preview
/// without the effect, and (once a consumer wires `WarningBadge`)
/// show a "⚠ preview unavailable" indicator.
export interface EffectCatalogEntry<P = unknown> {
  id: EffectId;
  supported: "preview-ok" | "export-only";
  /// Produce the ffmpeg lavfi-graph snippet for export. Required.
  /// Today's signature is intentionally loose — Phase 4's
  /// keyframe MCP work will tighten this against a typed Effect
  /// enum.
  ffmpegLavfi: (params: P) => string;
  /// Produce the CSS patch for preview. `t` is master time in
  /// microseconds; the patch may animate. Returning `null` is
  /// equivalent to omitting `css` entirely — the layer renders
  /// without the effect and the warning-badge path engages.
  css?: (params: P, t: number) => CssPatch | null;
}

/// Composition of multiple effect patches onto a base style. Last
/// patch wins on conflicting keys, matching CSS cascade semantics.
export function composeCssPatches(...patches: readonly CssPatch[]): CssPatch {
  const out: CssPatch = {};
  for (const p of patches) Object.assign(out, p);
  return out;
}

/// Initial catalog. Two entries; both fictional today (the
/// `LayerSummary.params` doesn't carry effects). The Brightness
/// entry demonstrates a `css` ↔ `ffmpeg` pair (mappable to a CSS
/// `filter` token); the Blur entry demonstrates the export-only
/// path with no `css` (CSS `filter: blur()` exists but the math
/// doesn't match ffmpeg's `gblur` — accept the gap per Q1).
const CATALOG: Record<EffectId, EffectCatalogEntry<unknown>> = {
  Brightness: {
    id: "Brightness",
    supported: "preview-ok",
    ffmpegLavfi: (params) => {
      const { value } = params as { value: number };
      // ffmpeg `eq=brightness=N` — N in [-1, 1] roughly maps to a
      // CSS `filter: brightness(1 + N)` factor.
      return `eq=brightness=${value.toFixed(3)}`;
    },
    css: (params) => {
      const { value } = params as { value: number };
      return { filter: `brightness(${(1 + value).toFixed(3)})` };
    },
  },
  Blur: {
    id: "Blur",
    supported: "export-only",
    ffmpegLavfi: (params) => {
      const { sigma } = params as { sigma: number };
      return `gblur=sigma=${sigma.toFixed(2)}`;
    },
    // No `css` — CSS `filter: blur()` is close visually but the
    // math diverges from `gblur` math. Render & Play is the
    // verification path (Q1). When this is acceptable lossy
    // preview is added, set `css` and flip `supported` to
    // `preview-ok`.
  },
};

export function getEffect<P>(id: EffectId): EffectCatalogEntry<P> | undefined {
  return CATALOG[id] as EffectCatalogEntry<P> | undefined;
}

/// True iff an effect renders correctly in preview. Consumers use
/// this to drive the `WarningBadge` overlay on layers with at
/// least one `export-only` effect.
export function isPreviewSupported(id: EffectId): boolean {
  return CATALOG[id]?.supported === "preview-ok";
}

/// All registered effect IDs. Test surfaces — production code
/// looks up by id.
export function listEffectIds(): EffectId[] {
  return Object.keys(CATALOG) as EffectId[];
}
