// Fixture runner. Loads a fixture directory from disk, synthesizes the
// in-memory shape `runExport` expects (ProjectSummary + mediaById Map
// with absolute paths), drives the export Worker, returns MP4 bytes.
//
// P10a foundation. The DSSIM-compare side that turns this into a real
// CI gate lands in P10b (`bin/render_fixture.rs` + dssim-core).
// Until then, the JS-side runner is consumed by a dev surface that
// generates baselines into `expected/` for one-off authoring.
//
// Fixture format: see `apps/desktop/fixtures/README.md`.

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
  /// Absolute path the runner used as the fixture root — propagated so
  /// the dev shell can write expected/ PNGs alongside the source files
  /// without re-asking for the path.
  fixtureRoot: string;
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

  const exp = await runExport({
    summary: project,
    mediaById,
  });

  return { manifest, export: exp, fixtureRoot };
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
/// Manual-loop helper for now; the auto-CI flow uses the same
/// extract path but stores baselines in-repo (committed by the
/// fixture author) and DSSIM-compares against them.
export async function generateBaselines(fixtureRoot: string): Promise<string[]> {
  const result = await runFixture(fixtureRoot);
  const written: string[] = [];
  const expectedDir = joinPath(fixtureRoot, "expected");
  await fs.mkdir(expectedDir, { recursive: true });
  for (const tUs of result.manifest.sample_times_us) {
    const png = await extractFrame(result.export.videoBytes, tUs);
    const dest = joinPath(expectedDir, `t_${tUs}.png`);
    await fs.writeFile(dest, png);
    written.push(dest);
  }
  return written;
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
    description: typeof r.description === "string" ? r.description : undefined,
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
    map.set(m.id, {
      ...m,
      path: absolutePath,
      proxy_path: proxyAbs,
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
