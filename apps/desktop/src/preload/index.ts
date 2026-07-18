import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron'
import type { SharedTextureImported } from 'electron'
import type {
  WeftcutApi,
  AppNotice,
  DecodeCapabilityProbeResult,
  DecodeComponentStatus,
  DecodeHwProbeResult,
  DialogOpenOpts,
  DialogSaveOpts,
  DirEntry,
  NotificationOpts,
  PreviewGpuColorSpace,
  PreviewGpuMainTiming,
  PreviewGpuOpenReply,
  PreviewGpuTimingReport,
  PreviewSwFrameMsg,
  ExportSwMsg,
  ExportSwOpenReply,
  SystemStats,
  WinCreateOpts,
  WinAction,
} from '../shared/ipc'

type Listener = (payload: unknown) => void

// The contextBridge surface — the COMPLETE set of things the (untrusted)
// renderer can ask the main process to do. Grouped, named methods rather than a
// generic `invoke(channel)` passthrough: a compromised renderer can only reach
// these specific operations, and the IPC surface is auditable at a glance
// (Electron security guidance: expose APIs, not channels). The one generic
// channel is `backend.invoke`, which fronts the napi/Rust command dispatcher —
// a single controlled capability that validates its own commands.
const api: WeftcutApi = {
  backend: {
    invoke(channel: string, args?: unknown): Promise<unknown> {
      return ipcRenderer.invoke('backend:invoke', { channel, args })
    },
  },

  fs: {
    writeFile(path: string, data: Uint8Array, append?: boolean): Promise<void> {
      return ipcRenderer.invoke('fs:writeFile', { path, data, append }) as Promise<void>
    },
    writeTextFile(path: string, data: string): Promise<void> {
      return ipcRenderer.invoke('fs:writeTextFile', { path, data }) as Promise<void>
    },
    mkdir(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('fs:mkdir', { path, recursive }) as Promise<void>
    },
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
      return ipcRenderer.invoke('fs:readFile', { path }) as Promise<Uint8Array<ArrayBuffer>>
    },
    remove(path: string): Promise<void> {
      return ipcRenderer.invoke('fs:remove', { path }) as Promise<void>
    },
    exists(path: string): Promise<boolean> {
      return ipcRenderer.invoke('fs:exists', { path }) as Promise<boolean>
    },
    readDir(path: string): Promise<DirEntry[]> {
      return ipcRenderer.invoke('fs:readDir', { path }) as Promise<DirEntry[]>
    },
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize') as Promise<void>,
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize') as Promise<void>,
    close: (): Promise<void> => ipcRenderer.invoke('window:close') as Promise<void>,
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
    setTitle: (title: string): Promise<void> => ipcRenderer.invoke('window:setTitle', title) as Promise<void>,
    captureSnapshot: (): Promise<Uint8Array<ArrayBuffer>> =>
      ipcRenderer.invoke('window:captureSnapshot') as Promise<Uint8Array<ArrayBuffer>>,
    focus: (): Promise<void> => ipcRenderer.invoke('window:focus') as Promise<void>,
  },

  dialog: {
    open(opts: DialogOpenOpts): Promise<string | string[] | null> {
      return ipcRenderer.invoke('dialog:open', opts) as Promise<string | string[] | null>
    },
    save(opts: DialogSaveOpts): Promise<string | null> {
      return ipcRenderer.invoke('dialog:save', opts) as Promise<string | null>
    },
  },

  path: {
    documentDir: (): Promise<string> => ipcRenderer.invoke('path:documentDir') as Promise<string>,
    join: (parts: string[]): Promise<string> => ipcRenderer.invoke('path:join', { parts }) as Promise<string>,
    tempDir: (): Promise<string> => ipcRenderer.invoke('path:tempDir') as Promise<string>,
  },

  mcp: {
    getInfo: (): Promise<unknown> => ipcRenderer.invoke('get_mcp_info'),
    resetToken: (): Promise<unknown> => ipcRenderer.invoke('reset_mcp_token'),
  },

  win: {
    create: (label: string, options?: WinCreateOpts): Promise<void> =>
      ipcRenderer.invoke('win:create', { label, options }) as Promise<void>,
    act: (label: string, action: WinAction): Promise<void> =>
      ipcRenderer.invoke('win:act', { label, action }) as Promise<void>,
    exists: (label: string): Promise<boolean> => ipcRenderer.invoke('win:exists', { label }) as Promise<boolean>,
  },

  media: {
    dropped: (paths: string[]): Promise<void> => ipcRenderer.invoke('media:dropped', paths) as Promise<void>,
  },

  app: {
    notices: (): Promise<AppNotice[]> => ipcRenderer.invoke('app:notices') as Promise<AppNotice[]>,
  },

  // OS shell + desktop notification — native main-process concerns, handled by
  // Electron directly (no Rust round-trip; the Rust dispatcher owns project
  // state, not the OS shell).
  shell: {
    open: (target: string): Promise<void> => ipcRenderer.invoke('shell:open', { target }) as Promise<void>,
  },
  notification: {
    send: (opts: NotificationOpts): Promise<void> => ipcRenderer.invoke('notification:send', opts) as Promise<void>,
  },
  metrics: {
    get: (): Promise<SystemStats> => ipcRenderer.invoke('app:metrics') as Promise<SystemStats>,
  },
  font: {
    resolve: (family: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke('font:resolve', { family }) as Promise<Uint8Array | null>,
  },

  // Event subscription: main relays core events via webContents.send →
  // `evt:<event>` → here.
  on(event: string, cb: Listener): () => void {
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(`evt:${event}`, handler)
    return () => ipcRenderer.removeListener(`evt:${event}`, handler)
  },
  off(event: string): void {
    ipcRenderer.removeAllListeners(`evt:${event}`)
  },

  // Cross-window broadcast: forward an event to main, which re-sends it as
  // `evt:<event>` to every window (delivered above via `on()`).
  emit(event: string, payload?: unknown): Promise<void> {
    return ipcRenderer.invoke('app:emit', { event, payload }) as Promise<void>
  },

  // Stream one raw frame to the native video sink over IPC (the Electron-native
  // alternative to the loopback WebSocket transport).
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void> {
    return ipcRenderer.invoke('export:videosink_write', bytes) as Promise<void>
  },

  // Native GPU-decode preview (Windows). The three session commands are plain
  // ipcRenderer.invoke wrappers; the decoded frames themselves flow OUT of band
  // over a MessagePort (see requestPort + the frameReady loop below) because a
  // MessagePort/ImageBitmap can't be handed across the contextBridge. consumeAck
  // is NOT exposed — it's fired preload-side, after createImageBitmap resolves.
  previewGpu: {
    open(args: { streamId: string; path: string; poolSize: number; colorSpace: PreviewGpuColorSpace }): Promise<PreviewGpuOpenReply> {
      return ipcRenderer.invoke('previewGpu:open', args) as Promise<PreviewGpuOpenReply>
    },
    requestFrameAt(args: { streamId: string; targetUs: number }): Promise<void> {
      return ipcRenderer.invoke('previewGpu:requestFrameAt', args) as Promise<void>
    },
    close(args: { streamId: string }): Promise<void> {
      return closePreviewGpuStream(args.streamId)
    },
    // Hand a MessagePort to the main world so it can receive decoded frames.
    // A contextBridge function MAY be called from the main world and MAY itself
    // call window.postMessage with a transfer list (only PASSING a port
    // as a bridge ARGUMENT fails). The renderer attaches its `message` listener
    // BEFORE calling this, then grabs `ev.ports[0]`.
    requestPort(): void {
      const ch = new MessageChannel()
      mainPort = ch.port1
      window.postMessage({ __weftcutPreviewGpu: 'port' }, '*', [ch.port2])
    },
    takeTimings(streamId: string): Promise<PreviewGpuTimingReport> {
      return ipcRenderer.invoke('previewGpu:takeTimings', { streamId }) as Promise<PreviewGpuTimingReport>
    },
    takeMainTimings(): Promise<PreviewGpuMainTiming> {
      return ipcRenderer.invoke('previewGpu:takeMainTimings') as Promise<PreviewGpuMainTiming>
    },
  },

  // Native SOFTWARE-decode preview (ProRes/DNxHD/MPEG-2/VC-1 — the
  // WebCodecs-blind-format path). Unlike previewGpu, decoded NV12 frames DO
  // cross the contextBridge directly — no shared texture / MessagePort dance —
  // arriving on the dedicated `previewSw:frame` channel (NOT the generic
  // `evt:*` EventSink relay), so `onFrame` subscribes to that channel directly.
  previewSw: {
    open(args: { streamId: string; path: string; lane?: string | null; device?: string | null }): Promise<{ width: number; height: number }> {
      return ipcRenderer.invoke('previewSw:open', args) as Promise<{ width: number; height: number }>
    },
    requestFrameAt(args: { streamId: string; targetUs: number }): void {
      ipcRenderer.send('previewSw:requestFrameAt', args)
    },
    close(args: { streamId: string }): void {
      ipcRenderer.send('previewSw:close', args)
    },
    onFrame(cb: (f: PreviewSwFrameMsg) => void): () => void {
      const h = (_e: unknown, f: PreviewSwFrameMsg) => cb(f)
      ipcRenderer.on('previewSw:frame', h)
      return () => { ipcRenderer.removeListener('previewSw:frame', h) }
    },
  },

  // Native SOFTWARE export-decode relay — the EXPORT-side mirror of previewSw.
  // Frames AND control signals (rangeEnd/ended/error) cross the contextBridge
  // as tagged ExportSwMsgs on the ONE dedicated `exportSw:msg` channel
  // (surfaced via `onMsg`); the renderer main thread is a pure relay to the
  // export Worker. The single ordered channel is load-bearing: control can
  // never overtake frames (see ExportSwMsg in shared/ipc.ts) — never split it.
  // `decodeRange` / `returnCredit` / `close` are fire-and-forget renderer →
  // main commands.
  exportSw: {
    open(args: { sessionId: string; path: string; outFormat: 'NV12' | 'I420P10'; creditWindow: number }): Promise<ExportSwOpenReply> {
      return ipcRenderer.invoke('exportSw:open', args) as Promise<ExportSwOpenReply>
    },
    decodeRange(args: { sessionId: string; aUs: number; bUs: number }): void {
      ipcRenderer.send('exportSw:decodeRange', args)
    },
    returnCredit(args: { sessionId: string; credits: number }): void {
      ipcRenderer.send('exportSw:returnCredit', args)
    },
    close(args: { sessionId: string }): void {
      ipcRenderer.send('exportSw:close', args)
    },
    closeAll(): void {
      ipcRenderer.send('exportSw:closeAll')
    },
    onMsg(cb: (m: ExportSwMsg) => void): () => void {
      const h = (_e: unknown, m: ExportSwMsg) => cb(m)
      ipcRenderer.on('exportSw:msg', h)
      return () => { ipcRenderer.removeListener('exportSw:msg', h) }
    },
  },

  // Availability of the optional native-decode component (level-0 gate). Pulled
  // once on mount by the renderer's decodeComponentStore.
  decodeComponent: {
    status: () => ipcRenderer.invoke('decodeComponent:status') as Promise<DecodeComponentStatus>,
  },

  // Machine capability probe: runs the SW decode probe + consults the
  // per-machine capability cache for the probed file's format class.
  // probeHw is the GPU-keyed HW-lane counterpart — caller supplies the
  // classKey (the renderer derives it from MediaSummary).
  decodeCap: {
    probeSw: (path: string) =>
      ipcRenderer.invoke('decodeCap:probeSw', { path }) as Promise<DecodeCapabilityProbeResult>,
    probeHw: (path: string, classKey: string) =>
      ipcRenderer.invoke('decodeCap:probeHw', { path, classKey }) as Promise<DecodeHwProbeResult>,
  },
}

