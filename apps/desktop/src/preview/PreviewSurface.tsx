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

import {
  logEmit,
  PREVIEW_EVENTS,
  previewCurrentPath,
  previewRetrySegment,
  previewSetPlayhead,
  previewWebcodecsRecipe,
  SEGMENT_EVENTS,
  type ManifestChanged,
  type PreviewReady,
  type SegmentError,
  type SegmentReady,
  type AudioReady,
} from "../ipc";
import {
  SegmentedMSEPlayer,
  type SegmentMeta,
} from "./SegmentedMSEPlayer";
import { PlaybackEngine } from "./webcodecs/playbackEngine";
import { useEffectivePreviewMode } from "./webcodecs/previewModeStore";

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
  /// Legacy path: `preview:render_complete` landed; `src` is the freshest
  /// whole-timeline MP4. The parent's transport buttons drive it
  /// directly via the imperative handle.
  | { kind: "ready"; src: string; stateHash: string; durationUs: number }
  /// Segmented path (A4): a `manifest_changed` event has landed and we
  /// have a SegmentedMSEPlayer feeding `<video src=blob:mediasource>`.
  /// `src` is the player's stable `objectUrl`; segment_ready events
  /// extend the buffered range as they arrive.
  | {
      kind: "segmented";
      src: string;
      globalHash: string;
      durationUs: number;
      pendingAtPlayhead: boolean;
    }
  /// `preview:render_error` landed. The video element still shows the
  /// last good frame (if any); error overlay shows the detail.
  | { kind: "error"; detail: string };

function rangeCoversPlayhead(
  range: { inUs: number; outUs: number },
  video: HTMLVideoElement | null,
): boolean {
  if (!video) return false;
  const tUs = Math.round(video.currentTime * 1_000_000);
  return tUs >= range.inUs && tUs < range.outUs;
}

