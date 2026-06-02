// Fixture runner. Loads a fixture directory from disk, synthesizes the
// in-memory shape `runExport` expects (ProjectSummary + mediaById Map
// with absolute paths), drives the export Worker, returns MP4 bytes.
//
// P10a foundation + P10b SSIM compare. The CI-callable headless-Tauri
// binary that drives this without a webview lives in a follow-up
// (P10c); until then, fixture authoring + regression checks happen
// locally via the devtools helpers in `devHooks.ts`.
//
// Fixture format: see `apps/desktop/fixtures/README.md`.

/// SSIM pass threshold for fixture checks. `image-compare`'s
/// MSSIMSimple returns a score in [0, 1] where 1.0 is pixel-identical.
/// 0.995 is "very similar" — tight enough to catch real regressions
/// (off-by-one shifts, blend-mode changes, dropped layers) but loose
/// enough to absorb encoder noise + display-color jitter between the
/// canvas-rendered MP4 and the committed PNG baseline.
///
/// Single source of truth — per-fixture tolerances are deliberately
/// not supported in P10b. If a fixture needs a different threshold
/// it likely needs a different DESIGN (e.g. shorter / fewer samples)
/// rather than a tuned epsilon. P10c will reconsider if real CI data
/// proves otherwise.
export const FIXTURE_SSIM_PASS_THRESHOLD = 0.995;

import { invoke } from "@tauri-apps/api/core";
import * as fs from "@tauri-apps/plugin-fs";

import type { MediaSummary, ProjectSummary } from "../../ipc";
import { runExport, type RunExportResult } from "../worker/runExport";

export interface FixtureManifest {
  name: string;
  description?: string;
  /// Composition pixel dimensions. Should match `project.json`'s
  /// composition entry — the runner cross-checks.
  width: number;
  height: number;
  /// Microseconds-from-zero at which baseline frames should be sampled.
  /// Must be strictly increasing.
  sample_times_us: number[];
}

export interface RunFixtureResult {
  manifest: FixtureManifest;
  export: RunExportResult;
  /// Full rendered MP4 bytes, reassembled from the streamed export chunks.
  /// The production export streams to disk to avoid a whole-file ArrayBuffer;
  /// fixtures are tiny, so buffering them in memory here is fine.
  videoBytes: ArrayBuffer;
  /// Absolute path the runner used as the fixture root — propagated so
  /// the dev shell can write expected/ PNGs alongside the source files
  /// without re-asking for the path.
  fixtureRoot: string;
}

