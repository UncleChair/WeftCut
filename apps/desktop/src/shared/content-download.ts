// Wire types for the app-managed content download surface (`content:*` IPC),
// shared by the Electron main process (owner of the downloader,
// src/main/contentDownload.ts) and the renderer (Settings UI). One definition →
// no main↔renderer drift — the same single-sourcing rule as
// src/shared/data-root.ts. Pure types + consts, no DOM / Node dependency.
//
// The catalog VALUES live in src/shared/content-catalog.ts; this file is the
// action/status contract layered on top of them.

/// `${process.platform}-${process.arch}` keys the catalog's per-platform
/// artifacts. Only platforms with shipped content appear; a platform absent
/// from an item's map reports the item `unavailable` there.
export type ContentPlatformKey =
  | "win32-x64"
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64";

/// One downloadable payload for one platform. Supply-chain rule
/// (docs/licensing.md): the URL is versioned and immutable — never a rolling
/// "latest" — and sha256 + exact byte count are pinned so the artifact, not
/// the claim, is what gets verified.
export interface ContentArtifact {
  url: string;
  sha256: string;
  /// Exact size of the archive (or raw payload) in bytes. Doubles as the
  /// progress denominator and as a cheap integrity floor for status checks.
  bytes: number;
  archive: "zip" | "none";
  /// Path of the item's entry point relative to its install dir once
  /// installed — e.g. "Release/whisper-cli.exe" inside the extracted zip, or
  /// the payload file's own name for `archive: "none"`.
  entryPath: string;
}

/// Which speech backend consumes an item, and which LocalEngineConfig field
/// its entry point fills. The main-process auto-fill consumer keys off this
/// instead of hard-coding item ids.
export interface SpeechConsumer {
  backend: "whisper_cpp";
  field: "binary" | "model" | "tokens";
}

/// One catalog entry. `version` names the install directory
/// (<dataRoot>/downloads/<id>/<version>/) so a future upgrade is a sibling
/// install, never an in-place mutation.
export interface ContentItem {
  id: string;
  kind: "speech-runtime" | "speech-model";
  version: string;
  /// i18n key for the human label (en-US + zh-CN).
  labelKey: string;
  /// License provenance travels with the record (docs/licensing.md).
  license: { name: string; upstreamUrl: string };
  /// i18n key for a platform prerequisite note (e.g. the MSVC v14 x64
  /// runtime the official whisper.cpp Windows build dynamically imports).
  prerequisiteKey?: string;
  speech?: SpeechConsumer;
  platforms: Partial<Record<ContentPlatformKey, ContentArtifact>>;
}

/// Install-state of one item on this machine, as reported by `content:list`.
export type ContentItemStatus =
  | { state: "not_installed" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number }
  /// `entryPath` is the ABSOLUTE path of the installed entry point.
  | { state: "installed"; entryPath: string }
  /// A manifest exists but the payload is missing or size-mismatched —
  /// surfaced instead of silently re-listing as not_installed so the UI can
  /// offer a re-download that explains itself.
  | { state: "corrupt" }
  /// No artifact for this platform in the catalog.
  | { state: "unavailable" };

/// One row of `content:list`: the catalog entry merged with local state.
export interface ContentListRow {
  item: ContentItem;
  status: ContentItemStatus;
}

/// One progress tick pushed on `evt:content:progress` while a download runs.
/// `verify` covers the post-stream hash comparison, `extract` the zip stage.
export interface ContentDownloadProgress {
  itemId: string;
  phase: "download" | "verify" | "extract" | "done" | "error";
  receivedBytes: number;
  totalBytes: number;
  /// Present on phase "error" only.
  error?: string;
}

/// Result of `content:download`. Mirrors DataRootMigrateResult: a user
/// cancellation is its own quiet branch, never an error path.
export type ContentDownloadResult =
  | { ok: true; entryPath: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

/// Event names pushed to the renderer (subscribe via api.on).
export const CONTENT_EVENTS = {
  progress: "content:progress",
} as const;

/// Derive this process's platform key. Returns null on platforms the catalog
/// scheme doesn't name (the UI then treats every item as `unavailable`).
export function contentPlatformKey(
  platform: string,
  arch: string,
): ContentPlatformKey | null {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "win32-x64":
    case "darwin-x64":
    case "darwin-arm64":
    case "linux-x64":
      return key;
    default:
      return null;
  }
}
