// Dev/E2E-only control surface. Installed ONLY when
// import.meta.env.VITE_WEFTCUT_E2E === "1" (set by the e2e build), so it is
// absent from normal production bundles (the dynamic import behind that static
// check is dead-code-eliminated). Lets the e2e spec drive a real
// new-project -> import -> place -> export through the SAME code paths the UI
// uses, in the real Electron renderer.
//
// Two-part because the editor (App, where the export lives) only mounts AFTER a
// project is open: main.tsx installs `newProjectAndEnter` (create workspace +
// flip Root to the editor stage); App installs `exportClip` once mounted.
import {
  importMedia,
  addTrack,
  addMediaLayer,
  addMotif,
  projectNewWorkspace,
  projectOpen,
  projectSave,
  projectSummary,
  updateLayerParams,
  workspaceDir,
  type AudioPatch,
  type CanvasPreset,
  type MediaSummary,
} from "../ipc";
import { captureMotifFrame } from "../render/motifs/host";
import { hashCacheKey } from "../render/motifs/frameCache";
import { sharedMotifFrameCache, sharedBakedKeyIndex } from "../render/motifs/motifRasterCache";
import { motifFrameDescriptor } from "../render/motifs/motifFrameDescriptor";
import { getMotif } from "../render/motifs/catalog";
import { requestPrebake } from "../render/motifs/prebakeBus";
import { mergeSettings, type ExportSettings } from "../render/exportSettings";
import { playheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { setPreferProxies } from "../state/proxyPreferenceStore";
import { resolveDecode } from "../render/decodeRoute";
import { exists, readDir } from "@/bridge/fs";
import { join as pathJoin } from "@/bridge/path";
import { MotifSprite } from "../render/sprite/MotifSprite";
import type { ResolvedMotifView } from "../render/resolveView";
import { ImageOverlaySprite } from "../render/sprite/ImageOverlaySprite";
import { decodeAnimatedImage } from "../render/sprite/animatedImageCache";
import type { ResolvedImageOverlayView } from "../render/resolveView";
import { convertFileSrc } from "@/bridge/ipc";
import { buildPanGraph, constantPanGains } from "../render/audio/panGraph";
import {
  decodeBenchRun,
  decodeBenchPhase,
  decodeBenchOrderCheck,
  decodeBenchBudgetProbe,
  decodeBenchHwFallbackProbe,
  type BenchArgs,
  type BenchResult,
  type OrderCheckArgs,
  type OrderCheckResult,
  type BudgetProbeResult,
  type HwFallbackProbeArgs,
  type HwFallbackProbeResult,
} from "../render/decoder/decodeBench";
import type { ActiveClipProbe } from "../render/Compositor";
import {
  ensureWaveformWindow,
  registerWaveformProducer,
} from "../timeline/tileEngine/WaveformTileProducer";

type RunExport = (
  settings: ExportSettings,
  outputPath: string,
  range?: { startUs: number; endUs: number },
) => Promise<void>;

export interface E2EHook {
  /// Create a blank workspace with `canvas` dims at `<parentFolder>/<name>/`,
  /// replacing the actor state, then flip Root to the editor stage (which
  /// mounts App + installs `exportClip`). Wait for `exportClip` to appear
  /// before calling it.
  newProjectAndEnter(args: {
    parentFolder: string;
    name: string;
    canvas: CanvasPreset;
  }): Promise<void>;
  /// Save, hop Root back to the StartupScreen (unmounting App), reopen the
  /// project at `path`, and re-enter the editor. Remounting App re-runs its
  /// on-open Motif staleness check — this mirrors the real close-and-reopen
  /// flow (the only in-session way to switch projects). Dev/e2e only.
  motifReopenProject(args: { path: string }): Promise<void>;
  /// Import `mediaAbsPath`, place it 1:1 at t=0 on a fresh video track, and
  /// export to `outputAbsPath`. `settings` overlays DEFAULT_EXPORT_SETTINGS
  /// (H.264/mp4, follow-composition res+fps). `range` trims the export to
  /// `[startUs, endUs)` (audio + video); omit for the whole composition.
  /// `audioPatches` drives the audio-engine conformance specs: N patches
  /// place N copies of the clip (each on its own track) and apply patch i to
  /// the i-th auto-paired Audio layer (gain/pan/fades/mute) before export.
  /// Rejects if no output is written.
  exportClip(args: {
    mediaAbsPath: string;
    outputAbsPath: string;
    settings?: Partial<ExportSettings>;
    range?: { startUs: number; endUs: number };
    audioPatches?: AudioPatch[];
  }): Promise<void>;
  /// Import `mediaAbsPath` and place it 1:1 at `tStartUs` (default 0) on a
  /// fresh track — the same IPC chain the UI uses — WITHOUT exporting.
  /// Returns the new ids plus the media's classified kind as the project
  /// store sees it. Used by the media-support specs (still images /
  /// audio-only files) together with `weftcutSeekUs` +
  /// `weftcutSampleComposite` for preview-level assertions.
  importAndPlaceMedia(args: {
    mediaAbsPath: string;
    tStartUs?: number;
  }): Promise<{ mediaId: string; layerId: string; kind: string }>;
  /// Place an ALREADY-imported media 1:1 at `tStartUs` (default 0) on a fresh
  /// track — the placement half of `importAndPlaceMedia`. Lets a spec put N
  /// copies of ONE mediaId on the timeline (the same-source overlap export
  /// scenarios); re-importing the file would mint a new mediaId and dodge the
  /// shared-source decoder path under test.
  placeMediaLayer(args: {
    mediaId: string;
    tStartUs?: number;
  }): Promise<{ layerId: string }>;
  /// Resolve once `resolveDecode(media).exportPath` is non-null — for a
  /// Video source that means the proxy/bypass route has been decided AND any
  /// needed proxy has landed. The animated-gif spec uses this to prove the
  /// gif routes through the video pipeline to an export-ready state.
  waitMediaExportReady(args: { mediaId: string; timeoutMs?: number }): Promise<void>;
  /// Export the CURRENT timeline as-is (no import/placement) to
  /// `outputAbsPath`. Lets a spec compose a multi-media timeline via
  /// `importAndPlaceMedia` and then drive the REAL export path, including
  /// both readiness gates (video proxies + audio conform). Rejects if no
  /// output is written.
  exportTimeline(args: {
    outputAbsPath: string;
    settings?: Partial<ExportSettings>;
    range?: { startUs: number; endUs: number };
  }): Promise<void>;
  /// The media's conform cache path as the project store sees it (null until
  /// the conform job lands). Cache-surgery specs (conform invalidation) read
  /// the real absolute path here instead of reconstructing the cache layout.
  mediaConformPath(args: { mediaId: string }): string | null;
  /// Sample the renderer's real waveform tile path at source times. This goes
  /// through WaveformTileProducer + TileEngine (including not_ready/pending
  /// retries), exactly like TimelineWaveform, instead of reading the backend
  /// peaks file directly.
  sampleWaveformRms(args: {
    mediaId: string;
    timesUs: number[];
    pxPerSec?: number;
    windowMs?: number;
    timeoutMs?: number;
  }): Promise<{ peaksPerSecond: number; rms: number[] }>;
  /// Add a built-in Motif layer at t=0 (default duration) and export to
  /// `outputAbsPath`. No video clip is needed — the export composites the
  /// motif-only timeline, driving the FULL real export path: main-thread
  /// `exportBakeMotifs` → transfer → Worker `MotifSprite` bind-by-index.
  /// Proves motifs render in export (they were silently absent before). The
  /// caller (project + editor) must already be set up via `newProjectAndEnter`.
  exportMotifClip(args: {
    motifId: string;
    outputAbsPath: string;
    durationUs?: number;
    props?: Record<string, unknown>;
    settings?: Partial<ExportSettings>;
  }): Promise<void>;
  /// Drive the REAL `MotifSprite` over a built-in motif at two
  /// layer-relative times and read back the interior pixel of each bound
  /// raster. Exercises the full sprite chain in real Electron renderer:
  /// `update(view, tInLayerUs, durationUs)` → frame index → `frameTimeSec` →
  /// `resolveMotifFrame` → `rasterMotifFrame` (CDP) → bound `Texture`. The spec
  /// asserts the two frames differ (the motif animated across the
  /// timeline). The spec's page.evaluate can't import the bundled `MotifSprite`,
  /// so it's constructed here and the result reduced to plain numbers.
  ///
  /// Returns, per requested time: the bound bitmap dims + a content checksum
  /// (sum of every RGBA byte, read via OffscreenCanvas + getImageData). The
  /// checksum differs whenever the rendered frame differs — the countdown's
  /// numeral + sweeping progress arc both change per frame, so two distinct
  /// times produce distinct checksums.
  renderMotifSpriteFrames(args: {
    motifId: string;
    fpsNum: number;
    fpsDen: number;
    durationUs: number;
    times: Array<{ tInLayerUs: number }>;
    props?: Record<string, unknown>;
  }): Promise<
    Array<{
      tInLayerUs: number;
      width: number;
      height: number;
      checksum: number;
    }>
  >;
  /// Drive a real ImageOverlaySprite over an imported animated image at several
  /// layer-local times and read back each bound frame's content checksum, plus
  /// the decoded total duration + frame count. Lets the spec prove the image
  /// ANIMATES (distinct checksums across frames) and LOOPS (checksum at t equals
  /// checksum at t + totalUs) through the exact sprite + cache code export uses.
  renderImageOverlaySpriteFrames(args: {
    mediaId: string;
    times: Array<{ tInLayerUs: number }>;
    durationUs: number;
    maxWidth: number;
    maxHeight: number;
  }): Promise<{
    totalUs: number;
    frameCount: number;
    samples: Array<{ tInLayerUs: number; width: number; height: number; checksum: number }>;
  }>;
  /// Trigger a persisted pre-bake of a motif layer (via the prebakeBus) and
  /// wait until at least `expectedFrames` PNG files appear under
  /// `<workspace>/Cache/raster/<hash>/`. Returns the absolute path to the hash
  /// dir and the number of PNGs found. Rejects on timeout (default 60 s). The
  /// cacheKey is computed internally from the current project summary so the
  /// e2e spec doesn't need to import bundled modules.
  prebakeLayerAndWait(args: {
    layerId: string;
    expectedFrames: number;
    timeoutMs?: number;
  }): Promise<{ hashDir: string; hashName: string; pngCount: number }>;
  /// List the hash dir names currently present under `<workspace>/Cache/raster/`.
  /// Returns an empty array when no project is open or the dir doesn't exist.
  listBakedHashDirs(): Promise<string[]>;
  /// Run the GC against `activeCacheKeys`: removes every `Cache/raster/<hash>` dir
  /// whose hash isn't in the active set. Mirrors `MotifFrameCache.gcUnreferenced`.
  gcRasterDirs(activeCacheKeys: string[]): Promise<void>;
  /// Compute the cacheKey for a motif layer by looking up its current state in
  /// the project summary. Returns null if the layer doesn't exist or isn't a Motif.
  cacheKeyForLayer(layerId: string): Promise<string | null>;
  /// Add a motif layer at t=0 with the given duration and return its layerId.
  /// Thin wrapper over the `add_motif` IPC so e2e specs don't need raw
  /// backend invoke access. Only available after the editor mounts.
  addMotifLayer(args: {
    motifId: string;
    durationUs: number;
    props?: Record<string, unknown>;
  }): Promise<string>;
  /// Reveal a layer's track AND select it — the same action as clicking a peek
  /// item in the right panel (App's `revealTrack`, driven here via the deferred
  /// `pendingRevealLayerId` so it fires once the summary contains the layer). In
  /// A/B-roll mode a role-null Overlay track stays COLLAPSED — its timeline
  /// LayerBlock, and the per-layer bake-status dot inside it, never mount — until
  /// revealed. Plain selection does NOT reveal (revealedTrackId is separate
  /// state), so the bake-status e2e must reveal before asserting `.motif-bake-dot`.
  /// Dev/e2e only.
  revealLayer(args: { layerId: string }): void;
  /// Patch a motif layer's props (merges field-wise). Used by the pre-bake
  /// e2e to change the `accent` prop and observe a new cacheKey / new hash dir.
  patchMotifLayerProps(args: {
    layerId: string;
    props: Record<string, unknown>;
  }): Promise<void>;
  /// Evict every L0 (in-RAM) frame for a cacheKey, so a subsequent resolve must
  /// come from disk (L2) or a fresh raster. Used to prove the disk read path.
  clearMotifCacheKey(cacheKey: string): void;
  /// Whether the in-RAM baked-key index currently marks this cacheKey baked.
  bakedIndexHas(cacheKey: string): boolean;
  /// Render a Motif frame via the Rust `motif_capture_frame` command and
  /// return the raw base64 PNG string (no `data:` prefix). Dev/e2e only:
  /// exposes the Motifs capture pipeline to e2e specs which cannot
  /// import bundled modules. Requires the Motif runtime to have been
  /// registered by the frontend (motif_register_runtime).
  captureMotifFrame(args: {
    motifId: string;
    tSec: number;
    props: Record<string, unknown>;
    width: number;
    height: number;
  }): Promise<string>;
  /// Add a `countdown` Motif layer at t=0 spanning [0, 5s) with default
  /// props (480×480, seconds/label/accent), via the real `add_motif` IPC.
  /// Returns the new layer id. Used by the live-preview e2e to put a countdown
  /// on the timeline so the compositor renders it through the Motif CDP path.
  /// Requires an open project + the editor mounted (call newProjectAndEnter
  /// first). Dev/e2e only.
  motifAddCountdown(): Promise<string>;
  /// Drive the live preview to composition-time `us`. Delegates to the active
  /// PlaybackEngine's `seek`, which sets the clock + re-composites the frame
  /// (the same path the transport/scrubber uses). No-op until the Pixi preview
  /// has mounted (installPreviewBridge ran). Dev/e2e only.
  weftcutSeekUs(us: number): void;
  /// Read one pixel back from the LIVE composited Pixi canvas at (x, y) in
  /// composition pixels. Uses the renderer's `extract` (reliable on
  /// WebGPU/WebGL regardless of preserveDrawingBuffer) and reads the pixel via
  /// a 2D canvas. Returns {r,g,b,a} in [0,255]. Rejects if the preview hasn't
  /// mounted. Dev/e2e only — this is what proves the countdown's CDP pixels
  /// reach the live compositor.
  weftcutSampleComposite(x: number, y: number): Promise<CompositeSample>;
  /// Preview-sw conformance: snapshot the active
  /// VideoClip's decode source + bound sprite off the LIVE Compositor. Proves
  /// the Compositor acquired a `FfmpegSource` on its software lane (native
  /// software decode) for a native-sw ProRes clip and that a decoded frame
  /// reached the sprite. Pass the clip's `layerId`; omit for the first live
  /// clip. Returns null until a clip is active. Delegates to the PixiPreview
  /// bridge (Dev/e2e only). `builtFromKey` additionally exposes the
  /// resolver's `${engine}:${source}:${target}` identity so the decode-engine
  /// e2e spec can assert the resolved ENGINE/SOURCE, not just the coarser
  /// `sourceKind`.
  activeClipProbe(layerId?: string): ActiveClipProbe | null;
  /// Preview-sw SSIM: base64 PNG (no `data:` prefix) of the current composited
  /// preview frame at composition resolution. The spec decodes this, produces
  /// an ffmpeg reference PNG of the same source frame, and SSIM-compares.
  capturePreviewFramePng(): Promise<string>;
  /// The persisted decode-route kind for `mediaId` as the renderer store sees
  /// it ("native-sw"/"proxied"/"bypass"/…), or null if the media isn't in the
  /// store yet. Lets the preview-sw spec wait for the async proxy-decision to
  /// commit `native-sw` before it seeks + asserts the software route. Dev/e2e.
  mediaDecodeRouteKind(mediaId: string): string | null;
  /// The full media summary for `mediaId` as the renderer project store sees
  /// it right now (path, kind, decode_route, …), or null if the media isn't
  /// in the store yet. Complements `mediaDecodeRouteKind` (which projects
  /// just the route tag): the Prefer-Proxies e2e needs the route's
  /// `quick_proxy` path alongside its tag to know an on-demand
  /// `generate_quick_proxy` build has landed. Dev/e2e only.
  mediaById(mediaId: string): MediaSummary | null;
  /// Drive the REAL Prefer-Proxies toggle — the wrapped renderer setter
  /// (`setPreferProxies`), NOT the raw `update_project_settings` backend
  /// command. `PixiPreview`'s `resolveSource` gates on `proxyIntent`, which
  /// reads the renderer's `useProxyPrefStore`; that store is updated only by
  /// this setter (IPC invoke, then optimistic `setState`) or by
  /// `wireProxyPrefStore`'s project_id-change rehydrate — a same-project
  /// settings patch made through the raw command alone never reaches it. The
  /// Prefer-Proxies e2e must go through this hook so the store (and therefore
  /// `proxyIntent`/`resolveSource`) actually flips. Returns the setter's
  /// promise so the caller can await the store update before proceeding.
  setPreferProxies(v: boolean): Promise<void>;
  /// Render the REAL buildPanGraph + constantPanGains in an OfflineAudioContext
  /// and return the mean L/R RMS energy. Drives the actual Web Audio graph
  /// wiring (splitter/4-gain/merger topology) that the headless math goldens
  /// cannot reach — a constant-1.0 input lets each case verify the equal-power
  /// matrix mix analytically. No media fixtures required. Dev/e2e only.
  panRenderProbe(args: {
    channels: number;
    pan: number;
    frames: number;
  }): Promise<{ l: number; r: number }>;
  /// decode-bench (docs/decode-bench.md): run one benchmark scenario against
  /// a private decoder pool. Orchestrated by e2e/scripts/decode-bench.mjs.
  decodeBenchRun(args: BenchArgs): Promise<BenchResult>;
  /// Current decode-bench phase ('idle'|'setup'|'warmup'|'measuring');
  /// the orchestrator gates its resource samplers on 'measuring'.
  decodeBenchPhase(): string;
  /// Frame-CONTENT-order regression guard (native-hw reorder bug): drive
  /// continuous forward decode of an index-encoded clip and verify each
  /// delivered bitmap's barcode matches its pts-derived index. `mismatches`
  /// non-empty ⇒ the strategy presented frames out of order (pixels↔pts
  /// mispaired). See decodeBench.decodeBenchOrderCheck. Dev/e2e only.
  decodeBenchOrderCheck(args: OrderCheckArgs): Promise<OrderCheckResult>;
  /// HW session-budget runtime probe (smoke item b): open `count` native-hw
  /// sessions and report each open's outcome. The (MAX_HW_SESSIONS+1)th must
  /// reject with `hw-budget-exceeded` and surface it via onFatalError (the
  /// resolver then downgrades that source off tier 1). Dev/e2e only.
  decodeBenchBudgetProbe(args: { sourcePath: string; count: number }): Promise<BudgetProbeResult>;
  /// HW→SW in-place fallback: a REAL (unforced) counterpart to
  /// `decodeBenchBudgetProbe` — opens `count` ffmpeg-engine sources on an
  /// HW-eligible clip WITHOUT forcing a lane, so `pickInitialLane`'s real
  /// probe puts the first `MAX_HW_SESSIONS` on hardware exactly as production
  /// does; the (MAX_HW_SESSIONS+1)th's budget rejection then engages
  /// `FfmpegSource`'s in-place HW→SW recovery instead of the forced path's
  /// hard fatal. Dev/e2e only. See decodeBench.ts's doc comment.
  decodeBenchHwFallbackProbe(args: HwFallbackProbeArgs): Promise<HwFallbackProbeResult>;
  /// Imperative read of the global playhead store (µs). Search-palette e2e
  /// uses this to prove a caption/clip jump (Enter on a result row) actually
  /// moved the playhead, without importing the bundled store module.
  getPlayheadUs(): number;
}

/// Pixel + whole-frame diagnostics from the live composite readback. `r/g/b/a`
/// is the sampled pixel; `w/h` the extracted buffer dims; `nonTransparent` the
/// count of pixels with alpha > 0 and `maxA` the peak alpha — both localise a
/// "nothing composited" failure vs a "wrong spot" failure. `accentCount` is the
/// number of accent-colored opaque pixels (the countdown's #ff4d4d numeral +
/// arc) and `accentR/G/B` a representative such pixel — the spec asserts on
/// these (robust to which exact glyph stroke a single sample point hits).
export interface CompositeSample {
  r: number;
  g: number;
  b: number;
  a: number;
  w: number;
  h: number;
  nonTransparent: number;
  maxA: number;
  accentCount: number;
  accentR: number;
  accentG: number;
  accentB: number;
}

/// Live-preview bridge handle registered by `PixiPreview` (behind the e2e
/// guard) so the readback/seek hooks can reach the active renderer + engine
/// without the spec importing bundled modules. Re-registered on each
/// `PixiPreview` mount (StrictMode / project swap); the most recent wins.
interface PreviewBridge {
  /// Seek the live preview to composition-time `us` (clock + re-composite).
  seekUs(us: number): void;
  /// Extract an (x,y) pixel from the live composited canvas as RGBA bytes,
  /// plus whole-frame diagnostics (see CompositeSample).
  sampleComposite(x: number, y: number): Promise<CompositeSample>;
  /// Active VideoClip decode-source + sprite snapshot off the live Compositor
  /// (see Compositor.activeClipProbe). Null when no live clip.
  activeClipProbe(layerId?: string): ActiveClipProbe | null;
  /// Base64 PNG (no `data:` prefix) of the current composited preview frame.
  capturePng(): Promise<string>;
}

function hookSlot(): Partial<E2EHook> {
  const w = window as unknown as { __weftcutTest?: Partial<E2EHook> };
  if (!w.__weftcutTest) w.__weftcutTest = {};
  return w.__weftcutTest;
}

/// Root-side: workspace creation + entering the editor. `enterEditor` is
/// Root's `setStage("editor")`; `exitToStartup` is `setStage("startup")`.
export function installBootstrapHook(
  enterEditor: () => void,
  exitToStartup: () => void,
): void {
  hookSlot().newProjectAndEnter = async (args) => {
    await projectNewWorkspace(args);
    enterEditor();
  };
  hookSlot().motifReopenProject = async ({ path }) => {
    await projectSave();
    exitToStartup();
    // Let React commit the App unmount before swapping actor state under it.
    await new Promise((r) => setTimeout(r, 50));
    await projectOpen(path);
    enterEditor();
  };
  hookSlot().getPlayheadUs = () => playheadTimeUs();
}

/// Root-side: install the decode-bench hooks (docs/decode-bench.md). No
/// App/export state needed — the driver owns its own private
/// SourceDecoderPool. Called once on boot from main.tsx.
export function installDecodeBenchHooks(): void {
  if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
  hookSlot().decodeBenchRun = decodeBenchRun;
  hookSlot().decodeBenchPhase = decodeBenchPhase;
  hookSlot().decodeBenchOrderCheck = decodeBenchOrderCheck;
  hookSlot().decodeBenchBudgetProbe = decodeBenchBudgetProbe;
  hookSlot().decodeBenchHwFallbackProbe = decodeBenchHwFallbackProbe;
}

/// Root-side: install Motif test hooks (prebake, cache ops, sprite frames,
/// add/patch/clear/baked-index). Lives at Root level; called once on boot.
export function installMotifTestHooks(): void {
  // Drive the REAL MotifSprite (Task A) and read back each bound frame's
  // content checksum so the spec can prove the motif animates across the
  // timeline through the sprite's own frame-selection + bind path.
  hookSlot().renderMotifSpriteFrames = async ({
    motifId,
    fpsNum,
    fpsDen,
    durationUs,
    times,
    props,
  }) => {
    const out: Array<{
      tInLayerUs: number;
      width: number;
      height: number;
      checksum: number;
    }> = [];
    // One sprite reused across the requested times — exactly how the
    // Compositor reuses an ActiveMotif sprite while the playhead moves.
    // `onLoaded` fires on the async bind path (cache miss); a flag flips so the
    // per-time waiter below (and the sync-hit detection) can settle.
    let bindSignalled = false;
    const sprite = new MotifSprite({
      layerId: "e2e-motif-sprite",
      motifId: motifId,
      fpsNum,
      fpsDen,
      onLoaded: () => {
        bindSignalled = true;
      },
    });
    try {
      const view: ResolvedMotifView = {
        motif_id: motifId,
        x: 0,
        y: 0,
        scale_x: 1,
        scale_y: 1,
        opacity: 1,
        src_in_us: 0,
        props: props ?? {},
      };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const { tInLayerUs } of times) {
        const prevResource = sprite.sprite.texture.source?.resource ?? null;
        bindSignalled = false;
        sprite.update(view, tInLayerUs, durationUs);
        // The async bind path (cache MISS) leaves the texture unchanged during
        // this synchronous update() — the previous frame stays bound until the
        // capture resolves and fires onLoaded (flipping `bindSignalled`). A
        // SYNC cache hit, by contrast, swaps the resource in-place HERE without
        // firing onLoaded. Wait until EITHER the async signal fired OR the
        // bound resource changed (sync hit), with a hard deadline.
        const deadline = Date.now() + 10000;
        // eslint-disable-next-line no-await-in-loop
        while (
          !bindSignalled &&
          (sprite.sprite.texture.source?.resource ?? null) === prevResource
        ) {
          if (Date.now() > deadline) {
            throw new Error("motif sprite bind timed out");
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(20);
        }
        const tex = sprite.sprite.texture;
        const bitmap = tex.source?.resource as ImageBitmap | undefined;
        if (!bitmap) throw new Error("sprite bound no bitmap resource");
        // Checksum the whole frame via a 2D canvas (createImageBitmap output
        // is clean — getImageData won't taint; see apps/desktop/e2e/electron/motif-capture.spec.ts).
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let checksum = 0;
        for (let i = 0; i < data.length; i++) checksum = (checksum + data[i]!) >>> 0;
        out.push({
          tInLayerUs,
          width: bitmap.width,
          height: bitmap.height,
          checksum,
        });
      }
    } finally {
      sprite.dispose();
    }
    return out;
  };

  hookSlot().renderImageOverlaySpriteFrames = async ({
    mediaId,
    times,
    durationUs,
    maxWidth,
    maxHeight,
  }) => {
    const media = useProjectStore.getState().mediaById.get(mediaId);
    if (!media) throw new Error(`renderImageOverlaySpriteFrames: media ${mediaId} not in store`);
    const url = convertFileSrc(media.path);
    // Decode directly so any error surfaces (loadFromAsset silently catches
    // decode failures and falls back to a 1-frame static bitmap, which would
    // make the animation/loop assertions pass vacuously or fail confusingly).
    const anim = await decodeAnimatedImage(url, maxWidth, maxHeight);
    const sprite = new ImageOverlaySprite({ layerId: "e2e-image-sprite", mediaId, maxWidth, maxHeight });
    try {
      // Inject the decoded animation so sprite.update() picks the right frame.
      (sprite as unknown as { anim: typeof anim; animKey: string | null }).anim = anim;
      (sprite as unknown as { animKey: string | null }).animKey = null; // no cache release needed
      // A static, fully-opaque view; only tInLayerUs drives the frame choice.
      const view = {
        media_id: mediaId,
        x: 0,
        y: 0,
        scale_x: 1,
        scale_y: 1,
        opacity: 1,
        fade_in_us: 0,
        fade_out_us: 0,
      } as unknown as ResolvedImageOverlayView;
      const samples: Array<{ tInLayerUs: number; width: number; height: number; checksum: number }> = [];
      for (const { tInLayerUs } of times) {
        sprite.update(view, tInLayerUs, durationUs);
        const bitmap = sprite.sprite.texture.source?.resource as ImageBitmap | undefined;
        if (!bitmap) throw new Error("image sprite bound no bitmap");
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let checksum = 0;
        for (let i = 0; i < data.length; i++) checksum = (checksum + data[i]!) >>> 0;
        samples.push({ tInLayerUs, width: bitmap.width, height: bitmap.height, checksum });
      }
      return {
        totalUs: anim.totalUs,
        frameCount: anim.frames.length,
        samples,
      };
    } finally {
      sprite.dispose();
      // Close the directly-decoded frames (not cache-owned here).
      for (const f of anim.frames) {
        try { f.close(); } catch { /* best-effort */ }
      }
    }
  };

  // Trigger a full L2 pre-bake of a motif layer (via the prebakeBus) and
  // wait until `expectedFrames` PNG files appear on disk. The cacheKey is
  // computed from the live project summary so the spec needs only the layerId.
  hookSlot().prebakeLayerAndWait = async ({ layerId, expectedFrames, timeoutMs = 60_000 }) => {
    // Derive the cacheKey from the current project summary.
    const summary = await projectSummary();
    let cacheKey: string | null = null;
    outer: for (const track of summary.tracks) {
      for (const layer of track.layers) {
        if (layer.id !== layerId || layer.params.kind !== "Motif") continue;
        const motif = getMotif(layer.params.motif_id);
        if (!motif) break outer;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const desc = motifFrameDescriptor(layer.params, 0, durationUs, summary.composition.fps_num, summary.composition.fps_den, motif);
        if (desc) cacheKey = desc.cacheKey;
        break outer;
      }
    }
    if (cacheKey === null) {
      throw new Error(`prebakeLayerAndWait: layer ${layerId} not found or has no motif`);
    }

    requestPrebake(layerId);

    const ws = await workspaceDir();
    if (!ws) throw new Error("prebakeLayerAndWait: no workspace open");
    const hashName = hashCacheKey(cacheKey);
    const hashDir = await pathJoin(ws, "Cache", "raster", hashName);

    const deadline = Date.now() + timeoutMs;
    let pngCount = 0;
    while (Date.now() < deadline) {
      if (await exists(hashDir)) {
        const entries = await readDir(hashDir);
        pngCount = entries.filter((e) => !e.isDirectory && e.name?.endsWith(".png")).length;
        if (pngCount >= expectedFrames) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (pngCount < expectedFrames) {
      throw new Error(
        `prebakeLayerAndWait: timed out — found ${pngCount}/${expectedFrames} PNGs in ${hashDir}`,
      );
    }
    return { hashDir, hashName, pngCount };
  };

  hookSlot().listBakedHashDirs = async () => {
    const ws = await workspaceDir();
    if (!ws) return [];
    const root = await pathJoin(ws, "Cache", "raster");
    if (!(await exists(root))) return [];
    const entries = await readDir(root);
    return entries.flatMap((e) => e.isDirectory ? [e.name ?? ""] : []);
  };

  hookSlot().gcRasterDirs = async (activeCacheKeys) => {
    await sharedMotifFrameCache.gcUnreferenced(activeCacheKeys);
  };

  hookSlot().cacheKeyForLayer = async (layerId) => {
    const summary = await projectSummary();
    for (const track of summary.tracks) {
      for (const layer of track.layers) {
        if (layer.id !== layerId || layer.params.kind !== "Motif") continue;
        const motif = getMotif(layer.params.motif_id);
        if (!motif) return null;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const desc = motifFrameDescriptor(layer.params, 0, durationUs, summary.composition.fps_num, summary.composition.fps_den, motif);
        return desc?.cacheKey ?? null;
      }
    }
    return null;
  };

  hookSlot().addMotifLayer = async ({ motifId, durationUs, props }) => {
    return addMotif({ motifId, tStartUs: 0, tEndUs: durationUs, ...(props !== undefined ? { props } : {}) });
  };

  hookSlot().patchMotifLayerProps = async ({ layerId, props }) => {
    await updateLayerParams(layerId, { kind: "Motif", props });
  };

  hookSlot().clearMotifCacheKey = (cacheKey: string): void => {
    sharedMotifFrameCache.clearKey(cacheKey);
  };

  hookSlot().bakedIndexHas = (cacheKey: string): boolean => {
    return sharedBakedKeyIndex.has(cacheKey);
  };
}

/// Resolve once the just-imported media has a decided export route in the UI
/// store — i.e. `resolveDecode(media).exportPath != null`, the EXACT condition
/// the export-readiness gate reads.
///
/// `importMedia`/`addMediaLayer` mutate the actor; those changes reach this
/// store asynchronously (via the `project:changed` bridge), and the
/// decodability decision that sets the export route lands a beat later still.
/// A real user clicks Export only after the clip appears ready on the timeline;
/// the hook otherwise fires `runExport` in the same tick, racing the bridge.
/// When it wins, the gate reads a project that doesn't yet reference the layer
/// (so `referencedVideoMediaIds` is empty → nothing to wait on), then
/// `runExport`'s snapshot picks up the media with its route still undecided and
/// throws `"… has no export-ready source"`. Gating the hook on the same
/// condition the gate uses makes that race impossible. (The companion product
/// fix — a sequence guard in `wireProjectStore` — keeps the route from being
/// clobbered back to undecided after this wait resolves.)
function waitForMediaExportReady(mediaId: string, timeoutMs: number): Promise<void> {
  const ready = () => {
    const m = useProjectStore.getState().mediaById.get(mediaId);
    return m != null && resolveDecode(m).exportPath != null;
  };
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(
        new Error(
          `media ${mediaId} not export-ready within ${timeoutMs}ms ` +
            `(decodability/proxy decision never produced a playback path)`,
        ),
      );
    }, timeoutMs);
    const settle = () => {
      if (!ready()) return;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    unsub = useProjectStore.subscribe(settle);
    // Re-check in case readiness landed between the initial check and subscribe.
    settle();
  });
}

