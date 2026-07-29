// Single source of truth for the preload IPC contract — the shape of
// `window.api`. Shared between the two DOM-context sides that must agree on it:
//   - src/preload/index.ts   implements it: `const api: WeftcutApi = {…}`
//                            (so the implementation is compile-checked here)
//   - src/renderer/bridge/   consumes it: augments `Window` + wraps each method
// Because both type-check against THIS definition, the two sides cannot drift.
// The main process does not consume this contract, so it does not reference
// this project.
//
// Types only — no runtime. `File` etc. resolve from DOM (both consumers are DOM
// contexts); this file is never imported by the non-DOM main process.

export type DialogOpenOpts = {
  title?: string
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
  defaultPath?: string
}

export type DialogSaveOpts = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export type DirEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }

// `decorations` is the Tauri-era name kept at the IPC boundary: true (the
// default in createSecondary) gives the window a native OS frame with a title
// bar (move/close). Secondary windows draw no custom titlebar, so omit it (or
// pass true) for everything except a window that paints its own caption.
export type WinCreateOpts = {
  url?: string
  width?: number
  height?: number
  title?: string
  decorations?: boolean
  resizable?: boolean
  minWidth?: number
  minHeight?: number
}

export type WinAction = 'show' | 'hide' | 'close' | 'center' | 'focus'

export type NotificationOpts = { title?: string; body?: string }

/// Process-tree resource snapshot derived from Electron's app.getAppMetrics().
/// Covers the whole app process tree (main + renderers + GPU + utility), not
/// the host machine. See src/main/metrics.ts for the CPU-normalization landmine.
export type SystemStats = {
  /// Summed CPU across the process tree, as a % of the whole machine (0–100).
  cpu_percent: number
  /// Summed resident memory (working set) of the process tree, in bytes.
  rss_bytes: number
  /// Number of processes in the Electron tree.
  process_count: number
  /// Logical core count — context for cpu_percent.
  logical_cores: number
}

/// An app-level capability notice surfaced through the system-status entry.
/// `code` keys the i18n strings; main collects these at startup
/// (e.g. keyring-unavailable → plaintext cloud keys) and the renderer PULLS them
/// on mount via `app.notices()` — a pull model so a notice can't be lost to the
/// fire-once-before-subscribe race a pushed event had.
export type AppNotice = { level: 'info' | 'warn' | 'error'; code: string }

/// Color-space tag for a native GPU-preview shared-texture import. Mirrors
/// Electron's `ColorSpace` structure (main passes it straight to
/// `importSharedTexture`); typed structurally here so this DOM/electron-free
/// contract file stays free of the Electron types. The enum values (e.g.
/// bt709/limited) come from the source's color metadata.
export type PreviewGpuColorSpace = {
  primaries: string
  transfer: string
  matrix: string
  range: 'limited' | 'full' | 'derived' | 'invalid'
}

