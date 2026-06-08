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
import { listen } from "@tauri-apps/api/event";
import { Application as PixiApplication } from "@pixi/react";
import { Rectangle, type Application } from "pixi.js";

import { previewPlaybackPathFor, useProjectStore } from "../state/projectStore";
import { MOTIFS_CHANGED_EVENT, type MediaSummary } from "../ipc";
import { Compositor } from "./Compositor";
import { ffprobeColorToWebCodecs } from "./decoder/ffprobeColorSpace";
import { PerfHUD } from "./PerfHUD";
import { PlaybackEngine } from "./PlaybackEngine";
import type { PixiExportResult, PixiPreviewHandle } from "./pixiPreviewFlag";
import { runExport } from "./worker/runExport";

interface Props {
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
  // Explicit `| undefined` (not just `?`) so PreviewSurface can pass its own
  // optional prop straight through under `exactOptionalPropertyTypes`, where a
  // bare `?:` would reject an explicitly-`undefined` value. Handled internally
  // via `previewDecodableOf?.(…) ?? false`.
  previewDecodableOf?: ((mediaId: string) => boolean) | undefined;
}

const LOG = "[weftcut/pixi]";

export const PixiPreview = forwardRef<PixiPreviewHandle, Props>(function PixiPreview(
  { onTimeUpdate, onPausedChange, previewDecodableOf },
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
      refreshSources() {
        const compositor = compositorRef.current;
        const engine = engineRef.current;
        if (!compositor) return;
        const t = engine?.positionUs() ?? 0;
        compositor.setProject(useProjectStore.getState().summary);
        compositor.setAnchorTime(t);
        compositor.compositeFrame(t);
      },
      runExport(opts) {
        return handlePixiExport(
          opts,
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
        // Bridge flag is session-scoped (App's decodeProbeMemo via the prop);
        // read live each call so a mid-session probe flip takes effect on the
        // next ensureClip.
        const previewDecodable = previewDecodableOf?.(mediaId) ?? false;
        const path = previewPlaybackPathFor(m, { previewDecodable });
        return path ? convertFileSrc(path) : null;
      };
      const originalAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        if (!m) return null;
        return convertFileSrc(m.path);
      };
      const sourceColor = (mediaId: string): VideoColorSpaceInit | undefined => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        return m ? ffprobeColorToWebCodecs(m) : undefined;
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
        sourceColor,
        mediaById: lookupMedia,
      });
      const initialSummary = useProjectStore.getState().summary;
      compositor.setProject(initialSummary);

      const engine = new PlaybackEngine({ compositor, ticker: app.ticker });
      engine.bindFps(
        initialSummary?.composition.fps_num ?? 30,
        initialSummary?.composition.fps_den ?? 1,
      );
      if (onTimeUpdate) engine.onTimeUpdate(onTimeUpdate);
      if (onPausedChange) engine.onPlayStateChange((p) => onPausedChange(!p));

      compositorRef.current = compositor;
      engineRef.current = engine;

      // E2E-only: register a live bridge so the WebDriver hooks
      // (window.__weftcutTest.weftcutSeekUs / weftcutSampleComposite) can drive
      // a real seek and read pixels straight off the composited canvas. Dynamic
      // import behind the static VITE_WEFTCUT_E2E check → stripped from prod.
      if (import.meta.env.VITE_WEFTCUT_E2E === "1") {
        void import("../testhook/e2eHook").then(({ installPreviewBridge }) => {
          installPreviewBridge({
            seekUs: (us: number) => {
              engine.seek(us);
            },
            sampleComposite: async (x: number, y: number) => {
              // Pull a full-composition RGBA buffer via renderer.extract.pixels
              // (reliable on WebGPU/WebGL regardless of preserveDrawingBuffer,
              // and avoids the OffscreenCanvas 2D-context quirks of the
              // canvas()+drawImage route). Frame is pinned to the WHOLE
              // composition (renderer size) so (x,y) are ABSOLUTE composition
              // pixels — the countdown sits at (0,0) scale 1, so its center is
              // (W/2, H/2).
              const W = app.renderer.width;
              const H = app.renderer.height;
              // Force a render of the live tree before extracting so the
              // freshly-bound template texture is on the framebuffer (the
              // always-on ticker also renders, but extracting right after an
              // explicit render removes any race with removeChildren()).
              compositor.compositeFrame(engine.positionUs());
              app.renderer.render(app.stage);
              const readFrom = (
                target: import("pixi.js").Container,
              ): import("../testhook/e2eHook").CompositeSample => {
                const out = app.renderer.extract.pixels({
                  target,
                  frame: new Rectangle(0, 0, W, H),
                });
                const buf = out.pixels;
                const w = out.width;
                const px = Math.max(0, Math.min(w - 1, Math.round(x)));
                const py = Math.max(0, Math.min(out.height - 1, Math.round(y)));
                const i = (py * w + px) * 4;
                // Whole-frame scan: count opaque pixels AND accent-colored
                // pixels (the countdown's accent #ff4d4d = rgb(255,77,77):
                // high red, low green/blue, opaque). Reporting the accent
                // count + a representative accent pixel lets the spec assert
                // "renders accent-colored content" without depending on where
                // a single glyph stroke lands (the numeral's exact center can
                // fall in the "3"'s transparent hollow).
                let nonTransparent = 0;
                let maxA = 0;
                let accentCount = 0;
                let ar = 0;
                let ag = 0;
                let ab = 0;
                for (let j = 0; j < buf.length; j += 4) {
                  const r = buf[j]!;
                  const g = buf[j + 1]!;
                  const b = buf[j + 2]!;
                  const a = buf[j + 3]!;
                  if (a > 0) nonTransparent++;
                  if (a > maxA) maxA = a;
                  if (a === 255 && r > 180 && g < 150 && b < 150) {
                    if (accentCount === 0) {
                      ar = r;
                      ag = g;
                      ab = b;
                    }
                    accentCount++;
                  }
                }
                return {
                  r: buf[i] ?? 0,
                  g: buf[i + 1] ?? 0,
                  b: buf[i + 2] ?? 0,
                  a: buf[i + 3] ?? 0,
                  w,
                  h: out.height,
                  nonTransparent,
                  maxA,
                  accentCount,
                  accentR: ar,
                  accentG: ag,
                  accentB: ab,
                };
              };
              // Prefer the app root (the live presented tree). If it reads all-
              // transparent, fall back to the compositor's own stage container —
              // a divergence localises the bug (root-vs-container extract).
              const root = readFrom(app.stage);
              if (root.nonTransparent > 0) return root;
              return readFrom(compositor.stage);
            },
          });
        });
      }

      compositor.setAnchorTime(0);
      compositor.compositeFrame(0);
      setStatus("");
    },
    [onTimeUpdate, onPausedChange],
  );

  // Forward summary updates to the Compositor without remounting the
  // Application.
  useEffect(() => {
    if (!compositorRef.current) return;
    compositorRef.current.setProject(summary);
    engineRef.current?.bindFps(
      summary?.composition.fps_num ?? 30,
      summary?.composition.fps_den ?? 1,
    );
    const t = engineRef.current?.positionUs() ?? 0;
    compositorRef.current.setAnchorTime(t);
    compositorRef.current.compositeFrame(t);
  }, [summary, mediaById]);

  // A draft edit / install / delete (motifs:changed) changes a Motif's source
  // but NOT the project summary, so the [summary] effect won't fire. Tell the
  // compositor to refresh its live Motif sprites against the new catalog and
  // recapture at the current playhead.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cleaned = false;
    void listen(MOTIFS_CHANGED_EVENT, () => {
      const c = compositorRef.current;
      if (!c) return;
      c.refreshMotifs();
      c.compositeFrame(engineRef.current?.positionUs() ?? 0);
    }).then((u) => {
      if (cleaned) u();
      else un = u;
    });
    return () => {
      cleaned = true;
      un?.();
    };
  }, []);

  // Dispose Compositor + PlaybackEngine on unmount. The library
  // disposes the Application itself.
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      compositorRef.current?.dispose();
      compositorRef.current = null;
      engineRef.current = null;
      // E2E-only: clear the preview bridge so seek/readback hooks don't
      // hold a stale closure over the disposed engine + compositor.
      if (import.meta.env.VITE_WEFTCUT_E2E === "1") {
        void import("../testhook/e2eHook").then(({ clearPreviewBridge }) => {
          clearPreviewBridge();
        });
      }
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
        // Letterbox surround: matches the editor's deepest-panel color
        // so the preview area integrates with the rest of the chrome.
        // The canvas itself stays pure black (`background={0x000000}`
        // below) so true-black composition pixels stand apart from the
        // surround when the aspect ratio doesn't fill the wrapper.
        background: "#11151c",
      }}
    >
      <PixiApplication
        width={composition.width}
        height={composition.height}
        background={0x000000}
        antialias
        // Prefer WebGPU; PixiJS auto-falls back to WebGL when the
        // runtime doesn't expose `navigator.gpu` (older WebView2,
        // restricted contexts). `app.renderer.type` in the init log
        // reads 2 for WebGPU, 1 for WebGL — useful sanity check.
        preference="webgpu"
        onInit={handleInit}
        className="pixi-preview-canvas"
      />
      {status && (
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
      )}
      {import.meta.env.DEV && (
        <PerfHUD compositorRef={compositorRef} engineRef={engineRef} />
      )}
    </div>
  );
});

