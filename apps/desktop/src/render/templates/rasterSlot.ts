// The DOM half of the rasterizer pool: a sandboxed iframe that turns an SVG
// string into a transferred ImageBitmap, plus the process-global pool singleton.
// Feasibility (untainted raster + cross-boundary transfer + pixel-parity) was
// verified in real WebView2; see the spec. Main-thread only — the export Worker
// has no `document`, so `getRasterPool()` returns null there and callers fall
// back to the inline rasterizer.
import { RasterPool, type RasterSlot } from "./rasterPool";

const READY_TIMEOUT_MS = 5000;
const RASTER_TIMEOUT_MS = 5000;

// Inline script injected into each rasterizer iframe. Plain, dependency-free JS.
// Protocol: parent -> iframe { type:"raster", id, svg }; iframe -> parent
// { type:"rastered", id, bitmap } (transferred) or { type:"rastered", id, error }.
// BUILD HAZARD: this is a single template literal — do NOT put a backtick or a
// dollar-brace sequence in the body (same lesson as HARNESS_FRAME / ENGINE_SOURCE).
export const RASTER_FRAME = `
(function () {
  function handle(ev) {
    var d = ev.data;
    if (!d || d.type !== "raster") return;
    var id = d.id;
    var url = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
    var img = new Image();
    img.onload = function () {
      createImageBitmap(img).then(function (b) {
        parent.postMessage({ type: "rastered", id: id, bitmap: b }, "*", [b]);
      }).catch(function (e) {
        parent.postMessage({ type: "rastered", id: id, error: String(e) }, "*");
      }).finally(function () { URL.revokeObjectURL(url); });
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      parent.postMessage({ type: "rastered", id: id, error: "raster: img failed to load SVG" }, "*");
    };
    img.src = url;
  }
  window.addEventListener("message", handle);
  parent.postMessage({ type: "ready" }, "*");
})();
`;

interface PendingRaster {
  resolve: (b: ImageBitmap) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/// Create one iframe-backed rasterizer slot. The iframe is sandboxed
/// (`allow-scripts`, no `allow-same-origin`) and offscreen; it rasterizes its
/// own blob-loaded SVG to an ImageBitmap (untainted) and transfers it back.
export function createIframeRasterSlot(): RasterSlot {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = "template-raster-slot";
  iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0";
  document.body.appendChild(iframe);

  let disposed = false;
  let nextId = 1;
  const pending = new Map<number, PendingRaster>();

  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  const readyTimer = setTimeout(() => {
    if (readyReject) readyReject(new Error("rasterSlot: iframe never readied"));
    readyResolve = null;
    readyReject = null;
  }, READY_TIMEOUT_MS);

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== iframe.contentWindow) return;
    const d = ev.data as { type?: string; id?: number; bitmap?: ImageBitmap; error?: string } | null;
    if (!d || typeof d.type !== "string") return;
    if (d.type === "ready") {
      clearTimeout(readyTimer);
      const r = readyResolve;
      readyResolve = null;
      readyReject = null;
      if (r) r();
      return;
    }
    if (d.type === "rastered" && typeof d.id === "number") {
      const entry = pending.get(d.id);
      if (!entry) return;
      pending.delete(d.id);
      clearTimeout(entry.timer);
      if (typeof d.error === "string") entry.reject(new Error("rasterSlot: " + d.error));
      else if (d.bitmap) entry.resolve(d.bitmap);
      else entry.reject(new Error("rasterSlot: reply had no bitmap"));
    }
  };
  window.addEventListener("message", onMessage);
  iframe.srcdoc =
    "<!doctype html><html><body><scr" + "ipt>" + RASTER_FRAME + "</scr" + "ipt></body></html>";

  return {
    async rasterize(svg: string): Promise<ImageBitmap> {
      if (disposed) throw new Error("rasterSlot: disposed");
      await ready; // rejects on ready-timeout/dispose → pool recycles + caller falls back
      const win = iframe.contentWindow;
      if (!win) throw new Error("rasterSlot: no contentWindow");
      const id = nextId++;
      return new Promise<ImageBitmap>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("rasterSlot: raster timed out"));
        }, RASTER_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        win.postMessage({ type: "raster", id, svg }, "*");
      });
    },
    dispose(): void {
      disposed = true;
      clearTimeout(readyTimer);
      if (readyReject) {
        readyReject(new Error("rasterSlot: disposed"));
        readyResolve = null;
        readyReject = null;
      }
      for (const e of pending.values()) {
        clearTimeout(e.timer);
        e.reject(new Error("rasterSlot: disposed"));
      }
      pending.clear();
      window.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}

/// Pool size: leave the main thread + a render-harness core headroom, cap at 4
/// (POC: 4 iframes give ~1.75x — sublinear past that).
const RASTER_POOL_SIZE = (() => {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(4, cores - 2));
})();

let poolSingleton: RasterPool | null = null;
let poolInitTried = false;

/// The process-wide rasterizer pool, or null when there is no DOM (export
/// Worker) — callers fall back to the inline main-thread rasterizer. Lazily
/// constructed; slots (iframes) are created on first raster, not here.
export function getRasterPool(): RasterPool | null {
  if (typeof document === "undefined") return null;
  if (!poolInitTried) {
    poolInitTried = true;
    poolSingleton = new RasterPool({
      size: RASTER_POOL_SIZE,
      createSlot: createIframeRasterSlot,
    });
  }
  return poolSingleton;
}
