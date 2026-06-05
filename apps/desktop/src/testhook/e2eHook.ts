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
  projectNewWorkspace,
  type CanvasPreset,
} from "../ipc";
import { mergeSettings, type ExportSettings } from "../render/exportSettings";
import { useProjectStore, exportPlaybackPathFor } from "../state/projectStore";
import { exists } from "@tauri-apps/plugin-fs";
import { getTemplate, type Template, type TemplateManifest } from "../render/templates/catalog";
import { TemplateHarness } from "../render/templates/harness";
import { rasterizeSvg } from "../render/templates/svgRaster";
// Build-time embed of a real woff2 so the synthetic test fixture can declare a
// bundled font WITHOUT shipping an asset under builtin/. `jassub` is a direct
// dependency of this package; its bundled woff2 is stable repo state (unlike a
// build-output font). Vite's `?arraybuffer` query yields the bytes inline.
import testFixtureFontBytes from "jassub/dist/default.woff2?arraybuffer";

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
  /// Capture one frame of a built-in template through a `TemplateHarness`
  /// (sandboxed-iframe `render(t)` → serialized post-render `<svg>` string).
  /// Lets a WebDriver spec exercise the real harness without importing bundled
  /// modules (`browser.execute` can't). Loads `templateId` lazily on first call
  /// and reuses the harness across calls. Returns the SVG markup string.
  renderTemplateFrameSvg(args: {
    templateId: string;
    tSec: number;
    durSec: number;
    props?: Record<string, unknown>;
  }): Promise<string>;
  /// Capture one frame of a SYNTHETIC, test-only template through a fresh
  /// `TemplateHarness`, then rasterize the captured `<svg>`. The fixture is
  /// built inline here (NOT in the shipping catalog) and exercises three
  /// present-but-untested harness features the only built-in (`countdown`)
  /// can't reach:
  ///   1. clock stub — `render()` writes `String(Date.now())` into `#clock`;
  ///      the harness stubs `Date.now`→0, so the capture must contain `>0<`.
  ///   2. in-`<svg>` `<script>` strip — a `<script>` child of the `<svg>`
  ///      (not a sibling) must be removed from the serialized clone.
  ///   3. bundled font — a declared `@font-face` (with embedded woff2 bytes)
  ///      must be injected into the captured markup.
  /// Returns the serialized `<svg>` plus whether `rasterizeSvg(svg)` resolved
  /// (a clean rasterize proves the stripped output is well-formed XML).
  renderTestFixtureSvg(args: {
    tSec: number;
    durSec: number;
    props?: Record<string, unknown>;
  }): Promise<{ svg: string; rasterizeOk: boolean }>;
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

/// Root-side: expose the template capture harness. A WebDriver spec can't
/// import the bundled `TemplateHarness`, so we construct one here and surface a
/// single async call that loads a built-in template (lazily, cached per id) and
/// returns the serialized post-render `<svg>` for a given time. Lives at Root
/// level (the harness only needs `document.body`, not an open project), so the
/// spec runs self-contained on the StartupScreen — same as the rasterizer test.
export function installTemplateHarnessHook(): void {
  // One harness per templateId, loaded on first request and reused after.
  const loaded = new Map<string, { harness: TemplateHarness; ready: Promise<void> }>();
  hookSlot().renderTemplateFrameSvg = async ({ templateId, tSec, durSec, props }) => {
    let entry = loaded.get(templateId);
    if (!entry) {
      const template = getTemplate(templateId);
      if (!template) throw new Error(`renderTemplateFrameSvg: unknown template ${templateId}`);
      const harness = new TemplateHarness();
      entry = { harness, ready: harness.load(template) };
      loaded.set(templateId, entry);
    }
    await entry.ready;
    return entry.harness.renderFrameSvg(tSec, durSec, props ?? {});
  };

  // Synthetic test-only fixture (built inline; NOT in the shipping catalog).
  let fixture: { harness: TemplateHarness; ready: Promise<void> } | null = null;
  hookSlot().renderTestFixtureSvg = async ({ tSec, durSec, props }) => {
    if (!fixture) {
      const harness = new TemplateHarness();
      fixture = { harness, ready: harness.load(buildTestFixtureTemplate()) };
    }
    await fixture.ready;
    const svg = await fixture.harness.renderFrameSvg(tSec, durSec, props ?? {});
    // A clean rasterize proves the script-stripped markup is well-formed XML
    // (a stray `<script>` left in the clone would make `<img>` parsing fail).
    let rasterizeOk = false;
    try {
      const bitmap = await rasterizeSvg(svg);
      rasterizeOk = true;
      bitmap.close?.();
    } catch {
      rasterizeOk = false;
    }
    return { svg, rasterizeOk };
  };
}

/// Build the synthetic, test-only `Template` exercising all three otherwise
/// untested harness features in ONE document (see `renderTestFixtureSvg`).
///
/// The HTML carries:
///   - a SIBLING `<script>` defining `render()` (kept functional). `render()`
///     reads `Date.now()` INSIDE the call — the harness stubs `Date.now`→0
///     only after the template script evaluates, so a top-level read would
///     capture the real epoch; the in-`render` read gets the stubbed `0`.
///   - a `<script>` that is a CHILD of the `<svg>` (inert; only there to be
///     stripped by the harness clone). Distinct from the sibling so the
///     clock-stub and script-strip proofs don't entangle.
///   - a declared `@font-face` family the harness injects from `Template.fonts`
///     (keyed `.../assets/test.woff2`, matched by `collectFonts`'s `endsWith`).
function buildTestFixtureTemplate(): Template {
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"></head>',
    '<body style="margin:0">',
    '  <svg xmlns="http://www.w3.org/2000/svg" width="320" height="120">',
    // Text node whose content render() overwrites with String(Date.now()).
    '    <text id="clock" x="20" y="50" font-family="HarnessTestFont" ' +
      'font-size="32" fill="#ffffff">pending</text>',
    // <script> INSIDE the <svg>: a strip target, not a sibling. Inert.
    '    <script type="application/ecmascript">/* in-svg inert script */</script>',
    "  </svg>",
    // SIBLING <script>: defines the functional render().
    "  <script>",
    "    function render(tSec, durationSec, props) {",
    // Read Date.now() HERE (after the harness stub is installed) so the
    // capture shows the stubbed 0, not a real 13-digit epoch.
    "      document.getElementById('clock').textContent = String(Date.now());",
    "    }",
    "    function ready() { return Promise.resolve(); }",
    "  </script>",
    "</body></html>",
  ].join("\n");

  const manifest: TemplateManifest = {
    id: "__test_fixture__",
    name: "Harness Test Fixture",
    version: 1,
    size: [320, 120],
    default_duration_s: 3,
    engine: "svg",
    props_schema: {},
    fonts: [{ family: "HarnessTestFont", file: "test.woff2" }],
  };

  return {
    manifest,
    html,
    // Key ends with `/assets/test.woff2` so collectFonts() matches it.
    fonts: { "test-fixture/assets/test.woff2": new Uint8Array(testFixtureFontBytes) },
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
}
