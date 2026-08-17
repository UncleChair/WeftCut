// Electron host for the gate's THIRD condition: the WGSL half of the catalog's
// dual-source filters, executed on a real WebGPU device.
//
// Why it is a separate host from main.cjs: WebGPU on Linux needs
// `--enable-features=Vulkan` (without it `requestAdapter()` returns null and
// Pixi silently falls back to WebGL — which is how a WGSL twin ships
// unexecuted), and enabling Vulkan also moves ANGLE's WebGL backend. Conditions
// A and B measure pool precision through WebGL and their numbers are recorded
// evidence, so they keep their own process with no extra switches.
//
// Prints a single `WGSL_RESULT <json>` (or `WGSL_ERROR <json>`) line and quits.
// Reports `{ unavailable }` rather than failing when the box has no WebGPU
// adapter — run.mjs turns that into a loud SKIP.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

// Linux: WebGPU is gated behind the Vulkan feature in this Chromium
// (148.0.7778.265 / Electron 42). Verified by probe: without it
// `navigator.gpu` exists but `requestAdapter()` resolves null; with it the
// adapter reports the real GPU. `--enable-unsafe-webgpu` alone would hand back
// SwiftShader, which compiles WGSL but measures a software path.
app.commandLine.appendSwitch("enable-features", "Vulkan");

let done = false;
function finish(tag, data) {
  if (done) return;
  done = true;
  process.stdout.write(`${tag} ${JSON.stringify(data)}\n`);
  setTimeout(() => app.quit(), 150);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 64,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.webContents.on("console-message", (_e, _level, msg) => {
    process.stdout.write(`CONSOLE ${msg}\n`);
  });

  ipcMain.on("wgsl-result", (_e, data) => finish("WGSL_RESULT", data));
  ipcMain.on("wgsl-error", (_e, data) => finish("WGSL_ERROR", data));

  win.loadFile(path.join(__dirname, "wgsl.html"));

  setTimeout(() => finish("WGSL_ERROR", { message: "timeout (no result in 30s)" }), 30000);
});

app.on("window-all-closed", () => app.quit());
