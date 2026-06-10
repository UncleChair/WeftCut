# Motif Stage 5 (cross-project staleness + file watch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out Motif Plan 4 with the §7-B on-open staleness signal (one-time summary dialog + dismiss-=-acknowledge) and a Rust-side file watcher that hot-reloads externally edited user Motifs.

**Architecture:** A new pure Rust module `motifs/staleness.rs` computes the report and the acknowledge set; two thin Tauri commands wrap it (pull-based — App calls the report once on mount, which is exactly once per project open). A new `motifs/watcher.rs` attaches a recursive `notify` watcher to `<app_config_dir>/motifs/` and coalesces disk events (~400 ms quiet window) into the existing `emit_motifs_changed`, reusing the entire 3b-2 resync/re-render pipeline with **zero TS changes** for the hot-reload path itself. The dialog is a new `MotifStaleDialog` modeled on `ImportProxyDialog`.

**Tech Stack:** Rust (tauri 2, notify 8, tempfile dev-dep already present), React/TS, wdio e2e (real WebView2).

**Spec:** `docs/superpowers/specs/2026-06-10-motif-stage5-cross-project-filewatch-design.md`

**Working directory:** the worktree `C:\Users\iClass\Desktop\learning\videtor\.claude\worktrees\feat+motif-stage5-filewatch` (branch `worktree-feat+motif-stage5-filewatch`). All paths below are relative to it. Baselines verified green: `cargo test`, `npm run typecheck`, `npm test` (vitest 377).

**Already satisfied (verify only, no work):** Spec §4's Caveat-A string append — `property_panel.motif_update_confirm_one/many` in BOTH locales already carry "(其它项目下次打开也会更新)" / "(and other projects update on next open)" (`apps/desktop/src/i18n/locales/zh-CN.ts:467-468`, `en-US.ts:476-477`). Shipped with 3b-3a.

**Spec adaptation (flagged during planning):** the spec's "TS (vitest): dialog renders entries" has no infra to land on — the repo has zero `.test.tsx` files, no jsdom/@testing-library setup. The dialog is asserted end-to-end by the staleness e2e (Task 8) instead. All other TS logic added here is IPC glue with no branching, so no new vitest files are added.

**Key codebase facts (verified during planning — trust these):**