// ---------------------------------------------------------------------------
// Native GPU-decode preview receiver (Windows). This wiring lives in the
// isolated preload world — the ONLY world where setSharedTextureReceiver is
// available and where the imported textures land. It bridges
// received frames to the renderer main world over a MessagePort.
// ---------------------------------------------------------------------------

// The imported shared texture for each pool slot, keyed `${streamId}:${slot}`.
// Populated once per slot at open by pairing the receiver callbacks (which carry
// no slot id) to `previewGpu:slot` announces in FIFO order.
const importedByKey = new Map<string, SharedTextureImported>()
// Slot announces awaiting their receiver callback. Main sends one announce
// immediately before each slot's sendSharedTexture, so the announce is enqueued
// here before the receiver fires for that slot — pair by shift() (FIFO).
const announceQueue: { streamId: string; slot: number }[] = []
// The renderer-main-world end of the frame channel, set by requestPort().
let mainPort: MessagePort | null = null

// Tear down a session from the PRELOAD side. Electron only frees a shared
// texture's GPU pool slot once EVERY import of it is released — main's
// closePreviewGpu releases its own (persistent, per-slot) imports, but the
// copy this preload holds in `importedByKey` (from setSharedTextureReceiver)
// is a SEPARATE import that only the preload can release. Skipping this leaks
// a whole NV12 pool per open/close cycle (decode-bench opens/closes a session
// per source, so this compounds into GPU OOM across a run).
// Ordering: release the preload's own imports and prune this stream's
// announce-queue entries BEFORE awaiting the main-process close, not after.
// The renderer handle nulls its side synchronously on dispose, but a
// `frameReady` poke can still be in flight; if it lands while this function
// is awaiting the invoke, it must find `importedByKey` already empty for this
// stream so the handler's `if (!imp || !mainPort) return` guard short-circuits
// it — otherwise it snapshots a bitmap onto a gone consumer (leaked, never
// closed) and fires a consumeAck against a session main is mid-closing.
// Clearing first also means this cleanup no longer depends on the invoke's
// outcome, so there's nothing left to strand if it rejects (main's close is
// idempotent and could still reject for an unrelated reason) — a plain
// sequential await is enough, no try/finally required.
async function closePreviewGpuStream(streamId: string): Promise<void> {
  const prefix = `${streamId}:`
  for (const [key, imp] of importedByKey) {
    if (key.startsWith(prefix)) {
      imp.release()
      importedByKey.delete(key)
    }
  }
  for (let i = announceQueue.length - 1; i >= 0; i--) {
    if (announceQueue[i].streamId === streamId) announceQueue.splice(i, 1)
  }
  await (ipcRenderer.invoke('previewGpu:close', { streamId }) as Promise<void>)
}

