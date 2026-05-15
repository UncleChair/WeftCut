// Phase B1 — dev-mode WebCodecs decoder smoke test.
//
// Activated by `?previewMode=realtime` in the dev URL. Replaces the
// normal `<PreviewSurface>` so we can prove the WebCodecs substrate
// works on the user's WebView2 before B2's compositor / B3's IR
// emitter / B4's probe assume it does.
//
// What this component proves:
//   1. The mp4box demuxer reads our MP4 files.
//   2. VideoDecoder accepts the codec config box.
//   3. Actual frames decode (not just `isConfigSupported=true`).
//   4. Frames render to a canvas via `drawImage(VideoFrame)`.
//
// What this component DOES NOT yet do (later B-phases):
//   - Compositing multiple layers (B2).
//   - Reading the project's actual timeline (B3 emits the recipe).
//   - Audio sync (B5).
//   - Fallback on decode failure (B6).

import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Mp4Decoder,
  probeWebCodecsCapability,
  type CapabilityReport,
  type ClipInfo,
} from "./decoder";

type Status =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ready"; clip: ClipInfo }
  | { kind: "error"; detail: string };

export function RealtimePreview() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<Mp4Decoder | null>(null);
  /// Latest decoded frame. The component keeps exactly one alive;
  /// when a newer frame arrives, the previous one is closed. RAF
  /// loop draws whichever is current.
  const latestFrameRef = useRef<VideoFrame | null>(null);
  const rafRef = useRef<number | null>(null);

  const [capability, setCapability] = useState<CapabilityReport | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [frameCount, setFrameCount] = useState(0);
  const [latestTimestampUs, setLatestTimestampUs] = useState(0);
  const [lastDecodeLatencyMs, setLastDecodeLatencyMs] = useState<number | null>(null);
  const [decoderErrors, setDecoderErrors] = useState<string[]>([]);

  // One-shot capability probe on mount.
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

  // RAF draw loop: copies the current frame to the canvas at the
  // display refresh rate. drawImage(VideoFrame) is GPU-fast on
  // WebView2 + WKWebView; the bottleneck is the decoder, not the
  // blit.
  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      const frame = latestFrameRef.current;
      if (canvas && frame) {
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(frame, 0, 0);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // Teardown: close the decoder + any lingering frame.
  useEffect(() => {
    return () => {
      void decoderRef.current?.close();
      decoderRef.current = null;
      latestFrameRef.current?.close();
      latestFrameRef.current = null;
    };
  }, []);

  const openFile = useCallback(async () => {
    const picked = await openDialog({
      title: "Pick a clip for the WebCodecs smoke test",
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "m4v", "mov"] }],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;

    // Drop any previous decoder + frame before kicking off a new one.
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
      onReady: (clip) => {
        setStatus({ kind: "ready", clip });
      },
      onFrame: ({ frame, timestampUs }) => {
        if (firstFrameAt === null) {
          firstFrameAt = performance.now();
          setLastDecodeLatencyMs(firstFrameAt - openedAt);
        }
        // Latest-frame-wins: close the previous, keep the new.
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

  const closeFile = useCallback(async () => {
    await decoderRef.current?.close();
    decoderRef.current = null;
    latestFrameRef.current?.close();
    latestFrameRef.current = null;
    setStatus({ kind: "idle" });
  }, []);

  return (
    <div className="realtime-preview-smoke">
      <header className="realtime-preview-header">
        <strong>B1 — WebCodecs decoder smoke</strong>
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
            {capability.detail && <li>{capability.detail}</li>}
          </ul>
        )}
      </section>

      <section className="realtime-preview-controls">
        <button type="button" onClick={openFile}>
          Pick clip…
        </button>
        <button
          type="button"
          onClick={closeFile}
          disabled={status.kind !== "ready"}
        >
          Close
        </button>
      </section>

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
            <li>Codec: <code>{status.clip.codec}</code></li>
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
              <li>
                Open → first frame: {lastDecodeLatencyMs.toFixed(1)} ms
              </li>
            )}
          </ul>
        )}
        {status.kind === "error" && (
          <p className="realtime-preview-error">Error: {status.detail}</p>
        )}
        {decoderErrors.length > 0 && (
          <details>
            <summary>Decoder errors ({decoderErrors.length})</summary>
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
