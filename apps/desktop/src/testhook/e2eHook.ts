// Dev/E2E-only control surface. Installed ONLY when
// import.meta.env.VITE_WEFTCUT_E2E === "1" (set by the e2e build), so it is
// absent from normal production bundles (the dynamic import behind that static
// check is dead-code-eliminated). Lets the WebDriver spec drive a real
// new-project -> import -> place -> export through the SAME code paths the UI
// uses, in the real WebView2.
//
// Two-part because the editor (App, where the export lives) only mounts AFTER a
// project is open: main.tsx installs `newProjectAndEnter` (create workspace +
// flip Root to the editor stage); App installs `exportClip` once mounted.
import {
  importMedia,
  addVideoTrack,
  addMediaLayer,
  addMotif,
  projectNewWorkspace,
  projectSummary,
  updateLayerParams,
  workspaceDir,
  type CanvasPreset,
} from "../ipc";
import { captureMotifFrame } from "../render/motifs/host";
import { hashCacheKey } from "../render/motifs/frameCache";
import { sharedMotifFrameCache, sharedBakedKeyIndex } from "../render/motifs/motifRasterCache";
import { motifFrameDescriptor } from "../render/motifs/motifFrameDescriptor";
import { getMotif } from "../render/motifs/catalog";
import { requestPrebake } from "../render/motifs/prebakeBus";
import { mergeSettings, type ExportSettings } from "../render/exportSettings";
import { useProjectStore, exportPlaybackPathFor } from "../state/projectStore";
import { exists, readDir } from "@tauri-apps/plugin-fs";
import { join as pathJoin } from "@tauri-apps/api/path";
import { MotifSprite } from "../render/sprite/MotifSprite";
import type { MotifView } from "../ipc";

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
  /// Import `mediaAbsPath`, place it 1:1 at t=0 on a fresh video track, and
  /// export to `outputAbsPath`. `settings` overlays DEFAULT_EXPORT_SETTINGS
  /// (H.264/mp4, follow-composition res+fps). `range` trims the export to
  /// `[startUs, endUs)` (audio + video); omit for the whole composition.
  /// Rejects if no output is written.
  exportClip(args: {
    mediaAbsPath: string;
    outputAbsPath: string;
    settings?: Partial<ExportSettings>;
    range?: { startUs: number; endUs: number };
  }): Promise<void>;
  /// Add a built-in Template layer at t=0 (default duration) and export to
  /// `outputAbsPath`. No video clip is needed — the export composites the
  /// template-only timeline, driving the FULL real export path: main-thread
  /// `exportBakeMotifs` → transfer → Worker `TemplateSprite` bind-by-index.
  /// Proves templates render in export (they were silently absent before). The
  /// caller (project + editor) must already be set up via `newProjectAndEnter`.
  exportTemplateClip(args: {
    templateId: string;
    outputAbsPath: string;
    durationUs?: number;
    props?: Record<string, unknown>;
    settings?: Partial<ExportSettings>;
  }): Promise<void>;
  /// Drive the REAL `TemplateSprite` (Task A) over a built-in template at two
  /// layer-relative times and read back the interior pixel of each bound
  /// raster. Exercises the full sprite chain in real WebView2:
  /// `update(view, tInLayerUs, durationUs)` → frame index → `frameTimeSec` →
  /// `resolveMotifFrame` → `rasterMotifFrame` (CDP) → bound `Texture`. The spec
  /// asserts the two frames differ (the template animated across the
  /// timeline). `browser.execute` can't import the bundled `TemplateSprite`,
  /// so it's constructed here and the result reduced to plain numbers.
  ///
  /// Returns, per requested time: the bound bitmap dims + a content checksum
  /// (sum of every RGBA byte, read via OffscreenCanvas + getImageData). The
  /// checksum differs whenever the rendered frame differs — the countdown's
  /// numeral + sweeping progress arc both change per frame, so two distinct
  /// times produce distinct checksums.
  renderTemplateSpriteFrames(args: {
    templateId: string;
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
  /// Trigger a persisted pre-bake of a template layer (via the prebakeBus) and
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
  /// Compute the cacheKey for a template layer by looking up its current state in
  /// the project summary. Returns null if the layer doesn't exist or isn't a Template.
  cacheKeyForLayer(layerId: string): Promise<string | null>;
  /// Add a template layer at t=0 with the given duration and return its layerId.
  /// Thin wrapper over the `add_template` IPC so e2e specs don't need raw
  /// Tauri invoke access. Only available after the editor mounts.
  addTemplateLayer(args: {
    templateId: string;
    durationUs: number;
    props?: Record<string, unknown>;
  }): Promise<string>;
  /// Patch a template layer's props (merges field-wise). Used by the pre-bake
  /// e2e to change the `accent` prop and observe a new cacheKey / new hash dir.
  patchTemplateLayerProps(args: {
    layerId: string;
    props: Record<string, unknown>;
  }): Promise<void>;
  /// Evict every L0 (in-RAM) frame for a cacheKey, so a subsequent resolve must
  /// come from disk (L2) or a fresh raster. Used to prove the disk read path.
  clearTemplateCacheKey(cacheKey: string): void;
  /// Whether the in-RAM baked-key index currently marks this cacheKey baked.
  bakedIndexHas(cacheKey: string): boolean;
  /// Render a Motif frame via the Rust `motif_capture_frame` command and
  /// return the raw base64 PNG string (no `data:` prefix). Dev/e2e only:
  /// exposes the Motifs capture pipeline to WebDriver specs which cannot
  /// import bundled modules. Requires the Motif runtime to have been
  /// registered by the frontend (motif_register_runtime).
  captureMotifFrame(args: {
    motifId: string;
    tSec: number;
    props: Record<string, unknown>;
    width: number;
    height: number;
  }): Promise<string>;
  /// Add a `countdown` Template layer at t=0 spanning [0, 5s) with default
  /// props (480×480, seconds/label/accent), via the real `add_template` IPC.
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
}

function hookSlot(): Partial<E2EHook> {
  const w = window as unknown as { __weftcutTest?: Partial<E2EHook> };
  if (!w.__weftcutTest) w.__weftcutTest = {};
  return w.__weftcutTest;
}

/// Root-side: workspace creation + entering the editor. `enterEditor` is
/// Root's `setStage("editor")`.
export function installBootstrapHook(enterEditor: () => void): void {
  hookSlot().newProjectAndEnter = async (args) => {
    await projectNewWorkspace(args);
    enterEditor();
  };
}

/// Root-side: install Motif test hooks (prebake, cache ops, sprite frames,
/// add/patch/clear/baked-index). Lives at Root level; called once on boot.
export function installMotifTestHooks(): void {
  // Drive the REAL TemplateSprite (Task A) and read back each bound frame's
  // content checksum so the spec can prove the template animates across the
  // timeline through the sprite's own frame-selection + bind path.
  hookSlot().renderTemplateSpriteFrames = async ({
    templateId,
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
    // Compositor reuses an ActiveTemplate sprite while the playhead moves.
    // `onLoaded` fires on the async bind path (cache miss); a flag flips so the
    // per-time waiter below (and the sync-hit detection) can settle.
    let bindSignalled = false;
    const sprite = new MotifSprite({
      layerId: "e2e-motif-sprite",
      motifId: templateId,
      fpsNum,
      fpsDen,
      onLoaded: () => {
        bindSignalled = true;
      },
    });
    try {
      const view: MotifView = {
        motif_id: templateId,
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
            throw new Error("template sprite bind timed out");
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(20);
        }
        const tex = sprite.sprite.texture;
        const bitmap = tex.source?.resource as ImageBitmap | undefined;
        if (!bitmap) throw new Error("sprite bound no bitmap resource");
        // Checksum the whole frame via a 2D canvas (createImageBitmap output
        // is clean — getImageData won't taint; see templates.e2e.js).
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

  // Trigger a full L2 pre-bake of a template layer (via the prebakeBus) and
  // wait until `expectedFrames` PNG files appear on disk. The cacheKey is
  // computed from the live project summary so the spec needs only the layerId.
  hookSlot().prebakeLayerAndWait = async ({ layerId, expectedFrames, timeoutMs = 60_000 }) => {
    // Derive the cacheKey from the current project summary.
    const summary = await projectSummary();
    let cacheKey: string | null = null;
    outer: for (const track of summary.tracks) {
      for (const layer of track.layers) {
        if (layer.id !== layerId || layer.params.kind !== "Motif") continue;
        const template = getMotif(layer.params.motif_id);
        if (!template) break outer;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const desc = motifFrameDescriptor(layer.params, 0, durationUs, summary.composition.fps_num, summary.composition.fps_den, template);
        if (desc) cacheKey = desc.cacheKey;
        break outer;
      }
    }
    if (cacheKey === null) {
      throw new Error(`prebakeLayerAndWait: layer ${layerId} not found or has no template`);
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
    return entries.filter((e) => e.isDirectory).map((e) => e.name ?? "");
  };

  hookSlot().gcRasterDirs = async (activeCacheKeys) => {
    await sharedMotifFrameCache.gcUnreferenced(activeCacheKeys);
  };

  hookSlot().cacheKeyForLayer = async (layerId) => {
    const summary = await projectSummary();
    for (const track of summary.tracks) {
      for (const layer of track.layers) {
        if (layer.id !== layerId || layer.params.kind !== "Motif") continue;
        const template = getMotif(layer.params.motif_id);
        if (!template) return null;
        const durationUs = layer.t_end_us - layer.t_start_us;
        const desc = motifFrameDescriptor(layer.params, 0, durationUs, summary.composition.fps_num, summary.composition.fps_den, template);
        return desc?.cacheKey ?? null;
      }
    }
    return null;
  };

  hookSlot().addTemplateLayer = async ({ templateId, durationUs, props }) => {
    return addMotif({ motifId: templateId, tStartUs: 0, tEndUs: durationUs, ...(props !== undefined ? { props } : {}) });
  };

  hookSlot().patchTemplateLayerProps = async ({ layerId, props }) => {
    await updateLayerParams(layerId, { kind: "Motif", props });
  };

  hookSlot().clearTemplateCacheKey = (cacheKey: string): void => {
    sharedMotifFrameCache.clearKey(cacheKey);
  };

  hookSlot().bakedIndexHas = (cacheKey: string): boolean => {
    return sharedBakedKeyIndex.has(cacheKey);
  };
}

/// Resolve once the just-imported media has a decided export route in the UI
/// store — i.e. `exportPlaybackPathFor(media) != null`, the EXACT condition the
/// export-readiness gate reads.
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
  const ready = () =>
    exportPlaybackPathFor(useProjectStore.getState().mediaById.get(mediaId)) != null;
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

/// Root-side: expose the Motifs capture pipeline to WebDriver specs.
/// Installs `window.__weftcutTest.captureMotifFrame(...)` which drives the
/// Rust `motif_capture_frame` IPC command (Approach A: hidden WebView2 host
/// window + `motif:` scheme + CDP `Page.captureScreenshot`). Returns the raw
/// base64 PNG string so the spec can compare, hash, and decode without
/// importing bundled modules (browser.execute is closed-world).
///
/// Dev/e2e only — called from main.tsx's e2e branch after `motif_register_runtime`
/// has been called (the frontend calls that at startup, so by the time the spec
/// runs it is already registered).
export function installMotifHook(): void {
  hookSlot().captureMotifFrame = async ({ motifId, tSec, props, width, height }) => {
    const bitmap = await captureMotifFrame(motifId, tSec, props, width, height);
    // Convert the ImageBitmap to a base64 PNG string so the WebDriver spec can
    // compare raw bytes without importing any bundled codec. The spec receives
    // a plain string from browser.execute — transferring an ImageBitmap would
    // require structured-clone support which WebDriver doesn't expose.
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
  // Template layer onto the timeline through the SAME `add_template` IPC the
  // TemplatePicker uses — the legacy SVG catalog supplies the metadata (size
  // 480×480 + props seconds/label/accent), which align with the Motif
  // `countdown` so the compositor's resolveMotifFrame → rasterMotifFrame
  // (CDP) path renders it live. `weftcutSeekUs` / `weftcutSampleComposite`
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
}

/// Most-recently-mounted Pixi preview's bridge. Written by
/// `installPreviewBridge` on each `PixiPreview` mount; the seek + composite
/// readback hooks read it. Null until the first preview mounts.
let previewBridge: PreviewBridge | null = null;

/// Called by `PixiPreview` (behind the e2e guard) once its Compositor +
/// PlaybackEngine are wired. Hands the readback/seek hooks a live bridge to the
/// active renderer + engine so the WebDriver spec can drive a real seek and
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

/// App-side: the real export. `runExport` is App's `runExportWithSettings`,
/// which awaits the full encode + audio + mux to completion.
export function installExportHook(runExport: RunExport): void {
  hookSlot().exportClip = async ({ mediaAbsPath, outputAbsPath, settings, range }) => {
    const mediaId = await importMedia(mediaAbsPath);
    const trackId = await addVideoTrack();
    await addMediaLayer(trackId, mediaId, 0);
    // Mirror a real user: don't export until the clip is export-ready in the
    // store the gate reads (see waitForMediaExportReady).
    await waitForMediaExportReady(mediaId, 60000);
    await runExport(mergeSettings(settings ?? null), outputAbsPath, range);
    if (!(await exists(outputAbsPath))) {
      throw new Error(`export produced no output file at ${outputAbsPath}`);
    }
  };

  hookSlot().exportTemplateClip = async ({
    templateId,
    outputAbsPath,
    durationUs,
    props,
    settings,
  }) => {
    // Add a Motif layer at t=0. `add_motif` auto-creates / reuses a track
    // and defaults t_end to the motif's default duration unless overridden.
    await addMotif({
      motifId: templateId,
      tStartUs: 0,
      ...(durationUs != null ? { tEndUs: durationUs } : {}),
      ...(props ? { props } : {}),
    });
    // No video source, so the readiness gate has nothing to wait on — the
    // export proceeds straight to bake + composite. runExport bakes the
    // template frames on the main thread and transfers them into the Worker.
    await runExport(mergeSettings(settings ?? null), outputAbsPath, undefined);
    if (!(await exists(outputAbsPath))) {
      throw new Error(`export produced no output file at ${outputAbsPath}`);
    }
  };
}
