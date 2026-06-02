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
import { exists } from "@tauri-apps/plugin-fs";

type RunExport = (settings: ExportSettings, outputPath: string) => Promise<void>;

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
  /// (H.264/mp4, follow-composition res+fps). Rejects if no output is written.
  exportClip(args: {
    mediaAbsPath: string;
    outputAbsPath: string;
    settings?: Partial<ExportSettings>;
  }): Promise<void>;
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

/// App-side: the real export. `runExport` is App's `runExportWithSettings`,
/// which awaits the full encode + audio + mux to completion.
export function installExportHook(runExport: RunExport): void {
  hookSlot().exportClip = async ({ mediaAbsPath, outputAbsPath, settings }) => {
    const mediaId = await importMedia(mediaAbsPath);
    const trackId = await addVideoTrack();
    await addMediaLayer(trackId, mediaId, 0);
    await runExport(mergeSettings(settings ?? null), outputAbsPath);
    if (!(await exists(outputAbsPath))) {
      throw new Error(`export produced no output file at ${outputAbsPath}`);
    }
  };
}
