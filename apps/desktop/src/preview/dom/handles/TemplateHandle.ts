/// Phase C — Template layer handle. Renders the template's HTML live
/// in a same-origin `<iframe srcdoc>` and drives its animation clock
/// from the PlaybackEngine's master clock via a synchronous
/// `__setTime(t)` hook in the preview shim.
///
/// Architecture (`docs/preview-dom.md` Q5):
///   - One iframe per Template layer instance. Mounts once; survives
///     param edits other than `template_id`.
///   - Sandbox `allow-scripts allow-same-origin` — scripts run, parent
///     can reach `iframe.contentWindow` for `__setTime` / `__props__`
///     updates. First-party templates only; no untrusted content.
///   - Preview shim is **distinct from raster** (`raster/time_mock.js`).
///     Raster's shim awaits `fonts.ready` + one real rAF per seek for
///     deterministic capture; preview wants synchronous, no-await
///     `__setTime` so it can run at 60 Hz without per-frame waits.
///     Both override the same primitives (`performance.now`,
///     `Date.now`, `requestAnimationFrame`) so existing template
///     animation code (`t = performance.now() / 1000` + rAF) works
///     unchanged in both contexts.
///   - Templates' `start()` polls `window.__props__` once, then
///     animates. Live param edits update `contentWindow.__props__`
///     but existing templates don't re-read; only static state at
///     first start. Future template refactor (`__onPropsUpdated`)
///     would close this gap.

import { listTemplates, type TemplateSummary } from "../../../ipc";
import { useProjectStore } from "../../../state/projectStore";
import type { HandleContext, LayerHandle } from "./types";

/// Cached across all TemplateHandle instances — `listTemplates()` is
/// pure-read on the Rust side and the list is stable for the app
/// session.
let templatesCache: Promise<TemplateSummary[]> | null = null;
function loadTemplates(): Promise<TemplateSummary[]> {
  if (!templatesCache) {
    templatesCache = listTemplates().catch((e) => {
      // Reset so a transient failure (e.g. cold-start race) is
      // retryable from the next handle.
      templatesCache = null;
      throw e;
    });
  }
  return templatesCache;
}

/// Preview-side time-mock shim. Injected as the FIRST script inside
/// the iframe so it overrides primitives before the template's own
/// script runs.
///
/// Differences from `raster/time_mock.js`:
///   - `__setTime(t)` is synchronous (no fonts/rAF awaits).
///   - `__seek_dispatch` and `__seek_status` are still defined so
///     templates that call them explicitly (rare) don't break.
///
/// Kept inline rather than imported from src-tauri/ because Vite's
/// import resolution treats paths outside `apps/desktop/src/` as
/// fragile; the alternative is a duplicated copy in `src/` or a
/// Tauri IPC fetch, both more friction than ~40 lines of inline JS.
const PREVIEW_SHIM = `
(function () {
  if (window.__setTime) return; // double-install guard
  let __t = 0;
  const rafCallbacks = new Set();
  const _origRAF = window.requestAnimationFrame.bind(window);

  try {
    Object.defineProperty(window.performance, "now", {
      configurable: true,
      value: () => __t * 1000,
    });
  } catch (_) {
    window.performance.now = () => __t * 1000;
  }
  window.Date.now = () => __t * 1000;

  window.requestAnimationFrame = (cb) => {
    rafCallbacks.add(cb);
    return 0;
  };
  window.cancelAnimationFrame = (id) => { void id; };

  function pinWebAnimations() {
    if (typeof document.getAnimations !== "function") return;
    const ms = __t * 1000;
    for (const a of document.getAnimations()) {
      try {
        a.pause();
        a.currentTime = ms;
      } catch (_) {}
    }
  }

  window.__setTime = function (seconds) {
    __t = Number(seconds) || 0;
    const cbs = [...rafCallbacks];
    rafCallbacks.clear();
    for (const cb of cbs) {
      try { cb(__t * 1000); } catch (e) { console.error("preview rAF:", e); }
    }
    pinWebAnimations();
  };

  // Stub the raster API so templates that explicitly call it don't
  // break in preview. Returns a no-op sequence number.
  let __seq = 0;
  window.__seek_dispatch = function (seconds) {
    window.__setTime(seconds);
    return ++__seq;
  };
  window.__seek_status = function () { return { done: __seq, latest: __seq }; };
})();
`;

function buildSrcdoc(template: TemplateSummary, props: Record<string, unknown>): string {
  const styled = template.html.replace("__STYLE__", template.style);
  const propsJson = JSON.stringify(props ?? {});
  const inject =
    `<script>${PREVIEW_SHIM}</script>` +
    `<script>window.__props__ = ${propsJson};</script>`;
  if (styled.includes("</head>")) {
    return styled.replace("</head>", `${inject}</head>`);
  }
  return styled.replace("<body", `${inject}<body`);
}

