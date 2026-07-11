import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, shell } from 'electron'
import { loadAllKeys, setKey, clearKey } from './keys.js'
import { MOTIF_SCHEME_ENTRY, registerMotifProtocol } from './motif/protocol.js'
import { setRuntimeSource, captureMotifFrameB64, setMotifStore } from './motif/capture.js'
import { UserMotifStore } from './motif/store.js'
import { spawnMotifWatcher, type MotifWatcher } from './motif/watcher.js'
import { builtinAssetDir } from './motif/builtinAssets.js'
import { createSecondary, actOnSecondary, secondaryExists, hardenWindow } from './windows.js'
import type { SecondaryWinOpts } from './windowConfig.js'
import { broadcastEvent } from './broadcast.js'
import { resolveSystemFont } from './fonts/resolveSystemFont.js'
import { collectMetrics } from './metrics.js'
import { isAllowed } from './fsGuard.js'
import { applyDerivativesEvent, applyWorkspacePathsEvent } from './state/jobs-writeback.js'
import { SINGLE_MEDIA_CHANNELS, resolveSingleMediaArgs } from './state/single-media-forward.js'
import { EXPORT_PROJECT_CHANNELS, injectProjectArgs } from './state/export-project-forward.js'
import { openPreviewGpu, requestFrameAtPreviewGpu, consumeAckPreviewGpu, closePreviewGpu, takeTimingsPreviewGpu } from './previewGpu.js'
import { recordFrameReadySent, recordConsumeAck, takeMainTimings } from './previewGpuTiming.js'
import { openPreviewSw, requestFrameAtPreviewSw, closePreviewSw } from './previewSw.js'
import { loadNativeDecode } from './native-decode.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'weftcut-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  MOTIF_SCHEME_ENTRY,
])

const require_ = createRequire(import.meta.url)
const { Backend } = require_('@weftcut/core') as typeof import('@weftcut/core')

let backend: import('@weftcut/core').Backend | null = null
let mainWindow: BrowserWindow | null = null
// The MCP host is started after `backend.init()`, but the `onEvent` closure
// (which taps `mcp:change`) is constructed in the `new Backend(...)` call
// BEFORE the host exists. Hold it module-scoped and set it right after
// `startMcpHost` resolves.
let mcpHostRef: import('./mcp/index.js').McpHost | null = null
let tsHost: import('./state/ts-actor-host.js').TsActorHost | null = null
let motifWatcher: MotifWatcher | null = null

const isDev = !!process.env['ELECTRON_RENDERER_URL']

// App-level startup notices the renderer PULLS on mount via the `app:notices`
// IPC (see AppNotice in src/shared/ipc.ts). Collected here at startup, fetched
// when the renderer is ready — a pull model so a notice can't be lost to the
// fire-once-before-subscribe race the old `evt:app:notice` send had.
const startupNotices: { level: string; code: string }[] = []

// GPU identity for the HW capability lane (D4): vendor/device/driver — a
// driver update or GPU swap invalidates every cached HW verdict. `getGPUInfo`
// payload shape varies by Electron version — the `catch -> 'gpu:unknown'`
// guard makes a shape change degrade to "cache never hits," not a crash.
async function hwEnvKey(): Promise<string> {
  try {
    const info = (await app.getGPUInfo('basic')) as {
      gpuDevice?: { vendorId?: number; deviceId?: number; driverVersion?: string }[]
    }
    const d = info.gpuDevice?.[0]
    return `gpu:${d?.vendorId ?? 0}:${d?.deviceId ?? 0}:${d?.driverVersion ?? 'unknown'}`
  } catch {
    return 'gpu:unknown'
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Show immediately. A frameless (`frame:false`) window combined with
    // `show:false` + a deferred `ready-to-show` show does NOT reliably surface
    // on Windows (ready-to-show may not fire) — the window stays hidden. With a
    // set backgroundColor there's no white flash, so show on create.
    show: true,
    // Frameless window — the renderer draws its
    // own titlebar (app-header / startup-titlebar / agent-titlebar) with custom
    // window controls. (macOS traffic-light styling is a future cross-platform
    // refinement.)
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow = win
  hardenWindow(win)

  // The renderer draws its own caption buttons (frameless window); their
  // maximize/restore glyph cares only about maximize-STATE transitions, not
  // every resize tick. Emit on maximize/unmaximize only — the external paths
  // (drag-region double-click, Win+arrow, drag-to-top) all funnel through these
  // — and carry the state so the renderer needn't round-trip back to read it.
  const sendMaximizeState = () =>
    win.webContents.send('evt:window:maximize-changed', { isMaximized: win.isMaximized() })
  win.on('maximize', sendMaximizeState)
  win.on('unmaximize', sendMaximizeState)

  // Capture renderer console messages to stdout for diagnostics
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['verbose', 'info', 'warning', 'error'][level] ?? 'log'
    console.log(`[renderer:${lvl}] ${message} (${sourceId}:${line})`)
  })

  if (isDev) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  void warnIfElevatedWindows(win)

  return win
}

