// Window geometry (position + size + maximize/fullscreen) persisted at
// <userData>/window_geometry.json, owned by the Electron main process. One
// document across every project — a window move can never dirty the Project or
// enter undo, exactly like the Workspace layout document (workspace.ts).
//
// Kept electron-free (operates on plain rects, returns plain objects) so the
// sanitize rules are unit-testable without launching a BrowserWindow or a
// display — same rule as windowConfig.ts / metrics.ts. The electron contact
// points (screen.getAllDisplays, BrowserWindow event wiring) live in windows.ts.
//
// LANDMINE: a saved rect is NOT trustworthy. It may name a monitor that has
// since been unplugged, or a resolution that has shrunk. Restoring it blindly
// opens the window off-screen — and this app is FRAMELESS on Windows/Linux, so
// there is no OS titlebar and no system "Move" menu to recover with: the window
// becomes unreachable and the user's only fix is deleting a JSON file they don't
// know about. Every read therefore goes through `sanitizeGeometry`, which falls
// back to a centered default rather than hand back an unreachable rect.
//
// Writes are DEBOUNCED (a drag emits `move` continuously) and buffered in
// memory; `flush()` forces the pending write and MUST be called on window close
// and before application quit (index.ts), or the last move would be lost.
//
// The on-disk file path + JSON field names are a COMPATIBILITY SURFACE.

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface WindowGeometryFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What we persist per window. `bounds` is always the NORMAL (un-maximized,
 *  un-fullscreened) rect — see `windows.ts` on getNormalBounds(). */
export interface WindowGeometry {
  bounds: Rect
  maximized: boolean
  fullScreen: boolean
}

/** The subset of Electron's `Display` this module needs. `workArea` (not
 *  `bounds`) is the correct reference: it excludes the taskbar/dock, so a
 *  restored window never hides under the shelf. */
export interface DisplayLike {
  workArea: Rect
}

/** Fallback sizing when there is nothing usable to restore. Mirrors the
 *  hard-coded defaults + minimums the main window ships with. */
