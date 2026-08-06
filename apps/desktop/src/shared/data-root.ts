// Shared types for the user-managed data-root migration IPC surface.
// Imported by BOTH the Electron main process (the dataRoot:* IPC handlers +
// dataRootMigration.ts) and the renderer (bridge wrappers / the Settings UI), so
// the two sides can't drift — mirrors how app-settings types are single-sourced
// in src/shared/app-settings.ts. Pure types + one const map, no DOM / Node /
// runtime dependency (so the DOM-free main process can import it too).
//
// The `data_root` VALUE itself lives in src/shared/app-settings.ts; this file is
// the migration ACTION contract layered on top of it.

/** Result of `dataRoot:current`. */
export interface DataRootCurrent {
  /** The resolved, effective data root this process is running on (absolute). */
  path: string
  /**
   * True when running on the default `<userData>/data` because a configured
   * `data_root` could not be honored — derived by comparing the resolved root to
   * the configured setting (the `dataRoot:current` handler in src/main/index.ts,
   * which owns the why). Surfaced so the UI can annotate the rare case.
   */
  isFallback: boolean
}

/** One progress tick pushed on `evt:dataRoot:progress` during a copy migration. */
export interface DataRootProgress {
  phase: 'copy' | 'verify' | 'done'
  /** The bucket currently being copied (copy phase only). */
  bucket?: 'motifs' | 'downloads'
  /** Files copied so far across all copied buckets. */
  copiedFiles: number
  /** Total files to copy across all copied buckets (0 until counted). */
  totalFiles: number
}

/** Result of `dataRoot:pickAndMigrate`. */
export type DataRootMigrateResult =
  /** Migration succeeded; `data_root` written + pending-delete marker recorded.
   *  The caller shows success then triggers `dataRoot:relaunch` — no auto-relaunch. */
  | { ok: true; mode: 'adopt' | 'copy'; newPath: string }
  /** The user cancelled the native folder picker (no change). */
  | { ok: false; cancelled: true }
  /** Plan/copy/verify failed; the new folder was rolled back, `data_root` unchanged. */
  | { ok: false; error: string }

/** Result of `dataRoot:pendingCleanup` — the old copy the user may delete. */
export interface DataRootPendingCleanup {
  /** Absolute path of the previous data root whose copy can now be deleted. */
  oldPath: string
}

/** Event names pushed to the renderer during a migration (subscribe via api.on). */
export const DATA_ROOT_EVENTS = {
  progress: 'dataRoot:progress',
} as const
