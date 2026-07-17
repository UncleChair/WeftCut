// apps/desktop/src/main/state/relink.ts
//
// Load-time relink-by-content: heal workspace-managed media whose on-disk file
// went missing because the FILENAME changed while the BYTES survived — the
// classic cross-machine transfer mangle (zip tools decoding UTF-8 names via the
// local ANSI codepage, NFD/NFC drift on macOS-origin names). The media pool is
// content-addressed (blake3 + size + mtime, media.rs) precisely for this:
// candidates in <workspace>/Media are prefiltered by exact file_size (one stat,
// no read) and confirmed by blake3 before rebinding, so a heal can never bind
// the wrong file. Runs between loadProjectFromJson and replaceState — a pure
// value repair, never a history entry.
import type { MediaItem, Project } from './model'

/** jobs/import.rs MEDIA_DIR — the flat workspace folder every import copy lands in. */
const MEDIA_DIR = 'Media'

export interface RelinkFs {
  exists(path: string): boolean
  /** Entry basenames; [] when the dir is missing/unreadable. */
  listDir(dir: string): string[]
  /** null when missing or not a regular file. */
  statFile(path: string): { size: number; mtimeSecs: number } | null
  /** Throws on failure (target locked, cross-device) — relink then adopts the found name instead. */
  rename(from: string, to: string): void
}

export interface RelinkDeps {
  fs: RelinkFs
  join: (...parts: string[]) => string
  /** BLAKE3 hex of a file's contents (Backend.hashMediaSource over napi). */
  hashFile: (path: string) => Promise<string>
}

export interface RelinkReport {
  /** `from` = the stray on-disk basename found, `to` = the final path_rel bound. */
  healed: { media: string; from: string; to: string }[]
  /** Media ids left unresolved — the MissingMedia surfaces take over. */
  missing: string[]
}

/** path_rel may carry either separator: Rust PathBuf serializes natively
 *  (backslash on Windows), a macOS-authored project carries forward slashes. */
function basenameOfRel(rel: string): string {
  return rel.split(/[\\/]/).pop() ?? rel
}

/** Heal missing workspace-managed media (path_rel set) by content identity.
 *  External sources (path_rel === null) are out of scope: their bytes were
 *  never copied under the workspace, so there is no bounded place to scan.
 *  Preferred outcome: rename the stray file back to the recorded basename
 *  (restores the human-readable name and makes the heal durable without a
 *  save); when the recorded name is taken or the rename fails, the item
 *  adopts the found name into path_rel instead. */
export async function relinkMissingMedia(
  project: Project,
  dir: string,
  deps: RelinkDeps,
): Promise<{ project: Project; report: RelinkReport }> {
  const { fs, join, hashFile } = deps
  const report: RelinkReport = { healed: [], missing: [] }

  const entries = Object.entries(project.media_pool)
  const missingIds = entries
    .filter(([, item]) => item.path_rel !== null && !fs.exists(item.path_abs))
    .map(([id]) => id)
  if (missingIds.length === 0) return { project, report }

  // Files already resolved by a healthy pool item are never rebind targets —
  // a rename would break the item that still works.
  const claimed = new Set(
    entries.filter(([id]) => !missingIds.includes(id)).map(([, item]) => item.path_abs),
  )
  const mediaDir = join(dir, MEDIA_DIR)
  const candidates = fs
    .listDir(mediaDir)
    .map((name) => {
      const abs = join(mediaDir, name)
      const stat = fs.statFile(abs)
      return stat && !claimed.has(abs) ? { name, abs, size: stat.size } : null
    })
    .filter((c): c is { name: string; abs: string; size: number } => c !== null)

  const hashMemo = new Map<string, string | null>() // abs → hex, null = unreadable
  async function hashOf(abs: string): Promise<string | null> {
    if (!hashMemo.has(abs)) {
      try { hashMemo.set(abs, await hashFile(abs)) } catch { hashMemo.set(abs, null) }
    }
    return hashMemo.get(abs) ?? null
  }

  // Same content imported twice with both copies missing: the second item
  // binds to the file the first heal landed on instead of staying missing.
  const healedByHash = new Map<string, { path_abs: string; path_rel: string; from: string }>()

  const media_pool: Record<string, MediaItem> = { ...project.media_pool }
  for (const id of missingIds) {
    const item = media_pool[id]
    const hash = item.file_hash_blake3
    // Provisional hashes (pending-{id}, pre-hash-pass imports) have no content
    // identity to match against.
    if (!hash || hash.startsWith('pending-')) { report.missing.push(id); continue }

    const prior = healedByHash.get(hash)
    if (prior) {
      media_pool[id] = { ...item, path_abs: prior.path_abs, path_rel: prior.path_rel }
      report.healed.push({ media: id, from: prior.from, to: prior.path_rel })
      continue
    }

    let hit: { name: string; abs: string; size: number } | null = null
    for (const c of candidates) {
      if (c.size !== item.file_size) continue
      if ((await hashOf(c.abs)) === hash) { hit = c; break }
    }
    if (!hit) { report.missing.push(id); continue }
    candidates.splice(candidates.indexOf(hit), 1)

    const recordedBase = basenameOfRel(item.path_rel!)
    const recordedAbs = join(mediaDir, recordedBase)
    let bound: { path_abs: string; path_rel: string }
    if (!fs.exists(recordedAbs)) {
      try {
        fs.rename(hit.abs, recordedAbs)
        bound = { path_abs: recordedAbs, path_rel: item.path_rel! }
      } catch {
        bound = { path_abs: hit.abs, path_rel: join(MEDIA_DIR, hit.name) }
      }
    } else {
      bound = { path_abs: hit.abs, path_rel: join(MEDIA_DIR, hit.name) }
    }

    const stat = fs.statFile(bound.path_abs)
    media_pool[id] = {
      ...item,
      ...bound,
      file_mtime: stat?.mtimeSecs ?? item.file_mtime,
    }
    healedByHash.set(hash, { ...bound, from: hit.name })
    report.healed.push({ media: id, from: hit.name, to: bound.path_rel })
  }

  return { project: { ...project, media_pool }, report }
}
