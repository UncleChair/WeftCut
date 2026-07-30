import { describe, it, expect, vi } from 'vitest'
import {
  BOUNDS_DEADBAND_PX,
  createWindowGeometryStore,
  sanitizeGeometry,
  visibleExtent,
  withinDeadband,
  type DisplayLike,
  type GeometryTimer,
  type WindowGeometry,
  type WindowGeometryFs,
} from './windowGeometry'

// Mirrors MAIN_WINDOW_GEOMETRY_DEFAULTS — kept local so a change to the real
// window's size doesn't silently rewrite what these cases assert.
const DEFAULTS = { width: 1440, height: 900, minWidth: 960, minHeight: 640 }

/** A 1920×1080 primary with a taskbar-reduced work area. */
const PRIMARY: DisplayLike = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
/** A second monitor to the right of PRIMARY, same size. */
const RIGHT: DisplayLike = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }

function saved(bounds: { x: number; y: number; width: number; height: number }, flags?: Partial<WindowGeometry>): WindowGeometry {
  return { bounds, maximized: false, fullScreen: false, ...flags }
}

describe('visibleExtent', () => {
  it('measures each axis independently', () => {
    // A window can share width with a display yet show nothing, because the
    // vertical overlap is zero. One combined "area" number would hide that.
    const rect = { x: 0, y: 2000, width: 1000, height: 700 }
    expect(visibleExtent(rect, PRIMARY.workArea)).toEqual({ width: 1000, height: 0 })
  })

  it('reports zero for a rect entirely outside', () => {
    expect(visibleExtent({ x: 5000, y: 5000, width: 100, height: 100 }, PRIMARY.workArea)).toEqual({
      width: 0,
      height: 0,
    })
  })
})

describe('withinDeadband', () => {
  const requested = { x: 60, y: 40, width: 1182, height: 761 }

  it('absorbs the DPI readback slop that Electron adds to a requested rect', () => {
    // Measured on Windows at scaleFactor 1.1: ask the constructor for 1182×761
    // and getBounds() reports 1189×766. Treating that as a user resize is what
    // makes the window grow every launch.
    expect(withinDeadband({ x: 60, y: 40, width: 1189, height: 766 }, requested)).toBe(true)
  })

  it('treats a real resize as a real resize', () => {
    expect(withinDeadband({ ...requested, width: 1400 }, requested)).toBe(false)
    expect(withinDeadband({ ...requested, height: 900 }, requested)).toBe(false)
  })

  it('treats a real move as a real move', () => {
    expect(withinDeadband({ ...requested, x: 600 }, requested)).toBe(false)
    expect(withinDeadband({ ...requested, y: 400 }, requested)).toBe(false)
  })

  it('is inclusive at the threshold and exclusive one past it', () => {
    const at = { ...requested, width: requested.width + BOUNDS_DEADBAND_PX }
    const past = { ...requested, width: requested.width + BOUNDS_DEADBAND_PX + 1 }
    expect(withinDeadband(at, requested)).toBe(true)
    expect(withinDeadband(past, requested)).toBe(false)
  })

  it('flags a rect that drifted on every axis at once', () => {
    // Each axis is compared independently: a rect inside the band on three axes
    // and outside on one is still a real change.
    expect(withinDeadband({ x: 60, y: 40, width: 1189, height: 1200 }, requested)).toBe(false)
  })

  it('keeps the threshold above the observed slop with headroom', () => {
    // Regression guard on the constant itself: the measured ratchet step was 7px
    // of width / 5px of height. Shrinking the band below that reopens the drift.
    expect(BOUNDS_DEADBAND_PX).toBeGreaterThanOrEqual(14)
  })
})

describe('sanitizeGeometry — falling back', () => {
  it('omits x/y entirely when nothing is saved, so Chromium centers', () => {
    const g = sanitizeGeometry(null, [PRIMARY], DEFAULTS, 'win32')
    // `undefined`, not 0 — an explicit x:0 would pin the window to the corner.
    expect(g.x).toBeUndefined()
    expect(g.y).toBeUndefined()
    expect(g).toMatchObject({ width: 1440, height: 900, maximized: false, fullScreen: false })
  })

  it('rejects non-finite coordinates from a hand-edited file', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const g = sanitizeGeometry(saved({ x: bad, y: 0, width: 1280, height: 800 }), [PRIMARY], DEFAULTS, 'win32')
      expect(g.x).toBeUndefined()
      expect(g.width).toBe(1440)
    }
  })

  it('rejects a rect whose monitor has been unplugged', () => {
    // Saved on a second monitor at x=1920 that is no longer attached.
    const g = sanitizeGeometry(saved({ x: 2200, y: 300, width: 1280, height: 800 }), [PRIMARY], DEFAULTS, 'win32')
    expect(g.x).toBeUndefined()
    expect(g.width).toBe(1440)
  })

  it('rejects a rect with only a sliver on screen', () => {
    // 40px of width visible — far too little to grab a frameless window by.
    const g = sanitizeGeometry(saved({ x: 1880, y: 200, width: 1000, height: 700 }), [PRIMARY], DEFAULTS, 'win32')
    expect(g.x).toBeUndefined()
  })

  it('drops the position but keeps default sizing when no display is enumerated', () => {
    const g = sanitizeGeometry(saved({ x: 10, y: 10, width: 1280, height: 800 }), [], DEFAULTS, 'win32')
    expect(g.x).toBeUndefined()
    expect(g).toMatchObject({ width: 1440, height: 900 })
  })
})

