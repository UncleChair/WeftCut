/// Phase A.5 — `<Layer>` React wrapper.
///
/// Hybrid React + ref model (`docs/preview-dom.md` Q6 lifecycle decision):
/// React owns *which* layers exist via the parent's keyed list; this
/// component creates exactly one handle per `layer.id` in
/// `useEffect([layer.id])` and never re-mounts during the layer's
/// lifetime. All per-frame state updates flow through the handle's ref,
/// never through React re-render — so decoder state survives every
/// parent reconciliation.
///
/// Layer kinds not yet handled in Phase A (Template / Subtitles / Text /
/// Audio-as-subtitle-source) render an empty placeholder; they land in
/// later phases (templates in C, subtitles in D, drawtext in B).

import { useEffect, useRef } from "react";

import type { LayerSummary } from "../../ipc";
import type { AudioGraph } from "./audio/AudioGraph";
import type { LayerHandle, PlaybackEngine } from "./PlaybackEngine";
import { AudioHandle } from "./handles/AudioHandle";
import { ColorHandle } from "./handles/ColorHandle";
import { ImageHandle } from "./handles/ImageHandle";
import { VideoClipHandle } from "./handles/VideoClipHandle";
import type { HandleContext } from "./handles/types";

interface Props {
  layer: LayerSummary;
  engine: PlaybackEngine;
  audioGraph: AudioGraph | null;
}

export function Layer({ layer, engine, audioGraph }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Single mount-per-layer effect. Deps include only `layer.id` so
  // that an edit to the layer's params (transform, opacity, src_in,
  // etc.) DOESN'T tear down the handle. The handle reads fresh
  // params from `useProjectStore` each tick.
  //
  // `audioGraph` is included only because changing it would require
  // re-attaching the element through a different graph — in
  // practice this ref is stable for the engine's lifetime.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ctx: HandleContext = {
      layerId: layer.id,
      container,
      audioGraph,
    };

    const handle = createHandle(layer, ctx);
    if (!handle) return; // unsupported kind — leave the empty div in place

    engine.registerHandle(layer.id, handle);
    return () => {
      engine.unregisterHandle(layer.id);
      // unregisterHandle calls handle.dispose internally.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, engine, audioGraph]);

  return (
    <div
      ref={containerRef}
      data-layer-id={layer.id}
      data-layer-kind={layer.params.kind}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        // Children are absolutely-positioned inside; this wrapper
        // is a 0×0 anchor that doesn't affect parent layout. Each
        // handle controls its own element's size via inline styles.
      }}
    />
  );
}

function createHandle(layer: LayerSummary, ctx: HandleContext): LayerHandle | null {
  switch (layer.params.kind) {
    case "VideoClip":
      return new VideoClipHandle(ctx);
    case "Audio":
      return new AudioHandle(ctx);
    case "Color":
      return new ColorHandle(ctx);
    case "ImageOverlay":
      return new ImageHandle(ctx);
    case "Text":
    case "Subtitles":
    case "Template":
      // Phase B (Text via DrawText effect catalog), Phase C (Template),
      // Phase D (Subtitles libass-wasm). Layer renders an empty stub
      // until then; the export path still produces them correctly.
      return null;
  }
}
