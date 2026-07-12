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

/// An app-level notice surfaced to the user (non-modal corner panel). `code`
/// keys the i18n strings + the dismissable UI; main collects these at startup
/// (e.g. keyring-unavailable → plaintext cloud keys) and the renderer PULLS them
/// on mount via `app.notices()` — a pull model so a notice can't be lost to the
/// fire-once-before-subscribe race a pushed event had.
export type AppNotice = { level: 'info' | 'warn' | 'error'; code: string }

/// Color-space tag for a native GPU-preview shared-texture import. Mirrors
/// Electron's `ColorSpace` structure (main passes it straight to
/// `importSharedTexture`); typed structurally here so this DOM/electron-free
/// contract file stays free of the Electron types. Task 7 supplies the enum
/// values (e.g. bt709/limited) from the source's color metadata.
export type PreviewGpuColorSpace = {
  primaries: string
  transfer: string
  matrix: string
  range: 'limited' | 'full' | 'derived' | 'invalid'
}

/// Reply of `previewGpu.open`: decoded stream dimensions + the realized pool
/// size (native may hand back fewer slots than requested).
export type PreviewGpuOpenReply = { width: number; height: number; poolSize: number }

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
/// than pool-full). See docs/superpowers/decode-bench-throughput-bottleneck-handoff.md.
export type PreviewGpuTimingReport = {
  coordRtt: PreviewGpuTimingSummary
  decodeCopy: PreviewGpuTimingSummary
  ackToEmit: PreviewGpuTimingSummary
  lookaheadGatedSkips: number
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
/// runs the one-frame d3d11va decode probe for a caller-supplied `classKey`
/// (the renderer derives it from `MediaSummary` — the HW probe itself does
/// not, unlike the SW probe, since probing is comparatively expensive).
export interface DecodeHwProbeResult {
  ok: boolean
  reason: string | null
}

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
  /// cross contextBridge). Instead `requestPort()` hands a MessagePort to the
  /// main world via `window.postMessage`, over which the preload posts each
  /// decoded frame; the renderer (Task 7) listens for the one-time port message
  /// then reads frames off `port.onmessage`. consumeAck is preload-internal
  /// (fired after createImageBitmap), so it is deliberately NOT exposed here.
  previewGpu: {
    open(args: {
      streamId: string
      path: string
      poolSize: number
      colorSpace: PreviewGpuColorSpace
    }): Promise<PreviewGpuOpenReply>
    requestFrameAt(args: { streamId: string; targetUs: number }): Promise<void>
    close(args: { streamId: string }): Promise<void>
    requestPort(): void
    /// E2E/bench-only: drain this session's Stage-3 timing samples. Rejects for
    /// an unknown stream, or with "preview-gpu not built" off the native path.
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
    open(args: { streamId: string; path: string }): Promise<{ width: number; height: number }>
    requestFrameAt(args: { streamId: string; targetUs: number }): void
    close(args: { streamId: string }): void
    onFrame(cb: (f: PreviewSwFrameMsg) => void): () => void
  }
  /// Availability of the optional @weftcut/native-decode component (level-0
  /// gate). The renderer pulls this once on mount (availability is fixed for a
  /// process lifetime — the require is memoized in main).
  decodeComponent: { status(): Promise<DecodeComponentStatus> }
  /// Machine capability probe (D3): runs the SW decode probe on `path` and
  /// returns the cache-informed verdict for that file's format class.
  /// `probeHw` (D4) is the GPU-keyed HW-lane counterpart: caller supplies
  /// `classKey` (probing is expensive, so the cache must be consulted before
  /// deciding to probe, not after).
  decodeCap: {
    probeSw(path: string): Promise<DecodeCapabilityProbeResult>
    probeHw(path: string, classKey: string): Promise<DecodeHwProbeResult>
  }
  on(event: string, cb: (payload: unknown) => void): () => void
  off(event: string): void
  /// Broadcast an event to every app window (delivered to `on()` subscribers as
  /// `evt:<event>`). Backs the renderer's cross-window `emit()` (bridge/events.ts).
  emit(event: string, payload?: unknown): Promise<void>
  videoSinkWrite(bytes: ArrayBuffer | ArrayBufferView): Promise<void>
}