async function handlePixiExport(
  opts: {
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
    startUs?: number;
    endUs?: number;
    keyframeIntervalSec?: number;
    writeChunk: (data: ArrayBuffer) => Promise<void>;
    /// Pre-rasterized Motif-layer frames (baked by App before launching the
    /// export). Threaded straight into `runExport`; the Worker binds them.
    motifFrames?: Record<string, ImageBitmap[]>;
  },
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
      writeChunk: opts.writeChunk,
      // Conditional spreads: under exactOptionalPropertyTypes an optional
      // field may be absent but not explicitly `undefined`.
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.encoderConfig ? { encoderConfig: opts.encoderConfig } : {}),
      ...(opts.outputFps ? { outputFps: opts.outputFps } : {}),
      ...(opts.startUs != null ? { startUs: opts.startUs } : {}),
      ...(opts.endUs != null ? { endUs: opts.endUs } : {}),
      ...(opts.keyframeIntervalSec != null
        ? { keyframeIntervalSec: opts.keyframeIntervalSec }
        : {}),
      ...(opts.motifFrames ? { motifFrames: opts.motifFrames } : {}),
    });
    const outFpsNum = opts.outputFps?.num ?? summary.composition.fps_num;
    const outFpsDen = opts.outputFps?.den ?? summary.composition.fps_den;
    return {
      framesEncoded: result.framesEncoded,
      totalFrames: result.totalFrames,
      fpsNum: outFpsNum,
      fpsDen: outFpsDen,
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
