// PixiJS-backed composition root. Owns the scene graph and the
// per-frame composite. Does NOT own the PIXI `Application` lifecycle —
// the host (`@pixi/react`'s `<Application>` for preview, or a Worker
// shell for export) is responsible for constructing and destroying
// the Application. The Compositor receives an already-initialized
// `Application` reference at construction.
//
// Plan: docs/pixi-renderer-plan.md

import { Application, Container, Texture } from "pixi.js";

import type { LayerSummary, MediaSummary, ProjectSummary } from "../ipc";
import { SourceDecoderPool, type SourceHandle } from "./decoder/SourceDecoderPool";
import { VideoClipSprite } from "./sprite/VideoClipSprite";

export interface CompositorInit {
  /// Pre-initialized PIXI Application. The Compositor adds its stage
  /// `Container` to `app.stage` and reads `app.renderer`. Lifecycle of
  /// the Application is the host's responsibility.
  app: Application;
  /// Project composition dimensions in pixels.
  width: number;
  height: number;
  /// Preview can prefer interactive over throughput; export wants
  /// throughput. Currently advisory.
  mode: "preview" | "export";
  /// Resolver for the asset URL of a media item's master proxy.
  proxyAssetUrl: (mediaId: string) => string | null;
  /// Lookup for media-side codec dimensions.
  mediaById: (mediaId: string) => MediaSummary | undefined;
}

interface ActiveClip {
  layerId: string;
  mediaId: string;
  source: SourceHandle;
  sprite: VideoClipSprite;
}

export class Compositor {
  readonly app: Application;
  readonly stage: Container;
  readonly pool: SourceDecoderPool;
  private clips = new Map<string, ActiveClip>();
  private projectSummary: ProjectSummary | null = null;
  private proxyAssetUrl: (mediaId: string) => string | null;
  private mediaById: (mediaId: string) => MediaSummary | undefined;
  private compositionWidth = 1920;
  private compositionHeight = 1080;
  private disposed = false;

  constructor(init: CompositorInit) {
    this.app = init.app;
    this.stage = new Container();
    this.pool = new SourceDecoderPool();
    this.proxyAssetUrl = init.proxyAssetUrl;
    this.mediaById = init.mediaById;
    this.compositionWidth = init.width;
    this.compositionHeight = init.height;
    this.app.stage.addChild(this.stage);
  }

  /// Replace the project snapshot. Sprites for layers that have
  /// disappeared get evicted; new layers will appear on the next
  /// `compositeFrame()` if active.
  setProject(summary: ProjectSummary | null): void {
    this.projectSummary = summary;
    if (!summary) {
      for (const c of this.clips.values()) c.sprite.dispose();
      this.clips.clear();
      return;
    }
    const livingLayerIds = new Set<string>();
    for (const t of summary.tracks) {
      for (const l of t.layers) livingLayerIds.add(l.id);
    }
    for (const [layerId, c] of this.clips) {
      if (!livingLayerIds.has(layerId)) {
        c.sprite.dispose();
        this.clips.delete(layerId);
      }
    }
  }

  /// Composite one frame at composition-time `tUs`.
  compositeFrame(tUs: number): void {
    if (this.disposed) return;
    if (!this.projectSummary) {
      this.app.renderer.render(this.app.stage);
      return;
    }

    this.stage.removeChildren();

    let z = 0;
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        if (layer.params.kind !== "VideoClip") continue;
        if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
        const clip = this.ensureClip(layer);
        if (!clip) continue;
        this.updateClip(clip, layer, tUs, z++);
        // Defense in depth: don't add a sprite to the stage while its
        // texture is still `Texture.EMPTY`. PixiJS v8's batched
        // renderer shader-compile path has crashed on empty placeholder
        // textures in some WebView2 / ANGLE configurations. Skipping
        // the addChild means an active-but-not-yet-decoded clip simply
        // renders nothing on its slot, which then naturally pops in
        // once the first VideoFrame lands.
        if (clip.sprite.sprite.texture !== Texture.EMPTY) {
          this.stage.addChild(clip.sprite.sprite);
        }
      }
    }

    this.app.renderer.render(this.app.stage);
  }

  /// Tell the decoder pool which time we're at so it can manage
  /// lookahead. Called by PlaybackEngine on every tick.
  setAnchorTime(tUs: number): void {
    if (!this.projectSummary) return;
    for (const c of this.clips.values()) {
      const layer = this.findLayer(c.layerId);
      if (!layer || layer.params.kind !== "VideoClip") continue;
      const layerLocalUs = tUs - layer.t_start_us;
      const srcTUs = layer.params.src_in_us + layerLocalUs;
      void c.source.requestFrameAt(srcTUs);
    }
  }

  /// Release every sprite + decoder + the stage container. Does NOT
  /// touch the Application — the host owns its lifecycle.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clips.values()) c.sprite.dispose();
    this.clips.clear();
    this.pool.dispose();
    try {
      this.app.stage.removeChild(this.stage);
      this.stage.destroy({ children: true });
    } catch {
      // App may already be destroyed by the host; ignore.
    }
  }

  // ============================================================
  // private
  // ============================================================

  private findLayer(layerId: string): LayerSummary | undefined {
    if (!this.projectSummary) return undefined;
    for (const t of this.projectSummary.tracks) {
      for (const l of t.layers) {
        if (l.id === layerId) return l;
      }
    }
    return undefined;
  }

  private ensureClip(layer: LayerSummary): ActiveClip | null {
    if (layer.params.kind !== "VideoClip") return null;
    const existing = this.clips.get(layer.id);
    if (existing) return existing;
    const mediaId = layer.params.media_id;
    const proxyUrl = this.proxyAssetUrl(mediaId);
    if (!proxyUrl) return null;
    const source = this.pool.acquire({ mediaId, proxyAssetUrl: proxyUrl });
    void source.ensureReady().catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`Compositor: ensureReady ${mediaId} failed`, e);
    });
    const sprite = new VideoClipSprite({ layerId: layer.id, mediaId });
    const clip: ActiveClip = { layerId: layer.id, mediaId, source, sprite };
    this.clips.set(layer.id, clip);
    return clip;
  }

  private updateClip(clip: ActiveClip, layer: LayerSummary, tUs: number, z: number): void {
    if (layer.params.kind !== "VideoClip") return;
    const params = layer.params;

    const layerLocalUs = tUs - layer.t_start_us;
    const srcTUs = params.src_in_us + layerLocalUs;

    const frame = clip.source.ring.frameAt(srcTUs);
    if (frame) {
      clip.sprite.updateFrame(frame);
    }

    const media = this.mediaById(params.media_id);
    const nativeW = media?.width ?? this.compositionWidth;
    const nativeH = media?.height ?? this.compositionHeight;
    clip.sprite.sprite.width = nativeW * params.scale_x;
    clip.sprite.sprite.height = nativeH * params.scale_y;
    clip.sprite.sprite.position.set(params.x, params.y);
    clip.sprite.sprite.alpha = params.opacity;
    if (params.flip_h) clip.sprite.sprite.scale.x = -Math.abs(clip.sprite.sprite.scale.x);
    if (params.flip_v) clip.sprite.sprite.scale.y = -Math.abs(clip.sprite.sprite.scale.y);

    clip.sprite.sprite.zIndex = z;
  }
}