- `MotifParams { motif_id, motif_version, props, src_in_us, transform, opacity }` (`state/layer.rs:175`); `add_motif` stamps `motif_version: motif.manifest.version` at placement (`commands.rs:2080`).
- Snapshot iteration idiom: `snap.tracks.iter().flat_map(|t| t.layers.iter())`, match `crate::state::LayerParams::Motif(p)`; `l.id` is `LayerId = Uuid` (`state/ids.rs:10`; mint test ids with `crate::state::ids::new_id()`).
- `MotifRebindEntry { layer_id, motif_id, motif_version, props: imbl::HashMap<String, serde_json::Value> }` (`state/actor.rs:200`); `handle.rebind_motif(Actor::User, updates).await` — one undo entry (`state/actor.rs:862`).
- Catalog: `motifs::catalog::builtins() -> Vec<Motif>` (manifest has `id/name/version`); user store `UserMotifStore::list_manifests()` returns published manifests only (drafts excluded — they're always v1 + hash-keyed, never stale).
- `emit_motifs_changed(app: &AppHandle)` is `pub` in `motifs/authoring_commands.rs:21`.
- Log idiom: `crate::logs::emit_via_app(&app, crate::logs::LogEntryInput { level, category, source, message, ..Default::default() })`; use `LogLevel::Warn`, `LogCategory::Project`, `LogSource::System`.
- lib.rs setup: `motifs_root = config_dir.join("motifs")` is created + `UserMotifStore` managed at `lib.rs:259-266`; command registration list ends motif commands at `lib.rs:158` (`delete_motif`).
- App mount = exactly one successful project open: `main.tsx` Root flips `boot|startup → editor` and back (`onCloseProject`); ALL `projectOpen` call sites (auto-reopen `main.tsx:60`, picker `StartupScreen.tsx:94`, recents `:106`) precede an App (re)mount. StrictMode double-fires the mount effect only in `tauri dev` (vite prod builds, incl. the e2e debug build, fire once) — a doubled read-only report is harmless.
- `ImportProxyDialog` (`panels/ImportProxyDialog.tsx`) is the visual model; it's rendered conditionally near `App.tsx:1622-1627`. Reuse its CSS classes (`export-panel import-proxy-dialog`) — zero new CSS.
- e2e: real app `tauri build --debug` with `VITE_WEFTCUT_E2E=1` (`e2e/wdio.conf.mjs`), identifier `dev.weftcut.desktop` → the live user-Motif store is `%APPDATA%\dev.weftcut.desktop\motifs` and Node (the wdio runner) can write it directly. Hooks: `newProjectAndEnter`, `addMotifLayer` (auto-creates one Overlay track per insert — two adds at t=0 don't collide), `weftcutSeekUs`, `weftcutSampleComposite(x,y)` → `{r,g,b,a,...}`. `projectSave()` / `projectOpen()` exist in `src/ipc/index.ts`.
- A disk-placed user Motif is ALREADY a valid installed Motif (the store reads disk on demand; no registration step). The watcher closes the only gap: the TS-side catalog/preview didn't learn about out-of-band disk changes.

---

### Task 1: Rust staleness core — pure functions + unit tests

**Files:**
- Create: `apps/desktop/src-tauri/src/motifs/staleness.rs`
- Modify: `apps/desktop/src-tauri/src/motifs/mod.rs` (add `pub mod staleness;` next to the other `pub mod` lines)

- [ ] **Step 1: Write the module with tests (TDD note: in Rust, write the `#[cfg(test)]` block first, watch it fail to compile, then add the implementations — or write both and verify the tests assert real behavior by mutating one expectation and seeing it fail)**

Create `apps/desktop/src-tauri/src/motifs/staleness.rs`:

```rust
//! §7-B cross-project staleness (Stage 5, upload-authoring spec §7).
//!
//! A placed Motif layer stores the `motif_version` it was created with as a
//! **seen-at marker** — it does NOT pin rendering (the frame cache key is
//! source-derived). When a project opens, comparing each marker against the
//! catalog's current version surfaces "this Motif changed since you placed
//! it (v1 → v3)". Dismissing the notice acknowledges: markers bump to
//! current in ONE undo entry via the existing `rebind_motif`.
//!
//! Pure cores (`build_staleness_report` / `build_ack_entries`) are split
//! from the Tauri commands so they unit-test without an actor or disk.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use tauri::{AppHandle, State};

use super::store::UserMotifStore;
use crate::state::actor::MotifRebindEntry;
use crate::state::ids::LayerId;
use crate::state::{Actor, LayerParams, ProjectHandle};

/// One row of the on-open staleness report, grouped by motif id.
#[derive(Clone, Debug, Serialize)]
pub struct MotifStaleEntry {
    pub motif_id: String,
    pub name: String,
    /// Lowest seen-at version across the affected (stale) layers.
    pub placed_version: u32,
    pub current_version: u32,
    pub layer_count: usize,
}

/// Current catalog versions: `motif_id -> (display name, version)`.
/// Built-ins first, then published user Motifs (a user Motif may not shadow
/// a built-in id, but insertion order makes the store win if it ever did).
/// Drafts are deliberately absent: they are always version 1 and
/// content-hash-keyed, so a draft layer can never read as stale.
pub fn current_versions(store: &UserMotifStore) -> HashMap<String, (String, u32)> {
    let mut map = HashMap::new();
    for m in super::catalog::builtins() {
        map.insert(
            m.manifest.id.clone(),
            (m.manifest.name.clone(), m.manifest.version),
        );
    }
    for m in store.list_manifests() {
        map.insert(m.id.clone(), (m.name.clone(), m.version));
    }
    map
}

/// Group `(motif_id, placed_version)` layer pairs into report rows.
/// ANY inequality reports (downgrades included — message shape is the same);
/// ids missing from `current` are skipped (the existing "unknown Motif"
/// placeholder owns that case); layers already at current don't count.
pub fn build_staleness_report(
    layers: &[(String, u32)],
    current: &HashMap<String, (String, u32)>,
) -> Vec<MotifStaleEntry> {
    // BTreeMap so the report order is deterministic (sorted by motif id).
    let mut grouped: BTreeMap<&str, (u32, usize)> = BTreeMap::new();
    for (id, placed) in layers {
        let Some((_, cur)) = current.get(id) else {
            continue;
        };
        if placed == cur {
            continue;
        }
        let slot = grouped.entry(id).or_insert((*placed, 0));
        slot.0 = slot.0.min(*placed);
        slot.1 += 1;
    }
    grouped
        .into_iter()
        .map(|(id, (placed_version, layer_count))| {
            let (name, current_version) = current[id].clone();
            MotifStaleEntry {
                motif_id: id.to_string(),
                name,
                placed_version,
                current_version,
                layer_count,
            }
        })
        .collect()
}

/// Build the acknowledge set: every layer whose seen-at version differs from
/// current keeps its id + props verbatim and gets `motif_version = current`.
pub fn build_ack_entries(
    layers: &[(LayerId, String, u32, imbl::HashMap<String, serde_json::Value>)],
    current: &HashMap<String, (String, u32)>,
) -> Vec<MotifRebindEntry> {
    layers
        .iter()
        .filter_map(|(layer_id, motif_id, placed, props)| {
            let (_, cur) = current.get(motif_id)?;
            if cur == placed {
                return None;
            }
            Some(MotifRebindEntry {
                layer_id: *layer_id,
                motif_id: motif_id.clone(),
                motif_version: *cur,
                props: props.clone(),
            })
        })
        .collect()
}

/// Pull-based §7-B check. The App calls this once on mount — which is exactly
/// once per successful project open (all open paths remount App). A non-empty
/// report also logs one Warn entry so the console keeps a record.
#[tauri::command]
pub async fn motif_staleness_report(
    app: AppHandle,
    handle: State<'_, ProjectHandle>,
    store: State<'_, UserMotifStore>,
) -> Result<Vec<MotifStaleEntry>, String> {
    let current = current_versions(&store);
    let snap = handle.snapshot().await;
    let layers: Vec<(String, u32)> = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .filter_map(|l| match &l.params {
            LayerParams::Motif(p) => Some((p.motif_id.clone(), p.motif_version)),
            _ => None,
        })
        .collect();
    let report = build_staleness_report(&layers, &current);
    if !report.is_empty() {
        let summary = report
            .iter()
            .map(|e| {
                format!(
                    "{} v{}→v{} ({} layer(s))",
                    e.motif_id, e.placed_version, e.current_version, e.layer_count
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        crate::logs::emit_via_app(
            &app,
            crate::logs::LogEntryInput {
                level: crate::logs::LogLevel::Warn,
                category: crate::logs::LogCategory::Project,
                source: crate::logs::LogSource::System,
                message: format!("Motifs changed since placement: {summary}"),
                ..Default::default()
            },
        );
    }
    Ok(report)
}

/// Dismiss-=-acknowledge: bump every stale layer's seen-at marker to the
/// current catalog version (same id, same props) in ONE undo entry. The
/// mismatch set is recomputed from the CURRENT snapshot — layers captured at
/// open time may have been deleted/edited since. Returns the number of layers
/// bumped (0 = nothing to do; the actor is not touched).
#[tauri::command]
pub async fn acknowledge_motif_staleness(
    handle: State<'_, ProjectHandle>,
    store: State<'_, UserMotifStore>,
) -> Result<usize, String> {
    let current = current_versions(&store);
    let snap = handle.snapshot().await;
    let layers: Vec<(LayerId, String, u32, imbl::HashMap<String, serde_json::Value>)> = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .filter_map(|l| match &l.params {
            LayerParams::Motif(p) => {
                Some((l.id, p.motif_id.clone(), p.motif_version, p.props.clone()))
            }
            _ => None,
        })
        .collect();
    let updates = build_ack_entries(&layers, &current);
    if updates.is_empty() {
        return Ok(0);
    }
    let n = updates.len();
    handle
        .rebind_motif(Actor::User, updates)
        .await
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cur(entries: &[(&str, &str, u32)]) -> HashMap<String, (String, u32)> {
        entries
            .iter()
            .map(|(id, name, v)| (id.to_string(), (name.to_string(), *v)))
            .collect()
    }

    #[test]
    fn report_groups_by_motif_and_takes_min_placed() {
        let current = cur(&[("lower-third", "Lower Third", 3)]);
        let layers = vec![("lower-third".to_string(), 1), ("lower-third".to_string(), 2)];
        let r = build_staleness_report(&layers, &current);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].motif_id, "lower-third");
        assert_eq!(r[0].name, "Lower Third");
        assert_eq!(r[0].placed_version, 1);
        assert_eq!(r[0].current_version, 3);
        assert_eq!(r[0].layer_count, 2);
    }

    #[test]
    fn report_skips_equal_and_unknown_ids() {
        let current = cur(&[("a", "A", 2)]);
        let layers = vec![
            ("a".to_string(), 2),     // equal -> skip
            ("ghost".to_string(), 1), // not in catalog -> skip
        ];
        assert!(build_staleness_report(&layers, &current).is_empty());
    }

    #[test]
    fn report_counts_only_stale_layers_and_reports_downgrades() {
        let current = cur(&[("a", "A", 1)]);
        let layers = vec![
            ("a".to_string(), 3), // placed ahead of current (reinstall) — still reported
            ("a".to_string(), 1), // equal -> not counted
        ];
        let r = build_staleness_report(&layers, &current);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].placed_version, 3);
        assert_eq!(r[0].current_version, 1);
        assert_eq!(r[0].layer_count, 1);
    }

    #[test]
    fn report_orders_deterministically_by_motif_id() {
        let current = cur(&[("b", "B", 2), ("a", "A", 2)]);
        let layers = vec![("b".to_string(), 1), ("a".to_string(), 1)];
        let r = build_staleness_report(&layers, &current);
        let ids: Vec<&str> = r.iter().map(|e| e.motif_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn ack_bumps_only_stale_layers_and_keeps_props() {
        let current = cur(&[("a", "A", 3)]);
        let stale_id = crate::state::ids::new_id();
        let fresh_id = crate::state::ids::new_id();
        let props: imbl::HashMap<String, serde_json::Value> =
            [("accent".to_string(), serde_json::json!("#fff"))]
                .into_iter()
                .collect();
        let layers = vec![
            (stale_id, "a".to_string(), 1, props.clone()),
            (fresh_id, "a".to_string(), 3, props.clone()),
            (crate::state::ids::new_id(), "ghost".to_string(), 1, props.clone()),
        ];
        let entries = build_ack_entries(&layers, &current);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].layer_id, stale_id);
        assert_eq!(entries[0].motif_id, "a");
        assert_eq!(entries[0].motif_version, 3);
        assert_eq!(entries[0].props, props);
    }

    #[test]
    fn current_versions_merges_builtins_and_disk_user_motifs() {
        let dir = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(dir.path().to_path_buf());
        let m = current_versions(&store);
        assert!(m.contains_key("countdown"));
        assert!(m.contains_key("lower-third"));

        let manifest = r#"{"id":"user-x","name":"User X","version":7,"size":[100,100],"default_duration_s":2,"props_schema":{}}"#;
        let html = format!(
            "<html><head><script type=\"application/json\" id=\"motif-manifest\">{manifest}</script></head><body></body></html>"
        );
        std::fs::create_dir_all(dir.path().join("user-x")).unwrap();
        std::fs::write(dir.path().join("user-x").join("index.html"), html).unwrap();
        let m = current_versions(&store);
        assert_eq!(m["user-x"], ("User X".to_string(), 7));
    }
}
```

- [ ] **Step 2: Register the module**

In `apps/desktop/src-tauri/src/motifs/mod.rs`, after `pub mod store;` add:

```rust
pub mod staleness;
```

- [ ] **Step 3: Run the module tests**

Run (from `apps/desktop/src-tauri`): `cargo test motifs::staleness`
Expected: 6 passed.

- [ ] **Step 4: Sanity-check one assertion is real**

Temporarily change `assert_eq!(r[0].placed_version, 1)` in the first test to `2`, run `cargo test motifs::staleness`, see it FAIL, revert, see it pass. (Guards against tests that vacuously pass.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/staleness.rs apps/desktop/src-tauri/src/motifs/mod.rs
git commit -m "feat(motifs): staleness report + acknowledge cores and commands (spec 7-B)"
```

---

### Task 2: Register the staleness commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:158` (command registration list)

- [ ] **Step 1: Add the two commands to the invoke handler**

In `apps/desktop/src-tauri/src/lib.rs`, directly after the line `motifs::authoring_commands::delete_motif,` add:

```rust
            motifs::staleness::motif_staleness_report,
            motifs::staleness::acknowledge_motif_staleness,
```

- [ ] **Step 2: Full Rust gate**

Run (from `apps/desktop/src-tauri`): `cargo test`
Expected: everything green (baseline + 6 new). The commands themselves are State-typed thin wrappers over the tested cores — they get their behavioral coverage in the Task-8 e2e.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): register staleness report/ack commands"
```

---

### Task 3: File watcher — debounced notify on the user-Motif root

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `notify`)
- Create: `apps/desktop/src-tauri/src/motifs/watcher.rs`
- Modify: `apps/desktop/src-tauri/src/motifs/mod.rs` (add `pub mod watcher;`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:262-266` (spawn at setup)

- [ ] **Step 1: Add the dependency**

In `apps/desktop/src-tauri/Cargo.toml`, after the `parking_lot = "0.12"` line add:

```toml
# Stage-5 Motif hot-reload: watches `<app_config_dir>/motifs/` and coalesces
# disk changes into `motifs:changed` (src/motifs/watcher.rs).
notify = "8"
```

(If `cargo` rejects `"8"` because a newer major shipped, pin whatever `cargo add notify` resolves — the API used below (`recommended_watcher`, `Watcher::watch`, `RecursiveMode`) is stable across notify 6→8.)

- [ ] **Step 2: Write the watcher module with tests**

Create `apps/desktop/src-tauri/src/motifs/watcher.rs`:

```rust
//! Stage-5 file watch: a recursive `notify` watcher on the user-Motif root.
//!
//! Any disk change — external-editor saves included — coalesces through a
//! quiet-window debounce into ONE `motifs:changed` emit; the frontend's
//! existing resync pipeline (syncCatalog → content-hash cache key → `?v=`
//! host cache-buster → sprite refresh) does the rest. Deliberately NO
//! per-file dispatch (the resync is a full, idempotent refresh) and NO
//! filtering of the app's own writes (install/delete/amend also emit
//! `motifs:changed` themselves; the debounced duplicate is harmless).

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

/// Quiet window: after a change, wait until this long passes with no further
/// event, then fire once. Absorbs editor write bursts and multi-file writes.
pub const DEBOUNCE_QUIET: Duration = Duration::from_millis(400);

/// Keeps the OS watcher alive for the app's lifetime (held in managed state).
pub struct MotifWatcher {
    _watcher: notify::RecommendedWatcher,
}

/// Attach a recursive watcher at `root` (created if missing — a first boot
/// has no user Motifs yet, but the watcher must still attach) and fire
/// `on_change` once per debounced burst.
pub fn spawn(
    root: PathBuf,
    on_change: impl Fn() + Send + 'static,
) -> notify::Result<MotifWatcher> {
    std::fs::create_dir_all(&root).ok();
    let (tx, rx) = mpsc::channel::<()>();
    // Errors are forwarded as change signals too: an overflow means
    // "something changed that we may have missed" — a spurious resync is
    // harmless, a missed one isn't.
    let mut watcher =
        notify::recommended_watcher(move |_res: notify::Result<notify::Event>| {
            let _ = tx.send(());
        })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    std::thread::spawn(move || debounce_loop(&rx, DEBOUNCE_QUIET, on_change));
    Ok(MotifWatcher { _watcher: watcher })
}

/// Coalesce: block for the next event, drain until `quiet` elapses with no
/// further event, then fire once. Exits when the channel disconnects (the
/// watcher was dropped).
pub fn debounce_loop(rx: &mpsc::Receiver<()>, quiet: Duration, on_change: impl Fn()) {
    while rx.recv().is_ok() {
        while rx.recv_timeout(quiet).is_ok() {}
        on_change();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn debounce_coalesces_a_burst_into_one_fire() {
        let (tx, rx) = mpsc::channel::<()>();
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        let handle = std::thread::spawn(move || {
            debounce_loop(&rx, Duration::from_millis(50), move || {
                f.fetch_add(1, Ordering::SeqCst);
            })
        });
        for _ in 0..5 {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(fired.load(Ordering::SeqCst), 1, "burst must coalesce to one fire");
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(fired.load(Ordering::SeqCst), 2, "a later burst fires again");
        drop(tx); // disconnect -> loop exits
        handle.join().unwrap();
    }

    #[test]
    fn watcher_fires_on_a_real_file_write() {
        let dir = tempfile::tempdir().unwrap();
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        let _w = spawn(dir.path().to_path_buf(), move || {
            f.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        // Give the OS watch a beat to attach before writing.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::create_dir_all(dir.path().join("m1")).unwrap();
        std::fs::write(dir.path().join("m1").join("index.html"), "<html>").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while fired.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(fired.load(Ordering::SeqCst) >= 1, "watcher never fired on a write");
    }
}
```

- [ ] **Step 3: Register the module**

In `apps/desktop/src-tauri/src/motifs/mod.rs`, after the just-added `pub mod staleness;` add:

```rust
pub mod watcher;
```

- [ ] **Step 4: Run the watcher tests**

Run (from `apps/desktop/src-tauri`): `cargo test motifs::watcher`
Expected: 2 passed. (Both are timing-based with generous margins; if `watcher_fires_on_a_real_file_write` flakes on a loaded machine, re-run once before suspecting the code.)

- [ ] **Step 5: Spawn the watcher at setup**

In `apps/desktop/src-tauri/src/lib.rs`, the current code at ~262-266 reads:

```rust
            let motifs_root = config_dir.join("motifs");
            if let Err(e) = std::fs::create_dir_all(&motifs_root) {
                tracing::warn!("user-motif dir setup failed: {e:#} ({})", motifs_root.display());
            }
            app.manage(motifs::store::UserMotifStore::new(motifs_root));
```

Change the last line and append the watcher block, so it becomes:

```rust
            let motifs_root = config_dir.join("motifs");
            if let Err(e) = std::fs::create_dir_all(&motifs_root) {
                tracing::warn!("user-motif dir setup failed: {e:#} ({})", motifs_root.display());
            }
            app.manage(motifs::store::UserMotifStore::new(motifs_root.clone()));
            // Stage 5 hot-reload: external edits anywhere under the user-Motif
            // tree (drafts AND installed) emit a debounced `motifs:changed`,
            // driving the same resync the in-app source panel uses. Attach
            // failure degrades to "no hot reload", never an app failure.
            let watcher_app = app.handle().clone();
            match motifs::watcher::spawn(motifs_root, move || {
                motifs::authoring_commands::emit_motifs_changed(&watcher_app);
            }) {
                Ok(w) => {
                    app.manage(w);
                }
                Err(e) => tracing::warn!("motif watcher setup failed: {e:#}"),
            }
```

- [ ] **Step 6: Full Rust gate**

Run (from `apps/desktop/src-tauri`): `cargo test`
Expected: all green (baseline + staleness 6 + watcher 2).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/motifs/watcher.rs apps/desktop/src-tauri/src/motifs/mod.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): debounced notify watcher on the user-Motif root (hot reload)"
```

---

### Task 4: TS IPC wrappers + i18n strings

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts` (append after `amendMotifDraft`, ~line 1130)
- Modify: `apps/desktop/src/i18n/locales/en-US.ts` (new group after the `import_proxy` block)
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts` (new group after the `import_proxy` block, which ends at line 305)

- [ ] **Step 1: IPC wrappers**

In `apps/desktop/src/ipc/index.ts`, after the `amendMotifDraft` function add:

```ts
/// One row of the on-open staleness report (docs/motifs.md "User Motifs"):
/// a Motif some placed layers saw at an older version than the catalog's
/// current. `placed_version` is the lowest seen-at version among them.
export interface MotifStaleEntry {
  motif_id: string;
  name: string;
  placed_version: number;
  current_version: number;
  layer_count: number;
}

/// Compare every placed Motif layer's seen-at `motif_version` against the
/// current catalog. Called once by App on mount (= once per project open).
export async function motifStalenessReport(): Promise<MotifStaleEntry[]> {
  return invoke<MotifStaleEntry[]>("motif_staleness_report");
}

/// Dismiss-=-acknowledge: bump all stale layers' seen-at markers to the
/// current version (one undo entry). Returns the number of layers bumped.
export async function acknowledgeMotifStaleness(): Promise<number> {
  return invoke<number>("acknowledge_motif_staleness");
}
```

- [ ] **Step 2: i18n strings**

In `apps/desktop/src/i18n/locales/en-US.ts`, after the closing `},` of the `import_proxy` group add:

```ts
  motif_stale: {
    title: "Motifs changed since you placed them",
    entry: "v{{from}} → v{{to}} ({{n}} layers)",
    note: "These layers already render with the current version — this is just a heads-up.",
    dismiss: "Got it",
  },
