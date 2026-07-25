// Ruler node-count gate. LOCAL-ONLY, beside the playback memory ratchet
// (memory-ratchet.mjs) and opt-in for the same reason: it drives the real app
// and measures, so it does not belong in the per-PR CI matrix.
//
// What it guards: the time ruler must paint a tick set bounded by the VIEWPORT,
// never by composition length. Frame mode used to emit one absolutely-positioned
// <div> per frame from zero to the end of the row — 216 001 nodes for a one-hour
// 60 fps timeline and 5 184 001 for a 24 h one, even when twenty frames were on
// screen. `renderer/timeline/rulerModel.ts` now windows the set; its unit tests
// own the model, and this gate owns the WIRING: that the live app's scroll
// offset really reaches the ruler and really bounds the DOM.
//
// Run it after touching the ruler, the timeline scroll plumbing, or
// state/timelineScrollStore.ts:
//   1. npm run build:e2e            (the run needs the __weftcutTest hook)
//   2. node apps/desktop/e2e/scripts/ruler-node-count.mjs
//   or: npm run e2e -- --ruler-gate (runs it after the Playwright projects)
//
// Method: launch the built app over a throwaway userData dir, create a blank
// project, zoom to maximum (so frame mode is on — the expensive regime), then set
// the composition duration to 10 s / 1 h / 24 h in turn and count the ruler's
// children each time.
// PASS: every count is identical across the three durations and sits under a
// ceiling derived from the measured viewport and tick pitch; and scrolling moves
// the painted window instead of re-painting the row head.
//
// The 24 h row at maximum zoom is 172 M px wide, past Chromium's element-size
// clamp, so its LAYOUT is truncated — the gate reads the inline `style.width`
// (unclamped) and never scrolls past the clamp, so the measurement holds. The
// clamp itself is a pre-existing extent limitation, not this gate's subject.
//
// Exit codes: 0 pass, 1 regression, 2 the run was invalid (no build, the app
// never reached the editor, zoom never entered frame mode).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../..');
const MAIN = path.join(DESKTOP, 'out', 'main', 'index.js');

/// Durations to compare. The invariant is that composition length does not enter
/// the node count, so the assertion is equality across this list. ASCENDING on
/// purpose: each step waits for a row at least as wide as its own content, and a
/// row that were still stale would be a LONGER one — which biases the count
/// upward, i.e. toward failing, never toward a false pass.
const DURATIONS_US = [
  ['10 s', 10_000_000],
  ['1 h', 3_600_000_000],
  ['24 h', 86_400_000_000],
];
const FPS = 60;
/// Upper bound on `RULER_OVERSCAN_PX` (rulerModel.ts). The gate only needs an
/// order-of-magnitude ceiling — it is deliberately loose so a deliberate
/// overscan change does not turn it red, while a whole-row set still fails by
/// three to five orders of magnitude.
const OVERSCAN_CEILING_PX = 1600;
const log = (m) => console.log(`[ruler-node-count] ${m}`);

/// The run could not measure what it exists to measure (exit 2) — as opposed to
/// measuring it and finding a regression (exit 1). Thrown, never `process.exit`ed:
/// exiting inside the try skips the `finally`, leaking the Electron process and
/// the temp dirs.
class InvalidRun extends Error {}

