// Motif layer rendered via the CDP capture path → per-frame raster → texture.
// A Motif animates over its layer duration: each composition frame is a
// distinct `resolveMotifFrame` call rasterized to an `ImageBitmap` and
// bound by frame index.
//
// Frames are stored in a process-wide `sharedMotifFrameCache` (an in-RAM
// LRU keyed by `(cacheKey, frameIndex)`) so two sprites referencing the same
// Motif with the same canonical props / dims / fps share one bitmap per
// frame. Sprite dispose tears down the sprite's Pixi Texture wrapper but does
// NOT close the underlying bitmap — the cache owns its lifetime.
//
// Capture is async: on a cache miss the sprite calls `resolveMotifFrame`
// (in-RAM cache → on-disk PNG → live `rasterMotifFrame` CDP screenshot of the
// hidden Motif host), stores the result, and binds it if the playhead still
// wants that (cacheKey, frame). The export Worker (no `document`) never takes
// this path — it binds pre-baked `injectedFrames` by index instead.

import { type Container, ImageSource, Sprite, Texture } from "pixi.js";

import { frameIndexInLayer } from "../../frames";
import { anchorPivot, textureExtent } from "../anchorPivot";
import type { ResolvedMotifView } from "../resolveView";
import { getMotif, type Motif } from "../motifs/catalog";
import { resolveMotifFrame, sharedMotifFrameCache } from "../motifs/motifRasterCache";
import { motifFrameDescriptor } from "../motifs/motifFrameDescriptor";
import { motifDurationFrames } from "../motifs/motifFrames";
import type { StageableSprite } from "./StageableSprite";

// A faint neutral tile shown while a first-ever-cold Motif's frame 0 is still
// in flight, so the layer reads as "warming" rather than vanishing. Built once
// from a 2×2 canvas (preview only — the export Worker never hits this path).
let _placeholder: HTMLCanvasElement | null = null;
function neutralPlaceholder(): HTMLCanvasElement {
  if (_placeholder) return _placeholder;
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(128,128,128,0.18)";
  ctx.fillRect(0, 0, 2, 2);
  _placeholder = c;
  return _placeholder;
}

export interface MotifSpriteInit {
  layerId: string;
  motifId: string;
  /// Composition fps rational. The sprite maps `tInLayerUs` to a frame index
  /// with the same exact-rational math the rest of the renderer uses.
  fpsNum: number;
  fpsDen: number;
  /// Fires after a freshly-rasterized bitmap is bound. The host uses it to
  /// schedule a repaint when the playhead is paused (no rAF tick in flight to
  /// pick up the new texture). NOT fired on a synchronous cache hit — that
  /// happens inside the current paint, so a repaint would be churn.
  onLoaded?: () => void;
}