```

In `apps/desktop/src/i18n/locales/zh-CN.ts`, after the closing `},` of the `import_proxy` group (line 305) add:

```ts
  motif_stale: {
    title: "Motif 在放置后已更新",
    entry: "v{{from}} → v{{to}}（{{n}} 个图层）",
    note: "这些图层已按当前版本渲染——这只是一个提示。",
    dismiss: "知道了",
  },
```

(Var is `n`, not `count` — i18next treats `count` as a pluralization key.)

- [ ] **Step 3: Typecheck gate**

Run (from `apps/desktop`): `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(motifs): staleness IPC wrappers + dialog strings"
```

---

### Task 5: MotifStaleDialog + App wiring

**Files:**
- Create: `apps/desktop/src/panels/MotifStaleDialog.tsx`
- Modify: `apps/desktop/src/App.tsx` (imports; state + mount effect inside `App()`; render block near `ImportProxyDialog` at ~1622)

- [ ] **Step 1: The dialog component**

Create `apps/desktop/src/panels/MotifStaleDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { acknowledgeMotifStaleness, type MotifStaleEntry } from "../ipc";

/// One-time on-open notice: some placed Motif layers were created at an
/// older version than the catalog now carries (docs/motifs.md "User
/// Motifs"). The layers ALREADY render with the current look (live/mutable —
/// the layer's stored version is only a seen-at marker), so this informs, it
/// doesn't offer to revert. Dismissing acknowledges: the markers bump to the
/// current version in one undo entry, so the notice doesn't repeat next open.
export function MotifStaleDialog({
  entries,
  onDone,
}: {
  entries: MotifStaleEntry[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await acknowledgeMotifStaleness();
    } catch {
      // Best-effort: a failed ack just means the notice repeats next open.
    }
    onDone();
  };
  return (
    <aside className="export-panel import-proxy-dialog motif-stale-dialog">
      <header>
        <span>{t("motif_stale.title")}</span>
        <button disabled={busy} onClick={() => void dismiss()}>
          {t("motif_stale.dismiss")}
        </button>
      </header>
      <ul className="import-proxy-list">
        {entries.map((e) => (
          <li key={e.motif_id}>
            <span className="import-proxy-clip">{e.name}</span>
            <span className="import-proxy-reason">
              {t("motif_stale.entry", {
                from: e.placed_version,
                to: e.current_version,
                n: e.layer_count,
              })}
            </span>
          </li>
        ))}
      </ul>
      <p className="import-proxy-note">{t("motif_stale.note")}</p>
    </aside>
  );
}
```

- [ ] **Step 2: App wiring**

In `apps/desktop/src/App.tsx`:

(a) Add to the imports near the `ImportProxyDialog` import (~line 75):

```tsx
import { MotifStaleDialog } from "./panels/MotifStaleDialog";
```

and extend the existing `./ipc` import list with `motifStalenessReport` and `type MotifStaleEntry`.

(b) Inside `App()`, alongside the other dialog state declarations, add:

```tsx
  // §7-B on-open staleness: App mounts exactly once per successful project
  // open (every open path remounts it), so a mount-time pull IS the
  // once-per-open check. Read-only; the ack happens on dismiss.
  const [staleMotifs, setStaleMotifs] = useState<MotifStaleEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void motifStalenessReport()
      .then((r) => {
        if (!cancelled && r.length > 0) setStaleMotifs(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
```

(c) In the render, directly after the `ImportProxyDialog` conditional block (`App.tsx:1622-1627`):

```tsx
      {staleMotifs.length > 0 && (
        <MotifStaleDialog
          entries={staleMotifs}
          onDone={() => setStaleMotifs([])}
        />
      )}
```

- [ ] **Step 3: Gates**

Run (from `apps/desktop`): `npm run typecheck && npm test`
Expected: tsc clean; vitest all green (377 — no new TS unit files, see the spec-adaptation note in the header).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/panels/MotifStaleDialog.tsx apps/desktop/src/App.tsx
git commit -m "feat(motifs): MotifStaleDialog — one-time on-open staleness notice"
```

---

### Task 6: e2e reopen hook

**Files:**
- Modify: `apps/desktop/src/testhook/e2eHook.ts` (E2EHook interface + `installBootstrapHook`, ~lines 41-50 and 216-223)
- Modify: `apps/desktop/src/main.tsx:79-88` (pass the exit closure)

- [ ] **Step 1: Extend the hook interface**

In `apps/desktop/src/testhook/e2eHook.ts`, inside `interface E2EHook` after `newProjectAndEnter` add:

```ts
  /// Save, hop Root back to the StartupScreen (unmounting App), reopen the
  /// project at `path`, and re-enter the editor. Remounting App re-runs its
  /// on-open Motif staleness check — this mirrors the real close-and-reopen
  /// flow (the only in-session way to switch projects). Dev/e2e only.
  motifReopenProject(args: { path: string }): Promise<void>;
```

- [ ] **Step 2: Implement it in the bootstrap installer**

Replace `installBootstrapHook` (currently `e2eHook.ts:218-223`) with:

```ts
/// Root-side: workspace creation + entering the editor. `enterEditor` is
/// Root's `setStage("editor")`; `exitToStartup` is `setStage("startup")`.
export function installBootstrapHook(
  enterEditor: () => void,
  exitToStartup: () => void,
): void {
  hookSlot().newProjectAndEnter = async (args) => {
    await projectNewWorkspace(args);
    enterEditor();
  };
  hookSlot().motifReopenProject = async ({ path }) => {
    await projectSave();
    exitToStartup();
    // Let React commit the App unmount before swapping actor state under it.
    await new Promise((r) => setTimeout(r, 50));
    await projectOpen(path);
    enterEditor();
  };
}
```

Extend the `../ipc` import at the top of `e2eHook.ts` with `projectSave` and `projectOpen` (alongside the existing `projectNewWorkspace`).

- [ ] **Step 3: Pass the exit closure from Root**

In `apps/desktop/src/main.tsx`, inside the e2e-hook effect, change

```ts
        installBootstrapHook(() => setStage("editor"));
```

to

```ts
        installBootstrapHook(
          () => setStage("editor"),
          () => setStage("startup"),
        );
```

- [ ] **Step 4: Typecheck gate**

Run (from `apps/desktop`): `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/testhook/e2eHook.ts apps/desktop/src/main.tsx
git commit -m "test(e2e): motifReopenProject hook (save -> startup -> reopen -> editor)"
```

---

### Task 7: file-watch e2e spec

**Files:**
- Create: `apps/desktop/e2e/specs/helpers/userMotifFs.mjs`
- Create: `apps/desktop/e2e/specs/motif_filewatch.e2e.js`

The wdio spec glob is `./specs/**/*.e2e.js`, so a `helpers/*.mjs` file is never collected as a spec.

- [ ] **Step 1: Node-side user-Motif fs helper**

Create `apps/desktop/e2e/specs/helpers/userMotifFs.mjs`:

```js
// Node-side (wdio runner) helpers that write user Motifs DIRECTLY on disk —
// deliberately bypassing every app command, because the file watcher and the
// staleness check exist precisely for out-of-band disk changes. The path
// mirrors Tauri's app_config_dir on Windows: %APPDATA%/<identifier> (the
// e2e app under test is the real debug build, identifier dev.weftcut.desktop,
// per src-tauri/tauri.conf.json).
import path from "node:path";
import fs from "node:fs";

export const MOTIFS_ROOT = path.join(
  process.env.APPDATA,
  "dev.weftcut.desktop",
  "motifs",
);

/// A minimal valid single-file Motif: manifest island + a solid `color` box
/// filling the whole 320×320 document (an unambiguous center-pixel assert).
/// `props_schema` is a required manifest field (empty = no props).
export function motifHtml({ id, version, color, name = "E2E User Motif" }) {
  const manifest = {
    id,
    name,
    version,
    size: [320, 320],
    default_duration_s: 4,
    props_schema: {},
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>
<style>html,body{margin:0;background:transparent}#box{width:320px;height:320px;background:${color}}</style>
</head><body><div id="box"></div>
<script>motif.define({ setup() {} });</script>
</body></html>`;
}

export function writeUserMotif(opts) {
  const dir = path.join(MOTIFS_ROOT, opts.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), motifHtml(opts));
}

export function removeUserMotif(id) {
  fs.rmSync(path.join(MOTIFS_ROOT, id), { recursive: true, force: true });
}
```

- [ ] **Step 2: The file-watch spec**

Create `apps/desktop/e2e/specs/motif_filewatch.e2e.js`:

```js
// Stage-5 file watch (hot reload) through the REAL app in real WebView2:
//   1. Place-after-boot — a user Motif written DIRECTLY to disk (no app
//      command) while the app runs becomes placeable AND renders in the live
//      preview. The disk write reaches the TS catalog via: notify watcher →
//      debounced `motifs:changed` → syncCatalog. (Before Stage 5 this needed
//      a picker visit to refresh the catalog.)
//   2. Hot reload — rewriting the SAME file on disk (same id, same version,
//      new color) re-renders the placed layer with no UI action:
//      watcher → motifs:changed → content_hash changes → frame-cache bust +
//      `?v=` host reload → CDP recapture.
import os from "node:os";
import path from "node:path";
import { writeUserMotif, removeUserMotif } from "./helpers/userMotifFs.mjs";

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-watch-proj");
const MOTIF_ID = "e2e-watch";
const RED = "#e02424";
const GREEN = "#1ea64a";

async function waitForHook(name) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (n) => typeof window.__weftcutTest?.[n] === "function",
        name,
      )) === true,
    { timeout: 30000, timeoutMsg: `${name} hook never mounted` },
  );
}

