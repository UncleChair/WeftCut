// Full-window pick overlay + magnifier. ALL hover-rate work is imperative DOM
// through refs — pointer-move-rate React state is banned (playhead-gate
// discipline); the only React state is the store's session presence.
// Spec: docs/features.md#color-picker-eyedropper

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { sampleHex, samplePatch, type FrameBuffer } from "./pixel";
import { getPreviewSampler } from "./previewSamplerRegistry";
import { usePickSessionStore, type PickSession } from "./pickColor";
import { eyeDropperAvailable, screenPick } from "./screenPick";

const MAG_RADIUS = 5; // 11×11 source patch
const MAG_SCALE = 10; // → 110×110 magnifier canvas

const MAGNIFIER_STYLE: CSSProperties = {
  position: "fixed",
  left: 0,
  top: 0,
  visibility: "hidden",
  pointerEvents: "none",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
};

const HINT_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  font: "12px system-ui",
  color: "#e5e7eb",
  background: "rgba(0,0,0,0.7)",
  padding: "4px 10px",
  borderRadius: 4,
  pointerEvents: "none",
};

export function PickOverlayHost() {
  const session = usePickSessionStore((s) => s.session);
  if (!session) return null;
  return <PickOverlay session={session} />;
}

interface Hit {
  hex: string;
  source: "composition" | "ui";
  patchBuf: FrameBuffer;
  px: number;
  py: number;
}

function PickOverlay({ session }: { session: PickSession }) {
  const { t } = useTranslation();
  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hexRef = useRef<HTMLSpanElement | null>(null);
  const raf = useRef<number | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  const sampleAt = (x: number, y: number): Hit | null => {
    const sampler = getPreviewSampler();
    if (session.comp && sampler) {
      const rect = sampler.canvasRect();
      if (rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
        const m = sampler.mapClientToComposition(x, y);
        if (m) {
          return {
            hex: sampleHex(session.comp, m.x, m.y),
            source: "composition",
            patchBuf: session.comp,
            px: m.x,
            py: m.y,
          };
        }
        // Letterbox bars inside the canvas element are painted chrome, not
        // composition content — fall through to the window snapshot.
      }
    }
    if (session.snap) {
      const buf: FrameBuffer = {
        pixels: session.snap.data.data,
        width: session.snap.data.width,
        height: session.snap.data.height,
      };
      const sx = Math.floor(x * session.snap.scaleX);
      const sy = Math.floor(y * session.snap.scaleY);
      return { hex: sampleHex(buf, sx, sy), source: "ui", patchBuf: buf, px: sx, py: sy };
    }
    return null;
  };

  const update = () => {
    raf.current = null;
    const p = last.current;
    if (!p) return;
    const hit = sampleAt(p.x, p.y);
    const mag = magRef.current;
    if (mag) {
      mag.style.transform = `translate(${p.x + 16}px, ${p.y + 16}px)`;
      mag.style.visibility = hit ? "visible" : "hidden";
    }
    if (!hit) return;
    if (hexRef.current) hexRef.current.textContent = hit.hex;
    const canvas = magCanvasRef.current;
    const ctx = canvas?.getContext("2d"); // jsdom: null — magnifier draw is best-effort
    if (canvas && ctx) {
      const patch = samplePatch(hit.patchBuf, hit.px, hit.py, MAG_RADIUS);
      const img = new ImageData(new Uint8ClampedArray(patch.pixels), patch.width, patch.height);
      // putImageData can't scale: stage 1:1, then blit with smoothing off.
      const stage = document.createElement("canvas");
      stage.width = patch.width;
      stage.height = patch.height;
      const sctx = stage.getContext("2d");
      if (sctx) {
        sctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(stage, 0, 0, canvas.width, canvas.height);
      }
    }
    session.opts.onHover?.(hit.hex);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    last.current = { x: e.clientX, y: e.clientY };
    if (raf.current === null) raf.current = requestAnimationFrame(update);
  };

  const onClick = (e: React.MouseEvent) => {
    const hit = sampleAt(e.clientX, e.clientY);
    if (hit) session.settle({ hex: hit.hex, source: hit.source });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        session.settle(null);
      } else if (
        (e.key === "s" || e.key === "S") &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        eyeDropperAvailable()
      ) {
        e.preventDefault();
        // Native handoff: drop the overlay FIRST (the session object keeps the
        // promise open), then settle from the native result. keydown carries
        // the transient activation EyeDropper.open() requires.
        usePickSessionStore.setState({ session: null });
        void screenPick().then((hex) =>
          session.settle(hex ? { hex, source: "screen" } : null),
        );
      }
    };
    const onBlur = () => session.settle(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [session]);

  return (
    <div
      data-testid="colorpick-overlay"
      onPointerMove={onPointerMove}
      onClick={onClick}
      style={{ position: "fixed", inset: 0, zIndex: 1000, cursor: "crosshair" }}
    >
      <div
        ref={magRef}
        style={MAGNIFIER_STYLE}
      >
        <canvas
          ref={magCanvasRef}
          width={(MAG_RADIUS * 2 + 1) * MAG_SCALE}
          height={(MAG_RADIUS * 2 + 1) * MAG_SCALE}
          style={{ border: "2px solid var(--border)", borderRadius: 6, background: "#000" }}
        />
        <span
          ref={hexRef}
          style={{
            font: "12px ui-monospace, monospace",
            color: "#e5e7eb",
            background: "rgba(0,0,0,0.7)",
            padding: "1px 6px",
            borderRadius: 3,
          }}
        />
      </div>
      <div
        style={HINT_STYLE}
      >
        {t("colorpick.hint_cancel")}
        {eyeDropperAvailable() ? ` · ${t("colorpick.hint_screen")}` : ""}
      </div>
    </div>
  );
}
