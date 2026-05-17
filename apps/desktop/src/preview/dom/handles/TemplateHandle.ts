/// Phase C — Template layer handle.
///
/// Renders the template's HTML live in a `<div>` host with a shadow
/// root for CSS isolation. Drives its animation clock from the
/// PlaybackEngine's master clock via a per-instance `setTime(t)`
/// hook that advances the closure-captured time + drains the
/// per-instance rAF queue.
///
/// **Why div+shadow rather than iframe** (`docs/preview-dom.md` Q5):
/// the design originally specced `<iframe srcdoc>` for isolation,
/// but WebView2 paints a hardcoded white canvas under srcdoc
/// (and `URL.createObjectURL`-backed) iframes that no CSS path
/// can reach — every computed background-color reports
/// `rgba(0,0,0,0)` and the document still renders white. Shadow
/// DOM gives the same style isolation without the iframe rendering
/// surface, so transparency works as written.
///
/// Architecture:
///   - Each Template layer mounts a `<div>` host with `attachShadow`.
///   - Template's `<style>` and `<body>` content go into the shadow
///     root; CSS is fully isolated, queries like
///     `document.getElementById` work because ShadowRoot implements
///     the DocumentOrShadowRoot mixin.
///   - Template's `<script>` is extracted (NOT inserted via innerHTML —
///     those don't execute) and run via `new Function` with per-
///     instance shadowed globals: `document → shadowRoot`,
///     `window → proxy with __props__`, `performance.now / Date.now
///     → synthetic-clock returner`, `requestAnimationFrame → adds to
///     per-instance queue`, `cancelAnimationFrame → no-op`. Bare
///     references to `setTimeout` / `Promise` / etc. resolve to
///     the real globals which is what templates expect.
///   - Each tick, `setTime(localSec)` updates the closure `__t` and
///     drains the rAF queue, letting templates animate frame-by-frame
///     driven by the master clock.
///
/// Raster path is unaffected — the offscreen webview still loads
/// templates as full HTML pages, executes them natively, and
/// captures via `CapturePreview`. The two paths share the template
/// artifact but diverge on rendering host.

import { listTemplates, type TemplateSummary } from "../../../ipc";
import { useProjectStore } from "../../../state/projectStore";
import type { HandleContext, LayerHandle } from "./types";

/// Cached across all TemplateHandle instances — `listTemplates()` is
/// pure-read on the Rust side and the list is stable for the app
/// session. Exported so `HtmlGroupHandle` (Phase H Template-in-
/// composition followup) can share the cache — re-fetching catalog
/// once per html-group mount would be wasteful.
let templatesCache: Promise<TemplateSummary[]> | null = null;
export function loadTemplates(): Promise<TemplateSummary[]> {
  if (!templatesCache) {
    templatesCache = listTemplates().catch((e) => {
      templatesCache = null;
      throw e;
    });
  }
  return templatesCache;
}

export interface TemplateRuntime {
  /// Advance the per-instance synthetic clock to `seconds` and
  /// drain the rAF queue so the template re-renders at that time.
  setTime(seconds: number): void;
  /// Tear down — clear the queue, drop references.
  dispose(): void;
}

/// Parse template HTML into the three pieces shadow-DOM mounting
/// needs: combined `<style>` body, combined `<script>` body, and
/// the `<body>` markup minus the scripts (so setting `innerHTML`
/// doesn't try-but-fail to execute them).
function parseTemplate(composed: string): {
  styles: string;
  scripts: string;
  bodyContent: string;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(composed, "text/html");
  const styles = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  const scripts = Array.from(doc.querySelectorAll("script"))
    .map((s) => s.textContent ?? "")
    .join("\n;\n");
  // Strip script elements from body so innerHTML doesn't try to set
  // them (it wouldn't execute them anyway, but they'd clutter the DOM).
  Array.from(doc.body.querySelectorAll("script")).forEach((s) => s.remove());
  const bodyContent = doc.body.innerHTML;
  return { styles, scripts, bodyContent };
}

