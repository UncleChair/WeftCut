// PixiJS-backed composition root. Owns the scene graph and the
// per-frame composite. Does NOT own the PIXI `Application` lifecycle —
// the host (`@pixi/react`'s `<Application>` for preview, or a Worker
// shell for export) is responsible for constructing and destroying
// the Application. The Compositor receives an already-initialized
// `Application` reference at construction.
//
// Plan: docs/pixi-renderer-plan.md

import { Application, Container, Texture } from "pixi.js";

import { lastFrameAnchorUs as computeLastFrameStartUs, snapFrameFloor } from "../frames";
import type { LayerSummary, MediaSummary, ProjectSummary } from "../ipc";
import { AudioMixer } from "./audio/AudioMixer";
import {
  SourceDecoderPool,
  type DecoderHandle,
  type DecoderPool,
} from "./decoder/SourceDecoderPool";
import { ColorSprite } from "./sprite/ColorSprite";
import { ImageOverlaySprite } from "./sprite/ImageOverlaySprite";
import { SubtitlesSprite } from "./sprite/SubtitlesSprite";
import { TemplateSprite } from "./sprite/TemplateSprite";
import { TextSprite } from "./sprite/TextSprite";
import { VideoClipSprite } from "./sprite/VideoClipSprite";
import { swapKeys } from "./swapKeys";

/// Match the preview ring's default lookahead window. We only use
/// this to warm the next clip boundary; the play() warm-up gate stays
/// smaller so clicking play remains responsive.
const UPCOMING_CLIP_PREWARM_US = 1_000_000;

/// Plain-numbers diagnostic snapshot for the dev `PerfHUD`. All fields
/// are safe to ship to a React state hook every 500ms; no live decoder
/// or sprite references leak out.
export interface CompositorPerfSnapshot {
  /// Most recent `compositeFrame` body duration in ms.
  compositeMsLast: number;
  /// Running peak since the last `resetPerfPeaks()`.
  compositeMsMax: number;
  /// Last preview-only upcoming-clip prewarm attempt. Null before
  /// the first `setAnchorTime()` tick or in export mode.
  upcomingPrewarm: UpcomingClipPrewarmSnapshot | null;
  /// Number of in-flight no-flash source swaps (bridge→proxy). Non-zero
  /// during the overlap window when a clip is being repointed to a
  /// freshly-built proxy; explains transient extra decode cost.
  swapsInFlight: number;
  clips: Array<{
    layerId: string;
    mediaId: string;
    /// `VideoDecoder.decodeQueueSize` at sample time.
    decodeQueueSize: number;
    /// Number of frames currently cached in the per-clip ring.
    ringSize: number;
    /// PTS of the ring's earliest cached frame; null if the ring is empty.
    ringFirstPtsUs: number | null;
    /// PTS of the ring's latest frame; null if the ring is empty.
    ringLastPtsUs: number | null;
    /// Cumulative frames decoded for this clip; the HUD diffs it into fps.
    decodedFrameCount: number;
    /// True if this handle has downgraded to software decode.
    downgraded: boolean;
    /// True when the ring's lookahead window is satisfied (decoder not
    /// running behind the playhead).
    lookaheadFull: boolean;
  }>;
}

export interface UpcomingClipPrewarmSnapshot {
  /// Composition time that drove the prewarm decision.
  anchorUs: number;
  /// Future window scanned for the next clip boundary.
  windowUs: number;
  /// Start time of the nearest future VideoClip in the window.
  /// Null means no upcoming VideoClip was found.
  nextStartUs: number | null;
  clips: Array<{
    layerId: string;
    mediaId: string;
    /// True if a DecoderHandle existed or was created and
    /// `requestFrameAt(src_in_us)` was issued.
    requested: boolean;
    decodeQueueSize: number;
    ringSize: number;
    ringLastPtsUs: number | null;
  }>;
}

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
  /// Used for VideoClip layers (decoded via WebCodecs).
  proxyAssetUrl: (mediaId: string) => string | null;
  /// Resolver for the asset URL of a media item's ORIGINAL file.
  /// Used for ImageOverlay layers (loaded via `createImageBitmap`).
  /// May return the same URL as `proxyAssetUrl` for media kinds
  /// that don't get proxied (images, audio).
  originalAssetUrl: (mediaId: string) => string | null;
  /// Resolver for a media item's ffprobe-derived source color tags
  /// (matrix/range/primaries/transfer), mapped to WebCodecs. Applied to the
  /// preview decode ONLY when the decoded URL is the ORIGINAL file (see the
  /// `=== originalAssetUrl` gate at each handle site) so 601/full-range
  /// originals preview with their real color; a proxy is a re-encode and
  /// gets the resolution default instead. Returns undefined when nothing maps.
  sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined;
  /// Lookup for media-side codec dimensions.
  mediaById: (mediaId: string) => MediaSummary | undefined;
  /// Optional decoder pool override. Defaults to a preview-tuned
  /// `SourceDecoderPool` with per-frame lookahead + ring eviction. The
  /// export Worker injects an `ExportDecoderPool` that drives decoding
  /// in batched chunks instead.
  pool?: DecoderPool;
}

interface ActiveClip {
  layerId: string;
  mediaId: string;
  source: DecoderHandle;
  sprite: VideoClipSprite;
  /// The `proxyAssetUrl` the current `source` was built from. When the
  /// resolver later returns a different URL for this media — the Plan-2
  /// bridge's instant original being replaced by a freshly-built proxy —
  /// `ensureClip` starts a no-flash overlap-swap to the new URL.
  builtFromUrl: string;
  /// Diagnostic edge-trigger: true if the last `updateClip` call
  /// found `ring.frameAt(srcTUs)` returned null. Used so the
  /// `frameAt → null` log fires once per transition rather than
  /// every rAF tick during the null window.
  loggedNull: boolean;
}

/// An in-flight no-flash source-swap (preview only). Holds a SECOND decoder
/// handle on the new URL until its ring has the current visible frame, then
/// atomically repoints `ActiveClip.source` to it and releases the original.
/// Keyed in `Compositor.swaps` by the clip's real layerId.
interface SwapState {
  handle: DecoderHandle;
  /// Pool key of the synthetic swap handle (`${layerId}#swap`).
  swapLayerId: string;
  /// The URL the swap handle is decoding (the freshly-built proxy).
  newUrl: string;
  /// Bounded poll driving the swap to completion (cleared on done/abandon).
  timer: ReturnType<typeof setInterval> | null;
  /// Safety deadline: abandon the swap if it never produces the frame.
  deadline: ReturnType<typeof setTimeout> | null;
}

