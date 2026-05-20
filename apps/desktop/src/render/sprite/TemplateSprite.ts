// Template layer rendered via foreignObject SVG raster → texture.
//
// Plan: docs/pixi-renderer-plan.md (P5 chunk 1 — no font embedding,
// no image data URLs, no animation. Templates render at their first
// canonical-prop set and re-raster on prop changes.)

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { TemplateView } from "../../ipc";
import {
  canonicalizeProps,
  rasterCacheKey,
  rasterizeForeignObject,
} from "../templates/Rasterizer";
import { TemplateRasterCache } from "../templates/Cache";
import { getTemplate, type Template } from "../templates/catalog";

export interface TemplateSpriteInit {
  layerId: string;
  templateId: string;
  /// Fires after a freshly-rasterized bitmap is bound. The host uses
  /// it to schedule a repaint when the playhead is paused (no rAF tick
  /// in flight to pick up the new texture).
  onLoaded?: () => void;
}

export class TemplateSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly templateId: string;
  private template: Template | null;
  /// Per-sprite cache. Cross-sprite sharing (templates with identical
  /// prop sets across multiple layers) is a chunk 2 optimization.
  private cache = new TemplateRasterCache();
  /// Cache key currently displayed (or in-flight for display).
  private boundKey: string | null = null;
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  private onLoaded: (() => void) | null;
  private disposed = false;

  constructor(init: TemplateSpriteInit) {
    this.layerId = init.layerId;
    this.templateId = init.templateId;
    this.onLoaded = init.onLoaded ?? null;
    this.template = getTemplate(this.templateId);
    if (!this.template) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] TemplateSprite ${this.layerId}: unknown template "${this.templateId}"`,
      );
    }
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Apply the LayerSummary's transform and trigger a re-raster if
  /// the canonical prop set has changed.
  update(view: TemplateView): void {
    if (this.disposed || !this.template) return;

    this.sprite.position.set(view.x, view.y);
    this.sprite.scale.set(view.scale_x, view.scale_y);
    this.sprite.alpha = view.opacity;

    let canonical: Record<string, unknown>;
    try {
      canonical = canonicalizeProps(view.props, this.template.manifest);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] TemplateSprite ${this.layerId}: canonicalize failed`,
        e,
      );
      return;
    }
    const [w, h] = this.template.manifest.size;
    const key = rasterCacheKey({
      templateId: this.template.manifest.id,
      version: this.template.manifest.version,
      canonicalProps: canonical,
      width: w,
      height: h,
    });
    if (key === this.boundKey) return;
    this.boundKey = key;

    const cached = this.cache.get(key);
    if (cached) {
      this.bindBitmap(cached);
      return;
    }
    void this.rasterizeAndBind(key, canonical, w, h);
  }

  private async rasterizeAndBind(
    key: string,
    canonicalProps: Record<string, unknown>,
    width: number,
    height: number,
  ): Promise<void> {
    if (!this.template) return;
    // Templates expect `window.__props__` available before their JS
    // runs. Inject a tiny script before the template HTML body.
    const propsScript = `<script>window.__props__ = ${JSON.stringify(canonicalProps)};</script>`;
    const html = propsScript + this.template.html;
    try {
      const bitmap = await rasterizeForeignObject({
        html,
        css: this.template.css,
        width,
        height,
      });
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.cache.set(key, bitmap);
      // A later update could have superseded this key while we waited;
      // only bind if we still want what we just rastered.
      if (this.boundKey === key) {
        this.bindBitmap(bitmap);
        this.onLoaded?.();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[weftcut/pixi] TemplateSprite ${this.layerId}: rasterize failed`,
        e,
      );
    }
  }

  private bindBitmap(bitmap: ImageBitmap): void {
    // Free the previous Texture wrapper but NOT the underlying bitmap —
    // the cache owns the bitmap's lifetime.
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(false);
      } catch {
        // ignore
      }
    }
    this.source = new ImageSource({
      resource: bitmap,
      width: bitmap.width,
      height: bitmap.height,
    });
    this.texture = new Texture({ source: this.source });
    this.sprite.texture = this.texture;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(false);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;
    this.cache.dispose();
    this.sprite.destroy({ children: true });
  }
}