export class TemplateHandle implements LayerHandle {
  private iframe: HTMLIFrameElement;
  /// Track current template id so we re-mount only when it changes,
  /// not on every param edit.
  private currentTemplateId: string | null = null;
  /// Cached props sig — when changed, we push the new props through
  /// `contentWindow.__props__` for templates that re-read.
  private appliedPropsSig: string | null = null;
  /// Cached size sig — width / height come from template manifest
  /// and only need to be set once after load.
  private appliedSizeSig: string | null = null;
  /// Cached transform sig.
  private appliedTransformSig: string | null = null;
  private appliedOpacity = -1;
  /// True once the iframe has loaded and its contentWindow's
  /// __setTime is callable. Until then, ticks no-op on the
  /// time-update side.
  private ready = false;
  private templateCache: TemplateSummary | null = null;
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    this.iframe.style.position = "absolute";
    this.iframe.style.top = "0";
    this.iframe.style.left = "0";
    this.iframe.style.transformOrigin = "top left";
    this.iframe.style.willChange = "transform, opacity";
    this.iframe.style.visibility = "hidden";
    this.iframe.style.border = "0";
    this.iframe.style.background = "transparent";
    this.iframe.style.pointerEvents = "none";
    this.iframe.addEventListener("load", this.onIframeLoad);
    ctx.container.appendChild(this.iframe);

    // Kick off the templates fetch; rebuild srcdoc once it lands.
    void this.refresh();
  }

  tick(masterUs: number, _playing: boolean): void {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Template") {
      this.hide();
      return;
    }
    if (masterUs < layer.t_start_us || masterUs >= layer.t_end_us) {
      this.hide();
      return;
    }
    // If the template id changed, re-mount with a new srcdoc.
    if (layer.params.template_id !== this.currentTemplateId) {
      void this.refresh();
      // Don't return — still show the existing iframe (if any) while
      // the new template loads, to avoid a flash.
    }

    this.applyVisualParams();
    this.iframe.style.visibility = "visible";

    if (this.ready && this.templateCache) {
      const localSec = (masterUs - layer.t_start_us) / 1_000_000;
      try {
        const w = this.iframe.contentWindow as
          | (Window & { __setTime?: (s: number) => void })
          | null;
        w?.__setTime?.(localSec);
      } catch {
        // contentWindow may be null mid-reload; ignore.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.iframe.removeEventListener("load", this.onIframeLoad);
    if (this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
  }

  // ===== Internal =========================================================

  /// Load templates list (cached) and rebuild srcdoc for the
  /// current layer's template_id. Triggered on construction and
  /// whenever template_id changes mid-life.
  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Template") return;
    const targetId = layer.params.template_id;

    let templates: TemplateSummary[];
    try {
      templates = await loadTemplates();
    } catch (e) {
      console.warn(`TemplateHandle[${this.ctx.layerId}]: list_templates failed`, e);
      return;
    }
    if (this.disposed) return;

    const tpl = templates.find((t) => t.id === targetId);
    if (!tpl) {
      console.warn(`TemplateHandle[${this.ctx.layerId}]: template '${targetId}' not in registry`);
      return;
    }

    this.templateCache = tpl;
    this.currentTemplateId = targetId;
    this.appliedSizeSig = null; // force re-apply post-mount
    this.appliedTransformSig = null;
    this.appliedOpacity = -1;
    this.ready = false;

    // Build srcdoc with the layer's actual props (validated server-side
    // against the template manifest). The injected `<script>window.__props__ = ...`
    // runs before the template's own script, so its `start()` poll
    // resolves immediately to the right values.
    const props = layer.params.props ?? {};
    const srcdoc = buildSrcdoc(tpl, props);
    this.iframe.srcdoc = srcdoc;
    this.appliedPropsSig = JSON.stringify(props);
  }

  private onIframeLoad = () => {
    this.ready = true;
  };

  /// Size + transform + visibility — read each tick (cheap) but
  /// only written when sig changes.
  private applyVisualParams(): void {
    if (this.disposed) return;
    if (!this.templateCache) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Template") return;
    const p = layer.params;

    // Template's manifest size — iframe is sized to the template's
    // native pixel dims, then transformed alongside other layers.
    // `scale_x` / `scale_y` multiply on top of this size (matching
    // the export-side `lower.rs` template branch where target_w =
    // info.width * scale_x).
    const [w, h] = this.templateCache.size;
    const sizeSig = `${w}x${h}`;
    if (sizeSig !== this.appliedSizeSig) {
      this.appliedSizeSig = sizeSig;
      this.iframe.style.width = `${w}px`;
      this.iframe.style.height = `${h}px`;
    }

    const transformSig = `${p.x}|${p.y}|${p.scale_x}|${p.scale_y}`;
    if (transformSig !== this.appliedTransformSig) {
      this.appliedTransformSig = transformSig;
      this.iframe.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale_x}, ${p.scale_y})`;
    }
    if (Math.abs(this.appliedOpacity - p.opacity) > 0.001) {
      this.appliedOpacity = p.opacity;
      this.iframe.style.opacity = String(p.opacity);
    }
  }

  private hide(): void {
    if (this.iframe.style.visibility !== "hidden") {
      this.iframe.style.visibility = "hidden";
    }
  }
}