export interface GeometryDefaults {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** BrowserWindow constructor options this module produces. `x`/`y` are omitted
 *  (not null) when we decline to restore a position, which is what makes
 *  Chromium fall back to its default centered placement. */
export interface RestoredGeometry {
  x?: number
  y?: number
  width: number
  height: number
  /** Apply with `win.maximize()` AFTER construction — BrowserWindow has no
   *  `maximized` option. */
  maximized: boolean
  /** Pass straight through as the `fullscreen` constructor option. */
  fullScreen: boolean
}

/// A restored window must expose at least this much of itself on ONE display's
/// work area, or we treat the rect as unreachable and re-center.
///
/// This is where we DIVERGE from electron-window-state, whose
/// `ensureWindowVisibleOnSomeDisplay` requires the saved rect to be FULLY
/// contained in a single display. That rule discards two placements users make
/// on purpose: a window straddling two monitors, and one nudged a few pixels
/// past an edge. Requiring a grabbable strip instead (rather than total
/// containment) keeps those while still rejecting a genuinely off-screen rect.
///
/// The height floor must clear our titlebar (~30–37px), since on Windows/Linux
/// that renderer-drawn bar is the ONLY way to drag the window back.
const MIN_VISIBLE_WIDTH_PX = 120
const MIN_VISIBLE_HEIGHT_PX = 48

const DOC_VERSION = 1

/// LANDMINE — the save/restore RATCHET. Electron's bounds API is NOT idempotent
/// on a fractionally-scaled display: hand a rect to the BrowserWindow
/// constructor and the value that comes back out differs, because the DIP↔
/// physical-pixel conversion rounds in both directions. Measured on a Windows
/// display at scaleFactor 1.1, feeding each accessor's own output back into the
/// constructor five times:
///
///   ctor → getBounds          1182 → 1189 → 1196 → 1202 → 1209 → 1216
///   ctor → getContentBounds   1182 → 1188 → 1193 → 1199 → 1203 → 1209
///   setBounds → getBounds     1182 → 1184 → 1186 → 1188 → 1190 → 1192
///
/// Monotonic, no convergence, for EVERY accessor pair — so this cannot be fixed
/// by picking a different one (useContentSize included). A naive
/// save-what-you-measure implementation therefore grows the window a few pixels
/// per launch until it hits the screen edge; electron-window-state has exactly
/// this defect. The loop has to be broken instead: `withinDeadband` lets the
/// caller keep persisting the rect it REQUESTED while the measured rect differs
/// only by that rounding slop.
///
/// The threshold must exceed the slop (7px observed at the near-worst-case scale
/// factor — the non-client inset shrinks in DIP as the scale grows, and rounds
/// exactly at 1.0×) while staying below any resize a user would notice losing.
/// The cost is bounded and one-shot: see `rememberGeometry` in windows.ts, which
/// abandons the deadband permanently after the first real resize.
export const BOUNDS_DEADBAND_PX = 16

/// Whether `measured` differs from `requested` only by DPI rounding slop — i.e.
/// the window is still where we put it and no user resize has happened.
export function withinDeadband(measured: Rect, requested: Rect): boolean {
  return (
    Math.abs(measured.x - requested.x) <= BOUNDS_DEADBAND_PX &&
    Math.abs(measured.y - requested.y) <= BOUNDS_DEADBAND_PX &&
    Math.abs(measured.width - requested.width) <= BOUNDS_DEADBAND_PX &&
    Math.abs(measured.height - requested.height) <= BOUNDS_DEADBAND_PX
  )
}

/** On-disk envelope. Keyed by window label (`main`, and any secondary window
 *  that opts in later) so adding one is additive — no schema migration. */
interface GeometryFile {
  version: number
  windows: Record<string, PersistedGeometry>
}

/** Flat per-window record. Deliberately flat rather than nesting `bounds`, so a
 *  hand-edit or a partial write degrades field-by-field. */
interface PersistedGeometry {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  full_screen: boolean
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Overlap of two rects along one axis; 0 when they don't intersect. */
function overlap1d(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart))
}

/** Visible width × height of `rect` inside `area`. Both axes matter
 *  independently: a window sharing 500px of width but 0px of height with a
 *  display shows nothing. */
export function visibleExtent(rect: Rect, area: Rect): { width: number; height: number } {
  return {
    width: overlap1d(rect.x, rect.width, area.x, area.width),
    height: overlap1d(rect.y, rect.height, area.y, area.height),
  }
}

/** The display presenting the most of `rect`, or null when no display shows a
 *  grabbable strip of it (every monitor it lived on is gone or has shrunk). */
export function bestDisplayFor(rect: Rect, displays: readonly DisplayLike[]): DisplayLike | null {
  let best: DisplayLike | null = null
  let bestArea = 0
  for (const display of displays) {
    const visible = visibleExtent(rect, display.workArea)
    if (visible.width < MIN_VISIBLE_WIDTH_PX || visible.height < MIN_VISIBLE_HEIGHT_PX) continue
    const area = visible.width * visible.height
    if (area > bestArea) {
      bestArea = area
      best = display
    }
  }
  return best
}

/** Defaults with NO position — Chromium centers a window whose x/y are absent. */
function centeredDefault(defaults: GeometryDefaults): RestoredGeometry {
  return {
    width: defaults.width,
    height: defaults.height,
    maximized: false,
    fullScreen: false,
  }
}

