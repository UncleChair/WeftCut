// Minimal Electron host for the f16-filter-pool PoC.
// Run with the primary checkout's electron binary, e.g.:
//   <primary>/node_modules/electron/dist/electron.exe <thisdir>/main.cjs
// It opens a hidden window, runs the WebGL2 experiment in the renderer,
// prints a single `POC_RESULT <json>` (or `POC_ERROR <json>`) line, and quits.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

// We NEED the GPU / WebGL2 + EXT_color_buffer_float — do NOT disable hw accel.
// Default ANGLE backend on Windows (D3D11) supports rgba16float render targets.

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
      // keep the GPU on for offscreen WebGL
      offscreen: false,
    },
  });

  win.webContents.on("console-message", (_e, _level, msg) => {
    process.stdout.write(`CONSOLE ${msg}\n`);
  });

  ipcMain.on("poc-result", (_e, data) => finish("POC_RESULT", data));
  ipcMain.on("poc-error", (_e, data) => finish("POC_ERROR", data));

  win.loadFile(path.join(__dirname, "index.html"));

  // hard safety timeout
  setTimeout(() => finish("POC_ERROR", { message: "timeout (no result in 25s)" }), 25000);
});

app.on("window-all-closed", () => app.quit());
