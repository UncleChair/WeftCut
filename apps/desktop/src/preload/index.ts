import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron'
import type { SharedTextureImported } from 'electron'
import type {
  WeftcutApi,
  AppNotice,
  AppVersions,
  DecodeCapabilityProbeResult,
  DecodeComponentStatus,
  DecodeHwProbeResult,
  DialogOpenOpts,
  DialogSaveOpts,
  DirEntry,
  HwBarrierMode,
  NotificationOpts,
  PreviewGpuBudgetSnapshot,
  PreviewGpuColorSpace,
  PreviewGpuMainTiming,
  PreviewGpuOpenReply,
  PreviewGpuSlotAck,
  PreviewGpuTimingReport,
  PreviewSwFrameMsg,
  ExportSwMsg,
  ExportSwOpenReply,
  SystemStats,
  WinCreateOpts,
  WinAction,
} from '../shared/ipc'
import type {
  DataRootCurrent,
  DataRootMigrateResult,
  DataRootPendingCleanup,
} from '../shared/data-root'

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
    versions: (): Promise<AppVersions> => ipcRenderer.invoke('app:versions') as Promise<AppVersions>,
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
    // The reply's `barrierMode` is the CONFIGURED label, for a caller that wants
    // to check a run's observed barrier against what it asked for. It is NOT how
    // the preload learns the mode — see the `evt:previewGpu:barrier` latch below
    // for why a reply cannot do that job.
    open(args: { streamId: string; path: string; poolSize: number; colorSpace: PreviewGpuColorSpace; codedWidth: number; codedHeight: number }): Promise<PreviewGpuOpenReply> {
      return ipcRenderer.invoke('previewGpu:open', args) as Promise<PreviewGpuOpenReply>
    },
    requestFrameAt(args: { streamId: string; targetUs: number }): Promise<void> {
      return ipcRenderer.invoke('previewGpu:requestFrameAt', args) as Promise<void>
    },
    close(args: { streamId: string }): Promise<void> {
      return closePreviewGpuStream(args.streamId)
    },
    // Hand a MessagePort to the main world so it can receive `streamId`'s decoded
    // frames. A contextBridge function MAY be called from the main world and MAY
    // itself call window.postMessage with a transfer list (only PASSING a port
    // as a bridge ARGUMENT fails). The renderer attaches its `message` listener
    // BEFORE calling this, then grabs `ev.ports[0]`.
    //
    // `streamId` rides the handoff message so a listener can tell ITS port from
    // another session's: the post is a broadcast every live transport hears.
    requestPort(streamId: string): void {
      const ch = new MessageChannel()
      portByStream.set(streamId, ch.port1)
      // The channel is bidirectional and under `rendererFence` the renderer sends
      // slot acks back up it (see receiveSlotAck). Setting `onmessage` also
      // starts the port, which is why nothing else has to.
      ch.port1.onmessage = (ev: MessageEvent) => { receiveSlotAck(ch.port1, ev.data) }
      window.postMessage({ __weftcutPreviewGpu: 'port', streamId }, '*', [ch.port2])
    },
    budget(): Promise<PreviewGpuBudgetSnapshot> {
      return ipcRenderer.invoke('previewGpu:budget') as Promise<PreviewGpuBudgetSnapshot>
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
    open(args: { streamId: string; path: string; lane?: string | null; device?: string | null; scaleDiv?: number | null; cadenceDiv?: number | null }): Promise<{ width: number; height: number }> {
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

  // User-managed data location (ticket 03). Plain main-process actions; the copy
  // migration's progress arrives out-of-band on `evt:dataRoot:progress` (subscribe
  // via the generic `on()` above), not as a return value.
  dataRoot: {
    current: (): Promise<DataRootCurrent> => ipcRenderer.invoke('dataRoot:current') as Promise<DataRootCurrent>,
    pickAndMigrate: (): Promise<DataRootMigrateResult> =>
      ipcRenderer.invoke('dataRoot:pickAndMigrate') as Promise<DataRootMigrateResult>,
    relaunch: (): Promise<void> => ipcRenderer.invoke('dataRoot:relaunch') as Promise<void>,
    openFolder: (): Promise<void> => ipcRenderer.invoke('dataRoot:openFolder') as Promise<void>,
    pendingCleanup: (): Promise<DataRootPendingCleanup | null> =>
      ipcRenderer.invoke('dataRoot:pendingCleanup') as Promise<DataRootPendingCleanup | null>,
    deleteOld: (): Promise<void> => ipcRenderer.invoke('dataRoot:deleteOld') as Promise<void>,
    dismissCleanup: (): Promise<void> => ipcRenderer.invoke('dataRoot:dismissCleanup') as Promise<void>,
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
// Cross-stream soundness rests on main SERIALISING its opens (see
// openPreviewGpu's queue): this one queue pairs positionally against a separate
// channel's callbacks, so two interleaved opens would mis-key each other's
// textures. Main guarantees at most one open is mid-loop.
const announceQueue: { streamId: string; slot: number }[] = []
// The renderer-main-world end of each session's frame channel, keyed by streamId.
//
// LANDMINE: this was ONE global `mainPort` that every `requestPort()` overwrote.
// Since `window.postMessage` is a broadcast, every live GpuTransport's listener
// also grabbed the newest port — so with 2+ concurrent GPU sessions all of them
// ended up sharing the last channel, one `onmessage` survived, and every frame
// whose `streamId` didn't match that transport was silently dropped. Every
// session but the newest went permanently dark: rings frozen, painter stuck on a
// stale frame, and (because eof/error pokes ride the same port) FfmpegSource
// never saw the failure so the HW→SW fallback never fired. One port per stream.
const portByStream = new Map<string, MessagePort>()
// The barrier strategy each live session runs, latched from the
// `evt:previewGpu:barrier` event main sends before creating the native session
// (main resolves the mode — see `HwBarrierMode`). Per-stream rather than one
// module-level value because the frameReady handler is given nothing but a
// streamId, and because a session that opened before the knob was read must keep
// the mode it was told.
//
// INVARIANT: an entry exists before the first frame of that stream arrives —
// both messages ride the same ordered webContents channel and main sends the
// latch first. So a MISSING entry no longer means "the reply hasn't landed yet";
// it means the stream is unknown (never opened, or already closed).
//
// The unlatched fallback is `readback`, NOT the shipped default, and the
// difference is deliberate twice over: readback is the barrier that needs no GL
// context, no fence support and no renderer cooperation, so it is the one that
// cannot itself fail; and
// because it differs from the default, an unlatched frame shows up as a second
// applied mode (`barrierModeObserved: 'mixed'`) instead of blending in. A
// fallback that silently matched the default would hide the very race the latch
// ordering exists to close. Never `none`: an unlatched stream still gets a
// correct barrier.
const barrierModeByStream = new Map<string, HwBarrierMode>()

// Tear down a session from the PRELOAD side. Electron only frees a shared
// texture's GPU pool slot once EVERY import of it is released — main's
// closePreviewGpu releases its own (persistent, per-slot) imports, but the
// copy this preload holds in `importedByKey` (from setSharedTextureReceiver)
// is a SEPARATE import that only the preload can release. Skipping this leaks
// a whole slot pool per open/close cycle (decode-bench opens/closes a session
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
  // Drop this stream's frame channel in the same "before the await" batch: the
  // frameReady handler's `if (!port) return` is what keeps a late poke from
  // acking into a session main is mid-closing.
  const port = portByStream.get(streamId)
  if (port) {
    portByStream.delete(streamId)
    port.close()
  }
  barrierModeByStream.delete(streamId)
  // Same "before the await" batch, same reason: a pending fence must not survive
  // into main's close and ack a slot of a session that is going away.
  dropPendingFencesFor(streamId)
  await (ipcRenderer.invoke('previewGpu:close', { streamId }) as Promise<void>)
}

// Slot-correlation announce: enqueue; the next receiver callback claims it.
ipcRenderer.on('evt:previewGpu:slot', (_e, { streamId, slot }: { streamId: string; slot: number }) => {
  announceQueue.push({ streamId, slot })
})

// Barrier latch — the authoritative one. Main sends this BEFORE it creates the
// native decode session, on the SAME ordered channel the frameReady pokes use,
// so it cannot be overtaken by a frame of the stream it describes.
//
// The `previewGpu:open` reply carries the same value but cannot be trusted to
// deliver it: an invoke reply is a separate channel, and with 2+ sessions
// opening at once a frameReady wins that race. The frame that arrives first then
// finds no latch, applies the unlatched `readback` fallback, and stamps it —
// while later frames of the SAME session stamp the configured mode. The lane
// stays correct (the fallback is a safe barrier), but the session reports two applied
// modes, which is indistinguishable from a genuine mid-session change and
// invalidates the measurement. Ordering, not retry, is what closes that.
ipcRenderer.on('evt:previewGpu:barrier', (_e, { streamId, mode }: { streamId: string; mode: HwBarrierMode }) => {
  barrierModeByStream.set(streamId, mode)
})

// Register the receiver ONCE at preload load. Each callback = one slot's texture
// arriving from main; pair it FIFO to the announce enqueued just before its send.
//
// An EMPTY queue here means the announce was pruned by a close that raced this
// send mid-open (`closePreviewGpuStream` runs its prune before awaiting main's
// close, and a dispose can land between the announce task and this callback).
// The ordering contract — announce enqueued before the receiver fires, main
// serialising opens — rules out "the announce just hasn't arrived yet". The
// unpaired import must be RELEASED, not dropped: it holds a GPU reference on
// the slot texture, Electron frees the underlying pool only once every import
// releases, and nothing else will ever see this one — one leaked slot texture
// per dispose-races-open occurrence, for the process lifetime.
sharedTexture.setSharedTextureReceiver(async (data) => {
  const a = announceQueue.shift()
  if (a) {
    importedByKey.set(`${a.streamId}:${a.slot}`, data.importedSharedTexture)
  } else {
    try { data.importedSharedTexture.release() } catch { /* already torn down */ }
  }
})

// Cross-device read-completion barrier (native-hw frame-REORDER fix).
//
// The shared slot texture is overwritten IN PLACE by the native decode
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
//
// This readback is correct but NOT free: it is synchronous renderer-thread time
// once per delivered frame PER SESSION, which is why `HwBarrierMode` exists — a
// switch between this readback, a GPU-side flush, a deferred fence on either
// side of the port, and no barrier at all.
//
// WHAT ACTUALLY RUNS TODAY IS `rendererFence`, and it runs in the RENDERER — the
// preload posts the bitmap and delegates the ack, because the completion signal
// belongs on a context that is presented every frame and this process has none
// (renderer/render/decoder/transports/slotFenceQueue.ts). The readback below
// stays the fallback and the A/B control, and it is still the clearest statement
// of WHY any barrier is needed at all — which is why the race is documented here
// rather than beside either fence.
//
// What the switch measured, and what it means for anyone changing this code:
// submitting the copy costs ~0.1ms and WAITING for it costs ~19.9ms, and a
// submit-only barrier (`gpuflush`) reorders exactly like no barrier at all. So
// the ack was never waiting on submission — it waits on COMPLETION, and there is
// no cheaper way to spell "completed". What the barrier never needed to gate is
// DELIVERY: only RECYCLING. Today's code conflates the two because it is
// synchronous. `fence` splits them (see the fence barrier below) — same hard
// completion signal, off the critical path.

/// What one barrier cost, split by phase. Reported per frame so the readback's
/// two halves can be told apart: the 2D context is created with
/// `willReadFrequently: true`, which hints a CPU-BACKED canvas, so `drawImage`
/// of a GPU-backed bitmap may ALREADY be the GPU→CPU readback and `getImageData`
/// nearly free. A single total cannot distinguish that from the reverse, and
/// attributing the cost to the wrong call sends any fix in the wrong direction.
/// `readMs` is 0 for barriers that have no CPU-read phase.
///
/// A null cost means the barrier could not run at all (no context). Every
/// barrier reports that rather than a zero cost, because "ran and was free" and
/// "never ran" are the two readings the experiment must never confuse.
type BarrierCost = { drawMs: number; readMs: number }

let readBarrierCtx: OffscreenCanvasRenderingContext2D | null | undefined
function forceSharedTextureReadComplete(bmp: ImageBitmap): BarrierCost | null {
  if (readBarrierCtx === undefined) {
    readBarrierCtx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
  }
  if (!readBarrierCtx) return null // no 2D context available — barrier unavailable
  const tDraw = performance.now()
  readBarrierCtx.drawImage(bmp, 0, 0, 1, 1)
  const tRead = performance.now()
  readBarrierCtx.getImageData(0, 0, 1, 1)
  return { drawMs: tRead - tDraw, readMs: performance.now() - tRead }
}

// The one WebGL2 context both GPU-side barriers share. One 1×1 context and ONE
// texture, created lazily and reused: the binding is set once at creation
// because nothing else ever touches this context.
//
// Null when WebGL2 is unavailable, which every caller must read as "fall back to
// the readback barrier" — a silently absent barrier corrupts frames, so no GPU
// path may degrade to a no-op. That fallback is why the frame message reports
// the barrier it APPLIED and not the one it was configured with (see below).
let gpuBarrierGl: WebGL2RenderingContext | null | undefined
function webglBarrierContext(): WebGL2RenderingContext | null {
  if (gpuBarrierGl === undefined) {
    gpuBarrierGl = new OffscreenCanvas(1, 1).getContext('webgl2')
    if (gpuBarrierGl) gpuBarrierGl.bindTexture(gpuBarrierGl.TEXTURE_2D, gpuBarrierGl.createTexture())
  }
  return gpuBarrierGl
}

// `gpuflush` barrier: schedule the copy on the GPU and flush, with NO CPU
// readback. `texImage2D` from the bitmap makes the GPU consume the
// createImageBitmap copy, but `flush()` only submits the command buffer, it does
// not wait for completion the way `getImageData` does — and that turned out to
// be the whole story: this mode reorders exactly as `none` does. Retained as the
// control that isolates submit cost (~0.1ms) from wait cost (~19.9ms).
function forceSharedTextureReadCompleteOnGpu(bmp: ImageBitmap): BarrierCost | null {
  const gl = webglBarrierContext()
  if (!gl) return null
  const tDraw = performance.now()
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
  gl.flush()
  return { drawMs: performance.now() - tDraw, readMs: 0 }
}

// ---------------------------------------------------------------------------
// `fence` barrier: the same GPU copy `gpuflush` submits, plus a fence to say
// when it COMPLETED — with the waiting moved off the frame's critical path.
//
// The slot's ack is what must wait for completion; DELIVERY never did. So this
// path posts the bitmap immediately (presentation latency unchanged: the
// renderer's own use of the bitmap only queues more GPU work behind our copy, so
// ordering still holds) and defers only the ack until the fence signals.
// ---------------------------------------------------------------------------

/// How long a pending fence may stay unsignalled before the drain stops polling
/// politely and forces the wait. Two display intervals.
///
/// LANDMINE: 4 intervals (66.7ms) was tried and is WORSE — do not re-widen this.
/// On an IDLE GPU the fence essentially never signals on its own, at any bound
/// we set, because nothing forces the pipeline along; under load the surrounding
/// traffic does, and the fence signals inside one interval. Widening therefore
/// does not convert timeouts into natural signals. It only holds a pool slot
/// longer, still times out, and pays more per timeout:
///
///   1080p, 1 track      deadline 33.3   deadline 66.7
///   fenceWaitP50            34.9ms          88.5ms
///   fenceForcedWaits           98             206
///   spin per 20s window      1.96s           4.12s
///   tick p99                 23.7 (smooth)   34.1 (STUTTER)
///
/// 2-4 tracks force nothing at either bound, so the idle case is the only one
/// this constant is really arbitrating — and for it, tighter is strictly better.
///
/// Why not shorter still: under load a fence does signal on its own within an
/// interval, and a deadline inside that window would force-wait frames that were
/// about to complete — the synchronous barrier back again by another name. Why
/// not longer: the table above, plus every slot parked in the pending queue is a
/// frame native cannot decode; the pool is only `poolSize` deep and
/// `fencePendingQueuePeak` already sits at `poolSize`.
const FENCE_DEADLINE_MS = 2 * (1000 / 60)

/// Wall-clock budget for that forced wait. Sized at the ~20ms the synchronous
/// readback barrier costs, so the worst case this mechanism degrades to is
/// "behaves like the barrier it replaced" — which was the safety argument for
/// adopting an unknown-risk mechanism, and is still the bound on how bad a
/// pathological session can get.
const FENCE_FORCED_WAIT_BUDGET_MS = 20

/// A delivered frame whose slot is not acked yet, waiting on `sync`. Acking out
/// of order is safe: native's `ConsumeAck(slot, gen)` sets a per-slot free flag
/// with no ordering assumption (preview_gpu/session.rs), so slots are
/// independently owned and a later frame's fence may signal first. `gen` is the
/// fill generation the frame arrived with — the ack must echo it.
type PendingFence = { streamId: string; slot: number; gen: number; sync: WebGLSync; submittedAt: number }
const pendingFences: PendingFence[] = []

/// Per-stream fence health, piggybacked onto that stream's next frame message.
/// `pendingPeak`/`forcedWaits`/`forcedWaitMsTotal` are cumulative (the summary
/// keeps the max), while `lastWaitMs` is the most recent completed submit→ack.
type FenceStreamStats = {
  pending: number
  pendingPeak: number
  forcedWaits: number
  /// Summed wall-clock ms burned inside forced spins. The spin is the ONLY
  /// blocking cost this path has, and it is absent from `barrierMs` (which stays
  /// submit-only by design) — so without this total a session spinning hundreds
  /// of times still reports a near-zero barrier cost.
  forcedWaitMsTotal: number
  lastWaitMs: number | null
}
const fenceStatsByStream = new Map<string, FenceStreamStats>()
function fenceStatsFor(streamId: string): FenceStreamStats {
  let s = fenceStatsByStream.get(streamId)
  if (!s) {
    s = { pending: 0, pendingPeak: 0, forcedWaits: 0, forcedWaitMsTotal: 0, lastWaitMs: null }
    fenceStatsByStream.set(streamId, s)
  }
  return s
}

function fenceSignalled(gl: WebGL2RenderingContext, status: GLenum): boolean {
  return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED
}

/// Submit the copy and fence it. Returns the BLOCKING cost only — the wait this
/// buys is reported separately, because "cost on the loop" means the same thing
/// everywhere else in this harness.
function submitFenceBarrier(bmp: ImageBitmap): { cost: BarrierCost; sync: WebGLSync } | null {
  const gl = webglBarrierContext()
  if (!gl) return null
  const tDraw = performance.now()
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  // The flush goes AFTER fenceSync so it carries the fence as well as the copy.
  // A fence nobody flushed sits in the client-side command buffer and can never
  // signal — the drain would then poll it until the deadline every single frame,
  // which reads as "the GPU is slow" and is really "we never submitted it".
  gl.flush()
  if (!sync) return null
  return { cost: { drawMs: performance.now() - tDraw, readMs: 0 }, sync }
}

/// Forced wait once a fence blew its deadline. Returns whether it signalled.
///
/// LANDMINE: WebGL2 caps `clientWaitSync`'s timeout at
/// `MAX_CLIENT_WAIT_TIMEOUT_WEBGL`, which is 0 on Chromium — a genuinely
/// blocking wait is NOT expressible, and passing a bigger timeout is an
/// INVALID_OPERATION that comes back WAIT_FAILED. So the bound is enforced in
/// wall-clock here and each call is a flush-and-poll. `SYNC_FLUSH_COMMANDS_BIT`
/// is what makes that poll safe against the un-flushed case above.
let maxClientWaitNs: number | undefined
function forceWaitOnFence(gl: WebGL2RenderingContext, sync: WebGLSync): boolean {
  if (maxClientWaitNs === undefined) {
    const v = gl.getParameter(gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL) as number | null
    maxClientWaitNs = typeof v === 'number' && v > 0 ? v : 0
  }
  const timeoutNs = Math.min(FENCE_FORCED_WAIT_BUDGET_MS * 1e6, maxClientWaitNs)
  const deadline = performance.now() + FENCE_FORCED_WAIT_BUDGET_MS
  for (;;) {
    const status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, timeoutNs)
    if (fenceSignalled(gl, status)) return true
    if (status === gl.WAIT_FAILED) return false
    if (performance.now() >= deadline) return false
  }
}

/// Ack every pending slot whose fence has signalled. Non-blocking by default —
/// `clientWaitSync(sync, 0, 0)` asks the state and returns.
function drainFenceAcks(): void {
  if (pendingFences.length === 0) return
  const gl = webglBarrierContext()
  if (!gl) return // unreachable: an entry only exists because the context did
  // Nudge the pipeline before polling. A fence nobody flushes signals only as
  // fast as whatever unrelated GPU traffic happens along, which made this
  // mechanism look load-dependent in the WRONG direction: at three tracks the
  // fences signalled in 6-9ms, at one track 35ms and 223 forced spins, because
  // the idle case had no other traffic to ride on.
  //
  // Per PASS, not per entry: `SYNC_FLUSH_COMMANDS_BIT` is a flush-then-wait on
  // each call, so setting it on every pending entry issues N flushes for one
  // queue. Doing it on only the first entry would work but makes the flush an
  // accident of iteration order — and this loop walks backwards and splices, so
  // "first" is not even stable. One explicit `flush()` here is unconditional,
  // order-independent, and visibly once.
  gl.flush()
  const now = performance.now()
  for (let i = pendingFences.length - 1; i >= 0; i--) {
    const p = pendingFences[i]
    let done = fenceSignalled(gl, gl.clientWaitSync(p.sync, 0, 0))
    let forced = false
    let forcedMs = 0
    if (!done) {
      if (now - p.submittedAt < FENCE_DEADLINE_MS) continue
      forced = true
      // Timed around the spin itself, not the whole entry: this is the slice
      // that actually burns the main thread, and it is the only part of the
      // fence path that does. See `forcedWaitMsTotal`.
      const tForced = performance.now()
      done = forceWaitOnFence(gl, p.sync)
      forcedMs = performance.now() - tForced
    }
    gl.deleteSync(p.sync)
    pendingFences.splice(i, 1)
    const stats = fenceStatsFor(p.streamId)
    stats.pending = Math.max(0, stats.pending - 1)
    stats.lastWaitMs = performance.now() - p.submittedAt
    if (forced) {
      stats.forcedWaits += 1
      stats.forcedWaitMsTotal += forcedMs
    }
    // Ack even when `done` is false — i.e. the forced wait ALSO timed out. A slot
    // that is never acked is a permanent leak, and `poolSize` of them wedge the
    // session for good; one possibly-torn frame is strictly the smaller harm.
    // `forcedWaits` is what makes the trade visible rather than silent.
    void ipcRenderer.invoke('previewGpu:consumeAck', { streamId: p.streamId, slot: p.slot, gen: p.gen }).catch(() => {})
  }
}

/// Drain driver for the gaps between frames. Runs ONLY while entries are pending
/// and stops the moment the queue empties — never a spin on an empty queue.
///
/// `setTimeout(0)`, deliberately, on both counts:
///   - NOT requestAnimationFrame. It looks perfect here (display-paced, free)
///     and it is a trap: rAF is frozen while the window is OCCLUDED, so acks
///     would stop, the pool would starve, and preview would wedge — reproducible
///     only when something covers the window.
///   - Over MessageChannel because the nested-timeout clamp (~4ms) rate-limits
///     the poll for free; a task-queue ping would re-arm at ~0ms and busy-loop
///     the main thread for the whole deadline.
let fencePumpTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFencePump(): void {
  if (fencePumpTimer !== null || pendingFences.length === 0) return
  fencePumpTimer = setTimeout(() => {
    fencePumpTimer = null
    drainFenceAcks()
    scheduleFencePump()
  }, 0)
}

/// Drop a closing stream's pending fences. Deletes each sync and does NOT ack:
/// acking into a session main is mid-closing is exactly what the close path's
/// ordering exists to prevent, and the native close joins the decode thread, so
/// the slots cease to exist with it.
function dropPendingFencesFor(streamId: string): void {
  for (let i = pendingFences.length - 1; i >= 0; i--) {
    const p = pendingFences[i]
    if (p.streamId !== streamId) continue
    gpuBarrierGl?.deleteSync(p.sync)
    pendingFences.splice(i, 1)
  }
  fenceStatsByStream.delete(streamId)
}

/// Release a slot the RENDERER says is done with (`rendererFence`). The only
/// message that travels back up a frame port: under that mode the preload runs no
/// barrier and no fence, so the renderer both takes the completion signal on its
/// presented device and returns the slot here.
///
/// Two guards, and both are the teardown ordering seen from this side:
///   - the ack must name the stream whose port carried it, so a message can never
///     free another session's slot;
///   - that stream must still be live. `closePreviewGpuStream` drops the port
///     before awaiting main's close, so a late ack usually cannot arrive at all —
///     this catches the one already dispatched, rather than acking into a session
///     main is mid-closing.
function receiveSlotAck(port: MessagePort, data: unknown): void {
  const msg = data as PreviewGpuSlotAck | null | undefined
  if (!msg || msg.kind !== 'consumeAck' || typeof msg.slot !== 'number' || typeof msg.gen !== 'number') return
  if (portByStream.get(msg.streamId) !== port) return
  void ipcRenderer.invoke('previewGpu:consumeAck', { streamId: msg.streamId, slot: msg.slot, gen: msg.gen }).catch(() => {})
}

// Per-frame loop — this is where the ACK-AFTER-READ discipline lives. On a
// frameReady poke: snapshot the slot's shared texture into an ImageBitmap, post
// it to the main world over the MessagePort, and consumeAck only once the
// snapshot's cross-device read has GPU-COMPLETED (`createImageBitmap` resolving
// is NOT that guarantee across devices, see above), so native may safely reuse
// the slot. Acking earlier lets native overwrite the slot mid-read
// (reorder/tearing). Native's AcquireSync on a still-held slot now times out
// (finite, Error-poke + skip) rather than hanging, but an early ack would still
// corrupt a frame, so the ordering stays load-bearing.
//
// WHERE the ack happens depends on the mode, and exactly one place does it per
// delivered bitmap: here (the synchronous barriers), in the fence queue above, or
// in the RENDERER under `rendererFence`, which is what ships — `ackDelegated`
// hands the obligation over with the frame and `receiveSlotAck` brings it back.
//
// The ack must ALSO fire if createImageBitmap (or the port post) throws — once
// getVideoFrame() has been called, the slot is spoken for, and vf.close() in
// the inner finally already releases the GPU hold regardless of outcome. So
// skipping the ack on failure would strand the slot until native's finite
// AcquireSync times out and skips it — an avoidable dropped frame, not a hang.
// Report the failure to the main world too, matching the eof/error relay below.
ipcRenderer.on(
  'evt:previewGpu:frameReady',
  async (_e, { streamId, slot, gen, ptsUs, durUs }: { streamId: string; slot: number; gen: number; ptsUs: number; durUs: number }) => {
    // Opportunistic fence drain (no-op unless the fence barrier is running).
    // Free: a frame arriving IS the wake-up the pending acks were waiting for,
    // and doing it here costs no scheduling. The pump only covers the gaps.
    drainFenceAcks()
    const imp = importedByKey.get(`${streamId}:${slot}`)
    // Snapshot the port into a const so its non-null narrowing survives the await
    // below (a fresh Map read after the await could see a closed session).
    const port = portByStream.get(streamId)
    // No port = the session is closed or mid-close (closePreviewGpuStream drops
    // the port + imports BEFORE awaiting main's close, exactly so a late poke
    // short-circuits here). Stay silent: acking into a mid-closing session is
    // what that ordering exists to avoid, and native is being torn down anyway.
    if (!port) return
    // Port but no import = a LIVE session whose slot never got paired (see
    // announceQueue). Nothing was read out of the slot, so native still owns it —
    // but we must ack or it is stranded until native's finite AcquireSync times
    // out, and pool_size stranded slots wedge the session for good. Same
    // reasoning as the ack-on-error case below; `getVideoFrame` was never called,
    // so there is no GPU hold to release first.
    if (!imp) {
      void ipcRenderer.invoke('previewGpu:consumeAck', { streamId, slot, gen }).catch(() => {})
      return
    }
    const tEntry = performance.now()
    // Set once this frame's slot is handed off — to the local fence queue, or
    // (under `rendererFence`) to the renderer with the delivered bitmap. The
    // finally below reads both to decide whether the ack is still its job.
    // Declared out here so a throw after a hand-off can't double-ack the slot.
    let fenceOwnsAck = false
    let rendererOwnsAck = false
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
      // Stamped DIRECTLY rather than left to be derived as
      // `resident - gvf - cib`: the subtraction also absorbs `vf.close()` and
      // any scheduling gap around the await, which made the derived figure read
      // several times the real drain and INVERT with load.
      //
      // `barrierMs` stays the TOTAL for whichever mode ran (its readers predate
      // the split); `barrierDrawMs`/`barrierReadMs` are the phases within it.
      //
      // `none` is the KNOWN-INCORRECT control: it reintroduces the reorder this
      // whole path exists to prevent, and is only ever reached because someone
      // set WEFTCUT_HW_BARRIER to measure what the barrier costs. All three
      // stamps read 0 then, so a run with no barrier is unmistakable in the data.
      //
      // `barrierApplied` is the barrier that ACTUALLY RAN, assigned from the
      // branch that produced the cost — never copied from `mode`. The configured
      // value can lie in both directions (main never picked the env up; the
      // gpuflush fallback quietly ran readback because WebGL2 was missing), and a
      // bench leg labelled by intent rather than by outcome reports "removing the
      // barrier buys nothing" when the barrier never left. A leg whose applied
      // mode disagrees with its label is INVALID, not slow — so the applied value
      // has to travel with the samples for anyone to be able to tell.
      //
      // Under `fence` the barrier stamps stay SUBMIT-ONLY (~0.1ms). The wait it
      // defers is real but is not cost on the loop, so it is reported apart, in
      // `fence` — conflating the two is how a mechanism that moved the cost
      // would look like one that removed it.
      //
      // `rendererFence` runs NOTHING here. The whole point of that mode is that
      // this process has no context worth fencing on, so it delegates: the copy,
      // the completion signal and the ack all happen on the renderer's presented
      // device (renderer/render/decoder/transports/slotFenceQueue.ts). It also
      // owns the `barrierApplied` stamp — only it knows which rung of its own
      // fallback ladder ran — so this side leaves the stamp off rather than
      // guessing, and `ackDelegated` is what carries the obligation across.
      const mode = barrierModeByStream.get(streamId) ?? 'readback'
      const delegateToRenderer = mode === 'rendererFence'
      let barrierApplied: HwBarrierMode | undefined = delegateToRenderer ? undefined : 'none'
      let barrierMs = 0
      let barrierDrawMs = 0
      let barrierReadMs = 0
      let fenceSync: WebGLSync | null = null
      if (!delegateToRenderer && mode !== 'none') {
        const tBarrier = performance.now()
        let cost: BarrierCost | null = null
        if (mode === 'fence') {
          const submitted = submitFenceBarrier(bmp)
          if (submitted) {
            cost = submitted.cost
            fenceSync = submitted.sync
            barrierApplied = 'fence'
          }
        } else if (mode === 'gpuflush') {
          cost = forceSharedTextureReadCompleteOnGpu(bmp)
          if (cost) barrierApplied = 'gpuflush'
        }
        if (!cost) {
          // Either readback was asked for, or a GPU path was and had no context
          // (or no fence object). Falling back keeps a hard barrier in place.
          cost = forceSharedTextureReadComplete(bmp)
          // Still null = no 2D context either, so NOTHING ran: report 'none',
          // which is both the honest answer and a correctness alarm.
          if (cost) barrierApplied = 'readback'
        }
        if (cost) {
          barrierMs = performance.now() - tBarrier
          barrierDrawMs = cost.drawMs
          barrierReadMs = cost.readMs
        }
      }
      // Queue the deferred ack BEFORE the post: `bmp` is transferred away by
      // postMessage, so from here on the fence is the ONLY handle on this copy's
      // completion — there is no bitmap left to fall back to `getImageData` on.
      let fence:
        | { waitMs?: number; pendingPeak: number; forcedWaits: number; forcedWaitMsTotal: number }
        | undefined
      if (fenceSync) {
        pendingFences.push({ streamId, slot, gen, sync: fenceSync, submittedAt: performance.now() })
        fenceOwnsAck = true
        const stats = fenceStatsFor(streamId)
        stats.pending += 1
        stats.pendingPeak = Math.max(stats.pendingPeak, stats.pending)
        scheduleFencePump()
        fence = {
          pendingPeak: stats.pendingPeak,
          forcedWaits: stats.forcedWaits,
          forcedWaitMsTotal: stats.forcedWaitMsTotal,
          ...(stats.lastWaitMs !== null ? { waitMs: stats.lastWaitMs } : {}),
        }
      }
      const residentMs = performance.now() - tEntry
      port.postMessage(
        { kind: 'frame', streamId, slot, gen, ptsUs, durUs, bitmap: bmp, gvfMs, cibMs, residentMs, barrierMs, barrierDrawMs, barrierReadMs, barrierApplied, fence, ...(delegateToRenderer ? { ackDelegated: true } : {}) },
        [bmp],
      )
      // AFTER the post, not before it: the obligation travels WITH the message,
      // and `postMessage` can throw. A message that never arrived leaves the ack
      // here — unlike the fence queue above, which takes ownership before the
      // post because the transfer leaves the sync as the only handle on the copy.
      if (delegateToRenderer) rendererOwnsAck = true
    } catch (err) {
      port.postMessage({ kind: 'error', streamId, message: err instanceof Error ? err.message : String(err) })
    } finally {
      // AFTER the snapshot attempt (success or failure) — release the slot back
      // to the native pool. Swallow a rejection: if a dispose raced this poke
      // and closed the session first, the ack lands on an already-closed
      // session and napi rejects — that's expected, not an error to surface.
      //
      // Skipped only when this frame's slot was handed off — to the fence queue,
      // or to the renderer with the delivered bitmap — which owns the ack from
      // that point. Everything else, including a throw after either hand-off,
      // still acks here or there exactly once.
      if (!fenceOwnsAck && !rendererOwnsAck) {
        void ipcRenderer.invoke('previewGpu:consumeAck', { streamId, slot, gen }).catch(() => {})
      }
    }
  },
)

// End-of-stream / error pokes → forward to the main world over the same port.
ipcRenderer.on('evt:previewGpu:eof', (_e, { streamId }: { streamId: string }) => {
  portByStream.get(streamId)?.postMessage({ kind: 'eof', streamId })
})
ipcRenderer.on('evt:previewGpu:error', (_e, { streamId, message }: { streamId: string; message: string }) => {
  portByStream.get(streamId)?.postMessage({ kind: 'error', streamId, message })
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