/// Instantiate one template into `hostDiv`. Sets up the shadow,
/// injects styles + body content, executes scripts with per-instance
/// shadowed globals, and returns a runtime handle to drive time.
///
/// Exported because Phase H's `HtmlGroupHandle` mounts templates as
/// children of a composition's shadow root — it walks the composition
/// for `[data-kind="Template"]` placeholders after `buildComposition()`
/// builds the outer DOM, and calls this to mount each one.
export function instantiateTemplate(
  hostDiv: HTMLDivElement,
  template: TemplateSummary,
  props: Record<string, unknown>,
): TemplateRuntime {
  // `attachShadow` is one-shot — if the host already has a shadow,
  // we can't re-attach. Caller guarantees a fresh hostDiv per
  // instantiation.
  const shadow = hostDiv.attachShadow({ mode: "open" });

  const composed = template.html.replace("__STYLE__", template.style);
  const { styles, scripts, bodyContent } = parseTemplate(composed);

  const [w, h] = template.size;
  // `:host { all: unset }` would nuke our display/size declarations
  // along with parent inheritance. Use `display: block` + explicit
  // size for layout; the shadow boundary keeps the template's CSS
  // from leaking out and the host page's CSS from leaking in.
  shadow.innerHTML =
    `<style>:host { display: block; position: relative; width: ${w}px; height: ${h}px; overflow: hidden; }</style>` +
    `<style>${styles}</style>` +
    bodyContent;

  // Per-instance state captured by the script's closure.
  const clock = { t: 0 };
  const rafQueue = new Map<number, FrameRequestCallback>();
  let rafSeq = 0;

  // Window-proxy: known per-instance properties (__props__, __ready__)
  // map to local state; anything else falls through to the real
  // window so bare references like `setTimeout`, `Promise`,
  // `console` work normally.
  const winState: Record<string | symbol, unknown> = {
    __props__: props,
  };
  const winProxy = new Proxy(winState, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Fall through to the real window. Type-cast because we're
      // intentionally bypassing the strict global typing here.
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

  const perfProxy = { now: () => clock.t * 1000 };
  const dateProxy = Object.assign(
    function DateShim(...args: unknown[]) {
      // `new Date()` / `new Date(arg)` — delegate to real Date so
      // formatting / parsing still works.
      return new (Date as unknown as new (...a: unknown[]) => Date)(...args);
    },
    { now: () => clock.t * 1000 },
  );

  const rafFn = (cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafQueue.set(id, cb);
    return id;
  };
  const cancelRafFn = (id: number) => {
    rafQueue.delete(id);
  };

  // Execute template scripts. `new Function` runs in the global
  // scope, but the named parameters shadow whatever the global has
  // for those names — so the template sees our overrides for
  // document / window / performance / Date / rAF.
  try {
    const fn = new Function(
      "document",
      "window",
      "performance",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      // Template authors don't reliably bare-use `globalThis`; the
      // shadowed `window` covers the cases that matter.
      scripts,
    );
    fn(
      // ShadowRoot has `getElementById` / `querySelector` /
      // `querySelectorAll` via DocumentOrShadowRoot. Templates that
      // depend on `document.body` would break here — none of the
      // shipped templates do.
      shadow,
      winProxy,
      perfProxy,
      dateProxy,
      rafFn,
      cancelRafFn,
    );
  } catch (e) {
    console.warn("TemplateHandle: script execution failed", e);
  }

  return {
    setTime(seconds: number) {
      clock.t = Number(seconds) || 0;
      // Snapshot + clear before invoking — callbacks that schedule
      // another rAF (every animation loop does) re-populate the
      // queue for the next tick.
      const cbs = Array.from(rafQueue.values());
      rafQueue.clear();
      const tMs = clock.t * 1000;
      for (const cb of cbs) {
        try {
          cb(tMs);
        } catch (e) {
          console.error("TemplateHandle rAF callback:", e);
        }
      }
    },
    dispose() {
      rafQueue.clear();
    },
  };
}

export class TemplateHandle implements LayerHandle {
  private host: HTMLDivElement;
  private runtime: TemplateRuntime | null = null;
  /// Track current template id so we re-mount only when it changes,
  /// not on every param edit.
  private currentTemplateId: string | null = null;
  /// Cached props sig — refresh on change so the template's `start()`
  /// re-reads them (current templates only read once, so this is a
  /// hard re-mount; future templates with an `__onPropsUpdated`
  /// hook can be optimized).
  private appliedPropsSig: string | null = null;
  /// Cached size + transform sigs so we don't touch the DOM on
  /// every tick when nothing has changed.
  private appliedSizeSig: string | null = null;
  private appliedTransformSig: string | null = null;
  private appliedOpacity = -1;
  private templateCache: TemplateSummary | null = null;
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.host = document.createElement("div");
    this.host.style.position = "absolute";
    this.host.style.top = "0";
    this.host.style.left = "0";
    this.host.style.transformOrigin = "top left";
    this.host.style.willChange = "transform, opacity";
    this.host.style.visibility = "hidden";
    this.host.style.pointerEvents = "none";
    ctx.container.appendChild(this.host);
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

    // Template id changed → rebuild from scratch (new template means
    // new HTML + scripts).
    if (layer.params.template_id !== this.currentTemplateId) {
      void this.refresh();
    } else {
      // Props changed → rebuild too. Existing templates read props
      // once at start(); a future template with an `__onPropsUpdated`
      // hook could swap to a no-rebuild path here.
      const propsSig = JSON.stringify(layer.params.props ?? {});
      if (propsSig !== this.appliedPropsSig) {
        void this.refresh();
      }
    }

    this.applyVisualParams();
    this.host.style.visibility = "visible";

    if (this.runtime) {
      const localSec = (masterUs - layer.t_start_us) / 1_000_000;
      this.runtime.setTime(localSec);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.runtime) {
      this.runtime.dispose();
      this.runtime = null;
    }
    if (this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
  }

  // ===== Internal =========================================================

  /// Load templates list (cached) and rebuild the shadow host for
  /// the current layer's template_id + props. Triggered on
  /// construction and whenever template_id or props change.
  ///
  /// Re-creates the host div from scratch each time because
  /// `attachShadow` is one-shot per element. The fresh host
  /// inherits the prior host's position in the container.
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

    const props = (layer.params.props ?? {}) as Record<string, unknown>;
    const propsSig = JSON.stringify(props);

    // Tear down prior runtime + host.
    if (this.runtime) {
      this.runtime.dispose();
      this.runtime = null;
    }
    const oldHost = this.host;
    const fresh = document.createElement("div");
    fresh.style.position = "absolute";
    fresh.style.top = "0";
    fresh.style.left = "0";
    fresh.style.transformOrigin = "top left";
    fresh.style.willChange = "transform, opacity";
    fresh.style.visibility = "hidden";
    fresh.style.pointerEvents = "none";
    oldHost.parentNode?.insertBefore(fresh, oldHost);
    oldHost.parentNode?.removeChild(oldHost);
    this.host = fresh;

    this.templateCache = tpl;
    this.currentTemplateId = targetId;
    this.appliedPropsSig = propsSig;
    this.appliedSizeSig = null;
    this.appliedTransformSig = null;
    this.appliedOpacity = -1;

    this.runtime = instantiateTemplate(this.host, tpl, props);
  }

  /// Size + transform + opacity — read each tick (cheap) but only
  /// written when sig changes.
  private applyVisualParams(): void {
    if (this.disposed) return;
    if (!this.templateCache) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Template") return;
    const p = layer.params;

    const [w, h] = this.templateCache.size;
    const sizeSig = `${w}x${h}`;
    if (sizeSig !== this.appliedSizeSig) {
      this.appliedSizeSig = sizeSig;
      this.host.style.width = `${w}px`;
      this.host.style.height = `${h}px`;
    }

    const transformSig = `${p.x}|${p.y}|${p.scale_x}|${p.scale_y}`;
    if (transformSig !== this.appliedTransformSig) {
      this.appliedTransformSig = transformSig;
      this.host.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.scale_x}, ${p.scale_y})`;
    }
    if (Math.abs(this.appliedOpacity - p.opacity) > 0.001) {
      this.appliedOpacity = p.opacity;
      this.host.style.opacity = String(p.opacity);
    }
  }

  private hide(): void {
    if (this.host.style.visibility !== "hidden") {
      this.host.style.visibility = "hidden";
    }
  }
}
