// Template layer rendered via the SVG capture harness → per-frame raster →
// texture. A template animates over its layer duration: each composition
// frame is a distinct `render(tSec)` rasterized to an `ImageBitmap` and
// bound by frame index.
//
// Frames are stored in a process-wide `sharedTemplateFrameCache` (an in-RAM
// LRU keyed by `(cacheKey, frameIndex)`) so two sprites referencing the same
// template with the same canonical props / dims / fps share one bitmap per
// frame. Sprite dispose tears down the sprite's Pixi Texture wrapper but does
// NOT close the underlying bitmap — the cache owns its lifetime.
//
// Capture is async: on a cache miss the sprite asks a per-templateId
// `TemplateHarness` for the frame's `<svg>`, rasterizes it, stores it, and
// binds it if the playhead still wants that (cacheKey, frame). Everything
// DOM-touching (the harness iframe, `rasterizeSvg`) is kept INSIDE the async
// path so a Template layer in the export Worker (no `document`) logs an error
// rather than throwing synchronously out of `update()`.

import { ImageSource, Sprite, Texture } from "pixi.js";

import { frameIndexInLayer } from "../../frames";
import type { TemplateView } from "../../ipc";
import { getTemplate, type Template } from "../templates/catalog";
import { TemplateFrameCache } from "../templates/frameCache";
import { TemplateHarness } from "../templates/harness";
import { rasterizeSvg } from "../templates/svgRaster";
import { templateFrameDescriptor } from "../templates/templateFrameDescriptor";

const US_PER_SEC = 1_000_000;

/// Total animated frames a template spans over `durationUs` on the comp-fps
/// grid, clamped to at least 1 (a zero/sub-frame placement still shows frame
/// 0). Exact-rational (no pre-rounded frame duration) to match the rest of
/// the renderer's frame math. Exported for unit testing.
export function templateDurationFrames(
  durationUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  if (fpsNum <= 0 || fpsDen <= 0) return 1;
  return Math.max(1, Math.round((durationUs * fpsNum) / (US_PER_SEC * fpsDen)));
}

/// Exact-rational seconds at the start of comp frame `frame`. The harness
/// renders `render(tSec)` at this time. Exported for unit testing.
export function frameTimeSec(frame: number, fpsNum: number, fpsDen: number): number {
  if (fpsNum <= 0) return 0;
  return (frame * fpsDen) / fpsNum;
}

/// Compute the content-frame selection for the preview path. `contentDurationUs`
/// is the resolved intrinsic content duration (or the layer width for uncapped
/// templates); `srcInUs` is the window offset (0 for uncapped). Returns the
/// absolute content frame to render and the total content-duration frame count
/// (for the cache key). Exported for unit testing.
export function templateContentFrame(
  tInLayerUs: number,
  srcInUs: number,
  contentDurationUs: number,
  fpsNum: number,
  fpsDen: number,
): { frame: number; contentDurationFrames: number } {
  const contentDurationFrames = templateDurationFrames(contentDurationUs, fpsNum, fpsDen);
  const contentTimeUs = srcInUs + Math.max(0, tInLayerUs);
  const frame = Math.min(
    contentDurationFrames - 1,
    frameIndexInLayer(contentTimeUs, fpsNum, fpsDen),
  );
  return { frame, contentDurationFrames };
}

/// Process-wide per-frame cache shared by every TemplateSprite, so identical
/// (template, props, dims, fps, frame) rasters resolve from one bitmap.
const sharedTemplateFrameCache = new TemplateFrameCache();

/// One harness per templateId, mounted lazily on first use and reused after.
/// Only `countdown` ships today, so this map never thrashes. NOTE: many
/// DISTINCT templates on screen at once would each hold their own iframe; a
/// real fix would be a bounded harness pool keyed by recency. v1 doesn't need
/// it (the built-in catalog is one entry).
interface HarnessEntry {
  harness: TemplateHarness;
  ready: Promise<void>;
}
const harnessByTemplateId = new Map<string, HarnessEntry>();

/// Get (or lazily mount) the shared harness for `template`. Touches the DOM
/// (`new TemplateHarness().load()` adds an iframe + a window listener), so it
/// MUST only be called from the async render path — never synchronously from
/// `update()`, which also runs in the document-less export Worker.
function harnessFor(template: Template): HarnessEntry {
  let entry = harnessByTemplateId.get(template.manifest.id);
  if (!entry) {
    const harness = new TemplateHarness();
    entry = { harness, ready: harness.load(template) };
    harnessByTemplateId.set(template.manifest.id, entry);
  }
  return entry;
}

export interface TemplateSpriteInit {
  layerId: string;
  templateId: string;
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

export class TemplateSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  readonly templateId: string;
  private readonly fpsNum: number;
  private readonly fpsDen: number;
  private template: Template | null;
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

