import { useEffect, useRef } from "react";
import { unitBezier } from "../render/animated";
import { handleToCoeff, coeffToHandle } from "../keyframe/curve";

const SIZE = 160; // px unit square

/// Editable cubic-bezier curve. `coeffs` = [x1,y1,x2,y2]; emits new coeffs on
/// drag. Handle x is clamped to [0,1] (monotone time); y is free (overshoot).
export function EasingCanvas({
  coeffs,
  onChange,
  disabled,
}: {
  coeffs: [number, number, number, number];
  onChange: (next: [number, number, number, number]) => void;
  disabled?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Tear down an in-flight drag if the component unmounts mid-drag (e.g. the
  // popover is dismissed via Escape) so the window listeners can't leak.
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);
  const [x1, y1, x2, y2] = coeffs;

  // Curve path: 40 sampled points through unitBezier (visualizes overshoot too).
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    const y = unitBezier(x1, y1, x2, y2, x);
    pts.push(`${x * SIZE},${(1 - y) * SIZE}`);
  }

  const [h1x, h1y] = coeffToHandle(x1, y1, SIZE);
  const [h2x, h2y] = coeffToHandle(x2, y2, SIZE);

  function dragHandle(which: 1 | 2, e: React.PointerEvent) {
    if (disabled) return;
    e.stopPropagation();
    const rect = svgRef.current!.getBoundingClientRect();
    const move = (me: PointerEvent) => {
      const [cx, cy] = handleToCoeff(me.clientX - rect.left, me.clientY - rect.top, SIZE);
      onChange(which === 1 ? [cx, cy, x2, y2] : [x1, y1, cx, cy]);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      teardownRef.current = null;
    };
    teardownRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={disabled ? "opacity-40" : ""}
      data-testid="easing-canvas"
    >
      <rect x="0" y="0" width={SIZE} height={SIZE} fill="var(--surface-2, #1b1b21)" stroke="var(--border-soft, #3a3a42)" />
      <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="var(--border-soft, #3a3a42)" strokeDasharray="3 3" opacity="0.4" />
      {!disabled && (
        <>
          <line x1="0" y1={SIZE} x2={h1x} y2={h1y} stroke="var(--ring, #6b6bff)" strokeWidth="1.5" />
          <line x1={SIZE} y1="0" x2={h2x} y2={h2y} stroke="var(--ring, #6b6bff)" strokeWidth="1.5" />
        </>
      )}
      <polyline points={pts.join(" ")} fill="none" stroke="var(--ring, #9a9aff)" strokeWidth="2" />
      {!disabled && (
        <>
          <circle cx={h1x} cy={h1y} r="6" fill="var(--ring, #6b6bff)" style={{ cursor: "grab" }}
            onPointerDown={(e) => dragHandle(1, e)} data-testid="easing-handle-1" />
          <circle cx={h2x} cy={h2y} r="6" fill="var(--ring, #6b6bff)" style={{ cursor: "grab" }}
            onPointerDown={(e) => dragHandle(2, e)} data-testid="easing-handle-2" />
        </>
      )}
    </svg>
  );
}