/// Root-side: expose the Motifs capture pipeline to e2e specs.
/// Installs `window.__weftcutTest.captureMotifFrame(...)` which drives the
/// `motif_capture_frame` IPC command (offscreen Electron window
/// + `motif:` scheme + CDP `Page.captureScreenshot` via webContents.debugger). Returns the raw
/// base64 PNG string so the spec can compare, hash, and decode without
/// importing bundled modules (the spec's page.evaluate is closed-world).
///
/// Dev/e2e only — called from main.tsx's e2e branch after `motif_register_runtime`
/// has been called (the frontend calls that at startup, so by the time the spec
/// runs it is already registered).
export function installMotifHook(): void {
  hookSlot().captureMotifFrame = async ({ motifId, tSec, props, width, height }) => {
    const bitmap = await captureMotifFrame(motifId, tSec, props, width, height);
    // Convert the ImageBitmap to a base64 PNG string so the e2e spec can
    // compare raw bytes without importing any bundled codec. The spec receives
    // a plain string from page.evaluate — transferring an ImageBitmap would
    // require structured-clone support the evaluate boundary doesn't expose.
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  };

  // Live-preview integration hooks. `motifAddCountdown` drops a 5 s countdown
  // Motif layer onto the timeline through the SAME `add_motif` IPC the
  // MotifPicker uses — the countdown Motif's manifest supplies the metadata
  // (size 480×480 + props seconds/label/accent) so the compositor's
  // resolveMotifFrame → rasterMotifFrame (CDP) path renders it live.
  // `weftcutSeekUs` / `weftcutSampleComposite`
  // delegate to the PreviewBridge registered by `PixiPreview`.
  hookSlot().motifAddCountdown = async () => {
    return addMotif({
      motifId: "countdown",
      tStartUs: 0,
      tEndUs: 5_000_000,
    });
  };
  hookSlot().weftcutSeekUs = (us: number) => {
    if (!previewBridge) throw new Error("weftcutSeekUs: preview bridge not registered");
    previewBridge.seekUs(us);
  };
  hookSlot().weftcutSampleComposite = async (x: number, y: number) => {
    if (!previewBridge) throw new Error("weftcutSampleComposite: preview bridge not registered");
    return previewBridge.sampleComposite(x, y);
  };
  // Preview-sw conformance: read the active clip's decode source +
  // sprite off the live Compositor, capture the composited frame, and expose
  // the persisted decode route — the three facts the spec needs to prove the
  // native software-decode preview path end-to-end.
  hookSlot().activeClipProbe = (layerId?: string) => {
    if (!previewBridge) throw new Error("activeClipProbe: preview bridge not registered");
    return previewBridge.activeClipProbe(layerId);
  };
  hookSlot().capturePreviewFramePng = async () => {
    if (!previewBridge) throw new Error("capturePreviewFramePng: preview bridge not registered");
    return previewBridge.capturePng();
  };
  hookSlot().mediaDecodeRouteKind = (mediaId: string) => {
    return useProjectStore.getState().mediaById.get(mediaId)?.decode_route?.route ?? null;
  };
  hookSlot().mediaById = (mediaId: string) => {
    return useProjectStore.getState().mediaById.get(mediaId) ?? null;
  };
  // Drive the REAL setter (IPC invoke + optimistic setState on
  // useProxyPrefStore) rather than the raw update_project_settings command —
  // see the E2EHook.setPreferProxies doc comment for why the raw command
  // alone never reaches proxyIntent/resolveSource.
  hookSlot().setPreferProxies = (v: boolean) => setPreferProxies(v);
}

