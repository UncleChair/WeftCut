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
  /// Most recent composition time we composited at. Used by
  /// `scheduleRepaint()` for async-arrived frames when the playhead
  /// is paused (no rAF tick incoming).
  private lastTUs = 0;
  private repaintScheduled = false;

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

  /// Coalesced repaint at the current playhead time. Called by
  /// SourceHandle.onFirstFrame so the canvas updates as soon as a
  /// decoded frame is available, even when the playback engine isn't
  /// actively ticking (paused state).
  scheduleRepaint(): void {
    if (this.disposed) return;
    if (this.repaintScheduled) return;
    this.repaintScheduled = true;
    requestAnimationFrame(() => {
      this.repaintScheduled = false;
      if (this.disposed) return;
      this.setAnchorTime(this.lastTUs);
      this.compositeFrame(this.lastTUs);
    });
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
  ///
  /// We do NOT call `app.renderer.render()` here. PixiJS v8's
  /// `TickerPlugin` auto-renders the stage every frame (default
  /// `autoStart: true`), and @pixi/react's Application reconciler is
  /// wired against that ticker. compositeFrame's job is to mutate
  /// the scene graph; the ticker presents it.
  compositeFrame(tUs: number): void {
    if (this.disposed) return;
    this.lastTUs = tUs;
    if (!this.projectSummary) return;

    const prevChildCount = this.stage.children.length;
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
        // Skip sprites still on Texture.EMPTY. PixiJS v8's batched
        // renderer has crashed on empty placeholder textures in some
        // WebView2 / ANGLE configurations. Once the first VideoFrame
        // arrives, `updateClip` swaps in an `ImageSource`-backed
        // texture and the sprite naturally pops in.
        if (clip.sprite.sprite.texture !== Texture.EMPTY) {
          this.stage.addChild(clip.sprite.sprite);
        }
      }
    }
    // One-shot diagnostic the first time we transition from "stage
    // has no children" to "stage has some" so the user can confirm
    // sprites are reaching the scene graph.
    if (prevChildCount === 0 && this.stage.children.length > 0) {
      const s = this.stage.children[0] as unknown as {
        x: number;
        y: number;
        scale: { x: number; y: number };
        alpha: number;
        texture: { orig: { width: number; height: number } };
        visible: boolean;
      };
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] first sprite added to stage: ` +
          `pos=(${s.x},${s.y}) scale=(${s.scale.x},${s.scale.y}) ` +
          `alpha=${s.alpha} visible=${s.visible} ` +
          `tex=${s.texture.orig.width}×${s.texture.orig.height} ` +
          `compStage.children=${this.stage.children.length} ` +
          `appStage.children=${this.app.stage.children.length}`,
      );
    }
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
    if (!proxyUrl) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] no proxy URL for media ${mediaId} (clip ${layer.id})`);
      return null;
    }
    const source = this.pool.acquire({ mediaId, proxyAssetUrl: proxyUrl });
    // Subscribe to the first-frame notification BEFORE kicking off
    // ensureReady so we don't miss the synchronous-fire case if the
    // source happened to be pre-warmed by another clip referencing
    // the same media.
    source.onFirstFrame(() => {
      this.scheduleRepaint();
    });
    // Kick off the async ensureReady. After it resolves, the next
    // setAnchorTime() tick (or first decoded frame's onFirstFrame
    // callback) will paint.
    void source.ensureReady().catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[weftcut/pixi] ensureReady ${mediaId} failed`, e);
    });
    const sprite = new VideoClipSprite({ layerId: layer.id, mediaId });
    const clip: ActiveClip = { layerId: layer.id, mediaId, source, sprite };
    this.clips.set(layer.id, clip);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] clip ${layer.id} → media ${mediaId} attached`);
    return clip;
  }

  private updateClip(clip: ActiveClip, layer: LayerSummary, tUs: number, z: number): void {
    if (layer.params.kind !== "VideoClip") return;
    const params = layer.params;

    const layerLocalUs = tUs - layer.t_start_us;
    const srcTUs = params.src_in_us + layerLocalUs;

    // Upload the current frame BEFORE adjusting transforms so the
    // sprite's natural size reflects the real texture dimensions.
    const frame = clip.source.ring.frameAt(srcTUs);
    if (frame) {
      clip.sprite.updateFrame(frame);
    }

    // (Per-tick clip diagnostic removed; rAF tick milestones removed.
    // Renderer is in steady state — bring them back only when a new
    // class of bug surfaces.)

    // Use sprite.scale directly. The width/height setters in PixiJS v8
    // compute scale from `texture.orig.width/height`, so setting them
    // while the texture is still `Texture.EMPTY` (1×1) leaves the
    // sprite with scale-as-pixel-count — when the real video texture
    // lands later, the sprite renders thousands of times larger than
    // intended. With scale alone, the sprite naturally adapts to
    // whatever texture is bound: scale 1.0 = texture-native size.
    //
    // Caveat for v1: the master proxy is capped at 1080p height, so
    // sources whose native dim > 1080p actually render slightly
    // smaller than their nominal source size. Source ≤ 1080p (the
    // common case) is unaffected. A future fix can multiply by
    // `media.width / texture.width` to recover source-pixel
    // semantics, but that needs the texture's actual size which we
    // only know after `updateFrame()`.
    clip.sprite.sprite.scale.set(
      params.scale_x * (params.flip_h ? -1 : 1),
      params.scale_y * (params.flip_v ? -1 : 1),
    );
    clip.sprite.sprite.position.set(params.x, params.y);
    clip.sprite.sprite.alpha = params.opacity;
    clip.sprite.sprite.zIndex = z;
  }
}
