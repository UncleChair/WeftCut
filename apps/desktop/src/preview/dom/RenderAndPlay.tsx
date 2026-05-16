/// Phase E — Render & Play escape hatch.
///
/// The WYSIWYG verification path when CSS-rendered preview diverges
/// from ffmpeg-rendered export (`docs/preview-dom.md` Q1 fidelity
/// contract). On click: ship the current project through the export
/// pipeline silently into a temp MP4, then swap the preview surface
/// for a `<video>` element playing it. "Return" disposes the file
/// and restores the live DOM compositor.
///
/// Lives as an overlay on the preview surface. Idle = a small
/// button in the top-right corner; pointer-events on the rest of
/// the canvas pass through to the layers. Active states (rendering,
/// playing, error) take over the whole canvas.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cleanupTempPreview, exportToTempPreview } from "../../ipc";

type State =
  | { kind: "idle" }
  | { kind: "rendering" }
  | { kind: "ready"; path: string; src: string }
  | { kind: "error"; detail: string };

interface Props {
  /// Called when the overlay's active-state changes, so the parent
  /// can hide the live compositor while a rendered preview plays
  /// (avoids double audio playback + GPU contention).
  onActiveChange?: (active: boolean) => void;
}

export function RenderAndPlay({ onActiveChange }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: "idle" });
  /// Active = anything other than idle. Parent uses this to gate
  /// the live LiveLayers tree.
  const active = state.kind !== "idle";

  // Notify parent on active-state changes. Wrapped in effect so we
  // don't re-call during render.
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Cleanup any in-flight temp file on unmount.
  const lastPathRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      const p = lastPathRef.current;
      if (p) {
        void cleanupTempPreview(p).catch(() => {});
        lastPathRef.current = null;
      }
    };
  }, []);

  const startRender = useCallback(async () => {
    setState({ kind: "rendering" });
    try {
      const path = await exportToTempPreview();
      lastPathRef.current = path;
      setState({ kind: "ready", path, src: convertFileSrc(path) });
    } catch (e) {
      setState({ kind: "error", detail: String(e) });
    }
  }, []);

  const returnToLive = useCallback(async () => {
    const p = lastPathRef.current;
    lastPathRef.current = null;
    setState({ kind: "idle" });
    if (p) {
      try {
        await cleanupTempPreview(p);
      } catch {
        // Non-fatal — OS will sweep temp dir eventually.
      }
    }
  }, []);

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        onClick={startRender}
        title={t("preview.render_play_hint", "Render the project to MP4 and play it — verify the final pixels.")}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          padding: "6px 12px",
          background: "rgba(20, 20, 20, 0.85)",
          color: "#eee",
          border: "1px solid rgba(255, 255, 255, 0.18)",
          borderRadius: 4,
          fontSize: 12,
          cursor: "pointer",
          pointerEvents: "auto",
          backdropFilter: "blur(4px)",
          zIndex: 10,
        }}
      >
        {t("preview.render_play", "Render & Play")}
      </button>
    );
  }

  if (state.kind === "rendering") {
    return (
      <div style={overlayStyle}>
        <div style={panelStyle}>
          <span className="preview-spinner" aria-hidden="true" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 14, marginBottom: 4 }}>
            {t("preview.rendering_export", "Rendering export-quality preview…")}
          </div>
          <div style={{ fontSize: 11, color: "#888" }}>
            {t("preview.rendering_hint", "This runs the full ffmpeg pipeline; expect ~0.5–2× realtime.")}
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "ready") {
    return (
      <div style={overlayStyle}>
        <video
          src={state.src}
          autoPlay
          controls
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            background: "#000",
            objectFit: "contain",
            pointerEvents: "auto",
          }}
        />
        <button
          type="button"
          onClick={returnToLive}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            padding: "6px 12px",
            background: "rgba(20, 20, 20, 0.85)",
            color: "#eee",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            borderRadius: 4,
            fontSize: 12,
            cursor: "pointer",
            pointerEvents: "auto",
            zIndex: 11,
          }}
        >
          {t("preview.return_to_live", "← Return to live preview")}
        </button>
      </div>
    );
  }

  // error
  return (
    <div style={overlayStyle}>
      <div style={{ ...panelStyle, pointerEvents: "auto" }}>
        <div style={{ fontSize: 14, marginBottom: 8, color: "#e88" }}>
          {t("preview.render_failed", "Render failed")}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#aaa",
            fontFamily: "monospace",
            maxWidth: 500,
            wordBreak: "break-word",
            marginBottom: 12,
          }}
        >
          {state.detail}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={startRender} style={buttonStyle}>
            {t("preview.retry", "Retry")}
          </button>
          <button type="button" onClick={returnToLive} style={buttonStyle}>
            {t("preview.dismiss", "Dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(0, 0, 0, 0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10,
  pointerEvents: "none",
};

const panelStyle: React.CSSProperties = {
  background: "rgba(28, 28, 28, 0.95)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 6,
  padding: "20px 28px",
  color: "#eee",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  pointerEvents: "auto",
};

const buttonStyle: React.CSSProperties = {
  padding: "5px 10px",
  background: "#333",
  color: "#eee",
  border: "1px solid #555",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
};

