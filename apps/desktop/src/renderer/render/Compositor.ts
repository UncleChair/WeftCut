// PixiJS-backed composition root. Owns the scene graph and the
// per-frame composite. Does NOT own the PIXI `Application` lifecycle —
// the host (`@pixi/react`'s `<Application>` for preview, or a Worker
// shell for export) is responsible for constructing and destroying
// the Application. The Compositor receives an already-initialized
// `Application` reference at construction.
//
// Plan: docs/render.md

import { Application, Container, Texture } from "pixi.js";
import type { WebGLRenderer } from "pixi.js";

import { lastFrameAnchorUs as computeLastFrameStartUs, snapFrameFloor } from "../frames";
import type { LayerSummary, MediaSummary, ProjectSummary } from "../ipc";
import { AudioGraph } from "./audio/AudioGraph";
import { AudioMixer } from "./audio/AudioMixer";
import { anyRoleSolo, roleAudible, roleGainLinear } from "./audio/roleGate";
import type { ClockAnchor } from "./audio/chunkSchedule";
import {
  resolveColorView,
  resolveImageOverlayView,
  resolveMotifView,
  resolveTextView,
  resolveVideoClipView,
} from "./resolveView";
import {
  SourceDecoderPool,
  SourceHandle,
  type DecoderHandle,
  type DecoderPool,
} from "./decoder/SourceDecoderPool";
import { NativeGpuSourceHandle } from "./decoder/NativeGpuSourceHandle";
import { SwSourceHandle } from "./decoder/SwSourceHandle";
import type { EngineTier } from "./decoder/decodeEngine";
import { markDowngraded } from "./decoder/decodeCapability";
import { exportHandleKey } from "./decoder/ExportDecoderPool";
import { ColorSprite } from "./sprite/ColorSprite";
import { ImageOverlaySprite } from "./sprite/ImageOverlaySprite";
import { MotifSprite } from "./sprite/MotifSprite";
import { TextSprite } from "./sprite/TextSprite";
import { VideoClipSprite } from "./sprite/VideoClipSprite";
import { getMotif } from "./motifs/catalog";
import { MotifPrewarmer, type PrewarmContentSpec } from "./motifs/MotifPrewarmer";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";
import {
  resolveMotifFrame,
  sharedBakedKeyIndex,
  sharedMotifFrameCache,
} from "./motifs/motifRasterCache";
import { MotifBaker, type BakeContentSpec } from "./motifs/MotifBaker";
import { encodeBitmapToPng } from "./motifs/pngEncode";
import { onPrebakeRequest } from "./motifs/prebakeBus";
import { bakeMotifFrame } from "./motifs/motifRaster";
import {
  setLayerBakeStatuses,
  motifWarmPhase,
  type LayerBakeStatus,
} from "../timeline/motifBakeStatusStore";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { swapKeys } from "./swapKeys";
import { isTenBitFrame } from "./decoder/tenBitFrame";
import { TenBitIngest } from "./tenbit/TenBitIngest";
import { loadBundledFontBytes } from "./fonts/registry";
import { loadFontsIntoFaceSet } from "./fonts/loadFontsIntoFaceSet";
import { EffectChain } from "./effects/EffectChain";
import type { StageableSprite } from "./sprite/StageableSprite";
import { effectsFor } from "./effects/effectsFor";

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

/// E2E-only diagnostic snapshot of ONE active VideoClip's decode source plus
/// its bound sprite. The preview-sw conformance spec reads this to prove the
/// runtime path (import → native-sw route → `resolveSource` resolves tier 3 →
/// acquire) ends in a real `SwSourceHandle` AND that a decoded frame reached
/// the sprite — the single runtime fact no other surface exposes (Task 8b was
/// typecheck-only before this). All fields are plain numbers/strings/booleans
/// so the whole thing survives the `page.evaluate` boundary.
export interface ActiveClipProbe {
  layerId: string;
  mediaId: string;
  /// Which concrete decode handle backs `ActiveClip.source`, discriminated by
  /// `instanceof` (NOT `constructor.name` — the minified E2E renderer build
  /// mangles class names). `"sw"` is the native software-decode path.
  sourceKind: "webcodecs" | "native-gpu" | "sw" | "unknown";
  /// Derived from `sourceKind === "sw"`: whether the active handle is the native
  /// software-decode path. Kept as a distinct field so the spec can assert the
  /// software tier explicitly (Task 10 extends the probe with the resolved key).
  isSoftware: boolean;
  /// True once the pool's idle sweeper has reclaimed this handle.
  sourceDisposed: boolean;
  /// Decoded frames currently buffered in the handle's ring. For the SW path a
  /// non-zero value means `SwSourceHandle` converted NV12 → VideoFrame →
  /// ImageBitmap and pushed it — i.e. the native decoder produced real output.
  ringSize: number;
  /// PTS (µs) of the earliest / latest frame buffered in the ring, or null when
  /// empty. The spec waits for `ringLastPtsUs >= target` so it captures the
  /// seeked frame rather than an earlier one the ring surfaced while catching up.
  ringFirstPtsUs: number | null;
  ringLastPtsUs: number | null;
  /// True once a real (non-EMPTY) texture is bound to the sprite. A VideoClip
  /// snapshots the ring's ImageBitmap into its own canvas, so "the bitmap
  /// reached the sprite" shows up as a bound, correctly-sized texture rather
  /// than a live ImageBitmap resource.
  spriteBound: boolean;
  spriteWidth: number;
  spriteHeight: number;
  /// The resolver IDENTITY (`${tier}:${target}`) the active clip's source was
  /// built from — see `ActiveClip.builtFromKey`. Lets the decode-engine e2e
  /// spec (Task 10) assert the resolved TIER (prefix before the `:`) rather
  /// than inferring it from `sourceKind` alone, which can't distinguish
  /// webcodecs-original from proxy — both decode through the WebCodecs pool
  /// and surface as `sourceKind: "webcodecs"`. Null only when
  /// `activeClipProbe` itself returns null (no matching clip).
  builtFromKey: string | null;
}

/// Preview mode's resolved decode source for one media, produced by the injected
/// `resolveSource` (PixiPreview gathers the store inputs and runs the pure
/// `resolveEngineTier`). `assetUrl` is ALREADY `convertFileSrc`'d — the WebCodecs
/// lanes decode it; the native lanes ignore it and decode `sourcePath` via
/// `forceStrategy`. `key` = `${tier}:${target}` is the swap IDENTITY: it changes
/// only when the resolved tier or decode target changes, so a landed proxy can
/// never displace a higher native/original tier (feedback_native_nle_conventions).
export interface ResolvedRendererSource {
  tier: EngineTier;
  forceStrategy?: "native" | "software" | undefined;
  sourcePath?: string | undefined;
  assetUrl: string | null;
  key: string | null;
}