  constructor(init: TemplateSpriteInit) {
    this.layerId = init.layerId;
    this.templateId = init.templateId;
    // The composition fps is captured ONCE at construction. If the project's
    // fps changes while this sprite is alive (a project swap that keeps the
    // sprite), the cached frame grid uses the stale rate until the sprite is
    // recreated. Accepted for v1 — the Compositor recreates sprites on a
    // composition reload, so this is only a transient edge, not re-architected.
    this.fpsNum = init.fpsNum;
    this.fpsDen = init.fpsDen;
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

  /// Apply the layer's transform and bind the raster for the frame at
  /// `tInLayerUs` (composition-time minus the layer's start; templates have no
  /// source-in offset, so this resets to 0 at `t_start`). On a cache hit the
  /// frame binds synchronously; on a miss it's captured + rasterized async and
  /// bound once ready (if still wanted).
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
    view: TemplateView,
    tInLayerUs: number,
    durationUs: number,
    injectedFrames?: readonly ImageBitmap[],
  ): void {
    if (this.disposed || !this.template) return;

    // Transforms first, every tick, BEFORE the frame no-op below: a
    // transform-only change with an unchanged frame must still take.
    this.sprite.position.set(view.x, view.y);
    this.sprite.scale.set(view.scale_x, view.scale_y);
    this.sprite.alpha = view.opacity;

    // Injected-frames path (export). Bind synchronously by layer-local
    // comp-frame index into the pre-baked array. The bake (`exportBake.ts`) is
    // responsible for content-window alignment: it renders each layer-local
    // frame at its CONTENT time (src_in offset + content duration), so this
    // branch only needs the layer-local index — it must NOT re-apply src_in or
    // the content cap (the preview path below does that for live rendering).
    // No canonicalize, no harness, no cache: the bitmaps are already baked.
    if (injectedFrames) {
      const durationFrames = templateDurationFrames(
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

    const desc = templateFrameDescriptor(
      view, tInLayerUs, durationUs, this.fpsNum, this.fpsDen, this.template,
    );
    if (!desc) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] TemplateSprite ${this.layerId}: canonicalize failed`);
      return;
    }
    const { cacheKey, contentFrame: frame, tSec, durationSec, canonicalProps: canonical } = desc;
    if (cacheKey === this.targetCacheKey && frame === this.targetFrame) return;
    this.targetCacheKey = cacheKey;
    this.targetFrame = frame;
    const cached = sharedTemplateFrameCache.getFrame(cacheKey, frame);
    if (cached) {
      this.bindBitmap(cached);
      return;
    }
    void this.captureAndBind(cacheKey, frame, tSec, durationSec, canonical);
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
    if (!this.template) return;
    try {
      const entry = harnessFor(this.template);
      await entry.ready;
      const svg = await entry.harness.renderFrameSvg(
        tSec,
        durationSec,
        canonicalProps,
      );
      const bitmap = await rasterizeSvg(svg);
      // Hand the bitmap to the cache. `setFrame` is idempotent: if a sibling
      // sprite already cached this (cacheKey, frame), it keeps that bitmap and
      // closes ours, returning the CANONICAL cache-owned bitmap. Bind THAT, so
      // no sprite ever binds a bitmap a sibling could close (the cause of the
      // "External Image has been detached" WebGPU error on project reopen).
      const canonical = sharedTemplateFrameCache.setFrame(cacheKey, frame, bitmap);
      // A later `update` may have superseded this request while we awaited;
      // only bind if we still want exactly this (cacheKey, frame).
      if (this.disposed) return;
      if (this.targetCacheKey !== cacheKey || this.targetFrame !== frame) return;
      this.bindBitmap(canonical);
      this.onLoaded?.();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[weftcut/pixi] TemplateSprite ${this.layerId}: capture/rasterize failed`,
        e,
      );
    }
  }

  private bindBitmap(bitmap: ImageBitmap): void {
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        // destroy(true) frees this sprite's own ImageSource/GPU texture.
        // The shared cache's ImageBitmap is NOT closed by destroy(true) —
        // ImageSource.destroy() calls unload() (GPU texture) and nulls
        // `resource` but never calls ImageBitmap.close(). The cache owns
        // bitmap lifetime; destroy(true) only frees this sprite's wrapper.
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

export interface TemplateFrameCacheKeyInput {
  templateId: string;
  version: number;
  canonicalProps: Record<string, unknown>;
  renderW: number;
  renderH: number;
  fpsNum: number;
  fpsDen: number;
  durationFrames: number;
}

/// Stable opaque key for `TemplateFrameCache`. The cache appends `#<frame>`;
/// callers must not. `canonicalProps` is already in stable key order
/// (`canonicalizeProps`), so its JSON is deterministic. Exported for unit
/// testing.
export function templateFrameCacheKey(input: TemplateFrameCacheKeyInput): string {
  return [
    input.templateId,
    String(input.version),
    String(input.renderW),
    String(input.renderH),
    String(input.fpsNum),
    String(input.fpsDen),
    String(input.durationFrames),
    JSON.stringify(input.canonicalProps),
  ].join("|");
}