async function sampleCenter() {
  return browser.executeAsync((done) => {
    window.__weftcutTest
      .weftcutSampleComposite(160, 160)
      .then((p) => done({ ok: true, r: p.r, g: p.g, b: p.b, a: p.a }))
      .catch((e) => done({ ok: false, error: String(e) }));
  });
}

/// Poll the live composite until `predicate(px)` holds. Re-seek each round:
/// cold CDP capture (~11 fps single host) + the async bind path need a real
/// settle window, and a paused stale frame must not starve the bind.
async function waitForCenter(predicate, label) {
  const deadline = Date.now() + 60000;
  let last = null;
  while (Date.now() < deadline) {
    await browser.execute(() => window.__weftcutTest.weftcutSeekUs(500_000));
    await browser.pause(800);
    last = await sampleCenter();
    if (last.ok && predicate(last)) return last;
  }
  throw new Error(`${label}: composite never matched; last=${JSON.stringify(last)}`);
}

describe("motif file watch (real WebView2)", function () {
  before(async () => {
    await waitForHook("newProjectAndEnter");
  });

  after(() => removeUserMotif(MOTIF_ID));

  it("a disk-placed user Motif renders, and an external rewrite hot-reloads it", async () => {
    // 1) Write the Motif DIRECTLY to disk while the app is running.
    writeUserMotif({ id: MOTIF_ID, version: 1, color: RED });

    // 2) 320×320 project so the Motif fills the frame (center pixel = box).
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-motif-watch-" + Date.now(),
          canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
    await waitForHook("addMotifLayer");
    await waitForHook("weftcutSampleComposite");

    // 3) Place it. `add_motif` resolves the id straight from the Rust store
    //    (disk read), and the TS frame math knows it because the watcher's
    //    motifs:changed already synced the runtime catalog — no picker visit.
    const added = await browser.executeAsync((id, done) => {
      window.__weftcutTest
        .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
        .then((layerId) => done({ ok: true, layerId }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, MOTIF_ID);
    if (!added.ok) throw new Error("addMotifLayer failed: " + added.error);

    // 4) The placed layer renders the RED box.
    await waitForCenter(
      (p) => p.a > 200 && p.r > 150 && p.g < 100,
      "initial red render",
    );

    // 5) EXTERNAL EDIT: same id, same version, new color. No app command —
    //    only the file watcher can deliver this change.
    writeUserMotif({ id: MOTIF_ID, version: 1, color: GREEN });

    // 6) Hot reload: the composite turns green with NO UI action.
    await waitForCenter(
      (p) => p.a > 200 && p.g > 120 && p.r < 100,
      "hot-reloaded green render",
    );
  });
});
```

- [ ] **Step 3: Run it (real WebView2)**

Run (from `apps/desktop/e2e`): `npm test -- --spec specs/motif_filewatch.e2e.js`
(The wdio `onPrepare` rebuilds the app debug-bundle with `VITE_WEFTCUT_E2E=1` — the first run pays the build; `target/debug` is already warm from Task 3's `cargo test`.)
Expected: 1 passing.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/specs/helpers/userMotifFs.mjs apps/desktop/e2e/specs/motif_filewatch.e2e.js
git commit -m "test(e2e): file-watch hot-reload spec (disk-placed motif + external rewrite)"
```

---

### Task 8: staleness e2e spec

**Files:**
- Create: `apps/desktop/e2e/specs/motif_staleness.e2e.js`

- [ ] **Step 1: The spec**

Create `apps/desktop/e2e/specs/motif_staleness.e2e.js`:

```js
// §7-B cross-project staleness through the REAL app in real WebView2:
//   project P1 places a user Motif at v1 → the Motif's island version is
//   bumped to v2 ON DISK (the state an Update from another project leaves
//   behind) → reopening P1 surfaces the one-time MotifStaleDialog (v1 → v2,
//   2 layers) → dismissing acknowledges (markers bump in one undo entry,
//   then the reopen-hook's save persists them) → reopening again is quiet.
import os from "node:os";
import path from "node:path";
import { writeUserMotif, removeUserMotif } from "./helpers/userMotifFs.mjs";

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-stale-proj");
const MOTIF_ID = "e2e-stale";
const DIALOG = ".motif-stale-dialog";

async function waitForHook(name) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (n) => typeof window.__weftcutTest?.[n] === "function",
        name,
      )) === true,
    { timeout: 30000, timeoutMsg: `${name} hook never mounted` },
  );
}

async function reopen(projectPath) {
  const r = await browser.executeAsync((p, done) => {
    window.__weftcutTest
      .motifReopenProject({ path: p })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, projectPath);
  if (!r.ok) throw new Error("motifReopenProject failed: " + r.error);
}

describe("motif staleness notice (real WebView2)", function () {
  before(async () => {
    await waitForHook("newProjectAndEnter");
  });

  after(() => removeUserMotif(MOTIF_ID));

  it("v1-placed layers surface v1→v2 on reopen; dismiss acknowledges once", async () => {
    writeUserMotif({ id: MOTIF_ID, version: 1, color: "#e02424" });

    const projectName = "e2e-motif-stale-" + Date.now();
    const projectPath = path.join(PROJECT_PARENT, projectName);
    const r1 = await browser.executeAsync((parent, name, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name,
          canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT, projectName);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
    await waitForHook("addMotifLayer");
    await waitForHook("motifReopenProject");

    // Two layers at v1 (each add_motif call gets its own Overlay track, so
    // t=0 twice doesn't collide) → the report should read "2 layers".
    for (let i = 0; i < 2; i++) {
      const a = await browser.executeAsync((id, done) => {
        window.__weftcutTest
          .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
          .then((layerId) => done({ ok: true, layerId }))
          .catch((e) => done({ ok: false, error: String(e) }));
      }, MOTIF_ID);
      if (!a.ok) throw new Error("addMotifLayer failed: " + a.error);
    }

    // Freshly placed = current version → no dialog now.
    expect(await $(DIALOG).isExisting()).toBe(false);

    // The "another project updated it" moment: the version bumps on disk.
    writeUserMotif({ id: MOTIF_ID, version: 2, color: "#1ea64a" });

    // Reopen P1 → App remounts → the on-mount check fires → dialog.
    await reopen(projectPath);
    await browser.waitUntil(async () => $(DIALOG).isExisting(), {
      timeout: 20000,
      timeoutMsg: "stale dialog never appeared",
    });
    const text = await $(DIALOG).getText();
    if (!/v1\s*→\s*v2/.test(text)) {
      throw new Error("dialog text missing v1 → v2: " + text);
    }
    if (!text.includes("2")) {
      throw new Error("dialog text missing the layer count: " + text);
    }

    // Dismiss = acknowledge. The dialog awaits the ack IPC before closing,
    // so its disappearance means the markers are bumped in the actor.
    await $(`${DIALOG} header button`).click();
    await browser.waitUntil(async () => !(await $(DIALOG).isExisting()), {
      timeout: 10000,
      timeoutMsg: "stale dialog never dismissed",
    });

    // Reopen again (the hook saves first → bumped markers are on disk):
    // acknowledged → quiet. Give the on-mount check a beat to (not) fire.
    await reopen(projectPath);
    await waitForHook("addMotifLayer");
    await browser.pause(3000);
    expect(await $(DIALOG).isExisting()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it (real WebView2)**

Run (from `apps/desktop/e2e`): `npm test -- --spec specs/motif_staleness.e2e.js`
Expected: 1 passing.

- [ ] **Step 3: Run BOTH new specs together (watch for cross-spec state bleed)**

Run (from `apps/desktop/e2e`): `npm test -- --spec specs/motif_filewatch.e2e.js --spec specs/motif_staleness.e2e.js`
Expected: 2 passing. (Each spec removes its own motif dir in `after()`.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/specs/motif_staleness.e2e.js
git commit -m "test(e2e): cross-project staleness spec (v1->v2 notice, dismiss acks once)"
```

---

### Task 9: evergreen docs + final gates

**Files:**
- Modify: `docs/motifs.md` (the "User Motifs" lifecycle bullets at ~349-355 and the paragraph at ~357)

Per the evergreen-docs convention: no stage numbers, no dates, no "new in" phrasing.

- [ ] **Step 1: Extend the "Edit" bullet (docs/motifs.md ~349-351)**

Replace:

```markdown
- **Edit** — a placed draft layer gets an in-app **source panel** (edit the HTML + island,
  Apply → re-render). Editing an *installed* Motif opens a working draft (see
  [Editing an installed Motif](#editing-an-installed-motif)).
```

with:

```markdown
- **Edit** — a placed draft layer gets an in-app **source panel** (edit the HTML + island,
  Apply → re-render). The on-disk store is also **watched**: saving a Motif's file from any
  external editor hot-reloads the same way — disk changes coalesce (debounced) into the same
  catalog resync the panel uses, and the content-hash cache key plus the capture-host
  cache-buster force a fresh capture. This covers installed Motifs too: any disk edit
  re-renders every placement. Editing an *installed* Motif opens a working draft (see
  [Editing an installed Motif](#editing-an-installed-motif)).
```

- [ ] **Step 2: Add the staleness paragraph**

After the paragraph ending "...degrades to an error placeholder, not a crash." (docs/motifs.md ~357) insert:

```markdown
Because updates are live/mutable, the `motif_version` stored on a placed layer is only a
**seen-at marker** — it never pins rendering. When a project opens, each Motif layer's marker
is compared against the catalog's current version; any mismatch surfaces a one-time
**"Motifs changed since you placed them"** notice (v1 → v3, with the affected layer count)
plus a status-log entry — the cross-project signal for updates made while this project was
closed. Dismissing it acknowledges: the markers bump to current in one undo step, so the
notice doesn't repeat on the next open. There is deliberately no global reverse index of
which projects use a Motif; each project self-reports when it opens.
```

- [ ] **Step 3: Final whole-branch gates**

```bash
cd apps/desktop/src-tauri && cargo test
cd ../ && npm run typecheck && npm test
cd e2e && npm test -- --spec specs/motif_filewatch.e2e.js --spec specs/motif_staleness.e2e.js
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/motifs.md
git commit -m "docs(motifs): file watch hot-reload + on-open staleness signal"
```

---

## Self-review notes (already applied)

- **Spec coverage:** §2 watcher → Task 3; §3 report/trigger/surface/ack → Tasks 1, 2, 4, 5; §4 Caveat A → already in code (header note), `motif_stale.*` strings → Task 4; §5 edge cases → encoded in core tests (downgrade, unknown, equal) + watcher debounce test + ack-recompute design; §6 Rust tests → Tasks 1, 3; §6 TS vitest → adapted (no component-test infra; header note); §6 e2e hot-reload + staleness → Tasks 7, 8; §7 implementation notes (no `MotifView` change, notify dep) → honored.
- **Known accepted risks:** the two watcher tests are timing-based (generous margins, re-run once on flake); the staleness e2e's final "stays quiet" assert is a 3 s negative wait — inherently a bounded-confidence check.
- **Half-written-file limitation** (spec §2): not tested — by design, self-heals on the next debounce tick.
