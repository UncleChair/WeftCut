import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@/bridge/ipc";
import {
  LAYER_LABEL_MIN_PX,
  LAYER_PREVIEW_MIN_PX,
} from "./geometry";
import { TimelineFilmstrip } from "./TimelineFilmstrip";
import { TimelineWaveform } from "./TimelineWaveform";
import { trackStatic, type LayerSummary, type Rgba } from "../ipc";
import { useMediaById } from "../state/projectStore";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rgbaToCss(color: Rgba): string {
  const alpha = color.a / 255;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp01(alpha)})`;
}

function compactText(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "Text";
  return clean.length > 64 ? `${clean.slice(0, 61)}...` : clean;
}

function fallbackFill(colorHint: string) {
  return (
    <div
      className="h-full w-full"
      style={{
        backgroundColor: colorHint,
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0.18))",
      }}
    />
  );
}

function usePreviewResourceGate(enabledByWidth: boolean) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(
    () => enabledByWidth && typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!enabledByWidth) {
      setEnabled(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setEnabled(true);
      return;
    }
    const element = rootRef.current;
    if (!element) return;
    setEnabled(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting || entry.intersectionRatio > 0,
          )
        ) {
          setEnabled(true);
        }
      },
      {
        root: null,
        rootMargin: "256px 512px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabledByWidth]);

  return { enabled, rootRef };
}

function colorFill(color: Rgba, colorHint: string) {
  const alpha = color.a / 255;
  if (alpha < 0.98) {
    const fill = rgbaToCss(color);
    return (
      <div
        className="h-full w-full"
        style={{
          backgroundColor: colorHint,
          backgroundImage: [
            `linear-gradient(${fill}, ${fill})`,
            "linear-gradient(45deg, rgba(255,255,255,0.18) 25%, transparent 25%)",
            "linear-gradient(-45deg, rgba(255,255,255,0.18) 25%, transparent 25%)",
            "linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.18) 75%)",
            "linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.18) 75%)",
          ].join(", "),
          backgroundPosition: "0 0, 0 0, 0 4px, 4px -4px, -4px 0",
          backgroundSize: "auto, 8px 8px, 8px 8px, 8px 8px, 8px 8px",
        }}
      />
    );
  }
  return (
    <div className="h-full w-full" style={{ backgroundColor: rgbaToCss(color) }} />
  );
}

export function TimelineVisualPreview({
  layer,
  layerWidthPx,
  layerHeightPx,
  pxPerSec,
}: {
  layer: LayerSummary;
  layerWidthPx: number;
  layerHeightPx: number;
  pxPerSec: number;
}) {
  const canRenderPreview = layerWidthPx >= LAYER_PREVIEW_MIN_PX;
  const { enabled: resourceEnabled, rootRef } =
    usePreviewResourceGate(canRenderPreview);
  const imageMedia = useMediaById(
    layer.params.kind === "ImageOverlay" ? layer.params.media_id : null,
  );
  const audioMedia = useMediaById(
    layer.params.kind === "Audio" ? layer.params.media_id : null,
  );
  if (!canRenderPreview) return null;

  const preview = (() => {
    switch (layer.params.kind) {
      case "VideoClip":
        return (
          <TimelineFilmstrip
            mediaId={layer.params.media_id}
            srcInUs={layer.params.src_in_us}
            srcOutUs={layer.params.src_out_us}
            layerWidthPx={layerWidthPx}
            colorHint={layer.color_hint}
            enabled={resourceEnabled}
          />
        );
      case "Audio":
        return (
          <TimelineWaveform
            mediaId={layer.params.media_id}
            srcInUs={layer.params.src_in_us}
            srcOutUs={layer.params.src_out_us}
            layerWidthPx={layerWidthPx}
            layerHeightPx={layerHeightPx}
            colorHint={layer.color_hint}
            enabled={resourceEnabled}
            pxPerSec={pxPerSec}
            mediaChannels={audioMedia?.audio_channels ?? undefined}
          />
        );
      case "ImageOverlay":
        return resourceEnabled && imageMedia?.available ? (
          <img
            className="h-full w-full object-cover"
            src={convertFileSrc(imageMedia.path)}
            alt=""
            draggable={false}
          />
        ) : (
          fallbackFill(layer.color_hint)
        );
      case "Color":
        return colorFill(
          trackStatic(layer.params.color, { r: 0, g: 0, b: 0, a: 255 }),
          layer.color_hint,
        );
      case "Text":
        return (
          <div
            className="flex h-full w-full items-center overflow-hidden px-2"
            style={{ backgroundColor: layer.color_hint }}
          >
            {layerWidthPx >= LAYER_LABEL_MIN_PX && (
              <span className="truncate text-[10px] font-semibold leading-none text-white/70">
                {compactText(layer.params.content)}
              </span>
            )}
          </div>
        );
      case "Motif":
        return fallbackFill(layer.color_hint);
    }
  })();

  return (
    <div
      ref={rootRef}
      data-testid="timeline-visual-preview"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ borderRadius: "inherit", backgroundColor: layer.color_hint }}
      aria-hidden="true"
    >
      {preview}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(0,0,0,0.16))]" />
    </div>
  );
}
