import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { PREVIEW_EVENTS, previewCurrentPath, type PreviewReady } from "../ipc";

interface Props {
  /// Project ready to be previewed? When false the surface stays on the
  /// empty-state placeholder regardless of any in-flight render the
  /// renderer might have left over from a previous project. Driven by
  /// `summary.layer_count > 0` in the parent.
  hasContent: boolean;
  /// Live playhead in microseconds. The parent owns the timeline + the
  /// numeric timecode display; we mirror it back into the `<video>`
  /// element when the parent issues a `seek()`. We also push out our own
  /// playhead via `onTimeUpdate` while playing.
  onTimeUpdate: (tUs: number) => void;
  /// Whether the `<video>` element is currently paused. Used by the
  /// transport button's icon swap. Mirrors `video.paused` events.
  onPausedChange: (paused: boolean) => void;
}

export interface PreviewSurfaceHandle {
  play(): void;
  pause(): void;
  seekTo(tUs: number): void;
  /// Current paused state. Lets the parent's `togglePlay` peek without
  /// having to thread a `paused` prop both directions.
  paused(): boolean;
}

type RenderState =
  /// Renderer hasn't produced anything yet for this session. If the
  /// workspace had a prior preview MP4, we pull it in via the
  /// `preview_current_path` command at mount and skip this state.
  | { kind: "idle" }
  /// Renderer reported `preview:render_started` — a new MP4 is being
  /// produced. The current `<video src>` (if any) stays playable in the
  /// meantime; a small overlay says "Rebuilding…".
  | { kind: "rendering" }
  /// `preview:render_complete` landed; `src` is the freshest MP4. The
  /// parent's transport buttons drive it directly via the imperative
  /// handle.
  | { kind: "ready"; src: string; stateHash: string; durationUs: number }
  /// `preview:render_error` landed. The video element still shows the
  /// last good frame (if any); error overlay shows the detail.
  | { kind: "error"; detail: string };

