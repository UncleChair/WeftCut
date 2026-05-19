// PixiJS-backed composition root. Owns the `Application`, the scene
// graph, and the per-frame composite. Same module serves both preview
// (main thread, mounts against HTMLCanvasElement) and export (Worker,
// mounts against OffscreenCanvas).
//
// Plan: docs/pixi-renderer-plan.md

import { Application, Container, Texture } from "pixi.js";

import type { LayerSummary, MediaSummary, ProjectSummary } from "../ipc";
import { SourceDecoderPool, type SourceHandle } from "./decoder/SourceDecoderPool";
import { VideoClipSprite } from "./sprite/VideoClipSprite";

export interface CompositorInit {
  /// Canvas to render into. `HTMLCanvasElement` on the main thread for
  /// preview; `OffscreenCanvas` inside the export Worker.
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /// Project composition dimensions in pixels. Internal renderer size
  /// stays at project resolution regardless of how the canvas is
  /// CSS-scaled in preview.
  width: number;
  height: number;
  /// Preview can prefer interactive over throughput; export wants
  /// throughput. Currently advisory — both modes initialize the same
  /// Application.
  mode: "preview" | "export";
  /// Resolver for the asset URL of a media item's master proxy.
  /// Caller supplies because the projectStore is a React/Zustand
  /// hookline that the Compositor doesn't reach for directly.
  proxyAssetUrl: (mediaId: string) => string | null;
  /// Lookup for media-side codec dimensions (we trust the demuxer for
  /// the actual stream, but the project canvas dims drive layout).
  mediaById: (mediaId: string) => MediaSummary | undefined;
}

interface ActiveClip {
  /// Layer id this clip renders.
  layerId: string;
  /// MediaId backing the clip.
  mediaId: string;
  /// Source-decoder pool handle for this media.
  source: SourceHandle;
  /// PixiJS sprite + container slot.
  sprite: VideoClipSprite;
}

export class Compositor {
  readonly app: Application;
  readonly stage: Container;
  readonly pool: SourceDecoderPool;
  private mounted = false;
  private clips = new Map<string, ActiveClip>();
  private projectSummary: ProjectSummary | null = null;
  private proxyAssetUrl: (mediaId: string) => string | null;
  private mediaById: (mediaId: string) => MediaSummary | undefined;
  private compositionWidth = 1920;
  private compositionHeight = 1080;
  private disposed = false;

  constructor(init: CompositorInit) {
    this.app = new Application();
    this.stage = new Container();
    this.pool = new SourceDecoderPool();
    this.proxyAssetUrl = init.proxyAssetUrl;
    this.mediaById = init.mediaById;
    this.compositionWidth = init.width;
    this.compositionHeight = init.height;
  }

  /// Initialize the underlying renderer. Must be awaited before any
  /// `compositeFrame()` call.
  async mount(init: CompositorInit): Promise<void> {
    await this.app.init({
      canvas: init.canvas as HTMLCanvasElement,
      width: init.width,
      height: init.height,
      antialias: true,
      backgroundAlpha: 1,
      background: 0x000000,
    });
    this.app.stage.addChild(this.stage);
    this.mounted = true;
  }

  /// Replace the project snapshot. Sprites for layers that have
  /// disappeared get evicted; new layers will appear on the next
  /// `compositeFrame()` if active.
  setProject(summary: ProjectSummary | null): void {
    this.projectSummary = summary;
    if (!summary) {
      // Nothing to render. Tear down active clips so we don't keep
      // GPU memory pinned.
      for (const c of this.clips.values()) c.sprite.dispose();
      this.clips.clear();
      return;
    }
    // Drop clips whose layer no longer exists.
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

  /// Composite one frame at composition-time `tUs`. Idempotent and
  /// safe to call at any cadence.
  compositeFrame(tUs: number): void {
    if (!this.mounted || this.disposed) return;
    if (!this.projectSummary) {
      this.app.renderer.render(this.app.stage);
      return;
    }

    // Walk tracks in z-order (bottom-up; first track is bottommost).
    // We rebuild the stage's child list each frame so the order
    // matches the project's track order even if mid-frame structural
    // edits happened.
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
        this.stage.addChild(clip.sprite.sprite);
      }
    }

    this.app.renderer.render(this.app.stage);
  }

  /// Tell the decoder pool which time we're at so it can manage
  /// lookahead. Called by PlaybackEngine on every tick.
  setAnchorTime(tUs: number): void {
    for (const c of this.clips.values()) {
      // Layer-local time for this clip = tUs - t_start_us.
      // We need the LayerSummary to compute it accurately; if the
      // project disappeared mid-call, skip.
      const layer = this.findLayer(c.layerId);
      if (!layer || layer.params.kind !== "VideoClip") continue;
      const layerLocalUs = tUs - layer.t_start_us;
      const srcInUs = layer.params.src_in_us;
      const srcTUs = srcInUs + layerLocalUs;
      // Async: request frames around this anchor. Errors propagate
      // through the source's error callback; we don't await here
      // because the loop is hot.
      void c.source.requestFrameAt(srcTUs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clips.values()) c.sprite.dispose();
    this.clips.clear();
    this.pool.dispose();
    this.app.destroy(true, { children: true, texture: true });
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
    if (!proxyUrl) return null; // Proxy not ready; skip this frame.
    const source = this.pool.acquire({ mediaId, proxyAssetUrl: proxyUrl });
    // Lazy ensureReady is async; sprite paints EMPTY texture until
    // first decoded frame arrives. The async kick is fire-and-forget
    // here; the next composite tick picks up the frame.
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

    // Layer-local time → source PTS within the clip's src window.
    const layerLocalUs = tUs - layer.t_start_us;
    const srcTUs = params.src_in_us + layerLocalUs;

    // Pull a decoded frame at srcTUs from the ring.
    const frame = clip.source.ring.frameAt(srcTUs);
    if (frame) {
      // PixiJS v8: Texture.from accepts any TexImageSource including
      // VideoFrame. We let PixiJS dispose the previous texture.
      const next = Texture.from(frame);
      clip.sprite.sprite.texture = next;
    }

    // Sprite position + scale from the static LayerSummary view.
    // Real keyframe interpolation lands once the IPC ships full
    // AnimTrack<T> on top of LayerSummary; today this picks up the
    // Rust-side evaluation at the IPC update tick.
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
