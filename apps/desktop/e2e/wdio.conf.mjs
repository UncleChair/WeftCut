import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureFixtures } from "./fixtures/generate-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", ".."); // apps/desktop/e2e -> repo root
const APP = path.resolve(REPO, "apps/desktop/native/target/debug/weftcut.exe");
const MSEDGEDRIVER = path.resolve(HERE, ".drivers", "msedgedriver.exe");
const TAURI_DRIVER = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");
const DRIVER_PORT = 4444;

let tauriDriver;
/// Resolves when the CURRENT driver process has actually exited. `kill()`
/// only sends the signal; the process tree (tauri-driver + msedgedriver +
/// app) releases port 4444 some time later.
let tauriDriverExited;

/// True when something is accepting TCP connections on the driver port.
/// A plain connect probe (not WebDriver /status) so it can't be fooled by
/// an intermediary that doesn't implement the endpoint.
function driverPortOpen() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: DRIVER_PORT, host: "127.0.0.1" });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function waitUntil(pred, what, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  /* eslint-enable no-await-in-loop */
  throw new Error(`[e2e] timed out waiting for ${what}`);
}

export const config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.js"],
  suites: {
    smoke: ["./specs/smoke/**/*.e2e.js"],
    ui: ["./specs/ui/**/*.e2e.js"],
    export: ["./specs/export/**/*.e2e.js"],
    audio: ["./specs/audio/**/*.e2e.js"],
    motif: ["./specs/motif/**/*.e2e.js"],
  },
  maxInstances: 1,
  capabilities: [{ maxInstances: 1, "tauri:options": { application: APP } }],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 180000 },
  logLevel: "warn",
  connectionRetryCount: 1,

  // Build the app with the e2e test hook compiled in (VITE_WEFTCUT_E2E=1
  // mounts window.__weftcutTest; absent in normal prod builds).
  onPrepare: async () => {
    const mediaDir = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "fixtures", "media");
    await ensureFixtures(mediaDir);
    // Opt-in fast path: reuse an already-built debug binary. Explicit only —
    // never auto-detect staleness (stale-binary trap). Default still rebuilds.
    if (process.env.WEFTCUT_E2E_NO_BUILD) {
      if (!existsSync(APP)) {
        throw new Error(
          `[e2e] WEFTCUT_E2E_NO_BUILD is set but the app binary is missing at ${APP} — run once without it to build first.`,
        );
      }
      console.log(`[e2e] WEFTCUT_E2E_NO_BUILD set — skipping tauri build, reusing ${APP}`);
      return;
    }
    const r = spawnSync(
      "npm",
      ["--prefix", "apps/desktop", "run", "tauri", "--", "build", "--debug", "--no-bundle"],
      { cwd: REPO, stdio: "inherit", shell: true, env: { ...process.env, VITE_WEFTCUT_E2E: "1" } },
    );
    if (r.status !== 0) throw new Error(`tauri build failed (${r.status})`);
  },

  // wdio runs each SPEC FILE as its own worker + session, sequentially. The
  // previous session's driver tree releases port 4444 asynchronously after
  // kill(); spawning the next tauri-driver while the old one still holds the
  // port makes its bind fail and every `/session` POST gets refused — the
  // inter-spec flake. So: wait for the old process to exit AND the port to go
  // quiet before spawning, then probe the new driver instead of sleeping a
  // fixed 1500 ms.
  beforeSession: async () => {
    if (tauriDriverExited) await tauriDriverExited;
    await waitUntil(
      async () => !(await driverPortOpen()),
      `port ${DRIVER_PORT} to be released by the previous driver`,
    );
    tauriDriver = spawn(TAURI_DRIVER, ["--native-driver", MSEDGEDRIVER], {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriverExited = new Promise((resolve) => {
      tauriDriver.once("exit", resolve);
      tauriDriver.once("error", resolve);
    });
    tauriDriver.on("error", (e) => console.error("[e2e] tauri-driver:", e));
    await waitUntil(driverPortOpen, "tauri-driver to start listening");
    // Listening ≠ fully wired to msedgedriver yet — a short settle keeps the
    // first /session POST off the driver's startup path.
    await new Promise((r) => setTimeout(r, 200));
  },
  afterSession: async () => {
    if (!tauriDriver) return;
    const exited = tauriDriverExited;
    tauriDriver.kill();
    await exited;
  },
};
