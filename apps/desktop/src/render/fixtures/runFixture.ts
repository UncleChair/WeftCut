// Reusable fixture runner. Loads a project from a fixture directory,
// drives it through preview-mode Compositor for visual smoke-testing,
// or through the export Worker for the DSSIM gate harness.
//
// Plan: docs/pixi-renderer-plan.md (P10)
//
// P0 stub. P10 implements the load + drive logic and a separate
// fixture-runner binary on the Rust side that invokes via headless
// Tauri.

export interface FixtureRunInput {
  /// Absolute path to fixture directory (contains project.vproj + media/ + expected/).
  fixtureDir: string;
  /// Mode: 'preview' dumps to PNG sequence from preview render; 'export'
  /// goes through the export Worker → MP4 → frame extract.
  mode: "preview" | "export";
}

export async function runFixture(_input: FixtureRunInput): Promise<void> {
  throw new Error("runFixture: not yet implemented (P10)");
}