/// Which read-completion barrier runs between snapshotting a slot's shared
/// texture and acking it back to the native pool. The product ships one of these
/// (`rendererFence`); the others exist so a bench can A/B against it. Main
/// resolves the mode from an env var (`WEFTCUT_HW_BARRIER`, see
/// src/main/previewGpu.ts) and every session reports the one it applied.
///
/// Two of them defer the ack behind a completion signal, and they differ in which
/// process takes it and — the part that turned out to matter — whether waiting
/// for it can be done without burning the renderer thread.
///
///   rendererFence — THE DEFAULT. The preload runs no barrier at all: it posts
///              the bitmap and hands the ack obligation to the renderer, which
///              takes the completion signal on the Pixi WebGPU device (see
///              renderer/render/decoder/transports/slotFenceQueue.ts) and acks
///              back over the same port. WebGPU's signal is a PROMISE, so a slot
///              that is not ready costs nothing to keep waiting for — that, not
///              a faster signal, is the win. The earlier deadline-based build
///              measured zero spin and barrier-less tick cost, but those numbers
///              are not a throughput promise for today's signal-only contract:
///              completion has been observed at 83–97ms, so a three-slot pool
///              can cap one session around 31–36 delivered fps.
///              Ownership is signal-only: elapsed wall time never releases an
///              unfinished slot. Stream teardown drops remaining probes without
///              acking because native destroys those slots as the session closes.
///   fence    — the same deferral, with the copy + `fenceSync` taken on a
///              PRIVATE offscreen 1×1 WebGL2 context in the preload. Correct and
///              off the critical path, and it took 1080p hardware from 2 smooth
///              tracks to 4 (tick p99 at 3 tracks 39.8 → 17.0ms). Its limit is
///              the idle GPU, where that fence does not signal on its own at ANY
///              bound: the drain's flush-and-poll spin is what completes it, and
///              WebGL2 cannot express a blocking wait
///              (`MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is 0 on Chromium) so the spin is
///              wall-clock-bounded busy work — ~2s per 20s window at one quiet
///              1080p track, 0.35-0.42 thread-s/s at 4K. NOT fixable by widening
///              its deadline; see `FENCE_DEADLINE_MS`, where the wider bound
///              measured worse. Retained as the A/B control.
///   readback — no longer the default, but still CORRECT and shipped for years:
///              rasterize + read back 1px, which blocks until Chromium's
///              cross-device read has GPU-completed. ~20ms of renderer-thread
///              time per frame — the wall that capped hardware preview at 2
///              smooth 1080p tracks. Now the A/B control and the safe fallback.
///   gpuflush — force the copy on the GPU only (texImage2D + flush), no CPU
///              readback. MEASURED AND REJECTED: reorders exactly as `none`
///              does, so submitting the copy is not what the ack was waiting
///              for — completion is. Kept only to re-run that comparison, and
///              it is the finding `fence` is built on.
///   none     — no barrier. KNOWN-INCORRECT: the lane presents frames pool_size
///              out of order (see the block comment in src/preload/index.ts).
///              It exists to measure the barrier's cost ceiling, nothing else.
export type HwBarrierMode = 'readback' | 'fence' | 'gpuflush' | 'none' | 'rendererFence'

/// Renderer → preload message on a session's frame port: this slot's read has
/// completed, so the preload may release it with `previewGpu:consumeAck`. The
/// ONLY message that travels back up the port, and it exists only under
/// `rendererFence`, where the renderer owns the ack.
///
/// Typed here rather than on either side because both ends must agree on it and
/// neither owns it: the renderer posts it, the preload turns it into the ack. The
/// preload verifies `streamId` against the port it arrived on, so an ack can only
/// ever free a slot of the stream whose channel carried it.
export type PreviewGpuSlotAck = { kind: 'consumeAck'; streamId: string; slot: number }

/// Reply of `previewGpu.open`: decoded stream dimensions + the realized pool
/// size (native may hand back fewer slots than requested).
export type PreviewGpuOpenReply = {
  width: number
  height: number
  poolSize: number
  /// Barrier strategy main resolved for this session (see `HwBarrierMode`).
  /// The CONFIGURED value, for a caller that wants to cross-check what it got.
  /// It is NOT how the preload learns the mode — a reply can be overtaken by
  /// the frames it describes, which cost a bench run: frames landing first
  /// missed the latch, ran the fallback, and invalidated every multi-track
  /// cell. The latch rides `evt:previewGpu:barrier`, sent before the native
  /// session exists on the same ordered channel as the frames themselves.
  barrierMode: HwBarrierMode
}

/// Reason `previewGpu:open` rejects with when either HW admission currency is
/// full. A CAPACITY condition, not a capability one: the same media on the same
/// machine opens on hardware again as soon as enough reservation frees. Callers must
/// treat it as "software for THIS open" and must NOT record it as a per-media
/// hardware verdict (see `FfmpegSource`'s open-failure branch — doing so pinned a
/// source to software for the rest of the app session the first time concurrent
/// load exceeded admission, and kept it there after the extra clips were
/// deleted). Shared so main and the renderer can't drift on the string.
export const HW_BUDGET_EXCEEDED = 'hw-budget-exceeded'

/// The native session opened at dimensions different from the coded size main
/// reserved. Treat this as a transient admission mismatch for THIS open: main
/// closes the native session and releases its lease, and the renderer falls to
/// software without poisoning the per-media hardware capability cache.
export const HW_BUDGET_RESERVATION_MISMATCH = 'hw-budget-reservation-mismatch'

/// Live preview-GPU admission snapshot. Main greedily reserves BOTH a hard
/// session slot and the source's coded width×height before native open.
///
/// `codedPixelArea` is calibrated from the measured 30 fps fixtures. It is
/// deliberately NOT called pixel-rate: fps is not yet carried into admission,
/// and multiplying this number by an assumed rate would overstate the model.
/// `calibratedFps` makes that empirical boundary visible to diagnostics.
export type PreviewGpuBudgetSnapshot = {
  currency: 'coded-pixel-area'
  sessions: { used: number; max: number }
  codedPixelArea: { used: number; max: number; calibratedFps: 30 }
}

