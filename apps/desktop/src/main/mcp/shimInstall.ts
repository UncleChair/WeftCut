import fs from 'node:fs'
import path from 'node:path'

/// Install the bundled weftcut-mcp shim into <userData>/cli/ at app startup.
///
/// userData is the path client configs reference because it is the only one
/// that is stable across version upgrades on all three OSes — on AppImage the
/// install image mounts at a random point every run, so a path into it would
/// die with the session. Refreshing the copy on every start also means the
/// shim can never go stale relative to the app that ships it.
///
/// Electron-free on purpose (paths ride in as arguments) so Vitest can cover
/// it — `electron` cannot load under the unit runner.
export function installShim(opts: {
  /// Packaged source: <resources>/cli/weftcut-mcp.cjs (extraResources).
  resourcesShim: string
  /// Dev source: <appRoot>/out/cli/weftcut-mcp.cjs (present after build:cli).
  devShim: string
  isPackaged: boolean
  userDataDir: string
}): string | null {
  const source = opts.isPackaged ? opts.resourcesShim : opts.devShim
  const dest = path.join(opts.userDataDir, 'cli', 'weftcut-mcp.cjs')
  try {
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(source, dest)
      return dest
    }
  } catch {
    /* fall through — a stale copy still beats none */
  }
  return fs.existsSync(dest) ? dest : null
}

/// The stdio client-config fragment the Settings panel and the dev console
/// emit. Mirrors src/cli/paths.ts `clientConfig` (which the shim's own
/// print-config uses); keep the two shapes in step.
export function stdioConnectConfig(opts: {
  execPath: string
  appImage: string | undefined
  shimPath: string
  userDataDir: string
}): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: opts.appImage ?? opts.execPath,
    args: [opts.shimPath],
    env: { ELECTRON_RUN_AS_NODE: '1', WEFTCUT_USERDATA: opts.userDataDir },
  }
}
