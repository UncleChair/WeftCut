// Capture harness: runs a template's `render(t, dur, props)` inside a sandboxed
// offscreen iframe and serializes the post-render `<svg>` to a string. The
// string is rasterized LATER (by the caller, via `rasterizeSvg`) — this module
// only produces SVG markup and must run on the MAIN thread (it needs the DOM).
//
// The iframe is `sandbox="allow-scripts"` with NO `allow-same-origin`, so the
// template script is process-isolated: a runaway `render()` can't hang the main
// thread or reach this app's DOM / Tauri APIs. Communication is postMessage
// only; replies are correlated by a monotonic request id and the message source
// is verified against this harness's own iframe (multiple harnesses can coexist
// because each only accepts messages from its own `contentWindow`).
//
// Lifecycle: `load(template)` (re)mounts the iframe with the template's
// `index.html` (+ injected `@font-face` + the harness script), resolving once
// the iframe posts `ready`. `renderFrameSvg(t, dur, props)` requests one frame.
// `dispose()` tears down the iframe + listener and rejects anything in flight.
import { buildFontFaceStyle, injectFontFace, type FontFaceInput } from "./fontFace";
import { HARNESS_FRAME } from "./harnessFrame";
import type { Template } from "./catalog";

const LOAD_TIMEOUT_MS = 5000;
const RENDER_TIMEOUT_MS = 5000;

interface Pending {
  resolve: (svg: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TemplateHarness {
  private iframe: HTMLIFrameElement | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly onMessage = (ev: MessageEvent) => this.handleMessage(ev);
  private listening = false;

  /// (Re)mount the iframe for `template`. Reuses the same iframe element across
  /// calls (resets `srcdoc`). Resolves when the harness posts `ready`; rejects
  /// on a ~5s timeout. The srcdoc is the template's `index.html` with the
  /// data-URL `@font-face` injected into the `<svg>` defs and the harness
  /// script appended just before `</body>`.
  load(template: Template): Promise<void> {
    this.ensureListener();
    this.rejectAllPending(new Error("harness: reloaded before render completed"));

    const fontStyle = buildFontFaceStyle(collectFonts(template));
    const styledHtml = injectFontFace(template.html, fontStyle);
    const srcdoc = appendHarnessScript(styledHtml);

    if (!this.iframe) {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.title = "template-capture-harness";
      iframe.style.position = "fixed";
      iframe.style.left = "-9999px";
      iframe.style.top = "0";
      iframe.style.width = `${template.manifest.size[0]}px`;
      iframe.style.height = `${template.manifest.size[1]}px`;
      iframe.style.border = "0";
      document.body.appendChild(iframe);
      this.iframe = iframe;
    } else {
      this.iframe.style.width = `${template.manifest.size[0]}px`;
      this.iframe.style.height = `${template.manifest.size[1]}px`;
    }

    return new Promise<void>((resolve, reject) => {
      // A prior load that never readied is superseded by this one.
      if (this.readyReject) this.readyReject(new Error("harness: superseded by a newer load()"));
      if (this.readyTimer !== null) clearTimeout(this.readyTimer);

      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        this.readyTimer = null;
        reject(new Error(`harness: iframe never signalled "ready" within ${LOAD_TIMEOUT_MS}ms`));
      }, LOAD_TIMEOUT_MS);

      // Assigning srcdoc reloads the document; the harness posts "ready" once
      // its script runs.
      this.iframe!.srcdoc = srcdoc;
    });
  }

  /// Request one frame: post a `render` to the iframe and resolve with the
  /// serialized post-render `<svg>` string. Rejects on a ~5s timeout or if the
  /// harness reports a render error.
  renderFrameSvg(
    tSec: number,
    durSec: number,
    props: Record<string, unknown>,
  ): Promise<string> {
    const win = this.iframe?.contentWindow;
    if (!win) {
      return Promise.reject(new Error("harness: renderFrameSvg called before load()"));
    }
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`harness: render #${id} timed out after ${RENDER_TIMEOUT_MS}ms`));
      }, RENDER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      win.postMessage({ type: "render", id, t: tSec, dur: durSec, props }, "*");
    });
  }

  /// Remove the iframe + message listener and reject everything in flight.
  dispose(): void {
    this.rejectAllPending(new Error("harness: disposed"));
    if (this.readyReject) {
      this.readyReject(new Error("harness: disposed"));
      this.readyResolve = null;
      this.readyReject = null;
    }
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.listening) {
      window.removeEventListener("message", this.onMessage);
      this.listening = false;
    }
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
  }

  private ensureListener(): void {
    if (this.listening) return;
    window.addEventListener("message", this.onMessage);
    this.listening = true;
  }

  private handleMessage(ev: MessageEvent): void {
    // Only accept messages from THIS harness's iframe. Origin is opaque
    // (sandboxed, no allow-same-origin) so it can't be checked — the source
    // identity check is the isolation guarantee.
    if (!this.iframe || ev.source !== this.iframe.contentWindow) return;
    const data = ev.data as
      | { type?: string; id?: number; svg?: string; error?: string }
      | null
      | undefined;
    if (!data || typeof data.type !== "string") return;

    if (data.type === "ready") {
      if (this.readyTimer !== null) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      if (resolve) resolve();
      return;
    }

    if (data.type === "rendered" && typeof data.id === "number") {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      clearTimeout(entry.timer);
      if (typeof data.error === "string") {
        entry.reject(new Error(`harness: render #${data.id} failed: ${data.error}`));
      } else if (typeof data.svg === "string") {
        entry.resolve(data.svg);
      } else {
        entry.reject(new Error(`harness: render #${data.id} returned no svg`));
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/// Map a template's declared fonts to `FontFaceInput`s, resolving each
/// declaration's `file` to the bundled bytes in `template.fonts` (keyed
/// `<dir>/assets/<file>`). Declarations whose bytes are missing are skipped.
function collectFonts(template: Template): FontFaceInput[] {
  const decls = template.manifest.fonts ?? [];
  const out: FontFaceInput[] = [];
  for (const decl of decls) {
    const key = Object.keys(template.fonts).find((k) => k.endsWith(`/assets/${decl.file}`));
    if (key === undefined) continue;
    const bytes = template.fonts[key];
    if (bytes === undefined) continue;
    // Build conditionally: `weight`/`style` are optional, and
    // exactOptionalPropertyTypes forbids assigning an explicit `undefined`.
    out.push({
      family: decl.family,
      bytes,
      file: decl.file,
      ...(decl.weight !== undefined ? { weight: decl.weight } : {}),
      ...(decl.style !== undefined ? { style: decl.style } : {}),
    });
  }
  return out;
}

/// Append `<script>${HARNESS_FRAME}</script>` just before `</body>` (or at the
/// document end if there's no `</body>`). Uses a FUNCTION replacer so any `$`
/// in the harness body is inserted literally — String.prototype.replace treats
/// `$&`/`$1`/etc. specially in a plain replacement string.
function appendHarnessScript(html: string): string {
  const scriptTag = `<script>${HARNESS_FRAME}</script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", () => `${scriptTag}</body>`);
  }
  return `${html}${scriptTag}`;
}
