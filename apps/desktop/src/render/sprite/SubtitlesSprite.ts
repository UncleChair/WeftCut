// Subtitles via libass-wasm (JASSUB). The JASSUB renderer paints into
// its own hidden HTMLCanvasElement at libass's cadence; we sample that
// canvas as a PixiJS texture each composite tick. Preview-only — export
// Worker context has no DOM and is skipped at the Compositor level.
//
// Plan: docs/pixi-renderer-plan.md (P6 chunk 1)

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { SubtitlesView } from "../../ipc";
import { JassubBinding } from "../subtitles/Jassub";
import { subtitlesViewToAssBody } from "../subtitles/assBody";

export interface SubtitlesSpriteInit {
  layerId: string;
  /// Composition pixel size — JASSUB renders at this resolution.
  width: number;
  height: number;
  /// DOM host where the hidden canvas mounts.
  host: HTMLElement;
}

export class SubtitlesSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  private binding: JassubBinding | null = null;
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  private boundBody: string | null = null;
  private host: HTMLElement;
  private width: number;
  private height: number;
  private disposed = false;

  constructor(init: SubtitlesSpriteInit) {
    this.layerId = init.layerId;
    this.host = init.host;
    this.width = init.width;
    this.height = init.height;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Drive JASSUB to render the cue active at `tUs`. The view's
  /// source_kind determines whether the body is consumed verbatim
  /// (InlineAss), converted from SRT, or skipped (Media — chunk 2).
  update(view: SubtitlesView, tUs: number): void {
    if (this.disposed) return;
    const body = subtitlesViewToAssBody(view);
    if (body === null) return;

    if (body !== this.boundBody) {
      this.rebind(body);
    }
    this.binding?.setCurrentTime(tUs);
    if (this.texture && this.texture !== Texture.EMPTY) {
      // Tell PixiJS the canvas's GPU texture is dirty so the next
      // batch upload re-samples libass's latest paint.
      this.texture.source.update();
    }
  }

  private rebind(body: string): void {
    if (this.binding) {
      this.binding.dispose();
      this.binding = null;
    }
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(true);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;

    this.binding = new JassubBinding({
      width: this.width,
      height: this.height,
      assBody: body,
      host: this.host,
    });
    this.boundBody = body;

    const canvas = this.binding.outputCanvas();
    if (canvas) {
      this.source = new ImageSource({
        resource: canvas,
        width: this.width,
        height: this.height,
      });
      this.texture = new Texture({ source: this.source });
      this.sprite.texture = this.texture;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.binding) {
      this.binding.dispose();
      this.binding = null;
    }
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(true);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;
    this.sprite.destroy({ children: true });
  }
}
