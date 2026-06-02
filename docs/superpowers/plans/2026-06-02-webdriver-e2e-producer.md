# WebDriver E2E Producer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the **real WeftCut app (real WebView2)** via WebdriverIO + tauri-driver to import + export ONE H.264 clip (1:1 placement), then run the Plan 2 `media_conformance` analyzer on the output vs source — a repeatable, headless, real-engine smoke gate.

**Architecture:** `apps/desktop/e2e/` holds a wdio project. A setup script fetches the `msedgedriver` matching the installed Edge/WebView2 build (mismatch → hang, so this is mandatory). `wdio.conf` builds the app (`tauri build --debug --no-bundle`) with a `VITE_WEFTCUT_E2E=1` env that mounts a dev-only `window.__weftcutTest` hook in the frontend. The spec calls the hook (via `browser.execute`) to import→place→export to a known path, then shells out to the `media_conformance` bin and asserts pass.

**Tech Stack:** WebdriverIO 9 (mocha), tauri-driver (cargo bin), msedgedriver (version-matched), Tauri 2 debug build, the Plan 2 Rust analyzer.

**Branch:** `test/media-conformance-e2e` (continues after Plans 1 + 2).

**Validated by the session spike:** the proven scaffold lives at `…/testfile/_e2e_spike` (wdio.conf + launch spec) and `…/testfile/_e2e_tools/msedgedriver.exe`; this plan formalizes it into the repo. Confirmed: session=`webview2 v148.0.3967.96`, UA `Edg/148`, hook-less launch + DOM read works.

**Assets:** external, via `WEFTCUT_TEST_MEDIA` env (default `C:/Users/jonny/Desktop/learning/testfile`); clip `test_1080p_30fps.mp4`. If the dir is absent, the spec SKIPS with a logged notice (Task 3).

---

### Task 1: e2e scaffold + msedgedriver auto-fetch + launch smoke

**Files:**
- Create: `apps/desktop/e2e/package.json`
- Create: `apps/desktop/e2e/scripts/fetch-msedgedriver.mjs`
- Create: `apps/desktop/e2e/wdio.conf.mjs`
- Create: `apps/desktop/e2e/specs/launch.e2e.js`
- Modify: `apps/desktop/.gitignore` (or repo root) to ignore `e2e/.drivers/` and `e2e/node_modules/`

- [ ] **Step 1: e2e package manifest**

`apps/desktop/e2e/package.json`:
```json
{
  "name": "@weftcut/e2e",
  "private": true,
  "type": "module",
  "scripts": {
    "drivers": "node scripts/fetch-msedgedriver.mjs",
    "test": "node scripts/fetch-msedgedriver.mjs && wdio run wdio.conf.mjs"
  },
  "devDependencies": {
    "@wdio/cli": "^9.19.0",
    "@wdio/local-runner": "^9.19.0",
    "@wdio/mocha-framework": "^9.19.0",
    "@wdio/spec-reporter": "^9.19.0"
  }
}
```
Run: `npm install --prefix apps/desktop/e2e`
Expected: exit 0; `apps/desktop/e2e/node_modules/.bin/wdio` exists.

- [ ] **Step 2: msedgedriver auto-fetch (matches the installed WebView2/Edge build)**

`apps/desktop/e2e/scripts/fetch-msedgedriver.mjs`:
```js
// Fetch the msedgedriver matching the installed Edge/WebView2 build into
// e2e/.drivers/. Version MUST match or tauri-driver hangs (Tauri docs warn this
// explicitly). WebView2 is evergreen, so we resolve the version at runtime.
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVERS = resolve(HERE, "..", ".drivers");

function edgeVersion() {
  // ProductVersion of the installed Edge == the WebView2 Evergreen runtime.
  const exe = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const out = execSync(
    `powershell -NoProfile -Command "(Get-Item '${exe}').VersionInfo.ProductVersion"`,
  ).toString().trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(out)) throw new Error(`bad Edge version: ${out}`);
  return out;
}

async function main() {
  const version = edgeVersion();
  const exe = resolve(DRIVERS, "msedgedriver.exe");
  const stamp = resolve(DRIVERS, `version-${version}.ok`);
  if (existsSync(exe) && existsSync(stamp)) {
    console.log(`[e2e] msedgedriver ${version} already present`);
    return;
  }
  mkdirSync(DRIVERS, { recursive: true });
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const zip = resolve(DRIVERS, "edgedriver.zip");
  console.log(`[e2e] downloading msedgedriver ${version}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  const { Readable } = await import("node:stream");
  await new Promise((ok, err) => {
    const ws = createWriteStream(zip);
    Readable.fromWeb(res.body).pipe(ws).on("finish", ok).on("error", err);
  });
  // Expand-Archive is always available in PowerShell 5+.
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${DRIVERS}' -Force"`,
  );
  await rm(zip, { force: true });
  // Touch the stamp.
  createWriteStream(stamp).end();
  if (!existsSync(exe)) throw new Error("msedgedriver.exe missing after extract");
  console.log(`[e2e] msedgedriver ${version} ready at ${exe}`);
  void createRequire; // (kept for parity; no CJS require needed)
}

