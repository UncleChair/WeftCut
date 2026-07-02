import { useCallback, useEffect, useRef, useState } from "react";

/// Per-segment viewport visibility for a horizontally tiled canvas strip
/// (filmstrip / waveform): ONE shared IntersectionObserver per strip watches
/// every registered segment canvas (same margins as usePreviewResourceGate);
/// the consumer's request, draw, and data-state passes consult only segments
/// it has reported visible. Without IntersectionObserver (jsdom /
/// non-browser), every segment counts as visible — the unclipped behavior
/// tests rely on.
export function useSegmentVisibility(): {
  isSegmentVisible: (startPx: number) => boolean;
  observeSegment: (el: HTMLCanvasElement, startPx: number) => () => void;
  visibilityVersion: number;
} {
  const visibleSegsRef = useRef<Set<number>>(new Set());
  const segElsRef = useRef<Map<Element, number>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [visibilityVersion, setVisibilityVersion] = useState(0);

  const isSegmentVisible = useCallback(
    (startPx: number) =>
      typeof IntersectionObserver === "undefined" || visibleSegsRef.current.has(startPx),
    [],
  );

  /// Registers one segment canvas with the (lazily created) shared observer;
  /// returns the unobserve cleanup. Passed down so each segment can observe
  /// itself on mount without the parent tracking element refs.
  const observeSegment = useCallback((el: HTMLCanvasElement, startPx: number): (() => void) => {
    if (typeof IntersectionObserver === "undefined") return () => {};
    let observer = observerRef.current;
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          let changed = false;
          for (const entry of entries) {
            const start = segElsRef.current.get(entry.target);
            if (start === undefined) continue;
            const visible = entry.isIntersecting || entry.intersectionRatio > 0;
            if (visible !== visibleSegsRef.current.has(start)) {
              if (visible) visibleSegsRef.current.add(start);
              else visibleSegsRef.current.delete(start);
              changed = true;
            }
          }
          // One bump both re-renders (segments learn their `visible` prop and
          // repaint) and re-runs the request pass immediately — a segment
          // scrolling into view must not wait out the param-churn debounce.
          if (changed) setVisibilityVersion((v) => v + 1);
        },
        { root: null, rootMargin: "256px 512px" },
      );
      observerRef.current = observer;
    }
    segElsRef.current.set(el, startPx);
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      segElsRef.current.delete(el);
      visibleSegsRef.current.delete(startPx);
    };
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { isSegmentVisible, observeSegment, visibilityVersion };
}
