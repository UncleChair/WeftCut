import { useEffect, useRef } from "react";
import { unitBezier } from "../render/animated";

const DUR_MS = 1200;

/// A dot that travels a mini track on a loop, eased by the current curve.
/// `coeffs` = [x1,y1,x2,y2]. Uses requestAnimationFrame; pure visual.
export function MotionPreview({ coeffs }: { coeffs: [number, number, number, number] }) {
  const dotRef = useRef<HTMLDivElement>(null);
  const coeffsRef = useRef(coeffs);
  coeffsRef.current = coeffs;

  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const u = ((ts - start) % DUR_MS) / DUR_MS;
      const [x1, y1, x2, y2] = coeffsRef.current;
      const eased = unitBezier(x1, y1, x2, y2, u);
      if (dotRef.current) dotRef.current.style.left = `${eased * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="relative h-2 rounded-full"
      style={{ background: "var(--surface-2, #1b1b21)" }}
      data-testid="motion-preview"
    >
      <div
        ref={dotRef}
        className="absolute -top-1 size-4 -translate-x-1/2 rounded-full"
        style={{ left: "0%", background: "var(--ring, #3b82f6)" }}
      />
    </div>
  );
}
