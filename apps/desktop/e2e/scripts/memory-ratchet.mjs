// Dev-mode playback memory-ratchet gate. LOCAL-ONLY (like the rest of e2e):
// the phenomenon it guards is dev-bundle-specific, so the prod-built e2e
// suite can never catch it — this script measures the DEV renderer instead.
//
// What it guards: a frame-rate value routed through React state above a leaf
// re-renders that whole subtree per composition frame during playback; under
// the React development build that load ratchets renderer memory native-side
// (GC- and pressure-immune, lands in partition_alloc's buffer partition).
// See docs/render.md §Playhead updates for the tiering that prevents it.
//
// Run it after touching the playback loop, playhead consumers, or anything
// that subscribes per-frame:
//   1. Have the dev server running:  npm run dev   (port 1420)
//   2. node apps/desktop/e2e/scripts/memory-ratchet.mjs [scenario]
//
// Scenarios (positional arg, default `text`):
//   text        — the original fixture: one static Text layer. Guards the
//                 playhead/React-subscription ratchet class.
//   transitions — the transition RT-pool leak class: 90 s of playback crosses
//                 ~22 active windows, so the two-input transition node's RT
//                 pool (TransitionRtPool) acquires/releases every cycle — a
//                 per-frame or per-window RT leak ratchets straight past the
//                 red line. Scenario shape: see `transitionsLayers` below.
//
// Method: assembles a throwaway shell package (isolated userData via a
// distinct app name; node_modules junction into the repo; copy of out/) so
// the probe NEVER touches the developer's own app instance, seeds a
// synthesized no-media project, auto-opens it via
// reopen_on_launch, plays 90 s, and compares forced-GC memory floors.
// PASS: ratchet < 30 MB (healthy runs measure ~10 MB; the regression this
// gate exists for measured +197 MB on the same fixture).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { electronBinPath } from '../lib/electron-bin.mjs';

const THRESHOLD_MB = 30;
const PLAY_SECONDS = 90;

const SCENARIO = process.argv[2] ?? 'text';
if (!['text', 'transitions'].includes(SCENARIO)) {
  console.error(`[memory-ratchet] unknown scenario '${SCENARIO}' — use 'text' or 'transitions'.`);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../..');
const REPO = path.resolve(DESKTOP, '../..');
const ELECTRON_EXE = electronBinPath();

const log = (m) => console.log(`[memory-ratchet] ${m}`);

// ── Preconditions ───────────────────────────────────────────────────────────
const devUp = await fetch('http://localhost:1420/').then((r) => r.ok, () => false);
if (!devUp) {
  console.error('[memory-ratchet] dev server not reachable on http://localhost:1420 — start `npm run dev` first.');
  process.exit(2);
}
if (!fs.existsSync(path.join(DESKTOP, 'out/main/index.js'))) {
  console.error('[memory-ratchet] apps/desktop/out/main missing — run the dev server (or a build) once first.');
  process.exit(2);
}

// ── Assemble the isolated shell + fixture ───────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-memgate-'));
const shell = path.join(work, 'shell');
fs.mkdirSync(shell);
fs.writeFileSync(path.join(shell, 'package.json'), JSON.stringify({
  name: 'weftcut-memprobe-gate',
  version: '0.0.0',
  private: true,
  main: 'out/main/index.js',
}));
fs.cpSync(path.join(DESKTOP, 'out'), path.join(shell, 'out'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(shell, 'node_modules'), 'junction');

const project = path.join(work, 'fixture');
fs.mkdirSync(project);
const DURATION_US = 120_000_000;
const staticNum = (v) => ({ mode: 'Static', value: v });
const fixtureId = (suffix) => `019f0000-0000-7000-8000-${suffix.toString(16).padStart(12, '0')}`;

// Scenario `text`: the original single static Text layer.
const textLayers = () => [{
  id: '019f0000-0000-7000-8000-0000000000ab',
  label: null, t_start_us: 0, t_end_us: DURATION_US,
  enabled: true, locked: false, metadata: {},
  params: {
    kind: 'Text', content: 'MEMORY RATCHET GATE',
    font: { family: 'Arial', size_px: 72, weight: 400, italic: false },
    color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
    align: 'Center',
    transform: {
      x: staticNum(0), y: staticNum(0), scale_x: staticNum(1), scale_y: staticNum(1),
      rotation_deg: staticNum(0), anchor_x: staticNum(0.5), anchor_y: staticNum(0.5),
    },
    opacity: staticNum(1),
    shadow: null, outline: null, intro: null, outro: null,
    backend_hint: 'DrawText',
  },
  effects: [],
}];

// Scenario `transitions`: alternating full-frame RED/BLUE Color layers, cuts
// every 4 s, a 1 s transition at EVERY cut (kinds cycling Crossfade → Wipe →
// Slide). Start-at-cut shape: each outgoing layer's tail extends 1 s past the
// cut, so overlap === duration_us (the validate/reconcile invariant). A layer
// is `from` of one transition and `to` of the previous — chains are legal
// (LayerInMultipleTransitions tracks from/to separately).
const SEG_US = 4_000_000;
const TRANSITION_US = 1_000_000;
const SEGMENTS = DURATION_US / SEG_US; // 30 layers, 29 transitions
const transitionsLayers = () => Array.from({ length: SEGMENTS }, (_, i) => ({
  id: fixtureId(0x1000 + i),
  label: null,
  t_start_us: i * SEG_US,
  // Every layer except the last is an outgoing participant → +1 s tail.
  t_end_us: (i + 1) * SEG_US + (i < SEGMENTS - 1 ? TRANSITION_US : 0),
  enabled: true, locked: false, metadata: {},
  params: {
    kind: 'Color',
    color: { mode: 'Static', value: i % 2 === 0 ? { r: 255, g: 0, b: 0, a: 255 } : { r: 0, g: 0, b: 255, a: 255 } },
    width: 1920, height: 1080,
  },
  effects: [],
}));
const TRANSITION_KINDS = [
  { kind: 'Crossfade' },
  { kind: 'Wipe', direction: 'left' },
  { kind: 'Slide', direction: 'left' },
];
const transitionsList = () => Array.from({ length: SEGMENTS - 1 }, (_, i) => ({
  id: fixtureId(0x2000 + i),
  from_layer: fixtureId(0x1000 + i),
  to_layer: fixtureId(0x1000 + i + 1),
  duration_us: TRANSITION_US,
  kind: TRANSITION_KINDS[i % TRANSITION_KINDS.length],
}));

const layers = SCENARIO === 'transitions' ? transitionsLayers() : textLayers();
const transitions = SCENARIO === 'transitions' ? transitionsList() : [];
log(`scenario: ${SCENARIO} (${layers.length} layers, ${transitions.length} transitions)`);

fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({
  // The app must OPEN this file, so it declares the CURRENT schema version
  // (src/main/state/model.ts). A .mjs script cannot import the TS constant; when
  // SCHEMA_VERSION bumps, this literal moves with it or the ratchet stops opening.
  schema_version: 1,
  project_id: '019f0000-0000-7000-8000-00000000c0de',
  metadata: { name: `memory-ratchet-${SCENARIO}`, created_at: '2026-01-01T00:00:00.000Z', modified_at: '2026-01-01T00:00:00.000Z', description: null },
  composition: {
    width: 1920, height: 1080, fps: { num: 30, den: 1 },
    duration_us: DURATION_US, duration_pinned: true,
    sample_rate: 48000, channels: 2, color_space: 'Bt709',
    background: { r: 0, g: 0, b: 0, a: 255 },
  },
  media_pool: {},
  tracks: [{
    id: '019f0000-0000-7000-8000-0000000000aa',
    label: 'Overlay', enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: null, transient: false, height_px: 64,
    layers,
  }],
  markers: [], transitions, groups: [], audio_roles: {},
  settings: {
    preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
    history_capacity: 200, auto_pair_audio_on_import: true,
  },
}, null, 2));

// userData derives from the shell package name.
const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const userData = path.join(appData, 'weftcut-memprobe-gate');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'recents.json'), JSON.stringify({
  reopen_on_launch: true,
  entries: [{ path: project, name: `memory-ratchet-${SCENARIO}`, last_opened: '2026-01-01T00:00:00.000Z' }],
  last_new_project_parent: null,
}));

