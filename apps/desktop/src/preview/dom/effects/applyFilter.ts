/// Per-layer effect application for standalone (non-composition) preview.
///
/// The composition-path engine (`composition/engine.ts`) applies effects
/// inside an html-render group. Standalone layers — a single layer not
/// in any group, carrying HtmlTransform or Blur — go through the
/// regular per-handle preview path (`Layer.tsx` → `VideoClipHandle` /
/// `ImageHandle` / `TextHandle` / `ColorHandle`). Each handle calls
/// `buildLayerTransform(base, layer.effects, tLocal)` +
/// `buildLayerFilter(...)` + `buildLayerOpacityMultiplier(...)` once
/// per tick and writes the results to its host element's style.
///
/// Keep the Animated<f64> resolution in sync with the composition
/// engine's `resolveAnimated` (`composition/engine.ts`). They must
/// produce identical values at identical `t` so a user who wraps the
/// layer in a group later doesn't see the effect jump.

import type { AnimTrack, Effect } from "../../../ipc";

function resolveAnimated(
  track: AnimTrack<number>,
  tUs: number,
  fallback: number,
): number {
  if (track.mode === "Static") return track.value;
  const kfs = track.value;
  if (kfs.length === 0) return fallback;
  if (kfs.length === 1) return kfs[0]!.value;
  if (tUs <= kfs[0]!.t_us) return kfs[0]!.value;
  if (tUs >= kfs[kfs.length - 1]!.t_us) return kfs[kfs.length - 1]!.value;
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1]!.t_us <= tUs) i++;
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  const span = b.t_us - a.t_us;
  if (span <= 0) return b.value;
  let u = (tUs - a.t_us) / span;
  const interp = a.interp.kind;
  if (interp === "Hold") return a.value;
  if (interp === "EaseIn") u = u * u;
  else if (interp === "EaseOut") {
    const iu = 1 - u;
    u = 1 - iu * iu;
  }
  // Bezier: linear approximation for v1 — matches the composition
  // engine's shortcut (`composition/engine.ts`).
  return a.value + (b.value - a.value) * u;
}

/// Compose every enabled filter-producing effect on a layer into one
/// CSS `filter` value. Returns "" when no contributors are active —
/// callers should write the empty string back to clear any prior
/// frame's filter (a non-empty filter would otherwise stick).
///
/// `tLayerLocalUs` is `masterUs - layer.t_start_us`; effect tracks
/// are authored in owner-local time so they restart with the layer.
/// Clamping `< 0` to 0 keeps lookbehind-mounted layers (LiveLayers'
/// 500 ms pre-window) from seeing negative time.
export function buildLayerFilter(
  effects: readonly Effect[] | undefined,
  tLayerLocalUs: number,
): string {
  if (!effects || effects.length === 0) return "";
  const t = Math.max(0, tLayerLocalUs);
  const parts: string[] = [];
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.params.kind === "Blur") {
      const radius = resolveAnimated(e.params.radius, t, 0);
      if (radius > 0) parts.push("blur(" + radius + "px)");
    }
  }
  return parts.join(" ");
}

/// Static "base" transform a layer applies before any effect. Carries
/// flip flags pre-folded into `scale_x` / `scale_y` so callers don't
/// have to remember the sign convention.
export interface BaseTransform {
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
}

/// Compose a layer's base transform with every enabled `HtmlTransform`
/// effect's per-frame contribution. Returns a CSS `transform:` value
/// ready to write to `style.transform`.
///
/// Composition rule (same as the composition engine's `applyLayer`):
///   translate adds, scale multiplies, rotation adds. Multiple
///   HtmlTransforms in one chain accumulate (first → last). When no
///   HtmlTransforms are present the returned string is just the base
///   transform, so callers can use one code path regardless.
export function buildLayerTransform(
  base: BaseTransform,
  effects: readonly Effect[] | undefined,
  tLayerLocalUs: number,
): string {
  const t = Math.max(0, tLayerLocalUs);
  let dx = 0;
  let dy = 0;
  let dsx = 1;
  let dsy = 1;
  let drot = 0;
  if (effects) {
    for (const e of effects) {
      if (!e.enabled) continue;
      if (e.params.kind === "HtmlTransform") {
        dx += resolveAnimated(e.params.x, t, 0);
        dy += resolveAnimated(e.params.y, t, 0);
        dsx *= resolveAnimated(e.params.scale_x, t, 1);
        dsy *= resolveAnimated(e.params.scale_y, t, 1);
        drot += resolveAnimated(e.params.rotation_deg, t, 0);
      }
    }
  }
  const tx = base.x + dx;
  const ty = base.y + dy;
  const sx = base.scale_x * dsx;
  const sy = base.scale_y * dsy;
  return (
    "translate(" + tx + "px, " + ty + "px) " +
    "rotate(" + drot + "deg) " +
    "scale(" + sx + ", " + sy + ")"
  );
}

/// Multiplier on a layer's fade-resolved opacity from every enabled
/// `HtmlTransform.opacity` track. Returns 1 when no HtmlTransforms are
/// present. Callers apply as `finalOpacity = fadeResolvedOpacity *
/// buildLayerOpacityMultiplier(...)`.
export function buildLayerOpacityMultiplier(
  effects: readonly Effect[] | undefined,
  tLayerLocalUs: number,
): number {
  if (!effects || effects.length === 0) return 1;
  const t = Math.max(0, tLayerLocalUs);
  let m = 1;
  for (const e of effects) {
    if (!e.enabled) continue;
    if (e.params.kind === "HtmlTransform") {
      m *= resolveAnimated(e.params.opacity, t, 1);
    }
  }
  return m;
}
