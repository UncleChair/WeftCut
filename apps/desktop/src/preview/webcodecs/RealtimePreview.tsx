// Phase B1/B2 — dev-mode WebCodecs smoke harness.
//
// Activated by `?previewMode=realtime` or
// `localStorage.weftcut:previewMode=realtime`. Replaces the standard
// `<PreviewSurface>` while the toggle is on.
//
// B1 path (decoder substrate):
//   - mp4box demuxes the picked clip
//   - VideoDecoder produces VideoFrames
//   - Frames render to a canvas via WebGL2 compositor
//
// B2 path (compositor):
//   - Multi-layer: video frame as the back layer + an optional PNG
//     overlay as the front layer
//   - Live controls for overlay transform, opacity, blend mode — proves
//     transforms/opacity/blends are wired through the compositor before
//     B3 starts emitting the JSON recipe that drives them for real.

import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  previewCurrentPath,
  previewWebcodecsRecipe,
  type WebcodecsRecipe,
} from "../../ipc";
import { Mp4Decoder, type ClipInfo } from "./decoder";
import {
  WebGL2Compositor,
  type BlendMode,
  type CompositorLayer,
} from "./compositor";
import { probeRealtimeCapability, type RealtimeCapability } from "./capability";
import {
  resolveEffectiveMode,
  usePreviewModeCapability,
  usePreviewModePreference,
  useSetPreviewModeCapability,
} from "./previewModeStore";
import { PlaybackEngine } from "./playbackEngine";

type Status =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ready"; clip: ClipInfo }
  | { kind: "error"; detail: string };

