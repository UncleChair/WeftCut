// Electron host for the f16 filter-pool parity gate.
//
// Opens a hidden window, runs the WebGL2 experiment in the renderer,
// prints a single `GATE_RESULT <json>` (or `GATE_ERROR <json>`) line, and quits.
// Launched by run.mjs (or manually), which checks the exit code + output.
//
// Requires WebGL2 + EXT_color_buffer_float. Default ANGLE backend on Windows
// (D3D11) supports rgba16float render targets.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

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

  ipcMain.on("gate-result", (_e, data) => finish("GATE_RESULT", data));
  ipcMain.on("gate-error", (_e, data) => finish("GATE_ERROR", data));

  win.loadFile(path.join(__dirname, "index.html"));

  // Hard safety timeout — no result after 25 s means GPU init hung.
  setTimeout(() => finish("GATE_ERROR", { message: "timeout (no result in 25s)" }), 25000);
});

app.on("window-all-closed", () => app.quit());
