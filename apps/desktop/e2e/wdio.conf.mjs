import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", ".."); // apps/desktop/e2e -> repo root
const APP = path.resolve(REPO, "apps/desktop/src-tauri/target/debug/weftcut.exe");
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