interface ActiveImage {
  layerId: string;
  mediaId: string;
  sprite: ImageOverlaySprite;
}

interface ActiveColor {
  layerId: string;
  sprite: ColorSprite;
}

interface ActiveText {
  layerId: string;
  sprite: TextSprite;
}

interface ActiveTemplate {
  layerId: string;
  templateId: string;
  sprite: TemplateSprite;
}

interface ActiveSubtitles {
  layerId: string;
  sprite: SubtitlesSprite;
}

interface ActiveAudio {
  layerId: string;
  mediaId: string;
  mixer: AudioMixer;
}

export class Compositor {
  readonly app: Application;
  readonly stage: Container;
  readonly pool: DecoderPool;
  private clips = new Map<string, ActiveClip>();
  private images = new Map<string, ActiveImage>();
  private colors = new Map<string, ActiveColor>();
  private texts = new Map<string, ActiveText>();
  private templates = new Map<string, ActiveTemplate>();
  /// Export-only: pre-rasterized Template-layer frames injected by the export
  /// Worker (`layerId → ImageBitmap[]`, indexed by comp-frame). When present
  /// for a layer, `updateTemplate` hands the array to `TemplateSprite.update`,
  /// which binds by index synchronously (no DOM harness — the Worker has none).
  /// Empty in preview mode; the sprite's harness/cache path runs instead.
  private templateFrames = new Map<string, readonly ImageBitmap[]>();
  private subtitles = new Map<string, ActiveSubtitles>();
  private audios = new Map<string, ActiveAudio>();
  /// In-flight no-flash source-swaps, keyed by the clip's real layerId.
  /// Preview-only; empty in export mode (export URLs are fixed per run).
  private swaps = new Map<string, SwapState>();
  /// Host element where AudioMixers append their hidden `<audio>`
  /// elements. Null in export mode (no DOM). The Compositor owns
  /// lifecycle; mixers append / remove themselves under this host.
  private audioHost: HTMLDivElement | null;
  /// Preview or export. Affects audio setup + (future) hardware-
  /// accel preferences.
  private mode: "preview" | "export";
  private projectSummary: ProjectSummary | null = null;
  /// O(1) layer lookup by id. Rebuilt in `setProject` whenever the
  /// project snapshot changes; read on every tick from `setAnchorTime`
  /// and `hasLookaheadAt`. Without this map those would be O(layers)
  /// per active clip per tick — quadratic for long timelines.
  private layerById = new Map<string, LayerSummary>();
  private proxyAssetUrl: (mediaId: string) => string | null;
  private originalAssetUrl: (mediaId: string) => string | null;
  private sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined;
  private mediaById: (mediaId: string) => MediaSummary | undefined;
  private compositionWidth = 1920;
  private compositionHeight = 1080;
  private disposed = false;
  /// Most recent composition time we composited at. Used by
  /// `scheduleRepaint()` for async-arrived frames when the playhead
  /// is paused (no rAF tick incoming).
  private lastTUs = 0;
  private repaintScheduled = false;
  /// Engine's playing state — written by PlaybackEngine on play /
  /// pause / seek. AudioMixers consult this to decide whether to
  /// `play()` or `pause()` their `<audio>` elements.
  private playing = false;
  /// When true, `setAnchorTime` is a no-op. PlaybackEngine flips this
  /// during rapid scrub so the decoder isn't hammered with a new
  /// target on every mouse-move event; the rAF loop keeps painting
  /// whatever frame is already in the ring (approximate but immediate
  /// visual feedback). Cleared after the scrub coalescer fires its
  /// stable-target callback, at which point the decoder catches up.
  private scrubbing = false;
  /// Suspended state — both `compositeFrame` and `setAnchorTime` are
  /// no-ops while true. Used by the export flow to release the
  /// preview's VideoDecoders so the export Worker's decoder doesn't
  /// fight for the hardware decode slot. On resume the next
  /// `compositeFrame` lazily re-acquires fresh handles via
  /// `ensureClip`.
  private suspended = false;
  /// Raw fps rational so `setAnchorTime` / `compositeFrame` can snap `tUs`
  /// to project-frame boundaries with exact rational arithmetic via
  /// `snapFrameFloor`. This matters on a 60 Hz display with a 60fps source
  /// in a 30fps project: snapping gives one consistent project-frame's
  /// worth of source every two rAFs (matching export) instead of rAF
  /// jitter. A pre-rounded frame duration (33_333 µs for 30 fps, vs
  /// 33_333.333… exact) accumulates ~1 µs of drift per frame; by frame 299
  /// (last frame of a 10 s 30 fps comp) the cumulative error is large
  /// enough to drop the lookup into the previous frame's source-PTS
  /// interval and paint the wrong frame. Always use
  /// `snapFrameFloor(tUs, this.fpsNum, this.fpsDen)`, never a pre-rounded
  /// `Math.floor(tUs / frameDur) * frameDur`.
  private fpsNum = 30;
  private fpsDen = 1;
  /// Diagnostic counters for the dev `PerfHUD`. `compositeMsLast` is
  /// the most recent `compositeFrame` duration; `compositeMsMax` is
  /// the running max since last `resetPerfPeaks()`. Updated by
  /// `compositeFrame` itself; reading is free.
  private compositeMsLast = 0;
  private compositeMsMax = 0;
  private upcomingPrewarm: UpcomingClipPrewarmSnapshot | null = null;