export const PreviewSurface = forwardRef<PreviewSurfaceHandle, Props>(
  function PreviewSurface(
    { hasContent, onTimeUpdate, onPausedChange },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [state, setState] = useState<RenderState>({ kind: "idle" });
    // Whether a re-render is currently in flight. Distinct from
    // `state.kind === "rendering"` because we may already have a
    // playable `<video src>` from a prior render — the inflight flag
    // just controls the small "Rebuilding…" overlay.
    const [rebuilding, setRebuilding] = useState(false);

    // On mount: ask the backend whether a preview MP4 already exists for
    // the current project state. If so, point `<video>` at it
    // immediately. Avoids a blank surface while we wait for the first
    // commit-debounce cycle.
    useEffect(() => {
      let cancelled = false;
      previewCurrentPath()
        .then((p) => {
          if (cancelled || !p) return;
          const src = convertFileSrc(p);
          setState({ kind: "ready", src, stateHash: "", durationUs: 0 });
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, []);

    // Subscribe to renderer events.
    useEffect(() => {
      const unlisteners: UnlistenFn[] = [];
      let cancelled = false;
      (async () => {
        const onStarted = await listen(PREVIEW_EVENTS.started, () => {
          setRebuilding(true);
        });
        const onComplete = await listen<PreviewReady>(
          PREVIEW_EVENTS.complete,
          (e) => {
            setRebuilding(false);
            const src = convertFileSrc(e.payload.path);
            setState({
              kind: "ready",
              src,
              stateHash: e.payload.stateHash,
              durationUs: e.payload.durationUs,
            });
          },
        );
        const onError = await listen<{ detail: string }>(
          PREVIEW_EVENTS.error,
          (e) => {
            setRebuilding(false);
            setState({ kind: "error", detail: e.payload.detail });
          },
        );
        if (cancelled) {
          onStarted();
          onComplete();
          onError();
          return;
        }
        unlisteners.push(onStarted, onComplete, onError);
      })();
      return () => {
        cancelled = true;
        for (const u of unlisteners) u();
      };
    }, []);

    // Preserve playhead + paused across `src` swaps. Without this, every
    // re-render would reset to t=0 and start playing — which would feel
    // like the editor lost the user's place every time they edited
    // anything.
    const lastTimeRef = useRef<number>(0);
    const lastPausedRef = useRef<boolean>(true);

    // requestAnimationFrame pump for smooth playhead updates during
    // playback. The `<video>` element's native `timeupdate` event fires
    // at most ~4Hz per the HTML5 spec, which reads as jerky on the
    // timeline. RAF runs at the display refresh rate (~60Hz) while
    // playing; we cancel it on pause + on unmount so it doesn't spin
    // forever. Paused-state seeks don't need the pump — `seekTo()` in
    // the imperative handle already pushes `currentTimeUs` up to the
    // parent before setting `video.currentTime`.
    const rafRef = useRef<number | null>(null);
    const pumpTime = useCallback(() => {
      const v = videoRef.current;
      if (!v || v.paused) {
        rafRef.current = null;
        return;
      }
      const secs = v.currentTime;
      lastTimeRef.current = secs;
      onTimeUpdate(Math.round(secs * 1_000_000));
      rafRef.current = requestAnimationFrame(pumpTime);
    }, [onTimeUpdate]);

    useEffect(() => {
      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, []);
    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      if (state.kind !== "ready") return;
      const onLoaded = () => {
        try {
          v.currentTime = lastTimeRef.current;
        } catch {
          // setting currentTime can throw if loadedmetadata raced; ignore
        }
        if (!lastPausedRef.current) {
          void v.play().catch(() => {});
        }
      };
      v.addEventListener("loadedmetadata", onLoaded, { once: true });
      return () => v.removeEventListener("loadedmetadata", onLoaded);
    }, [state.kind === "ready" ? state.src : null]);

    useImperativeHandle(
      forwardedRef,
      (): PreviewSurfaceHandle => ({
        play() {
          void videoRef.current?.play().catch(() => {});
        },
        pause() {
          videoRef.current?.pause();
        },
        seekTo(tUs: number) {
          const v = videoRef.current;
          if (!v) return;
          const secs = tUs / 1_000_000;
          try {
            v.currentTime = secs;
          } catch {
            // ignored — video may not have a loaded src yet
          }
          lastTimeRef.current = secs;
        },
        paused() {
          return videoRef.current?.paused ?? true;
        },
      }),
      [],
    );

    if (!hasContent) {
      return (
        <span className="placeholder">{t("preview.empty_hint")}</span>
      );
    }
    if (state.kind === "idle") {
      return (
        <div className="preview-loading" aria-live="polite">
          <span className="preview-spinner" aria-hidden="true" />
          <span className="placeholder">{t("preview.preparing")}</span>
        </div>
      );
    }
    if (state.kind === "error" && (state.kind as string) === "error") {
      return (
        <div className="preview-error" role="alert">
          <span className="preview-error-title">
            {t("preview.init_failed")}
          </span>
          {state.kind === "error" && state.detail && (
            <span className="preview-error-detail">{state.detail}</span>
          )}
        </div>
      );
    }
    return (
      <>
        <video
          ref={videoRef}
          className="preview-video"
          src={state.kind === "ready" ? state.src : undefined}
          preload="auto"
          onPlay={() => {
            lastPausedRef.current = false;
            onPausedChange(false);
            // Start the ~60Hz pump for smooth playhead motion. The
            // native `timeupdate` event only fires at ~4Hz so isn't
            // used here.
            if (rafRef.current === null) {
              rafRef.current = requestAnimationFrame(pumpTime);
            }
          }}
          onPause={() => {
            lastPausedRef.current = true;
            onPausedChange(true);
            if (rafRef.current !== null) {
              cancelAnimationFrame(rafRef.current);
              rafRef.current = null;
            }
            // Mirror the final video.currentTime once on pause so the
            // playhead lands exactly where the video stopped (RAF
            // cancellation can race the last frame by one tick).
            const v = videoRef.current;
            if (v) {
              const tUs = Math.round(v.currentTime * 1_000_000);
              lastTimeRef.current = v.currentTime;
              onTimeUpdate(tUs);
            }
          }}
        />
        {rebuilding && (
          <div className="preview-rebuilding" aria-live="polite">
            <span className="preview-spinner-inline" aria-hidden="true" />
            <span>{t("preview.rebuilding")}</span>
          </div>
        )}
      </>
    );
  },
);
