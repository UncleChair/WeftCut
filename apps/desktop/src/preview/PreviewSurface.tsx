/// Phase A.7 — `<PreviewSurface>` rewritten as a DOM compositor mount.
///
/// Replaces the legacy three-mode surface (cached `<video>`,
/// segmented MSE, B.3 WebCodecs canvas) with a single
/// `LiveLayers` tree driven by `PlaybackEngine` + `AudioGraph`.
/// External props + imperative handle shape are unchanged so the
/// parent App.tsx doesn't need to know.
///
/// The legacy event subscriptions (preview:render_complete,
/// preview:segment_ready, etc.) are gone here — those events still
/// fire from the Rust side until Phase F deletes the cached/segmented
/// renderers, but they're inert from this surface's POV.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useProjectStore } from "../state/projectStore";
import { PixiPreview } from "../render/PixiPreview";
import {
  isPixiPreviewEnabled,
  type PixiPreviewHandle,
} from "../render/pixiPreviewFlag";
import { PixiErrorBoundary } from "../render/PixiErrorBoundary";
import { AudioGraph } from "./dom/audio/AudioGraph";
import { LiveLayers } from "./dom/LiveLayers";
import { PlaybackEngine } from "./dom/PlaybackEngine";
import { RenderAndPlay } from "./dom/RenderAndPlay";

interface Props {
  /// True when the project has at least one layer. When false we
  /// render the empty-state placeholder.
  hasContent: boolean;
  /// Master clock callback in microseconds. Engine throttles to
  /// ~30 Hz so this is safe to drop into React state directly.
  onTimeUpdate: (tUs: number) => void;
  /// Mirror of `engine.isPlaying()` → inverted to match the legacy
  /// "paused" convention the parent's transport button expects.
  onPausedChange: (paused: boolean) => void;
}

export interface PreviewSurfaceHandle {
  play(): void;
  pause(): void;
  seekTo(tUs: number): void;
  paused(): boolean;
}

/// Visual scaling: we render the layer canvas at the project's
/// native composition pixels (so x/y/transform values from the IR
/// map 1:1) and use `transform: scale(...)` on a wrapper to fit
/// it into whatever the surrounding panel gives us.
function computeFitScale(
  outerW: number,
  outerH: number,
  canvasW: number,
  canvasH: number,
): number {
  if (canvasW <= 0 || canvasH <= 0 || outerW <= 0 || outerH <= 0) return 1;
  return Math.min(outerW / canvasW, outerH / canvasH);
}

