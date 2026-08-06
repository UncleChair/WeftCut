// Data-root migration core. Pure logic for safely CHANGING the
// user-configurable data root (resolved by dataRoot.ts): plan (adopt-or-copy),
// copy user content to the new root, verify it, and roll back on failure — plus
// a userData-resident "delete the old copy after a successful relaunch" marker.
//
// The whole safety model rests on: the OLD root is READ-ONLY throughout — the
// originals are preserved until the user explicitly confirms deletion post-
// relaunch (dataRoot:deleteOld). This module never writes to or deletes anything
// under oldRoot except from the explicit deleteOldCopy() entry point.
//
// No Electron imports: the filesystem surface + path join are INJECTED so this
// is unit-testable in-memory (mirrors the DI style of dataRoot.ts /
// app-settings.ts). The IPC glue in index.ts wires the node:fs adapter.
//
// Motif verification REUSES the existing motif/contentHash — no second hashing
// scheme is invented.

import { parseManifestIsland } from '../shared/motifs/catalog'
import { motifContentHash } from './motif/contentHash'
import type { DataRootProgress } from '../shared/data-root'

// The three fixed data-root buckets (dataRoot.ts layout). `motifs` + `downloads`
// are copied on a data-root change; `cache` is regenerable and is only created
// empty at the new root (never copied).
const COPY_BUCKETS = ['motifs', 'downloads'] as const
const ALL_BUCKETS = ['motifs', 'cache', 'downloads'] as const

/**
 * Minimal fs surface — injected so tests run in-memory; node:fs in production.
 * `rm` is recursive + force (idempotent: never throws on a missing path).
 */
export interface MigrationFs {
  exists(path: string): boolean
  isDirectory(path: string): boolean
  /** Names of the immediate children of `path` (like readdirSync, no types). */
  readDir(path: string): string[]
  /** Read a file as utf-8 text (throws on a missing file). */
  readFileText(path: string): string
  /** Byte size of a file (0 when it can't be stat'd). */
  fileSize(path: string): number
  mkdirp(path: string): void
  /** Copy a single file src → dest (dest's parent already created). */
  copyFile(src: string, dest: string): void
  /** Write utf-8 text (marker). */
  writeFile(path: string, text: string): void
  /** rm -rf; idempotent (a missing path is a no-op, never a throw). */
  rm(path: string): void
}

export type MigrationMode = 'adopt' | 'copy'

export interface MigrationPlan {
  mode: MigrationMode
}

export interface CopyResult {
  /**
   * Absolute paths this copy created at the NEW root (newRoot itself when it was
   * created fresh, else each bucket dir added under a pre-existing newRoot).
   * Pass to rollback() to undo exactly — and only — this run's additions.
   */
  createdPaths: string[]
}

export interface VerifyResult {
  ok: boolean
  /** Human-readable mismatch lines; empty when ok. */
  mismatches: string[]
}

/** The userData-resident marker recording an old copy awaiting user deletion. */
export interface CleanupMarker {
  /** Data root the app ran on BEFORE the migration (the copy to offer for deletion). */
  oldPath: string
  /** Data root the migration switched to (what the app should reboot onto). */
  newPath: string
  status: 'pending-delete'
}

type Join = (...parts: string[]) => string

// Derive the platform path separator from the injected join ('/'.
// in tests, path.sep in production) so nested-root math needs no node:path.
function separatorFrom(join: Join): string {
  return join('a', 'b').slice(1, -1)
}

/**
 * Reject a new root that is the same as, nested inside, or an ancestor of the
 * old root — a self-overwrite / infinite-copy hazard. Thrown eagerly by
 * planMigration + runCopy (and re-checkable by the IPC layer before prompting).
 */
export function assertDisjointRoots(oldRoot: string, newRoot: string, join: Join): void {
  const sep = separatorFrom(join)
  const strip = (p: string): string =>
    p.length > sep.length && p.endsWith(sep) ? p.slice(0, -sep.length) : p
  const a = strip(oldRoot)
  const b = strip(newRoot)
  if (a === b) {
    throw new Error('[dataRootMigration] the new data folder is the same as the current one')
  }
  // The trailing sep is what keeps `/old` vs `/older` from a false positive.
  if (b.startsWith(a + sep) || a.startsWith(b + sep)) {
    throw new Error(
      '[dataRootMigration] the new data folder must not be inside the current one (or contain it)',
    )
  }
}

