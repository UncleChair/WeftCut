// Dev Performance Monitor window ownership. The renderer asks Electron for a
// labelled singleton, then explicitly shows and focuses it. Keeping this
// operation outside the dashboard component lets the Dev menu reopen/focus the
// monitor without mounting any telemetry UI in the editor.

export const PERF_MONITOR_WINDOW_LABEL = "perf-hud";
export const PERF_MONITOR_WINDOW_OPENED_EVENT = "weftcut://win-opened";
export const PERF_MONITOR_WINDOW_CLOSED_EVENT = "weftcut://win-closed";

const PERF_MONITOR_WINDOW_OPTIONS = {
  url: "/?perfHud=1",
  title: "WeftCut — Performance",
  width: 640,
  height: 560,
  minWidth: 380,
  minHeight: 320,
  resizable: true,
  // Frameless: the monitor draws the same self-owned titlebar as the main
  // window. On macOS the secondary-window config retains native traffic lights.
  decorations: false,
} as const;

export async function openPerformanceMonitor(): Promise<void> {
  const exists = await window.api.win.exists(PERF_MONITOR_WINDOW_LABEL);
  if (!exists) {
    await window.api.win.create(
      PERF_MONITOR_WINDOW_LABEL,
      PERF_MONITOR_WINDOW_OPTIONS,
    );
  }
  await window.api.win.act(PERF_MONITOR_WINDOW_LABEL, "show");
  await window.api.win.act(PERF_MONITOR_WINDOW_LABEL, "focus");
}