main().catch((e) => {
  console.error(`[e2e] fetch-msedgedriver failed: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 3: wdio config (formalizes the spike config)**

`apps/desktop/e2e/wdio.conf.mjs`:
```js
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", ".."); // apps/desktop/e2e -> repo root
const APP = path.resolve(
  REPO, "apps/desktop/src-tauri/target/debug/weftcut.exe",
);
const MSEDGEDRIVER = path.resolve(HERE, ".drivers", "msedgedriver.exe");
const TAURI_DRIVER = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");

let tauriDriver;

export const config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  capabilities: [{ maxInstances: 1, "tauri:options": { application: APP } }],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 180000 },
  logLevel: "warn",
  connectionRetryCount: 1,

  // Build the app with the e2e test hook compiled in (VITE_WEFTCUT_E2E=1
  // mounts window.__weftcutTest; absent in normal prod builds).
  onPrepare: () => {
    const r = spawnSync(
      "npm",
      ["--prefix", "apps/desktop", "run", "tauri", "--", "build", "--debug", "--no-bundle"],
      { cwd: REPO, stdio: "inherit", shell: true, env: { ...process.env, VITE_WEFTCUT_E2E: "1" } },
    );
    if (r.status !== 0) throw new Error(`tauri build failed (${r.status})`);
  },

  beforeSession: () =>
    new Promise((ok) => {
      tauriDriver = spawn(TAURI_DRIVER, ["--native-driver", MSEDGEDRIVER], {
        stdio: [null, process.stdout, process.stderr],
      });
      tauriDriver.on("error", (e) => console.error("[e2e] tauri-driver:", e));
      setTimeout(ok, 1500);
    }),
  afterSession: () => tauriDriver && tauriDriver.kill(),
};
```

- [ ] **Step 4: launch smoke spec (the proven spike assertion)**

`apps/desktop/e2e/specs/launch.e2e.js`:
```js
describe("WeftCut launches in the real WebView2", () => {
  it("boots the frontend as Edge/WebView2 with the Tauri bridge", async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    const info = await browser.execute(() => ({
      hasTauri: !!(window.__TAURI_INTERNALS__ || window.__TAURI__),
      domNodes: document.querySelectorAll("*").length,
      ua: navigator.userAgent,
    }));
    expect(info.domNodes).toBeGreaterThan(10);
    expect(info.ua).toContain("Edg/");
    expect(info.hasTauri).toBe(true);
  });
});
```

- [ ] **Step 5: gitignore the driver + node_modules**

Append to `apps/desktop/.gitignore`:
```
e2e/.drivers/
e2e/node_modules/
```

- [ ] **Step 6: Run the launch smoke (real build + real WebView2)**

Run: `npm --prefix apps/desktop/e2e test`
Expected: msedgedriver fetched/cached → `tauri build` → `1 passing`, session reported as `webview2 (vNNN) on windows`. (First run includes a Rust debug build — minutes.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/e2e/package.json apps/desktop/e2e/scripts apps/desktop/e2e/wdio.conf.mjs apps/desktop/e2e/specs/launch.e2e.js apps/desktop/.gitignore
git commit -m "test(e2e): wdio + tauri-driver scaffold + msedgedriver auto-fetch + launch smoke"
```

---

### Task 2: the `window.__weftcutTest` export hook (frontend)

**Files:**
- Create: `apps/desktop/src/testhook/e2eHook.ts`
- Modify: `apps/desktop/src/App.tsx` (mount the hook when `import.meta.env.VITE_WEFTCUT_E2E === "1"`, wiring it to `runExportWithSettings` which is in App scope)

- [ ] **Step 1: Confirm the new-project command (the one binding not yet read)**

The hook must bootstrap a blank project before importing. `main.tsx` opens projects via `projectOpen(path)` and has a "startup" stage with a new-project flow. Find the exact IPC:
Run: `rg -n "project_new|new_project|projectNew|projectCreate|create.*project|startupNewProject|stage.*startup" apps/desktop/src/ipc/index.ts apps/desktop/src/main.tsx apps/desktop/src/startup`
Record the function (expected: an `ipc` export like `projectNew(parentDir)` / `invoke("project_new", …)`). Use that name as `PROJECT_NEW` below. If a blank project also needs a `setComposition` to match the clip, note that `setComposition({ width, height, fps_num, fps_den, duration_pinned })` exists (ipc/index.ts:844) — but import auto-fit may suffice; decide after the first run.