/**
 * True when `root` already looks like a valid WeftCut data root: the recognizable
 * motifs/ + cache/ + downloads/ layout all present as directories. Such a target
 * is ADOPTED as-is (no copy, no merge).
 */
export function isValidDataRoot(root: string, fs: MigrationFs, join: Join): boolean {
  return ALL_BUCKETS.every((sub) => {
    const p = join(root, sub)
    return fs.exists(p) && fs.isDirectory(p)
  })
}

/** Plan a data-root change: adopt an existing valid root, else copy into it. */
export function planMigration(
  oldRoot: string,
  newRoot: string,
  fs: MigrationFs,
  join: Join,
): MigrationPlan {
  assertDisjointRoots(oldRoot, newRoot, join)
  return { mode: isValidDataRoot(newRoot, fs, join) ? 'adopt' : 'copy' }
}

// Recursively count the files under a directory (for the progress denominator).
function countFiles(dir: string, fs: MigrationFs, join: Join): number {
  if (!fs.exists(dir) || !fs.isDirectory(dir)) return 0
  let n = 0
  for (const name of fs.readDir(dir)) {
    const p = join(dir, name)
    if (fs.isDirectory(p)) n += countFiles(p, fs, join)
    else n += 1
  }
  return n
}

// Recursively { files, bytes } for a directory subtree (downloads verification).
function dirStats(dir: string, fs: MigrationFs, join: Join): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  if (!fs.exists(dir) || !fs.isDirectory(dir)) return { files, bytes }
  for (const name of fs.readDir(dir)) {
    const p = join(dir, name)
    if (fs.isDirectory(p)) {
      const s = dirStats(p, fs, join)
      files += s.files
      bytes += s.bytes
    } else {
      files += 1
      bytes += fs.fileSize(p)
    }
  }
  return { files, bytes }
}

// Copy a directory tree src → dest (dest created as needed), invoking onFile once
// per copied file (progress). Names sorted for deterministic traversal.
function copyTree(
  srcDir: string,
  destDir: string,
  fs: MigrationFs,
  join: Join,
  onFile: () => void,
): void {
  fs.mkdirp(destDir)
  for (const name of [...fs.readDir(srcDir)].sort()) {
    const s = join(srcDir, name)
    const d = join(destDir, name)
    if (fs.isDirectory(s)) copyTree(s, d, fs, join, onFile)
    else {
      fs.copyFile(s, d)
      onFile()
    }
  }
}

/**
 * Copy motifs/ + downloads/ from oldRoot to newRoot (source READ-ONLY; originals
 * untouched) and create an EMPTY cache/ at newRoot (cache is regenerable — never
 * copied). Tracks exactly what it creates at newRoot and, on ANY mid-copy error,
 * rolls those additions back before re-throwing (so a partial copy never
 * survives). Returns the created paths so the caller can also roll back after a
 * failed verify().
 */