/// Concatenate streamed export chunks into one contiguous ArrayBuffer.
export function concatExportChunks(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/// Load + run a fixture end-to-end through the export Worker. Caller
/// is responsible for writing the resulting MP4 / extracting frames /
/// computing baselines. This function does no I/O after the export
/// finishes.
export async function runFixture(fixtureRoot: string): Promise<RunFixtureResult> {
  const manifest = await loadManifest(fixtureRoot);
  const project = await loadProject(fixtureRoot);
  validateManifestAgainstProject(manifest, project);

  const mediaById = buildMediaById(project, fixtureRoot);

  const chunks: Uint8Array[] = [];
  const exp = await runExport({
    summary: project,
    mediaById,
    writeChunk: async (data) => {
      chunks.push(new Uint8Array(data));
    },
  });

  return {
    manifest,
    export: exp,
    videoBytes: concatExportChunks(chunks),
    fixtureRoot,
  };
}

/// Extract a PNG frame from the MP4 at composition-time `tUs`. Round-
/// trips through the Rust `extract_video_frame` command (ffmpeg-sidecar
/// under the hood). Returns raw PNG bytes.
export async function extractFrame(
  mp4Bytes: ArrayBuffer,
  tUs: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(mp4Bytes);
  // Tauri's command bridge serializes typed arrays as plain arrays;
  // explicit Array conversion keeps the shape predictable across
  // backends. Same applies to the response.
  const out = (await invoke("extract_video_frame", {
    mp4Bytes: Array.from(bytes),
    tUs,
  })) as number[];
  return new Uint8Array(out);
}

/// Generate baselines for `fixtureRoot`. For each `sample_times_us`
/// entry in the fixture's manifest, extracts a PNG from the rendered
/// MP4 and writes it to `<fixtureRoot>/expected/t_<us>.png`. Overwrites
/// existing files. Returns the list of paths written.
///
/// Run this exactly once per fixture (or whenever the renderer
/// intentionally changes how a fixture renders). The output PNGs
/// become the ground truth — commit them. `checkFixture` then
/// SSIM-compares against them on every subsequent run.
export async function generateBaselines(fixtureRoot: string): Promise<string[]> {
  const result = await runFixture(fixtureRoot);
  const written: string[] = [];
  const expectedDir = joinPath(fixtureRoot, "expected");
  await fs.mkdir(expectedDir, { recursive: true });
  for (const tUs of result.manifest.sample_times_us) {
    const png = await extractFrame(result.videoBytes, tUs);
    const dest = joinPath(expectedDir, `t_${tUs}.png`);
    await fs.writeFile(dest, png);
    written.push(dest);
  }
  return written;
}

/// One sample-time comparison result from `checkFixture`. `score` is
/// the raw SSIM number; `pass` reflects whether it cleared the
/// `FIXTURE_SSIM_PASS_THRESHOLD`. `missingBaseline` is true when the
/// expected/ PNG doesn't exist yet — the runner can't fail-closed in
/// that case because no ground truth exists, but the caller surfaces
/// it as a needs-baseline signal.
export interface CheckSampleResult {
  tUs: number;
  expectedPath: string;
  score: number | null;
  pass: boolean;
  missingBaseline: boolean;
  error?: string;
}

export interface CheckFixtureResult {
  fixtureRoot: string;
  manifest: FixtureManifest;
  samples: CheckSampleResult[];
  /// True iff every sample either passed or was a missing-baseline
  /// (missing-baselines are not failures — they're "owed work" the
  /// fixture author hasn't done yet).
  pass: boolean;
}

/// Run a fixture end-to-end and SSIM-compare each sample against the
/// committed baselines in `expected/`. The fixture-suite consumer
/// (devtools, eventually CI) folds these into a pass/fail report.
export async function checkFixture(
  fixtureRoot: string,
): Promise<CheckFixtureResult> {
  const ran = await runFixture(fixtureRoot);
  const samples: CheckSampleResult[] = [];
  let allPass = true;
  for (const tUs of ran.manifest.sample_times_us) {
    const expectedPath = joinPath(fixtureRoot, `expected/t_${tUs}.png`);
    let actualBytes: Uint8Array;
    try {
      actualBytes = await extractFrame(ran.videoBytes, tUs);
    } catch (e) {
      samples.push({
        tUs,
        expectedPath,
        score: null,
        pass: false,
        missingBaseline: false,
        error: errMessage(e),
      });
      allPass = false;
      continue;
    }

    if (!(await fileExists(expectedPath))) {
      samples.push({
        tUs,
        expectedPath,
        score: null,
        pass: false,
        missingBaseline: true,
      });
      // Missing baselines aren't pass-blocking — they're a "run
      // generateBaselines once" signal that the caller surfaces
      // separately.
      continue;
    }

    try {
      const score = (await invoke("compare_fixture_frame", {
        actualPngBytes: Array.from(actualBytes),
        expectedPngPath: expectedPath,
      })) as number;
      const pass = score >= FIXTURE_SSIM_PASS_THRESHOLD;
      samples.push({
        tUs,
        expectedPath,
        score,
        pass,
        missingBaseline: false,
      });
      if (!pass) allPass = false;
    } catch (e) {
      samples.push({
        tUs,
        expectedPath,
        score: null,
        pass: false,
        missingBaseline: false,
        error: errMessage(e),
      });
      allPass = false;
    }
  }
  return {
    fixtureRoot,
    manifest: ran.manifest,
    samples,
    pass: allPass,
  };
}

export interface SuiteReport {
  suiteRoot: string;
  fixtures: CheckFixtureResult[];
  pass: boolean;
}

/// Check every immediate subdirectory of `suiteRoot` that contains a
/// `manifest.json`. Returns one report per fixture plus a top-level
/// `pass` flag (true iff every fixture passed and none had a hard
/// error). Missing baselines do not fail the suite — they show up
/// as `missingBaseline: true` entries in the report.
export async function checkFixtureSuite(suiteRoot: string): Promise<SuiteReport> {
  const entries = await fs.readDir(suiteRoot);
  // Sort by directory name so reports are deterministic across runs
  // (filesystems don't promise order).
  const fixtureDirs = entries
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();

  const fixtures: CheckFixtureResult[] = [];
  let allPass = true;
  for (const name of fixtureDirs) {
    const root = joinPath(suiteRoot, name);
    const manifestPath = joinPath(root, "manifest.json");
    if (!(await fileExists(manifestPath))) {
      // Skip directories without a manifest (README.md sits at the
      // suite root and shouldn't be scanned).
      continue;
    }
    const result = await checkFixture(root);
    fixtures.push(result);
    if (!result.pass) allPass = false;
  }
  return { suiteRoot, fixtures, pass: allPass };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ----- internals ----------------------------------------------------------

async function loadManifest(root: string): Promise<FixtureManifest> {
  const text = await fs.readTextFile(joinPath(root, "manifest.json"));
  const parsed = JSON.parse(text) as unknown;
  return validateManifest(parsed);
}

async function loadProject(root: string): Promise<ProjectSummary> {
  const text = await fs.readTextFile(joinPath(root, "project.json"));
  return JSON.parse(text) as ProjectSummary;
}

function validateManifest(raw: unknown): FixtureManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("fixture manifest must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const name = r.name;
  const width = r.width;
  const height = r.height;
  const samples = r.sample_times_us;
  if (typeof name !== "string" || !name) {
    throw new Error("fixture manifest: 'name' required");
  }
  if (typeof width !== "number" || width <= 0) {
    throw new Error("fixture manifest: 'width' must be a positive number");
  }
  if (typeof height !== "number" || height <= 0) {
    throw new Error("fixture manifest: 'height' must be a positive number");
  }
  if (
    !Array.isArray(samples) ||
    samples.some((s) => typeof s !== "number" || s < 0)
  ) {
    throw new Error(
      "fixture manifest: 'sample_times_us' must be an array of non-negative numbers",
    );
  }
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] as number) <= (samples[i - 1] as number)) {
      throw new Error(
        "fixture manifest: 'sample_times_us' must be strictly increasing",
      );
    }
  }
  return {
    name,
    // Only include `description` when present — under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not assignable
    // to the optional `description?: string` field.
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    width,
    height,
    sample_times_us: samples as number[],
  };
}

