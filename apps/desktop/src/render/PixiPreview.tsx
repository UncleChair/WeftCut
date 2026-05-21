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
import { ExportSourceHandle } from "./decoder/ExportDecoderPool";
import { PlaybackEngine } from "./PlaybackEngine";
import type { PixiExportResult, PixiPreviewHandle } from "./pixiPreviewFlag";
import { runExport } from "./worker/runExport";
// Side-effect import: installs `window.__weftcut_generate_baselines` so
// fixture authors can call into the runner from devtools. Stays out of
// production reach unless `?pixi=1` boots the preview.
import "./fixtures/devHooks";

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
      runExport(opts) {
        return handlePixiExport(
          opts?.onProgress,
          compositorRef.current,
          engineRef.current,
        );
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
          void runMainThreadProbe();
        }}
        style={{
          position: "absolute",
          top: 4,
          right: 120,
          padding: "4px 10px",
          font: "12px ui-monospace, monospace",
          color: "#fff",
          background: "rgba(120,80,0,0.85)",
          border: "none",
          borderRadius: 3,
          cursor: "pointer",
          whiteSpace: "pre",
        }}
      >
        MT Probe
      </button>
    </div>
  );
});

/// Diagnostic — construct an `ExportSourceHandle` in the MAIN thread
/// and drive `decodeRange` directly. Discriminates Worker context vs.
/// stream/extradata as the cause of the export-decoder wedge. Logs to
/// the same `[weftcut/export]` namespace as the real Worker so the
/// outputs are comparable.
async function runMainThreadProbe(): Promise<void> {
  const store = useProjectStore.getState();
  const summary = store.summary;
  if (!summary) {
    // eslint-disable-next-line no-console
    console.warn("[weftcut/mt-probe] no project");
    return;
  }
  // Find the first active VideoClip in the project.
  let target: { mediaId: string; layerId: string } | null = null;
  for (const track of summary.tracks) {
    for (const layer of track.layers) {
      if (layer.params.kind === "VideoClip") {
        target = {
          mediaId: layer.params.media_id,
          layerId: layer.id,
        };
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    // eslint-disable-next-line no-console
    console.warn("[weftcut/mt-probe] no VideoClip layer in project");
    return;
  }
  const m = store.mediaById.get(target.mediaId);
  const proxyPath = m ? playbackPathFor(m) : null;
  if (!proxyPath) {
    // eslint-disable-next-line no-console
    console.warn(`[weftcut/mt-probe] no proxy for media ${target.mediaId}`);
    return;
  }
  const proxyAssetUrl = convertFileSrc(proxyPath);
  // eslint-disable-next-line no-console
  console.log(
    `[weftcut/mt-probe] starting MT decode probe on media=${target.mediaId} ` +
      `proxy=${proxyAssetUrl}`,
  );
  const handle = new ExportSourceHandle({
    mediaId: target.mediaId,
    proxyAssetUrl,
  });
  const startMs = performance.now();
  try {
    // Decode the first ~2 s — same range as chunk 0 of the Worker
    // export.
    await handle.decodeRange(0, 1_999_999);
    const elapsedMs = performance.now() - startMs;
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/mt-probe] decodeRange resolved in ${elapsedMs.toFixed(0)}ms; ` +
        `ring=${(handle.ring as unknown as { size(): number }).size()} frames`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[weftcut/mt-probe] decodeRange threw:", err);
  } finally {
    handle.dispose();
  }
}

async function handlePixiExport(
  onProgress: ((encoded: number, total: number) => void) | undefined,
  compositor: Compositor | null,
  engine: PlaybackEngine | null,
): Promise<PixiExportResult> {
  const store = useProjectStore.getState();
  const summary = store.summary;
  if (!summary) {
    throw new Error("No project loaded");
  }
  // Suspend the preview compositor so its VideoDecoder releases the
  // hardware video-decode slot. The export Worker's decoder otherwise
  // wedges fighting for the same slot. Engine is paused first so its
  // rAF loop can't squeeze in another setAnchorTime tick before
  // suspend takes effect.
  const wasPlaying = engine?.isPlaying() ?? false;
  engine?.pause();
  compositor?.setSuspended(true);

  try {
    const result = await runExport({
      summary,
      mediaById: store.mediaById,
      onProgress,
    });
    return {
      videoBytes: result.videoBytes,
      framesEncoded: result.framesEncoded,
      totalFrames: result.totalFrames,
      fpsNum: summary.composition.fps_num,
      fpsDen: summary.composition.fps_den,
    };
  } finally {
    compositor?.setSuspended(false);
    // Force re-init: the engine's rAF loop will re-acquire decoders
    // via ensureClip on its next tick, but kick the compositor once
    // here so the canvas isn't blank for a frame.
    const t = engine?.positionUs() ?? 0;
    compositor?.setProject(useProjectStore.getState().summary);
    compositor?.setAnchorTime(t);
    compositor?.compositeFrame(t);
    if (wasPlaying) engine?.play();
  }
}
