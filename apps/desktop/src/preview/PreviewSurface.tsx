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
import { AudioGraph } from "./dom/audio/AudioGraph";
import { LiveLayers } from "./dom/LiveLayers";
import { PlaybackEngine } from "./dom/PlaybackEngine";

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
    const [fitScale, setFitScale] = useState<number>(1);

    // Mount engine + audio graph once. Dispose on unmount.
    useEffect(() => {
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
          if (!engine || !audioGraph) return;
          // AudioContext must be resumed under a user gesture
          // before any audio is audible. The parent's play button
          // is a click handler — this call sequence is what makes
          // it count.
          void audioGraph.resume().then(() => engine.play());
        },
        pause() {
          engine?.pause();
        },
        seekTo(tUs: number) {
          engine?.seek(tUs);
        },
        paused() {
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

    return (
      <div
        ref={outerRef}
        className="preview-video"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: "#000",
        }}
      >
        {/* Inner canvas at project-native resolution. CSS scale fits
            it into the outer container; layers render at their
            actual pixel coordinates inside. */}
        <div
          className="preview-dom-canvas"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: composition.width,
            height: composition.height,
            transformOrigin: "top left",
            transform: `scale(${fitScale})`,
          }}
        >
          {engine && (
            <LiveLayers engine={engine} audioGraph={audioGraph} />
          )}
        </div>
      </div>
    );
  },
);
