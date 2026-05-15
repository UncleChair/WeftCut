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
  Mp4Decoder,
  probeWebCodecsCapability,
  type CapabilityReport,
  type ClipInfo,
} from "./decoder";
import {
  WebGL2Compositor,
  type BlendMode,
  type CompositorLayer,
} from "./compositor";

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

  const [capability, setCapability] = useState<CapabilityReport | null>(null);
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

  // One-shot capability probe.
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "probing" });
    void probeWebCodecsCapability().then((report) => {
      if (cancelled) return;
      setCapability(report);
      setStatus({ kind: "idle" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
              <strong>
                {capability.h264Supported === null
                  ? "n/a"
                  : capability.h264Supported
                    ? "supported"
                    : "NOT supported"}
              </strong>
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