// Slot-correlation announce: enqueue; the next receiver callback claims it.
ipcRenderer.on('evt:previewGpu:slot', (_e, { streamId, slot }: { streamId: string; slot: number }) => {
  announceQueue.push({ streamId, slot })
})

// Register the receiver ONCE at preload load. Each callback = one slot's texture
// arriving from main; pair it FIFO to the announce enqueued just before its send.
sharedTexture.setSharedTextureReceiver(async (data) => {
  const a = announceQueue.shift()
  if (a) importedByKey.set(`${a.streamId}:${a.slot}`, data.importedSharedTexture)
})

// Cross-device read-completion barrier (native-hw frame-REORDER fix).
//
// The shared NV12 slot texture is overwritten IN PLACE by the native decode
// thread — on ffmpeg's OWN D3D11 device — as soon as the slot is `consumeAck`ed.
// Chromium reads that texture (getVideoFrame → createImageBitmap) on the
// SEPARATE GPU-process device. Unlike a same-process WebCodecs VideoFrame (whose
// buffer Chromium won't recycle until its own createImageBitmap copy completes),
// Chromium CANNOT track this cross-device write dependency, and
// `await createImageBitmap` resolves before its read has actually GPU-completed.
// So acking right after the await frees the slot while the read is still in
// flight; the producer then overwrites it with the frame POOL_SIZE ahead, and
// the ImageBitmap captures the wrong frame's pixels tagged with this frame's PTS
// (observed: decoded index = expected + pool_size). The ring self-sorts by PTS,
// so this surfaces as out-of-order playback, not tearing.
//
// Fix: before acking, rasterize a 1px sample of the bitmap. `getImageData`
// forces Chromium to materialize the createImageBitmap copy — a GPU dependency
// it must block on — which cannot resolve until the source-texture read has
// landed. Once this returns, the read is done, so the slot is safe to recycle.
// One reused 1×1 canvas; the readback is a pipeline flush, not a frame-sized
// transfer.
let readBarrierCtx: OffscreenCanvasRenderingContext2D | null | undefined
function forceSharedTextureReadComplete(bmp: ImageBitmap): void {
  if (readBarrierCtx === undefined) {
    readBarrierCtx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
  }
  if (!readBarrierCtx) return // no 2D context available — barrier unavailable
  readBarrierCtx.drawImage(bmp, 0, 0, 1, 1)
  readBarrierCtx.getImageData(0, 0, 1, 1)
}