/// Export mode has exactly one tier today (the proxy/master). Wrap its asset URL
/// in the `ResolvedRendererSource` shape so `ensureClip` runs ONE acquire path
/// across preview + export; preview injects the real engine resolver instead.
/// D5 will fold export onto the resolver too.
function rsFromExportProxy(url: string | null): ResolvedRendererSource | null {
  return url
    ? { tier: "proxy", assetUrl: url, key: `proxy:${url}`, sourcePath: undefined, forceStrategy: undefined }
    : null;
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
  /// EXPORT mode's resolver for the asset URL of a media item's master proxy
  /// (decoded via WebCodecs). Preview mode uses `resolveSource` instead and does
  /// NOT pass this; export keeps it until Phase D5 folds export onto the
  /// resolver. Defaults to `() => null` when absent.
  proxyAssetUrl?: (mediaId: string) => string | null;
  /// PREVIEW mode's engine resolution: gathers store inputs and runs the pure
  /// `resolveEngineTier`, returning the resolved decode source (tier + target +
  /// swap key). REQUIRED in preview mode; export mode keeps `proxyAssetUrl`
  /// (Phase D5). Defaults to `() => null` so export/worker are unaffected.
  resolveSource?: (mediaId: string) => ResolvedRendererSource | null;
  /// Resolver for the asset URL of a media item's ORIGINAL file.
  /// Used for ImageOverlay layers (loaded via `createImageBitmap`).
  /// May return the same URL as `proxyAssetUrl` for media kinds
  /// that don't get proxied (images, audio).
  originalAssetUrl: (mediaId: string) => string | null;
  /// Resolver for a media item's ffprobe-derived source color tags
  /// (matrix/range/primaries/transfer), mapped to WebCodecs. Applied to every
  /// decode target for the media — the original trivially, and proxies too
  /// (a proxy preserves the source's colorimetry; its own container tag still
  /// outranks this per-field in `withDefaultColorSpace`) — so 601/full-range
  /// sources render with their real color from either URL. Returns undefined
  /// when nothing maps.
  sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined;
  /// Lookup for media-side codec dimensions.
  mediaById: (mediaId: string) => MediaSummary | undefined;
  /// Resolver for the asset URL of a media item's conform PCM (VCONF).
  /// Drives the buffer-scheduled preview audio mixer; `null` while the
  /// conform job hasn't completed (the layer stays silent). Optional:
  /// the export Worker omits it (export audio mixes in Rust).
  conformAssetUrl?: (mediaId: string) => string | null;
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
  effects: EffectChain;
  /// The resolver IDENTITY (`${tier}:${target}`) the current `source` was built
  /// from. When the resolver later returns a DIFFERENT key for this media (a
  /// proxy landed for a tier-4 clip, the engine flipped, or a D4 runtime
  /// downgrade), `ensureClip` starts a no-flash overlap-swap to the new source.
  /// Keying on tier+target (not URL) is what makes a landed proxy unable to
  /// displace a native/original tier: the resolver keeps returning the higher
  /// tier, so the key never changes (feedback_native_nle_conventions).
  builtFromKey: string;
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
  /// The resolver IDENTITY (`${tier}:${target}`) the swap handle is decoding
  /// toward. Becomes the clip's `builtFromKey` on completion; the in-flight
  /// dedupe compares it against the freshly-resolved key.
  key: string;
  /// Bounded poll driving the swap to completion (cleared on done/abandon).
  timer: ReturnType<typeof setInterval> | null;
  /// Safety deadline: abandon the swap if it never produces the frame.
  deadline: ReturnType<typeof setTimeout> | null;
}

interface ActiveImage {
  layerId: string;
  mediaId: string;
  sprite: ImageOverlaySprite;
  effects: EffectChain;
}

interface ActiveColor {
  layerId: string;
  sprite: ColorSprite;
  effects: EffectChain;
}

interface ActiveText {
  layerId: string;
  sprite: TextSprite;
  effects: EffectChain;
}

interface ActiveMotif {
  layerId: string;
  motifId: string;
  sprite: MotifSprite;
  effects: EffectChain;
}

interface ActiveAudio {
  layerId: string;
  mediaId: string;
  mixer: AudioMixer;
  /// Change detection for `updateView`: the params object reference is
  /// stable between `setProject` calls, so per-tick comparison is one
  /// identity check; on a new summary the JSON guard avoids tearing down
  /// the mixer's schedule when nothing audio-relevant actually changed.
  lastParamsRef: unknown;
  lastParamsJson: string;
  /// Last role-bus linear gain folded into the mixer. A role-gain change
  /// (or role mute/solo flip changing audibility) must re-derive the mixer
  /// even when `layer.params` is reference-stable, so it joins the
  /// change-detection guard. Sentinel `NaN` forces the first `updateView`.
  lastRoleGain: number;
}

/// Schedule `cb` for an idle slice: `requestIdleCallback` when available
/// (with a 200ms timeout floor so the prewarm can't starve indefinitely),
/// else a short `setTimeout`. Returns a cancel token for `cancelIdle`.
function scheduleIdle(cb: () => void): number {
  const g = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    setTimeout: (cb: () => void, ms: number) => number;
  };
  if (typeof g.requestIdleCallback === "function") return g.requestIdleCallback(cb, { timeout: 200 });
  return g.setTimeout(cb, 16);
}

function cancelIdle(token: number): void {
  const g = globalThis as unknown as {
    cancelIdleCallback?: (t: number) => void;
    clearTimeout: (t: number) => void;
  };
  if (typeof g.cancelIdleCallback === "function") g.cancelIdleCallback(token);
  else g.clearTimeout(token);
}

