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
import os from 'node:os'
import type { NativeDecode } from '@weftcut/native-decode'

export type OnComponentEvent = (err: Error | null, json: string) => void

export interface NativeDecodeComponent {
  backend: NativeDecode | null
  reason: string | null
  version: string | null
  /// The decode lanes this build advertised (`capabilities()`, ADR 0030
  /// §Lane advertisement): `software` on every platform, plus the platform's HW
  /// lanes — `d3d11va` on the Windows HW-preview build, `nvdec`/`vaapi` on
  /// Linux, `videotoolbox` on macOS. Empty when the component failed to load.
  /// Resolvers probe ONLY advertised lanes, so the Linux resolver never touches
  /// the GPU-preview stub that returns a "not built" verdict by design.
  lanes: string[]
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
    return {
      backend: new mod.NativeDecode(onEvent),
      reason: null,
      version: mod.versionInfo(),
      lanes: mod.capabilities(),
    }
  } catch (e) {
    if (dllDir) process.env.PATH = prevPath
    return { backend: null, reason: e instanceof Error ? e.message : String(e), version: null, lanes: [] }
  }
}

let cached: NativeDecodeComponent | null = null

/// Production entry — resolves the DLL dir for the current run mode and
/// memoizes (the component is a singleton like the core backend).
export function loadNativeDecode(onEvent: OnComponentEvent): NativeDecodeComponent {
  if (cached) return cached
  const require_ = createRequire(import.meta.url)
  cached = loadNativeDecodeWith(requireComponent(require_), onEvent, resolveDllDir())
  return cached
}

/// How the component's `.node` is required. On Linux it MUST load with
/// RTLD_DEEPBIND: Electron bundles Chromium's `libffmpeg.so`, a minimal ffmpeg
/// build that exports ~840 global `av*` symbols (`avformat_open_input`, …) with
/// NO `file` protocol. Under ELF's default global scope those interpose the
/// addon's own LGPL libavformat, so every file open fails "Protocol not found"
/// even though the addon loads fine under plain Node. This is electron/electron
/// #31397 (closed "not planned" — the app must work around it), and the
/// sanctioned fix is deep binding: it searches the addon's own dependency tree
/// (its co-located $ORIGIN LGPL build) ahead of the global scope. We pass the
/// documented max-isolation combo RTLD_NOW | RTLD_LOCAL | RTLD_DEEPBIND. napi's
/// generated index.js loads the `.node` with a plain `require`, so we OR the
/// flags into `process.dlopen` for that one synchronous require. Windows PE and
/// macOS Mach-O resolve symbols per-module, so this is Linux-only. See
/// docs/adr/0030.
function requireComponent(require_: NodeRequire): () => ComponentModule {
  if (process.platform !== 'linux') {
    return () => require_('@weftcut/native-decode') as ComponentModule
  }
  return () => {
    const orig = process.dlopen
    const { RTLD_NOW, RTLD_LOCAL, RTLD_DEEPBIND } = os.constants.dlopen
    const deep = RTLD_NOW | RTLD_LOCAL | RTLD_DEEPBIND
    process.dlopen = (module, filename, flags?: number) =>
      orig.call(process, module, filename, (flags ?? 0) | deep)
    try {
      return require_('@weftcut/native-decode') as ComponentModule
    } finally {
      process.dlopen = orig
    }
  }
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