- [ ] **Step 2: Write the hook module**

`apps/desktop/src/testhook/e2eHook.ts` (uses ONLY confirmed ipc functions + the project-new function from Step 1 — substitute its real name for `projectNew`):
```ts
// Dev/E2E-only control surface. Mounted by App ONLY when
// import.meta.env.VITE_WEFTCUT_E2E === "1" (set by the e2e build), so it is
// absent from normal production bundles. Lets the WebDriver spec drive a real
// import -> place -> export through the SAME code paths the UI uses.
import {
  importMedia,
  addVideoTrack,
  addMediaLayer,
  exportSettingsGet,
  projectNew, // <- the name confirmed in Step 1
} from "../ipc";
import type { ExportSettings } from "../render/exportSettings";

export interface E2EHook {
  /// Create a blank project, import `mediaAbsPath`, place it 1:1 at t=0 on a
  /// fresh video track, export to `outputAbsPath`. Resolves when the export
  /// file is fully written. `settings` defaults to the saved export settings.
  exportClip(args: {
    mediaAbsPath: string;
    outputAbsPath: string;
    settings?: Partial<ExportSettings>;
  }): Promise<void>;
}

export function installE2EHook(
  runExport: (settings: ExportSettings, outputPath: string) => Promise<void>,
  waitForExportDone: () => Promise<void>,
) {
  const hook: E2EHook = {
    async exportClip({ mediaAbsPath, outputAbsPath, settings }) {
      await projectNew(/* args per Step 1 */);
      const mediaId = await importMedia(mediaAbsPath);
      const trackId = await addVideoTrack();
      await addMediaLayer(trackId, mediaId, 0);
      const base = (await exportSettingsGet()) ?? defaultExportSettings();
      const merged = { ...base, ...(settings ?? {}) } as ExportSettings;
      await runExport(merged, outputAbsPath);
      await waitForExportDone();
    },
  };
  (window as unknown as { __weftcutTest?: E2EHook }).__weftcutTest = hook;
}

// Minimal defaults if no saved settings (H.264 / mp4, comp fps). Mirror the
// ExportSettings shape confirmed in render/exportSettings.ts during Step 1.
function defaultExportSettings(): ExportSettings {
  return {
    codec: "h264",
    container: "mp4",
    // ...fill the remaining required ExportSettings fields per its type
  } as ExportSettings;
}
```
NOTE: `defaultExportSettings` must be completed against the real `ExportSettings` type — open `apps/desktop/src/render/exportSettings.ts`, copy every required field with a sane H.264/mp4 value. (Prefer relying on `exportSettingsGet()` returning non-null in the e2e build so this default is rarely hit.)

- [ ] **Step 3: Mount the hook from App.tsx**

In `apps/desktop/src/App.tsx`, after `runExportWithSettings` is defined, add an effect. `runExportWithSettings` already sets `exportState`; expose a `waitForExportDone` that resolves when `exportState.kind === "done"` (or rejects on `"error"`). Add:
```tsx
useEffect(() => {
  if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;
  doneResolverRef.current = { set: (r, j) => { resolveDone = r; rejectDone = j; } };
  void import("./testhook/e2eHook").then(({ installE2EHook }) => {
    installE2EHook(
      (settings, path) => runExportWithSettings(settings, path),
      () => new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; }),
    );
  });
  return () => { resolveDone = null; rejectDone = null; };
}, [runExportWithSettings]);
```
…and drive `resolveDone()` / `rejectDone()` from the existing `setExportState` transitions (when `kind === "done"` resolve; when `kind === "error"` reject with the detail). Implement by routing those two transitions through a small ref-held callback. (Exact wiring: locate every `setExportState({ kind: "done" … })` / `"error"` in `runExportWithSettings` and call the resolver alongside.)

- [ ] **Step 4: Verify the hook compiles + is tree-shaken from prod**

Run: `cd apps/desktop && npx tsc -b --force`
Expected: exit 0.

Run: `npm --prefix apps/desktop run build`
Expected: `✓ built`. Confirm the prod bundle excludes the hook:
Run: `rg -l "__weftcutTest" apps/desktop/dist`
Expected: NO matches (dead-code-eliminated because `VITE_WEFTCUT_E2E` is unset for a plain build).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/testhook/e2eHook.ts apps/desktop/src/App.tsx
git commit -m "test(e2e): dev-only window.__weftcutTest export hook (gated on VITE_WEFTCUT_E2E)"
```

---

### Task 3: the conformance E2E spec (import → export → analyze)

**Files:**
- Create: `apps/desktop/e2e/specs/conformance.e2e.js`
- Create: `apps/desktop/e2e/lib/analyze.mjs` (helper that shells the `media_conformance` bin)

- [ ] **Step 1: analyzer helper**

`apps/desktop/e2e/lib/analyze.mjs`:
```js
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

