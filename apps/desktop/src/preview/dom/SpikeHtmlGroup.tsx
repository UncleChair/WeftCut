/// Phase H.0 spike — single-pixel transparency probe through both
/// composition mount surfaces (preview = `<div>` + outer Shadow DOM;
/// export = full root document in the offscreen raster webview). Decision
/// 12 (`docs/html-render-groups.md`) requires this to pass before any
/// further html-render-groups work lands.
///
/// Reachable via URL hash `#html-group-spike`; mounted from main.tsx
/// outside the normal app tree so it runs with or without an open
/// project. Removed at Phase H closure.
///
/// Validates, in order:
///   1. Preview mount: shadow-DOM with `background: transparent` lets
///      the host page's backdrop show through the probe rect's 50%
///      alpha. Three backdrops side by side (checker / white / black)
///      let the eye verify the blend math without needing a JS-level
///      pixel-read of composited DOM (which the platform doesn't
///      expose).
///   2. Export mount: the Tauri command `html_group_probe_transparency`
///      drives the offscreen raster webview through the same probe
///      document, captures a PNG, and returns the bytes. The TS side
///      decodes the PNG into a 1×1 canvas read at the center pixel and
///      asserts vs. PROBE_TARGET ± PROBE_TOLERANCE per channel.
///
/// If either surface fails: stop. The iframe-transparency arc has
/// re-opened on a new surface and the fix needs to land before Phase
/// H.1 onward.

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import {
  PROBE_CANVAS_H,
  PROBE_CANVAS_W,
  PROBE_TARGET,
  PROBE_TOLERANCE,
  buildComposition,
  buildProbeHtml,
  checkProbePixel,
} from "./composition/CompositionGenerator";
import { ENGINE_SOURCE, type CompositionState } from "./composition/engine";
import { htmlGroupProbeTransparency, type HtmlGroupProbeResult } from "../../ipc";

/// Mount the probe composition inside a `<div>` + outer Shadow DOM. Returns
/// nothing — the consumer just needs the host div to be in the React tree.
function useProbeShadow(hostRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (host.shadowRoot) {
      // Strict-mode double-effect — bail; shadow already attached.
      return;
    }
    const shadow = host.attachShadow({ mode: "open" });
    const { shadow: shadowHtml } = buildProbeHtml();
    shadow.innerHTML = shadowHtml;
  }, [hostRef]);
}

