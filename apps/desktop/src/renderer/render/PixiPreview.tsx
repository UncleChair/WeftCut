// React mount for the PixiJS-backed preview surface. Uses @pixi/react's
// <Application> for the PIXI.Application lifecycle (StrictMode-safe,
// async-init, ref-forwarded); the Compositor is driven imperatively from
// onInit and does not own the Application itself.
//
// Plan: docs/render.md

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@/bridge/ipc";
import { Application as PixiApplication } from "@pixi/react";
import { Rectangle, type Application } from "pixi.js";

import {
  registerTransport,
  releaseTransport,
  setTransportPlaying,
} from "../state/playbackStore";
import { useProjectStore } from "../state/projectStore";
import { useAppSettingsStore, useDecodeEngine } from "../settings/appSettingsStore";
import {
  useDecodeComponentAvailable,
  useDecodeComponentStore,
} from "../settings/decodeComponentStore";
import { containMap } from "../colorpick/pixel";
import {
  clearPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "../colorpick/previewSamplerRegistry";
import { quickProxyPath } from "./decodeRoute";
import { proxyIntent } from "../state/proxyPreferenceStore";
import { resolveDecodeEngine } from "./decoder/decodeEngine";
import { isFfmpegUnusable } from "./decoder/ffmpegCapability";
import { isWebcodecsUnusable } from "./decoder/webcodecsCapability";
import { noteResolution } from "./decoder/decodeCapability";
import { logEmit, type MediaSummary, reportAudioMeter } from "../ipc";
import {
  resetUnderrunState,
  setUnderrunState,
} from "../state/underrunStore";
import {
  setEffectDisabled,
  subscribeEffectOverrides,
} from "./effects/effectOverrides";
import { subscribeRoleGainOverrides } from "./audio/roleGainOverrides";
import { subscribeMotifCatalog } from "./motifs/catalog";
import { Compositor, type ResolvedRendererSource } from "./Compositor";
import { ffprobeColorToWebCodecs } from "./decoder/ffprobeColorSpace";
import type { ExportDecodeRouting } from "./exportDecodeRouting";
import { PerfTelemetryBridge } from "./PerfHUD";
import { PlaybackEngine } from "./PlaybackEngine";
import { UnsupportedClipCard } from "./UnsupportedClipCard";
import type { PixiExportResult, PixiPreviewHandle } from "./pixiPreviewFlag";
import { runExport } from "./worker/runExport";
import {
  clearMasterMeter,
  publishMasterMeter,
} from "../state/masterMeterStore";
import { setPixiPresentationVisible } from "./previewPresentation";
import type { PreviewFrameCapture } from "../testhook/e2eHook";

interface Props {
  onTimeUpdate?: (tUs: number) => void;
  onPausedChange?: (paused: boolean) => void;
  // Explicit `| undefined` (not just `?`) so PreviewSurface can pass its own
  // optional prop straight through under `exactOptionalPropertyTypes`, where a
  // bare `?:` would reject an explicitly-`undefined` value. Handled internally
  // via `previewDecodableOf?.(…) ?? false`.
  previewDecodableOf?: ((mediaId: string) => boolean) | undefined;
  visible?: boolean;
}

const LOG = "[weftcut/pixi]";
let previewResourceSequence = 0;

export const PixiPreview = forwardRef<PixiPreviewHandle, Props>(function PixiPreview(
  { onTimeUpdate, onPausedChange, previewDecodableOf, visible = true },
  ref,
) {
  const compositorRef = useRef<Compositor | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const applicationRef = useRef<Application | null>(null);
  // `handleInit` must not change identity when an always-rendered dock tab
  // flips visibility. Read the current value through a ref at initialization;
  // the visibility effect owns every subsequent transition.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /// MCP meter push timer; set in `onInit`, cleared on unmount (the mount
  /// effect is async and can't return a cleanup itself).
  const meterTimerRef = useRef<number | null>(null);
  const samplerRef = useRef<PreviewSampler | null>(null);
  const unsubOverridesRef = useRef<(() => void) | null>(null);
  const unsubRoleOverridesRef = useRef<(() => void) | null>(null);
  const [initializing, setInitializing] = useState(true);
  // On-screen media the Compositor can't decode with any engine — fed ONLY
  // by `Compositor.onUnsupported` (membership-change snapshots, never
  // per-frame; see that field's contract). This component must NEVER clear
  // it directly (React would desync from the Compositor's ground truth); to
  // react to a decode_engine / component-availability change, trigger a
  // re-composite (the `scheduleRepaint()` effect below) and let the
  // Compositor's next resolve fire the correction.
  const [unsupportedIds, setUnsupportedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

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
  const decodeEngine = useDecodeEngine();
  const decodeComponentAvailable = useDecodeComponentAvailable();

  // Called by @pixi/react once the underlying PIXI.Application is
  // ready. Handed an already-initialized Application — we wire the
  // Compositor and PlaybackEngine against it.
  const handleInit = useCallback(
    (app: Application) => {
      applicationRef.current = app;
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

      // Dispose any prior Compositor (StrictMode re-mount). Release its
      // transport registration first so the store never holds a disposed
      // engine (the new engine re-registers below).
      if (engineRef.current) releaseTransport(engineRef.current);
      engineRef.current?.dispose();
      compositorRef.current?.dispose();

      // THE preview decode resolver: the single injected gatherer that reads
      // the live stores, runs the PURE `resolveDecodeEngine`, and returns the
      // resolved source (engine + source + decode target + swap key). Impure
      // by design (store reads) but hands only plain values into the pure
      // core; a mid-session setting/component/probe flip takes effect on the
      // next `ensureClip` because every input is read live per call. Lane
      // (HW/SW) selection is NOT gathered here — `FfmpegSource` owns it (via
      // `pickInitialLane`/`ffmpegCapability`); the pool acquires by `engine`.
      const resolveSource = (mediaId: string): ResolvedRendererSource | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        if (!m) return null;
        const setting = useAppSettingsStore.getState().settings.decode_engine;
        const componentAvailable = useDecodeComponentStore.getState().available;
        const qp = quickProxyPath(m);
        const r = resolveDecodeEngine({
          setting,
          componentAvailable,
          // Gate on availability: intent true but no proxy on disk keeps the
          // original decoding until a build lands (then the swap key flips).
          useProxySource: proxyIntent(mediaId) && qp !== null,
          proxyReady: qp !== null,
          proxyUrl: qp !== null ? convertFileSrc(qp) : null,
          originalPath: m.path,
          // convertFileSrc HERE (the impure edge) so the Compositor + pure
          // core stay URL-scheme-agnostic.
          originalUrl: convertFileSrc(m.path),
          // Session probe memo (App's decodeProbeMemo via the prop) — read
          // live so a mid-session probe flip feeds the webcodecs×original
          // branch on the next ensureClip. A sticky "webcodecs-confirmed-
          // unusable" mark (set by the import sweep on a DEFINITIVE
          // unsupported-codec verdict, e.g. ProRes) wins as "fail" so a pinned-
          // Lite decode resolves status:"unsupported" (UnsupportedClipCard)
          // instead of hanging on "pending"; mirrors the `ffmpegUsable` feed.
          webcodecsCanDecodeOriginal: isWebcodecsUnusable(mediaId)
            ? "fail"
            : (previewDecodableOf?.(mediaId) ?? false)
              ? "ok"
              : "untested",
          ffmpegUsable: !isFfmpegUnusable(mediaId),
        });
        noteResolution(mediaId, r);
        return r;
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
      const conformAssetUrl = (mediaId: string): string | null => {
        const m = useProjectStore.getState().mediaById.get(mediaId);
        const p = m?.conform_path;
        return p ? convertFileSrc(p) : null;
      };

      const compositor = new Compositor({
        app,
        width: app.canvas.width,
        height: app.canvas.height,
        mode: "preview",
        resolveSource,
        // Membership-change snapshot only (see `compositeFrame`'s reset/
        // diff/fire around its layer sweep) — safe to feed straight into
        // React state.
        onUnsupported: setUnsupportedIds,
        // Edge-triggered + throttled (UnderrunTracker) — feeds the
        // transport bar's DroppedFramesIndicator via the module store.
        onUnderrun: setUnderrunState,
        originalAssetUrl,
        sourceColor,
        mediaById: lookupMedia,
        conformAssetUrl,
      });
      compositor.setPresentationVisible(visibleRef.current);
      setPixiPresentationVisible(app, visibleRef.current);
      const initialSummary = useProjectStore.getState().summary;
      compositor.setProject(initialSummary);

      const engine = new PlaybackEngine({ compositor, ticker: app.ticker });
      const resourceGeneration = ++previewResourceSequence;
      engine.bindFps(
        initialSummary?.composition.fps_num ?? 30,
        initialSummary?.composition.fps_den ?? 1,
      );
      if (onTimeUpdate) engine.onTimeUpdate(onTimeUpdate);
      if (onPausedChange) engine.onPlayStateChange((p) => onPausedChange(!p));

      compositorRef.current = compositor;
      engineRef.current = engine;

      // Global transport: expose this engine to code outside the React ref
      // chain (backend event handlers, MCP-driven mutations, dialogs) via the
      // playback store. Mirror the play state so store subscribers track
      // play/pause without polling.
      engine.onPlayStateChange(setTransportPlaying);
      registerTransport(engine);

      // Session-end dropped-frame summary → status log. FCP-style "warn
      // after playback": the transport indicator shows drops live; this
      // row makes them durable + explains the cause. `takeUnderrun
      // SessionSummary` is once-per-session, so a pause-during-warmup
      // (which also fires playing=false) can't re-log a stale count.
      engine.onPlayStateChange((playing) => {
        if (playing) return;
        const dropped = compositor.takeUnderrunSessionSummary();
        if (dropped === 0) return;
        void logEmit({
          level: "warn",
          category: { kind: "System" },
          source: { kind: "System" },
          message: `Playback dropped ${dropped} frame${dropped === 1 ? "" : "s"} — decoding fell behind`,
          i18n_key: "log.playback_dropped_frames",
          i18n_args: { count: dropped },
        });
      });

      // Color picker: register the sampling surface (same replace-on-remount
      // lifecycle as the transport registration above). captureFrame reuses the
      // compositeFrame→render→extract discipline the e2e sampleComposite path
      // proved; excludeEffectId freezes the PRE-key frame the chromakey
      // eyedropper samples. Spec: docs/color-picker.md
      unsubOverridesRef.current?.();
      const previewSampler: PreviewSampler = {
        captureFrame: async (opts) => {
          const excludeId = opts?.excludeEffectId;
          try {
            if (excludeId) setEffectDisabled(excludeId, true);
            compositor.compositeFrame(engine.positionUs());
            app.renderer.render(app.stage);
            const out = app.renderer.extract.pixels({
              target: app.stage,
              frame: new Rectangle(0, 0, app.renderer.width, app.renderer.height),
            });
            return { pixels: out.pixels, width: out.width, height: out.height };
          } finally {
            if (excludeId) {
              setEffectDisabled(excludeId, false);
              compositor.compositeFrame(engine.positionUs());
            }
          }
        },
        mapClientToComposition: (clientX, clientY) => {
          const rect = (app.canvas as HTMLCanvasElement).getBoundingClientRect();
          return containMap(clientX, clientY, rect, app.renderer.width, app.renderer.height);
        },
        canvasRect: () => (app.canvas as HTMLCanvasElement).getBoundingClientRect(),
      };
      registerPreviewSampler(previewSampler);
      samplerRef.current = previewSampler;
      // Hover live-apply while paused: sync() only runs inside compositeFrame,
      // so poke one on every transient-override change.
      unsubOverridesRef.current = subscribeEffectOverrides(() => {
        compositor.compositeFrame(engine.positionUs());
      });
      // Role Gain fader audition: the audio pass re-derives the mixer from the
      // renderer-local override only inside compositeFrame, so poke one on every
      // change (the change-detection guard skips a reschedule when the folded
      // gain is unchanged). Playing already composites per rAF; this keeps the
      // audition responsive at the very start/end of a gesture.
      unsubRoleOverridesRef.current?.();
      unsubRoleOverridesRef.current = subscribeRoleGainOverrides(() => {
        compositor.compositeFrame(engine.positionUs());
      });

      // Master-bus meter push (~2 Hz while playing) for the MCP
      // `composition://meter` resource. dB values clamp at -120 — JSON
      // can't carry the analyser's -Infinity silence reading. Clear any
      // prior timer first (StrictMode re-mount).
      if (meterTimerRef.current !== null) {
        window.clearInterval(meterTimerRef.current);
      }
      meterTimerRef.current = window.setInterval(() => {
        const g = compositor.getAudioGraph();
        if (!g || !engine.isPlaying()) return;
        const snap = g.meterSnapshot();
        publishMasterMeter(snap);
        void reportAudioMeter({
          rmsDb: Number.isFinite(snap.rmsDb) ? snap.rmsDb : -120,
          peakDb: Number.isFinite(snap.peakDb) ? snap.peakDb : -120,
        }).catch(() => {});
      }, 500);

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
              // freshly-bound motif texture is on the framebuffer (the
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
            // Preview-sw conformance: report the active clip's decode source +
            // sprite straight off the live Compositor.
            activeClipProbe: (layerId?: string) =>
              compositor.activeClipProbe(layerId),
            // Preview conformance: encode the current composited frame and
            // return the exact clip-frame identity bound during that same
            // capture. Ring bounds alone cannot establish what was painted.
            captureFrame: async (layerId?: string): Promise<PreviewFrameCapture> => {
              const W = app.renderer.width;
              const H = app.renderer.height;
              // Re-composite + render so the freshly-decoded frame is on the
              // framebuffer before the read (mirrors sampleComposite).
              const positionUs = engine.positionUs();
              compositor.compositeFrame(positionUs);
              app.renderer.render(app.stage);
              const clip = compositor.activeClipProbe(layerId);
              const { presentedCompositeCount } = compositor.presentationSnapshot();
              const out = app.renderer.extract.pixels({
                target: app.stage,
                frame: new Rectangle(0, 0, W, H),
              });
              const canvas = new OffscreenCanvas(out.width, out.height);
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("capturePng: no 2d context");
              ctx.putImageData(
                new ImageData(
                  new Uint8ClampedArray(out.pixels),
                  out.width,
                  out.height,
                ),
                0,
                0,
              );
              const blob = await canvas.convertToBlob({ type: "image/png" });
              const buf = await blob.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]!);
              }
              return {
                pngBase64: btoa(binary),
                positionUs,
                presentedCompositeCount,
                clip,
              };
            },
            resourceProbe: () => ({
              generation: resourceGeneration,
              playing: engine.isPlaying(),
              positionUs: engine.positionUs(),
              ...compositor.presentationSnapshot(),
            }),
          });
        });
      }

      compositor.setAnchorTime(0);
      compositor.compositeFrame(0);
      setInitializing(false);
    },
    [onTimeUpdate, onPausedChange, previewDecodableOf],
  );

  useEffect(() => {
    const compositor = compositorRef.current;
    const app = applicationRef.current;
    compositor?.setPresentationVisible(visible);
    if (app) setPixiPresentationVisible(app, visible);
  }, [visible]);

  // A Standard switch (from the card's own button or the settings panel) or
  // the ffmpeg component finishing load can change whether a given media is
  // decodable — but `unsupportedIds` must be updated ONLY by the Compositor's
  // `onUnsupported` callback: a direct `setUnsupportedIds` here races it and
  // can permanently hide the card for a still-unsupported clip. Request a
  // re-composite instead; the Compositor re-resolves every on-screen clip
  // and fires exactly once if membership actually changed.
  useEffect(() => {
    compositorRef.current?.scheduleRepaint();
  }, [decodeEngine, decodeComponentAvailable]);

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

  // A draft edit / install / delete updates the runtime Motif catalog (via the
  // async motifs:changed → syncUserMotifsFromBackend → setUserMotifs chain). We
  // subscribe to the catalog CHANGE-NOTIFIER rather than the raw backend event so
  // we refresh only AFTER `merged` actually carries the new content_hash —
  // subscribing to the raw event races the async re-sync and re-captures stale
  // source. Refresh the live Motif sprites against the fresh catalog + recapture
  // at the current playhead. The compositor may not be initialized yet (async
  // onInit) — read the ref live and bail if absent.
  useEffect(() => {
    return subscribeMotifCatalog(() => {
      const c = compositorRef.current;
      if (!c) return;
      c.refreshMotifs();
      c.compositeFrame(engineRef.current?.positionUs() ?? 0);
    });
  }, []);

  // Dispose Compositor + PlaybackEngine on unmount. The library
  // disposes the Application itself.
  useEffect(() => {
    return () => {
      // Identity-guarded release: a stale unmount can't tear down a newer
      // mount's registration.
      if (engineRef.current) releaseTransport(engineRef.current);
      resetUnderrunState();
      if (samplerRef.current) clearPreviewSampler(samplerRef.current);
      samplerRef.current = null;
      unsubOverridesRef.current?.();
      unsubOverridesRef.current = null;
      unsubRoleOverridesRef.current?.();
      unsubRoleOverridesRef.current = null;
      engineRef.current?.dispose();
      compositorRef.current?.dispose();
      compositorRef.current = null;
      engineRef.current = null;
      applicationRef.current = null;
      clearMasterMeter();
      if (meterTimerRef.current !== null) {
        window.clearInterval(meterTimerRef.current);
        meterTimerRef.current = null;
      }
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

  // The card is a single overlay: with multiple simultaneously-unsupported
  // clips it targets one representative id (Set iteration order, i.e.
  // first-inserted this composite) — an accepted simplification.
  const unsupportedMediaId = unsupportedIds.values().next().value;

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
        background: "var(--background)",
      }}
    >
      <PixiApplication
        width={composition.width}
        height={composition.height}
        background={0x000000}
        antialias
        // Prefer WebGPU; PixiJS auto-falls back to WebGL when the
        // runtime doesn't expose `navigator.gpu` (older Chromium,
        // restricted contexts). `app.renderer.type` in the init log
        // reads 2 for WebGPU, 1 for WebGL — useful sanity check.
        preference="webgpu"
        onInit={handleInit}
        className="pixi-preview-canvas"
      />
      {initializing && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
          data-testid="pixi-preview-initializing"
        >
          <div className="preview-spinner" />
        </div>
      )}
      {(import.meta.env.DEV || import.meta.env.VITE_WEFTCUT_E2E === "1") && (
        <PerfTelemetryBridge compositorRef={compositorRef} engineRef={engineRef} />
      )}
      {unsupportedMediaId !== undefined && (
        <UnsupportedClipCard mediaId={unsupportedMediaId} />
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
    /// Output bit depth (8 = existing pipeline; 10 = f16/WebGL2 + native-encode).
    bitDepth?: 8 | 10;
    /// Present ⇒ the worker packs frames to this format and streams them to
    /// the native ffmpeg sink instead of WebCodecs-encoding.
    nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
    /// Per-media decode routing table (see exportDecodeRouting.ts). Threaded
    /// straight into `runExport`.
    decodeRouting?: ExportDecodeRouting;
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
      ...(opts.bitDepth != null ? { bitDepth: opts.bitDepth } : {}),
      ...(opts.nativeSinkPixFmt != null
        ? { nativeSinkPixFmt: opts.nativeSinkPixFmt }
        : {}),
      ...(opts.decodeRouting ? { decodeRouting: opts.decodeRouting } : {}),
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