/// Per-metric ms summary from the native preview timing accumulator (decode-bench
/// Stage 3). Field names are the napi camelCase of the Rust `TimingSummary`.
export type PreviewGpuTimingSummary = {
  count: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}
/// Native timing metrics: the coord round-trip (emit->ack), decode+copy, and the
/// throughput-bottleneck probe — `ackToEmit` (a slot's ConsumeAck -> its next
/// FrameReady, the one per-slot-cycle segment coordRtt does NOT cover) plus
/// `lookaheadGatedSkips` (how often the pump idled on the lookahead gate rather
/// than pool-full). See docs/decode-bench.md §Native strategy.
export type PreviewGpuTimingReport = {
  coordRtt: PreviewGpuTimingSummary
  decodeCopy: PreviewGpuTimingSummary
  ackToEmit: PreviewGpuTimingSummary
  lookaheadGatedSkips: number
  /// Frames the pump discarded as already-late (past the playhead by more than the
  /// A/V tolerance) instead of paying the GPU copy + IPC + ImageBitmap to deliver
  /// one nothing would display. 0 = the pipeline kept up; sustained non-zero = a
  /// decode shortfall the drop policy is absorbing.
  lateFrameDrops: number
  /// Round-2 thread time-budget probe: production/ack cadence (interEmit/interAck),
  /// the session thread's recv_timeout block distribution (recvBlock — its sum ~=
  /// total thread idle), and wake-reason tallies (idle ticks / acks / anchor nudges).
  interEmit: PreviewGpuTimingSummary
  interAck: PreviewGpuTimingSummary
  recvBlock: PreviewGpuTimingSummary
  recvTimeoutTicks: number
  recvAckMsgs: number
  recvReqMsgs: number
  /// Round-3 stall attribution: which pump early-return dominated (eofReturns /
  /// poolFullReturns / acquireFailed / lookaheadGatedSkips), plus the terminal
  /// free-slot count + eof flag when the pump last gave up.
  eofReturns: number
  poolFullReturns: number
  acquireFailed: number
  finalFreeSlots: number
  finalEof: boolean
}

/// Main-measured renderer round-trip (decode-bench signal attribution): the time
/// from main dispatching `frameReady` to receiving the matching `consumeAck` —
/// main<->renderer transit + renderer work, measured in main's own clock.
export type PreviewGpuMainTiming = { rendererRoundTripMs: PreviewGpuTimingSummary }

/// One software-decoded frame relayed to the renderer over the dedicated
/// `previewSw:frame` channel (native SW-decode preview: ProRes/DNxHD/MPEG-2/
/// VC-1 — the WebCodecs-blind-format path). Mirrors the napi `PreviewSwFrame`
/// shape 1:1 (already camelCase); `data` is the Rust `Buffer` structured-cloned
/// to the renderer as a `Uint8Array` (the one main→renderer copy). Color tags
/// are canonical FFmpeg string names or absent where the stream leaves them
/// unspecified.
///
/// `width`/`height` are the SHIPPED dimensions, which are the media's ONLY at
/// `scaleDiv` 1 — a downscaled preview frame is smaller, and `data.byteLength`
/// follows these two, never the media's. The Compositor renormalizes with
/// `media.width / textureW`, so the on-canvas rect is unchanged either way.
export type PreviewSwFrameMsg = {
  streamId: string
  ptsUs: number
  durUs: number
  width: number
  height: number
  format: 'NV12'
  colorMatrix?: string
  colorRange?: string
  colorPrimaries?: string
  colorTransfer?: string
  data: Uint8Array
}