export function runCopy(
  oldRoot: string,
  newRoot: string,
  fs: MigrationFs,
  join: Join,
  onProgress?: (p: DataRootProgress) => void,
): CopyResult {
  assertDisjointRoots(oldRoot, newRoot, join)

  const srcMotifs = join(oldRoot, 'motifs')
  const srcDownloads = join(oldRoot, 'downloads')
  const destMotifs = join(newRoot, 'motifs')
  const destDownloads = join(newRoot, 'downloads')
  const destCache = join(newRoot, 'cache')

  // Copy mode targets a CLEAN folder (a populated WeftCut root goes down the
  // adopt path). Refuse to merge into a target that already holds copied content
  // — this also keeps rollback exact: everything under the dest buckets is ours.
  for (const bucket of COPY_BUCKETS) {
    const dir = join(newRoot, bucket)
    if (fs.exists(dir) && dirStats(dir, fs, join).files > 0) {
      throw new Error(
        `[dataRootMigration] the new folder already contains a non-empty "${bucket}" folder; refusing to merge`,
      )
    }
  }

  const createdPaths: string[] = []
  const ensureDir = (dir: string): void => {
    if (!fs.exists(dir)) createdPaths.push(dir)
    fs.mkdirp(dir)
  }

  try {
    // If newRoot itself is new, tracking it alone suffices for rollback (removing
    // it recursively takes its whole subtree); otherwise track each bucket we add
    // beneath a pre-existing newRoot so rollback never touches its other content.
    if (!fs.exists(newRoot)) {
      createdPaths.push(newRoot)
      fs.mkdirp(newRoot)
      fs.mkdirp(destMotifs)
      fs.mkdirp(destDownloads)
      fs.mkdirp(destCache)
    } else {
      ensureDir(destMotifs)
      ensureDir(destDownloads)
      ensureDir(destCache)
    }

    const totalFiles = countFiles(srcMotifs, fs, join) + countFiles(srcDownloads, fs, join)
    let copiedFiles = 0
    onProgress?.({ phase: 'copy', copiedFiles, totalFiles })
    const tick = (bucket: 'motifs' | 'downloads') => (): void => {
      copiedFiles += 1
      onProgress?.({ phase: 'copy', bucket, copiedFiles, totalFiles })
    }

    if (fs.exists(srcMotifs) && fs.isDirectory(srcMotifs)) {
      copyTree(srcMotifs, destMotifs, fs, join, tick('motifs'))
    }
    if (fs.exists(srcDownloads) && fs.isDirectory(srcDownloads)) {
      copyTree(srcDownloads, destDownloads, fs, join, tick('downloads'))
    }

    onProgress?.({ phase: 'verify', copiedFiles, totalFiles })
    return { createdPaths }
  } catch (e) {
    // Mid-copy failure: undo our partial additions at newRoot, leave oldRoot
    // fully intact, then surface the error.
    rollback(newRoot, fs, createdPaths)
    throw e
  }
}

// Build a per-motif content-identity map for a motifs/ dir. Keys are the motif
// id (published) or `drafts/<id>`; values are the reused motifContentHash (or a
// raw-content fallback for a motif whose manifest island won't parse, so a
// corrupt copy still can't pass as "ok").
function motifValueAt(dir: string, fs: MigrationFs, join: Join): string | null {
  const indexPath = join(dir, 'index.html')
  if (!fs.exists(indexPath)) return null
  let html: string
  try {
    html = fs.readFileText(indexPath)
  } catch {
    return null
  }
  try {
    return motifContentHash(parseManifestIsland(html), html)
  } catch {
    return 'raw:' + html
  }
}

function motifValueMap(motifsDir: string, fs: MigrationFs, join: Join): Map<string, string> {
  const map = new Map<string, string>()
  if (!fs.exists(motifsDir) || !fs.isDirectory(motifsDir)) return map
  for (const name of [...fs.readDir(motifsDir)].sort()) {
    const entry = join(motifsDir, name)
    if (!fs.isDirectory(entry)) continue
    if (name === 'drafts') {
      for (const draft of [...fs.readDir(entry)].sort()) {
        const draftDir = join(entry, draft)
        if (!fs.isDirectory(draftDir)) continue
        const v = motifValueAt(draftDir, fs, join)
        if (v != null) map.set('drafts/' + draft, v)
      }
      continue
    }
    const v = motifValueAt(entry, fs, join)
    if (v != null) map.set(name, v)
  }
  return map
}

/**
 * Verify the copy: motifs by content hash (reusing motif/contentHash), the other
 * copied buckets (downloads) by file count + total size. Cache is regenerable so
 * it is not verified. Returns ok + any mismatch detail.
 */