describe('sanitizeGeometry — restoring', () => {
  it('restores a wholly on-screen rect verbatim', () => {
    const g = sanitizeGeometry(saved({ x: 100, y: 80, width: 1280, height: 800 }), [PRIMARY], DEFAULTS, 'win32')
    expect(g).toEqual({ x: 100, y: 80, width: 1280, height: 800, maximized: false, fullScreen: false })
  })

  it('keeps a window straddling two monitors', () => {
    // The DIVERGENCE from electron-window-state, whose full-containment rule
    // would discard this deliberate placement and re-center.
    const g = sanitizeGeometry(saved({ x: 1600, y: 100, width: 1000, height: 700 }), [PRIMARY, RIGHT], DEFAULTS, 'win32')
    expect(g).toMatchObject({ x: 1600, y: 100, width: 1000, height: 700 })
  })

  it('keeps a window nudged past the right edge while a grabbable strip remains', () => {
    // 170px visible — enough to drag back, so respect the user's placement.
    const g = sanitizeGeometry(saved({ x: 1750, y: 200, width: 1000, height: 700 }), [PRIMARY], DEFAULTS, 'win32')
    expect(g).toMatchObject({ x: 1750, y: 200 })
  })

  it('rounds fractional bounds to integers', () => {
    // A fractional-DPI rect drifts a pixel per restore if passed through raw.
    const g = sanitizeGeometry(saved({ x: 100.6, y: 80.4, width: 1280.5, height: 800.5 }), [PRIMARY], DEFAULTS, 'win32')
    expect(g).toMatchObject({ x: 101, y: 80, width: 1281, height: 801 })
  })
})

describe('sanitizeGeometry — clamping size', () => {
  it('shrinks a rect saved on a larger monitor to fit the one that is left', () => {
    const small: DisplayLike = { workArea: { x: 0, y: 0, width: 1366, height: 728 } }
    const g = sanitizeGeometry(saved({ x: 0, y: 0, width: 3000, height: 2000 }), [small], DEFAULTS, 'win32')
    expect(g).toMatchObject({ width: 1366, height: 728 })
  })

  it('raises a rect below the window minimums', () => {
    const g = sanitizeGeometry(saved({ x: 100, y: 100, width: 400, height: 300 }), [PRIMARY], DEFAULTS, 'win32')
    expect(g).toMatchObject({ width: 960, height: 640 })
  })

  it('honors the minimums even on a display too small to hold them', () => {
    // A window that cannot satisfy its own minWidth/minHeight is worse than one
    // slightly larger than a cramped screen.
    const tiny: DisplayLike = { workArea: { x: 0, y: 0, width: 800, height: 500 } }
    const g = sanitizeGeometry(saved({ x: 0, y: 0, width: 700, height: 400 }), [tiny], DEFAULTS, 'win32')
    expect(g).toMatchObject({ width: 960, height: 640 })
  })

  it('clamps to the HOST display, not the largest attached one', () => {
    const big: DisplayLike = { workArea: { x: 0, y: 0, width: 3840, height: 2100 } }
    const small: DisplayLike = { workArea: { x: 3840, y: 0, width: 1280, height: 700 } }
    // Lives on `small`; must not keep `big`'s dimensions.
    const g = sanitizeGeometry(saved({ x: 4000, y: 100, width: 3000, height: 2000 }), [big, small], DEFAULTS, 'win32')
    expect(g).toMatchObject({ width: 1280, height: 700 })
  })

  it('re-seats the window when the size clamp eats its visible strip', () => {
    const big: DisplayLike = { workArea: { x: 0, y: 0, width: 3840, height: 2100 } }
    const small: DisplayLike = { workArea: { x: 3840, y: 0, width: 1280, height: 700 } }
    // y=-660 leaves 700px visible at height 2000, but only 40px once clamped to
    // 700 — below the floor, so the rect must be pulled inside the work area.
    const g = sanitizeGeometry(saved({ x: 4000, y: -660, width: 3000, height: 2000 }), [big, small], DEFAULTS, 'win32')
    expect(g).toEqual({ x: 3840, y: 0, width: 1280, height: 700, maximized: false, fullScreen: false })
  })
})