// ── Probe ───────────────────────────────────────────────────────────────────
const { _electron } = await import('@playwright/test');
const app = await _electron.launch({
  executablePath: ELECTRON_EXE,
  args: [shell],
  env: {
    ...process.env,
    WEFTCUT_SUPPRESS_ELEVATION_NOTICE: '1',
    ELECTRON_RENDERER_URL: 'http://localhost:1420',
  },
});
let exitCode = 1;
try {
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => document.querySelectorAll('canvas').length > 0 || document.body.innerText.includes('00:00:00:00'),
    undefined,
    { timeout: 90_000 },
  );
  await new Promise((r) => setTimeout(r, 15_000));

  const rendererPrivMB = async () => {
    const ms = await app.evaluate(async ({ app: a }) =>
      a.getAppMetrics().map((m) => ({ type: m.type, privKB: m.memory.privateBytes ?? 0 })));
    return Math.round(Math.max(...ms.filter((m) => m.type === 'Tab').map((m) => m.privKB), 0) / 1024);
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable').catch(() => {});
  const gcFloor = async () => {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await new Promise((r) => setTimeout(r, 4_000));
    return await rendererPrivMB();
  };

  const floorA = await gcFloor();
  log(`floor A (pre-play) = ${floorA} MB`);
  await page.mouse.click(640, 360);
  await page.keyboard.press('Space');
  const tc = async () => await page.evaluate(() => (document.body.innerText.match(/\d\d:\d\d:\d\d:\d\d/) ?? ['?'])[0]);
  const tc1 = await tc();
  await new Promise((r) => setTimeout(r, 5_000));
  if ((await tc()) === tc1) throw new Error('transport did not start (timecode frozen) — gate run invalid');
  log(`playing ${PLAY_SECONDS}s`);
  await new Promise((r) => setTimeout(r, (PLAY_SECONDS - 5) * 1_000));
  await page.keyboard.press('Space');
  await new Promise((r) => setTimeout(r, 3_000));
  const floorB = await gcFloor();
  const ratchet = floorB - floorA;
  log(`floor B (post-play, post-GC) = ${floorB} MB → ratchet = ${ratchet} MB over ${PLAY_SECONDS}s`);

  if (ratchet < THRESHOLD_MB) {
    log(`PASS [${SCENARIO}] (< ${THRESHOLD_MB} MB)`);
    exitCode = 0;
  } else if (SCENARIO === 'transitions') {
    log(`FAIL [transitions] (>= ${THRESHOLD_MB} MB) — likely a transition RT-pool leak (per-frame/per-window RenderTexture allocation); see src/renderer/render/transitions/TransitionRtPool.ts`);
  } else {
    log(`FAIL [text] (>= ${THRESHOLD_MB} MB) — a frame-rate React subscription has likely crept back in; see docs/render.md §Playhead updates`);
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
process.exit(exitCode);