  constructor(init: CompositorInit) {
    this.app = init.app;
    this.stage = new Container();
    this.pool = init.pool ?? new SourceDecoderPool();
    this.proxyAssetUrl = init.proxyAssetUrl;
    this.originalAssetUrl = init.originalAssetUrl;
    this.sourceColor = init.sourceColor;
    this.mediaById = init.mediaById;
    this.compositionWidth = init.width;
    this.compositionHeight = init.height;
    this.mode = init.mode;
    this.app.stage.addChild(this.stage);
    // Hidden DOM host for AudioMixer's `<audio>` elements. Only
    // mounted in preview mode — the export Worker has no `document`
    // and routes audio through Rust ffmpeg (P9 final mux). Without
    // this gate the Worker would crash at construction.
    if (this.mode === "preview" && typeof document !== "undefined") {
      this.audioHost = document.createElement("div");
      this.audioHost.setAttribute("data-pixi-audio-host", "");
      this.audioHost.style.display = "none";
      document.body.appendChild(this.audioHost);
    } else {
      this.audioHost = null;
    }
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

  /// PlaybackEngine flips this during rapid scrub. While true,
  /// `setAnchorTime` is suppressed so the decoder isn't churned by a
  /// new target on every mouse-move; the canvas still updates via
  /// `compositeFrame` against whatever is already in the ring.
  setScrubbing(s: boolean): void {
    this.scrubbing = s;
  }

  /// PlaybackEngine writes its current play state here on play /
  /// pause / seek so AudioMixers know whether to call .play() or
  /// .pause() on their `<audio>` elements.
  setMasterPlayState(playing: boolean): void {
    this.playing = playing;
  }

  /// Export-only: install the pre-rasterized Template-layer frames the export
  /// Worker baked on the main thread (`layerId → ImageBitmap[]`, comp-frame
  /// indexed). `updateTemplate` forwards a layer's array to its
  /// `TemplateSprite.update`, which binds by index synchronously instead of
  /// running the DOM capture harness (absent in the Worker). Passing an empty
  /// map (or never calling this) leaves preview's harness/cache path untouched.
  setTemplateFrames(map: Record<string, readonly ImageBitmap[]>): void {
    this.templateFrames.clear();
    for (const [layerId, frames] of Object.entries(map)) {
      this.templateFrames.set(layerId, frames);
    }
  }

  /// Suspend / resume the compositor. While suspended, every
  /// VideoClip's decoder is closed (releasing its hardware decode
  /// slot), audio mixers are torn down, and `compositeFrame` /
  /// `setAnchorTime` are short-circuited so the engine's rAF loop
  /// can't lazily re-create decoders. The next `compositeFrame` after
  /// `setSuspended(false)` re-acquires fresh handles via the normal
  /// `ensureClip` path.
  ///
  /// Used by export: the export Worker's decoder otherwise wedges
  /// when the preview's decoder is still holding a hardware video-
  /// decode slot for the same source.
  setSuspended(s: boolean): void {
    if (this.suspended === s) return;
    this.suspended = s;
    if (s) {
      for (const c of this.clips.values()) c.sprite.dispose();
      this.clips.clear();
      for (const a of this.audios.values()) a.mixer.dispose();
      this.audios.clear();
      this.stage.removeChildren();
      this.cancelAllSwaps();
      this.pool.dispose();
    }
  }

  /// Replace the project snapshot. Sprites for layers that have
  /// disappeared get evicted; new layers will appear on the next
  /// `compositeFrame()` if active.
  setProject(summary: ProjectSummary | null): void {
    this.projectSummary = summary;
    this.layerById.clear();
    if (!summary) {
      for (const c of this.clips.values()) c.sprite.dispose();
      this.clips.clear();
      return;
    }
    // Recompute the frame-snap fps state whenever the project changes
    // (composition fps could differ between projects).
    const c = summary.composition;
    if (c.fps_num > 0 && c.fps_den > 0) {
      this.fpsNum = c.fps_num;
      this.fpsDen = c.fps_den;
    }
    const livingLayerIds = new Set<string>();
    for (const t of summary.tracks) {
      for (const l of t.layers) {
        livingLayerIds.add(l.id);
        this.layerById.set(l.id, l);
      }
    }
    for (const [layerId, c] of this.clips) {
      if (!livingLayerIds.has(layerId)) {
        this.abandonSwap(layerId);
        c.sprite.dispose();
        this.clips.delete(layerId);
      }
    }
    for (const [layerId, i] of this.images) {
      if (!livingLayerIds.has(layerId)) {
        i.sprite.dispose();
        this.images.delete(layerId);
      }
    }
    for (const [layerId, c] of this.colors) {
      if (!livingLayerIds.has(layerId)) {
        c.sprite.dispose();
        this.colors.delete(layerId);
      }
    }
    for (const [layerId, t] of this.texts) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        this.texts.delete(layerId);
      }
    }
    for (const [layerId, t] of this.templates) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        this.templates.delete(layerId);
      }
    }
    for (const [layerId, s] of this.subtitles) {
      if (!livingLayerIds.has(layerId)) {
        s.sprite.dispose();
        this.subtitles.delete(layerId);
      }
    }
    for (const [layerId, a] of this.audios) {
      if (!livingLayerIds.has(layerId)) {
        a.mixer.dispose();
        this.audios.delete(layerId);
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
    if (this.suspended) return;
    this.lastTUs = tUs;
    if (!this.projectSummary) return;
    const compositeStart = performance.now();

    // Snap wall-clock tUs to the project's frame grid. Without this,
    // rAF jitter (real-world ticks at 14–19 ms instead of a clean
    // 16.67 ms) causes high-fps source frames to land in two
    // different rAF windows, showing one source frame twice while
    // skipping its neighbor — the "frame missing" stutter the user
    // saw with 60fps content in a 30fps project. Snapping keeps the
    // frame selection consistent across rAF ticks at the cost of
    // rendering at the project's authored fps rather than the
    // display's native rate (the export behavior, matched).
    //
    // Uses exact-rational `snapFrameFloor` instead of `Math.floor(tUs
    // / this.frameDurUs) * this.frameDurUs`: the pre-rounded
    // `frameDurUs` (33_333 for 30 fps, vs 33_333.333… exact) drifts
    // ~1 µs/frame and by frame 299 of a 10 s 30 fps comp lands ~99 µs
    // BEFORE the last frame's true source-PTS start, paint = the
    // second-to-last frame.
    const tUsSnapped = snapFrameFloor(tUs, this.fpsNum, this.fpsDen);

    const prevChildCount = this.stage.children.length;
    this.stage.removeChildren();

    // First pass: ensure audio mixers for every Audio layer. Skipped
    // entirely in export mode — the Worker has no DOM `<audio>` element
    // to drive, and audio export rides the existing Rust ffmpeg
    // compositor.
    //
    // VideoClip layers are NOT eligible. Mirrors `ir/lower.rs`'s
    // canonical export routing: only `LayerParams::Audio(_)` contributes
    // to the IR's `audio_streams`; VideoClips are video-only. Import's
    // `auto_pair_audio_on_import` (default-on) places a sibling Audio
    // layer on the same media for the audio track. Treating the
    // VideoClip as also audio-bearing here would play the same proxy
    // through two `<audio>` elements — the audible doubling bug.
    if (this.audioHost !== null) {
      for (const track of this.projectSummary.tracks) {
        if (!track.enabled) continue;
        for (const layer of track.layers) {
          if (!layer.enabled) continue;
          if (layer.params.kind === "Audio") {
            const audio = this.ensureAudio(layer);
            if (audio) {
              audio.mixer.updateLayerParams(
                layer.t_start_us,
                layer.params.src_in_us,
              );
              audio.mixer.tick(tUsSnapped, this.playing, layer.t_end_us);
            }
          }
        }
      }
    }

    let z = 0;
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        if (tUsSnapped < layer.t_start_us || tUsSnapped >= layer.t_end_us)
          continue;

        const kind = layer.params.kind;
        if (kind === "VideoClip") {
          const clip = this.ensureClip(layer);
          if (!clip) continue;
          this.updateClip(clip, layer, tUsSnapped, z++);
          // Skip empty-texture sprites — PixiJS v8's batched
          // renderer crashes on the placeholder in some WebView2
          // configs. Once the first VideoFrame lands, updateClip
          // swaps to a real texture and the sprite pops in.
          if (clip.sprite.sprite.texture !== Texture.EMPTY) {
            this.stage.addChild(clip.sprite.sprite);
          }
        } else if (kind === "ImageOverlay") {
          const image = this.ensureImage(layer);
          if (!image) continue;
          this.updateImage(image, layer, tUsSnapped, z++);
          if (image.sprite.sprite.texture !== Texture.EMPTY) {
            this.stage.addChild(image.sprite.sprite);
          }
        } else if (kind === "Color") {
          const color = this.ensureColor(layer);
          if (!color) continue;
          this.updateColor(color, layer, z++);
          this.stage.addChild(color.sprite.graphics);
        } else if (kind === "Text") {
          const text = this.ensureText(layer);
          if (!text) continue;
          this.updateText(text, layer, z++);
          this.stage.addChild(text.sprite.text);
        } else if (kind === "Template") {
          const tmpl = this.ensureTemplate(layer);
          if (!tmpl) continue;
          this.updateTemplate(tmpl, layer, z++, tUsSnapped);
          if (tmpl.sprite.sprite.texture !== Texture.EMPTY) {
            this.stage.addChild(tmpl.sprite.sprite);
          }
        } else if (kind === "Subtitles") {
          const subs = this.ensureSubtitles(layer);
          if (!subs) continue;
          this.updateSubtitles(subs, layer, tUsSnapped, z++);
          if (subs.sprite.sprite.texture !== Texture.EMPTY) {
            this.stage.addChild(subs.sprite.sprite);
          }
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
        // Optional: a Color layer's first sprite is a Graphics-backed fill
        // with no `texture.orig`. Reading it unguarded crashed the composite
        // path for any color-first composition (export AND preview).
        texture?: { orig?: { width: number; height: number } };
        visible: boolean;
      };
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] first sprite added to stage: ` +
          `pos=(${s.x},${s.y}) scale=(${s.scale.x},${s.scale.y}) ` +
          `alpha=${s.alpha} visible=${s.visible} ` +
          `tex=${s.texture?.orig?.width ?? "?"}×${s.texture?.orig?.height ?? "?"} ` +
          `compStage.children=${this.stage.children.length} ` +
          `appStage.children=${this.app.stage.children.length}`,
      );
    }
    // Stamp the duration last — anything that early-returns above
    // (disposed, suspended, no project) is correctly excluded from
    // the average, since the body did no real work.
    this.compositeMsLast = performance.now() - compositeStart;
    if (this.compositeMsLast > this.compositeMsMax) {
      this.compositeMsMax = this.compositeMsLast;
    }
  }

  /// Authored composition duration, in microseconds, from the current
  /// project snapshot. Returns 0 when no project is loaded. Used by
  /// PlaybackEngine to auto-pause once the playhead crosses the end —
  /// the alternative is letting the clock run past the last layer into
  /// the empty black region forever, which is never the user's intent.
  compositionDurationUs(): number {
    return this.projectSummary?.duration_us ?? 0;
  }

  /// Exact-rational "last frame start" for an exclusive `endUs`
  /// boundary, against the current project's fps. Returns 0 if no
  /// project / degenerate fps / `endUs <= 0`.
  ///
  /// Exposed so PlaybackEngine can park the playhead at the start of
  /// the last visible frame on auto-pause without carrying its own
  /// fps state, AND without the `endUs − pre-rounded-frameDurUs` drift
  /// that would otherwise land 1 µs above the true frame-grid value
  /// and confuse downstream lookups.
  lastFrameAnchorUs(endUs: number): number {
    return computeLastFrameStartUs(endUs, this.fpsNum, this.fpsDen);
  }

  /// End of the last piece of *playable material* — the maximum
  /// `t_end_us` across enabled layers in enabled tracks. Returns 0
  /// when no enabled layer exists.
  ///
  /// Distinct from `compositionDurationUs()` only when the user pins
  /// composition duration past the last visible frame (`set_composition
  /// { duration_us: D }`, D > max layer end). For unpinned projects the
  /// two values are equal by construction (see ADR 0005). PlaybackEngine
  /// uses this for auto-pause so the playhead lands on the final visible
  /// frame even when a pinned duration would otherwise carry the clock
  /// into a black tail.
  playableEndUs(): number {
    if (!this.projectSummary) return 0;
    let end = 0;
    for (const t of this.projectSummary.tracks) {
      if (!t.enabled) continue;
      for (const l of t.layers) {
        if (!l.enabled) continue;
        if (l.t_end_us > end) end = l.t_end_us;
      }
    }
    return end;
  }

  /// True if every active VideoClip layer at composition time `tUs`
  /// has a decoded frame at its source-time mapping AND at least
  /// `minLookaheadUs` of additional ring contents past it.
  ///
  /// Used by `PlaybackEngine.play()` to defer the clock start until
  /// the decoder pipeline has produced enough output to absorb its
  /// own first-frame warm-up latency. Without this gate, hardware-
  /// decoder init burns ~50–200 ms on cold start while the clock
  /// races ahead — the painter clamps to the latest-emitted frame
  /// and the user sees a stutter for the first dozen frames.
  ///
  /// Returns true immediately when no VideoClip is active (e.g. the
  /// playhead is over an empty region, or only non-decoded layers).
  hasLookaheadAt(tUs: number, minLookaheadUs: number): boolean {
    if (!this.projectSummary) return true;
    for (const c of this.clips.values()) {
      const layer = this.layerById.get(c.layerId);
      if (!layer || layer.params.kind !== "VideoClip") continue;
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
      const layerLocalUs = tUs - layer.t_start_us;
      const srcTUs = layer.params.src_in_us + layerLocalUs;
      const ring = c.source.ring;
      if (!ring.containsPts(srcTUs)) return false;
      const last = ring.lastPtsUs();
      if (last === null || last < srcTUs + minLookaheadUs) return false;
    }
    return true;
  }

  /// Tell the decoder pool which time we're at so it can manage
  /// lookahead. Called by PlaybackEngine on every tick.
  ///
  /// Suppressed while `scrubbing` is true — fast scrub events would
  /// otherwise issue a new decoder target every mouse-move, forcing
  /// the decoder to constantly re-prioritize and never produce a
  /// stable frame at any one position. The ScrubCoalescer in
  /// PlaybackEngine clears `scrubbing` after the debounce expires
  /// and calls setAnchorTime once with the final target.
  setAnchorTime(tUs: number): void {
    if (!this.projectSummary) return;
    if (this.scrubbing) return;
    if (this.suspended) return;
    // Use the same exact-rational snap as `compositeFrame` so the
    // decoder's anchor matches the frame we're actually painting.
    // See `snapFrameFloor` and the long comment in `compositeFrame`
    // for why the pre-rounded `frameDurUs` is not safe here.
    const tUsSnapped = snapFrameFloor(tUs, this.fpsNum, this.fpsDen);
    for (const c of this.clips.values()) {
      const layer = this.layerById.get(c.layerId);
      if (!layer || layer.params.kind !== "VideoClip") continue;
      // Mirror compositeFrame's window check. `this.clips` retains every
      // clip that's ever been active (it's only pruned in `setProject`
      // when a layer is deleted); without this filter every accumulated
      // entry would fire `requestFrameAt` on each tick with srcTUs
      // computed from a clip not under the playhead, churning the
      // decoder + ring with anchors for time-regions the user isn't
      // viewing. With per-layer decoders (each clip owns its own
      // SourceHandle / VideoDecoder / FrameRing) the "N clips of one
      // mediaId fight over one decoder" failure mode is gone, but
      // wasting work on out-of-window clips is still pointless.
      if (tUsSnapped < layer.t_start_us || tUsSnapped >= layer.t_end_us) continue;
      // Stale handle (pool reclaimed during idle): skip this tick.
      // The next `compositeFrame` runs immediately after this and its
      // `ensureClip` swaps in a fresh source; the tick after that
      // will see the revived handle here.
      if (c.source.disposed) continue;
      const layerLocalUs = tUsSnapped - layer.t_start_us;
      const srcTUs = layer.params.src_in_us + layerLocalUs;
      void c.source.requestFrameAt(srcTUs);
    }
    if (this.mode === "preview") {
      this.prewarmUpcomingClipBoundary(tUsSnapped);
    }
  }

  /// Plain-number perf snapshot for the dev `PerfHUD`. Read whenever
  /// (cheap — no allocation on the hot path; numbers come from fields
  /// already updated by `compositeFrame`). Per-clip stats are filtered
  /// to active (non-disposed) handles only, so a recently-swept entry
  /// doesn't appear with bogus zeros.
  getPerfSnapshot(): CompositorPerfSnapshot {
    const clips: CompositorPerfSnapshot["clips"] = [];
    for (const c of this.clips.values()) {
      if (c.source.disposed) continue;
      const ring = c.source.ring;
      clips.push({
        layerId: c.layerId,
        mediaId: c.mediaId,
        decodeQueueSize: c.source.decodeQueueSize?.() ?? 0,
        ringSize: ring.size(),
        ringFirstPtsUs: ring.firstPtsUs(),
        ringLastPtsUs: ring.lastPtsUs(),
        decodedFrameCount: c.source.decodedFrameCount?.() ?? 0,
        downgraded: c.source.isDowngraded?.() ?? false,
        lookaheadFull: c.source.isLookaheadFull?.() ?? false,
      });
    }
    return {
      compositeMsLast: this.compositeMsLast,
      compositeMsMax: this.compositeMsMax,
      upcomingPrewarm: this.upcomingPrewarm,
      swapsInFlight: this.swaps.size,
      clips,
    };
  }

  /// Reset the running peak for `compositeMsMax`. Called by the HUD's
  /// "reset peaks" button so a momentary stall doesn't pin the max
  /// forever.
  resetPerfPeaks(): void {
    this.compositeMsMax = 0;
  }

  /// Release every sprite + decoder + the stage container. Does NOT
  /// touch the Application — the host owns its lifecycle.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clips.values()) c.sprite.dispose();
    this.clips.clear();
    for (const i of this.images.values()) i.sprite.dispose();
    this.images.clear();
    for (const c of this.colors.values()) c.sprite.dispose();
    this.colors.clear();
    for (const t of this.texts.values()) t.sprite.dispose();
    this.texts.clear();
    for (const t of this.templates.values()) t.sprite.dispose();
    this.templates.clear();
    // Drop the injected export-bake frame references. Bitmaps here are OWNED by
    // the export caller (`exportBakeTemplates`), not the Compositor — same as
    // `setTemplateFrames`, which clears without closing — so we clear (no
    // `.close()`) to avoid double-freeing the caller's bitmaps.
    this.templateFrames.clear();
    for (const s of this.subtitles.values()) s.sprite.dispose();
    this.subtitles.clear();
    for (const a of this.audios.values()) a.mixer.dispose();
    this.audios.clear();
    if (this.audioHost && this.audioHost.parentNode) {
      this.audioHost.parentNode.removeChild(this.audioHost);
    }
    this.cancelAllSwaps();
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

  /// Warm the next VideoClip boundary inside the ring-sized lookahead
  /// window. This keeps normal playback's current-frame pump unchanged
  /// while giving the next clip's decoder a chance to parse, configure,
  /// and fill its first-frame ring before the playhead reaches it.
  private prewarmUpcomingClipBoundary(tUs: number): void {
    if (!this.projectSummary) return;
    const horizonEndUs = tUs + UPCOMING_CLIP_PREWARM_US;
    let nextStartUs: number | null = null;
    let candidates: LayerSummary[] = [];

    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled || layer.params.kind !== "VideoClip") continue;
        if (layer.t_start_us <= tUs || layer.t_start_us > horizonEndUs) continue;
        if (nextStartUs === null || layer.t_start_us < nextStartUs) {
          nextStartUs = layer.t_start_us;
          candidates = [layer];
        } else if (layer.t_start_us === nextStartUs) {
          candidates.push(layer);
        }
      }
    }

    const clips: UpcomingClipPrewarmSnapshot["clips"] = [];
    for (const layer of candidates) {
      // `candidates` is pre-filtered to VideoClip layers above, but the
      // narrowing is lost through the `LayerSummary[]` array type — re-narrow
      // so `layer.params` exposes the VideoClip fields (media_id, src_in_us).
      if (layer.params.kind !== "VideoClip") continue;
      const clip = this.ensureClip(layer);
      if (!clip || clip.source.disposed) {
        clips.push({
          layerId: layer.id,
          mediaId: layer.params.media_id,
          requested: false,
          decodeQueueSize: 0,
          ringSize: 0,
          ringLastPtsUs: null,
        });
        continue;
      }
      const srcTUs = layer.params.src_in_us;
      void clip.source.requestFrameAt(srcTUs);
      clips.push({
        layerId: layer.id,
        mediaId: layer.params.media_id,
        requested: true,
        decodeQueueSize: clip.source.decodeQueueSize?.() ?? 0,
        ringSize: clip.source.ring.size(),
        ringLastPtsUs: clip.source.ring.lastPtsUs(),
      });
    }
    this.upcomingPrewarm = {
      anchorUs: tUs,
      windowUs: UPCOMING_CLIP_PREWARM_US,
      nextStartUs,
      clips,
    };
  }

  private ensureClip(layer: LayerSummary): ActiveClip | null {
    if (layer.params.kind !== "VideoClip") return null;
    const existing = this.clips.get(layer.id);
    // `existing.source` can have been reclaimed by the pool's idle
    // sweeper (`SourceDecoderPool` disposes handles after
    // `IDLE_DISPOSE_MS` of no `requestFrameAt` traffic). After my
    // fix to `setAnchorTime`, only the SourceHandle for the currently
    // active media gets its `lastUseMs` touched, so handles for other
    // media on the timeline are now genuine sweep candidates. When
    // the user returns to one of those clips, the cached `source`
    // points at a disposed handle whose ring is empty and whose
    // demuxer samples have been freed — a fresh `pool.acquire()` is
    // needed to revive the source.
    if (existing && !existing.source.disposed) {
      // No-flash bridge→proxy upgrade: once the resolver returns a different
      // URL for this media (the Plan-2 instant original replaced by a freshly
      // built proxy), begin an overlap-swap — but keep returning the existing
      // clip so the original stays on screen until the proxy has the frame.
      if (this.mode === "preview") {
        const url = this.proxyAssetUrl(layer.params.media_id);
        if (url && url !== existing.builtFromUrl) {
          this.beginSwap(existing, layer, url);
        }
      }
      return existing;
    }
    const mediaId = layer.params.media_id;
    const proxyUrl = this.proxyAssetUrl(mediaId);
    if (!proxyUrl) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] no proxy URL for media ${mediaId} (clip ${layer.id})`);
      return null;
    }
    // Source color tags apply ONLY when the decoded URL is the ORIGINAL file —
    // a proxy/quick-proxy is a re-encode whose color may differ, so it takes
    // the resolution default instead (undefined here).
    const sourceColor =
      proxyUrl === this.originalAssetUrl(mediaId) ? this.sourceColor(mediaId) : undefined;
    const source = this.pool.acquire({
      layerId: layer.id,
      mediaId,
      proxyAssetUrl: proxyUrl,
      sourceColor,
    });
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
    if (existing) {
      // Revival path: keep the sprite (the bound texture from the
      // last paint is still visible on the canvas, so the user sees
      // a held frame rather than a flash to EMPTY while the new
      // decoder warms up), just swap in the fresh source.
      existing.source = source;
      existing.builtFromUrl = proxyUrl;
      existing.loggedNull = false;
      return existing;
    }
    const sprite = new VideoClipSprite({ layerId: layer.id, mediaId });
    const clip: ActiveClip = {
      layerId: layer.id,
      mediaId,
      source,
      sprite,
      builtFromUrl: proxyUrl,
      loggedNull: false,
    };
    this.clips.set(layer.id, clip);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] clip ${layer.id} → media ${mediaId} attached`);
    return clip;
  }

  /// Begin a no-flash overlap-swap of `clip` to a second handle decoding
  /// `newUrl`. The original stays referenced by `clip.source` (so the preview
  /// never blanks) until `pollSwap` confirms the new handle's ring holds the
  /// visible frame, at which point `completeSwap` repoints atomically.
  private beginSwap(clip: ActiveClip, layer: LayerSummary, newUrl: string): void {
    if (layer.params.kind !== "VideoClip") return;
    const inflight = this.swaps.get(clip.layerId);
    if (inflight) {
      // Already swapping to this URL → leave it. Otherwise the target changed
      // (or the handle died) → abandon and restart toward `newUrl`.
      if (!inflight.handle.disposed && inflight.newUrl === newUrl) return;
      this.abandonSwap(clip.layerId);
    }
    const { swapLayerId, swapMediaId } = swapKeys(clip.layerId, clip.mediaId);
    // `newUrl` may be the original or a freshly-built proxy; the gate resolves
    // against the REAL media (`clip.mediaId`) even though we acquire under the
    // synthetic `swapMediaId`, so color applies only while the original is the
    // decoded URL.
    const sourceColor =
      newUrl === this.originalAssetUrl(clip.mediaId) ? this.sourceColor(clip.mediaId) : undefined;
    const handle = this.pool.acquire({
      layerId: swapLayerId,
      mediaId: swapMediaId,
      proxyAssetUrl: newUrl,
      sourceColor,
    });
    const state: SwapState = { handle, swapLayerId, newUrl, timer: null, deadline: null };
    this.swaps.set(clip.layerId, state);
    void handle.ensureReady().catch(() => {
      this.abandonSwap(clip.layerId);
    });
    // `onFirstFrame` is one-shot and usually fires on the GOP key (before the
    // target frame), so it can't carry the swap to completion alone. Drive it
    // with a bounded poll that also keeps the swap handle warm against the
    // idle sweeper; a deadline abandons a swap that never produces the frame.
    const poll = () => this.pollSwap(clip.layerId);
    handle.onFirstFrame(poll);
    state.timer = setInterval(poll, 120);
    state.deadline = setTimeout(() => this.abandonSwap(clip.layerId), 8000);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] begin source-swap ${clip.layerId} → ${newUrl}`);
  }

  /// Poll an in-flight swap: nudge the new handle toward the current frame and
  /// complete once that frame is decoded. No-op once the swap is gone.
  private pollSwap(layerId: string): void {
    const state = this.swaps.get(layerId);
    if (!state) return;
    const clip = this.clips.get(layerId);
    const layer = this.layerById.get(layerId);
    if (!clip || !layer || layer.params.kind !== "VideoClip" || state.handle.disposed) {
      this.abandonSwap(layerId);
      return;
    }
    const tUsSnapped = snapFrameFloor(this.lastTUs, this.fpsNum, this.fpsDen);
    // Playhead off this clip → can't prove the proxy has the visible frame
    // yet; keep the original and retry on a later tick.
    if (tUsSnapped < layer.t_start_us || tUsSnapped >= layer.t_end_us) return;
    const srcTUs = layer.params.src_in_us + (tUsSnapped - layer.t_start_us);
    void state.handle.requestFrameAt(srcTUs);
    if (state.handle.ring.frameAt(srcTUs) != null) {
      this.completeSwap(layerId, srcTUs);
    }
  }

  /// Atomically repoint `clip.source` to the swap handle (whose ring now holds
  /// the frame at `srcTUs`) and release the original. Never swaps to an empty
  /// ring — that black frame is exactly what this avoids.
  private completeSwap(layerId: string, srcTUs: number): void {
    const state = this.swaps.get(layerId);
    const clip = this.clips.get(layerId);
    if (!state) return;
    if (!clip) {
      this.abandonSwap(layerId);
      return;
    }
    if (state.handle.ring.frameAt(srcTUs) == null) return; // lost the frame; wait
    const old = clip.source;
    clip.source = state.handle;
    clip.builtFromUrl = state.newUrl;
    this.clearSwapTimers(state);
    this.swaps.delete(layerId);
    // Release the ORIGINAL handle by its pool key (the clip's real layerId).
    // The swap handle now lives under `${layerId}#swap`, referenced by
    // `clip.source` and kept warm by `setAnchorTime`'s per-tick requests.
    if (!old.disposed) this.pool.release(layerId);
    this.scheduleRepaint();
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] completed source-swap ${layerId} → ${state.newUrl}`);
  }

  /// Tear down an in-flight swap without repointing: clear its timers and
  /// release the synthetic swap handle. The clip keeps its original source.
  private abandonSwap(layerId: string): void {
    const state = this.swaps.get(layerId);
    if (!state) return;
    this.clearSwapTimers(state);
    this.swaps.delete(layerId);
    this.pool.release(state.swapLayerId);
  }

  private clearSwapTimers(state: SwapState): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.deadline !== null) {
      clearTimeout(state.deadline);
      state.deadline = null;
    }
  }

  /// Clear every in-flight swap's timers and forget them. Used by
  /// suspend/dispose, where the pool is disposed wholesale so the synthetic
  /// handles don't need a per-key release.
  private cancelAllSwaps(): void {
    for (const s of this.swaps.values()) this.clearSwapTimers(s);
    this.swaps.clear();
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
    } else {
      // Diagnostic: log when frameAt returns null (painter holds
      // previous frame). Throttled to "only when this clip's state
      // transitions from has-frame to null" to avoid spamming during
      // a long null window.
      if (clip.sprite.sprite.texture !== Texture.EMPTY && !clip.loggedNull) {
        clip.loggedNull = true;
        // eslint-disable-next-line no-console
        console.log(
          `[weftcut/pixi] frameAt(${srcTUs}) → null for ${clip.layerId} ` +
            `(ringFirst=${clip.source.ring.firstPtsUs()} ` +
            `ringLast=${clip.source.ring.lastPtsUs()})`,
        );
      }
    }
    if (frame) clip.loggedNull = false;

    // (Per-tick clip diagnostic removed; rAF tick milestones removed.
    // Renderer is in steady state — bring them back only when a new
    // class of bug surfaces.)

    // Keep transform semantics tied to the original media dimensions, not
    // the currently decoded proxy dimensions. Quick proxies may be 540p and
    // full proxies are capped at 1080p; both should preview at the same size
    // as the source would. Avoid Pixi's width/height setters because they
    // derive scale from `Texture.EMPTY` before the first frame lands.
    const tex = clip.sprite.sprite.texture;
    const media = this.mediaById(params.media_id);
    const textureW = tex === Texture.EMPTY ? null : tex.orig.width;
    const textureH = tex === Texture.EMPTY ? null : tex.orig.height;
    const sourceScaleX =
      media?.width && textureW && textureW > 0 ? media.width / textureW : 1;
    const sourceScaleY =
      media?.height && textureH && textureH > 0 ? media.height / textureH : 1;
    clip.sprite.sprite.scale.set(
      params.scale_x * sourceScaleX * (params.flip_h ? -1 : 1),
      params.scale_y * sourceScaleY * (params.flip_v ? -1 : 1),
    );
    clip.sprite.sprite.position.set(params.x, params.y);
    clip.sprite.sprite.alpha = params.opacity;
    clip.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // ImageOverlay
  // ============================================================

  private ensureImage(layer: LayerSummary): ActiveImage | null {
    if (layer.params.kind !== "ImageOverlay") return null;
    const existing = this.images.get(layer.id);
    if (existing) return existing;
    const mediaId = layer.params.media_id;
    const url = this.originalAssetUrl(mediaId);
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] no asset URL for media ${mediaId} (image ${layer.id})`,
      );
      return null;
    }
    const sprite = new ImageOverlaySprite({ layerId: layer.id, mediaId });
    void sprite.loadFromAsset(url).then(() => {
      // Trigger a repaint once the bitmap lands.
      this.scheduleRepaint();
    });
    const image: ActiveImage = { layerId: layer.id, mediaId, sprite };
    this.images.set(layer.id, image);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/pixi] image ${layer.id} → media ${mediaId} attached`,
    );
    return image;
  }

  private updateImage(
    image: ActiveImage,
    layer: LayerSummary,
    tUs: number,
    z: number,
  ): void {
    if (layer.params.kind !== "ImageOverlay") return;
    const params = layer.params;
    const tInLayerUs = tUs - layer.t_start_us;
    const durationUs = layer.t_end_us - layer.t_start_us;
    image.sprite.update(params, tInLayerUs, durationUs);
    image.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // Color
  // ============================================================

  private ensureColor(layer: LayerSummary): ActiveColor | null {
    if (layer.params.kind !== "Color") return null;
    const existing = this.colors.get(layer.id);
    if (existing) return existing;
    const sprite = new ColorSprite({ layerId: layer.id });
    const color: ActiveColor = { layerId: layer.id, sprite };
    this.colors.set(layer.id, color);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] color ${layer.id} attached`);
    return color;
  }

  private updateColor(color: ActiveColor, layer: LayerSummary, z: number): void {
    if (layer.params.kind !== "Color") return;
    color.sprite.update(layer.params);
    color.sprite.graphics.zIndex = z;
  }

  // ============================================================
  // Text
  // ============================================================

  private ensureText(layer: LayerSummary): ActiveText | null {
    if (layer.params.kind !== "Text") return null;
    const existing = this.texts.get(layer.id);
    if (existing) return existing;
    const sprite = new TextSprite({ layerId: layer.id });
    const text: ActiveText = { layerId: layer.id, sprite };
    this.texts.set(layer.id, text);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] text ${layer.id} attached`);
    return text;
  }

  private updateText(text: ActiveText, layer: LayerSummary, z: number): void {
    if (layer.params.kind !== "Text") return;
    text.sprite.update(layer.params);
    text.sprite.text.zIndex = z;
  }

  // ============================================================
  // Template
  // ============================================================

  private ensureTemplate(layer: LayerSummary): ActiveTemplate | null {
    if (layer.params.kind !== "Template") return null;
    const existing = this.templates.get(layer.id);
    if (existing) return existing;
    const templateId = layer.params.template_id;
    const sprite = new TemplateSprite({
      layerId: layer.id,
      templateId,
      fpsNum: this.fpsNum,
      fpsDen: this.fpsDen,
      onLoaded: () => this.scheduleRepaint(),
    });
    const tmpl: ActiveTemplate = { layerId: layer.id, templateId, sprite };
    this.templates.set(layer.id, tmpl);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/pixi] template ${layer.id} → ${templateId} attached`,
    );
    return tmpl;
  }

  private updateTemplate(
    tmpl: ActiveTemplate,
    layer: LayerSummary,
    z: number,
    tUs: number,
  ): void {
    if (layer.params.kind !== "Template") return;
    // Layer-relative time, mirroring `updateImage`. Templates have no
    // source-in offset, so this resets to 0 at `t_start` — the intended v1
    // semantic (a template animates over its own placed duration).
    const tInLayerUs = tUs - layer.t_start_us;
    const durationUs = layer.t_end_us - layer.t_start_us;
    // Export mode: pass the baked frames for this layer so the sprite binds by
    // index synchronously (the Worker has no DOM harness). Undefined in preview
    // (or if this layer wasn't baked) → the sprite's harness/cache path runs.
    const injected = this.templateFrames.get(layer.id);
    tmpl.sprite.update(layer.params, tInLayerUs, durationUs, injected);
    tmpl.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // Subtitles
  // ============================================================

  private ensureSubtitles(layer: LayerSummary): ActiveSubtitles | null {
    if (layer.params.kind !== "Subtitles") return null;
    // JASSUB needs a real DOM canvas; export Worker has no DOM, so we
    // can't render subtitles into the export pipeline yet. Skip
    // silently — the legacy ffmpeg export path is still wired and
    // will own subtitles export through the v1 cutover.
    if (this.audioHost === null) return null;
    const existing = this.subtitles.get(layer.id);
    if (existing) return existing;
    const sprite = new SubtitlesSprite({
      layerId: layer.id,
      width: this.compositionWidth,
      height: this.compositionHeight,
      host: this.audioHost,
      resolveMedia: (mediaId) => {
        const media = this.mediaById(mediaId);
        if (!media) return null;
        const url = this.originalAssetUrl(mediaId);
        if (!url) return null;
        return { path: media.path, assetUrl: url };
      },
    });
    const subs: ActiveSubtitles = { layerId: layer.id, sprite };
    this.subtitles.set(layer.id, subs);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] subtitles ${layer.id} attached`);
    return subs;
  }

  private updateSubtitles(
    subs: ActiveSubtitles,
    layer: LayerSummary,
    tUs: number,
    z: number,
  ): void {
    if (layer.params.kind !== "Subtitles") return;
    const tInLayerUs = tUs - layer.t_start_us;
    subs.sprite.update(layer.params, tInLayerUs);
    subs.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // Audio
  // ============================================================

  private ensureAudio(layer: LayerSummary): ActiveAudio | null {
    const kind = layer.params.kind;
    if (kind !== "Audio") return null;
    if (this.audioHost === null) return null;
    const existing = this.audios.get(layer.id);
    if (existing) return existing;
    const mediaId = layer.params.media_id;
    // Audio-only media has no proxy; `proxyAssetUrl` falls back to the
    // original file. AV-paired Audio layers reference the same media as
    // a sibling VideoClip and use that media's proxy MP4, whose audio
    // track an `<audio>` element decodes correctly.
    const url = this.proxyAssetUrl(mediaId);
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] no audio URL for media ${mediaId} (layer ${layer.id})`,
      );
      return null;
    }
    const mixer = new AudioMixer(
      {
        layerId: layer.id,
        audioUrl: url,
        layerTStartUs: layer.t_start_us,
        srcInUs: layer.params.src_in_us,
      },
      this.audioHost,
    );
    const audio: ActiveAudio = { layerId: layer.id, mediaId, mixer };
    this.audios.set(layer.id, audio);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] audio ${layer.id} → media ${mediaId} attached`);
    return audio;
  }
}