/// Decode the captured PNG into a 1×1 canvas read at the center pixel.
/// Returns the RGBA values plus a pass/fail vs. PROBE_TARGET per channel.
async function readCenterPixel(
  pngBase64: string,
): Promise<{ r: number; g: number; b: number; a: number; diagnostic: string | null }> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngBase64}`;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("probe PNG failed to decode"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  // willReadFrequently isn't strictly necessary for one read, but it
  // bypasses the lazy GPU-backed buffer path and keeps the readback
  // deterministic across drivers.
  ctx.drawImage(img, 0, 0);
  const cx = Math.floor(img.naturalWidth / 2);
  const cy = Math.floor(img.naturalHeight / 2);
  const data = ctx.getImageData(cx, cy, 1, 1).data;
  if (data.length < 4) {
    throw new Error(`getImageData returned ${data.length} bytes; expected ≥4`);
  }
  const pixel = { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
  return { ...pixel, diagnostic: checkProbePixel(pixel) };
}

interface ExportProbeState {
  status: "idle" | "running" | "ok" | "failed";
  result: HtmlGroupProbeResult | null;
  centerPixel: { r: number; g: number; b: number; a: number } | null;
  diagnostic: string | null;
  error: string | null;
}

export function SpikeHtmlGroup() {
  const checkerRef = useRef<HTMLDivElement | null>(null);
  const whiteRef = useRef<HTMLDivElement | null>(null);
  const blackRef = useRef<HTMLDivElement | null>(null);

  useProbeShadow(checkerRef);
  useProbeShadow(whiteRef);
  useProbeShadow(blackRef);

  const [exportProbe, setExportProbe] = useState<ExportProbeState>({
    status: "idle",
    result: null,
    centerPixel: null,
    diagnostic: null,
    error: null,
  });

  const runExportProbe = async () => {
    setExportProbe({
      status: "running",
      result: null,
      centerPixel: null,
      diagnostic: null,
      error: null,
    });
    try {
      const result = await htmlGroupProbeTransparency();
      const pixel = await readCenterPixel(result.pngBase64);
      setExportProbe({
        status: pixel.diagnostic === null ? "ok" : "failed",
        result,
        centerPixel: { r: pixel.r, g: pixel.g, b: pixel.b, a: pixel.a },
        diagnostic: pixel.diagnostic,
        error: null,
      });
    } catch (e) {
      setExportProbe({
        status: "failed",
        result: null,
        centerPixel: null,
        diagnostic: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Run the export probe automatically on first mount so the page is
  // useful at a glance. Manual re-run via the button covers
  // post-edit checks.
  useEffect(() => {
    void runExportProbe();
  }, []);

  return (
    <div style={{ padding: 24, color: "#ddd", background: "#111", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginTop: 0 }}>HTML render groups — Phase H.0 transparency probe</h1>
      <p style={{ color: "#aaa", maxWidth: 720 }}>
        Both mount surfaces are tested below. Both must report green
        before Phase H.1 onward lands. If either turns red, the
        iframe-transparency-bug arc has re-opened on a new surface and
        the fix has to ship first.
      </p>

      <h2>Preview mount — `&lt;div&gt;` + outer Shadow DOM</h2>
      <p style={{ color: "#aaa", maxWidth: 720 }}>
        The probe is a {PROBE_CANVAS_W}×{PROBE_CANVAS_H} composition with
        a centered 400×100 div at <code>background: rgba(255, 0, 0, 0.5)</code>.
        Visual check: each backdrop should blend with the probe rect
        according to the expected alpha math. If all three look the same
        (pure red on white), the host page is leaking an opaque white
        backdrop into the shadow and transparency is broken.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(3, ${PROBE_CANVAS_W}px)`, gap: 16, marginTop: 12 }}>
        <ProbeBackdrop hostRef={checkerRef} label="Checker (alpha visible as squares)" backgroundColor="#888" backgroundImage={checkerBg()} />
        <ProbeBackdrop hostRef={whiteRef} label="White backdrop → expect pink at center" backgroundColor="#ffffff" />
        <ProbeBackdrop hostRef={blackRef} label="Black backdrop → expect dark red at center" backgroundColor="#000000" />
      </div>

      <h2 style={{ marginTop: 32 }}>Export mount — offscreen raster webview, full root document</h2>
      <p style={{ color: "#aaa", maxWidth: 720 }}>
        The Tauri command <code>html_group_probe_transparency</code>{" "}
        navigates the long-lived <code>raster-worker</code> webview to the
        same probe content (wrapped as a full HTML document), captures via
        WebView2 <code>CapturePreview</code>, and returns the PNG bytes.
        We decode them, read the center pixel, and compare to <code>{JSON.stringify(PROBE_TARGET)}</code> ± {PROBE_TOLERANCE} per channel.
      </p>
      <button
        type="button"
        onClick={() => void runExportProbe()}
        disabled={exportProbe.status === "running"}
        style={{
          padding: "6px 14px",
          background: "#234",
          color: "#eee",
          border: "1px solid #456",
          borderRadius: 4,
          cursor: exportProbe.status === "running" ? "wait" : "pointer",
          marginBottom: 12,
        }}
      >
        {exportProbe.status === "running" ? "Capturing…" : "Re-run export probe"}
      </button>

      <ExportProbeView state={exportProbe} />

      <CompositionSmokeTest />
    </div>
  );
}

// ============================================================
// Composition smoke test (H.3)
// ============================================================

/// Fixture composition for the smoke test — exercises both basic layer
/// kinds shipped in H.3 (Color background + Text overlay) and the
/// engine's time-gating (Text shows only during [1s, 2s]).
function fixtureCompositionState(): CompositionState {
  return {
    width: 640,
    height: 180,
    layers: [
      {
        id: "L-bg",
        z: 0,
        t_start_us: 0,
        t_end_us: 3_000_000,
        opacity: 1,
        x: 0,
        y: 0,
        scale_x: 1,
        scale_y: 1,
        params: {
          kind: "Color",
          rgba: { r: 30, g: 64, b: 120, a: 255 },
          width: 640,
          height: 180,
        },
      },
      {
        id: "L-title",
        z: 1,
        t_start_us: 1_000_000,
        t_end_us: 2_000_000,
        opacity: 1,
        x: 40,
        y: 60,
        scale_x: 1,
        scale_y: 1,
        params: {
          kind: "Text",
          content: "Hello WeftCut — visible only between 1s and 2s",
          font_family: "system-ui, sans-serif",
          font_size_px: 28,
          color: { r: 255, g: 255, b: 255, a: 255 },
        },
      },
    ],
  };
}