describe('sanitizeGeometry — maximize and fullscreen', () => {
  it('passes the maximized flag through', () => {
    const g = sanitizeGeometry(saved({ x: 100, y: 80, width: 1280, height: 800 }, { maximized: true }), [PRIMARY], DEFAULTS, 'win32')
    expect(g.maximized).toBe(true)
    // The normal rect rides along so "restore down" lands where the user left it.
    expect(g).toMatchObject({ x: 100, y: 80, width: 1280, height: 800 })
  })

  it('restores fullscreen on macOS', () => {
    const g = sanitizeGeometry(saved({ x: 0, y: 0, width: 1280, height: 800 }, { fullScreen: true }), [PRIMARY], DEFAULTS, 'darwin')
    expect(g.fullScreen).toBe(true)
  })

  it('never restores fullscreen on Windows or Linux', () => {
    // F11 is dev-gated (inputPolicy.matchDevKeyAction), so a production build
    // gives the user no way out of a frameless fullscreen window.
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const g = sanitizeGeometry(saved({ x: 0, y: 0, width: 1280, height: 800 }, { fullScreen: true }), [PRIMARY], DEFAULTS, platform)
      expect(g.fullScreen).toBe(false)
    }
  })

  it('lets fullscreen win over maximized when a file claims both', () => {
    const both = saved({ x: 0, y: 0, width: 1280, height: 800 }, { maximized: true, fullScreen: true })
    const mac = sanitizeGeometry(both, [PRIMARY], DEFAULTS, 'darwin')
    expect(mac).toMatchObject({ fullScreen: true, maximized: false })
    // Off macOS the dropped fullscreen must not take maximized down with it.
    const win = sanitizeGeometry(both, [PRIMARY], DEFAULTS, 'win32')
    expect(win).toMatchObject({ fullScreen: false, maximized: true })
  })
})

// ─── store ────────────────────────────────────────────────────────────────────

const FILE = '/userData/window_geometry.json'

function fakeFs(): WindowGeometryFs & {
  files: Map<string, string>
  dirs: Set<string>
  renames: [string, string][]
} {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const renames: [string, string][] = []
  return {
    files,
    dirs,
    renames,
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    writeFile: (p, t) => void files.set(p, t),
    rename: (a, b) => {
      files.set(b, files.get(a)!)
      files.delete(a)
      renames.push([a, b])
    },
    mkdirp: (d) => void dirs.add(d),
  }
}

function fakeTimer(): GeometryTimer & { run(): void; scheduled(): boolean } {
  let cb: (() => void) | null = null
  return {
    set: (callback) => {
      cb = callback
      return 1
    },
    clear: () => void (cb = null),
    run: () => {
      const c = cb
      cb = null
      c?.()
    },
    scheduled: () => cb !== null,
  }
}

function makeStore(fs = fakeFs(), timer = fakeTimer()) {
  const store = createWindowGeometryStore({ fs, path: FILE, dir: '/userData', timer })
  return { store, fs, timer }
}

const GEOM: WindowGeometry = {
  bounds: { x: 200, y: 150, width: 1600, height: 1000 },
  maximized: true,
  fullScreen: false,
}