export function verify(
  oldRoot: string,
  newRoot: string,
  fs: MigrationFs,
  join: Join,
): VerifyResult {
  const mismatches: string[] = []

  // Motifs — content-hash identity per motif (no second hashing scheme).
  const oldMotifs = motifValueMap(join(oldRoot, 'motifs'), fs, join)
  const newMotifs = motifValueMap(join(newRoot, 'motifs'), fs, join)
  for (const [id, val] of oldMotifs) {
    const got = newMotifs.get(id)
    if (got === undefined) mismatches.push(`motif "${id}" missing at the new folder`)
    else if (got !== val) mismatches.push(`motif "${id}" content differs at the new folder`)
  }
  for (const id of newMotifs.keys()) {
    if (!oldMotifs.has(id)) mismatches.push(`motif "${id}" unexpectedly present at the new folder`)
  }

  // Downloads — file count + byte size.
  const oldDl = dirStats(join(oldRoot, 'downloads'), fs, join)
  const newDl = dirStats(join(newRoot, 'downloads'), fs, join)
  if (oldDl.files !== newDl.files) {
    mismatches.push(`downloads file count differs (${oldDl.files} → ${newDl.files})`)
  }
  if (oldDl.bytes !== newDl.bytes) {
    mismatches.push(`downloads byte size differs (${oldDl.bytes} → ${newDl.bytes})`)
  }

  return { ok: mismatches.length === 0, mismatches }
}

/**
 * Delete ONLY what a copy run created at newRoot (createdPaths), deepest-first.
 * Idempotent. NEVER touches oldRoot. The `newRoot` arg is a safety fence, but a
 * raw prefix test rather than true containment — a sibling such as `<newRoot>x`
 * passes it — so only ever pass paths a copy run itself recorded.
 */
export function rollback(newRoot: string, fs: MigrationFs, createdPaths: string[]): void {
  for (let i = createdPaths.length - 1; i >= 0; i--) {
    const p = createdPaths[i]
    if (p !== newRoot && !p.startsWith(newRoot)) continue
    try {
      fs.rm(p)
    } catch {
      /* best-effort — rm is force; a partial rollback is still safe (oldRoot intact) */
    }
  }
}

// ---------------------------------------------------------------------------
// Delete-old-copy marker — carries the "old path to offer for deletion" across
// the process restart. Stored in userData (NOT under any data root, so it
// survives the switch). All ops are idempotent so a crash mid-delete recovers:
// the marker stays until the delete completes AND clears it.
// ---------------------------------------------------------------------------

/** Write (or overwrite) the pending-delete marker. Idempotent. */
export function writeMarker(markerPath: string, marker: CleanupMarker, fs: MigrationFs): void {
  fs.writeFile(markerPath, JSON.stringify(marker, null, 2))
}

/** Read the marker, or null when absent / corrupt / not a pending-delete record. */
export function readMarker(markerPath: string, fs: MigrationFs): CleanupMarker | null {
  if (!fs.exists(markerPath)) return null
  let body: string
  try {
    body = fs.readFileText(markerPath)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object') return null
  const m = parsed as Record<string, unknown>
  if (typeof m.oldPath !== 'string' || typeof m.newPath !== 'string') return null
  if (m.status !== 'pending-delete') return null
  return { oldPath: m.oldPath, newPath: m.newPath, status: 'pending-delete' }
}

/** Remove the marker. Idempotent (a missing marker is a no-op). */
export function clearMarker(markerPath: string, fs: MigrationFs): void {
  try {
    fs.rm(markerPath)
  } catch {
    /* already gone — idempotent */
  }
}

/**
 * Delete the old copy after a confirmed relaunch. When oldPath IS the default
 * `<userData>/data` (entirely app-owned) the whole dir is removed; otherwise
 * only the three app-managed buckets are removed, leaving the user's chosen
 * folder (which may hold unrelated files) in place. NEVER deletes userData
 * itself. Idempotent (rm is force) so a crash mid-delete is recoverable.
 */
export function deleteOldCopy(
  oldPath: string,
  defaultDataDir: string,
  fs: MigrationFs,
  join: Join,
): void {
  if (!oldPath) return
  if (oldPath === defaultDataDir) {
    fs.rm(oldPath)
    return
  }
  for (const bucket of ALL_BUCKETS) {
    fs.rm(join(oldPath, bucket))
  }
}