export const PreviewSurface = forwardRef<PreviewSurfaceHandle, Props>(
  function PreviewSurface(
    { hasContent, onTimeUpdate, onPausedChange },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    const composition = useProjectStore((s) => s.summary?.composition);

    // Engine + audio graph are stateful — kept in React state so the
    // child <LiveLayers> can render once they exist.
    const [engine, setEngine] = useState<PlaybackEngine | null>(null);
    const [audioGraph, setAudioGraph] = useState<AudioGraph | null>(null);

    const outerRef = useRef<HTMLDivElement | null>(null);
    const pixiRef = useRef<PixiPreviewHandle | null>(null);
    const [fitScale, setFitScale] = useState<number>(1);
    /// True while Render & Play has taken over the surface (rendering
    /// or playing the rendered MP4). LiveLayers is hidden so we
    /// don't double-decode audio / contest the GPU with both
    /// renderers.
    const [renderPreviewActive, setRenderPreviewActive] = useState<boolean>(false);

    // Mount engine + audio graph once. Dispose on unmount.
    //
    // SKIPPED when pixi mode is on: the legacy DOM `PlaybackEngine`
    // unconditionally starts a `requestAnimationFrame` loop in its
    // constructor and fires `onTimeUpdate(0)` every ~33 ms even when
    // paused (its masterUs stays 0 because nothing ever called play()
    // on it). In pixi mode that emit stream stomps over the PIXI
    // engine's correct time updates, which manifests as "playhead
    // jumps back to 0 when pause is hit."
    useEffect(() => {
      if (isPixiPreviewEnabled()) {
        // PixiPreview owns its own PlaybackEngine + Compositor; the
        // legacy DOM stack is unused in this mode.
        return;
      }
      const ag = new AudioGraph();
      const e = new PlaybackEngine({ audioGraph: ag });
      setAudioGraph(ag);
      setEngine(e);
      const unsubTime = e.onTimeUpdate((us) => onTimeUpdate(us));
      const unsubPlay = e.onPlayStateChange((playing) => onPausedChange(!playing));
      return () => {
        unsubTime();
        unsubPlay();
        e.dispose();
        ag.dispose();
        setEngine(null);
        setAudioGraph(null);
      };
      // onTimeUpdate / onPausedChange are stable across renders in
      // practice (parent passes setState dispatchers); intentionally
      // excluded from deps so we don't tear down + rebuild the engine
      // on every parent re-render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // When Render & Play takes over, pause the live engine and mute
    // the Web Audio master so the rendered `<video>`'s own audio is
    // the only thing playing. Restore on return-to-live.
    useEffect(() => {
      if (!engine || !audioGraph) return;
      if (renderPreviewActive) {
        engine.pause();
        audioGraph.muteMaster();
      } else {
        audioGraph.unmuteMaster();
        // Don't auto-resume — the user explicitly chose to return,
        // and may want to scrub the timeline before playing again.
      }
    }, [renderPreviewActive, engine, audioGraph]);

    // Outer-container size tracking → recompute fit scale.
    useEffect(() => {
      const outer = outerRef.current;
      if (!outer || !composition) return;
      const ro = new ResizeObserver(() => {
        const { width: ow, height: oh } = outer.getBoundingClientRect();
        const s = computeFitScale(ow, oh, composition.width, composition.height);
        setFitScale(s);
      });
      ro.observe(outer);
      // Initial measure — ResizeObserver fires synchronously the
      // first time on most browsers, but explicit measure here
      // guarantees the very first paint has the right scale.
      const { width: ow, height: oh } = outer.getBoundingClientRect();
      setFitScale(computeFitScale(ow, oh, composition.width, composition.height));
      return () => ro.disconnect();
    }, [composition]);

    useImperativeHandle(
      forwardedRef,
      (): PreviewSurfaceHandle => ({
        play() {
          // When the PixiJS renderer is the active surface, route to
          // its PlaybackEngine. The DOM `engine` + `audioGraph` belong
          // to the legacy `LiveLayers` mount which is hidden in pixi
          // mode and shouldn't be ticking.
          if (isPixiPreviewEnabled()) {
            pixiRef.current?.play();
            return;
          }
          if (!engine || !audioGraph) return;
          // AudioContext must be resumed under a user gesture
          // before any audio is audible. The parent's play button
          // is a click handler — this call sequence is what makes
          // it count.
          void audioGraph.resume().then(() => engine.play());
        },
        pause() {
          if (isPixiPreviewEnabled()) {
            pixiRef.current?.pause();
            return;
          }
          engine?.pause();
        },
        seekTo(tUs: number) {
          if (isPixiPreviewEnabled()) {
            pixiRef.current?.seek(tUs);
            return;
          }
          engine?.seek(tUs);
        },
        paused() {
          if (isPixiPreviewEnabled()) {
            return pixiRef.current?.paused() ?? true;
          }
          return !(engine?.isPlaying() ?? false);
        },
      }),
      [engine, audioGraph],
    );

    if (!hasContent) {
      return <span className="placeholder">{t("preview.empty_hint")}</span>;
    }
    if (!composition) {
      return (
        <div className="preview-loading" aria-live="polite">
          <span className="preview-spinner" aria-hidden="true" />
          <span className="placeholder">{t("preview.preparing")}</span>
        </div>
      );
    }

    // Flag-gated parallel mount for the PixiJS + WebCodecs renderer
    // (P2 of the renderer rewrite). The legacy `<video>` DOM
    // compositor remains the default; pass `?pixi=1` or set
    // `localStorage.weftcut.preview.pixi = "1"` to opt in. The two
    // mounts are mutually exclusive — `PixiPreview` owns its own
    // PlaybackEngine + Compositor and does not share state with
    // `LiveLayers` + the DOM `PlaybackEngine`.
    if (isPixiPreviewEnabled()) {
      return (
        <div
          ref={outerRef}
          className="preview-video"
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
            background: "#1f2937",
          }}
        >
          <PixiErrorBoundary>
            <PixiPreview
              ref={pixiRef}
              onTimeUpdate={onTimeUpdate}
              onPausedChange={onPausedChange}
            />
          </PixiErrorBoundary>
        </div>
      );
    }

    return (
      <div
        ref={outerRef}
        className="preview-video"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          // Lighter-dark surround so the project canvas (black) reads
          // as a distinct rectangle against the preview's letterbox
          // area when the canvas aspect doesn't match the preview
          // panel's. Matches the app theme's slate-800 panel color.
          background: "#1f2937",
        }}
      >
        {/* Inner canvas at project-native resolution. CSS scale fits
            it into the outer container; layers render at their
            actual pixel coordinates inside. Explicit black background
            mirrors the export's `Color { rgba: project.composition.background }`
            base (project bg defaults to `Rgba::BLACK`), so a layer
            smaller than the canvas (e.g. 1920×1032 source in a 1920×1080
            canvas) shows the same black backdrop as the exported mp4
            and the canvas boundary is visible against the lighter
            surround.
            Positioning: `position: absolute; top: 50%; left: 50%;` puts
            the inner's TOP-LEFT at the outer's center; the `translate(-50%, -50%)`
            inside the transform then shifts by half the un-scaled
            dims so the inner's true center lands on the outer's
            center. `scale(${fitScale})` is composed with the translate
            in the same transform — `transform-origin: center` (default)
            keeps the scale anchored. The inner is absolute-positioned
            so it doesn't participate in the outer's flex/block layout
            and can't push the panel to grow on small windows. */}
        <div
          className="preview-dom-canvas"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: composition.width,
            height: composition.height,
            transform: `translate(-50%, -50%) scale(${fitScale})`,
            background: "#000",
            // Hide live compositor while a rendered preview is
            // active so we don't double-play audio.
            visibility: renderPreviewActive ? "hidden" : "visible",
          }}
        >
          {engine && (
            <LiveLayers engine={engine} audioGraph={audioGraph} />
          )}
        </div>
        <RenderAndPlay onActiveChange={setRenderPreviewActive} />
      </div>
    );
  },
);
