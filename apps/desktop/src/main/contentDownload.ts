// The app-managed content downloader: stream → verify → install for catalog
// items (src/shared/content-catalog.ts), plus the install-status derivation
// `content:list` reports. Every side effect goes through injected deps (fs,
// http, zip) — no Electron imports and no direct node:fs — so the whole
// lifecycle is unit-testable in-memory (the dataRootMigration.ts discipline).
// The production adapters (Electron net.fetch, node:fs, fflate) are built at
// the call site in src/main/index.ts.
//
// Layout it owns:
//   <downloadsDir>/<id>/<version>/...            installed payload
//   <downloadsDir>/<id>/<version>/manifest.json  written LAST — its presence
//                                                marks a complete install
//   <downloadsDir>/<id>/.staging-<version>/      extraction scratch, renamed
//                                                into place atomically
//   <partialDir>/<id>.part                       in-flight stream target; the
//                                                partial dir lives under
//                                                cache/ (regenerable), so the
//                                                data-root migration never
//                                                copies junk

import { createHash } from "node:crypto";
import type {
  ContentArtifact,
  ContentDownloadProgress,
  ContentDownloadResult,
  ContentItem,
  ContentItemStatus,
  ContentPlatformKey,
} from "../shared/content-download";

/** Minimal fs surface — in-memory in tests, node:fs at the call site. */
export interface ContentFs {
  mkdirp(dir: string): void;
  /** Recursive + force — a no-op when the path is missing. */
  rm(path: string): void;
  rename(from: string, to: string): void;
  /** Byte size of a file, or null when it does not exist. */
  statBytes(path: string): number | null;
  writeText(path: string, text: string): void;
  writeBytes(path: string, data: Uint8Array): void;
  openWrite(path: string): { write(chunk: Uint8Array): void; close(): void };
}

/**
 * GET the url and return the response body as a chunk stream. Must throw on
 * network failure and non-2xx status; must respect the AbortSignal (the
 * production Electron net.fetch adapter does both natively).
 */