/// Turn a (possibly stale, possibly hand-mangled) saved geometry into
/// BrowserWindow constructor options that are guaranteed reachable on the
/// CURRENT display set.
///
/// `platform` gates fullscreen restore only: on Windows/Linux this app reaches
/// fullscreen exclusively through the dev-gated F11 accelerator (inputPolicy's
/// matchDevKeyAction), so a production build offers the user no way OUT of it —
/// restoring a stale `full_screen: true` there would trap them in a frameless
/// fullscreen window with no caption buttons. macOS keeps it: the native green
/// traffic light both enters and leaves fullscreen, and reopening into the
/// fullscreen Space is what a native macOS app does.
export function sanitizeGeometry(
  saved: WindowGeometry | null,
  displays: readonly DisplayLike[],
  defaults: GeometryDefaults,
  platform: NodeJS.Platform = process.platform,
): RestoredGeometry {
  if (!saved) return centeredDefault(defaults)
  const { x, y, width, height } = saved.bounds
  if (!isFiniteInt(x) || !isFiniteInt(y) || !isFiniteInt(width) || !isFiniteInt(height)) {
    return centeredDefault(defaults)
  }
  // No display set (headless / racing app-ready) — keep the size, drop the
  // position rather than gamble on coordinates we cannot validate.
  if (displays.length === 0) return centeredDefault(defaults)

  // Electron wants integers; a fractional rect (a saved fractional-DPI bounds)
  // drifts by a pixel per restore on Windows.
  const rounded: Rect = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }

  // Clamp the SIZE before choosing a display: a rect saved on a 4K monitor must
  // not stay 3000×2000 once the only screen left is 1080p. Upper bound is the
  // largest work area available, so a genuinely large monitor is not punished
  // for a small one also being attached; the per-display clamp happens below.
  const widestWorkArea = Math.max(...displays.map((d) => d.workArea.width))
  const tallestWorkArea = Math.max(...displays.map((d) => d.workArea.height))
  const sized: Rect = {
    ...rounded,
    width: Math.min(Math.max(rounded.width, defaults.minWidth), widestWorkArea),
    height: Math.min(Math.max(rounded.height, defaults.minHeight), tallestWorkArea),
  }

  const display = bestDisplayFor(sized, displays)
  if (!display) return centeredDefault(defaults)

  // Now that a host display is known, clamp to ITS work area so the window is
  // never larger than the screen it opens on. Honors the minimums even on a
  // display smaller than them (a too-small display is the lesser evil versus a
  // window whose own minimum size it cannot satisfy).
  const finalWidth = Math.min(Math.max(sized.width, defaults.minWidth), Math.max(display.workArea.width, defaults.minWidth))
  const finalHeight = Math.min(Math.max(sized.height, defaults.minHeight), Math.max(display.workArea.height, defaults.minHeight))

  // Position is kept AS SAVED — it already passed the grabbable-strip test, so
  // a deliberately straddling or edge-hugging window survives a restart. Only a
  // shrink triggered above can move it, and only to keep the strip visible.
  const position = { x: sized.x, y: sized.y }
  const shrunk = finalWidth !== sized.width || finalHeight !== sized.height
  if (shrunk) {
    const reduced: Rect = { ...position, width: finalWidth, height: finalHeight }
    if (!bestDisplayFor(reduced, displays)) {
      // The clamp ate the visible strip — re-seat inside the host work area.
      position.x = Math.max(display.workArea.x, Math.min(position.x, display.workArea.x + display.workArea.width - finalWidth))
      position.y = Math.max(display.workArea.y, Math.min(position.y, display.workArea.y + display.workArea.height - finalHeight))
    }
  }

  // fullScreen wins over maximized when a hand-edited file sets both: it is the
  // more specific state, and `maximize()` on a fullscreen window is a no-op.
  const fullScreen = saved.fullScreen === true && platform === 'darwin'
  return {
    ...position,
    width: finalWidth,
    height: finalHeight,
    maximized: !fullScreen && saved.maximized === true,
    fullScreen,
  }
}

export interface WindowGeometryStore {
  /** The saved geometry for `label` — the buffered value if a write is pending,
   *  else disk. null when nothing usable is stored. */
  get(label: string): WindowGeometry | null
  /** Buffer `geometry` for `label` and schedule one debounced disk write. */
  remember(label: string, geometry: WindowGeometry): void
  /** Force any pending debounced write to disk now (no-op when nothing pending). */
  flush(): void
}

