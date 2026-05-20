// libass-wasm (JASSUB) binding.
//
// The JASSUB v2.x API expects an HTMLCanvasElement (not OffscreenCanvas)
// and drives rendering via `manualRender({ mediaTime, ... })`. The
// binding owns a hidden canvas mounted under the Compositor's DOM host;
// the PixiJS sprite samples that canvas as a texture each frame after
// calling `setCurrentTime`.
//
// Plan: docs/pixi-renderer-plan.md (P6 chunk 1 — preview only; export
// Worker context has no DOM, so SubtitlesSprite no-ops there.)

import JASSUB from "jassub";

// Vite resolves these to stable URLs at build time. JASSUB needs the
// worker + WASM + default font reachable as same-origin assets.
import jassubWorkerUrl from "jassub/dist/jassub-worker.js?url";
import jassubWasmUrl from "jassub/dist/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/jassub-worker-modern.wasm?url";
import defaultFontUrl from "jassub/dist/default.woff2?url";

export interface JassubBindingInit {
  /// Width / height of the subtitles canvas. Should match composition
  /// resolution.
  width: number;
  height: number;
  /// ASS document text. Subtitle-source dispatch (SRT → ASS conversion,
  /// file-backed handling) happens upstream — this consumes an ASS body
  /// or nothing.
  assBody: string;
  /// DOM host under which the hidden canvas mounts. The Compositor's
  /// `audioHost` div is the conventional pick.
  host: HTMLElement;
}

export class JassubBinding {
  private canvas: HTMLCanvasElement;
  private jassub: JASSUB | null = null;
  private width: number;
  private height: number;
  private disposed = false;

  constructor(init: JassubBindingInit) {
    this.width = init.width;
    this.height = init.height;
    this.canvas = document.createElement("canvas");
    this.canvas.width = init.width;
    this.canvas.height = init.height;
    this.canvas.style.display = "none";
    init.host.appendChild(this.canvas);

    try {
      this.jassub = new JASSUB({
        canvas: this.canvas,
        subContent: init.assBody,
        workerUrl: jassubWorkerUrl,
        wasmUrl: jassubWasmUrl,
        modernWasmUrl: jassubModernWasmUrl,
        availableFonts: { "liberation sans": defaultFontUrl },
        defaultFont: "liberation sans",
      } as ConstructorParameters<typeof JASSUB>[0]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[weftcut/pixi] JassubBinding init failed:", e);
    }
  }

  outputCanvas(): HTMLCanvasElement | null {
    return this.disposed ? null : this.canvas;
  }

  /// Drive a render at composition-time `tUs`. Fire-and-forget — the
  /// underlying `manualRender` is async; the texture sample on the
  /// next compositor tick picks up whatever JASSUB has rendered.
  setCurrentTime(tUs: number): void {
    if (this.disposed || !this.jassub) return;
    const mediaTime = tUs / 1_000_000;
    try {
      void this.jassub.manualRender({
        mediaTime,
        expectedDisplayTime: performance.now(),
        width: this.width,
        height: this.height,
      } as Parameters<JASSUB["manualRender"]>[0]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[weftcut/pixi] JassubBinding.setCurrentTime threw:", e);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.jassub) {
      try {
        void this.jassub.destroy();
      } catch {
        // ignore
      }
      this.jassub = null;
    }
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
