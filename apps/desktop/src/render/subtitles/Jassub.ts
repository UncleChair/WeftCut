// libass-wasm (JASSUB) canvas-mode binding.
//
// Plan: docs/pixi-renderer-plan.md (P6)
//
// P0 stub. P6 wires the JASSUB instance with an OffscreenCanvas target
// so the renderer can sample its output as a Texture each frame.

// JASSUB types come from the package. Importing as a type-only here so
// the value-side (`new JASSUB(...)`) isn't pulled in at module load.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type JASSUB from "jassub";

export interface JassubBindingInit {
  /// Width / height of the subtitles canvas. Should match composition
  /// resolution.
  width: number;
  height: number;
  /// ASS document text.
  assBody: string;
}

export class JassubBinding {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_init: JassubBindingInit) {
    // P6: new JASSUB({ canvas: new OffscreenCanvas(w, h), subContent: assBody, ... })
  }

  /// Output canvas. Pass to PixiJS `Texture.from(canvas)`; refresh
  /// each frame via `texture.source.update()`.
  outputCanvas(): OffscreenCanvas | null {
    return null;
  }

  setCurrentTime(_tUs: number): void {
    // P6: jassub.setCurrentTime(tUs / 1e6)
  }

  dispose(): void {
    // P6: jassub.destroy()
  }
}
