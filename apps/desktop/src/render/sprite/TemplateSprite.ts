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
// Rasterizer.ts still owns the prop canonicalizer (validates + fills defaults
// + stable key order). Its old foreignObject fns are dead and removed by a
// later sweep; only `canonicalizeProps` is imported here.
import { canonicalizeProps } from "../templates/Rasterizer";
import { rasterizeSvg } from "../templates/svgRaster";

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
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  private onLoaded: (() => void) | null;
  private disposed = false;

  constructor(init: TemplateSpriteInit) {
    this.layerId = init.layerId;
    this.templateId = init.templateId;
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
  update(view: TemplateView, tInLayerUs: number, durationUs: number): void {
    if (this.disposed || !this.template) return;

    // Transforms first, every tick, BEFORE the frame no-op below: a
    // transform-only change with an unchanged frame must still take.
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

    const durationFrames = templateDurationFrames(durationUs, this.fpsNum, this.fpsDen);
    const frame = Math.min(
      durationFrames - 1,
      frameIndexInLayer(tInLayerUs, this.fpsNum, this.fpsDen),
    );

    // v1: raster at the template's natural size. The Pixi sprite's scale
    // handles display sizing — accept upscale softness (matches prior
    // behavior). `durationFrames` is in the key so a trim changes the key
    // (the numeral sequence depends on duration).
    const [renderW, renderH] = this.template.manifest.size;
    const cacheKey = templateFrameCacheKey({
      templateId: this.template.manifest.id,
      version: this.template.manifest.version,
      canonicalProps: canonical,
      renderW,
      renderH,
      fpsNum: this.fpsNum,
      fpsDen: this.fpsDen,
      durationFrames,
    });

    // Same (key, frame) already bound/in-flight → nothing to do.
    if (cacheKey === this.targetCacheKey && frame === this.targetFrame) return;
    this.targetCacheKey = cacheKey;
    this.targetFrame = frame;

    const cached = sharedTemplateFrameCache.getFrame(cacheKey, frame);
    if (cached) {
      // Synchronous hit: bind in this paint, no onLoaded (would be churn).
      this.bindBitmap(cached);
      return;
    }

    const tSec = frameTimeSec(frame, this.fpsNum, this.fpsDen);
    const durationSec = durationUs / US_PER_SEC;
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
      // Hand the bitmap to the cache regardless of whether we still want it —
      // it's correct work and another sprite / a later seek may reuse it.
      // `setFrame` owns the bitmap's lifetime from here (LRU close-on-evict).
      sharedTemplateFrameCache.setFrame(cacheKey, frame, bitmap);
      // A later `update` may have superseded this request while we awaited;
      // only bind if we still want exactly this (cacheKey, frame).
      if (this.disposed) return;
      if (this.targetCacheKey !== cacheKey || this.targetFrame !== frame) return;
      this.bindBitmap(bitmap);
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
        // destroy(false) frees the Pixi Texture wrapper but leaves the
        // underlying ImageBitmap alone — the shared frame cache may still
        // hand it to another sprite. The cache owns the bitmap's close().
        this.texture.destroy(false);
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