/// Whether THIS process runs at Windows High integrity (i.e. "Run as
/// administrator"). The High Mandatory Level integrity SID (S-1-16-12288) appears
/// in the token's group list only when elevated, and the SID — unlike the group's
/// display name — is locale-independent. Uses `whoami` (always on PATH) rather
/// than a native Win32 dependency.
function isElevatedWindows(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('whoami', ['/groups'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.includes('S-1-16-12288'))
    })
  })
}

/// One-shot startup notice: when WeftCut runs elevated on Windows, Windows UIPI
/// blocks file drag-drop from the (Medium-integrity) Explorer into this
/// (High-integrity) process — the drag never reaches the renderer, so drop-import
/// silently dies. Surface it instead of leaving a confusing no-op. The dialog is
/// suppressed under e2e/CI (which often run elevated) so it can't block automation.
async function warnIfElevatedWindows(win: BrowserWindow): Promise<void> {
  if (process.platform !== 'win32') return
  if (process.env['WEFTCUT_SUPPRESS_ELEVATION_NOTICE']) return
  if (!(await isElevatedWindows())) return
  if (win.isDestroyed()) return
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  await dialog.showMessageBox(win, {
    type: 'info',
    noLink: true,
    buttons: ['OK'],
    title: zh ? '正在以管理员身份运行' : 'Running as administrator',
    message: zh ? '拖放导入已被禁用' : 'Drag-and-drop import is disabled',
    detail: zh
      ? 'Windows 会阻止把文件从资源管理器拖放到以管理员身份运行的应用。要启用拖放,请以普通方式(不要"以管理员身份运行")重新启动 WeftCut。你仍可使用"导入媒体…"按钮导入。'
      : 'Windows blocks dragging files from File Explorer into an app that runs as administrator. To enable drag-and-drop, relaunch WeftCut normally (not "Run as administrator"). You can still import with the "Import media…" button.',
  })
}

