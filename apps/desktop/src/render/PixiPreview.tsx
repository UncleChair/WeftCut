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

import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Application as PixiApplication } from "@pixi/react";
import type { Application } from "pixi.js";

import { playbackPathFor, useProjectStore } from "../state/projectStore";
import type { MediaSummary } from "../ipc";
import { Compositor } from "./Compositor";
import { PlaybackEngine } from "./PlaybackEngine";

interface Props {
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
}

export function isPixiPreviewEnabled(): boolean {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("pixi");
    if (q === "1" || q === "true") return true;
  } catch {
    // not a browser
  }
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("weftcut.preview.pixi") === "1";
    }
  } catch {
    // storage disabled
  }
  return false;
}

const LOG = "[weftcut/pixi]";

export function PixiPreview({ onTimeUpdate, onPausedChange }: Props) {
  const compositorRef = useRef<Compositor | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [status, setStatus] = useState<string>("Initializing PixiJS…");
  const summary = useProjectStore((s) => s.summary);
  const mediaById = useProjectStore((s) => s.mediaById);
  const composition = summary?.composition;

  // Called by @pixi/react once the underlying PIXI.Application is
  // ready. Handed an already-initialized Application — we wire the
  // Compositor and PlaybackEngine against it.
  const handleInit = useCallback(
    (app: Application) => {
      console.log(`${LOG} application init`);

      // Dispose any prior Compositor (StrictMode re-mount).
      engineRef.current?.dispose();
      compositorRef.current?.dispose();

      const proxyAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        const path = playbackPathFor(m);
        return path ? convertFileSrc(path) : null;
      };
      const lookupMedia = (mediaId: string): MediaSummary | undefined =>
        useProjectStore.getState().mediaById.get(mediaId);

      const compositor = new Compositor({
        app,
        width: app.canvas.width,
        height: app.canvas.height,
        mode: "preview",
        proxyAssetUrl,
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
    </div>
  );
}