describe('createWindowGeometryStore', () => {
  it('returns null when nothing has ever been saved', () => {
    const { store } = makeStore()
    expect(store.get('main')).toBeNull()
  })

  it('serves a buffered write before it reaches disk', () => {
    const { store, fs } = makeStore()
    store.remember('main', GEOM)
    // Read-your-writes: the debounce must not make get() lag behind.
    expect(store.get('main')).toEqual(GEOM)
    expect(fs.files.has(FILE)).toBe(false)
  })

  it('promotes the file atomically (temp + rename)', () => {
    const { store, fs, timer } = makeStore()
    store.remember('main', GEOM)
    timer.run()
    // A direct overwrite could truncate the live file if the process dies
    // mid-write; every config store here writes temp-then-rename instead.
    expect(fs.renames).toEqual([[FILE + '.tmp', FILE]])
    expect(fs.files.has(FILE + '.tmp')).toBe(false)
    expect(JSON.parse(fs.files.get(FILE)!)).toEqual({
      version: 1,
      windows: { main: { x: 200, y: 150, width: 1600, height: 1000, maximized: true, full_screen: false } },
    })
  })

  it('collapses a burst of moves into a single write', () => {
    const { store, fs, timer } = makeStore()
    for (let i = 0; i < 20; i++) {
      store.remember('main', { ...GEOM, bounds: { ...GEOM.bounds, x: 200 + i } })
    }
    expect(fs.renames).toHaveLength(0)
    timer.run()
    expect(fs.renames).toHaveLength(1)
    expect(store.get('main')!.bounds.x).toBe(219)
  })

  it('flush writes the pending value and cancels the timer', () => {
    const { store, fs, timer } = makeStore()
    store.remember('main', GEOM)
    store.flush()
    expect(fs.renames).toHaveLength(1)
    expect(timer.scheduled()).toBe(false)
  })

  it('flush is a no-op with nothing pending', () => {
    const { store, fs } = makeStore()
    store.flush()
    store.flush()
    expect(fs.renames).toHaveLength(0)
  })

  it('round-trips through disk, including the snake_case fullscreen field', () => {
    const fs = fakeFs()
    const first = makeStore(fs)
    const fullscreened: WindowGeometry = { bounds: GEOM.bounds, maximized: false, fullScreen: true }
    first.store.remember('main', fullscreened)
    first.store.flush()
    // A fresh store proves the value came off disk, not the buffer.
    expect(makeStore(fs).store.get('main')).toEqual(fullscreened)
  })

  it('rounds fractional bounds on the way to disk', () => {
    const { store, fs } = makeStore()
    store.remember('main', { bounds: { x: 10.4, y: 10.6, width: 1600.5, height: 999.5 }, maximized: false, fullScreen: false })
    store.flush()
    expect(JSON.parse(fs.files.get(FILE)!).windows.main).toMatchObject({ x: 10, y: 11, width: 1601, height: 1000 })
  })

  it('keeps windows independent', () => {
    const { store, timer } = makeStore()
    store.remember('main', GEOM)
    timer.run()
    store.remember('perf-hud', { bounds: { x: 5, y: 5, width: 480, height: 320 }, maximized: false, fullScreen: false })
    timer.run()
    expect(store.get('main')).toEqual(GEOM)
    expect(store.get('perf-hud')!.bounds.width).toBe(480)
  })
})

describe('createWindowGeometryStore — bad-config recovery', () => {
  it('degrades to null on unparseable JSON', () => {
    const fs = fakeFs()
    fs.files.set(FILE, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A hand-edit mishap must not brick the editor at boot.
    expect(makeStore(fs).store.get('main')).toBeNull()
    warn.mockRestore()
  })

  it('degrades to null on an empty file', () => {
    const fs = fakeFs()
    fs.files.set(FILE, '')
    expect(makeStore(fs).store.get('main')).toBeNull()
  })

  it('degrades to null when the envelope has no windows map', () => {
    const fs = fakeFs()
    fs.files.set(FILE, JSON.stringify({ version: 1 }))
    expect(makeStore(fs).store.get('main')).toBeNull()
  })

  it('drops only the mangled entry, not its siblings', () => {
    const fs = fakeFs()
    fs.files.set(
      FILE,
      JSON.stringify({
        version: 1,
        windows: {
          main: { x: 1, y: 2, width: 1600, height: 1000, maximized: false, full_screen: false },
          broken: { x: 'left', width: 0 },
        },
      }),
    )
    const { store } = makeStore(fs)
    expect(store.get('broken')).toBeNull()
    expect(store.get('main')!.bounds).toEqual({ x: 1, y: 2, width: 1600, height: 1000 })
  })

  it('rejects a zero-sized entry', () => {
    const fs = fakeFs()
    fs.files.set(FILE, JSON.stringify({ version: 1, windows: { main: { x: 0, y: 0, width: 0, height: 0 } } }))
    expect(makeStore(fs).store.get('main')).toBeNull()
  })

  it('swallows a write failure rather than breaking quit', () => {
    const fs = fakeFs()
    fs.writeFile = () => {
      throw new Error('EACCES')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = makeStore(fs)
    store.remember('main', GEOM)
    // flush() runs inside before-quit; a throw there would stall shutdown.
    expect(() => store.flush()).not.toThrow()
    warn.mockRestore()
  })

  it('swallows a read failure', () => {
    const fs = fakeFs()
    fs.files.set(FILE, 'x')
    fs.readFile = () => {
      throw new Error('EIO')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(makeStore(fs).store.get('main')).toBeNull()
    warn.mockRestore()
  })
})