function validateManifestAgainstProject(
  manifest: FixtureManifest,
  project: ProjectSummary,
): void {
  const c = project.composition;
  if (c.width !== manifest.width || c.height !== manifest.height) {
    throw new Error(
      `fixture: manifest dims (${manifest.width}×${manifest.height}) ` +
        `disagree with project.json composition (${c.width}×${c.height})`,
    );
  }
  // Sample times must lie inside the project duration. A sample at
  // exactly duration_us is past the last frame and produces undefined
  // pixels in ffmpeg's seek path — reject so the author gets a clear
  // signal rather than a mystery DSSIM diff later.
  for (const t of manifest.sample_times_us) {
    if (t >= project.duration_us) {
      throw new Error(
        `fixture: sample time ${t}µs falls at or past project ` +
          `duration ${project.duration_us}µs`,
      );
    }
  }
}

/// Walk the project's media list and produce the `mediaById` Map that
/// `runExport` consumes. Media paths in `project.json` are stored
/// RELATIVE to the fixture root (e.g. `media/clip.mp4`); the runner
/// rewrites them to absolute so `convertFileSrc` produces a real
/// asset:// URL.
export function buildMediaById(
  project: ProjectSummary,
  fixtureRoot: string,
): ReadonlyMap<string, MediaSummary> {
  const map = new Map<string, MediaSummary>();
  for (const m of project.media) {
    const absolutePath = expandRelative(m.path, fixtureRoot);
    const proxyAbs = m.proxy_path
      ? expandRelative(m.proxy_path, fixtureRoot)
      : null;
    const quickProxyAbs = m.quick_proxy_path
      ? expandRelative(m.quick_proxy_path, fixtureRoot)
      : null;
    map.set(m.id, {
      ...m,
      path: absolutePath,
      proxy_path: proxyAbs,
      quick_proxy_path: quickProxyAbs,
    });
  }
  return map;
}

/// Resolve `p` against `root` if it's relative; pass through unchanged
/// if already absolute. Recognizes Windows drive-letter prefixes
/// (`C:\…`) and POSIX leading-slash absolutes.
export function expandRelative(p: string, root: string): string {
  if (isAbsolute(p)) return p;
  return joinPath(root, p);
}

function isAbsolute(p: string): boolean {
  // POSIX
  if (p.startsWith("/")) return true;
  // Windows: drive letter + colon + (forward or back) slash
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // UNC paths
  if (p.startsWith("\\\\")) return true;
  return false;
}

/// Cheap path-join that handles both forward and back slashes. Avoids
/// pulling in `@tauri-apps/api/path` for the test path — the helpers
/// here stay testable in Node without Tauri.
export function joinPath(a: string, b: string): string {
  const trimA = a.replace(/[\\/]+$/, "");
  const trimB = b.replace(/^[\\/]+/, "");
  return `${trimA}/${trimB}`;
}