export interface ContentHttp {
  get(url: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

export interface ZipEntry {
  /** Entry path as recorded in the archive (zip convention: "/" separators). */
  path: string;
  data: Uint8Array;
}

export interface ContentDeps {
  fs: ContentFs;
  http: ContentHttp;
  /** Read every file entry of a zip on disk (fflate in production). */
  readZipEntries(archivePath: string): Promise<readonly ZipEntry[]>;
  join(...parts: string[]): string;
  downloadsDir: string;
  partialDir: string;
  /** ISO timestamp for manifest `installedAt` (injected: Date is banned in tests). */
  now(): string;
}

/** Digest/size verification failed — retried like a network error, because a
 *  truncated or corrupted transfer is indistinguishable from one. */
class IntegrityError extends Error {}

/** A zip entry tried to escape the staging dir — never retried: the payload
 *  hash already matched, so re-downloading yields the same hostile archive. */
class ZipSlipError extends Error {}

const MAX_ATTEMPTS = 3;

export function installDir(deps: ContentDeps, item: ContentItem): string {
  return deps.join(deps.downloadsDir, item.id, item.version);
}

function manifestPath(deps: ContentDeps, item: ContentItem): string {
  return deps.join(installDir(deps, item), "manifest.json");
}

function entryAbsPath(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
): string {
  return deps.join(installDir(deps, item), ...artifact.entryPath.split("/"));
}

/**
 * Fast install-state check: manifest presence + entry-point existence (+ exact
 * byte count for raw payloads, where the pinned size IS the payload size).
 * Zip members have no per-file pin, so their check is existence-only — the
 * full hash ran at install time and the manifest records it ("verify the
 * artifact" happens at download; this is the cheap steady-state read).
 */
export function itemStatus(
  deps: ContentDeps,
  item: ContentItem,
  platform: ContentPlatformKey | null,
): ContentItemStatus {
  const artifact = platform ? item.platforms[platform] : undefined;
  if (!artifact) return { state: "unavailable" };

  const manifestBytes = deps.fs.statBytes(manifestPath(deps, item));
  const entryBytes = deps.fs.statBytes(entryAbsPath(deps, item, artifact));

  if (manifestBytes == null) return { state: "not_installed" };
  const entryOk =
    entryBytes != null &&
    (artifact.archive !== "none" || entryBytes === artifact.bytes);
  if (!entryOk) return { state: "corrupt" };
  return { state: "installed", entryPath: entryAbsPath(deps, item, artifact) };
}

/**
 * Reject archive entries that would write outside the staging dir. Paths are
 * normalized ("\" → "/") before the check so a Windows-authored archive still
 * extracts, while absolute, drive-lettered, or `..`-traversing entries throw.
 * Returns the safe "/"-separated segments.
 */
function guardedEntrySegments(entryPath: string): string[] {
  const normalized = entryPath.replace(/\\/g, "/");
  if (/^([a-zA-Z]:)?\//.test(normalized)) {
    throw new ZipSlipError(`absolute zip entry path: ${entryPath}`);
  }
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    throw new ZipSlipError(`traversal in zip entry path: ${entryPath}`);
  }
  return segments;
}

/**
 * Download, verify, and atomically install one catalog item. Progress ticks
 * fire per chunk (throttling is the IPC layer's concern). The result union
 * mirrors DataRootMigrateResult: cancellation is a quiet branch, not an error.
 */
export async function downloadItem(
  deps: ContentDeps,
  item: ContentItem,
  platform: ContentPlatformKey | null,
  onProgress: (p: ContentDownloadProgress) => void,
  signal: AbortSignal,
): Promise<ContentDownloadResult> {
  const artifact = platform ? item.platforms[platform] : undefined;
  if (!artifact) {
    return { ok: false, error: `no artifact for this platform: ${item.id}` };
  }

  const partialPath = deps.join(deps.partialDir, `${item.id}.part`);
  const stagingDir = deps.join(
    deps.downloadsDir,
    item.id,
    `.staging-${item.version}`,
  );

  const cleanup = (): void => {
    deps.fs.rm(partialPath);
    deps.fs.rm(stagingDir);
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await fetchAndVerify(deps, artifact, item.id, partialPath, onProgress, signal);
      // Past this point failures are NOT retried: the bytes on disk already
      // hashed clean, so extraction/install errors are local, not transfer.
      onProgress({
        itemId: item.id,
        phase: "extract",
        receivedBytes: artifact.bytes,
        totalBytes: artifact.bytes,
      });
      const entryPath = await installVerified(deps, item, artifact, partialPath, stagingDir);
      onProgress({
        itemId: item.id,
        phase: "done",
        receivedBytes: artifact.bytes,
        totalBytes: artifact.bytes,
      });
      return { ok: true, entryPath };
    } catch (e) {
      cleanup();
      if (signal.aborted) return { ok: false, cancelled: true };
      const message = e instanceof Error ? e.message : String(e);
      // Transfer-stage failures (network, size, sha) retry; post-verify
      // failures (extraction, install, zip-slip) are local and never do.
      if (attempt < MAX_ATTEMPTS && !installStageReached(e)) continue;
      onProgress({
        itemId: item.id,
        phase: "error",
        receivedBytes: 0,
        totalBytes: artifact.bytes,
        error: message,
      });
      return { ok: false, error: message };
    }
  }
  // Unreachable: the loop always returns; TypeScript needs the branch.
  return { ok: false, error: "download failed" };
}

/** Marker for errors thrown after verification — see the retry boundary above. */
class InstallStageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
function installStageReached(e: unknown): boolean {
  return e instanceof InstallStageError || e instanceof ZipSlipError;
}

async function fetchAndVerify(
  deps: ContentDeps,
  artifact: ContentArtifact,
  itemId: string,
  partialPath: string,
  onProgress: (p: ContentDownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  deps.fs.mkdirp(deps.partialDir);
  deps.fs.rm(partialPath);

  const stream = await deps.http.get(artifact.url, signal);
  const sink = deps.fs.openWrite(partialPath);
  const hash = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error("aborted");
      sink.write(chunk);
      hash.update(chunk);
      received += chunk.byteLength;
      onProgress({
        itemId,
        phase: "download",
        receivedBytes: received,
        totalBytes: artifact.bytes,
      });
    }
  } finally {
    sink.close();
  }

  onProgress({
    itemId,
    phase: "verify",
    receivedBytes: received,
    totalBytes: artifact.bytes,
  });
  if (received !== artifact.bytes) {
    throw new IntegrityError(
      `size mismatch for ${itemId}: expected ${artifact.bytes} bytes, got ${received}`,
    );
  }
  const digest = hash.digest("hex");
  if (digest !== artifact.sha256) {
    throw new IntegrityError(
      `sha256 mismatch for ${itemId}: expected ${artifact.sha256}, got ${digest}`,
    );
  }
}