// Runs the Plan-2 bin; returns the parsed JSON report. Throws on non-zero exit.
export function analyze({ output, source, samples }) {
  const r = spawnSync(
    "cargo",
    [
      "run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
      "--bin", "media_conformance", "--quiet", "--",
      "--output", output, "--source", source, "--samples", samples.join(","),
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`media_conformance exit ${r.status}: ${r.stdout}\n${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}
```

- [ ] **Step 2: the conformance spec (skips if assets absent)**

`apps/desktop/e2e/specs/conformance.e2e.js`:
```js
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR = process.env.WEFTCUT_TEST_MEDIA
  || "C:/Users/jonny/Desktop/learning/testfile";
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");
const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-out.mp4");

describe("H.264 import -> export conformance (real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP: source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`);
      this.skip();
    }
  });

  it("exports a 1:1 H.264 clip that stays frame-aligned with low loss", async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => !!window.__weftcutTest)) === true,
      { timeout: 30000, timeoutMsg: "window.__weftcutTest never mounted" },
    );
    // Drive the real import -> place -> export through the app.
    await browser.executeAsync((media, output, done) => {
      window.__weftcutTest
        .exportClip({ mediaAbsPath: media, outputAbsPath: output })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, SOURCE, OUTPUT).then((res) => {
      if (!res.ok) throw new Error(`exportClip failed: ${res.error}`);
    });

    // Analyze: sample interior frames; assert alignment + loss (Node/Rust side).
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150, 270] });
    for (const s of report.samples) {
      expect(s.aligned, `frame ${s.index} aligned (best=${s.best_match_index})`).toBe(true);
    }
    expect(report.pass, `conformance report: ${JSON.stringify(report)}`).toBe(true);
  });
});
```

- [ ] **Step 3: Run the full conformance E2E**

Run: `npm --prefix apps/desktop/e2e test`
Expected: launch smoke passes; conformance test exports `weftcut-e2e-out.mp4` in the real WebView2, the analyzer reports `pass: true` with every sample `aligned: true`. (If `--ssim-min 0.95` is too strict/loose for the real H.264 export, tune it in `analyze.mjs`'s call and record the observed numbers.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/specs/conformance.e2e.js apps/desktop/e2e/lib/analyze.mjs
git commit -m "test(e2e): H.264 import->export conformance (real WebView2 + media_conformance)"
```

---

## Self-Review

**Spec coverage:** real-WebView2 producer ✓ (Tasks 1-2); import+export one H.264 clip 1:1 ✓ (Task 2 hook + Task 3 spec); analyzer integration ✓ (Task 3); msedgedriver version-pin/auto-fetch ✓ (Task 1 Step 2); programmatic `window.__weftcutTest` hook, not UI ✓ (Task 2); asset env + skip-if-absent ✓ (Task 3 `before`); test-flag absent in prod ✓ (Task 2 Step 4 verifies dead-code elimination); `apps/desktop/e2e/` location ✓.

**Placeholder scan — KNOWN GAPS to resolve at execution (flagged, not hidden):**
- Task 2 Step 1: the **new-project IPC name** (`projectNew`) is the one symbol not yet read; Step 1 is the explicit `rg` that confirms it. Everything else (`importMedia`, `addVideoTrack`, `addMediaLayer`, `exportSettingsGet`, `setComposition`, `runExportWithSettings`) is confirmed in this session.
- Task 2 Step 2/3: `defaultExportSettings()` fields + the `done/error` resolver wiring depend on the exact `ExportSettings` type and the `setExportState` call sites — the steps say precisely which file/lines to read and what to fill. These are the irreducible app-coupling points; a subagent resolves them against the named files.

**Type/name consistency:** `window.__weftcutTest.exportClip(...)` signature matches between the hook (Task 2) and the spec (Task 3); `analyze(...)` arg/return shape matches between `lib/analyze.mjs` and the `media_conformance` JSON (`samples[].aligned`, `report.pass`) from Plan 2; `VITE_WEFTCUT_E2E` is consistent across wdio.conf, App mount, and the prod-exclusion check.

## Dependencies

Requires Plan 1 (clean base) and Plan 2 (`media_conformance` bin) merged/landed first. The external assets + the validated tooling (`testfile/_e2e_tools/msedgedriver.exe`, `testfile/_e2e_spike`) are reused/auto-fetched.
