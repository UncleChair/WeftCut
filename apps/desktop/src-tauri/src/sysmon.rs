//! Dev-only system-resource sampler. Reports the CPU% and resident
//! memory of the *app process tree* — the Tauri main process plus every
//! WebView2 child (renderer, GPU, utility) and the export Worker — to
//! the dev `PerfHUD`.
//!
//! WebView2 is multi-process: the renderer and GPU processes do most of
//! the real work, so reading only our own PID badly undercounts. We walk
//! the parent→child links from our PID and sum the whole subtree.
//!
//! Everything here is gated on `debug_assertions` (see the `mod sysmon`
//! declaration in `lib.rs`): release builds never spawn the sampler nor
//! expose the command.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

/// A flattened single-process reading: pid, parent pid (None when the
/// parent is unknown or the process is a root), and that one process's
/// CPU + resident-set readings.
#[derive(Debug, Clone)]
pub struct ProcSample {
    pub pid: u32,
    pub parent: Option<u32>,
    /// sysinfo per-process CPU%, where 100.0 == one saturated logical
    /// core (so a busy 4-core app can read ~400).
    pub cpu: f32,
    /// Resident set size in bytes.
    pub rss: u64,
}

/// Sum CPU and RSS across `root` and every process reachable from it via
/// parent links. Returns `(cpu_sum, rss_sum, process_count)`, where
/// `process_count` counts only subtree pids that actually have a sample.
/// Unrelated process trees are excluded; an absent `root` with no
/// children yields `(0.0, 0, 0)`. `cpu_sum` keeps sysinfo's
/// "100 per core" scale — the caller normalizes by logical-core count.
pub fn aggregate_tree(procs: &[ProcSample], root: u32) -> (f32, u64, u32) {
    use std::collections::{HashMap, HashSet};

    // Index samples by pid, and build a parent→children adjacency so the
    // subtree walk is O(tree) rather than rescanning the slice per hop.
    let by_pid: HashMap<u32, &ProcSample> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        if let Some(parent) = p.parent {
            children.entry(parent).or_default().push(p.pid);
        }
    }

    let (mut cpu, mut rss, mut count) = (0.0f32, 0u64, 0u32);
    let mut visited: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !visited.insert(pid) {
            continue; // guard against parent-link cycles
        }
        if let Some(p) = by_pid.get(&pid) {
            cpu += p.cpu;
            rss += p.rss;
            count += 1;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    (cpu, rss, count)
}

/// Latest system-resource snapshot for the dev `PerfHUD`. All figures
/// cover the app process tree, not the whole machine.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SystemStats {
    /// App process-tree CPU as a percentage of the whole machine (0–100):
    /// sysinfo's per-core sum divided by logical-core count, matching the
    /// Task-Manager-style figure.
    pub cpu_percent: f32,
    /// Summed resident memory of the app process tree, in bytes.
    pub rss_bytes: u64,
    /// Processes in the tree (main + WebView2 children + export Worker).
    pub process_count: u32,
    /// Logical core count — context for the normalized `cpu_percent`.
    pub logical_cores: u32,
}

/// Managed slot holding the most recent sample. `None` until the sampler
/// produces its first reading.
pub type SystemStatsSlot = Arc<Mutex<Option<SystemStats>>>;

pub fn new_slot() -> SystemStatsSlot {
    Arc::new(Mutex::new(None))
}

/// Latest system-resource snapshot. Returns `None` before the first
/// sample lands (the sampler ticks once a second).
#[tauri::command]
pub fn get_system_stats(slot: tauri::State<'_, SystemStatsSlot>) -> Option<SystemStats> {
    slot.lock().clone()
}

/// Spawn the once-a-second sampler. Owns a `sysinfo::System`, refreshes
/// the process table, sums our process tree, and writes the normalized
/// snapshot into `slot`. CPU% is a delta between refreshes, so the first
/// tick reads ~0 and later ticks reflect the prior second.
pub fn spawn_sampler(slot: SystemStatsSlot) {
    tauri::async_runtime::spawn(async move {
        let our_pid = std::process::id();
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1);
        let refresh = ProcessRefreshKind::nothing().with_cpu().with_memory();
        let mut sys = System::new();
        loop {
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
            let procs: Vec<ProcSample> = sys
                .processes()
                .iter()
                .map(|(pid, p)| ProcSample {
                    pid: pid.as_u32(),
                    parent: p.parent().map(|pp| pp.as_u32()),
                    cpu: p.cpu_usage(),
                    rss: p.memory(),
                })
                .collect();
            let (cpu_sum, rss_bytes, process_count) = aggregate_tree(&procs, our_pid);
            *slot.lock() = Some(SystemStats {
                cpu_percent: if logical_cores > 0 {
                    cpu_sum / logical_cores as f32
                } else {
                    cpu_sum
                },
                rss_bytes,
                process_count,
                logical_cores,
            });
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pid: u32, parent: Option<u32>, cpu: f32, rss: u64) -> ProcSample {
        ProcSample { pid, parent, cpu, rss }
    }

    #[test]
    fn single_root_returns_its_own_readings() {
        let procs = vec![s(1, None, 10.0, 100)];
        assert_eq!(aggregate_tree(&procs, 1), (10.0, 100, 1));
    }

    #[test]
    fn sums_root_plus_all_descendants() {
        // 1 ─┬─ 2 ── 4
        //    └─ 3
        let procs = vec![
            s(1, None, 5.0, 100),
            s(2, Some(1), 10.0, 200),
            s(3, Some(1), 0.0, 50),
            s(4, Some(2), 20.0, 400),
        ];
        assert_eq!(aggregate_tree(&procs, 1), (35.0, 750, 4));
    }

    #[test]
    fn excludes_unrelated_process_trees() {
        let procs = vec![
            s(1, None, 5.0, 100),
            s(2, Some(1), 10.0, 200),
            s(99, None, 50.0, 9999), // a different tree entirely
            s(100, Some(99), 33.0, 1234),
        ];
        assert_eq!(aggregate_tree(&procs, 1), (15.0, 300, 2));
    }

    #[test]
    fn absent_root_with_no_children_is_zero() {
        let procs = vec![s(2, Some(7), 10.0, 200)];
        assert_eq!(aggregate_tree(&procs, 42), (0.0, 0, 0));
    }
}