export function RealtimePreview() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<Mp4Decoder | null>(null);
  const compositorRef = useRef<WebGL2Compositor | null>(null);
  const latestFrameRef = useRef<VideoFrame | null>(null);
  const overlayBitmapRef = useRef<ImageBitmap | null>(null);
  const rafRef = useRef<number | null>(null);

  // Capability now lives in the shared zustand store (B4) — atomic
  // selectors so the smoke harness doesn't re-render on unrelated
  // store changes. The local `capability` variable just mirrors the
  // store value so the existing rendering blocks below don't need
  // restructuring.
  const capability = usePreviewModeCapability();
  const setCapability = useSetPreviewModeCapability();
  const preference = usePreviewModePreference();
  const effectiveMode = resolveEffectiveMode(preference, capability);
  const [compositorReady, setCompositorReady] = useState(false);
  const [compositorError, setCompositorError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [frameCount, setFrameCount] = useState(0);
  const [latestTimestampUs, setLatestTimestampUs] = useState(0);
  const [lastDecodeLatencyMs, setLastDecodeLatencyMs] = useState<number | null>(null);
  const [decoderErrors, setDecoderErrors] = useState<string[]>([]);

  // Overlay state (B2). Refs are read inside the RAF tick; mirroring
  // state lets the UI sliders drive the GL render at 60Hz without
  // recreating the loop on every change.
  // B3: fetched recipe — displayed below as a structural summary so we
  // can verify the IR emit walks the live project correctly. B5
  // additionally hands the recipe to the PlaybackEngine for real
  // playback in the B5 canvas below.
  const [recipe, setRecipe] = useState<WebcodecsRecipe | null>(null);
  const [recipeError, setRecipeError] = useState<string | null>(null);
  const [recipeLoading, setRecipeLoading] = useState(false);

  // B5: playback engine state. Owns its own canvas + compositor +
  // decoder pool; lives alongside (not replacing) the B1/B2 single-
  // clip smoke canvas so both verification paths stay usable.
  const playbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [playbackPaused, setPlaybackPaused] = useState(true);
  const [playbackTimeUs, setPlaybackTimeUs] = useState(0);
  const [playbackStats, setPlaybackStats] = useState<{
    activeDecoders: number;
    errors: ReadonlyArray<{ layerId: string; detail: string }>;
  }>({ activeDecoders: 0, errors: [] });

  const [overlayLoaded, setOverlayLoaded] = useState(false);
  const [opacity, setOpacity] = useState(0.85);
  const [overlayX, setOverlayX] = useState(0.35);
  const [overlayY, setOverlayY] = useState(0.35);
  const [overlayScale, setOverlayScale] = useState(0.3);
  const [blendMode, setBlendMode] = useState<BlendMode>("normal");
  const opacityRef = useRef(opacity);
  const overlayXRef = useRef(overlayX);
  const overlayYRef = useRef(overlayY);
  const overlayScaleRef = useRef(overlayScale);
  const blendModeRef = useRef<BlendMode>(blendMode);
  useEffect(() => { opacityRef.current = opacity; }, [opacity]);
  useEffect(() => { overlayXRef.current = overlayX; }, [overlayX]);
  useEffect(() => { overlayYRef.current = overlayY; }, [overlayY]);
  useEffect(() => { overlayScaleRef.current = overlayScale; }, [overlayScale]);
  useEffect(() => { blendModeRef.current = blendMode; }, [blendMode]);

  // One-shot capability probe — only if the store hasn't already
  // been seeded by App.tsx's mount probe. The smoke harness can be
  // opened before App's effect fires (race window <50ms) so we
  // back-stop here.
  useEffect(() => {
    if (capability) return;
    let cancelled = false;
    setStatus({ kind: "probing" });
    void probeRealtimeCapability().then((report: RealtimeCapability) => {
      if (cancelled) return;
      setCapability(report);
      setStatus({ kind: "idle" });
    });
    return () => {
      cancelled = true;
    };
  }, [capability, setCapability]);

  // Create the compositor once the canvas mounts.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      compositorRef.current = new WebGL2Compositor(canvas);
      setCompositorReady(true);
    } catch (e) {
      setCompositorError(String(e));
    }
    return () => {
      compositorRef.current?.dispose();
      compositorRef.current = null;
      setCompositorReady(false);
    };
  }, []);

  // RAF render loop. Pulls the current video frame + overlay bitmap
  // (if any) into a layer array and hands it to the compositor.
  useEffect(() => {
    const tick = () => {
      const compositor = compositorRef.current;
      const canvas = canvasRef.current;
      if (compositor && canvas) {
        const frame = latestFrameRef.current;
        const overlay = overlayBitmapRef.current;
        const layers: CompositorLayer[] = [];
        if (frame) {
          compositor.setSize(frame.displayWidth, frame.displayHeight);
          layers.push({
            source: frame,
            transform: { x: 0, y: 0, width: 1, height: 1 },
            opacity: 1,
            blendMode: "normal",
            // WebView2 ignores UNPACK_FLIP_Y_WEBGL on VideoFrame
            // uploads (zero-copy GPU fast path). Compensate per-layer
            // via the fragment shader's u_flipY uniform.
            flipY: true,
          });
        }
        if (overlay) {
          const s = overlayScaleRef.current;
          // Center the overlay box around (overlayX, overlayY).
          layers.push({
            source: overlay,
            transform: {
              x: overlayXRef.current - s / 2,
              y: overlayYRef.current - s / 2,
              width: s,
              height: s,
            },
            opacity: opacityRef.current,
            blendMode: blendModeRef.current,
          });
        }
        if (layers.length > 0) compositor.render(layers);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // Teardown.
  useEffect(() => {
    return () => {
      void decoderRef.current?.close();
      decoderRef.current = null;
      latestFrameRef.current?.close();
      latestFrameRef.current = null;
      overlayBitmapRef.current?.close();
      overlayBitmapRef.current = null;
    };
  }, []);

  const openClip = useCallback(async () => {
    const picked = await openDialog({
      title: "Pick a clip for the WebCodecs smoke test",
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "m4v", "mov"] }],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;

    await decoderRef.current?.close();
    decoderRef.current = null;
    latestFrameRef.current?.close();
    latestFrameRef.current = null;
    setFrameCount(0);
    setLatestTimestampUs(0);
    setLastDecodeLatencyMs(null);
    setDecoderErrors([]);
    setStatus({ kind: "idle" });

    const url = convertFileSrc(path);
    let openedAt = performance.now();
    let firstFrameAt: number | null = null;

    const decoder = new Mp4Decoder({
      onReady: (clip) => setStatus({ kind: "ready", clip }),
      onFrame: ({ frame, timestampUs }) => {
        if (firstFrameAt === null) {
          firstFrameAt = performance.now();
          setLastDecodeLatencyMs(firstFrameAt - openedAt);
        }
        latestFrameRef.current?.close();
        latestFrameRef.current = frame;
        setFrameCount((n) => n + 1);
        setLatestTimestampUs(timestampUs);
      },
      onError: (detail) => {
        setDecoderErrors((prev) => [...prev.slice(-9), detail]);
      },
    });
    decoderRef.current = decoder;

    try {
      openedAt = performance.now();
      await decoder.open(url);
    } catch (e) {
      setStatus({ kind: "error", detail: String(e) });
    }
  }, []);

  const closeClip = useCallback(async () => {
    await decoderRef.current?.close();
    decoderRef.current = null;
    latestFrameRef.current?.close();
    latestFrameRef.current = null;
    setStatus({ kind: "idle" });
  }, []);

  const pickOverlay = useCallback(async () => {
    const picked = await openDialog({
      title: "Pick an overlay image (B2 compositor smoke)",
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    try {
      const url = convertFileSrc(path);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      overlayBitmapRef.current?.close();
      overlayBitmapRef.current = bmp;
      setOverlayLoaded(true);
    } catch (e) {
      setDecoderErrors((prev) => [...prev.slice(-9), `overlay: ${String(e)}`]);
    }
  }, []);

  const clearOverlay = useCallback(() => {
    overlayBitmapRef.current?.close();
    overlayBitmapRef.current = null;
    setOverlayLoaded(false);
  }, []);

  const fetchRecipe = useCallback(async () => {
    setRecipeLoading(true);
    setRecipeError(null);
    try {
      const r = await previewWebcodecsRecipe();
      setRecipe(r);
      // Hand the fresh recipe to the engine immediately so the
      // playback canvas reflects the active project.
      engineRef.current?.setRecipe(r);
      // B6a — also hand it the legacy preview MP4 path as an audio
      // source. The legacy preview always carries the project's
      // mixed audio track; the engine's `<audio>` element ignores
      // the embedded video. Projects with no audio tracks land
      // duration=NaN and the engine falls back to the synthetic
      // clock cleanly.
      try {
        const path = await previewCurrentPath();
        if (path) {
          engineRef.current?.setAudioUrl(convertFileSrc(path));
        } else {
          engineRef.current?.setAudioUrl(null);
        }
      } catch {
        engineRef.current?.setAudioUrl(null);
      }
    } catch (e) {
      setRecipeError(String(e));
      setRecipe(null);
      engineRef.current?.setRecipe(null);
      engineRef.current?.setAudioUrl(null);
    } finally {
      setRecipeLoading(false);
    }
  }, []);

  // Create the playback engine when the B5 canvas mounts. Tear down
  // on unmount.
  useEffect(() => {
    const canvas = playbackCanvasRef.current;
    if (!canvas) return;
    const engine = new PlaybackEngine(canvas, {
      onTimeUpdate: (t) => setPlaybackTimeUs(t),
      onPausedChange: (p) => setPlaybackPaused(p),
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Periodic stats poll — engine itself doesn't push these (it'd
  // cause a React render every RAF tick).
  useEffect(() => {
    const id = window.setInterval(() => {
      const engine = engineRef.current;
      if (engine) setPlaybackStats(engine.stats());
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const playRecipe = useCallback(() => {
    engineRef.current?.play();
  }, []);
  const pauseRecipe = useCallback(() => {
    engineRef.current?.pause();
  }, []);
  const seekRecipeStart = useCallback(() => {
    engineRef.current?.seekTo(0);
  }, []);

  return (
    <div className="realtime-preview-smoke">
      <header className="realtime-preview-header">
        <strong>B1+B2 — WebCodecs decoder + WebGL2 compositor smoke</strong>
        <span className="realtime-preview-hint">
          Dev-mode harness: <code>?previewMode=realtime</code>. Standard preview
          path is gated off in this URL.
        </span>
      </header>

      <section className="realtime-preview-capability">
        <h3>Capability</h3>
        {!capability ? (
          <span>Probing…</span>
        ) : (
          <ul>
            <li>
              VideoDecoder API:{" "}
              <strong>{capability.apiPresent ? "present" : "MISSING"}</strong>
            </li>
            <li>
              H.264 (avc1.640028):{" "}
              <strong>{capability.h264Supported ? "supported" : "NOT supported"}</strong>
            </li>
            <li>
              WebGL2 probe:{" "}
              <strong>{capability.webgl2Ok ? "ok" : "FAILED"}</strong>
            </li>
            <li>
              WebGL2 compositor:{" "}
              <strong>
                {compositorError
                  ? "FAILED"
                  : compositorReady
                    ? "ready"
                    : "initializing"}
              </strong>
            </li>
            <li>
              Preference: <strong>{preference}</strong> → effective:{" "}
              <strong>{effectiveMode}</strong>
            </li>
            {capability.detail && <li>{capability.detail}</li>}
            {compositorError && <li className="realtime-preview-error">{compositorError}</li>}
          </ul>
        )}
      </section>

      <section className="realtime-preview-controls">
        <button type="button" onClick={openClip}>
          Pick clip…
        </button>
        <button
          type="button"
          onClick={closeClip}
          disabled={status.kind !== "ready"}
        >
          Close
        </button>
        <span className="realtime-preview-divider" />
        <button type="button" onClick={pickOverlay}>
          Pick overlay image…
        </button>
        <button type="button" onClick={clearOverlay} disabled={!overlayLoaded}>
          Clear overlay
        </button>
        <span className="realtime-preview-divider" />
        <button type="button" onClick={fetchRecipe} disabled={recipeLoading}>
          {recipeLoading ? "Fetching recipe…" : "Fetch recipe (B3)"}
        </button>
      </section>

      {overlayLoaded && (
        <section className="realtime-preview-overlay-ctrls">
          <h3>Overlay (front layer)</h3>
          <label>
            Opacity {opacity.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
            />
          </label>
          <label>
            X {overlayX.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={overlayX}
              onChange={(e) => setOverlayX(parseFloat(e.target.value))}
            />
          </label>
          <label>
            Y {overlayY.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={overlayY}
              onChange={(e) => setOverlayY(parseFloat(e.target.value))}
            />
          </label>
          <label>
            Size {overlayScale.toFixed(2)}
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.01}
              value={overlayScale}
              onChange={(e) => setOverlayScale(parseFloat(e.target.value))}
            />
          </label>
          <label>
            Blend
            <select
              value={blendMode}
              onChange={(e) => setBlendMode(e.target.value as BlendMode)}
            >
              <option value="normal">normal</option>
              <option value="add">add</option>
            </select>
          </label>
        </section>
      )}

      <section className="realtime-preview-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="realtime-preview-canvas"
          width={640}
          height={360}
        />
      </section>

      {(recipe || recipeError) && (
        <section className="realtime-preview-capability">
          <h3>Recipe (B3)</h3>
          {recipeError && (
            <p className="realtime-preview-error">Error: {recipeError}</p>
          )}
          {recipe && (
            <>
              <ul>
                <li>
                  Schema: <code>v{recipe.schemaVersion}</code>
                </li>
                <li>
                  Canvas: {recipe.canvas.width}×{recipe.canvas.height} @{" "}
                  {(recipe.canvas.fpsNum / recipe.canvas.fpsDen).toFixed(2)} fps
                </li>
                <li>
                  Duration: {(recipe.durationUs / 1_000_000).toFixed(2)}s
                </li>
                <li>
                  Layers: {recipe.clips.length} clip
                  {recipe.clips.length === 1 ? "" : "s"} ·{" "}
                  {recipe.rasters.length} raster
                  {recipe.rasters.length === 1 ? "" : "s"} ·{" "}
                  {recipe.images.length} image
                  {recipe.images.length === 1 ? "" : "s"}
                </li>
              </ul>
              {recipe.clips.length > 0 && (
                <details>
                  <summary>Clips ({recipe.clips.length})</summary>
                  <ul>
                    {recipe.clips.map((c, i) => (
                      <li key={i}>
                        track {c.trackIndex} · z={c.zOrder} ·{" "}
                        [{(c.timelineInUs / 1_000_000).toFixed(2)}s –{" "}
                        {(c.timelineOutUs / 1_000_000).toFixed(2)}s] ·{" "}
                        <code>{c.mediaPath.split(/[\\/]/).pop()}</code>{" "}
                        transform=({c.transform.x.toFixed(2)},
                        {c.transform.y.toFixed(2)}) size=(
                        {c.transform.width.toFixed(2)},
                        {c.transform.height.toFixed(2)}) op=
                        {c.opacity.toFixed(2)} blend={c.blendMode}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {recipe.rasters.length > 0 && (
                <details>
                  <summary>Rasters ({recipe.rasters.length})</summary>
                  <ul>
                    {recipe.rasters.map((r, i) => (
                      <li key={i}>
                        track {r.trackIndex} · z={r.zOrder} · {r.frameCount}{" "}
                        frames @ {(r.fpsNum / r.fpsDen).toFixed(0)} fps ·{" "}
                        dir=<code>{r.rasterDir.split(/[\\/]/).pop()}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {recipe.images.length > 0 && (
                <details>
                  <summary>Images ({recipe.images.length})</summary>
                  <ul>
                    {recipe.images.map((m, i) => (
                      <li key={i}>
                        track {m.trackIndex} · z={m.zOrder} ·{" "}
                        <code>{m.mediaPath.split(/[\\/]/).pop()}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>
      )}

      <section className="realtime-preview-playback">
        <h3>Recipe playback (B5)</h3>
        <p className="realtime-preview-hint">
          Plays the active project's recipe via decoder pool + WebGL2
          compositor. No audio yet (B6). Pick a clip + Fetch recipe
          first if the canvas is blank.
        </p>
        <div className="realtime-preview-controls">
          <button type="button" onClick={playRecipe} disabled={!recipe}>
            Play
          </button>
          <button
            type="button"
            onClick={pauseRecipe}
            disabled={!recipe || playbackPaused}
          >
            Pause
          </button>
          <button type="button" onClick={seekRecipeStart} disabled={!recipe}>
            ⏮ Start
          </button>
          <span className="realtime-preview-divider" />
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
            {(playbackTimeUs / 1_000_000).toFixed(2)}s /{" "}
            {((recipe?.durationUs ?? 0) / 1_000_000).toFixed(2)}s
          </span>
          <span style={{ marginLeft: 12 }}>
            decoders: {playbackStats.activeDecoders}
          </span>
        </div>
        <div className="realtime-preview-canvas-wrap">
          <canvas
            ref={playbackCanvasRef}
            className="realtime-preview-canvas"
            width={640}
            height={360}
          />
        </div>
        {playbackStats.errors.length > 0 && (
          <details>
            <summary className="realtime-preview-error">
              Decoder errors ({playbackStats.errors.length})
            </summary>
            <ul>
              {playbackStats.errors.map((e, i) => (
                <li key={i}>
                  <code>{e.layerId.slice(0, 8)}</code>: {e.detail}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="realtime-preview-stats">
        <h3>Stats</h3>
        {status.kind === "idle" && <p>No file open.</p>}
        {status.kind === "probing" && <p>Probing capability…</p>}
        {status.kind === "ready" && (
          <ul>
            <li>
              Codec: <code>{status.clip.codec}</code>
            </li>
            <li>
              Size: {status.clip.width}×{status.clip.height}
            </li>
            <li>
              Duration: {(status.clip.durationUs / 1_000_000).toFixed(2)}s
            </li>
            <li>Frames decoded: {frameCount}</li>
            <li>
              Latest frame PTS: {(latestTimestampUs / 1_000_000).toFixed(3)}s
            </li>
            {lastDecodeLatencyMs !== null && (
              <li>Open → first frame: {lastDecodeLatencyMs.toFixed(1)} ms</li>
            )}
          </ul>
        )}
        {status.kind === "error" && (
          <p className="realtime-preview-error">Error: {status.detail}</p>
        )}
        {decoderErrors.length > 0 && (
          <details>
            <summary>Errors ({decoderErrors.length})</summary>
            <ul>
              {decoderErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