// Per-frame loop — this is where the ACK-AFTER-READ discipline lives. On a
// frameReady poke: snapshot the slot's shared texture into an ImageBitmap, post
// it to the main world over the MessagePort, and ONLY THEN consumeAck. The ack
// must fire after the snapshot's cross-device read has GPU-COMPLETED (forced by
// `forceSharedTextureReadComplete` — `createImageBitmap` resolving is NOT that
// guarantee across devices, see above), so native may safely reuse the slot.
// Acking earlier lets native overwrite the slot mid-read (reorder/tearing).
// Native's AcquireSync on a still-held slot now times out (finite, Error-poke +
// skip) rather than hanging, but an early ack would still corrupt a frame, so
// the ordering stays load-bearing.
//
// The ack must ALSO fire if createImageBitmap (or the port post) throws — once
// getVideoFrame() has been called, the slot is spoken for, and vf.close() in
// the inner finally already releases the GPU hold regardless of outcome. So
// skipping the ack on failure would strand the slot until native's finite
// AcquireSync times out and skips it — an avoidable dropped frame, not a hang.
// Report the failure to the main world too, matching the eof/error relay below.
ipcRenderer.on(
  'evt:previewGpu:frameReady',
  async (_e, { streamId, slot, ptsUs, durUs }: { streamId: string; slot: number; ptsUs: number; durUs: number }) => {
    const imp = importedByKey.get(`${streamId}:${slot}`)
    // Snapshot mainPort into a const so its non-null narrowing survives the await
    // below (a module-scoped `let` re-widens across await points).
    const port = mainPort
    if (!imp || !port) return
    const tEntry = performance.now()
    try {
      let bmp: ImageBitmap
      let gvfMs = 0
      let cibMs = 0
      // getVideoFrame() lives INSIDE the try: once it's called the slot is
      // spoken for, so any failure from here on (including getVideoFrame
      // itself throwing) must still reach the single consumeAck below — the
      // same stranded-slot failure mode the ack-on-error fix closed. vf stays
      // undefined (and its close guarded) if getVideoFrame throws.
      let vf: VideoFrame | undefined
      try {
        const tGvf = performance.now()
        vf = imp.getVideoFrame()
        gvfMs = performance.now() - tGvf
        const tCib = performance.now()
        bmp = await createImageBitmap(vf)
        cibMs = performance.now() - tCib
      } finally {
        vf?.close?.()
      }
      // Barrier: block until Chromium's cross-device read of the slot texture
      // into `bmp` has GPU-completed, BEFORE the outer finally's consumeAck
      // frees the slot for the producer to overwrite. Without this the native-hw
      // lane presents frames pool_size out of order (see the block comment).
      forceSharedTextureReadComplete(bmp)
      const residentMs = performance.now() - tEntry
      port.postMessage({ kind: 'frame', streamId, slot, ptsUs, durUs, bitmap: bmp, gvfMs, cibMs, residentMs }, [bmp])
    } catch (err) {
      port.postMessage({ kind: 'error', streamId, message: err instanceof Error ? err.message : String(err) })
    } finally {
      // AFTER the snapshot attempt (success or failure) — release the slot back
      // to the native pool. Swallow a rejection: if a dispose raced this poke
      // and closed the session first, the ack lands on an already-closed
      // session and napi rejects — that's expected, not an error to surface.
      void ipcRenderer.invoke('previewGpu:consumeAck', { streamId, slot }).catch(() => {})
    }
  },
)