interface CompositionRuntime {
  setTime: (tSeconds: number) => void;
}

/// Mount a composition inside a fresh shadow root with a per-instance
/// engine execution context. This prefigures the H.4 mount strategy:
/// `new Function(document, window, ...)` with the host shadow root
/// shadowed as `document` and a Proxy `window` so the engine's writes
/// to `window.__setTime` land on per-instance state instead of the
/// real `window`. Without per-instance shadowing, multiple compositions
/// on one page would overwrite each other's `__setTime` global.
function mountComposition(
  host: HTMLDivElement,
  state: CompositionState,
): CompositionRuntime | null {
  if (host.shadowRoot) {
    // Strict-mode double-effect — bail; shadow already attached.
    return null;
  }
  const shadow = host.attachShadow({ mode: "open" });
  const artifact = buildComposition(state);
  shadow.innerHTML = artifact.shadow;

  // The state-blob `<script type="application/json">` survives
  // innerHTML; the engine `<script>` does NOT execute via innerHTML in
  // any browser (HTML5 spec). Remove the inert engine script and run
  // it explicitly via `new Function` with shadowed globals.
  const engineScripts = Array.from(shadow.querySelectorAll('script:not([type="application/json"])'));
  engineScripts.forEach((s) => s.remove());

  // Per-instance window proxy: local properties win, everything else
  // falls through to the real window. The engine's writes to
  // `__setTime` / `__seek` / `__weftcutCompositionReady` land here.
  const localWindow: Record<string | symbol, unknown> = {};
  const winProxy = new Proxy(localWindow, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (window as unknown as Record<string | symbol, unknown>)[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      return prop in target || prop in window;
    },
  });

  try {
    // Shadow root acts as `document` so the engine's
    // `getElementById(STATE_SCRIPT_ID)` finds the embedded state blob,
    // and its querySelectorAll for layer hosts walks the shadow tree.
    // `requestAnimationFrame` needs to be the real one — pull from the
    // host window. `console` falls through the proxy too.
    const fn = new Function("document", "window", "requestAnimationFrame", ENGINE_SOURCE);
    fn(shadow, winProxy, window.requestAnimationFrame.bind(window));
  } catch (e) {
    console.error("SpikeHtmlGroup: composition engine execution failed", e);
    return null;
  }

  const setTime = (winProxy as { __setTime?: (t: number) => void }).__setTime;
  if (typeof setTime !== "function") {
    console.error("SpikeHtmlGroup: engine did not register __setTime");
    return null;
  }
  return { setTime: (t: number) => setTime(t) };
}

