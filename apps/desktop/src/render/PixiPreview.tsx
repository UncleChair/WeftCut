// React mount for the PixiJS-backed preview surface. Flag-gated parallel
// to the existing DOM `LiveLayers` pipeline so we can A/B-compare during
// the rewrite without breaking the live app.
//
// Activation: visit the app with `?pixi=1` in the URL, or run with
// `localStorage.setItem("weftcut.preview.pixi", "1")` set. The default
// is the existing DOM preview until P14 cutover.
//
// Plan: docs/pixi-renderer-plan.md (P2)

import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../state/projectStore";
import type { MediaSummary, ProjectSummary } from "../ipc";
import { Compositor } from "./Compositor";
import { PlaybackEngine } from "./PlaybackEngine";

interface Props {
  /// Master clock callback in microseconds.
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
}

/// Decides whether the user has opted into the new PixiJS preview.
/// True if either:
///   - URL has `?pixi=1` (or `?pixi=true`), OR
///   - `localStorage.weftcut.preview.pixi === "1"`.
export function isPixiPreviewEnabled(): boolean {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("pixi");
    if (q === "1" || q === "true") return true;
  } catch {
    // SSR / non-browser: fall through.
  }
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("weftcut.preview.pixi") === "1";
    }
  } catch {
    // Storage disabled: ignore.
  }
  return false;
}

export function PixiPreview({ onTimeUpdate, onPausedChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const summary = useProjectStore((s) => s.summary);
  const mediaById = useProjectStore((s) => s.mediaById);
  const composition = summary?.composition;

  // Initialize Compositor + PlaybackEngine once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) return;
    let cancelled = false;
    const compositor = new Compositor({
      canvas,
      width: composition.width,
      height: composition.height,
      mode: "preview",
      proxyAssetUrl: (mediaId) => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        const path = playbackPathFor(m);
        return path ? convertFileSrc(path) : null;
      },
      mediaById: (mediaId): MediaSummary | undefined =>
        useProjectStore.getState().mediaById.get(mediaId),
    });
    void compositor
      .mount({
        canvas,
        width: composition.width,
        height: composition.height,
        mode: "preview",
        proxyAssetUrl: (mediaId) => {
          const m = useProjectStore.getState().mediaById.get(mediaId);
          const path = playbackPathFor(m);
          return path ? convertFileSrc(path) : null;
        },
        mediaById: (mediaId) =>
          useProjectStore.getState().mediaById.get(mediaId),
      })
      .then(() => {
        if (cancelled) {
          compositor.dispose();
          return;
        }
        compositor.setProject(summary as ProjectSummary);
        const engine = new PlaybackEngine({ compositor });
        const unsubTime = engine.onTimeUpdate((t) => onTimeUpdate?.(t));
        const unsubPlay = engine.onPlayStateChange((p) =>
          onPausedChange?.(!p),
        );
        compositorRef.current = compositor;
        engineRef.current = engine;
        // Composite an initial frame so the canvas isn't black-on-mount.
        compositor.compositeFrame(0);
        return () => {
          unsubTime();
          unsubPlay();
          engine.dispose();
          compositor.dispose();
        };
      })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("PixiPreview mount failed:", e);
      });
    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      compositorRef.current?.dispose();
      compositorRef.current = null;
      engineRef.current = null;
    };
    // composition dims drive renderer init — change them, remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composition?.width, composition?.height]);

  // Forward summary updates to the Compositor without remounting.
  useEffect(() => {
    compositorRef.current?.setProject(summary);
  }, [summary, mediaById]);

  if (!composition) {
    return <span className="placeholder">Loading…</span>;
  }

  return (
    <canvas
      ref={canvasRef}
      width={composition.width}
      height={composition.height}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        background: "#000",
      }}
    />
  );
}
