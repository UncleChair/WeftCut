import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, shell } from 'electron'
import { loadAllKeys, setKey, clearKey } from './keys.js'
import { MOTIF_SCHEME_ENTRY, registerMotifProtocol } from './motif/protocol.js'
import { setRuntimeSource, captureMotifFrameB64, setMotifStore } from './motif/capture.js'
import { UserMotifStore } from './motif/store.js'
import { spawnMotifWatcher, type MotifWatcher } from './motif/watcher.js'
import { builtinAssetDir } from './motif/builtinAssets.js'
import { createSecondary, actOnSecondary, secondaryExists, hardenWindow, restoreGeometry, rememberGeometry } from './windows.js'
import type { SecondaryWinOpts } from './windowConfig.js'
import { shouldClearApplicationMenu } from './inputPolicy.js'
import { buildApplicationMenuTemplate, sanitizeMenuProjection } from './appMenu.js'
import type { MenuProjection } from '../shared/menu.js'
import { broadcastEvent } from './broadcast.js'
import { resolveSystemFont } from './fonts/resolveSystemFont.js'
import { collectMetrics } from './metrics.js'
import { isAllowed } from './fsGuard.js'
import { applyDerivativesEvent, applyWorkspacePathsEvent } from './state/jobs-writeback.js'
import { SINGLE_MEDIA_CHANNELS, resolveSingleMediaArgs } from './state/single-media-forward.js'
import { EXPORT_PROJECT_CHANNELS, injectProjectArgs } from './state/export-project-forward.js'
import { openPreviewGpu, requestFrameAtPreviewGpu, consumeAckPreviewGpu, closePreviewGpu, takeTimingsPreviewGpu, hwBudget } from './previewGpu.js'
import { recordFrameReadySent, recordConsumeAck, takeMainTimings } from './previewGpuTiming.js'
import { openPreviewSw, requestFrameAtPreviewSw, closePreviewSw } from './previewSw.js'
import { openExportSw, decodeRangeExportSw, returnCreditExportSw, closeExportSw, closeAllExportSw } from './exportSw.js'
import { loadNativeDecode } from './native-decode.js'
import { MAIN_WINDOW_MINIMUM_SIZE, MAIN_WINDOW_GEOMETRY_DEFAULTS, MAIN_WINDOW_LABEL } from './mainWindowConfig.js'
import { openPathRobust } from './openPath.js'
import {
  planMigration, runCopy, verify, rollback,
  writeMarker, readMarker, clearMarker, deleteOldCopy,
  type MigrationFs,
} from './dataRootMigration.js'
import type { DataRootMigrateResult, DataRootProgress } from '../shared/data-root.js'

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

/// Forward an `evt:*` event to the renderer, guarding against a native/backend
/// callback firing during teardown. `mainWindow?.` only catches null — a window
/// that has been DESTROYED (app closing) is still a non-null reference, and
/// `.webContents.send()` on it (or even reading `.webContents`) throws
/// "Object has been destroyed". For the async backend / native-decode event
/// relays that throw is uncaught and surfaces as a main-process error dialog —
/// especially visible in e2e, which launches and closes the app rapidly. No-op
/// once the window (or its webContents) is gone.
function emitToRenderer(event: string, payload: unknown): void {
  const w = mainWindow
  if (!w || w.isDestroyed()) return
  const wc = w.webContents
  if (wc.isDestroyed()) return
  wc.send('evt:' + event, payload)
}
// The MCP host is started after `backend.init()`, but the `onEvent` closure
// (which taps `mcp:change`) is constructed in the `new Backend(...)` call
// BEFORE the host exists. Hold it module-scoped and set it right after
// `startMcpHost` resolves.
let mcpHostRef: import('./mcp/index.js').McpHost | null = null
let tsHost: import('./state/ts-actor-host.js').TsActorHost | null = null
let motifWatcher: MotifWatcher | null = null
// Held at module scope so the before-quit handler can flush the debounced
// Workspace-layout write before the process exits.
let workspaceStore: import('./workspace.js').WorkspaceStore | null = null
// Same reason, plus createWindow() reads it — and createWindow is also invoked
// from `app.on('activate')` (macOS re-open) with no arguments, so the store
// cannot be threaded in as a parameter. Null until whenReady constructs it;
// window creation happens later in that same closure, so the main window always
// sees it. A null store degrades to "no geometry memory", never to a crash.
let windowGeometryStore: import('./windowGeometry.js').WindowGeometryStore | null = null

const isDev = !!process.env['ELECTRON_RENDERER_URL']

// App-level startup notices the renderer PULLS on mount via the `app:notices`
// IPC (see AppNotice in src/shared/ipc.ts). Collected here at startup, fetched
// when the renderer is ready — a pull model, because a push send loses any
// notice emitted before the renderer subscribes.
const startupNotices: { level: string; code: string }[] = []

// GPU identity for the HW capability lane: vendor/device/driver — a
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

/// (Re)install the macOS application menu from the renderer's latest
/// projection — null before its first sync, i.e. the menu on show while the
/// window is still loading. Chosen items travel back as `menu:action`, which the
/// renderer runs through the same handler map `useShortcuts` dispatches into.
function installApplicationMenu(projection: MenuProjection | null): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        projection,
        appName: app.getName(),
        dispatch: (actionId) => emitToRenderer('menu:action', { actionId }),
      }),
    ),
  )
}

// DRM render nodes (/dev/dri/renderD*) for VAAPI device enumeration (issue #5
// Block C, User Story 9): libva's default device selection picks the wrong GPU
// on a multi-GPU machine, so the resolver probes each node explicitly. Sorted
// for a stable probe order; [] off Linux or when the dir is absent (a
// non-VAAPI platform simply enumerates no devices, so the VAAPI lane is
// skipped even if somehow advertised).
function enumerateDrmRenderNodes(): string[] {
  try {
    return fs
      .readdirSync('/dev/dri')
      .filter((n) => n.startsWith('renderD'))
      .sort()
      .map((n) => `/dev/dri/${n}`)
  } catch {
    return []
  }
}