export class MotifSprite implements StageableSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly motifId: string;
  private readonly fpsNum: number;
  private readonly fpsDen: number;
  private motif: Motif | null;
  /// The (cacheKey, frame) we currently want displayed — set eagerly in
  /// `update` and read for BOTH the no-op check and the async race-guard
  /// (a newer `update` supersedes an in-flight rasterize by moving these).
  private targetCacheKey: string | null = null;
  private targetFrame = -1;
  /// Last comp-frame index bound from `injectedFrames` (export mode). Lets a
  /// repeated index (output fps < comp fps, or a held frame) skip the rebind +
  /// per-tick GPU texture churn. -1 = nothing bound yet.
  private injectedFrame = -1;
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  private onLoaded: (() => void) | null;
  private disposed = false;
  private boundOnce = false;

  constructor(init: MotifSpriteInit) {
    this.layerId = init.layerId;
    this.motifId = init.motifId;
    // The composition fps is captured ONCE at construction. If the project's
    // fps changes while this sprite is alive (a project swap that keeps the
    // sprite), the cached frame grid uses the stale rate until the sprite is
    // recreated — which the Compositor does on a composition reload.
    this.fpsNum = init.fpsNum;
    this.fpsDen = init.fpsDen;
    this.onLoaded = init.onLoaded ?? null;
    this.motif = getMotif(this.motifId);
    if (!this.motif) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] MotifSprite ${this.layerId}: unknown motif "${this.motifId}"`,
      );
    }
    this.sprite = new Sprite(Texture.EMPTY);
  }

  get displayObject(): Container {
    return this.sprite;
  }

  /// EMPTY until the first raster (cache hit / capture) binds; not staged
  /// before then (PixiJS v8 batched renderer crashes on the EMPTY placeholder).
  get stageReady(): boolean {
    return this.sprite.texture !== Texture.EMPTY;
  }

  /// Apply the layer's transform and bind the raster for the frame at
  /// `tInLayerUs` (composition-time minus the layer's start; `src_in`
  /// windowing, where it applies, happens inside `motifFrameDescriptor`). On a
  /// cache hit the frame binds synchronously; on a miss it's captured +
  /// rasterized async and bound once ready (if still wanted).
  ///
  /// `injectedFrames` (export mode) is a pre-rasterized `ImageBitmap[]` for
  /// THIS layer, indexed by composition-frame, baked on the main thread by
  /// `exportBake.ts`. When present it is consulted FIRST: the frame is bound
  /// SYNCHRONOUSLY by `frameIndexInLayer(...)` (clamped), bypassing the DOM
  /// capture harness entirely (the export Worker has no `document`). The frame
  /// index is computed with the SAME comp-fps math as the preview path, so
  /// export == preview frame selection. Absent (preview) ⇒ the harness/cache
  /// path below runs unchanged.
  update(
    view: ResolvedMotifView,
    tInLayerUs: number,
    durationUs: number,
    injectedFrames?: readonly ImageBitmap[],
  ): void {
    if (this.disposed || !this.motif) return;

    // Transforms first, every tick, BEFORE the frame no-op below: a
    // transform-only change with an unchanged frame must still take.
    this.sprite.scale.set(view.scale_x, view.scale_y);
    // Anchor is the pivot; `x`/`y` stay the unrotated top-left (anchorPivot.ts).
    // The raster's own dimensions are the local space here, so a Motif captured
    // at a different size still pivots at the same relative point.
    const pivot = anchorPivot({
      x: view.x,
      y: view.y,
      anchorX: view.anchor_x,
      anchorY: view.anchor_y,
      ...textureExtent(this.sprite.texture),
      effScaleX: view.scale_x,
      effScaleY: view.scale_y,
    });
    this.sprite.pivot.set(pivot.pivotX, pivot.pivotY);
    this.sprite.position.set(pivot.posX, pivot.posY);
    this.sprite.angle = view.rotation_deg;
    this.sprite.alpha = view.opacity;

    // Injected-frames path (export). Bind synchronously by layer-local
    // comp-frame index into the pre-baked array. The bake (`exportBake.ts`) is
    // responsible for content-window alignment: it renders each layer-local
    // frame at its CONTENT time (src_in offset + content duration), so this
    // branch only needs the layer-local index — it must NOT re-apply src_in or
    // the content cap (the preview path below does that for live rendering).
    // No canonicalize, no harness, no cache: the bitmaps are already baked.
    if (injectedFrames) {
      const durationFrames = motifDurationFrames(
        durationUs,
        this.fpsNum,
        this.fpsDen,
      );
      const frame = Math.min(
        durationFrames - 1,
        frameIndexInLayer(tInLayerUs, this.fpsNum, this.fpsDen),
      );
      // Clamp into the baked array — a mid-layer export start leaves head
      // holes, and the array's length is `lastFrame + 1`, so an in-range
      // request always lands on a real bitmap. Guard against a hole / OOB
      // defensively (would otherwise bind `undefined`).
      const idx = Math.max(0, Math.min(injectedFrames.length - 1, frame));
      // Same index already bound → skip the rebind (avoids per-tick GPU
      // texture churn when output fps < comp fps or the frame is held).
      if (idx === this.injectedFrame) return;
      const bitmap = injectedFrames[idx];
      if (bitmap) {
        this.bindBitmap(bitmap);
        this.injectedFrame = idx;
      }
      return;
    }

    const desc = motifFrameDescriptor(
      view, tInLayerUs, durationUs, this.fpsNum, this.fpsDen, this.motif,
    );
    if (!desc) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] MotifSprite ${this.layerId}: canonicalize failed`);
      return;
    }
    const { cacheKey, contentFrame: frame, tSec, durationSec, canonicalProps: canonical } = desc;
    if (cacheKey === this.targetCacheKey && frame === this.targetFrame) return;
    this.targetCacheKey = cacheKey;
    this.targetFrame = frame;
    const cached = sharedMotifFrameCache.getFrame(cacheKey, frame);
    if (cached) {
      this.bindBitmap(cached);
      return;
    }
    // First-ever cold frame: show a neutral placeholder so the layer doesn't
    // flash empty while frame 0 is captured. Later misses hold the last bitmap.
    if (!this.boundOnce && this.texture === null && typeof document !== "undefined") {
      this.bindBitmap(neutralPlaceholder());
    }
    void this.captureAndBind(cacheKey, frame, tSec, durationSec, canonical);
  }

  /// Re-fetch this layer's Motif from the runtime catalog and reset the render
  /// target so the next `update()` re-evaluates the cache key and re-captures.
  /// Called by `Compositor.refreshMotifs()` on a catalog change (draft edit /
  /// install / delete). Does NOT dispose — the last bound bitmap stays on screen
  /// until the fresh frame lands, so there's no flash. No-op once disposed.
  refreshMotif(): void {
    if (this.disposed) return;
    this.motif = getMotif(this.motifId);
    this.targetCacheKey = null;
    this.targetFrame = -1;
  }

  /// Render + rasterize one frame, store it, and bind it iff the playhead
  /// still wants this exact (cacheKey, frame) and the sprite is alive. The
  /// rasterized bitmap is handed to the shared cache even when superseded /
  /// disposed so the work isn't wasted (another sprite — or a later seek back
  /// — may want it). Everything here is async + DOM-touching, kept off the
  /// synchronous `update()` path so the document-less export Worker doesn't
  /// throw out of the composite loop.
  private async captureAndBind(
    cacheKey: string,
    frame: number,
    tSec: number,
    durationSec: number,
    canonicalProps: Record<string, unknown>,
  ): Promise<void> {
    if (!this.motif) return;
    try {
      const bitmap = await resolveMotifFrame(
           this.motif, cacheKey, frame, tSec, durationSec, canonicalProps,
         );
      // Hand the bitmap to the cache. `setFrame` is idempotent: if a sibling
      // sprite already cached this (cacheKey, frame), it keeps that bitmap and
      // closes ours, returning the CANONICAL cache-owned bitmap. Bind THAT, so
      // no sprite ever binds a bitmap a sibling could close (the cause of the
      // "External Image has been detached" WebGPU error on project reopen).
      const canonical = sharedMotifFrameCache.setFrame(cacheKey, frame, bitmap);
      // A later `update` may have superseded this request while we awaited;
      // only bind if we still want exactly this (cacheKey, frame).
      if (this.disposed) return;
      if (this.targetCacheKey !== cacheKey || this.targetFrame !== frame) return;
      this.bindBitmap(canonical);
      this.onLoaded?.();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[weftcut/pixi] MotifSprite ${this.layerId}: capture/rasterize failed`,
        e,
      );
    }
  }

  private bindBitmap(bitmap: ImageBitmap | HTMLCanvasElement): void {
    // destroy(true) frees this sprite's own ImageSource/GPU texture on every
    // rebind, preventing a per-tick GPU-memory leak. The shared cache's
    // ImageBitmap is NOT closed by destroy(true) — ImageSource inherits
    // TextureSource.destroy(), which calls unload() (GPU texture freed) and
    // nulls `resource` but never calls ImageBitmap.close(). Each sprite wraps
    // the cache bitmap in its OWN independent ImageSource, so destroy(true)
    // only affects this sprite's wrapper + source, not the cache-owned bitmap.
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(true);
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
    this.boundOnce = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        // Frees this sprite's own wrapper only — never the cache-owned
        // ImageBitmap (see bindBitmap).
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