/// One export-decoded frame — the EXPORT-side mirror of `PreviewSwFrameMsg`,
/// carried as the `frame` body of an `ExportSwMsg` (kind `'frame'`) on the
/// dedicated `exportSw:msg` channel. Delivered under the exactly-once range
/// contract + credit window (not best-effort preview), and carries `sessionId`
/// (not `streamId`) because one export runs several native sessions
/// concurrently (one per phase group). `data` is the Rust `Buffer`
/// structured-cloned to the renderer as a `Uint8Array` — the one main→renderer
/// copy; the renderer then transfers its ArrayBuffer on to the export Worker
/// (zero-copy) via postMessage.
export type ExportSwFrameMsg = {
  sessionId: string
  ptsUs: number
  durUs: number
  width: number
  height: number
  /// NV12 = 8-bit; I420P10 = tightly-packed u16LE planes (Y then U then V,
  /// the `copyToTenBit` layout — see renderer/render/decoder/tenBitFrame.ts).
  format: 'NV12' | 'I420P10'
  colorMatrix?: string
  colorRange?: string
  colorPrimaries?: string
  colorTransfer?: string
  data: Uint8Array
}

/// One in-band message on the per-session export-decode channel. Frames AND
/// control signals (rangeEnd/ended/error) ride this single tagged union down
/// ONE ordered path — napi TSFN queue → one `exportSw:msg` IPC channel per
/// webContents → one renderer listener — so a control signal can NEVER
/// overtake a frame emitted before it. That ordering IS the contract (an
/// `ended` arriving before its tail frames would corrupt the export tail);
/// never split control from frames onto a second channel. Mirrors the napi
/// `ExportSwMsg`, narrowed to a discriminated union on `kind`.
export type ExportSwMsg =
  | { sessionId: string; kind: 'frame'; frame: ExportSwFrameMsg }
  | { sessionId: string; kind: 'rangeEnd'; aUs: number; bUs: number }
  | { sessionId: string; kind: 'ended' }
  | { sessionId: string; kind: 'error'; message: string }

/// Reply of `exportSw.open`: the native session's decoded dimensions, source
/// color tags, and source-normalized start PTS (the offset already subtracted
/// from every frame's `ptsUs`). Mirrors the napi `ExportSwOpenInfoJs` 1:1.
export interface ExportSwOpenReply {
  width: number
  height: number
  colorMatrix?: string
  colorRange?: string
  colorPrimaries?: string
  colorTransfer?: string
  startPtsUs: number
}

/// Availability of the optional @weftcut/native-decode component (level-0
/// gate, ADR 0030). `reason` is the require error when unavailable.
export interface DecodeComponentStatus {
  available: boolean
  reason: string | null
  version: string | null
}

/// Verdict of `decodeCap:probeSw` (D3 machine capability cache): main runs the
/// SW one-frame decode probe, derives the format-class key from what it
/// learned, and consults/updates the per-machine cache. `classKey` is null
/// when the probe couldn't even identify a codec (e.g. unopenable file).
export interface DecodeCapabilityProbeResult {
  ok: boolean
  classKey: string | null
  reason: string | null
}

/// Verdict of `decodeCap:probeHw` (D4 GPU-keyed HW capability cache): main
/// resolves the best HW decode lane for a caller-supplied `classKey` (the
/// renderer derives it from `MediaSummary` — the HW probe itself does not,
/// unlike the SW probe, since probing is comparatively expensive). `lane` is the
/// HW lane that passed (`d3d11va` | `nvdec` | `vaapi`), or null on software
/// fallback; `device` names the DRM render node for a `vaapi` verdict (null for
/// NVDEC/d3d11va, which decode on the sole GPU handle).
export interface DecodeHwProbeResult {
  ok: boolean
  reason: string | null
  lane: string | null
  device: string | null
}

// Data-root migration IPC surface (ticket 03). Types single-sourced in
// src/shared/data-root.ts (imported by main's handlers + renderer wrappers too).
import type {
  DataRootCurrent,
  DataRootMigrateResult,
  DataRootPendingCleanup,
} from './data-root'