// End-of-stream / error pokes → forward to the main world over the same port.
ipcRenderer.on('evt:previewGpu:eof', (_e, { streamId }: { streamId: string }) => {
  mainPort?.postMessage({ kind: 'eof', streamId })
})
ipcRenderer.on('evt:previewGpu:error', (_e, { streamId, message }: { streamId: string; message: string }) => {
  mainPort?.postMessage({ kind: 'error', streamId, message })
})

contextBridge.exposeInMainWorld('api', api)

// Resolve drag-drop file paths in the preload's own drop listener.
// Background: in Electron 30+, a File passed across the contextBridge loses its
// disk-backing, so webUtils.getPathForFile() returns '' when called from the
// renderer side (electron/electron#44600). The fix is to intercept drop events
// here in the preload where the File objects are still native-backed.
function wireFileDrop(): void {
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    if (!(e.target instanceof Element && e.target.closest('.media-pool'))) return
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .flatMap((f) => {
        try {
          const path = webUtils.getPathForFile(f)
          return path.length > 0 ? [path] : []
        } catch {
          return []
        }
      })
    if (paths.length > 0) void ipcRenderer.invoke('media:dropped', paths)
  })
}
wireFileDrop()

// Frameless-window drag regions. The renderer marks its titlebars with the
// `data-drag-region` attribute; Electron doesn't treat it as draggable on its
// own — it uses the CSS `-webkit-app-region` property. Bridge the two by
// injecting a stylesheet
// (interactive descendants get `no-drag` so window controls / buttons stay
// clickable).
function injectDragRegionStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    [data-drag-region] { -webkit-app-region: drag; }
    [data-drag-region] :where(button, a, input, select, textarea, [role="button"], [contenteditable]) { -webkit-app-region: no-drag; }
  `
  document.head.appendChild(style)
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDragRegionStyles)
} else {
  injectDragRegionStyles()
}
