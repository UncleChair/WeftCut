// ImageOverlay layer. Supported still-image types (gif/png/jpeg/webp/avif) are
// decoded via the shared ImageDecoder cache: a multi-frame source becomes an
// *animated image* whose frame is chosen per-tick from composition time and
// LOOPED to fill the (free) layer duration; a single-frame source binds frame 0
// once. Unsupported types (bmp/tiff/svg) fall back to a one-shot
// createImageBitmap. The cache owns animated bitmaps; this sprite only wraps
// them in its own Texture (mirrors MotifSprite ownership). See docs/render.md.

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { ResolvedImageOverlayView } from "../resolveView";
import { gifFrameIndexAt } from "./gifTiming";
import {
  sharedAnimatedImageCache,
  type DecodedAnimation,
} from "./animatedImageCache";

export interface ImageOverlaySpriteInit {
  layerId: string;
  mediaId: string;
  /// Decode-time downscale cap (composition pixels). Frames are scaled to
  /// min(original, cap) so a large GIF can't blow memory.
  maxWidth: number;
  maxHeight: number;
}

export class ImageOverlaySprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly mediaId: string;
  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private texture: Texture | null = null;
  /// Decoded animation (1+ frames) from the shared cache, or null when the
  /// static fallback path is used. Cache-owned: never closed here.
  private anim: DecodedAnimation | null = null;
  /// Cache key held for `release` on dispose; null until/unless an acquire wins.
  private animKey: string | null = null;
  /// Last bound frame index (animated path) — skip rebind when unchanged.
  private boundIndex = -1;
  /// Reject async binds after dispose.
  private disposed = false;

  constructor(init: ImageOverlaySpriteInit) {
    this.layerId = init.layerId;
    this.mediaId = init.mediaId;
    this.maxWidth = init.maxWidth;
    this.maxHeight = init.maxHeight;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Load `assetUrl`. Tries the animated ImageDecoder cache first; on an
  /// unsupported type / decode error falls back to a one-shot bitmap. Idempotent.
  async loadFromAsset(assetUrl: string): Promise<void> {
    if (this.anim || this.texture || this.disposed) return;
    const key = `${this.mediaId}@${this.maxWidth}x${this.maxHeight}`;
    try {
      const anim = await sharedAnimatedImageCache.acquire(
        key,
        assetUrl,
        this.maxWidth,
        this.maxHeight,
      );
      if (this.disposed) {
        sharedAnimatedImageCache.release(key);
        return;
      }
      this.anim = anim;
      this.animKey = key;
      // First frame binds on the next update() (it knows tInLayerUs).
      return;
    } catch {
      // Unsupported type / decode failure → static fallback below.
    }
    try {
      const res = await fetch(assetUrl);
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`[weftcut/pixi] ImageOverlay ${this.layerId}: fetch ${assetUrl} → ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.bindBitmap(bitmap);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[weftcut/pixi] ImageOverlay ${this.layerId}: load failed`, e);
    }
  }

  /// Apply transform/opacity/fade and, for an animated source, bind the looped
  /// frame for `tInLayerUs`. `tInLayerUs` is composition-time minus the layer's
  /// start; `durationUs` is the layer's (free) span.
  update(view: ResolvedImageOverlayView, tInLayerUs: number, durationUs: number): void {
    if (this.disposed) return;
    this.sprite.position.set(view.x, view.y);
    this.sprite.scale.set(view.scale_x, view.scale_y);
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

    if (this.anim) {
      const idx = gifFrameIndexAt(tInLayerUs, this.anim.durationsUs);
      if (idx !== this.boundIndex) {
        const bmp = this.anim.frames[idx];
        if (bmp) {
          this.bindBitmap(bmp);
          this.boundIndex = idx;
        }
      }
    }
  }

  /// Wrap `bitmap` in this sprite's OWN ImageSource/Texture, destroying the
  /// previous wrapper (frees this sprite's GPU texture; does NOT close the
  /// bitmap — the static path's bitmap is GC'd; the animated path's bitmaps are
  /// cache-owned). Mirrors MotifSprite.bindBitmap.
  private bindBitmap(bitmap: ImageBitmap): void {
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(true);
      } catch {
        // ignore
      }
    }
    const source = new ImageSource({ resource: bitmap, width: bitmap.width, height: bitmap.height });
    this.texture = new Texture({ source });
    this.sprite.texture = this.texture;
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
    this.anim = null;
    if (this.animKey) {
      sharedAnimatedImageCache.release(this.animKey);
      this.animKey = null;
    }
  }
}
