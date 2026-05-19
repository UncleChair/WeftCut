// React mount for the PixiJS-backed preview surface. Flag-gated parallel
// to the existing DOM `LiveLayers` pipeline so we can A/B-compare during
// the rewrite without breaking the live app.
//
// Activation: visit the app with `?pixi=1` in the URL, or run with
// `localStorage.setItem("weftcut.preview.pixi", "1")` set. The default
// is the existing DOM preview until P14 cutover.
//
// Plan: docs/pixi-renderer-plan.md (P2)

import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../state/projectStore";
import type { MediaSummary } from "../ipc";
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

/// Tag for all PixiJS-renderer console output so the user can grep.
const LOG = "[weftcut/pixi]";

export function PixiPreview({ onTimeUpdate, onPausedChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /// React StrictMode runs the effect twice in dev. Holding the
  /// in-flight Compositor / PlaybackEngine in local closure variables
  /// (NOT just refs) means the cleanup function can dispose them even
  /// before async `mount()` resolves and the refs get set.
  const compositorRef = useRef<Compositor | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [status, setStatus] = useState<string>("Mounting…");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const summary = useProjectStore((s) => s.summary);
  const mediaById = useProjectStore((s) => s.mediaById);
  const composition = summary?.composition;

  // Initialize Compositor + PlaybackEngine once. Re-init if the
  // project's composition resolution changes (rare).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !composition) {
      setStatus("Waiting for project…");
      return;
    }
    // Local copies the cleanup closure can see even before the
    // async mount() promise resolves. Critical for StrictMode-safe
    // double-effect behavior: the cleanup of the first effect must
    // tear down the first Compositor (which has taken the canvas's
    // WebGL context) before the second effect tries to mount onto
    // the same canvas.
    let cancelled = false;
    let compositor: Compositor | null = null;
    let engine: PlaybackEngine | null = null;
    let unsubTime: (() => void) | null = null;
    let unsubPlay: (() => void) | null = null;

    const proxyAssetUrl = (mediaId: string): string | null => {
      const m = useProjectStore.getState().mediaById.get(mediaId);
      const path = playbackPathFor(m);
      return path ? convertFileSrc(path) : null;
    };
    const lookupMedia = (mediaId: string): MediaSummary | undefined =>
      useProjectStore.getState().mediaById.get(mediaId);

    setStatus("Initializing PixiJS…");
    console.log(`${LOG} init w=${composition.width} h=${composition.height}`);

    (async () => {
      try {
        const c = new Compositor({
          canvas,
          width: composition.width,
          height: composition.height,
          mode: "preview",
          proxyAssetUrl,
          mediaById: lookupMedia,
        });
        compositor = c;
        await c.mount({
          canvas,
          width: composition.width,
          height: composition.height,
          mode: "preview",
          proxyAssetUrl,
          mediaById: lookupMedia,
        });
        if (cancelled) {
          c.dispose();
          compositor = null;
          return;
        }
        console.log(`${LOG} compositor mounted`);
        c.setProject(useProjectStore.getState().summary);
        const e = new PlaybackEngine({ compositor: c });
        engine = e;
        unsubTime = e.onTimeUpdate((t) => onTimeUpdate?.(t));
        unsubPlay = e.onPlayStateChange((p) => onPausedChange?.(!p));
        compositorRef.current = c;
        engineRef.current = e;
        c.setAnchorTime(0);
        c.compositeFrame(0);
        setStatus("Ready");
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error(`${LOG} mount failed:`, err);
        setErrMsg(msg);
        setStatus("Mount failed");
        if (compositor) {
          try {
            compositor.dispose();
          } catch {
            // ignore
          }
          compositor = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubTime?.();
      unsubPlay?.();
      engine?.dispose();
      compositor?.dispose();
      compositorRef.current = null;
      engineRef.current = null;
    };
    // composition dims drive renderer init — change them, remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composition?.width, composition?.height]);

  // Forward summary updates to the Compositor without remounting.
  useEffect(() => {
    if (!compositorRef.current) return;
    compositorRef.current.setProject(summary);
    // Force-paint on summary change so structural edits (add/remove
    // layer) are visible without a playback tick.
    const t = engineRef.current?.positionUs() ?? 0;
    compositorRef.current.setAnchorTime(t);
    compositorRef.current.compositeFrame(t);
  }, [summary, mediaById]);

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
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 4,
          padding: "2px 6px",
          font: "12px ui-monospace, monospace",
          color: errMsg ? "#ffb4b4" : "#9ca3af",
          background: "rgba(0,0,0,0.6)",
          pointerEvents: "none",
          borderRadius: 3,
          maxWidth: "90%",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
        data-testid="pixi-preview-status"
      >
        {errMsg ? `Error — ${errMsg}` : status}
      </div>
    </div>
  );
}
