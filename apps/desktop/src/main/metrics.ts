// Process-tree resource snapshot, derived from Electron's own per-process
// metrics (app.getAppMetrics()). Electron already tracks the whole app tree
// (Browser/main + renderers + GPU + utility/export-worker), so this needs no
// system-info crate and no Rust round-trip — the metrics live in main.
//
// Kept electron-free (operates on the plain metric array) so it's unit-testable
// without launching a BrowserWindow.
//
// LANDMINE: getAppMetrics().cpu.percentCPUUsage is ALREADY whole-machine
// normalized on Electron 42 (probed on a 16-core box: one fully-busy core read
// 6.0% ≈ 100/16). So cpu_percent is the plain SUM across processes, 0–100 of
// the whole machine — do NOT divide by core count. Re-probe if the Electron
// major bumps; Chromium has changed this normalization before.

interface ProcMetric {
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number } // kilobytes
}

// Twin of `SystemStats` in src/shared/ipc.ts. Defined locally because main
// deliberately does NOT reference the shared preload/renderer contract (see that
// file's header). Keep the two shapes in sync.
interface SystemStats {
  cpu_percent: number
  rss_bytes: number
  process_count: number
  logical_cores: number
}

export function collectMetrics(metrics: ProcMetric[], logicalCores: number): SystemStats {
  let cpu = 0
  let rssKb = 0
  for (const p of metrics) {
    cpu += p.cpu.percentCPUUsage
    rssKb += p.memory.workingSetSize
  }
  return {
    cpu_percent: cpu,
    rss_bytes: rssKb * 1024,
    process_count: metrics.length,
    logical_cores: logicalCores,
  }
}
