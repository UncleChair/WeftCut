import { useEffect, useState } from "react";
import { getGizmoProbe } from "../preview/gizmoProbeRegistry";
import type { TextFit } from "../render/textBox";

function sameFit(a: TextFit | null, b: TextFit | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.authoredPx === b.authoredPx &&
    a.effectivePx === b.effectivePx &&
    a.overflowing === b.overflowing
  );
}

/// What the renderer actually did with a Text layer's font size, sampled per
/// frame so the inspector's reduced-size notice can never disagree with the
/// canvas by more than a frame.
///
/// Polled rather than subscribed because `GizmoProbe.textFitOf` is a call into
/// the compositor, not a store: the shrink search runs when the SPRITE restages,
/// which is at least a frame after the `project:changed` re-render that carried
/// the new box, and nothing fires when the answer changes. A read taken during
/// render would answer about the previous box.
///
/// `enabled` is what keeps the loop off the idle path. Shrink belongs to Fixed
/// alone (ADR 0049), so in either auto mode there is nothing to sample and no
/// frame is ever requested; selecting a non-Text layer unmounts the caller
/// outright. Only the changed samples reach React, so a steady frame costs one
/// probe call and no render.
export function useTextFit(layerId: string, enabled: boolean): TextFit | null {
  const [fit, setFit] = useState<TextFit | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFit(null);
      return;
    }
    // `undefined` (not null) is the "nothing sampled yet" sentinel, so the first
    // sample always commits — otherwise switching layers would keep displaying
    // the previous one's fit whenever the new one reads null.
    let last: TextFit | null | undefined;
    let frame = 0;
    const sample = (): void => {
      frame = requestAnimationFrame(sample);
      const next = getGizmoProbe()?.textFitOf(layerId) ?? null;
      if (last !== undefined && sameFit(next, last)) return;
      last = next;
      setFit(next);
    };
    frame = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(frame);
  }, [layerId, enabled]);

  return fit;
}