export class Compositor {
  readonly app: Application;
  readonly stage: Container;
  readonly pool: DecoderPool;
  private clips = new Map<string, ActiveClip>();
  private images = new Map<string, ActiveImage>();
  /// In-flight loadFromAsset promises, keyed by layerId. Used by `preloadImages`
  /// so the export Worker can await all image loads before the frame loop.
  private imageLoadPromises = new Map<string, Promise<void>>();
  private colors = new Map<string, ActiveColor>();
  private texts = new Map<string, ActiveText>();
  private activeMotifs = new Map<string, ActiveMotif>();
  /// Export-only: pre-rasterized Motif-layer frames injected by the export
  /// Worker (`layerId → ImageBitmap[]`, indexed by comp-frame). When present
  /// for a layer, `updateMotif` hands the array to `MotifSprite.update`,
  /// which binds by index synchronously (no DOM harness — the Worker has none).
  /// Empty in preview mode; the sprite's harness/cache path runs instead.
  private motifFrames = new Map<string, readonly ImageBitmap[]>();
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
  private resolveSource: (mediaId: string) => ResolvedRendererSource | null;
  private originalAssetUrl: (mediaId: string) => string | null;
  private sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined;
  private mediaById: (mediaId: string) => MediaSummary | undefined;
  private conformAssetUrl: (mediaId: string) => string | null;
  /// Master audio bus (preview mode only; null in the export Worker).
  private audioGraph: AudioGraph | null = null;
  /// Media ids already warned about a missing conform (once per media,
  /// cleared when the conform shows up).
  private conformWarned = new Set<string>();
  /// The engine's clock anchor, forwarded each tick (null while paused
  /// or while the AudioContext is suspended). Consumed by the audio pass.
  private clockAnchor: ClockAnchor | null = null;
  private compositionWidth = 1920;
  private compositionHeight = 1080;
  private disposed = false;
  /// Lazily created on the first TenBitFrame. Null in preview (TenBitFrames
  /// never reach the preview ring) and in WebGPU export contexts (10-bit
  /// export forces the WebGL backend, so reaching this non-null on WebGPU
  /// is a wiring bug caught by ensureTenBitIngest).
  private tenBitIngest: TenBitIngest | null = null;
  /// Most recent composition time we composited at. Used by
  /// `scheduleRepaint()` for async-arrived frames when the playhead
  /// is paused (no rAF tick incoming).
  private lastTUs = 0;
  /// Background filler that warms the shared motif-frame cache ahead of the
  /// playhead. DOM-gated: only the main-thread preview Compositor creates one;
  /// the export Worker (no `document`, frames injected via `setMotifFrames`)
  /// leaves it null.
  private prewarmer: MotifPrewarmer | null =
    typeof document !== "undefined"
      ? new MotifPrewarmer({
          cap: sharedMotifFrameCache.capacity(),
          hasFrame: (k, f) => sharedMotifFrameCache.hasFrame(k, f),
          setFrame: (k, f, b) => {
            sharedMotifFrameCache.setFrame(k, f, b);
          },
          schedule: (cb) => scheduleIdle(cb),
          cancel: (t) => cancelIdle(t),
          // batchSize 1: captures now serialize in Rust, so a larger batch only
          // adds head-of-line latency for an on-demand scrub. One in-flight
          // capture per loop keeps the shared host queue short.
          batchSize: 1,
          onProgress: () => this.recomputeBakeStatuses(),
        })
      : null;
  /// L2 writer. DOM-gated like the prewarmer (never in the export Worker).
  private baker: MotifBaker | null =
    typeof document !== "undefined"
      ? new MotifBaker({
          schedule: (cb) => scheduleIdle(cb),
          cancel: (t) => cancelIdle(t),
          // batchSize 1: captures now serialize in Rust, so a larger batch only
          // adds head-of-line latency for an on-demand scrub. One in-flight
          // capture per loop keeps the shared host queue short.
          batchSize: 1,
          isOnDisk: (k, f) => sharedMotifFrameCache.hasPng(k, f),
          persist: async (k, f, bmp) => {
            const png = await encodeBitmapToPng(bmp);
            await sharedMotifFrameCache.writePng(k, f, png);
            sharedBakedKeyIndex.add(k);
          },
          warm: (k, f, bmp) => {
            sharedMotifFrameCache.setFrame(k, f, bmp);
          },
          onStatus: (cacheKey, status) => {
            this.bakeStatusByCacheKey.set(cacheKey, status);
            this.recomputeBakeStatuses();
          },
        })
      : null;
  /// Latest per-cacheKey bake status from the baker. Fanned out to per-layer
  /// entries in `recomputeBakeStatuses`.
  private bakeStatusByCacheKey = new Map<string, LayerBakeStatus>();
  /// Signature of the last published bake-status map, so recompute is a no-op
  /// when nothing changed (it runs every frame via updateBakeTargets).
  private lastBakeStatusSig = "";
  /// LayerIds the user manually "Pre-bake now"'d this session — baked even
  /// when the global setting is off.
  private manualPrebakeLayers = new Set<string>();
  /// Unsubscribe handle for the prebake bus.
  private prebakeUnsub: (() => void) | null = null;
  /// Last composition frame index we re-planned the prewarm targets at, so the
  /// per-tick refresh in `compositeFrame` only fires on a frame change.
  private lastPrewarmFrame = -1;
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
    // Default null-resolvers: preview passes `resolveSource`, export passes
    // `proxyAssetUrl`; each mode's ensureClip branch reads only its own.
    this.proxyAssetUrl = init.proxyAssetUrl ?? ((): string | null => null);
    this.resolveSource = init.resolveSource ?? ((): ResolvedRendererSource | null => null);
    this.originalAssetUrl = init.originalAssetUrl;
    this.sourceColor = init.sourceColor;
    this.mediaById = init.mediaById;
    this.compositionWidth = init.width;
    this.compositionHeight = init.height;
    this.mode = init.mode;
    this.conformAssetUrl = init.conformAssetUrl ?? ((): string | null => null);
    this.app.stage.addChild(this.stage);
    // Hidden DOM host element. The buffer-scheduled audio mixer no longer
    // mounts `<audio>` elements, but the host remains the "am I in a real
    // DOM context" gate — the export Worker has neither `document` nor
    // preview audio.
    if (this.mode === "preview" && typeof document !== "undefined") {
      // Bundled fonts: same set as the export Worker, so preview matches the
      // burned-in output. Awaited off the constructor; the first post-load
      // redraw picks them up.
      void loadBundledFontBytes().then((b) =>
        loadFontsIntoFaceSet(document.fonts, b),
      );
      this.audioHost = document.createElement("div");
      this.audioHost.setAttribute("data-pixi-audio-host", "");
      this.audioHost.style.display = "none";
      document.body.appendChild(this.audioHost);
      this.audioGraph = new AudioGraph();
    } else {
      this.audioHost = null;
    }
  }

  /// The preview master audio bus, for the dev PerfHUD meter row and the
  /// MCP meter report. Null in export mode.
  getAudioGraph(): AudioGraph | null {
    return this.audioGraph;
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
  /// pause / seek so the audio pass knows whether to schedule.
  setMasterPlayState(playing: boolean): void {
    this.playing = playing;
  }

  /// PlaybackEngine forwards its clock anchor every tick. The AudioMixers
  /// schedule chunks against this exact pair — the same one the playhead
  /// derives from — so playhead and audio share ONE clock
  /// (docs/audio.md §Clock). Null while paused or audio-suspended.
  setClockAnchor(anchor: ClockAnchor | null): void {
    this.clockAnchor = anchor;
  }

  /// Export-only: install the pre-rasterized Motif-layer frames the export
  /// Worker baked on the main thread (`layerId → ImageBitmap[]`, comp-frame
  /// indexed). `updateMotif` forwards a layer's array to its
  /// `MotifSprite.update`, which binds by index synchronously instead of
  /// running the DOM capture harness (absent in the Worker). Passing an empty
  /// map (or never calling this) leaves preview's harness/cache path untouched.
  setMotifFrames(map: Record<string, readonly ImageBitmap[]>): void {
    this.motifFrames.clear();
    for (const [layerId, frames] of Object.entries(map)) {
      this.motifFrames.set(layerId, frames);
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
      this.tenBitIngest?.dispose();
      this.tenBitIngest = null;
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
      this.tenBitIngest?.dispose();
      this.tenBitIngest = null;
      this.baker?.setTargets([]);
      this.manualPrebakeLayers.clear();
      sharedBakedKeyIndex.clear();
      this.bakeStatusByCacheKey.clear();
      this.lastBakeStatusSig = "";
      setLayerBakeStatuses({});
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
        this.tenBitIngest?.release(layerId);
        c.sprite.dispose();
        c.effects.dispose();
        this.clips.delete(layerId);
      }
    }
    for (const [layerId, i] of this.images) {
      if (!livingLayerIds.has(layerId)) {
        i.sprite.dispose();
        i.effects.dispose();
        this.images.delete(layerId);
      }
    }
    for (const [layerId, c] of this.colors) {
      if (!livingLayerIds.has(layerId)) {
        c.sprite.dispose();
        c.effects.dispose();
        this.colors.delete(layerId);
      }
    }
    for (const [layerId, t] of this.texts) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        t.effects.dispose();
        this.texts.delete(layerId);
      }
    }
    for (const [layerId, t] of this.activeMotifs) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        t.effects.dispose();
        this.activeMotifs.delete(layerId);
      }
    }
    for (const [layerId, a] of this.audios) {
      if (!livingLayerIds.has(layerId)) {
        a.mixer.dispose();
        this.audios.delete(layerId);
      }
    }
    // Subscribe to the timeline's "Pre-bake now" bus exactly once (DOM-gated
    // by `this.baker`). A request records the layer and refreshes bake targets
    // so it bakes even when the global setting is off.
    if (this.baker && !this.prebakeUnsub) {
      this.prebakeUnsub = onPrebakeRequest((layerId) => {
        this.manualPrebakeLayers.add(layerId);
        this.updateBakeTargets(this.lastTUs);
      });
    }
    // Re-plan the prewarm window against the new project at the current
    // playhead. Reached only for a non-null summary (the null branch returns
    // above); `this.lastTUs` is the last composited composition time.
    this.updatePrewarmTargets(this.lastTUs);
    this.updateBakeTargets(this.lastTUs);
    this.recomputeBakeStatuses();
    // Hydrate the on-disk baked-key index + GC orphaned hash dirs against the
    // new project's live keys. Fire-and-forget — never blocks load.
    void this.hydrateBakedIndexAndGc();
  }

  /// Per-frame "filter + addChild" tail for every visual layer kind. Applies
  /// the layer's resolved effect filters, then stages the node once it's ready.
  /// All five visual kinds — including Motif — carry an EffectChain; `effects`
  /// stays optional only as a defensive no-op (a chain-less caller would stage
  /// unfiltered).
  private stageVisual(
    sprite: StageableSprite,
    effects: EffectChain | undefined,
    layer: LayerSummary,
    tInLayerUs: number,
    effectOpts: { previewEffectsEnabled: boolean },
  ): void {
    if (effects) {
      sprite.displayObject.filters = effectsFor(effects, layer, tInLayerUs, effectOpts);
    }
    // Skip not-yet-ready sprites. Sprite-backed kinds report stageReady false
    // while their texture is still the EMPTY placeholder — PixiJS v8's batched
    // renderer crashes on that placeholder in some Chromium configs. Once the
    // first frame lands, the texture swaps and the sprite stages.
    if (sprite.stageReady) {
      this.stage.addChild(sprite.displayObject);
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
    // entirely in export mode — export audio mixes in Rust
    // (`audio::mix`, docs/audio.md).
    //
    // VideoClip layers are NOT eligible. Mirrors `audio::mix`'s canonical
    // export routing: only Audio layers are audible; VideoClips are
    // video-only. Import's `auto_pair_audio_on_import` (default-on)
    // places a sibling Audio layer on the same media for the audio
    // track. Treating the VideoClip as also audio-bearing here would
    // play the same audio twice — the audible doubling bug.
    if (this.audioGraph !== null) {
      // Audio gates — mirror audio/mix.rs audible_audio_layers semantics:
      // whole-track disable still gates, but audio mute/solo now lives on
      // ROLES (mute wins over solo; an absent role defaults audible iff no
      // role is soloed). Gated-out layers are skipped here, then swept below
      // with a pause-shaped tick so their pre-scheduled chunks stop
      // immediately. (Preview ignores `locked`, matching the live behavior.)
      const roles = this.projectSummary.audio_roles ?? [];
      const anySolo = anyRoleSolo(roles);
      const tickedAudio = new Set<string>();
      for (const track of this.projectSummary.tracks) {
        if (!track.enabled) continue; // whole-track disable still gates
        for (const layer of track.layers) {
          if (!layer.enabled) continue;
          if (layer.params.kind === "Audio") {
            // Role gating moved off the track (M/S → roles).
            if (!roleAudible(layer.params.role, roles, anySolo)) continue;
            const audio = this.ensureAudio(layer);
            if (audio) {
              const rGain = roleGainLinear(layer.params.role, roles);
              if (
                audio.lastParamsRef !== layer.params ||
                audio.lastRoleGain !== rGain
              ) {
                const json =
                  JSON.stringify(layer.params) +
                  `|${layer.t_start_us}|${layer.t_end_us}|${rGain}`;
                if (json !== audio.lastParamsJson) {
                  audio.mixer.updateView(
                    layer.params,
                    layer.t_start_us,
                    layer.t_end_us,
                    rGain,
                  );
                  audio.lastParamsJson = json;
                }
                audio.lastParamsRef = layer.params;
                audio.lastRoleGain = rGain;
              }
              tickedAudio.add(layer.id);
              audio.mixer.tick(
                tUsSnapped,
                this.playing,
                layer.t_end_us,
                this.clockAnchor,
              );
            }
          }
        }
      }
      // Mixers gated out above (track mute/solo/disable, layer disable)
      // would otherwise never tick again, leaving their pre-scheduled
      // chunks (≤ LOOKAHEAD_S ≈ 3 s) audible after the gate flips. Tick
      // them with pause semantics (playing=false, null anchor — the exact
      // branch a transport pause exercises) so the mixer's own teardown
      // stops every live node this frame.
      for (const [layerId, audio] of this.audios) {
        if (tickedAudio.has(layerId)) continue;
        const layer = this.layerById.get(layerId);
        audio.mixer.tick(tUsSnapped, false, layer?.t_end_us ?? 0, null);
      }
    }

    // Export ignores the preview-only LOD toggle — effects are always
    // applied at full quality during export regardless of the user's
    // preview performance setting. The export worker realm never
    // hydrates the settings store, but this guard is structural so
    // correctness doesn't depend on that implementation detail.
    const previewEffectsEnabled =
      this.mode === "export"
        ? true
        : useAppSettingsStore.getState().settings.preview_effects_enabled;
    const effectOpts = { previewEffectsEnabled };

    let z = 0;
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        if (tUsSnapped < layer.t_start_us || tUsSnapped >= layer.t_end_us)
          continue;

        const kind = layer.params.kind;
        const tInLayerUs = tUsSnapped - layer.t_start_us;
        if (kind === "VideoClip") {
          const clip = this.ensureClip(layer);
          if (!clip) continue;
          this.updateClip(clip, layer, tUsSnapped, z++);
          this.stageVisual(clip.sprite, clip.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "ImageOverlay") {
          const image = this.ensureImage(layer);
          if (!image) continue;
          this.updateImage(image, layer, tUsSnapped, z++);
          this.stageVisual(image.sprite, image.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Color") {
          const color = this.ensureColor(layer);
          if (!color) continue;
          this.updateColor(color, layer, z++, tInLayerUs);
          this.stageVisual(color.sprite, color.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Text") {
          const text = this.ensureText(layer);
          if (!text) continue;
          this.updateText(text, layer, z++, tUsSnapped);
          this.stageVisual(text.sprite, text.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Motif") {
          const tmpl = this.ensureMotif(layer);
          if (!tmpl) continue;
          this.updateMotif(tmpl, layer, z++, tUsSnapped);
          this.stageVisual(tmpl.sprite, tmpl.effects, layer, tInLayerUs, effectOpts);
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
    // Refresh the prewarm window when the playhead crosses a frame boundary.
    // Throttled to once per composition frame so scrub/play ticks within the
    // same frame don't re-plan. Runs whether playing or paused.
    if (this.prewarmer) {
      const frameIdx = Math.round((tUsSnapped * this.fpsNum) / (1_000_000 * this.fpsDen));
      if (frameIdx !== this.lastPrewarmFrame) {
        this.lastPrewarmFrame = frameIdx;
        this.updatePrewarmTargets(tUsSnapped);
        this.updateBakeTargets(tUsSnapped);
      }
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

  /// E2E-only (preview-sw conformance / Task 8b runtime proof): snapshot the
  /// decode source + bound sprite of the active VideoClip named by `layerId`
  /// (or the first live clip when omitted). Returns null when no matching clip
  /// is active. `sourceKind` is decided by `instanceof` so it is robust to the
  /// minified E2E build. Read-only — never mutates compositor state.
  activeClipProbe(layerId?: string): ActiveClipProbe | null {
    let clip: ActiveClip | undefined;
    if (layerId != null) {
      clip = this.clips.get(layerId);
    } else {
      for (const c of this.clips.values()) {
        if (!c.source.disposed) {
          clip = c;
          break;
        }
      }
    }
    if (!clip) return null;
    const s = clip.source;
    const sourceKind: ActiveClipProbe["sourceKind"] =
      s instanceof SwSourceHandle
        ? "sw"
        : s instanceof NativeGpuSourceHandle
          ? "native-gpu"
          : s instanceof SourceHandle
            ? "webcodecs"
            : "unknown";
    const tex = clip.sprite.sprite.texture;
    const isEmpty = tex === Texture.EMPTY;
    return {
      layerId: clip.layerId,
      mediaId: clip.mediaId,
      sourceKind,
      isSoftware: sourceKind === "sw",
      sourceDisposed: s.disposed,
      ringSize: s.ring.size(),
      ringFirstPtsUs: s.ring.firstPtsUs(),
      ringLastPtsUs: s.ring.lastPtsUs(),
      spriteBound: !isEmpty,
      spriteWidth: isEmpty ? 0 : tex.orig.width,
      spriteHeight: isEmpty ? 0 : tex.orig.height,
      builtFromKey: clip.builtFromKey,
    };
  }

  /// Release every sprite + decoder + the stage container. Does NOT
  /// touch the Application — the host owns its lifecycle.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clips.values()) { c.sprite.dispose(); c.effects.dispose(); }
    this.clips.clear();
    for (const i of this.images.values()) { i.sprite.dispose(); i.effects.dispose(); }
    this.images.clear();
    for (const c of this.colors.values()) { c.sprite.dispose(); c.effects.dispose(); }
    this.colors.clear();
    for (const t of this.texts.values()) { t.sprite.dispose(); t.effects.dispose(); }
    this.texts.clear();
    for (const t of this.activeMotifs.values()) { t.sprite.dispose(); t.effects.dispose(); }
    this.activeMotifs.clear();
    this.prewarmer?.dispose();
    this.prewarmer = null;
    this.baker?.dispose();
    this.baker = null;
    this.prebakeUnsub?.();
    this.prebakeUnsub = null;
    this.manualPrebakeLayers.clear();
    sharedBakedKeyIndex.clear();
    this.bakeStatusByCacheKey.clear();
    this.lastBakeStatusSig = "";
    setLayerBakeStatuses({});
    // Drop the injected export-bake frame references. Bitmaps here are OWNED by
    // the export caller (`exportBakeMotifs`), not the Compositor — same as
    // `setMotifFrames`, which clears without closing — so we clear (no
    // `.close()`) to avoid double-freeing the caller's bitmaps.
    this.motifFrames.clear();
    for (const a of this.audios.values()) a.mixer.dispose();
    this.audios.clear();
    this.audioGraph?.dispose();
    this.audioGraph = null;
    if (this.audioHost && this.audioHost.parentNode) {
      this.audioHost.parentNode.removeChild(this.audioHost);
    }
    this.cancelAllSwaps();
    this.tenBitIngest?.dispose();
    this.tenBitIngest = null;
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

  /// Lazily construct the 10-bit ingest. TenBitFrames only flow when the
  /// export worker runs the WebGL backend (bitDepth=10 forces preference
  /// "webgl"), so reaching this on a WebGPU renderer is a wiring bug — fail
  /// loudly rather than mis-render.
  private ensureTenBitIngest(): TenBitIngest {
    if (!this.tenBitIngest) {
      const renderer = this.app.renderer;
      // `"gl" in renderer` distinguishes WebGLRenderer (exposes `gl`) from
      // WebGPURenderer (exposes `gpu`). Both share the `Renderer` union type;
      // this narrowing is sufficient and avoids importing WebGLRenderer as a
      // value (it's already in the bundle via TenBitIngest, so no bloat either
      // way — kept as type-import to match the rest of this file's style).
      if (!("gl" in renderer)) {
        throw new Error(
          "TenBitFrame reached a non-WebGL renderer — 10-bit export requires the WebGL backend",
        );
      }
      this.tenBitIngest = new TenBitIngest(renderer as WebGLRenderer);
    }
    return this.tenBitIngest;
  }

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

  /// Map the active motif layers at composition-time `tUs` to prewarm specs
  /// (deduped by cacheKey inside the planner) and hand them to the prewarmer.
  /// Runs whether playing or paused (compositeFrame fires on seek/scrub too), so
  /// the cache warms ahead of the playhead in both states.
  private updatePrewarmTargets(tUs: number): void {
    if (!this.prewarmer || !this.projectSummary) return;
    const specs: PrewarmContentSpec[] = [];
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled || layer.params.kind !== "Motif") continue;
        const motif = getMotif(layer.params.motif_id);
        if (!motif) continue;
        const tInLayerUs = tUs - layer.t_start_us;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const view = layer.params;
        const desc = motifFrameDescriptor(view, tInLayerUs, durationUs, this.fpsNum, this.fpsDen, motif);
        if (!desc) continue;
        // Capture the plan-time inputs in locals so the async render closure
        // binds the values that produced THIS cacheKey, not whatever `this.fps*`
        // is at raster time (which could drift if the project fps changes).
        const fpsNum = this.fpsNum;
        const fpsDen = this.fpsDen;
        const canonicalProps = desc.canonicalProps;
        const durationSec = desc.durationSec;
        specs.push({
          cacheKey: desc.cacheKey,
          contentFrame: desc.contentFrame,
          contentDurationFrames: desc.contentDurationFrames,
          // tSec for an arbitrary content frame = frame * fpsDen / fpsNum.
          // Disk-first: prefer a baked PNG over a live raster, falling through
          // to `rasterMotifFrame` (CDP) inside the resolver on miss / fs hiccup.
          render: (frame: number) =>
            resolveMotifFrame(
              motif,
              desc.cacheKey,
              frame,
              (frame * fpsDen) / fpsNum,
              durationSec,
              canonicalProps,
            ),
        });
      }
    }
    this.prewarmer.setTargets(specs);
  }

  /// Feed the L2 baker (the SOLE disk writer). Persists the FULL content of:
  /// every active motif content when the global `prebake_motifs` setting
  /// is on, PLUS any layer the user manually "Pre-bake now"'d this session
  /// (regardless of the setting). Mirrors `updatePrewarmTargets`' descriptor
  /// shape; the baker's `render` closure uses `bakeMotifFrame` (CDP capture,
  /// no disk read) directly (reading disk-first would be pointless — the baker is the writer).
  private updateBakeTargets(tUs: number): void {
    if (!this.baker || !this.projectSummary) return;
    const globalOn = useAppSettingsStore.getState().settings.prebake_motifs;
    const specs: BakeContentSpec[] = [];
    for (const track of this.projectSummary.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled || layer.params.kind !== "Motif") continue;
        const wanted = globalOn || this.manualPrebakeLayers.has(layer.id);
        if (!wanted) continue;
        const motif = getMotif(layer.params.motif_id);
        if (!motif) continue;
        const tInLayerUs = tUs - layer.t_start_us;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const view = layer.params;
        const desc = motifFrameDescriptor(view, tInLayerUs, durationUs, this.fpsNum, this.fpsDen, motif);
        if (!desc) continue;
        // Capture the plan-time inputs in locals so the async render closure
        // binds the values that produced THIS cacheKey, not whatever `this.fps*`
        // is at raster time (which could drift if the project fps changes).
        const fpsNum = this.fpsNum;
        const fpsDen = this.fpsDen;
        const canonicalProps = desc.canonicalProps;
        specs.push({
          cacheKey: desc.cacheKey,
          contentFrame: desc.contentFrame,
          contentDurationFrames: desc.contentDurationFrames,
          // tSec for an arbitrary content frame = frame * fpsDen / fpsNum.
          // `bakeMotifFrame` (CDP capture, no disk read): the baker is the sole
          // L2 writer; reading disk-first here would be pointless.
          render: (frame: number) => bakeMotifFrame(motif, frame, fpsNum, fpsDen, canonicalProps),
        });
      }
    }
    this.baker.setTargets(specs);
    this.recomputeBakeStatuses();
  }

  /// On project load: rebuild the in-RAM baked-key index from what's on disk
  /// (so the resolver's disk-first read fires only for keys that actually have
  /// PNGs) and reclaim disk for hash dirs no live key references anymore.
  /// Fire-and-forget; any fs error is swallowed so it can never block load.
  private async hydrateBakedIndexAndGc(): Promise<void> {
    if (!this.projectSummary) return;
    const activeKeys: string[] = [];
    for (const track of this.projectSummary.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "Motif") continue;
        const motif = getMotif(layer.params.motif_id);
        if (!motif) continue;
        // The cacheKey is window/time-independent (it folds props, dims, fps and
        // content-duration, not the playhead), so tInLayerUs = 0 is fine here:
        // we only read `desc.cacheKey`. durationUs is the layer width, mirroring
        // `updatePrewarmTargets`.
        const durationUs = layer.t_end_us - layer.t_start_us;
        const desc = motifFrameDescriptor(
          layer.params,
          0,
          durationUs,
          this.fpsNum,
          this.fpsDen,
          motif,
        );
        if (desc) activeKeys.push(desc.cacheKey);
      }
    }
    sharedBakedKeyIndex.setLiveCandidates(activeKeys);
    try {
      const hashes = await sharedMotifFrameCache.listBakedHashes();
      sharedBakedKeyIndex.hydrateFromHashes(hashes);
      // The index now reflects on-disk frames; recompute so last-session-baked
      // layers (no live baker status) surface as "ready".
      this.recomputeBakeStatuses();
      await sharedMotifFrameCache.gcUnreferenced(activeKeys);
    } catch (e) {
      console.warn("[weftcut/motifs] baked-index hydrate/gc failed", e);
    }
  }

  /// Build the per-layer bake-status map and publish it to the store. A layer
  /// shows: its baker status if live; else "ready" if its frames are already on
  /// disk (sharedBakedKeyIndex — e.g. baked last session, toggle off); else it
  /// is omitted (idle → no dot). O(motif layers); called on every onStatus,
  /// updateBakeTargets, and setProject.
  private recomputeBakeStatuses(): void {
    if (!this.projectSummary) {
      if (this.lastBakeStatusSig !== "") { this.lastBakeStatusSig = ""; setLayerBakeStatuses({}); }
      return;
    }
    const byLayer: Record<string, LayerBakeStatus> = {};
    for (const track of this.projectSummary.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "Motif") continue;
        const motif = getMotif(layer.params.motif_id);
        if (!motif) continue;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const view = layer.params;
        const desc = motifFrameDescriptor(view, 0, durationUs, this.fpsNum, this.fpsDen, motif);
        if (!desc) continue;
        const live = this.bakeStatusByCacheKey.get(desc.cacheKey);
        // L0 coverage of this layer's content frames (cheap Map lookups; the
        // cache `hasFrame` doesn't touch recency). This is the "is preview warm"
        // signal that drives the green bar.
        let covered = 0;
        for (let f = 0; f < desc.contentDurationFrames; f++) {
          if (sharedMotifFrameCache.hasFrame(desc.cacheKey, f)) covered++;
        }
        const status = motifWarmPhase(
          live ?? null,
          covered,
          desc.contentDurationFrames,
          sharedBakedKeyIndex.has(desc.cacheKey),
        );
        if (status) byLayer[layer.id] = status;
      }
    }
    const sig = JSON.stringify(byLayer);
    if (sig === this.lastBakeStatusSig) return;
    this.lastBakeStatusSig = sig;
    setLayerBakeStatuses(byLayer);
  }

  private ensureClip(layer: LayerSummary): ActiveClip | null {
    if (layer.params.kind !== "VideoClip") return null;
    const existing = this.clips.get(layer.id);
    // `existing.source` can have been reclaimed by the pool's idle
    // sweeper (`SourceDecoderPool` disposes handles after
    // `IDLE_DISPOSE_MS` of no `requestFrameAt` traffic). `setAnchorTime`
    // only touches `lastUseMs` for the currently active media's handle,
    // so handles for other media on the timeline are genuine sweep
    // candidates. When the user returns to one of those clips, the cached
    // `source` points at a disposed handle whose ring is empty and whose
    // demuxer samples have been freed — a fresh `pool.acquire()` revives it.
    if (existing && !existing.source.disposed) {
      // No-flash re-resolution: when the resolver's IDENTITY for this media
      // changes (a proxy landed for a tier-4 clip, the engine flipped, or a D4
      // runtime downgrade), begin an overlap-swap; keep returning the existing
      // clip so the current frame stays on screen until the new handle holds
      // the visible frame. Keying on tier+target (not URL) means a landed proxy
      // can NEVER displace a native/original tier — the resolver simply keeps
      // returning the higher tier, so the key doesn't change
      // (feedback_native_nle_conventions).
      if (this.mode === "preview") {
        const rs = this.resolveSource(layer.params.media_id);
        if (rs?.key && rs.key !== existing.builtFromKey && (rs.assetUrl !== null || rs.sourcePath)) {
          this.beginSwap(existing, layer, rs);
        }
      }
      return existing;
    }
    const mediaId = layer.params.media_id;
    // Preview resolves the engine tier once here (native-hw / webcodecs-original
    // / native-sw / proxy); export keeps today's single proxy tier (D5 folds
    // export onto the resolver too). `rsFromExportProxy` wraps the proxy URL in
    // the same shape so this acquire path is shared.
    const rs =
      this.mode === "preview"
        ? this.resolveSource(mediaId)
        : rsFromExportProxy(this.proxyAssetUrl(mediaId));
    if (!rs || (!rs.assetUrl && !rs.sourcePath)) {
      // Nothing acquirable yet: proxy still building, or no decodable tier.
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] no decode source for media ${mediaId} (clip ${layer.id})`);
      return null;
    }
    // Source color tags apply to ANY decode target for this media: the
    // original carries them trivially, and a proxy/quick-proxy PRESERVES the
    // source's colorimetry (the recipe never converts matrix/range). The
    // decode target's own container tag still outranks this per-field in
    // `withDefaultColorSpace`, so a self-describing (colr-tagged) proxy is
    // unaffected; colr-less ones stop being misread as bt709/limited.
    const sourceColor = this.sourceColor(mediaId);
    const sourceStartPtsUs = this.mediaById(mediaId)?.video_start_pts_us ?? this.mediaById(mediaId)?.start_pts_us ?? null;
    // Swap/revival identity (tier + decode target). Non-null: the guard above
    // bailed unless a target exists, and the resolver only nulls `key` when it
    // has none.
    const builtFromKey = rs.key!;
    const source = this.pool.acquire({
      layerId: layer.id,
      mediaId,
      // Export pool keying: must match the Worker's per-(media, phase)
      // grouping so this sprite reads the ring the Worker is filling.
      // Preview keys by layerId and ignores handleKey.
      ...(this.mode === "export"
        ? { handleKey: exportHandleKey(mediaId, layer.params.src_in_us, layer.t_start_us) }
        : {}),
      // WebCodecs lanes decode this URL; native lanes ignore it and decode
      // `sourcePath` via `forceStrategy` (spread below).
      proxyAssetUrl: rs.assetUrl ?? "",
      sourceColor,
      sourceStartPtsUs,
      ...(rs.forceStrategy ? { forceStrategy: rs.forceStrategy, sourcePath: rs.sourcePath ?? "" } : {}),
    });
    // Subscribe to the first-frame notification BEFORE kicking off
    // ensureReady so we don't miss the synchronous-fire case if the
    // source happened to be pre-warmed by another clip referencing
    // the same media.
    source.onFirstFrame(() => {
      this.scheduleRepaint();
    });
    // D4 sticky runtime downgrade (Task 18): a native lane (`rs.forceStrategy`
    // set — native-hw or native-sw) that dies at runtime (GPU decode error,
    // device loss, session crash, or the `hw-budget-exceeded` open throw from
    // Task 17's `MAX_HW_SESSIONS` cap) fires `onFatalError`. Mark this media's
    // tier downgraded (sticky; LogBus warns) and schedule a repaint — the next
    // `ensureClip` re-resolves via `resolveSource`, the downgraded tier is
    // skipped, the resolved key changes, and the no-flash swap above (the
    // `existing` branch) rebuilds onto the next tier. No new swap mechanism:
    // this rides the same key-based swap Task 9 already built. WebCodecs'
    // `SourceHandle` has no `onFatalError` (its own downgrade-to-software
    // machinery handles GPU decode errors internally), so this is a no-op there.
    if (rs.forceStrategy && source.onFatalError) {
      const failedTier = rs.tier;
      source.onFatalError((reason) => {
        markDowngraded(mediaId, failedTier, reason);
        this.scheduleRepaint();
      });
    }
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
      existing.builtFromKey = builtFromKey;
      existing.loggedNull = false;
      return existing;
    }
    const sprite = new VideoClipSprite({ layerId: layer.id, mediaId });
    const clip: ActiveClip = {
      layerId: layer.id,
      mediaId,
      source,
      sprite,
      effects: new EffectChain(),
      builtFromKey,
      loggedNull: false,
    };
    this.clips.set(layer.id, clip);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] clip ${layer.id} → media ${mediaId} attached`);
    return clip;
  }

  /// Begin a no-flash overlap-swap of `clip` to a second handle decoding the
  /// freshly-resolved source `rs`. The original stays referenced by
  /// `clip.source` (so the preview never blanks) until `pollSwap` confirms the
  /// new handle's ring holds the visible frame, at which point `completeSwap`
  /// repoints atomically. `rs` may resolve to any tier — a native lane
  /// (forceStrategy + sourcePath) or a WebCodecs URL — so D4's runtime
  /// downgrades ride this same path.
  private beginSwap(clip: ActiveClip, layer: LayerSummary, rs: ResolvedRendererSource): void {
    if (layer.params.kind !== "VideoClip") return;
    if (!rs.key) return;
    const inflight = this.swaps.get(clip.layerId);
    if (inflight) {
      // Already swapping to this identity → leave it. Otherwise the target
      // changed (or the handle died) → abandon and restart toward `rs`.
      if (!inflight.handle.disposed && inflight.key === rs.key) return;
      this.abandonSwap(clip.layerId);
    }
    const { swapLayerId, swapMediaId } = swapKeys(clip.layerId, clip.mediaId);
    // Resolve color/start against the REAL media (`clip.mediaId`) even though we
    // acquire under the synthetic `swapMediaId`: a proxy preserves the source
    // colorimetry (its own colr tag still outranks this per-field), and a native
    // lane decodes the original directly.
    const sourceColor = this.sourceColor(clip.mediaId);
    const sourceStartPtsUs =
      this.mediaById(clip.mediaId)?.video_start_pts_us ??
      this.mediaById(clip.mediaId)?.start_pts_us ??
      null;
    const handle = this.pool.acquire({
      layerId: swapLayerId,
      mediaId: swapMediaId,
      proxyAssetUrl: rs.assetUrl ?? "",
      sourceColor,
      sourceStartPtsUs,
      ...(rs.forceStrategy ? { forceStrategy: rs.forceStrategy, sourcePath: rs.sourcePath ?? "" } : {}),
    });
    const state: SwapState = { handle, swapLayerId, key: rs.key, timer: null, deadline: null };
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
    console.log(`[weftcut/pixi] begin source-swap ${clip.layerId} → ${rs.key}`);
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
    clip.builtFromKey = state.key;
    this.clearSwapTimers(state);
    this.swaps.delete(layerId);
    // Release the ORIGINAL handle by its pool key (the clip's real layerId).
    // The swap handle now lives under `${layerId}#swap`, referenced by
    // `clip.source` and kept warm by `setAnchorTime`'s per-tick requests.
    if (!old.disposed) this.pool.release(layerId);
    this.scheduleRepaint();
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] completed source-swap ${layerId} → ${state.key}`);
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

    const layerLocalUs = tUs - layer.t_start_us;
    // Per-frame keyframe resolution: AnimTrack views -> scalars at the
    // layer-local time. Identical in preview and the export Worker.
    const params = resolveVideoClipView(layer.params, layerLocalUs);
    const srcTUs = params.src_in_us + layerLocalUs;

    // Upload the current frame BEFORE adjusting transforms so the
    // sprite's natural size reflects the real texture dimensions.
    const frame = clip.source.ring.frameAt(srcTUs);
    if (frame) {
      if (isTenBitFrame(frame)) {
        clip.sprite.bindExternalTexture(
          this.ensureTenBitIngest().textureFor(clip.layerId, frame),
        );
      } else {
        clip.sprite.updateFrame(frame);
      }
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
    const sprite = new ImageOverlaySprite({
      layerId: layer.id,
      mediaId,
      maxWidth: this.compositionWidth,
      maxHeight: this.compositionHeight,
    });
    const loadPromise = sprite.loadFromAsset(url).then(() => {
      // Trigger a repaint once the bitmap lands.
      this.scheduleRepaint();
      this.imageLoadPromises.delete(layer.id);
    });
    this.imageLoadPromises.set(layer.id, loadPromise);
    void loadPromise;
    const image: ActiveImage = { layerId: layer.id, mediaId, sprite, effects: new EffectChain() };
    this.images.set(layer.id, image);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/pixi] image ${layer.id} → media ${mediaId} attached`,
    );
    return image;
  }

  /// Pre-trigger image loading for every ImageOverlay layer in the current
  /// project and return a promise that resolves once ALL are loaded. Called by
  /// the export Worker before the frame loop so that animated GIF frames are
  /// available before compositing begins (ensureImage fires loadFromAsset as
  /// fire-and-forget; without this wait the decoder races the frame loop and
  /// all frames composite as transparent).
  async preloadImages(): Promise<void> {
    if (!this.projectSummary) return;
    const imageLayerIds: string[] = [];
    for (const track of this.projectSummary.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind === "ImageOverlay") imageLayerIds.push(layer.id);
      }
    }
    // Force-create sprites for any not yet ensured (compositeFrame would do
    // this lazily, but we want the load promises in flight immediately).
    for (const layerId of imageLayerIds) {
      const layer = this.layerById.get(layerId);
      if (layer) this.ensureImage(layer);
    }
    const pending = imageLayerIds
      .map((id) => this.imageLoadPromises.get(id))
      .filter((p): p is Promise<void> => p !== undefined);
    if (pending.length > 0) await Promise.all(pending);
  }

  private updateImage(
    image: ActiveImage,
    layer: LayerSummary,
    tUs: number,
    z: number,
  ): void {
    if (layer.params.kind !== "ImageOverlay") return;
    const tInLayerUs = tUs - layer.t_start_us;
    const durationUs = layer.t_end_us - layer.t_start_us;
    const params = resolveImageOverlayView(layer.params, tInLayerUs);
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
    const color: ActiveColor = { layerId: layer.id, sprite, effects: new EffectChain() };
    this.colors.set(layer.id, color);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] color ${layer.id} attached`);
    return color;
  }

  private updateColor(color: ActiveColor, layer: LayerSummary, z: number, tInLayerUs: number): void {
    if (layer.params.kind !== "Color") return;
    color.sprite.update(resolveColorView(layer.params, tInLayerUs));
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
    const text: ActiveText = { layerId: layer.id, sprite, effects: new EffectChain() };
    this.texts.set(layer.id, text);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] text ${layer.id} attached`);
    return text;
  }

  private updateText(text: ActiveText, layer: LayerSummary, z: number, tUs: number): void {
    if (layer.params.kind !== "Text") return;
    const tInLayerUs = tUs - layer.t_start_us;
    text.sprite.update(resolveTextView(layer.params, tInLayerUs));
    text.sprite.text.zIndex = z;
  }

  // ============================================================
  // Motif
  // ============================================================

  private ensureMotif(layer: LayerSummary): ActiveMotif | null {
    if (layer.params.kind !== "Motif") return null;
    const motifId = layer.params.motif_id;
    const existing = this.activeMotifs.get(layer.id);
    if (existing) {
      if (existing.motifId === motifId) return existing;
      // The layer was retargeted to a different Motif (Edit-swap / Discard /
      // Update rebind) — dispose the stale sprite so a fresh one re-fetches
      // getMotif(motifId) and re-captures. Keyed by layer.id, so the map slot
      // is replaced below.
      existing.sprite.dispose();
      existing.effects.dispose();
      this.activeMotifs.delete(layer.id);
    }
    const sprite = new MotifSprite({
      layerId: layer.id,
      motifId,
      fpsNum: this.fpsNum,
      fpsDen: this.fpsDen,
      onLoaded: () => this.scheduleRepaint(),
    });
    const tmpl: ActiveMotif = { layerId: layer.id, motifId, sprite, effects: new EffectChain() };
    this.activeMotifs.set(layer.id, tmpl);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/pixi] motif ${layer.id} → ${motifId} attached`,
    );
    return tmpl;
  }

  private updateMotif(
    tmpl: ActiveMotif,
    layer: LayerSummary,
    z: number,
    tUs: number,
  ): void {
    if (layer.params.kind !== "Motif") return;
    // Layer-relative time, mirroring `updateImage`. Motifs have no
    // source-in offset, so this resets to 0 at `t_start` — the intended v1
    // semantic (a motif animates over its own placed duration).
    const tInLayerUs = tUs - layer.t_start_us;
    const durationUs = layer.t_end_us - layer.t_start_us;
    // Export mode: pass the baked frames for this layer so the sprite binds by
    // index synchronously (the Worker has no DOM harness). Undefined in preview
    // (or if this layer wasn't baked) → the sprite's harness/cache path runs.
    const injected = this.motifFrames.get(layer.id);
    tmpl.sprite.update(resolveMotifView(layer.params, tInLayerUs), tInLayerUs, durationUs, injected);
    tmpl.sprite.sprite.zIndex = z;
  }

  /// Refresh every live Motif sprite against the current runtime catalog and
  /// schedule a repaint. Called when `motifs:changed` fires (a draft edit /
  /// install / delete) so an edited draft's preview re-captures. Cheap +
  /// user-paced; no sprite is recreated (refreshMotif keeps the last bitmap
  /// until the fresh capture lands).
  refreshMotifs(): void {
    for (const { sprite } of this.activeMotifs.values()) {
      sprite.refreshMotif();
    }
    this.scheduleRepaint();
  }

  // ============================================================
  // Audio
  // ============================================================

  private ensureAudio(layer: LayerSummary): ActiveAudio | null {
    if (layer.params.kind !== "Audio") return null;
    const graph = this.audioGraph;
    if (graph === null) return null;
    const existing = this.audios.get(layer.id);
    if (existing) return existing;
    const mediaId = layer.params.media_id;
    // The mixer Range-reads the media's conform PCM — no decode in the
    // renderer. `null` until the conform job lands: the layer stays
    // silent and we retry on a later tick (the media summary updates
    // when the job completes).
    const url = this.conformAssetUrl(mediaId);
    if (!url) {
      if (!this.conformWarned.has(mediaId)) {
        this.conformWarned.add(mediaId);
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/pixi] no conform PCM yet for media ${mediaId} (layer ${layer.id}); audio silent until the conform job completes`,
        );
      }
      return null;
    }
    this.conformWarned.delete(mediaId);
    const mixer = new AudioMixer(
      {
        layerId: layer.id,
        conformUrl: url,
        view: layer.params,
        layerTStartUs: layer.t_start_us,
        layerTEndUs: layer.t_end_us,
      },
      graph,
    );
    const audio: ActiveAudio = {
      layerId: layer.id,
      mediaId,
      mixer,
      lastParamsRef: layer.params,
      lastParamsJson:
        JSON.stringify(layer.params) + `|${layer.t_start_us}|${layer.t_end_us}`,
      // Sentinel: the constructor derived the mixer at unity role gain, so
      // the first selection-loop pass must re-derive with the real role gain.
      lastRoleGain: NaN,
    };
    this.audios.set(layer.id, audio);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] audio ${layer.id} → media ${mediaId} attached`);
    return audio;
  }
}
