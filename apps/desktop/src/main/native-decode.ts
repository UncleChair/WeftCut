// Level-0 availability gate for the optional @weftcut/native-decode component
// (ADR 0030 §Conditional first-class). Main tries the require ONCE in
// a try/catch; failure means the Native decode engine is unavailable — the app
// keeps working, the setting grays out with `reason`, `auto` skips Native tiers.
//
// Why a separate addon: a missing avcodec DLL in a single addon's import table
// would fail the entire require('@weftcut/core') — jobs/export/MCP would die
// with it. Isolation is structural, not optional (docs/adr/0030).
import { createRequire } from 'node:module'
import path from 'node:path'
import type { NativeDecode } from '@weftcut/native-decode'

export type OnComponentEvent = (err: Error | null, json: string) => void

export interface NativeDecodeComponent {
  backend: NativeDecode | null
  reason: string | null
  version: string | null
}

type ComponentModule = typeof import('@weftcut/native-decode')

/// Testable core: injectable require + DLL dir. On Windows the ffmpeg shared
/// DLLs resolve via the process PATH at dlopen time, so prepend the bundled
/// (packaged) / fetched (dev) DLL dir first. PATH is left prepended on success
/// (the addon may lazily load more of the family later) and RESTORED on
/// failure so a broken component can't pollute sidecar ffmpeg resolution.
export function loadNativeDecodeWith(
  requireFn: () => ComponentModule,
  onEvent: OnComponentEvent,
  dllDir: string | null,
): NativeDecodeComponent {
  const prevPath = process.env.PATH
  if (dllDir) process.env.PATH = `${dllDir}${path.delimiter}${prevPath ?? ''}`
  try {
    const mod = requireFn()
    return { backend: new mod.NativeDecode(onEvent), reason: null, version: mod.versionInfo() }
  } catch (e) {
    if (dllDir) process.env.PATH = prevPath
    return { backend: null, reason: e instanceof Error ? e.message : String(e), version: null }
  }
}

let cached: NativeDecodeComponent | null = null

/// Production entry — resolves the DLL dir for the current run mode and
/// memoizes (the component is a singleton like the core backend).
export function loadNativeDecode(onEvent: OnComponentEvent): NativeDecodeComponent {
  if (cached) return cached
  const require_ = createRequire(import.meta.url)
  cached = loadNativeDecodeWith(
    () => require_('@weftcut/native-decode') as ComponentModule,
    onEvent,
    resolveDllDir(),
  )
  return cached
}

/// Resolve the dir holding the component's ffmpeg-lgpl shared DLLs for the
/// current run mode. Non-Windows has no PATH-based dlopen resolution, so null.
/// Electron is required lazily (same pattern as index.ts's `dialog` require) so
/// the pure `loadNativeDecodeWith` core above stays import-safe outside an
/// electron process (the unit tests never touch electron).
function resolveDllDir(): string | null {
  if (process.platform !== 'win32') return null
  const { app } = require('electron') as typeof import('electron')
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native-decode')
    : path.join(app.getAppPath(), 'resources', 'ffmpeg-lgpl', 'win', 'bin')
}
