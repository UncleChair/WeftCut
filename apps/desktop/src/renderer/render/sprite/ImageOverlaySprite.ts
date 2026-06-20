// ImageOverlay layer. Loads the image once via `createImageBitmap`,
// wraps it in an `ImageSource`-backed `Texture`, then applies the
// LayerSummary's flattened static transforms each composite tick.
//
// See docs/render.md (image-overlay layers).
//
// The bitmap stays GPU-resident for the lifetime of the sprite. If
// the user replaces the image's underlying media, the layer's
// mediaId changes and the Compositor disposes + re-creates the
// sprite (which re-loads).

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { ResolvedImageOverlayView } from "../resolveView";

export interface ImageOverlaySpriteInit {
  layerId: string;
  mediaId: string;
}

export class ImageOverlaySprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  /// Reject any further `loadFromAsset` calls after dispose so a
  /// late-arriving async fetch doesn't bind a texture to a destroyed
  /// sprite.
  private disposed = false;

  constructor(init: ImageOverlaySpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Fetch the image at `assetUrl`, decode to an ImageBitmap, and
  /// bind it as the sprite's texture. Idempotent (no-op on second
  /// call). Errors are logged and leave the sprite on Texture.EMPTY
  /// (visible as a gap in the composition).
  async loadFromAsset(assetUrl: string): Promise<void> {
    if (this.source || this.disposed) return;
    try {
      const res = await fetch(assetUrl);
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[weftcut/pixi] ImageOverlay ${this.layerId}: fetch ${assetUrl} → ${res.status}`,
        );
        return;
      }
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.source = new ImageSource({
        resource: bitmap,
        width: bitmap.width,
        height: bitmap.height,
      });
      this.texture = new Texture({ source: this.source });
      this.sprite.texture = this.texture;
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] image ${this.layerId} loaded: ${bitmap.width}×${bitmap.height}`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[weftcut/pixi] ImageOverlay ${this.layerId}: load failed`, e);
    }
  }

  /// Apply transform/opacity from the LayerSummary view + fade
  /// windows. `tInLayerUs` is composition-time minus the layer's
  /// start.
  update(view: ResolvedImageOverlayView, tInLayerUs: number, durationUs: number): void {
    if (this.disposed) return;
    this.sprite.position.set(view.x, view.y);
    this.sprite.scale.set(view.scale_x, view.scale_y);
    // Compose layer opacity with fade-in / fade-out envelopes.
    let alpha = view.opacity;
    if (view.fade_in_us > 0 && tInLayerUs < view.fade_in_us) {
      alpha *= Math.max(0, tInLayerUs / view.fade_in_us);
    }
    if (view.fade_out_us > 0) {
      const tUntilEndUs = durationUs - tInLayerUs;
      if (tUntilEndUs < view.fade_out_us) {
        alpha *= Math.max(0, tUntilEndUs / view.fade_out_us);
      }
    }
    this.sprite.alpha = alpha;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const tex = this.texture;
    this.sprite.destroy({ children: true });
    if (tex && tex !== Texture.EMPTY) {
      try {
        tex.destroy(true);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;
  }
}