/** Injected timer seam — real setTimeout in production, controllable in tests. */
export interface GeometryTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/// A window drag emits `move` on every pointer tick; 500ms matches the
/// Workspace store's autosave debounce so both flush on the same quit hook.
const DEFAULT_DEBOUNCE_MS = 500

const defaultTimer: GeometryTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function toPersisted(geometry: WindowGeometry): PersistedGeometry {
  return {
    x: Math.round(geometry.bounds.x),
    y: Math.round(geometry.bounds.y),
    width: Math.round(geometry.bounds.width),
    height: Math.round(geometry.bounds.height),
    maximized: geometry.maximized === true,
    full_screen: geometry.fullScreen === true,
  }
}

function fromPersisted(raw: unknown): WindowGeometry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isFiniteInt(r['x']) || !isFiniteInt(r['y'])) return null
  if (!isFiniteInt(r['width']) || !isFiniteInt(r['height'])) return null
  if (r['width'] <= 0 || r['height'] <= 0) return null
  return {
    bounds: { x: r['x'], y: r['y'], width: r['width'], height: r['height'] },
    maximized: r['maximized'] === true,
    fullScreen: r['full_screen'] === true,
  }
}

export function createWindowGeometryStore(deps: {
  fs: WindowGeometryFs
  path: string
  dir: string
  debounceMs?: number
  timer?: GeometryTimer
}): WindowGeometryStore {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const timer = deps.timer ?? defaultTimer

  // The latest document not yet on disk. null → disk is authoritative.
  let pending: GeometryFile | null = null
  let handle: unknown = null

  function emptyDoc(): GeometryFile {
    return { version: DOC_VERSION, windows: {} }
  }

  /// Bad-config recovery: a missing / empty / corrupt file degrades to "nothing
  /// saved" (→ centered defaults) so a hand-edit mishap can't brick the editor.
  function readDisk(): GeometryFile {
    if (!deps.fs.exists(deps.path)) return emptyDoc()
    let body: string
    try {
      body = deps.fs.readFile(deps.path)
    } catch (e) {
      console.warn(`[window-geometry] read ${deps.path}:`, e)
      return emptyDoc()
    }
    if (body.trim() === '') return emptyDoc()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (e) {
      console.warn(`[window-geometry] parse ${deps.path}:`, e)
      return emptyDoc()
    }
    if (!parsed || typeof parsed !== 'object') return emptyDoc()
    const windows = (parsed as Record<string, unknown>)['windows']
    if (!windows || typeof windows !== 'object') return emptyDoc()
    // Per-window validation, not whole-document rejection: one mangled entry
    // must not cost the other windows their geometry.
    const out: Record<string, PersistedGeometry> = {}
    for (const [label, raw] of Object.entries(windows as Record<string, unknown>)) {
      const geometry = fromPersisted(raw)
      if (geometry) out[label] = toPersisted(geometry)
    }
    return { version: DOC_VERSION, windows: out }
  }

  function currentDoc(): GeometryFile {
    return pending ?? readDisk()
  }

  function writeDisk(doc: GeometryFile): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(doc, null, 2))
    deps.fs.rename(tmp, deps.path) // atomic promote
  }

  function clearTimer(): void {
    if (handle !== null) {
      timer.clear(handle)
      handle = null
    }
  }

  /// BEST-EFFORT: geometry is a convenience, never worth surfacing an error or
  /// blocking quit for. Log and swallow.
  function flush(): void {
    clearTimer()
    if (pending === null) return
    const doc = pending
    pending = null
    try {
      writeDisk(doc)
    } catch (e) {
      console.warn(`[window-geometry] write ${deps.path}:`, e)
    }
  }

  return {
    get(label) {
      const entry = currentDoc().windows[label]
      return entry ? fromPersisted(entry) : null
    },

    remember(label, geometry) {
      const doc = currentDoc()
      pending = {
        version: DOC_VERSION,
        windows: { ...doc.windows, [label]: toPersisted(geometry) },
      }
      clearTimer()
      handle = timer.set(() => {
        handle = null
        flush()
      }, debounceMs)
    },

    flush,
  }
}
