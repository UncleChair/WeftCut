import fs from 'node:fs'
import path from 'node:path'

/// Install the bundled agent skill folder into <userData>/skills/ at app
/// startup. That directory is what the Settings panel tells the user (or their
/// agent) to copy into the client's own skills directory: userData is the only
/// path stable across version upgrades on all three OSes — on AppImage the
/// install image mounts at a random point every run. Refreshing on every start
/// means the skill can never go stale relative to the app that ships it.
///
/// The copy overwrites shipped files but never deletes: anything the user added
/// under <userData>/skills/ survives, since `cpSync` only walks the source tree.
///
/// Electron-free on purpose (paths ride in as arguments) so Vitest can cover
/// it — `electron` cannot load under the unit runner.
export function installSkills(opts: {
  /// Packaged source: <resources>/skills (extraResources).
  resourcesSkills: string
  /// Dev source: <appRoot>/out/skills (present after build:skills).
  devSkills: string
  isPackaged: boolean
  userDataDir: string
}): string | null {
  const source = opts.isPackaged ? opts.resourcesSkills : opts.devSkills
  const dest = path.join(opts.userDataDir, 'skills')
  try {
    if (fs.existsSync(source)) {
      fs.cpSync(source, dest, { recursive: true, force: true })
      return dest
    }
  } catch {
    /* fall through — a stale copy still beats none */
  }
  return fs.existsSync(dest) ? dest : null
}