// ── Preconditions ───────────────────────────────────────────────────────────
if (!fs.existsSync(MAIN)) {
  console.error('[ruler-node-count] no built app at apps/desktop/out — run `npm run build:e2e` first.');
  process.exit(2);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-rulergate-'));
const projectParent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-rulergate-proj-'));
const ELECTRON_EXE = path.join(
  DESKTOP, '..', '..', 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const { _electron } = await import('@playwright/test');
const app = await _electron.launch({
  executablePath: fs.existsSync(ELECTRON_EXE) ? ELECTRON_EXE : undefined,
  args: [`--user-data-dir=${userData}`, MAIN],
  env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1' },
});

let exitCode = 1;
try {
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');

  // The hook surface is tree-shaken out of a flag-less build; without it the
  // run cannot create a project at all.
  try {
    await page.waitForFunction(
      () => typeof window.__weftcutTest?.newProjectAndEnter === 'function',
      undefined,
      { timeout: 30_000 },
    );
  } catch {
    throw new InvalidRun('window.__weftcutTest is absent — rebuild with `npm run build:e2e`.');
  }
  await page.evaluate(
    (o) => window.__weftcutTest.newProjectAndEnter(o),
    { parentFolder: projectParent, name: 'ruler-node-count', canvas: { width: 1920, height: 1080, fpsNum: FPS, fpsDen: 1 } },
  );
  await page.waitForSelector('[data-testid="timeline-ruler"]', { timeout: 60_000 });
  // LANDMINE: the editor mounts BEHIND the splash screen, so the ruler exists
  // (and paints) while a full-window overlay still covers it. Anything
  // coordinate-addressed — hit-testing, pointer input — lands on the splash
  // until it detaches, ~2.5 s in (SplashScreen.tsx SPLASH_INTRO_DURATION_MS).
  await page.waitForSelector('.splash-screen', { state: 'detached', timeout: 60_000 });

  /// Everything the gate reads off the live ruler in one page call: the node
  /// count, the tick pitch (adjacent minor ticks — the on-screen frame width in
  /// frame mode), the lane-area width, the inline row width, and the leftmost
  /// painted tick.
  const probe = () =>
    page.evaluate(() => {
      const ruler = document.querySelector('[data-testid="timeline-ruler"]');
      const root = ruler?.closest('.overflow-auto');
      const corner = document.querySelector('[data-testid="timeline-ruler-corner"]');
      const kids = Array.from(ruler?.children ?? []);
      const lefts = kids.map((k) => Number.parseFloat(k.style.left)).sort((a, b) => a - b);
      let pitch = 0;
      for (let i = 1; i < lefts.length; i++) {
        const d = lefts[i] - lefts[i - 1];
        if (d > 0 && (pitch === 0 || d < pitch)) pitch = d;
      }
      return {
        count: kids.length,
        pitch,
        firstLeft: lefts[0] ?? 0,
        rowWidth: ruler?.style.width ?? '',
        // Lane area = scroll viewport minus the sticky track-header column.
        viewport: (root?.clientWidth ?? 0) - (corner?.clientWidth ?? 0),
        scrollLeft: root?.scrollLeft ?? 0,
        // Frame mode is the expensive regime; SMPTE labels are its marker.
        smpte: /\d\d:\d\d:\d\d:\d\d/.test(ruler?.textContent ?? ''),
      };
    });

  /// Poll `probe` until `ready` holds. Every state change here is a React
  /// commit driven by an event we just dispatched — condition-polled, never
  /// slept on a fixed delay.
  const settle = async (ready, what, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await probe();
      if (ready(p)) return p;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // ── Zoom to maximum, i.e. into frame mode ────────────────────────────────
  // Ctrl+wheel is the app's only zoom control: there is no zoom command, action
  // or test hook, so the `wheel` listener `useTimelineView` installs on the
  // scroll root IS the seam, and the gate dispatches at it directly.
  //
  // Not via `page.mouse.wheel`: in this Electron + Playwright pair EVERY
  // `Input.dispatchMouseEvent` (move and wheel alike, modifiers or not) is
  // rejected with `Protocol error: Invalid parameters`, so no wheel event ever
  // reaches the document. Dispatching in-page also removes the hit-test and
  // modifier-plumbing dependencies a gate should not have.
  await page.evaluate(() => {
    const root = document
      .querySelector('[data-testid="timeline-ruler"]')
      ?.closest('.overflow-auto');
    if (!root) throw new Error('no timeline scroll root');
    const rect = root.getBoundingClientRect();
    // Zoom is exponential in wheel px (factor = exp(-deltaY * 0.001)), so one
    // big tick saturates at MAX_PX_PER_SEC whatever the starting zoom.
    root.dispatchEvent(
      new WheelEvent('wheel', {
        ctrlKey: true,
        deltaY: -8000,
        deltaMode: 0,
        // Cursor-anchored zoom reads clientX to keep the time under the cursor
        // put; any point inside the lane area is a valid anchor.
        clientX: rect.x + Math.min(rect.width / 2, 400),
        clientY: rect.y + 10,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  let state;
  try {
    // 12 px/frame is the frame-mode threshold (rulerModel.ts); SMPTE labels
    // confirm the regime from the other side.
    state = await settle((p) => p.smpte && p.pitch > 12, 'frame mode at maximum zoom');
  } catch {
    const p = await probe();
    throw new InvalidRun(
      `zoom never reached frame mode (pitch=${p.pitch}px, smpte=${p.smpte}) — the run would have measured the cheap regime.`,
    );
  }
  log(`zoomed: tick pitch ${state.pitch.toFixed(1)} px, lane viewport ${state.viewport} px`);

  // ── Count at each duration ───────────────────────────────────────────────
  // In frame mode the tick pitch IS the on-screen frame width, so pitch × fps
  // recovers the live px/sec without reaching into React state.
  const pxPerSec = state.pitch * FPS;
  const counts = [];
  for (const [label, durationUs] of DURATIONS_US) {
    await page.evaluate(
      (us) => window.api.backend.invoke('set_composition', { patch: { duration_us: us } }),
      durationUs,
    );
    // Two conditions, both absolute: the backend holds the new duration, and the
    // renderer has painted a row wide enough to hold it. The tick count itself
    // must NOT change, so it can never be the settle signal.
    const applied = await page.evaluate(
      () => window.api.backend.invoke('project_summary', {}).then((s) => s.duration_us),
    );
    if (applied !== durationUs)
      throw new InvalidRun(`set_composition did not take: asked ${durationUs} µs, got ${applied} µs`);
    const contentPx = (durationUs / 1_000_000) * pxPerSec;
    const p = await settle(
      (q) => Number.parseFloat(q.rowWidth) >= contentPx,
      `the ${label} row to be painted`,
    );
    counts.push([label, p.count]);
    log(`${label}: ${p.count} ruler nodes (row width ${p.rowWidth})`);
  }

  // ── Verdict on the counts ────────────────────────────────────────────────
  // Judged BEFORE the scroll probe: a ruler that paints the whole row again
  // fails both checks, and "node count tracks composition length" is the
  // message that names the defect. A scroll-probe timeout would only say the
  // window did not move.
  const ceiling =
    Math.ceil((state.viewport + 2 * OVERSCAN_CEILING_PX) / Math.max(1, state.pitch)) + 16;
  const values = counts.map(([, c]) => c);
  const failures = [];
  if (new Set(values).size !== 1)
    failures.push(`node count tracks composition length: ${counts.map(([l, c]) => `${l}=${c}`).join(', ')}`);
  for (const [label, c] of counts)
    if (c > ceiling) failures.push(`${label} painted ${c} nodes, over the ${ceiling}-node viewport ceiling`);

  // ── Scrolling moves the window, not just the head ─────────────────────────
  const headLeft = (await probe()).firstLeft;
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="timeline-ruler"]')?.closest('.overflow-auto');
    if (root) root.scrollLeft = 250_000;
  });
  try {
    const scrolled = await settle(
      (p) => p.firstLeft > headLeft,
      'the painted window to follow the scroll',
    );
    log(`scrolled to ${scrolled.scrollLeft} px: window starts at ${scrolled.firstLeft.toFixed(0)} px, ${scrolled.count} nodes`);
    if (scrolled.count > ceiling)
      failures.push(`scrolled window painted ${scrolled.count} nodes, over the ${ceiling}-node ceiling`);
  } catch {
    // A failure to report, not an invalid run: the scroll offset is not
    // reaching the ruler (state/timelineScrollStore.ts and the listener in
    // Timeline.tsx are the two links).
    failures.push('the painted window did not follow a 250 000 px scroll');
  }

  if (failures.length === 0) {
    log(`PASS (${values[0]} nodes at every duration, ceiling ${ceiling})`);
    exitCode = 0;
  } else {
    for (const f of failures) console.error(`[ruler-node-count] FAIL — ${f}`);
    console.error('[ruler-node-count] the ruler is painting the whole row again; see src/renderer/timeline/rulerModel.ts and the scroll plumbing in Timeline.tsx.');
  }
} catch (err) {
  if (err instanceof InvalidRun) {
    console.error(`[ruler-node-count] INVALID RUN — ${err.message}`);
    exitCode = 2;
  } else {
    console.error(`[ruler-node-count] FAIL — ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(projectParent, { recursive: true, force: true });
}
process.exit(exitCode);
