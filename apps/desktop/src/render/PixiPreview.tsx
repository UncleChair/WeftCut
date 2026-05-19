// React mount for the PixiJS-backed preview surface. Flag-gated parallel
// to the existing DOM `LiveLayers` pipeline so we can A/B-compare during
// the rewrite without breaking the live app.
//
// Uses `@pixi/react`'s `<Application>` for the PIXI.Application lifecycle
// (StrictMode-safe, async-init, ref-forwarded). The Compositor is
// imperatively driven from `onInit` and doesn't own the Application
// itself.
//
// Activation: `?pixi=1` URL param or
// `localStorage.setItem("weftcut.preview.pixi", "1")`.
//
// Plan: docs/pixi-renderer-plan.md (P2)

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Application as PixiApplication } from "@pixi/react";
import type { Application } from "pixi.js";

import { playbackPathFor, useProjectStore } from "../state/projectStore";
import type { MediaSummary } from "../ipc";
import { Compositor } from "./Compositor";
import { PlaybackEngine } from "./PlaybackEngine";
import type { PixiPreviewHandle } from "./pixiPreviewFlag";
import { runExport } from "./worker/runExport";

interface Props {
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
}

const LOG = "[weftcut/pixi]";

export const PixiPreview = forwardRef<PixiPreviewHandle, Props>(function PixiPreview(
  { onTimeUpdate, onPausedChange },
  ref,
) {
  const compositorRef = useRef<Compositor | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [status, setStatus] = useState<string>("Initializing PixiJS…");
  const [exporting, setExporting] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      play() {
        engineRef.current?.play();
      },
      pause() {
        engineRef.current?.pause();
      },
      seek(tUs: number) {
        engineRef.current?.seek(tUs);
      },
      paused() {
        return !(engineRef.current?.isPlaying() ?? false);
      },
    }),
    [],
  );
  const summary = useProjectStore((s) => s.summary);
  const mediaById = useProjectStore((s) => s.mediaById);
  const composition = summary?.composition;

  // Called by @pixi/react once the underlying PIXI.Application is
  // ready. Handed an already-initialized Application — we wire the
  // Compositor and PlaybackEngine against it.
  const handleInit = useCallback(
    (app: Application) => {
      console.log(
        `${LOG} application init: canvas=${app.canvas.width}×${app.canvas.height} ` +
          `renderer=${app.renderer.type}`,
      );
      // @pixi/react renders a bare <canvas> with no CSS sizing.
      // Inline-replaced canvas elements default to their intrinsic
      // pixel size (here 1920×1080), which overflows the preview
      // panel. Force the display size to fill the wrapper while the
      // internal pixel size stays at composition resolution.
      const c = app.canvas as HTMLCanvasElement;
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.display = "block";
      c.style.objectFit = "contain";

      // Dispose any prior Compositor (StrictMode re-mount).
      engineRef.current?.dispose();
      compositorRef.current?.dispose();

      const proxyAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        const path = playbackPathFor(m);
        return path ? convertFileSrc(path) : null;
      };
      const originalAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        if (!m) return null;
        return convertFileSrc(m.path);
      };
      const lookupMedia = (mediaId: string): MediaSummary | undefined =>
        useProjectStore.getState().mediaById.get(mediaId);

      const compositor = new Compositor({
        app,
        width: app.canvas.width,
        height: app.canvas.height,
        mode: "preview",
        proxyAssetUrl,
        originalAssetUrl,
        mediaById: lookupMedia,
      });
      compositor.setProject(useProjectStore.getState().summary);

      const engine = new PlaybackEngine({ compositor });
      if (onTimeUpdate) engine.onTimeUpdate(onTimeUpdate);
      if (onPausedChange) engine.onPlayStateChange((p) => onPausedChange(!p));

      compositorRef.current = compositor;
      engineRef.current = engine;

      compositor.setAnchorTime(0);
      compositor.compositeFrame(0);
      setStatus("Ready");
    },
    [onTimeUpdate, onPausedChange],
  );

  // Forward summary updates to the Compositor without remounting the
  // Application.
  useEffect(() => {
    if (!compositorRef.current) return;
    compositorRef.current.setProject(summary);
    const t = engineRef.current?.positionUs() ?? 0;
    compositorRef.current.setAnchorTime(t);
    compositorRef.current.compositeFrame(t);
  }, [summary, mediaById]);

  // Dispose Compositor + PlaybackEngine on unmount. The library
  // disposes the Application itself.
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      compositorRef.current?.dispose();
      compositorRef.current = null;
      engineRef.current = null;
    };
  }, []);

  if (!composition) {
    return (
      <span className="placeholder" data-testid="pixi-preview-loading">
        Loading project…
      </span>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#000",
      }}
    >
      <PixiApplication
        width={composition.width}
        height={composition.height}
        background={0x000000}
        antialias
        onInit={handleInit}
        className="pixi-preview-canvas"
      />
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 4,
          padding: "2px 6px",
          font: "12px ui-monospace, monospace",
          color: "#9ca3af",
          background: "rgba(0,0,0,0.6)",
          pointerEvents: "none",
          borderRadius: 3,
          maxWidth: "90%",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
        data-testid="pixi-preview-status"
      >
        {status}
      </div>
      <button
        type="button"
        onClick={() => {
          void handlePixiExport(setExporting);
        }}
        disabled={exporting !== null}
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          padding: "4px 10px",
          font: "12px ui-monospace, monospace",
          color: "#fff",
          background:
            exporting !== null ? "rgba(80,80,80,0.7)" : "rgba(0,120,0,0.8)",
          border: "none",
          borderRadius: 3,
          cursor: exporting !== null ? "default" : "pointer",
          whiteSpace: "pre",
        }}
      >
        {exporting ?? "Pixi Export"}
      </button>
    </div>
  );
});

async function handlePixiExport(
  setStatus: (s: string | null) => void,
): Promise<void> {
  const store = useProjectStore.getState();
  const summary = store.summary;
  if (!summary) {
    setStatus("No project");
    setTimeout(() => setStatus(null), 1500);
    return;
  }
  setStatus("Exporting 0%");
  try {
    const result = await runExport({
      summary,
      mediaById: store.mediaById,
      onProgress: (encoded, total) => {
        const pct = total > 0 ? Math.round((encoded / total) * 100) : 0;
        setStatus(`Exporting ${pct}%`);
      },
    });
    // Hand the bytes to the browser as a downloadable Blob so the
    // user can save and inspect the result. Real ExportPanel wiring
    // (and audio mux) is the next step.
    const blob = new Blob([result.videoBytes], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weftcut-pixi-export-${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus(`Done — ${result.framesEncoded}f`);
    setTimeout(() => setStatus(null), 2500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[weftcut/pixi] export failed:", err);
    setStatus(`Failed: ${msg.slice(0, 40)}`);
    setTimeout(() => setStatus(null), 3500);
  }
}