/**
 * Turn the verified partial into <id>/<version>/: build the full payload in a
 * staging dir, rename it into place, then write manifest.json last. "Atomic"
 * here means crash-shaped, not tick-shaped — a crash at any point leaves
 * either scratch (swept at start) or a manifest-less dir (reported
 * not_installed), never a half-install that claims to be whole.
 */
async function installVerified(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
  partialPath: string,
  stagingDir: string,
): Promise<string> {
  const finalDir = installDir(deps, item);
  try {
    deps.fs.rm(stagingDir);
    deps.fs.mkdirp(stagingDir);
    if (artifact.archive === "zip") {
      const entries = await deps.readZipEntries(partialPath);
      for (const entry of entries) {
        // Directory entries carry no payload; their files mkdirp their own
        // parents below.
        if (entry.path.endsWith("/")) continue;
        const segments = guardedEntrySegments(entry.path);
        if (segments.length === 0) continue;
        if (segments.length > 1) {
          deps.fs.mkdirp(deps.join(stagingDir, ...segments.slice(0, -1)));
        }
        deps.fs.writeBytes(deps.join(stagingDir, ...segments), entry.data);
      }
      deps.fs.rm(partialPath);
    } else {
      deps.fs.rename(
        partialPath,
        deps.join(stagingDir, ...artifact.entryPath.split("/")),
      );
    }
    finishInstall(deps, item, artifact, stagingDir, finalDir);
    return entryAbsPath(deps, item, artifact);
  } catch (e) {
    if (e instanceof ZipSlipError) throw e;
    throw new InstallStageError(e);
  }
}

function finishInstall(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
  stagingDir: string,
  finalDir: string,
): void {
  deps.fs.rm(finalDir);
  deps.fs.mkdirp(deps.join(deps.downloadsDir, item.id));
  deps.fs.rename(stagingDir, finalDir);
  deps.fs.writeText(
    deps.join(finalDir, "manifest.json"),
    JSON.stringify(
      {
        id: item.id,
        version: item.version,
        url: artifact.url,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        license: item.license,
        installedAt: deps.now(),
      },
      null,
      2,
    ),
  );
}

/** Remove stray in-flight files (crash leftovers); call once at app start. */
export function sweepPartials(deps: ContentDeps): void {
  deps.fs.rm(deps.partialDir);
  deps.fs.mkdirp(deps.partialDir);
}

/**
 * The speech-config entries that installed managed content should create —
 * the ADR 0039 consumer's decision logic, pure so the only-if-blank rule is
 * testable. Per backend: every `speech`-tagged item must be installed to form
 * an entry (a half pair configures nothing), and an existing entry with ANY
 * non-blank path wins outright — a manual path is never overwritten, and a
 * partially-manual entry is left entirely alone (mixing provenance in one
 * entry is worse than none).
 */
export function speechAutofillPlan(
  items: readonly ContentItem[],
  statusOf: (item: ContentItem) => ContentItemStatus,
  existingLocal: Record<string, { binary: string; model: string }>,
): Array<{ backend: string; config: { binary: string; model: string; tokens?: string } }> {
  const byBackend = new Map<
    string,
    Partial<Record<"binary" | "model" | "tokens", string>> & { complete: boolean }
  >();
  for (const item of items) {
    if (!item.speech) continue;
    const slot = byBackend.get(item.speech.backend) ?? { complete: true };
    const status = statusOf(item);
    if (status.state === "installed") {
      slot[item.speech.field] = status.entryPath;
    } else if (status.state !== "unavailable") {
      // A catalog item this backend needs exists for the platform but is not
      // installed — the pair is incomplete, so nothing is configured.
      slot.complete = false;
    }
    byBackend.set(item.speech.backend, slot);
  }

  const plan: Array<{ backend: string; config: { binary: string; model: string; tokens?: string } }> = [];
  for (const [backend, slot] of byBackend) {
    if (!slot.complete || !slot.binary || !slot.model) continue;
    const existing = existingLocal[backend];
    if (existing && (existing.binary.trim() !== "" || existing.model.trim() !== "")) continue;
    plan.push({
      backend,
      config: {
        binary: slot.binary,
        model: slot.model,
        ...(slot.tokens ? { tokens: slot.tokens } : {}),
      },
    });
  }
  return plan;
}
