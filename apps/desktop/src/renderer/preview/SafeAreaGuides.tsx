// Broadcast safe-area guides over the preview: an action-safe and a title-safe
// rectangle in composition space, mapped onto the canvas' `object-fit: contain`
// box. Read-only chrome — no gestures, no hit target.
//
// Screen-space SVG rather than Pixi children for the reason the gizmo's header
// gives (`TransformGizmo.tsx`): the stage is read back by the eyedropper and the
// conformance capture hooks. A SIBLING of that overlay, never part of it — a
// safe area is a property of the frame, so it needs no selected layer and must
// stay up while nothing is selected at all.
//
// Off by default, toggled from the View menu, remembered as an app preference
// (`safe_area_guides_visible` in `shared/app-settings.ts`) — never project
// state, so it records no history entry. See ADR 0049.

import { useEffect, useRef } from "react";

import type { CompositionSummary } from "../ipc";
import { useSafeAreaGuidesVisible } from "../settings/appSettingsStore";
import { useProjectStore } from "../state/projectStore";
import { compToClient, containFit } from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";

/// The delivery margins every broadcaster's spec is a restatement of, written as
/// the FRACTION of the frame the rectangle keeps: action-safe drops 3.5% per
/// side, title-safe 5%. Exported because they are constants a test can compare
/// against another module's margin — the caption importer's 8% box has to fall
/// inside title-safe, and a number nobody can read is a number nobody can check.
export const ACTION_SAFE_FRACTION = 0.93;
export const TITLE_SAFE_FRACTION = 0.9;

/// The rectangle `fraction` names, centred in the composition, in composition
/// pixels. Both margins are symmetric, which is what makes this one expression
/// rather than a per-edge table.
export function safeAreaRect(
  fraction: number,
  compW: number,
  compH: number,
): { x: number; y: number; w: number; h: number } {
  const w = compW * fraction;
  const h = compH * fraction;
  return { x: (compW - w) / 2, y: (compH - h) / 2, w, h };
}

/// Dashed, and hard-coded white over a dark backing rather than a theme token:
/// same two reasons the snap guides are hard-coded magenta (see
/// `TransformGizmo.tsx`) — the palette is achromatic and the preview has no
/// background of its own to read a hairline against. NOT the guides' magenta and
/// not `var(--ring)`: a safe area is neither a gesture's result nor part of the
/// selection's chrome.
const SAFE_AREA_COLOR = "rgba(255, 255, 255, 0.85)";
const SAFE_AREA_WIDTH_PX = 1;
const SAFE_AREA_DASH = "6 4";
const SAFE_AREA_UNDER_COLOR = "rgba(0, 0, 0, 0.5)";
const SAFE_AREA_UNDER_WIDTH_PX = 3;

/// Mounts the overlay only while the preference is on and a composition exists
/// — the two things the rectangles are defined in terms of. Keyed on neither
/// selection nor playhead: a safe area does not move.
export function SafeAreaGuidesHost() {
  const visible = useSafeAreaGuidesVisible();
  const composition = useProjectStore((s) => s.summary?.composition);
  if (!visible || !composition) return null;
  return <SafeAreaGuides composition={composition} />;
}

function SafeAreaGuides({ composition }: { composition: CompositionSummary }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const actionRef = useRef<SVGGElement | null>(null);
  const titleRef = useRef<SVGGElement | null>(null);
  // Latest composition for the rAF loop, so a project resize doesn't have to
  // restart it (the gizmo's `compRef` for the same reason).
  const compRef = useRef(composition);
  compRef.current = composition;

  useEffect(() => {
    let frame = 0;
    /// Write one band's geometry onto both of its rects — the dark under-stroke
    /// and the bright line share a rectangle and differ only in stroke.
    const paint = (
      el: SVGGElement | null,
      r: { x: number; y: number; w: number; h: number },
    ): void => {
      if (!el) return;
      el.style.display = "";
      for (let i = 0; i < el.children.length; i += 1) {
        const rect = el.children[i]!;
        rect.setAttribute("x", String(r.x));
        rect.setAttribute("y", String(r.y));
        rect.setAttribute("width", String(r.w));
        rect.setAttribute("height", String(r.h));
      }
    };
    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      const svg = svgRef.current;
      if (!svg) return;
      const hide = (): void => {
        if (actionRef.current) actionRef.current.style.display = "none";
        if (titleRef.current) titleRef.current.style.display = "none";
      };
      // The canvas box, not the panel's: the canvas is contain-sized inside the
      // panel, and the guides belong to the frame.
      const rect = getGizmoProbe()?.canvasRect();
      if (!rect) return hide();
      const comp = compRef.current;
      const fit = containFit(rect, comp.width, comp.height);
      if (!fit) return hide();
      // The SVG is inset:0 in the preview panel, so its own client origin comes
      // off the mapped point — a pure translation, like the gizmo's `local`.
      const own = svg.getBoundingClientRect();
      const bandRect = (fraction: number) => {
        const r = safeAreaRect(fraction, comp.width, comp.height);
        const at = compToClient({ x: r.x, y: r.y }, fit);
        return {
          x: at.x - own.left,
          y: at.y - own.top,
          w: r.w * fit.scale,
          h: r.h * fit.scale,
        };
      };
      paint(actionRef.current, bandRect(ACTION_SAFE_FRACTION));
      paint(titleRef.current, bandRect(TITLE_SAFE_FRACTION));
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <svg
      ref={svgRef}
      data-testid="safe-area-guides"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      {/* Action-safe first, so title-safe — the inner, tighter rectangle, and
          the one a caption is sized against — paints over it wherever a small
          preview collapses the two onto the same pixel. */}
      {band("safe-area-guide-action", actionRef)}
      {band("safe-area-guide-title", titleRef)}
    </svg>
  );
}

/// One band's markup: the dark under-stroke, then the bright dashed line over
/// it. Geometry comes from the draw loop; this fixes only the paint. A plain
/// helper rather than a component — it holds no state and the ref belongs to the
/// loop's owner.
function band(testId: string, ref: React.Ref<SVGGElement>) {
  return (
    <g ref={ref} data-testid={testId} style={{ pointerEvents: "none", display: "none" }}>
      <rect
        fill="none"
        style={{
          stroke: SAFE_AREA_UNDER_COLOR,
          strokeWidth: SAFE_AREA_UNDER_WIDTH_PX,
          strokeDasharray: SAFE_AREA_DASH,
        }}
      />
      <rect
        fill="none"
        style={{
          stroke: SAFE_AREA_COLOR,
          strokeWidth: SAFE_AREA_WIDTH_PX,
          strokeDasharray: SAFE_AREA_DASH,
        }}
      />
    </g>
  );
}
