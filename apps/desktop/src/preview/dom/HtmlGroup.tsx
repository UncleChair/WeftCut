/// Phase H.4 — `<HtmlGroup>` React wrapper.
///
/// Mirrors `Layer.tsx` but keyed on the group's `GroupSummary.id`.
/// LiveLayers renders one `<HtmlGroup>` per active `Html`-mode group
/// (skipping individual `<Layer>`s for its members). The wrapper
/// creates exactly one `HtmlGroupHandle` per `groupId` in
/// `useEffect([groupId])`; all per-tick updates flow through the
/// handle's ref, never through React re-render.
///
/// Engine registration key is `html-group:<groupId>` to keep it
/// disjoint from per-layer handles (which key on layer id).

import { useEffect, useRef } from "react";

import { HtmlGroupHandle } from "./handles/HtmlGroupHandle";
import type { PlaybackEngine } from "./PlaybackEngine";

interface Props {
  groupId: string;
  engine: PlaybackEngine;
}

export function HtmlGroup({ groupId, engine }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = new HtmlGroupHandle({ groupId, container });
    const key = `html-group:${groupId}`;
    engine.registerHandle(key, handle);
    return () => {
      engine.unregisterHandle(key);
    };
  }, [groupId, engine]);

  return (
    <div
      ref={containerRef}
      data-html-group-id={groupId}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
      }}
    />
  );
}