export const PreviewSurface = forwardRef<PreviewSurfaceHandle, Props>(
  function PreviewSurface(
    { hasContent, onTimeUpdate, onPausedChange },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement | null>(null);
    // B6b — realtime mode is driven by the resolved preview-mode
    // store. When it flips to "realtime" we mount a canvas +
    // PlaybackEngine instead of the `<video>` surface; the legacy /
    // segmented event subscriptions stay live so switching modes
    // back doesn't need a reload.
    const effectiveMode = useEffectivePreviewMode();
    const inRealtimeMode = effectiveMode === "realtime";
    const realtimeCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<PlaybackEngine | null>(null);
    // Mirror inRealtimeMode in a ref so the (stable) imperative
    // handle below can branch on the live value without re-creating
    // itself every render.
    const inRealtimeModeRef = useRef(inRealtimeMode);
    useEffect(() => {
      inRealtimeModeRef.current = inRealtimeMode;
    }, [inRealtimeMode]);
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
            // If segmented mode is already active, ignore legacy
            // completion — the MSE player is authoritative.
            setState((cur) => {
              if (cur.kind === "segmented") return cur;
              const src = convertFileSrc(e.payload.path);
              return {
                kind: "ready",
                src,
                stateHash: e.payload.stateHash,
                durationUs: e.payload.durationUs,
              };
            });
          },
        );
        const onError = await listen<{ detail: string }>(
          PREVIEW_EVENTS.error,
          (e) => {
            setRebuilding(false);
            setState((cur) =>
              cur.kind === "segmented" ? cur : { kind: "error", detail: e.payload.detail },
            );
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

    // Segmented-mode event subscription (Phase A4). Activates when the
    // first `manifest_changed` event lands; in legacy mode (no
    // WEFTCUT_PREVIEW_SEGMENTED env var) these events never fire.
    const playerRef = useRef<SegmentedMSEPlayer | null>(null);
    // Local cache of the known segment ranges so the seek-into-pending
    // check knows what's buffered. Updated on segment_ready arrival.
    const segmentsRef = useRef<SegmentMeta[]>([]);
    // Failed-segment registry for the playhead-in-failed-range overlay.
    // hash → segment metadata + the first line of the error detail.
    const failedSegmentsRef = useRef<
      Map<string, { inUs: number; outUs: number; detail: string }>
    >(new Map());
    const [failedAtPlayhead, setFailedAtPlayhead] = useState<{
      hash: string;
      detail: string;
    } | null>(null);
    useEffect(() => {
      const unlisteners: UnlistenFn[] = [];
      let cancelled = false;
      (async () => {
        const onManifest = await listen<ManifestChanged>(
          SEGMENT_EVENTS.manifestChanged,
          (e) => {
            // First manifest event in this session: spin up an MSE player
            // pinned to the manifest's codec strings (so Linux builds
            // using VP9/Opus get the right SourceBuffer mime). Subsequent
            // events re-use the same player IF the codec didn't change;
            // a codec swap mid-session would require teardown + rebuild,
            // which is rare (only happens if the user moves between
            // OS-flavored workspaces).
            if (!playerRef.current) {
              const player = new SegmentedMSEPlayer(
                e.payload.videoCodec,
                e.payload.audioCodec,
              );
              playerRef.current = player;
              setState({
                kind: "segmented",
                src: player.objectUrl,
                globalHash: e.payload.globalHash,
                durationUs: e.payload.durationUs,
                pendingAtPlayhead: false,
              });
            } else {
              setState((cur) =>
                cur.kind === "segmented"
                  ? {
                      ...cur,
                      globalHash: e.payload.globalHash,
                      durationUs: e.payload.durationUs,
                    }
                  : cur,
              );
            }
            // Reset known segments — segment_ready events will rebuild.
            segmentsRef.current = [];
            playerRef.current?.setManifest([], e.payload.durationUs);
          },
        );
        const onSegmentReady = await listen<SegmentReady>(
          SEGMENT_EVENTS.segmentReady,
          (e) => {
            const player = playerRef.current;
            if (!player) return;
            const { hash, inUs, outUs, path } = e.payload;
            const cur = segmentsRef.current;
            if (!cur.some((s) => s.hash === hash)) {
              const next = [...cur, { hash, inUs, outUs }].sort(
                (a, b) => a.inUs - b.inUs,
              );
              segmentsRef.current = next;
              const last = next[next.length - 1];
              player.setManifest(next, last.outUs);
            }
            void player.appendSegment(hash, convertFileSrc(path));
            // Successful render: drop any failed marker for this hash.
            failedSegmentsRef.current.delete(hash);
            setFailedAtPlayhead((cur) => (cur?.hash === hash ? null : cur));
            // If the seek-pending overlay is up and this segment covers
            // the playhead, clear it.
            setState((s) =>
              s.kind === "segmented" && s.pendingAtPlayhead
                ? {
                    ...s,
                    pendingAtPlayhead: !rangeCoversPlayhead(
                      { hash, inUs, outUs },
                      videoRef.current,
                    ),
                  }
                : s,
            );
          },
        );
        const onAudioReady = await listen<AudioReady>(
          SEGMENT_EVENTS.audioReady,
          (e) => {
            void playerRef.current?.appendAudio(convertFileSrc(e.payload.path));
          },
        );
        const onSegmentError = await listen<SegmentError>(
          SEGMENT_EVENTS.segmentError,
          (e) => {
            const meta = segmentsRef.current.find(
              (s) => s.hash === e.payload.hash,
            );
            if (!meta) return;
            failedSegmentsRef.current.set(e.payload.hash, {
              inUs: meta.inUs,
              outUs: meta.outUs,
              detail: e.payload.detail,
            });
            // If the playhead is currently in the failed range, raise
            // the overlay.
            const v = videoRef.current;
            if (v) {
              const tUs = Math.round(v.currentTime * 1_000_000);
              if (tUs >= meta.inUs && tUs < meta.outUs) {
                setFailedAtPlayhead({
                  hash: e.payload.hash,
                  detail: e.payload.detail,
                });
              }
            }
          },
        );
        if (cancelled) {
          onManifest();
          onSegmentReady();
          onAudioReady();
          onSegmentError();
          return;
        }
        unlisteners.push(onManifest, onSegmentReady, onAudioReady, onSegmentError);
      })();
      return () => {
        cancelled = true;
        for (const u of unlisteners) u();
        playerRef.current?.dispose();
        playerRef.current = null;
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
    const lastPlayheadReportRef = useRef<number>(0);
    const pumpTime = useCallback(() => {
      const v = videoRef.current;
      if (!v || v.paused) {
        rafRef.current = null;
        return;
      }
      const secs = v.currentTime;
      lastTimeRef.current = secs;
      const tUs = Math.round(secs * 1_000_000);
      onTimeUpdate(tUs);
      // Report to the Rust SegmentedRenderer so playhead priority is
      // accurate. Throttle to ~10 Hz — segment-priority quantum is much
      // coarser than 60 Hz, no point spamming.
      if (tUs - lastPlayheadReportRef.current >= 100_000) {
        lastPlayheadReportRef.current = tUs;
        void previewSetPlayhead(tUs).catch(() => {});
        // Same cadence: refresh the failed-at-playhead overlay. Linear
        // scan over failed segments (rare) is fine.
        let inFailed: { hash: string; detail: string } | null = null;
        for (const [hash, meta] of failedSegmentsRef.current.entries()) {
          if (tUs >= meta.inUs && tUs < meta.outUs) {
            inFailed = { hash, detail: meta.detail };
            break;
          }
        }
        setFailedAtPlayhead(inFailed);
      }
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
          if (inRealtimeModeRef.current) {
            engineRef.current?.play();
            return;
          }
          void videoRef.current?.play().catch(() => {});
        },
        pause() {
          if (inRealtimeModeRef.current) {
            engineRef.current?.pause();
            return;
          }
          videoRef.current?.pause();
        },
        seekTo(tUs: number) {
          if (inRealtimeModeRef.current) {
            engineRef.current?.seekTo(tUs);
            // Still inform the Rust segmented orchestrator — it's
            // harmless when segmented mode isn't running and
            // useful if the user switches modes mid-session.
            void previewSetPlayhead(tUs).catch(() => {});
            return;
          }
          const v = videoRef.current;
          if (!v) return;
          const secs = tUs / 1_000_000;
          try {
            v.currentTime = secs;
          } catch {
            // ignored — video may not have a loaded src yet
          }
          lastTimeRef.current = secs;
          // Tell the Rust orchestrator the new playhead so the next
          // queue push assigns Playhead priority to the right segment.
          void previewSetPlayhead(tUs).catch(() => {});
          // In segmented mode: detect seek-into-pending OR
          // seek-into-failed and surface the appropriate overlay.
          const player = playerRef.current;
          if (player) {
            const target = player.segmentAt(tUs);
            const isPending = !target || !player.hasSegment(target.hash);
            setState((s) =>
              s.kind === "segmented" ? { ...s, pendingAtPlayhead: isPending } : s,
            );
            // Failed overlay check.
            let inFailed: { hash: string; detail: string } | null = null;
            for (const [hash, meta] of failedSegmentsRef.current.entries()) {
              if (tUs >= meta.inUs && tUs < meta.outUs) {
                inFailed = { hash, detail: meta.detail };
                break;
              }
            }
            setFailedAtPlayhead(inFailed);
          }
        },
        paused() {
          if (inRealtimeModeRef.current) {
            return engineRef.current?.paused() ?? true;
          }
          return videoRef.current?.paused ?? true;
        },
      }),
      [],
    );

    // B6b realtime engine lifecycle. The canvas only mounts when
    // inRealtimeMode is true; this effect creates the engine on
    // mount and disposes on unmount. It also runs an immediate
    // recipe + audio fetch so the surface paints something before
    // the next project:changed event.
    useEffect(() => {
      if (!inRealtimeMode) return;
      const canvas = realtimeCanvasRef.current;
      if (!canvas) return;
      const engine = new PlaybackEngine(canvas, {
        onTimeUpdate: (t) => onTimeUpdate(t),
        onPausedChange: (p) => onPausedChange(p),
        // B6c — surface decoder failures + stalls to the status
        // log. Each (clip, kind) fires at most once per engine
        // lifetime so the bar doesn't fill up.
        onDecoderIssue: (issue) => {
          const basename = issue.mediaPath.split(/[\\/]/).pop() ?? issue.mediaPath;
          const verb = issue.kind === "stall" ? "stalled" : "failed";
          void logEmit({
            level: issue.kind === "stall" ? "warn" : "error",
            category: { kind: "Project" },
            source: { kind: "System" },
            message: `Real-time preview decoder ${verb} for ${basename}: ${issue.detail}`,
          }).catch(() => {});
        },
      });
      engineRef.current = engine;

      const fetchAll = async () => {
        try {
          const recipe = await previewWebcodecsRecipe();
          engine.setRecipe(recipe);
        } catch {
          // Recipe unavailable (no project, MCP race, etc.).
          // Engine sits at empty-state until the next project:changed
          // or hasContent-flip fetch.
        }
        try {
          const path = await previewCurrentPath();
          engine.setAudioUrl(path ? convertFileSrc(path) : null);
        } catch {
          engine.setAudioUrl(null);
        }
      };
      void fetchAll();

      return () => {
        engine.dispose();
        engineRef.current = null;
      };
    }, [inRealtimeMode, onTimeUpdate, onPausedChange]);

    // Re-fetch the recipe on every project:changed while in
    // realtime mode. The legacy / segmented branches already react
    // to their own events; realtime needs an explicit refresh
    // because the recipe is a pull from a Rust command rather than
    // a pushed event.
    useEffect(() => {
      if (!inRealtimeMode) return;
      let unlisten: UnlistenFn | null = null;
      let cancelled = false;
      (async () => {
        const u = await listen("project:changed", () => {
          const engine = engineRef.current;
          if (!engine) return;
          void previewWebcodecsRecipe()
            .then((r) => engine.setRecipe(r))
            .catch(() => {});
        });
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })();
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    }, [inRealtimeMode]);

    // Startup-race guard: the engine effect's initial `fetchAll`
    // happens on mount, but a workspace that's still mid-`project_open`
    // can return a not-yet-ready recipe (or fail outright). The
    // `project:changed` listener catches *subsequent* mutations, but
    // can miss the very first load event if the listener installs
    // after that event was emitted. Mirror the fetch off the
    // `hasContent` prop, which the parent flips true once
    // `summary.layer_count > 0` — by then the project actor is fully
    // populated and the recipe is meaningful.
    useEffect(() => {
      if (!inRealtimeMode) return;
      if (!hasContent) return;
      const engine = engineRef.current;
      if (!engine) return;
      void previewWebcodecsRecipe()
        .then((r) => engine.setRecipe(r))
        .catch(() => {});
    }, [inRealtimeMode, hasContent]);

    // Track the latest legacy preview MP4 for the realtime path's
    // audio source. The legacy renderer always produces this even
    // when WEFTCUT_PREVIEW_SEGMENTED is set; it carries the mixed
    // audio track that the engine's `<audio>` element consumes.
    useEffect(() => {
      if (!inRealtimeMode) return;
      let unlisten: UnlistenFn | null = null;
      let cancelled = false;
      (async () => {
        const u = await listen<PreviewReady>(
          PREVIEW_EVENTS.complete,
          (e) => {
            engineRef.current?.setAudioUrl(convertFileSrc(e.payload.path));
          },
        );
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      })();
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    }, [inRealtimeMode]);

    if (!hasContent) {
      return (
        <span className="placeholder">{t("preview.empty_hint")}</span>
      );
    }
    // B6b — realtime mode owns the surface entirely. The canvas is
    // driven by the PlaybackEngine; the transport controls in the
    // parent route through the imperative handle. We deliberately
    // skip the legacy "Rebuilding…" / "preview unavailable" overlays
    // here because realtime doesn't go through the segment-render
    // lifecycle that those overlays describe.
    if (inRealtimeMode) {
      return (
        <canvas
          ref={realtimeCanvasRef}
          className="preview-video"
          aria-label={t("preview.realtime_label", "Real-time preview")}
        />
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
    const videoSrc =
      state.kind === "ready"
        ? state.src
        : state.kind === "segmented"
          ? state.src
          : undefined;
    return (
      <>
        <video
          ref={videoRef}
          className="preview-video"
          src={videoSrc}
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
        {rebuilding && state.kind !== "segmented" && (
          <div className="preview-rebuilding" aria-live="polite">
            <span className="preview-spinner-inline" aria-hidden="true" />
            <span>{t("preview.rebuilding")}</span>
          </div>
        )}
        {state.kind === "segmented" && state.pendingAtPlayhead && (
          <div className="preview-rebuilding" aria-live="polite">
            <span className="preview-spinner-inline" aria-hidden="true" />
            <span>
              {t("preview.rendering_range", "Rendering this range…")}
            </span>
          </div>
        )}
        {failedAtPlayhead && (
          <div className="preview-failed-overlay" role="alert">
            <div className="preview-failed-strip" />
            <span>{t("preview.unavailable_range", "Preview unavailable for this range")}</span>
            <button
              type="button"
              className="preview-failed-retry"
              onClick={() => {
                const target = failedAtPlayhead;
                void previewRetrySegment(target.hash).catch(() => {});
              }}
            >
              {t("preview.retry_rendering", "Retry rendering")}
            </button>
          </div>
        )}
      </>
    );
  },
);