/// Most-recently-mounted Pixi preview's bridge. Written by
/// `installPreviewBridge` on each `PixiPreview` mount; the seek + composite
/// readback hooks read it. Null until the first preview mounts.
let previewBridge: PreviewBridge | null = null;

/// Called by `PixiPreview` (behind the e2e guard) once its Compositor +
/// PlaybackEngine are wired. Hands the readback/seek hooks a live bridge to the
/// active renderer + engine so the e2e spec can drive a real seek and
/// read pixels straight off the composited canvas. Re-registering replaces the
/// prior bridge (StrictMode re-mount / project swap).
export function installPreviewBridge(bridge: PreviewBridge): void {
  if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
  previewBridge = bridge;
}

/// Called by `PixiPreview` on unmount (behind the same e2e guard as
/// `installPreviewBridge`) so the seek/readback hooks don't hold a stale
/// closure over a disposed Compositor + PlaybackEngine.
export function clearPreviewBridge(): void {
  previewBridge = null;
}

/// Resolve once the media appears in the project store (the `project:changed`
/// bridge delivers actor mutations asynchronously) and, when `pred` is given,
/// once it also satisfies `pred`.
function waitForMediaInStore(
  mediaId: string,
  timeoutMs: number,
  what: string,
  pred?: (m: NonNullable<ReturnType<typeof mediaFromStore>>) => boolean,
): Promise<void> {
  const ready = () => {
    const m = mediaFromStore(mediaId);
    return m != null && (pred?.(m) ?? true);
  };
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`media ${mediaId}: ${what} not satisfied within ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = () => {
      if (!ready()) return;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    unsub = useProjectStore.subscribe(settle);
    settle();
  });
}

function mediaFromStore(mediaId: string) {
  return useProjectStore.getState().mediaById.get(mediaId);
}

/// App-side: the real export. `runExport` is App's `runExportWithSettings`,
/// which awaits the full encode + audio + mux to completion.
export function installExportHook(
  runExport: RunExport,
  revealLayer: (layerId: string) => void,
): void {
  hookSlot().revealLayer = ({ layerId }) => revealLayer(layerId);

  hookSlot().importAndPlaceMedia = async ({ mediaAbsPath, tStartUs }) => {
    const mediaId = await importMedia(mediaAbsPath);
    const trackId = await addTrack();
    const layerId = await addMediaLayer(trackId, mediaId, tStartUs ?? 0);
    await waitForMediaInStore(mediaId, 10000, "store sync");
    return { mediaId, layerId, kind: mediaFromStore(mediaId)!.kind };
  };

  hookSlot().placeMediaLayer = async ({ mediaId, tStartUs }) => {
    const trackId = await addTrack();
    const layerId = await addMediaLayer(trackId, mediaId, tStartUs ?? 0);
    return { layerId };
  };

  hookSlot().waitMediaExportReady = async ({ mediaId, timeoutMs }) => {
    await waitForMediaExportReady(mediaId, timeoutMs ?? 120000);
  };

  hookSlot().exportTimeline = async ({ outputAbsPath, settings, range }) => {
    await runExport(mergeSettings(settings ?? null), outputAbsPath, range);
    if (!(await exists(outputAbsPath))) {
      throw new Error(`export produced no output file at ${outputAbsPath}`);
    }
  };

  hookSlot().mediaConformPath = ({ mediaId }) =>
    mediaFromStore(mediaId)?.conform_path ?? null;

  hookSlot().sampleWaveformRms = async ({
    mediaId,
    timesUs,
    pxPerSec = 100,
    windowMs = 80,
    timeoutMs = 60_000,
  }) => {
    registerWaveformProducer();
    const maxUs = Math.max(1, ...timesUs) + 100_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const win = await ensureWaveformWindow(mediaId, 0, 0, maxUs, pxPerSec);
      if (win !== "pending" && win !== "not_ready") {
        const rms = timesUs.map((timeUs) => {
          const globalPeak = Math.round((timeUs / 1_000_000) * win.peaksPerSecond);
          const center = globalPeak - win.startPeak;
          if (windowMs === 0) return win.rms[center] ?? 0;
          const radius = Math.max(
            1,
            Math.round((windowMs / 2_000) * win.peaksPerSecond),
          );
          const lo = Math.max(0, center - radius);
          const hi = Math.min(win.rms.length, center + radius);
          let sum = 0;
          for (let i = lo; i < hi; i++) sum += win.rms[i]!;
          return sum / Math.max(1, hi - lo);
        });
        return { peaksPerSecond: win.peaksPerSecond, rms };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`waveform ${mediaId} not ready within ${timeoutMs}ms`);
  };

  hookSlot().exportClip = async ({
    mediaAbsPath,
    outputAbsPath,
    settings,
    range,
    audioPatches,
  }) => {
    const mediaId = await importMedia(mediaAbsPath);
    const trackId = await addTrack();
    await addMediaLayer(trackId, mediaId, 0);
    // Audio-engine scenarios: N patches want N copies of the clip (the
    // extras on their own tracks), so overlap/limiter cases can stack.
    if (audioPatches && audioPatches.length > 1) {
      for (let i = 1; i < audioPatches.length; i++) {
        const extraTrack = await addTrack();
        await addMediaLayer(extraTrack, mediaId, 0);
      }
    }
    // Mirror a real user: don't export until the clip is export-ready in the
    // store the gate reads (see waitForMediaExportReady). Audio conform is
    // deliberately NOT pre-waited: the export's own audio gate
    // (`ensure_export_audio_conform` + conform job events) owns that wait,
    // and pre-waiting here would shadow the very path these specs gate.
    await waitForMediaExportReady(mediaId, 60000);
    if (audioPatches && audioPatches.length > 0) {
      const summary = await projectSummary();
      const audioLayerIds: string[] = [];
      for (const tr of summary.tracks) {
        for (const l of tr.layers) {
          if (l.params.kind === "Audio") audioLayerIds.push(l.id);
        }
      }
      if (audioLayerIds.length < audioPatches.length) {
        throw new Error(
          `expected ${audioPatches.length} auto-paired Audio layers, found ${audioLayerIds.length} — is auto_pair_audio_on_import off, or does the fixture lack an audio stream?`,
        );
      }
      for (let i = 0; i < audioPatches.length; i++) {
        await updateLayerParams(audioLayerIds[i]!, {
          kind: "Audio",
          ...audioPatches[i]!,
        });
      }
      // The extra copies' VideoClips stay ENABLED: stacked same-phase clips
      // of one source share a merged-range export pipeline (see
      // exportHandleKey), so they cost nothing — and leaving them on keeps
      // these audio scenarios doubling as overlap-export regression cover.
    }
    await runExport(mergeSettings(settings ?? null), outputAbsPath, range);
    if (!(await exists(outputAbsPath))) {
      throw new Error(`export produced no output file at ${outputAbsPath}`);
    }
  };

  hookSlot().exportMotifClip = async ({
    motifId,
    outputAbsPath,
    durationUs,
    props,
    settings,
  }) => {
    // Add a Motif layer at t=0. `add_motif` auto-creates / reuses a track
    // and defaults t_end to the motif's default duration unless overridden.
    await addMotif({
      motifId,
      tStartUs: 0,
      ...(durationUs != null ? { tEndUs: durationUs } : {}),
      ...(props ? { props } : {}),
    });
    // No video source, so the readiness gate has nothing to wait on — the
    // export proceeds straight to bake + composite. runExport bakes the
    // motif frames on the main thread and transfers them into the Worker.
    await runExport(mergeSettings(settings ?? null), outputAbsPath, undefined);
    if (!(await exists(outputAbsPath))) {
      throw new Error(`export produced no output file at ${outputAbsPath}`);
    }
  };
}

/// Root-side: install audio test hooks (preview pan-graph probe). Lives at Root
/// level — no App/export state needed. Called once on boot from main.tsx.
export function installAudioTestHooks(): void {
  // Render the preview pan matrix graph offline and return mean L/R energy.
  // Drives the REAL buildPanGraph so the e2e covers graph wiring, not math.
  // Constant pan exercises the topology deterministically; the animated coeff
  // path (panCurves) is covered by the envelope coeff-env golden.
  hookSlot().panRenderProbe = async ({ channels, pan, frames }) => {
    const sr = 48_000;
    const ctx = new OfflineAudioContext(2, frames, sr);
    const buf = ctx.createBuffer(channels, frames, sr);
    for (let c = 0; c < channels; c++) buf.copyToChannel(new Float32Array(frames).fill(1), c);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const env = { stepUs: 10_000, spanUs: (frames / sr) * 1e6, values: [pan] };
    const g = buildPanGraph(ctx, channels);
    src.connect(g.input);
    g.output.connect(ctx.destination);
    // constant pan: set gains directly (mirrors AudioMixer fast path)
    const cg = constantPanGains(env, channels);
    g.gains.forEach((node, i) => (node.gain.value = cg[i] ?? 0));
    src.start();
    const rendered = await ctx.startRendering();
    const lCh = rendered.getChannelData(0);
    const rCh = rendered.getChannelData(1);
    let l = 0;
    let r = 0;
    for (let i = 0; i < frames; i++) {
      l += lCh[i]! * lCh[i]!;
      r += rCh[i]! * rCh[i]!;
    }
    return { l: Math.sqrt(l / frames), r: Math.sqrt(r / frames) };
  };
}
