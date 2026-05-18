// PixiJS-backed composition root. Owns the `Application`, the scene
// graph, and the per-frame composite. Same module serves both preview
// (main thread, mounts against HTMLCanvasElement) and export (Worker,
// mounts against OffscreenCanvas).
//
// Plan: docs/pixi-renderer-plan.md

import { Application, Container } from "pixi.js";

export interface CompositorInit {
  /// Canvas to render into. `HTMLCanvasElement` on the main thread for
  /// preview; `OffscreenCanvas` inside the export Worker.
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /// Project composition dimensions in pixels. Internal renderer size
  /// stays at project resolution regardless of how the canvas is
  /// CSS-scaled in preview.
  width: number;
  height: number;
  /// Preview can prefer interactive over throughput; export wants
  /// throughput. Currently advisory — both modes initialize the same
  /// Application.
  mode: "preview" | "export";
}

export class Compositor {
  readonly app: Application;
  readonly stage: Container;
  private _disposed = false;

  constructor(_init: CompositorInit) {
    // P0 stub: construct the Application but don't initialize it yet —
    // PixiJS v8's `init()` is async. The `mount()` method handles the
    // async path so callers can `await` cleanly.
    this.app = new Application();
    this.stage = new Container();
  }

  /// Initialize the underlying renderer. Must be awaited before any
  /// `compositeFrame()` call.
  async mount(init: CompositorInit): Promise<void> {
    await this.app.init({
      canvas: init.canvas as HTMLCanvasElement,
      width: init.width,
      height: init.height,
      antialias: true,
      backgroundAlpha: 1,
      background: 0x000000,
      // P1 will tune: preference: 'high-performance', powerPreference, etc.
    });
    this.app.stage.addChild(this.stage);
  }

  /// Render one frame at composition-time `tUs`. P0 stub — paints
  /// the configured background only. P2 populates the scene graph
  /// from project state.
  compositeFrame(_tUs: number): void {
    if (this._disposed) return;
    this.app.renderer.render(this.app.stage);
  }

  /// Release GPU resources. Safe to call repeatedly.
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.app.destroy(true, { children: true, texture: true });
  }
}