app.whenReady().then(async () => {
  // Bundled ffmpeg: ffmpeg-sidecar resolves "ffmpeg" via PATH when no binary sits
  // adjacent to the exe (ffmpeg_sidecar::paths::ffmpeg_path). Prepend the packaged dir so the
  // in-process addon spawns OUR static build, not a system one. Dev (unpackaged)
  // has no bundled dir → falls back to system/auto-download as before.
  const ffmpegDir = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(__dirname, '../../resources/ffmpeg', process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux')
  const ffmpegBin = path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (fs.existsSync(ffmpegBin)) {
    process.env.PATH = ffmpegDir + path.delimiter + (process.env.PATH ?? '')
    console.log(`[main] bundled ffmpeg on PATH: ${ffmpegBin}`)
  }

  // Construct + init the Backend before creating the window
  backend = new Backend(
    app.getPath('userData'),
    path.join(app.getPath('userData'), 'Cache'),
    (_err: Error | null, msg: string) => {
      if (!msg) return
      const { event, payload } = JSON.parse(msg)
      // `mcp:change` is consumed by the MCP host (relayed as an in-protocol
      // streamable-HTTP notification to connected agents), NOT forwarded to the renderer.
      if (event === 'mcp:change') {
        mcpHostRef?.notifyChange(payload)
        return
      }
      // `media:derivatives` write-back: when the TS actor is authoritative, apply
      // the derivative patch to the TS actor instead of forwarding to the renderer.
      // tsHost is module-scoped (set later); the closure captures it by reference.
      if (event === 'media:derivatives') {
        // Synchronous (jobs-writeback is statically imported — type-only deps, no
        // eager actor construction) so the TSFN callback stays sync and can't race
        // a concurrent handleInvoke via a deferred microtask. The apply fn logs (not
        // throws) on MediaNotFound; the try/catch guards any other throw so it can't
        // surface as an unhandled rejection.
        if (tsHost) {
          try { applyDerivativesEvent(tsHost.actor, payload as never) }
          catch (e) { console.warn('[main] media:derivatives write-back threw', e) }
          return
        }
        // flag-off: Rust is authoritative and never emits this event — fall through is defensive
      }
      // `media:workspace_paths` write-back: the background import-copy job's
      // path/hash result. Same seam shape as media:derivatives (Phase 3d-e) —
      // apply to the TS actor under the flag instead of forwarding to the renderer.
      if (event === 'media:workspace_paths') {
        if (tsHost) {
          try { applyWorkspacePathsEvent(tsHost.actor, payload as never) }
          catch (e) { console.warn('[main] media:workspace_paths write-back threw', e) }
          return
        }
        // flag-off: Rust is authoritative and never emits this event — fall through is defensive
      }
      mainWindow?.webContents.send('evt:' + event, payload)
    },
  )
  await backend.init()
  console.log('[main] backend init OK')

  // Optional native-decode component (level-0 gate). Its events use the same
  // {event, payload} envelope as the core backend; relay through evt:* so the
  // preload's existing previewGpu listeners keep working unchanged.
  const nd = loadNativeDecode((_err, json) => {
    try {
      const { event, payload } = JSON.parse(json) as { event: string; payload: unknown }
      if (event === 'previewGpu:frameReady') {
        const p = payload as { streamId: string; slot: number }
        recordFrameReadySent(p.streamId, p.slot, performance.now())
      }
      mainWindow?.webContents.send('evt:' + event, payload)
    } catch (e) {
      console.warn('[main] native-decode event parse failed', e)
    }
  })
  if (!nd.backend) {
    console.warn('[main] native-decode component unavailable:', nd.reason)
    startupNotices.push({ level: 'info', code: 'native_decode_unavailable' })
  }
  const ndBackend = (): NonNullable<typeof nd.backend> => {
    if (!nd.backend) throw new Error('native-decode component unavailable')
    return nd.backend
  }

  const { encryptionAvailable } = await import('./keys.js')
  if (!encryptionAvailable()) {
    console.warn('[main] OS keyring unavailable — cloud API keys persist in PLAINTEXT (cloud_keys.json). Secure your userData dir or install a keyring (libsecret/kwallet).')
    // Surfaced to the user by the renderer's <AppNotices> (pulled via app:notices).
    startupNotices.push({ level: 'warn', code: 'keyring_unavailable' })
  }

  // Push any safeStorage-persisted cloud API keys into the backend cache so
  // reqwest providers + settings_test_provider see them without a renderer round-trip.
  for (const [provider, key] of Object.entries(loadAllKeys())) {
    backend.setCloudKey(provider, key)
  }

  // Construct the motif store + resolve the built-in dir once at boot.
  // Both are passed to the protocol handler and the capture singleton so
  // captureMotifFrameB64 and registerMotifProtocol no longer need the backend.
  const motifStore = new UserMotifStore(path.join(app.getPath('userData'), 'motifs'))
  const motifBuiltinDir = builtinAssetDir()
  setMotifStore(motifStore)

  // TS actor host: constructed unconditionally; must start BEFORE startMcpHost so
  // the actor (the sole owner of project state — it serves every MCP state view and
  // injects the slice each Rust compute call needs) is ready before any MCP read can
  // run. mcpNotify uses mcpHostRef?.notifyChange (optional), so the host wires up
  // cleanly before the MCP host exists.
  const { createTsActorHost } = await import('./state/ts-actor-host.js')

  // The TS actor snaps frame edges via the wasm eval leaf (snap.ts → renderer/eval).
  // Main MUST initialize it once at boot before the actor handles any command
  // (snap.ts contract).
  const { initEval } = await import('./state/snap.js')
  await initEval()

  // Node fs adapter — satisfies both OrchestratorFs and AutosaveFs.
  const nodeFs = {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
    mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
    copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
    readdir: (d: string) => fs.readdirSync(d) as string[],
    rm: (p: string) => { fs.rmSync(p, { force: true }) },
  }

  // Napi facade for workspace bookkeeping — delegates workspace/job ops to the
  // Backend instance; recents ops delegate to the TS recents store.
  const napiFacade = {
    commitWorkspace: (p: string) => backend!.commitWorkspace(p),
    pushRecent: (p: string, n: string) => recents.push(p, n),
    setLastNewProjectParent: (p: string) => recents.setLastNewProjectParent(p),
    enqueueJobsForMedia: (j: string) => backend!.enqueueJobsForMedia(j),
  }

  // Workspace dir cache — seeded once at boot; refreshed after each persistence call
  // (the orchestrator calls commitWorkspace itself before replaceState, so by the time
  // open/saveAs/newWorkspace resolves wsCache must reflect the NEW workspace so that
  // buildProjectSummary's fileExists + autosave see the right dir).
  let wsCache: string | null = null
  try {
    wsCache = JSON.parse(await backend!.invoke('workspace_dir', '{}')) as string | null
  } catch { /* no workspace at cold boot */ }

  // Wrap napiFacade.commitWorkspace to also refresh wsCache as a side effect —
  // the orchestrator calls it before replaceState, so by the time any post-open
  // handler runs, wsCache already holds the new path.
  const napiFacadeWithCache = {
    ...napiFacade,
    commitWorkspace: async (p: string) => {
      await napiFacade.commitWorkspace(p)
      wsCache = p
    },
  }

  // Rust compute facade for the native-compute → TS-write hybrids (Phase 3d-e):
  // Rust probes/hashes/parses (no actor write); the TS host applies the write.
  const computeFacade = {
    probeMedia: (p: string) => backend!.probeMedia(p),
    hashMediaSource: (p: string) => backend!.hashMediaSource(p),
    parseSubtitles: (body: string, format: string | null) => backend!.parseSubtitles(body, format),
    synthesizeSpeechCompute: (argsJson: string) => backend!.synthesizeSpeechCompute(argsJson),
  }

  // Load built-in Motif sources once (manifest + relocated index.html) for the
  // TS catalog/authoring surface (Phase 2). builtinMotifs reads from motifBuiltinDir.
  const { builtinMotifs } = await import('./motif/authoring.js')
  const motifBuiltins = builtinMotifs(motifBuiltinDir)

  // Atomic-JSON fs adapter (temp+rename) shared by the TS-owned config stores.
  // nodeFs above has no rename, hence a dedicated one.
  const atomicFs = {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
    rename: (a: string, b: string) => fs.renameSync(a, b),
    mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
  }
  // App-level prefs store — persists <userData>/app_settings.json.
  const { createAppSettingsStore } = await import('./app-settings.js')
  const appSettings = createAppSettingsStore({ fs: atomicFs, path: path.join(app.getPath('userData'), 'app_settings.json'), dir: app.getPath('userData') })
  // Per-workspace view state — resolves the workspace dir per call; no-op pre-workspace.
  const { createViewStateStore } = await import('./view-state.js')
  const viewState = createViewStateStore({ fs: atomicFs, join: path.join })
  // Per-workspace export settings — opaque JSON, renderer owns the schema.
  const { createExportSettingsStore } = await import('./export-settings.js')
  const exportSettings = createExportSettingsStore({ fs: atomicFs, join: path.join })
  // Per-user keybinding overrides — persists <userData>/keybindings.json.
  const { createKeybindingsStore } = await import('./keybindings.js')
  const keybindings = createKeybindingsStore({
    fs: atomicFs,
    path: path.join(app.getPath('userData'), 'keybindings.json'),
    dir: app.getPath('userData'),
  })
  // Recent-projects list + startup prefs — persists <userData>/recents.json.
  const { createRecentsStore } = await import('./recents.js')
  const recents = createRecentsStore({
    fs: atomicFs,
    path: path.join(app.getPath('userData'), 'recents.json'),
    dir: app.getPath('userData'),
  })
  // Machine capability cache (dual-engine spec §"Capability probe cache") —
  // persists <userData>/decode_capability.json. Keyed by (lane, format class),
  // invalidated per-lane when its envKey changes (SW: ffmpeg version).
  const { createDecodeCapabilityStore, classKeyOf } = await import('./decode-capability.js')
  const decodeCapability = createDecodeCapabilityStore({
    fs: atomicFs,
    path: path.join(app.getPath('userData'), 'decode_capability.json'),
    dir: app.getPath('userData'),
  })

  tsHost = createTsActorHost({
    send: (event, payload) => mainWindow?.webContents.send('evt:' + event, payload),
    mcpNotify: (payload) => mcpHostRef?.notifyChange(payload),
    fileExists: (p) => fs.existsSync(p),
    fs: nodeFs,
    join: path.join,
    napi: napiFacadeWithCache,
    compute: computeFacade,
    enqueueWorkspaceCopy: (id, p) => backend!.enqueueWorkspaceCopy(id, p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    workspaceDir: () => wsCache,
    beginAgentSessionSlot: (reason) => backend!.beginAgentSessionSlot(reason),
    endAgentSessionSlot: () => backend!.endAgentSessionSlot(),
    emitLog: (entry) => { void backend!.invoke('log_emit', JSON.stringify({ input: entry })) },
    listMotifs: () => backend!.invoke('list_motifs', '{}'),
    motifStore,
    motifBuiltins,
    appSettings,
    viewState,
    exportSettings,
    keybindings,
    recents,
  })
  tsHost.start()
  console.log('[main] TS state actor authoritative; MCP host starting')

  // Stage-5 file watch (TS): on any disk change under <userData>/motifs/,
  // refresh the actor catalog (so a disk-written Motif is placeable via
  // add_motif) AND emit motifs:changed (renderer resync → ?v= host buster).
  // Supersedes the Rust watcher (still live until Phase 4 deletes the feature;
  // its duplicate emit is idempotent).
  motifWatcher = spawnMotifWatcher(motifStore.root(), () => {
    tsHost?.refreshMotifCatalog()
    mainWindow?.webContents.send('evt:motifs:changed', {})
  })

  // Start the MCP host (streamable HTTP + bearer) and expose its info IPC.
  // Started AFTER tsHost.start() so the actor is ready before any MCP read can run
  // (the host serves state views from the actor and injects compute slices).
  const { startMcpHost } = await import('./mcp/index.js')
  const mcpHost = await startMcpHost(backend, () => tsHost)
  mcpHostRef = mcpHost

  ipcMain.handle('get_mcp_info', () => mcpHost.getInfo())
  ipcMain.handle('reset_mcp_token', () => mcpHost.resetToken())
  ipcMain.handle('app:notices', () => startupNotices)

  ipcMain.handle('backend:invoke', async (_e, { channel, args }) => {
    // Motif runtime registration: renderer sends its clock-takeover source once
    // at boot; main injects it into the offscreen capture host via CDP.
    if (channel === 'motif_register_runtime') {
      setRuntimeSource((args as { source: string }).source)
      return null
    }
    // Motif frame capture: offscreen CDP path — never falls through to Rust.
    if (channel === 'motif_capture_frame') {
      const a = args as {
        motifId: string; tSec: number; propsJson: string
        width: number; height: number; settleRafs: number | null; contentHash: string
      }
      return await captureMotifFrameB64(a)
    }
    // API-key writes need safeStorage (main-only) + a push into the backend
    // cache. Intercept here; status/test fall through to the Rust dispatcher.
    if (channel === 'settings_set_api_key') {
      const { provider, key } = (args ?? {}) as { provider: string; key: string }
      setKey(provider, key)
      backend!.setCloudKey(provider, (key ?? '').trim())
      return null
    }
    if (channel === 'settings_clear_api_key') {
      const { provider } = (args ?? {}) as { provider: string }
      clearKey(provider)
      backend!.clearCloudKey(provider)
      return null
    }
    // Single-media compute: the TS actor owns state, so resolve the MediaItem
    // here and forward it — the Rust fns take it as a call argument (Phase 1).
    if (tsHost && SINGLE_MEDIA_CHANNELS.has(channel)) {
      const pool = tsHost.actor.snapshot().media_pool as Record<string, import('./state/model.js').MediaItem>
      const resolved = resolveSingleMediaArgs((args ?? {}) as { mediaId?: string }, pool)
      const json = await backend!.invoke(channel, JSON.stringify(resolved))
      return JSON.parse(json)
    }
    // Audio export: the TS actor owns state, so inject the full project here and
    // forward it — the Rust fns take it as a call argument (Phase 2).
    if (tsHost && EXPORT_PROJECT_CHANNELS.has(channel)) {
      const merged = injectProjectArgs((args ?? {}) as Record<string, unknown>, tsHost.actor.snapshot())
      const json = await backend!.invoke(channel, JSON.stringify(merged))
      return JSON.parse(json)
    }
    // TS actor splitter: route non-Rust channels into the TS host.
    // Consulted AFTER main-only intercepts above, BEFORE the Rust fallthrough.
    if (tsHost) {
      const route = (await import('./state/router.js')).routeChannel(channel)
      if (route.kind !== 'rust') return await tsHost.handleInvoke(channel, (args ?? {}) as Record<string, unknown>)
    }
    const json = await backend!.invoke(channel, JSON.stringify(args ?? {}))
    return JSON.parse(json)
  })

  // Native GPU-decode preview (Windows). Session lifecycle + the persistent
  // shared-texture handoff live in ./previewGpu; the per-frame
  // frameReady/eof/error pokes reach the renderer already, via the Backend
  // onEvent relay above (they fall through to `evt:previewGpu:*`). consumeAck is
  // driven by the preload's per-frame loop AFTER createImageBitmap resolves (the
  // ack-after-read contract) — never earlier, or native could reuse the slot
  // mid-read (tearing / a dropped frame). Native's AcquireSync on a still-held
  // slot now backstops this with a finite timeout (Error-poke + skip) rather
  // than hanging, but the ack ordering still exists to avoid paying that cost.
  ipcMain.handle(
    'previewGpu:open',
    (e, a: { streamId: string; path: string; poolSize: number; colorSpace: Electron.ColorSpace }) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
      if (!win) throw new Error('previewGpu:open — no window for sender')
      return openPreviewGpu(ndBackend(), win, a.streamId, a.path, a.poolSize, a.colorSpace)
    },
  )
  ipcMain.handle('previewGpu:requestFrameAt', (_e, a: { streamId: string; targetUs: number }) =>
    requestFrameAtPreviewGpu(ndBackend(), a.streamId, a.targetUs),
  )
  ipcMain.handle('previewGpu:consumeAck', (_e, a: { streamId: string; slot: number }) => {
    // Record the round-trip at handler entry (t_ack_received) BEFORE forwarding.
    recordConsumeAck(a.streamId, a.slot, performance.now())
    return consumeAckPreviewGpu(ndBackend(), a.streamId, a.slot)
  })
  ipcMain.handle('previewGpu:close', (_e, a: { streamId: string }) => closePreviewGpu(ndBackend(), a.streamId))
  ipcMain.handle('previewGpu:takeTimings', (_e, a: { streamId: string }) => takeTimingsPreviewGpu(ndBackend(), a.streamId))
  ipcMain.handle('previewGpu:takeMainTimings', () => takeMainTimings())

  // Availability of the optional native-decode component (level-0 gate). The
  // renderer pulls this once on mount to gray out the Native-engine setting +
  // surface the startup notice when the require failed.
  ipcMain.handle('decodeComponent:status', () => ({
    available: !!nd.backend,
    reason: nd.reason,
    version: nd.version,
  }))

  // Machine capability probe (D3): runs the SW one-frame decode probe (Task 12),
  // derives the format-class key from what it learned, and consults/updates the
  // per-machine cache above. KNOWN LIMITATION: previewSwProbe is SYNCHRONOUS and
  // UNINTERRUPTIBLE — it blocks the main thread until the one-frame decode
  // finishes. Acceptable because it only ever runs on import-vetted local media
  // (ffprobe'd at import time), so practical hang risk is low; no interrupt
  // callback is built here (out of scope for this task).
  ipcMain.handle('decodeCap:probeSw', (_e, a: { path: string }) => {
    if (!nd.backend) return { ok: false, classKey: null, reason: 'component unavailable' }
    const envKey = nd.version ?? 'unknown'
    const probe = nd.backend.previewSwProbe(a.path)
    const classKey = probe.codec ? classKeyOf(probe.codec, probe.pixFmt ?? null, probe.width, probe.height) : null
    if (classKey) {
      const cached = decodeCapability.get('sw', classKey, envKey)
      if (cached === null) decodeCapability.put('sw', classKey, envKey, probe.ok)
      // Cache-first shortcut: a cached true for this class skips nothing here
      // (we already probed to LEARN the class from this file), but the verdict
      // below prefers the cache so a one-off file glitch can't poison a class.
      return { ok: cached ?? probe.ok, classKey, reason: probe.reason ?? null }
    }
    return { ok: probe.ok, classKey, reason: probe.reason ?? null }
  })

  // Machine capability probe (D4): runs the HW (d3d11va) one-frame decode
  // probe (Task 16) for a caller-supplied classKey. Unlike the SW probe, the
  // HW probe doesn't derive the class key itself — it's expensive enough that
  // the renderer (Task 17) computes classKey from MediaSummary BEFORE deciding
  // to probe, so an already-cached verdict never pays for a decode. envKey is
  // GPU identity (vendor/device/driver): a driver update or GPU swap
  // invalidates every cached HW verdict for this machine.
  ipcMain.handle('decodeCap:probeHw', async (_e, a: { path: string; classKey: string }) => {
    if (process.platform !== 'win32' || !nd.backend) {
      return { ok: false, reason: 'hw lane unavailable' }
    }
    const envKey = await hwEnvKey()
    const cached = decodeCapability.get('hw', a.classKey, envKey)
    if (cached !== null) return { ok: cached, reason: 'cached' }
    const r = nd.backend.previewGpuProbe(a.path, 4000)
    decodeCapability.put('hw', a.classKey, envKey, r.ok)
    return { ok: r.ok, reason: r.reason ?? null }
  })

  // Native SOFTWARE-decode preview (ProRes/DNxHD/MPEG-2/VC-1 — the
  // WebCodecs-blind-format path). Frames flow out of band on the dedicated
  // `previewSw:frame` channel (see ./previewSw), not through the generic
  // `evt:*` EventSink relay above.
  ipcMain.handle('previewSw:open', (e, a: { streamId: string; path: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('previewSw:open — no window for sender')
    return openPreviewSw(ndBackend(), win, a.streamId, a.path)
  })
  ipcMain.on('previewSw:requestFrameAt', (_e, a: { streamId: string; targetUs: number }) => {
    // napi can throw Err (e.g. an unknown/already-closed streamId from a renderer
    // race) — this is a fire-and-forget .on listener, not .handle, so an uncaught
    // throw here would be an uncaught exception in the main process. Swallow.
    try { requestFrameAtPreviewSw(ndBackend(), a.streamId, a.targetUs) }
    catch (e) { console.warn('[main] previewSw:requestFrameAt failed', e) }
  })
  ipcMain.on('previewSw:close', (_e, a: { streamId: string }) => {
    try { closePreviewSw(ndBackend(), a.streamId) }
    catch (e) { console.warn('[main] previewSw:close failed', e) }
  })

  // Secondary windows (PerfHUD popup etc.) via win:* IPC.
  ipcMain.handle('win:create', (_e, { label, options }: { label: string; options?: SecondaryWinOpts }) => createSecondary(label, options))
  ipcMain.handle('win:act', (_e, { label, action }: { label: string; action: 'show' | 'hide' | 'close' | 'center' | 'focus' }) => actOnSecondary(label, action))
  ipcMain.handle('win:exists', (_e, { label }: { label: string }) => secondaryExists(label))

  // Drag-drop import: the renderer resolves real paths via webUtils and posts
  // them here; we re-emit the SAME `media:external-drop` event the renderer's
  // existing listener already handles.
  ipcMain.handle('media:dropped', (_e, paths: string[]) => {
    if (Array.isArray(paths) && paths.length > 0) {
      mainWindow?.webContents.send('evt:media:external-drop', paths)
    }
  })

  // Caption-button controls act on the SENDER's window, not always mainWindow:
  // secondary windows (the PerfHUD popup) render the same <WindowControls/>, so
  // their close/min/max must target themselves — otherwise the popup's close
  // button would close the main editor. fromWebContents resolves the window that
  // invoked the IPC; mainWindow is the fallback if it can't (shouldn't happen).
  const ctlWin = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? mainWindow
  ipcMain.handle('window:minimize', (e) => ctlWin(e)?.minimize())
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = ctlWin(e)
    if (w?.isMaximized()) w.unmaximize()
    else w?.maximize()
  })
  ipcMain.handle('window:close', (e) => ctlWin(e)?.close())
  ipcMain.handle('window:isMaximized', (e) => !!ctlWin(e)?.isMaximized())
  ipcMain.handle('window:setTitle', (e, title: string) => ctlWin(e)?.setTitle(title))
  // Color picker: freeze the invoking window for in-app (non-canvas) sampling.
  // PNG keeps the IPC payload small; the renderer derives the CSS→device pixel
  // scale from the decoded bitmap size vs window.innerWidth (robust across
  // display scale factors).
  ipcMain.handle('window:captureSnapshot', async (e) => {
    const img = await e.sender.capturePage()
    return img.toPNG()
  })
  // Color picker: the native EyeDropper's pick click activates the foreign
  // window (electron#27980 — the dropper widget has no system capture in
  // Electron); the renderer snaps focus back here after the pick settles.
  ipcMain.handle('window:focus', (e) => ctlWin(e)?.focus())
  ipcMain.handle('path:documentDir', () => app.getPath('documents'))
  ipcMain.handle('path:join', (_e, payload: { parts?: string[]; paths?: string[] }) => path.join(...(payload.parts ?? payload.paths ?? [])))
  ipcMain.handle('path:tempDir', () => app.getPath('temp'))

  // Open a path or URL in the OS default handler. Files/folders → the file
  // manager; http(s) → the default browser (openExternal refuses non-web
  // schemes, so a compromised renderer can't launch arbitrary protocols).
  ipcMain.handle('shell:open', async (_e, { target }: { target: string }) => {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target)
    } else {
      const err = await shell.openPath(target)
      if (err) throw new Error(err)
    }
  })

  // Best-effort desktop notification. Silently no-op where the OS reports no
  // notification support (matches the renderer's fire-and-forget contract).
  ipcMain.handle('notification:send', (_e, opts: { title?: string; body?: string }) => {
    if (!Notification.isSupported()) return
    new Notification({ title: opts?.title ?? '', body: opts?.body ?? '' }).show()
  })

  // Cross-window event broadcast: re-send to EVERY window (incl. the sender) as
  // `evt:<event>`. Backs the renderer's `emit()` → `listen()` path (e.g. the
  // main window streaming PerfHUD snapshots to the popped-out HUD window).
  ipcMain.handle('app:emit', (_e, { event, payload }: { event: string; payload?: unknown }) => {
    broadcastEvent(BrowserWindow.getAllWindows(), event, payload)
  })

  // Process-tree resource snapshot for the PerfHUD. Electron tracks the whole
  // app tree (Browser + renderers + GPU + utility) itself — no Rust round-trip,
  // no system-info crate. Works in dev AND release (unlike the dropped Rust
  // `get_system_stats`, which only ever errored).
  ipcMain.handle('app:metrics', () => collectMetrics(app.getAppMetrics(), os.cpus().length))

  const { dialog } = require('electron') as typeof import('electron')
  ipcMain.handle('dialog:open', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      multiple?: boolean
      directory?: boolean
      filters?: { name: string; extensions: string[] }[]
      defaultPath?: string
    }
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = o.directory
      ? ['openDirectory']
      : ['openFile']
    if (o.multiple) properties.push('multiSelections')
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      // Filters are meaningless for a directory picker.
      filters: o.directory ? undefined : o.filters,
      properties,
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return o.multiple ? res.filePaths : res.filePaths[0]
  })
  ipcMain.handle('dialog:save', async (_e, opts) => {
    const o = (opts ?? {}) as {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })

  // fs:* — direct main-process filesystem access for the renderer (write/append/
  // read/remove/readDir). Confined to APP-MANAGED roots: the OS temp dir (export
  // scratch), userData (incl. the backend Cache), and the active workspace. The
  // renderer is first-party (contextIsolation+sandbox, no remote content / no
  // <webview>) and the final export files + project saves go through Rust (not
  // this surface), so the whitelist breaks nothing — it just caps the blast
  // radius of an XSS/CSP breach: a compromised renderer can no longer read,
  // overwrite, or recursively delete arbitrary paths on disk. The workspace
  // path is fetched from the BACKEND (the authority), so a compromised renderer
  // can't widen its own scope by lying about which folder is "the workspace".
  //
  // NOTE: arbitrary user-imported MEDIA is served read-only by the separate
  // weftcut-media:// protocol below (those paths come from the import dialog and
  // can live anywhere), which is deliberately NOT confined here.
  let cachedWorkspace: string | null = null
  const refreshWorkspace = async (): Promise<void> => {
    try {
      cachedWorkspace = JSON.parse(await backend!.invoke('workspace_dir', '{}')) as string | null
    } catch {
      /* keep the last-known value on a query error */
    }
  }
  const fsRoots = (): string[] => {
    const roots = [app.getPath('temp'), app.getPath('userData')]
    if (cachedWorkspace) roots.push(cachedWorkspace)
    return roots
  }
  // Resolve `p` and assert it sits under an allowed root, else throw. Static
  // roots (temp/userData) are checked first with no backend round-trip; only a
  // miss re-queries the workspace (it may have just opened) and retries — so the
  // hot path (export temp appends) never touches the backend.
  const guardFsPath = async (p: string): Promise<string> => {
    const abs = path.resolve(p)
    if (isAllowed(abs, fsRoots())) return abs
    await refreshWorkspace()
    if (isAllowed(abs, fsRoots())) return abs
    throw new Error(`fs access denied: ${abs} is outside the allowed roots (temp, userData, workspace)`)
  }

  ipcMain.handle(
    'fs:writeFile',
    async (_e, { path: p, data, append }: { path: string; data: Uint8Array; append?: boolean }) => {
      const abs = await guardFsPath(p)
      const buf = Buffer.from(data)
      if (append) fs.appendFileSync(abs, buf)
      else fs.writeFileSync(abs, buf)
    },
  )
  ipcMain.handle('fs:writeTextFile', async (_e, { path: p, data }: { path: string; data: string }) => {
    fs.writeFileSync(await guardFsPath(p), data, 'utf8')
  })
  ipcMain.handle('fs:mkdir', async (_e, { path: p, recursive }: { path: string; recursive?: boolean }) => {
    fs.mkdirSync(await guardFsPath(p), { recursive: recursive ?? false })
  })
  ipcMain.handle('fs:readFile', async (_e, { path: p }: { path: string }) => fs.readFileSync(await guardFsPath(p)))
  ipcMain.handle('font:resolve', async (_e, { family }: { family: string }) => {
    return resolveSystemFont(family)
  })

  // PoC: native IPC video-sink write. Binary frame in (ArrayBuffer/typed array),
  // forwarded straight to the napi backend's ffmpeg stdin. No JSON.
  ipcMain.handle('export:videosink_write', async (_e, ab: ArrayBuffer | Uint8Array) => {
    const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab as ArrayBuffer)
    await backend!.exportVideoSinkWrite(buf)
  })
  ipcMain.handle('fs:remove', async (_e, { path: p }: { path: string }) => {
    fs.rmSync(await guardFsPath(p), { force: true, recursive: true })
  })
  ipcMain.handle('fs:exists', async (_e, { path: p }: { path: string }) => fs.existsSync(await guardFsPath(p)))
  ipcMain.handle('fs:readDir', async (_e, { path: p }: { path: string }) =>
    fs.readdirSync(await guardFsPath(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })),
  )

  registerMotifProtocol(motifBuiltinDir, motifStore)

  protocol.handle('weftcut-media', async (request) => {
    // URL form: weftcut-media://localhost/<encodeURIComponent(absPath)>
    const u = new URL(request.url)
    const abs = decodeURIComponent(u.pathname.replace(/^\//, ''))
    if (!path.isAbsolute(abs)) {
      return new Response('bad path', { status: 403 })
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 })

    const total = stat.size
    const range = request.headers.get('Range')
    const headersBase: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
    }

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m) return new Response('bad range', { status: 416 })
      let start = m[1] === '' ? 0 : parseInt(m[1], 10)
      let end = m[2] === '' ? total - 1 : parseInt(m[2], 10)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        })
      }
      if (end >= total) end = total - 1
      const stream = fs.createReadStream(abs, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...headersBase,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }

    const stream = fs.createReadStream(abs)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: { ...headersBase, 'Content-Length': String(total) },
    })
  })

  const win = await createWindow()

  win.once('ready-to-show', () => win.show())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().then((w) => w.once('ready-to-show', () => w.show()))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Flush the TS actor's debounced autosave before the process exits — an edit made
// inside the 500ms autosave debounce window would otherwise be lost on quit
// (autosave.stop() drops the pending timer rather than firing it). `project_save`
// routes (router.ts) to autosave.forceFlush(), a no-op when no workspace is set
// (blank-boot). Async-quit pattern: preventDefault once, flush, then re-quit; the
// quitFlushed guard breaks the re-entrant before-quit that app.quit() raises.
// Flag-off (tsHost null) early-returns so the Rust path's quit behavior is unchanged.
let quitFlushed = false
app.on('before-quit', (event) => {
  motifWatcher?.close(); motifWatcher = null
  if (quitFlushed || !tsHost) return
  event.preventDefault()
  quitFlushed = true
  void tsHost
    .handleInvoke('project_save', {})
    .catch((e) => console.warn('[main] autosave quit-flush failed', e))
    .finally(() => app.quit())
})
