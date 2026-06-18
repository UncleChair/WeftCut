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

use super::store::UserMotifStore;
use crate::state::actor::MotifRebindEntry;
use crate::state::ids::LayerId;

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