async function createWindow(): Promise<BrowserWindow> {
  // Last session's position/size, validated against the monitors attached RIGHT
  // NOW (windowGeometry.ts). Spread into the constructor rather than applied
  // after — `show: true` below means a post-construction setBounds() would be a
  // visible jump. Falls back to a centered 1440×900 whenever the saved rect is
  // missing, stale, or unreachable.
  const geometry = restoreGeometry(windowGeometryStore, MAIN_WINDOW_LABEL, MAIN_WINDOW_GEOMETRY_DEFAULTS)
  const win = new BrowserWindow({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    // Restored only on macOS, where the green traffic light can also LEAVE
    // fullscreen; see sanitizeGeometry on why Win/Linux never restores it.
    // LANDMINE: spread in only when actually TRUE. Passing `fullscreen: false`
    // (the value on every normal launch) makes Electron DISABLE the window's
    // fullscreen capability outright — isFullScreenable() goes false and the
    // green stoplight degrades to a plain zoom, silently losing native
    // fullscreen. Verified on Electron 42: omitting the key gives a
    // fullscreenable window, passing `false` or even `undefined` does not.
    ...(geometry.fullScreen ? { fullscreen: true as const } : {}),
    // Restates the default, so the trap above can't creep back in via another
    // option; the e2e window-chrome spec guards the resulting capability.
    fullscreenable: true,
    ...MAIN_WINDOW_MINIMUM_SIZE,
    // Dev only: electron-vite runs the bare electron.exe, whose taskbar/Alt-Tab
    // icon is Electron's default. The PACKAGED app gets its icon from
    // electron-builder (embedded in the exe + installer — see
    // electron-builder.yml), and build/ is not bundled into the app, so we point
    // at the raster master only in dev, where the repo tree is on disk.
    ...(isDev ? { icon: path.join(import.meta.dirname, '../../build/icon.png') } : {}),
    // Show immediately. A frameless (`frame:false`) window combined with
    // `show:false` + a deferred `ready-to-show` show does NOT reliably surface
    // on Windows (ready-to-show may not fire) — the window stays hidden. With a
    // set backgroundColor there's no white flash, so show on create.
    show: true,
    // Titlebar strategy is platform-split so the green stoplight behaves like a
    // native app on macOS:
    //   • macOS — `titleBarStyle: 'hidden'` hides the bar but KEEPS the native
    //     traffic lights (red/amber/green) in the top-left. With `fullscreenable`
    //     left at its default (true), the green button enters the native
    //     fullscreen Space ("its own screen") with the system animation, exactly
    //     like a native app — no custom wiring needed. The renderer suppresses
    //     its own caption glyphs on macOS (see WindowControls / platform.ts) and
    //     insets its titlebars to clear the traffic lights.
    //   • Windows / Linux — a fully frameless window; the renderer draws its own
    //     titlebar (app-header / startup-titlebar / agent-titlebar) + caption
    //     buttons, since those platforms have no traffic-light equivalent.
    // trafficLightPosition centres the buttons in our slim caption bars instead
    // of the taller macOS default. The buttons occupy a 14px-tall band whose TOP
    // is `y` (measured on Electron 42; fractional values round to whole points),
    // so centring in a bar of height H means y = (H - 14) / 2. H here is the
    // renderer's shared chrome band, --app-chrome-height in app.css — 42.5px,
    // .app-header's content-driven height, which the startup strip and the
    // agent-mode row take too — giving y = 14. Chromium then reports
    // env(titlebar-area-height) as 2y + 14 = 42px, and the band's centre is
    // always exactly half of that, so the invariant is simply "bar height ==
    // env(titlebar-area-height)". One number for all three bars, so this y has
    // to match it. The e2e window-chrome spec fails if they drift apart.
    // titleBarOverlay exposes the button geometry to CSS as
    // env(titlebar-area-*), which is how the renderer insets its titlebars —
    // Chromium updates those in lockstep with the native frame, including at the
    // START of the leave-fullscreen animation (~500ms before Electron's
    // 'leave-full-screen' fires), so the title never overlaps the reappearing
    // buttons. macOS ONLY: on Windows the same flag makes the OS draw its own
    // caption buttons on top of our <WindowControls/>.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 13, y: 14 }, titleBarOverlay: true }
      : { frame: false }),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // BrowserWindow has no `maximized` constructor option, so this is the one
  // restored field that must be applied after the fact. Kept in the SAME tick as
  // the constructor (nothing below awaits before the content loads) so Chromium
  // has not painted a frame at the un-maximized size yet — no visible snap.
  if (geometry.maximized) win.maximize()

  mainWindow = win
  hardenWindow(win)
  // Start tracking moves/resizes. Wired after the restore above so the initial
  // maximize() doesn't bounce straight back into the store. `geometry` is passed
  // back in as the deadband baseline — without it the window grows a few pixels
  // on every launch (windowGeometry.ts, BOUNDS_DEADBAND_PX).
  rememberGeometry(win, MAIN_WINDOW_LABEL, windowGeometryStore, geometry)

  // The renderer draws its own caption buttons (frameless window); their
  // maximize/restore glyph cares only about maximize-STATE transitions, not
  // every resize tick. Emit on maximize/unmaximize only — the external paths
  // (drag-region double-click, Win+arrow, drag-to-top) all funnel through these
  // — and carry the state so the renderer needn't round-trip back to read it.
  const sendMaximizeState = () =>
    win.webContents.send('evt:window:maximize-changed', { isMaximized: win.isMaximized() })
  win.on('maximize', sendMaximizeState)
  win.on('unmaximize', sendMaximizeState)

  // Forward the fullscreen state so the renderer can drop its self-drawn window
  // edge (base.css .app-window-fullscreen) while the window owns the screen.
  // NOT used for the macOS traffic-light inset: these events land only AFTER the
  // fullscreen animation finishes, so driving the inset off them left the title
  // overlapping the reappearing buttons for the length of the exit animation.
  // That inset now reads env(titlebar-area-x) instead (titleBarOverlay above).
  const sendFullscreenState = () =>
    win.webContents.send('evt:window:fullscreen-changed', { isFullscreen: win.isFullScreen() })
  win.on('enter-full-screen', sendFullscreenState)
  win.on('leave-full-screen', sendFullscreenState)

  // Capture renderer console messages to stdout for diagnostics
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['verbose', 'info', 'warning', 'error'][level] ?? 'log'
    console.log(`[renderer:${lvl}] ${message} (${sourceId}:${line})`)
  })

  if (isDev) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    await win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
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
  // Windows taskbar identity: without an explicit AppUserModelID a run groups
  // under generic "electron.exe" and won't adopt our window icon. Match the
  // packaged appId (electron-builder.yml) so dev and prod share one identity.
  app.setAppUserModelId('dev.weftcut.desktop')

  // WeftCut's UI is dark-only (base.css pins `color-scheme: dark`), so declare
  // that to the OS instead of inheriting the system appearance. macOS draws the
  // traffic lights through the WINDOW's appearance, and its light-chrome
  // INACTIVE state is a dark grey disc meant for a light titlebar — invisible
  // against our #0a0a0a caption, so an unfocused window looked like it had no
  // buttons at all on a light-mode host. `color-scheme` can't reach them: it
  // only governs what Chromium paints, not NSWindow's own controls. Set before
  // the first window (and before any native menu/dialog) so nothing paints
  // light first; it also carries the dark appearance into native menus, sheets,
  // and the file picker.
  nativeTheme.themeSource = 'dark'

  // App-global (not per-window): Electron's DEFAULT application menu never goes
  // live on any platform — Windows/Linux get no menu at all, macOS the explicit
  // one from ./appMenu. Either way dev reload/DevTools/fullscreen come from
  // hardenWindow's before-input-event seam, so dev and prod share one code path.
  if (shouldClearApplicationMenu(process.platform)) Menu.setApplicationMenu(null)
  else installApplicationMenu(null)

  // Bundled ffmpeg: ffmpeg-sidecar resolves "ffmpeg" via PATH when no binary sits
  // adjacent to the exe (ffmpeg_sidecar::paths::ffmpeg_path). Prepend the packaged dir so the
  // in-process addon spawns OUR static build, not a system one. Dev (unpackaged)
  // has no bundled dir → falls back to system/auto-download as before.
  const ffmpegDir = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(import.meta.dirname, '../../resources/ffmpeg', process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux')
  const ffmpegBin = path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (fs.existsSync(ffmpegBin)) {
    process.env.PATH = ffmpegDir + path.delimiter + (process.env.PATH ?? '')
    console.log(`[main] bundled ffmpeg on PATH: ${ffmpegBin}`)
    // ffmpeg-sidecar's ffmpeg_path() prefers a binary ADJACENT to the Electron
    // exe over anything on PATH (paths.rs sidecar_path), so a stale sidecar
    // auto-download dropped there silently shadows the controlled build above —
    // the "sidecar version uncontrolled" trap (issue #5). Linux no longer
    // auto-downloads (native ffmpeg::bootstrap), so this only bites a machine
    // that did so before; warn loudly rather than delete a file in node_modules.
    const adjacent = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (fs.existsSync(adjacent)) {
      console.warn(`[main] WARNING: ${adjacent} sits beside the Electron binary and will SHADOW the controlled sidecar (${ffmpegBin}); remove it so exports use the version-pinned ffmpeg.`)
    }
  }

  // Atomic-JSON fs adapter (temp+rename) shared by every TS-owned config store.
  // Constructed here (ahead of its later consumers) because the app-settings
  // store and the data-root resolver both need it BEFORE the Backend cache dir
  // and UserMotifStore are built below.
  const atomicFs = {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
    rename: (a: string, b: string) => fs.renameSync(a, b),
    mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
  }
  // App-level prefs store — persists <userData>/app_settings.json. This is the
  // SINGLE owner of app_settings.json (the resolver and every later consumer
  // reuse this instance; no second parse anywhere).
  const { createAppSettingsStore } = await import('./app-settings.js')
  const appSettings = createAppSettingsStore({ fs: atomicFs, path: path.join(app.getPath('userData'), 'app_settings.json'), dir: app.getPath('userData') })

  // Speech-backend config store — persists <userData>/speech_config.json (NON-
  // secret: preferred engine + each local engine's binary/model/device/threads).
  // The OpenAI API key stays in safeStorage (keys.ts); this is its non-secret
  // sibling (ADR 0036). Single owner — the startup population loop + the Settings
  // IPC intercepts below reuse this instance.
  const { createSpeechConfigStore } = await import('./speech-config.js')
  const speechConfig = createSpeechConfigStore({ fs: atomicFs, path: path.join(app.getPath('userData'), 'speech_config.json'), dir: app.getPath('userData') })

  // Video-understanding (VLM) backend config store — <userData>/vlm_config.json,
  // the non-secret sibling of the cloud key (ticket 06). Unlike speech (pushed
  // onto the napi Backend), VLM config is injected per-call into describe_clip /
  // media://{id}/description (stateless, ADR 0024) via the provider passed to
  // startMcpHost below.
  const { createVlmConfigStore, toVlmBackendSnapshot } = await import('./vlm-config.js')
  const vlmConfig = createVlmConfigStore({ fs: atomicFs, path: path.join(app.getPath('userData'), 'vlm_config.json'), dir: app.getPath('userData') })

  // Resolve the user-configurable data root BEFORE the Backend cache dir
  // (`new Backend(...)` below) and UserMotifStore are constructed — both take
  // their paths from it. A configured-but-unavailable root surfaces a blocking
  // native dialog here (no main window yet), so the sync Electron
  // dialog/picker are used.
  const { resolveDataRoot } = await import('./dataRoot.js')
  const dataRoot = resolveDataRoot({
    userDataDir: app.getPath('userData'),
    settings: appSettings,
    fs: {
      mkdirp: (d: string) => { fs.mkdirSync(d, { recursive: true }) },
      writeFile: (p: string, t: string) => fs.writeFileSync(p, t, 'utf8'),
      rm: (p: string) => { fs.rmSync(p, { force: true }) },
    },
    join: path.join,
    showUnavailableDialog: (unavailableRoot) => {
      const zh = app.getLocale().toLowerCase().startsWith('zh')
      const idx = dialog.showMessageBoxSync({
        type: 'error',
        noLink: true,
        buttons: zh ? ['重新选择…', '退出'] : ['Re-set…', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        title: zh ? '数据文件夹不可用' : 'Data folder unavailable',
        message: zh ? 'WeftCut 无法访问已配置的数据文件夹' : "WeftCut can't reach its data folder",
        detail: zh
          ? `路径:\n${unavailableRoot}\n\n该磁盘可能未挂载、被删除或权限被撤销。请重新选择一个位置,或退出。`
          : `Path:\n${unavailableRoot}\n\nThe drive may be unmounted, deleted, or its permission revoked. Choose a new location, or quit.`,
      })
      return idx === 0 ? 'reset' : 'quit'
    },
    pickDirectory: () => {
      const zh = app.getLocale().toLowerCase().startsWith('zh')
      const picked = dialog.showOpenDialogSync({
        title: zh ? '选择数据文件夹' : 'Choose a data folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      return picked && picked.length > 0 ? picked[0] : null
    },
    exit: () => app.exit(0),
  })
  console.log(`[main] data root: ${dataRoot.dataRoot} (motifs=${dataRoot.motifsDir}, cache=${dataRoot.cacheDir}, downloads=${dataRoot.downloadsDir})`)

  // Construct + init the Backend before creating the window
  backend = new Backend(
    app.getPath('userData'),
    dataRoot.cacheDir,
    (_err: Error | null, msg: string) => {
      if (!msg) return
      const { event, payload } = JSON.parse(msg)
      // `mcp:change` is consumed by the MCP host (relayed as an in-protocol
      // streamable-HTTP notification to connected agents), NOT forwarded to the renderer.
      if (event === 'mcp:change') {
        mcpHostRef?.notifyChange(payload)
        return
      }
      // `media:derivatives` write-back: apply the derivative patch to the TS
      // actor instead of forwarding to the renderer. tsHost is module-scoped
      // (set later); the closure captures it by reference.
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
        // tsHost not constructed yet (boot window) — fall through is defensive
      }
      // `media:workspace_paths` write-back: the background import-copy job's
      // path/hash result. Same seam shape as media:derivatives — apply to the
      // TS actor instead of forwarding to the renderer.
      if (event === 'media:workspace_paths') {
        if (tsHost) {
          try { applyWorkspacePathsEvent(tsHost.actor, payload as never) }
          catch (e) { console.warn('[main] media:workspace_paths write-back threw', e) }
          return
        }
        // tsHost not constructed yet (boot window) — fall through is defensive
      }
      emitToRenderer(event, payload)
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
      emitToRenderer(event, payload)
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
    // Surfaced through the renderer's system-status entry (pulled via app:notices).
    startupNotices.push({ level: 'warn', code: 'keyring_unavailable' })
  }

  // Push any safeStorage-persisted cloud API keys into the backend cache so
  // reqwest providers + settings_test_provider see them without a renderer round-trip.
  for (const [provider, key] of Object.entries(loadAllKeys())) {
    backend.setCloudKey(provider, key)
  }
  // …and the TS-owned local-engine config (non-secret binary/model paths) so the
  // speech resolver sees a COMPLETE speech_config snapshot (cloud keys + local
  // config) before the first transcribe_clip. Ordered right after the keys, well
  // ahead of the MCP host start below.
  for (const [tag, lc] of Object.entries(speechConfig.get().local)) {
    backend.setLocalBackend(tag, lc.binary, lc.model, lc.device ?? null, lc.threads ?? null, lc.tokens ?? null)
  }

  // Construct the motif store + resolve the built-in dir once at boot.
  // Both are passed to the protocol handler and the capture singleton so
  // captureMotifFrameB64 and registerMotifProtocol don't need the backend.
  const motifStore = new UserMotifStore(dataRoot.motifsDir)
  const motifBuiltinDir = builtinAssetDir()
  setMotifStore(motifStore)

  // TS actor host: constructed unconditionally; must start BEFORE startMcpHost so
  // the actor (the sole owner of project state — it serves every MCP state view and
  // injects the slice each Rust compute call needs) is ready before any MCP read can
  // run. mcpNotify uses mcpHostRef?.notifyChange (optional), so the host wires up
  // cleanly before the MCP host exists.
  const [{ createTsActorHost }, { initEval }] = await Promise.all([
    import('./state/ts-actor-host.js'),
    import('./state/snap.js'),
  ])

  // The TS actor snaps frame edges via the wasm eval leaf (snap.ts → renderer/eval).
  // Main MUST initialize it once at boot before the actor handles any command
  // (snap.ts contract).
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

  // Directory-scan/stat/rename shell for the open-time media relink self-heal.
  const relinkFs = {
    exists: (p: string) => fs.existsSync(p),
    listDir: (d: string) => { try { return fs.readdirSync(d) as string[] } catch { return [] } },
    statFile: (p: string) => {
      try {
        const s = fs.statSync(p)
        return s.isFile() ? { size: s.size, mtimeSecs: Math.floor(s.mtimeMs / 1000) } : null
      } catch { return null }
    },
    rename: (from: string, to: string) => { fs.renameSync(from, to) },
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

  // Rust compute facade for the native-compute → TS-write hybrids:
  // Rust probes/hashes/parses (no actor write); the TS host applies the write.
  const computeFacade = {
    probeMedia: (p: string) => backend!.probeMedia(p),
    hashMediaSource: (p: string) => backend!.hashMediaSource(p),
    parseSubtitles: (body: string, format: string | null) => backend!.parseSubtitles(body, format),
    synthesizeSpeechCompute: (argsJson: string) => backend!.synthesizeSpeechCompute(argsJson),
    analyzeShots: (mediaJson: string, optsJson: string) => backend!.analyzeShots(mediaJson, optsJson),
  }

  // Load built-in Motif sources once (manifest + relocated index.html) for the
  // TS catalog/authoring surface. builtinMotifs reads from motifBuiltinDir.
  const { builtinMotifs } = await import('./motif/authoring.js')
  const motifBuiltins = builtinMotifs(motifBuiltinDir)

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
  // App-level Workspace document (Dock arrangement) — persists
  // <userData>/workspaces.json. Debounced writes; flushed on quit (below).
  const { createWorkspaceStore } = await import('./workspace.js')
  const workspace = createWorkspaceStore({ fs: atomicFs, path: path.join(app.getPath('userData'), 'workspaces.json'), dir: app.getPath('userData') })
  workspaceStore = workspace
  // Window position/size memory — persists <userData>/window_geometry.json.
  // Must be constructed BEFORE createWindow() below (it reads the saved rect to
  // build the BrowserWindow options). Debounced writes; flushed on window close
  // and on quit. e2e launches mint a fresh userData dir per app (see
  // e2e/electron/helpers/driver.ts), so specs always get the centered default.
  const { createWindowGeometryStore } = await import('./windowGeometry.js')
  windowGeometryStore = createWindowGeometryStore({
    fs: atomicFs,
    path: path.join(app.getPath('userData'), 'window_geometry.json'),
    dir: app.getPath('userData'),
  })
  // Recent-projects list + startup prefs — persists <userData>/recents.json.
  const { createRecentsStore } = await import('./recents.js')
  const recents = createRecentsStore({
    fs: atomicFs,
    path: path.join(app.getPath('userData'), 'recents.json'),
    dir: app.getPath('userData'),
  })
  // Machine capability cache (ADR 0030; docs/preview.md §Decode engine) —
  // persists <userData>/decode_capability.json. Keyed by (lane, format class),
  // invalidated per-lane when its envKey changes (SW: ffmpeg version).
  const { createDecodeCapabilityStore, classKeyOf, resolveHwLane } = await import('./decode-capability.js')
  const decodeCapability = createDecodeCapabilityStore({
    fs: atomicFs,
    path: path.join(app.getPath('userData'), 'decode_capability.json'),
    dir: app.getPath('userData'),
  })

  tsHost = createTsActorHost({
    send: (event, payload) => emitToRenderer(event, payload),
    mcpNotify: (payload) => mcpHostRef?.notifyChange(payload),
    fileExists: (p) => fs.existsSync(p),
    fs: nodeFs,
    relinkFs,
    join: path.join,
    napi: napiFacadeWithCache,
    compute: computeFacade,
    enqueueWorkspaceCopy: (id, p) => backend!.enqueueWorkspaceCopy(id, p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    workspaceDir: () => wsCache,
    beginAgentSessionSlot: (reason, client) => backend!.beginAgentSessionSlot(reason, client),
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
    workspace,
  })
  tsHost.start()
  console.log('[main] TS state actor authoritative; MCP host starting')

  // Motif file watch: on any disk change under <dataRoot>/motifs/, refresh
  // the actor catalog (so a disk-written Motif is placeable via add_motif)
  // AND emit motifs:changed (renderer resync → ?v= host buster).
  motifWatcher = spawnMotifWatcher(dataRoot.motifsDir, () => {
    tsHost?.refreshMotifCatalog()
    emitToRenderer('motifs:changed', {})
  })

  // Start the MCP host (streamable HTTP + bearer) and expose its info IPC.
  // Started AFTER tsHost.start() so the actor is ready before any MCP read can run
  // (the host serves state views from the actor and injects compute slices).
  const { startMcpHost } = await import('./mcp/index.js')
  const mcpHost = await startMcpHost(backend, () => tsHost, () => speechConfig.get().preferred_engine, () => {
    // Merge non-secret store config + the OpenAI cloud key (the VLM cloud
    // backend is gpt-4o) into the snapshot the stateless describe_clip resolver
    // reads; empty until the user configures an engine → "no backend available".
    const cfg = vlmConfig.get()
    return { config: toVlmBackendSnapshot(cfg, loadAllKeys().openai ?? null), preferred: cfg.preferred_engine }
  })
  mcpHostRef = mcpHost

  ipcMain.handle('get_mcp_info', () => mcpHost.getInfo())
  ipcMain.handle('reset_mcp_token', () => mcpHost.resetToken())
  ipcMain.handle('app:notices', () => startupNotices)
  // macOS application menu: the renderer resolves labels (i18next) and
  // effective accelerators (catalogue defaults ⊕ keybindings.json) and pushes
  // them here on mount and whenever either changes, so the native menu can
  // never show a stale label or a rebound chord. Payload is renderer-authored,
  // hence sanitised before it reaches Menu.buildFromTemplate.
  ipcMain.handle('menu:sync', (_e, projection: unknown) => {
    installApplicationMenu(sanitizeMenuProjection(projection))
  })
  // About-dialog identity: app version + runtime tags, pulled by the renderer
  // (Help → About) since the bundle has no package.json access.
  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch,
  }))

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
    // Speech backends. Like the API-key writes above, these are
    // intercepted here — the reads merge Rust-side availability with the
    // TS-owned config store, and the writes both persist non-secret local config
    // AND push it into the backend cache (setLocalBackend, the non-secret sibling
    // of setCloudKey). Intercepted BEFORE the router, so they never route to Rust.
    if (channel === 'settings_get_speech_backends') {
      const sc = speechConfig.get()
      const json = await backend!.invoke('settings_get_speech_backends', JSON.stringify({
        preferred: sc.preferred_engine === 'auto' ? null : sc.preferred_engine,
      }))
      const rows = JSON.parse(json) as Array<{ backend: string; locality: string } & Record<string, unknown>>
      // Merge each LOCAL backend's stored paths/hints so the UI can populate its
      // picker fields; cloud rows carry no local config.
      return {
        preferred_engine: sc.preferred_engine,
        backends: rows.map((r) =>
          r.locality === 'local' && sc.local[r.backend]
            ? { ...r, local: sc.local[r.backend] }
            : r,
        ),
      }
    }
    if (channel === 'settings_set_speech_preferred') {
      const { engine } = (args ?? {}) as { engine: import('../shared/speech-config.js').PreferredEngine }
      speechConfig.apply({ preferred_engine: engine })
      return null
    }
    if (channel === 'settings_set_local_backend') {
      const a = (args ?? {}) as { backend: string; binary: string; model: string; tokens?: string; device?: string; threads?: number }
      const next = speechConfig.apply({
        local: {
          backend: a.backend,
          config: {
            binary: a.binary,
            model: a.model,
            ...(a.tokens ? { tokens: a.tokens } : {}),
            ...(a.device ? { device: a.device } : {}),
            ...(a.threads != null ? { threads: a.threads } : {}),
          },
        },
      })
      // Push the PERSISTED (sanitized) entry, not the raw args — the store
      // trims paths and drops bogus threads, and pushing anything else would
      // give the live resolver a different config than the next launch reads.
      // A sanitized-away entry (both paths blank) clears the cache entry too.
      const entry = next.local[a.backend]
      if (entry) backend!.setLocalBackend(a.backend, entry.binary, entry.model, entry.device ?? null, entry.threads ?? null, entry.tokens ?? null)
      else backend!.clearLocalBackend(a.backend)
      return null
    }
    if (channel === 'settings_clear_local_backend') {
      const { backend: tag } = (args ?? {}) as { backend: string }
      speechConfig.apply({ local: { backend: tag, config: null } })
      backend!.clearLocalBackend(tag)
      return null
    }
    // "Analyze shots" (media-pool drive-by): warm the deterministic shot report
    // for one media through the existing shot-analysis napi — the SAME VSHOT
    // cache the agent's analyze_clip / auto_split_by_shot read, so a later agent
    // call is a hit. Handled here rather than via SINGLE_MEDIA_CHANNELS because
    // it calls the direct `analyzeShots` napi (whole-source report) rather than a
    // Rust `invoke` arm; the TS actor (sole state owner) resolves the MediaItem.
    // Returns the detected shot count for a status line.
    if (tsHost && channel === 'analyze_shots') {
      const { mediaId } = (args ?? {}) as { mediaId?: string }
      const pool = tsHost.actor.snapshot().media_pool as Record<string, import('./state/model.js').MediaItem>
      const item = pool[mediaId ?? '']
      if (!item) throw new Error(`media ${mediaId ?? ''} not found`)
      const report = JSON.parse(await backend!.analyzeShots(JSON.stringify(item), '{}')) as { shots?: unknown[] }
      return { shots: report.shots?.length ?? 0 }
    }
    // Single-media compute: the TS actor owns state, so resolve the MediaItem
    // here and forward it — the Rust fns take it as a call argument.
    if (tsHost && SINGLE_MEDIA_CHANNELS.has(channel)) {
      const pool = tsHost.actor.snapshot().media_pool as Record<string, import('./state/model.js').MediaItem>
      const resolved = resolveSingleMediaArgs((args ?? {}) as { mediaId?: string }, pool)
      const json = await backend!.invoke(channel, JSON.stringify(resolved))
      return JSON.parse(json)
    }
    // Audio export: the TS actor owns state, so inject the full project here
    // and forward it — the Rust fns take it as a call argument.
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
    (e, a: { streamId: string; path: string; poolSize: number; colorSpace: Electron.ColorSpace; codedWidth: number; codedHeight: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? mainWindow
      if (!win) throw new Error('previewGpu:open — no window for sender')
      return openPreviewGpu(
        ndBackend(),
        win,
        a.streamId,
        a.path,
        a.poolSize,
        a.colorSpace,
        a.codedWidth,
        a.codedHeight,
      )
    },
  )
  ipcMain.handle('previewGpu:requestFrameAt', (_e, a: { streamId: string; targetUs: number }) =>
    requestFrameAtPreviewGpu(ndBackend(), a.streamId, a.targetUs),
  )
  ipcMain.handle('previewGpu:consumeAck', (_e, a: { streamId: string; slot: number; gen: number }) => {
    // Record the round-trip at handler entry (t_ack_received) BEFORE forwarding.
    recordConsumeAck(a.streamId, a.slot, performance.now())
    return consumeAckPreviewGpu(ndBackend(), a.streamId, a.slot, a.gen)
  })
  ipcMain.handle('previewGpu:close', (_e, a: { streamId: string }) => closePreviewGpu(ndBackend(), a.streamId))
  // Read-only budget probe: no `ndBackend()`, so it answers on every platform,
  // including the ones where the addon's previewGpu* methods throw.
  ipcMain.handle('previewGpu:budget', () => hwBudget())
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

  // Machine capability probe: runs the SW one-frame decode probe,
  // derives the format-class key from what it learned, and consults/updates the
  // per-machine cache above. KNOWN LIMITATION: previewSwProbe is SYNCHRONOUS and
  // UNINTERRUPTIBLE — it blocks the main thread until the one-frame decode
  // finishes. Acceptable because it only ever runs on import-vetted local media
  // (ffprobe'd at import time), so practical hang risk is low; no interrupt
  // callback exists.
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

  // Machine capability probe: resolves the best HW decode lane for a
  // caller-supplied classKey. Unlike the SW probe, the HW probe doesn't derive
  // the class key itself — it's expensive enough that the renderer computes
  // classKey from MediaSummary BEFORE deciding to probe, so an already-cached
  // verdict never pays for a decode. envKey is GPU identity
  // (vendor/device/driver): a driver update or GPU swap invalidates every cached
  // HW verdict for this machine. `resolveHwLane` walks the component's ADVERTISED
  // lanes (`nd.lanes`) in HW_LANE_PRIORITY order (NVDEC > VAAPI > d3d11va >
  // videotoolbox — only one platform's lanes are ever advertised), per DRM node
  // for VAAPI, and falls back to software when none pass — so a build without a
  // HW lane (Linux SW-only) never reaches a native probe, no platform
  // special-casing.
  ipcMain.handle('decodeCap:probeHw', async (_e, a: { path: string; classKey: string }) => {
    // E2E/bench lane pin: the lane-parameterized preview-hw conformance spec
    // sets WEFTCUT_FORCE_HW_LANE so ONE variant tests exactly one HW lane on a
    // multi-lane machine. When set, hide every advertised HW lane except the
    // forced one (keep `software` so the resolver's SW fallback is intact), which
    // pins `resolveHwLane` to that single lane instead of the normal NVDEC>VAAPI
    // priority walk. Forcing a lane the addon never advertised (e.g. `vaapi` on a
    // box whose libva can't copy-back) leaves no candidate → software fallback —
    // exactly the clean-skip the e2e wants. Absent = normal priority walk.
    const forcedHwLane = process.env.WEFTCUT_FORCE_HW_LANE
    const advertisedLanes = forcedHwLane
      ? nd.lanes.filter((l) => l === forcedHwLane || l === 'software')
      : nd.lanes
    const r = await resolveHwLane({
      lanes: advertisedLanes,
      store: decodeCapability,
      classKey: a.classKey,
      envKey: () => hwEnvKey(),
      devices: (lane) => (lane === 'vaapi' ? enumerateDrmRenderNodes() : [null]),
      probe: (lane, device) => {
        // Each advertised lane routes to its native one-frame probe: d3d11va to
        // previewGpuProbe (Windows), the copy-back lanes — NVDEC/VAAPI (Linux)
        // and VideoToolbox (macOS, issue #10) — to previewHwProbe (which takes
        // the DRM node as `device` — null for NVDEC/videotoolbox). resolveHwLane
        // only probes ADVERTISED lanes, so `lane not built` is inert (an
        // unadvertised lane never reaches here).
        if (lane === 'd3d11va') {
          const v = ndBackend().previewGpuProbe(a.path, 4000)
          return { ok: v.ok, reason: v.reason ?? null }
        }
        if (lane === 'nvdec' || lane === 'vaapi' || lane === 'videotoolbox') {
          const v = ndBackend().previewHwProbe(a.path, lane, device, 4000)
          return { ok: v.ok, reason: v.reason ?? null }
        }
        return { ok: false, reason: 'lane not built' }
      },
    })
    return { ok: r.ok, reason: r.reason, lane: r.lane, device: r.device }
  })

  // Native SOFTWARE-decode preview (ProRes/DNxHD/MPEG-2/VC-1 — the
  // WebCodecs-blind-format path). Frames flow out of band on the dedicated
  // `previewSw:frame` channel (see ./previewSw), not through the generic
  // `evt:*` EventSink relay above.
  ipcMain.handle('previewSw:open', (e, a: { streamId: string; path: string; lane?: string | null; device?: string | null; scaleDiv?: number | null; cadenceDiv?: number | null; outFormat?: string | null }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('previewSw:open — no window for sender')
    return openPreviewSw(ndBackend(), win, a.streamId, a.path, a.lane ?? null, a.device ?? null, a.scaleDiv ?? null, a.cadenceDiv ?? null, a.outFormat ?? null)
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

  // Native SOFTWARE export-decode (blind-spot originals) — the EXPORT-side
  // mirror of previewSw + the reverse of the encode chunk channel. Everything
  // flows on the one dedicated `exportSw:msg` channel (see ./exportSw and
  // `ExportSwMsg` in shared/ipc — never split it); nothing exportSw rides the
  // generic `evt:*` relay.
  ipcMain.handle('exportSw:open', (e, a: { sessionId: string; path: string; outFormat: 'NV12' | 'I420P10'; creditWindow: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('exportSw:open — no window for sender')
    return openExportSw(ndBackend(), win, a.sessionId, a.path, a.outFormat, a.creditWindow)
  })
  ipcMain.on('exportSw:decodeRange', (_e, a: { sessionId: string; aUs: number; bUs: number }) => {
    // Fire-and-forget .on: napi can throw Err (unknown/already-closed sessionId
    // from a renderer race), which as a .on listener would be an uncaught main
    // exception. Swallow (matches previewSw:requestFrameAt).
    try { decodeRangeExportSw(ndBackend(), a.sessionId, a.aUs, a.bUs) }
    catch (e) { console.warn('[main] exportSw:decodeRange failed', e) }
  })
  ipcMain.on('exportSw:returnCredit', (_e, a: { sessionId: string; credits: number }) => {
    try { returnCreditExportSw(ndBackend(), a.sessionId, a.credits) }
    catch (e) { console.warn('[main] exportSw:returnCredit failed', e) }
  })
  ipcMain.on('exportSw:close', (_e, a: { sessionId: string }) => {
    try { closeExportSw(ndBackend(), a.sessionId) }
    catch (e) { console.warn('[main] exportSw:close failed', e) }
  })
  // Reap every still-open export session at export end (done / error / cancel).
  // A Worker terminated mid-teardown may never send its per-session close, so
  // the renderer signals main to close them directly — else the native decode
  // threads leak. Idempotent; no-ops when nothing is open.
  ipcMain.on('exportSw:closeAll', () => {
    try { closeAllExportSw(ndBackend()) }
    catch (e) { console.warn('[main] exportSw:closeAll failed', e) }
  })

  // Secondary windows (Dev Performance Monitor etc.) via win:* IPC.
  ipcMain.handle('win:create', (_e, { label, options }: { label: string; options?: SecondaryWinOpts }) => createSecondary(label, options))
  ipcMain.handle('win:act', (_e, { label, action }: { label: string; action: 'show' | 'hide' | 'close' | 'center' | 'focus' }) => actOnSecondary(label, action))
  ipcMain.handle('win:exists', (_e, { label }: { label: string }) => secondaryExists(label))

  // Drag-drop import: the renderer resolves real paths via webUtils and posts
  // them here; we re-emit the SAME `media:external-drop` event the renderer's
  // existing listener already handles.
  ipcMain.handle('media:dropped', (_e, paths: string[]) => {
    if (Array.isArray(paths) && paths.length > 0) {
      emitToRenderer('media:external-drop', paths)
    }
  })

  // Caption-button controls act on the SENDER's window, not always mainWindow:
  // secondary windows (the Performance Monitor) render the same <WindowControls/>, so
  // their close/min/max must target themselves — otherwise the monitor's close
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
  // Path opens go through openPathRobust (see openPath.ts: Electron's
  // shell.openPath can wedge the launched GTK app on Linux).
  ipcMain.handle('shell:open', async (_e, { target }: { target: string }) => {
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target)
    } else {
      const err = await openPathRobust(target)
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
  // main window streaming on-demand telemetry to the Performance Monitor).
  ipcMain.handle('app:emit', (_e, { event, payload }: { event: string; payload?: unknown }) => {
    broadcastEvent(BrowserWindow.getAllWindows(), event, payload)
  })

  // Performance Monitor snapshot — see metrics.ts.
  ipcMain.handle('app:metrics', () => collectMetrics(app.getAppMetrics(), os.cpus().length))

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

  // dataRoot:* — user-managed data location. The migration COPY runs
  // here in main via node:fs directly (it does NOT pass through the fs:* guard),
  // so the copy destination needs no guard admission; the resolved dataRoot is
  // already an fsRoots() root. `migrationFs` is the node:fs adapter
  // for the pure, fs-injected core (dataRootMigration.ts).
  const migrationFs: MigrationFs = {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
    readDir: (p) => { try { return fs.readdirSync(p) } catch { return [] } },
    readFileText: (p) => fs.readFileSync(p, 'utf8'),
    fileSize: (p) => { try { return fs.statSync(p).size } catch { return 0 } },
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }) },
    copyFile: (s, d) => { fs.copyFileSync(s, d) },
    writeFile: (p, t) => { fs.writeFileSync(p, t, 'utf8') },
    rm: (p) => { fs.rmSync(p, { recursive: true, force: true }) },
  }
  // The delete-old marker lives in userData (NOT under any data root, so it
  // survives the root switch across the relaunch). The default data dir is the
  // resolver's `<userData>/data` — used to decide whether deleteOld removes the
  // whole old dir or just its buckets.
  const migrationMarkerPath = path.join(app.getPath('userData'), 'data-root-migration.json')
  const defaultDataDir = path.join(app.getPath('userData'), 'data')

  // Effective root + whether it's a fallback (configured but not honored). The
  // resolver never falls back silently today, so isFallback is effectively always
  // false; derived by comparing the resolved root to the configured `data_root`.
  ipcMain.handle('dataRoot:current', () => {
    const configured = appSettings.get().data_root?.trim()
    const isFallback = !!configured && path.resolve(configured) !== path.resolve(dataRoot.dataRoot)
    return { path: dataRoot.dataRoot, isFallback }
  })

  // Pick a new folder → plan → (copy+verify OR adopt), emitting progress. On
  // success: write data_root + the pending-delete marker, return ready-to-
  // relaunch (does NOT relaunch — the renderer times that via dataRoot:relaunch).
  // On failure: roll back the new root and return the error (data_root unchanged).
  ipcMain.handle('dataRoot:pickAndMigrate', async (): Promise<DataRootMigrateResult> => {
    const zh = app.getLocale().toLowerCase().startsWith('zh')
    const picked = dialog.showOpenDialogSync(mainWindow!, {
      title: zh ? '选择新的数据文件夹' : 'Choose a new data folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (!picked || picked.length === 0) return { ok: false, cancelled: true }

    const oldRoot = dataRoot.dataRoot
    const newRoot = path.resolve(picked[0])
    const emit = (p: DataRootProgress): void => { emitToRenderer('dataRoot:progress', p) }

    try {
      const plan = planMigration(oldRoot, newRoot, migrationFs, path.join) // throws on nested/same
      if (plan.mode === 'copy') {
        const { createdPaths } = runCopy(oldRoot, newRoot, migrationFs, path.join, emit)
        const result = verify(oldRoot, newRoot, migrationFs, path.join)
        if (!result.ok) {
          rollback(newRoot, migrationFs, createdPaths)
          return { ok: false, error: `verify failed: ${result.mismatches.join('; ')}` }
        }
      }
      // Success — repoint data_root. (Order: settings first so a crash before
      // relaunch still boots onto the new root; the marker below is only a hint.)
      appSettings.apply({ data_root: newRoot })
      // Record the old copy for post-relaunch deletion ONLY in copy mode: there
      // the new root is a verified COPY of the old, so the old is a redundant
      // copy safe to offer for deletion. In ADOPT mode nothing was copied — the
      // old root is the user's separate, previous library, NOT a copy — so we do
      // NOT offer to delete it (that would be net data loss, not cleanup). They
      // can remove it manually if they want.
      if (plan.mode === 'copy') {
        writeMarker(migrationMarkerPath, { oldPath: oldRoot, newPath: newRoot, status: 'pending-delete' }, migrationFs)
      }
      emit({ phase: 'done', copiedFiles: 0, totalFiles: 0 })
      return { ok: true, mode: plan.mode, newPath: newRoot }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Apply a completed migration: relaunch onto the newly-written data root.
  // Separate channel so the renderer can show success first, then relaunch.
  ipcMain.handle('dataRoot:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  // Reveal the effective data root in the OS file manager. Goes through
  // openPathRobust: Electron's shell.openPath can wedge the launched file
  // manager on Linux (see openPath.ts).
  ipcMain.handle('dataRoot:openFolder', async () => {
    const err = await openPathRobust(dataRoot.dataRoot)
    if (err) throw new Error(err)
  })

  // Post-relaunch: the old copy awaiting deletion — but ONLY when we actually
  // rebooted onto the marker's newPath (i.e. the migration succeeded and this
  // process is running on it). Otherwise the reboot didn't land on the new root
  // and nothing should be offered for deletion.
  ipcMain.handle('dataRoot:pendingCleanup', () => {
    const marker = readMarker(migrationMarkerPath, migrationFs)
    if (!marker) return null
    if (path.resolve(marker.newPath) !== path.resolve(dataRoot.dataRoot)) return null
    return { oldPath: marker.oldPath }
  })

  // Delete the old copy recorded by the marker, then clear it. NEVER auto-called
  // — only on explicit user confirm from the UI. Idempotent (a crash mid-delete
  // leaves the marker so this can be retried).
  ipcMain.handle('dataRoot:deleteOld', () => {
    const marker = readMarker(migrationMarkerPath, migrationFs)
    if (!marker) return
    deleteOldCopy(marker.oldPath, defaultDataDir, migrationFs, path.join)
    clearMarker(migrationMarkerPath, migrationFs)
  })

  // Dismiss the delete-old prompt WITHOUT deleting: the user keeps the old copy
  // on disk (to remove manually later). Clears the marker so this is a one-time
  // prompt rather than a nag on every launch. Non-destructive.
  ipcMain.handle('dataRoot:dismissCleanup', () => {
    clearMarker(migrationMarkerPath, migrationFs)
  })

  // fs:* — direct main-process filesystem access for the renderer (write/append/
  // read/remove/readDir). Confined to APP-MANAGED roots: the OS temp dir (export
  // scratch), userData (small config/state), the data root (backend cache +
  // Motifs, possibly outside userData), and the active workspace. The
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
    // `dataRoot` is resolved earlier in this same whenReady closure (before the
    // Backend/UserMotifStore), so it is in scope here. The backend media cache +
    // user Motifs now live under it (possibly outside userData), so it must be
    // an explicitly allowed root.
    const roots = [app.getPath('temp'), app.getPath('userData'), dataRoot.dataRoot]
    if (cachedWorkspace) roots.push(cachedWorkspace)
    return roots
  }
  // Resolve `p` and assert it sits under an allowed root, else throw. Static
  // roots (temp/userData/dataRoot) are checked first with no backend round-trip;
  // only a miss re-queries the workspace (it may have just opened) and retries —
  // so the hot path (export temp appends) never touches the backend.
  const guardFsPath = async (p: string): Promise<string> => {
    const abs = path.resolve(p)
    if (isAllowed(abs, fsRoots())) return abs
    await refreshWorkspace()
    if (isAllowed(abs, fsRoots())) return abs
    throw new Error(`fs access denied: ${abs} is outside the allowed roots (temp, userData, data root, workspace)`)
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

  // Native IPC video-sink write. Binary frame in (ArrayBuffer/typed array),
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
// A null tsHost early-returns: nothing to flush before whenReady constructs the host.
let quitFlushed = false
app.on('before-quit', (event) => {
  motifWatcher?.close(); motifWatcher = null
  // Flush the debounced Workspace-layout write synchronously — an arrangement
  // change made inside the debounce window would otherwise be dropped on quit.
  workspaceStore?.flush()
  // Same for window geometry. The window's own `close` handler also flushes
  // (covering macOS ⌘W, which never quits); this covers quitting via the app
  // menu / Cmd+Q, where before-quit precedes the window close.
  windowGeometryStore?.flush()
  if (quitFlushed || !tsHost) return
  event.preventDefault()
  quitFlushed = true
  void tsHost
    .handleInvoke('project_save', {})
    .catch((e) => console.warn('[main] autosave quit-flush failed', e))
    .finally(() => app.quit())
})