export interface WeftcutApi {
  /** The napi/Rust command dispatcher — one controlled channel for the whole
   *  Rust command catalog. */
  backend: { invoke(channel: string, args?: unknown): Promise<unknown> }
  fs: {
    writeFile(path: string, data: Uint8Array, append?: boolean): Promise<void>
    writeTextFile(path: string, data: string): Promise<void>
    mkdir(path: string, recursive?: boolean): Promise<void>
    readFile(path: string): Promise<Uint8Array<ArrayBuffer>>
    remove(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    readDir(path: string): Promise<DirEntry[]>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    setTitle(title: string): Promise<void>
    captureSnapshot(): Promise<Uint8Array<ArrayBuffer>>
    focus(): Promise<void>
  }
  dialog: {
    open(opts: DialogOpenOpts): Promise<string | string[] | null>
    save(opts: DialogSaveOpts): Promise<string | null>
  }
  path: {
    documentDir(): Promise<string>
    join(parts: string[]): Promise<string>
    tempDir(): Promise<string>
  }
  mcp: { getInfo(): Promise<unknown>; resetToken(): Promise<unknown> }
  win: {
    create(label: string, options?: WinCreateOpts): Promise<void>
    act(label: string, action: WinAction): Promise<void>
    exists(label: string): Promise<boolean>
  }
  media: { dropped(paths: string[]): Promise<void> }
  /// Startup notices the renderer pulls on mount (see AppNotice).
  app: { notices(): Promise<AppNotice[]> }
  /// Open a path or URL in the OS default handler (file manager / browser).
  shell: { open(target: string): Promise<void> }
  /// Post a desktop notification (best-effort; no-op where unsupported).
  notification: { send(opts: NotificationOpts): Promise<void> }
  /// Process-tree resource snapshot (app.getAppMetrics(), main-side).
  metrics: { get(): Promise<SystemStats> }
  /// Best-effort OS font-file lookup by family name (main-side scan); null when
  /// not found, so the renderer falls back to the bundled font chain.
  font: { resolve(family: string): Promise<Uint8Array | null> }
  /// Native GPU-decode preview (Windows). Session commands only — per-frame
  /// `ImageBitmap`s do NOT travel over this bridge (a MessagePort/frame can't
  /// cross contextBridge). Instead `requestPort(streamId)` hands a MessagePort to
  /// the main world via `window.postMessage`, over which the preload posts that
  /// stream's decoded frames; the renderer listens for the one-time port message
  /// then reads frames off `port.onmessage`. consumeAck is deliberately NOT
  /// exposed here: the preload fires it, either itself or when the renderer
  /// reports a slot's read complete over that same port (`PreviewGpuSlotAck`),
  /// which reaches only the stream whose channel carried it.
  previewGpu: {
    open(args: {
      streamId: string
      path: string
      poolSize: number
      colorSpace: PreviewGpuColorSpace
      /// Renderer-probed coded dimensions reserved by main before native open.
      codedWidth: number
      codedHeight: number
    }): Promise<PreviewGpuOpenReply>
    requestFrameAt(args: { streamId: string; targetUs: number }): Promise<void>
    close(args: { streamId: string }): Promise<void>
    /// One channel PER stream. The handoff post carries `streamId` so a listener
    /// can tell its own port from another concurrent session's — the post is a
    /// broadcast every live transport hears. The channel is bidirectional: under
    /// `rendererFence` the renderer sends slot acks back up it
    /// (`PreviewGpuSlotAck`), the only traffic that flows that way.
    requestPort(streamId: string): void
    /// Live preview-GPU admission budget (see `PreviewGpuBudgetSnapshot`).
    /// Diagnostics —
    /// the open gate in main is still the authority; a caller must not pre-check
    /// this and skip the open.
    budget(): Promise<PreviewGpuBudgetSnapshot>
    /// E2E/bench-only: drain this session's per-frame timing samples. Rejects
    /// for an unknown stream, or with "preview-gpu not built" off the native path.
    takeTimings(streamId: string): Promise<PreviewGpuTimingReport>
    /// E2E/bench-only: drain the MAIN-measured renderer round-trip samples.
    takeMainTimings(): Promise<PreviewGpuMainTiming>
  }
  /// Native SOFTWARE-decode preview (ProRes/DNxHD/MPEG-2/VC-1 — the
  /// WebCodecs-blind-format path). Unlike previewGpu, decoded frames DO cross
  /// the contextBridge directly: each is a plain NV12 buffer (no shared
  /// texture / MessagePort dance needed), delivered on the dedicated
  /// `previewSw:frame` channel (NOT the generic `evt:*` relay) and surfaced via
  /// `onFrame`.
  previewSw: {
    /// `lane`/`device` select the Standard engine's hardware copy-back lane
    /// (Linux NVDEC/VAAPI; `device` = the DRM node for VAAPI). Absent/null =
    /// software. This is the private HW-vs-SW choice — the frame contract the
    /// session emits is unchanged NV12 either way.
    ///
    /// `scaleDiv` is the playback-resolution divisor (1 | 2 | 4; absent = 1 =
    /// full): native downscales each frame BEFORE it crosses IPC, so the reply
    /// and every `PreviewSwFrameMsg` carry the SHIPPED dimensions, which can be
    /// smaller than the media's.
    ///
    /// `cadenceDiv` is preview-only (absent = 1 = every frame). Native decodes
    /// every frame for reference correctness, then skips unselected frames
    /// before copy-back/scale/packing and IPC.
    open(args: { streamId: string; path: string; lane?: string | null; device?: string | null; scaleDiv?: number | null; cadenceDiv?: number | null }): Promise<{ width: number; height: number }>
    requestFrameAt(args: { streamId: string; targetUs: number }): void
    close(args: { streamId: string }): void
    onFrame(cb: (f: PreviewSwFrameMsg) => void): () => void
  }
  /// Native SOFTWARE export-decode relay (blind-spot originals: ProRes/DNxHD/
  /// MPEG-2/VC-1). The EXPORT-side mirror of `previewSw` and the reverse of the
  /// encode chunk channel: frames AND control signals (rangeEnd/ended/error)
  /// flow main → renderer here as tagged `ExportSwMsg`s on the ONE dedicated
  /// `exportSw:msg` channel (surfaced via `onMsg`), while `decodeRange` /
  /// `returnCredit` / `close` are fire-and-forget renderer → main commands. The
  /// renderer main thread is a pure relay between the export Worker's
  /// `NativeExportSourceHandle` and the main-process `NativeDecode` session; the
  /// Worker itself has no bridge. The single ordered channel is the contract
  /// (see `ExportSwMsg`); nothing exportSw rides the generic `evt:*` relay.
  exportSw: {
    open(args: {
      sessionId: string
      path: string
      /// CPU transport format for the session's frames: NV12 (8-bit) or
      /// I420P10 (the 10-bit lane; layout documented on `ExportSwFrameMsg`).
      outFormat: 'NV12' | 'I420P10'
      creditWindow: number
    }): Promise<ExportSwOpenReply>
    decodeRange(args: { sessionId: string; aUs: number; bUs: number }): void
    returnCredit(args: { sessionId: string; credits: number }): void
    close(args: { sessionId: string }): void
    /// Reap EVERY still-open export session. The renderer calls this when an
    /// export ends (done / error / cancel): a Worker terminated mid-teardown
    /// may never send its per-session `close`, so main must be able to close
    /// them independently or the native decode threads leak. Idempotent.
    closeAll(): void
    onMsg(cb: (m: ExportSwMsg) => void): () => void
  }
  /// Availability of the optional @weftcut/native-decode component (level-0
  /// gate). The renderer pulls this once on mount (availability is fixed for a
  /// process lifetime — the require is memoized in main).
  decodeComponent: { status(): Promise<DecodeComponentStatus> }
  /// Machine capability probe: runs the SW decode probe on `path` and
  /// returns the cache-informed verdict for that file's format class.
  /// `probeHw` is the GPU-keyed HW-lane counterpart: caller supplies
  /// `classKey` (probing is expensive, so the cache must be consulted before
  /// deciding to probe, not after).
  decodeCap: {
    probeSw(path: string): Promise<DecodeCapabilityProbeResult>
    probeHw(path: string, classKey: string): Promise<DecodeHwProbeResult>
  }
  /// User-managed data location (ticket 03). Main-process actions (not backend
  /// commands): report the effective root, pick+migrate to a new root
  /// (copy/verify/rollback or adopt, progress on `evt:dataRoot:progress`),
  /// relaunch onto it, open it in the file manager, and the post-relaunch
  /// delete-the-old-copy flow. `relaunch` is separate from `pickAndMigrate` so
  /// the UI controls timing (show success, then relaunch).
  dataRoot: {
    current(): Promise<DataRootCurrent>
    pickAndMigrate(): Promise<DataRootMigrateResult>
    relaunch(): Promise<void>
    openFolder(): Promise<void>
    pendingCleanup(): Promise<DataRootPendingCleanup | null>
    deleteOld(): Promise<void>
    dismissCleanup(): Promise<void>
  }
  on(event: string, cb: (payload: unknown) => void): () => void
  off(event: string): void
  /// Broadcast an event to every app window (delivered to `on()` subscribers as
  /// `evt:<event>`). Backs the renderer's cross-window `emit()` (bridge/events.ts).
  emit(event: string, payload?: unknown): Promise<void>
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
}