function CompositionSmokeTest() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<CompositionRuntime | null>(null);
  const [tSeconds, setTSeconds] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const runtime = mountComposition(host, fixtureCompositionState());
    if (!runtime) return;
    runtimeRef.current = runtime;
    runtime.setTime(0);
    setMounted(true);
  }, []);

  useEffect(() => {
    runtimeRef.current?.setTime(tSeconds);
  }, [tSeconds]);

  return (
    <div style={{ marginTop: 32 }}>
      <h2>Composition generator — H.3 smoke test</h2>
      <p style={{ color: "#aaa", maxWidth: 720 }}>
        Generates a 640×180 composition with two layers (blue Color
        background + a Text overlay visible only between 1s and 2s) and
        mounts it inside a shadow root with a per-instance engine. Drag
        the slider — the text should appear at t=1.0 and disappear at
        t=2.0. If time-gating works, H.3's engine logic is sound.
      </p>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginTop: 12 }}>
        <figure style={{ margin: 0 }}>
          <div
            ref={hostRef}
            style={{
              width: 640,
              height: 180,
              outline: "1px solid #444",
              backgroundImage: checkerBg(),
              backgroundColor: "#888",
              backgroundSize: "20px 20px",
            }}
          />
          <figcaption style={{ color: "#aaa", marginTop: 6, fontSize: 13 }}>
            Composition mount (over checker so transparent regions show through)
          </figcaption>
        </figure>
        <div style={{ minWidth: 280 }}>
          <label style={{ display: "block", color: "#aaa", fontSize: 13, marginBottom: 6 }}>
            t = {tSeconds.toFixed(2)} s
          </label>
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={tSeconds}
            onChange={(e) => setTSeconds(Number(e.target.value))}
            style={{ width: 280 }}
            disabled={!mounted}
          />
          <div style={{ color: "#888", fontSize: 12, marginTop: 8, fontFamily: "monospace" }}>
            Layer 0 (blue Color): visible [0, 3]<br />
            Layer 1 (white Text): visible [1, 2]
          </div>
          <div style={{ color: mounted ? "#4f4" : "#f55", fontSize: 13, marginTop: 8 }}>
            engine: {mounted ? "mounted" : "not mounted"}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportProbeView({ state }: { state: ExportProbeState }) {
  if (state.status === "idle") {
    return <div style={{ color: "#888" }}>Idle.</div>;
  }
  if (state.status === "running") {
    return <div style={{ color: "#aaa" }}>Capturing via offscreen webview…</div>;
  }
  if (state.error) {
    return <div style={{ color: "#f55" }}>error: {state.error}</div>;
  }
  const { result, centerPixel, diagnostic } = state;
  if (!result || !centerPixel) {
    return <div style={{ color: "#f55" }}>missing result payload</div>;
  }
  const ok = diagnostic === null;
  return (
    <div>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <figure style={{ margin: 0 }}>
          <img
            src={`data:image/png;base64,${result.pngBase64}`}
            alt="captured probe"
            style={{ outline: "1px solid #444", backgroundImage: checkerBg(), backgroundSize: "20px 20px", backgroundColor: "#888" }}
          />
          <figcaption style={{ color: "#aaa", marginTop: 6, fontSize: 13 }}>
            Captured PNG over a host-page checker backdrop (visual)
          </figcaption>
        </figure>
        <div style={{ minWidth: 280 }}>
          <h3 style={{ margin: "0 0 8px 0" }}>
            <span style={{ color: ok ? "#4f4" : "#f55" }}>
              {ok ? "PASS" : "FAIL"}
            </span>
          </h3>
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {(["r", "g", "b", "a"] as const).map((ch) => {
                const got = centerPixel[ch];
                const want = PROBE_TARGET[ch];
                const drift = Math.abs(got - want);
                const channelOk = drift <= PROBE_TOLERANCE;
                return (
                  <tr key={ch}>
                    <td style={{ padding: "4px 12px 4px 0", color: "#aaa" }}>{ch}</td>
                    <td style={{ padding: "4px 12px 4px 0", color: channelOk ? "#4f4" : "#f55", fontFamily: "monospace" }}>
                      {got}
                    </td>
                    <td style={{ padding: "4px 12px 4px 0", color: "#888", fontFamily: "monospace" }}>
                      want {want}±{PROBE_TOLERANCE}
                    </td>
                    <td style={{ padding: "4px 0", color: "#888", fontFamily: "monospace" }}>
                      Δ {drift}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {diagnostic && (
            <div style={{ color: "#f55", marginTop: 8, fontFamily: "monospace", fontSize: 13 }}>
              {diagnostic}
            </div>
          )}
          <div style={{ color: "#888", marginTop: 8, fontSize: 12 }}>
            Capture size: {result.width}×{result.height}
          </div>
        </div>
      </div>
    </div>
  );
}

/// Conic / repeating-conic-gradient gives the canonical Photoshop-style
/// transparency checker without bundling an image asset.
function checkerBg(): string {
  return `repeating-conic-gradient(#666 0% 25%, #999 25% 50%)`;
}

interface ProbeBackdropProps {
  hostRef: RefObject<HTMLDivElement | null>;
  label: string;
  backgroundColor: string;
  backgroundImage?: string;
}

function ProbeBackdrop({ hostRef, label, backgroundColor, backgroundImage }: ProbeBackdropProps) {
  const style: CSSProperties = {
    width: PROBE_CANVAS_W,
    height: PROBE_CANVAS_H,
    backgroundColor,
    backgroundSize: "20px 20px",
    outline: "1px solid #444",
  };
  if (backgroundImage !== undefined) {
    style.backgroundImage = backgroundImage;
  }
  return (
    <figure style={{ margin: 0 }}>
      <div ref={hostRef} style={style} />
      <figcaption style={{ color: "#aaa", marginTop: 6, fontSize: 13 }}>{label}</figcaption>
    </figure>
  );
}
