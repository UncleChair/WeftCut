//! `&Backend` authoring-lifecycle commands. Thin wrappers over the
//! `motifs::authoring_commands` cores + a `motifs:changed` emit, so the human
//! (renderer) surface and the MCP tools share one implementation.

use crate::napi_backend::Backend;
use crate::motifs::authoring_commands as ac;
use crate::motifs::catalog::builtins;
use crate::motifs::staleness as st;
use crate::state::{Actor, LayerParams};
use crate::state::ids::LayerId;

fn emit_changed(b: &Backend) {
    b.events.emit(ac::MOTIFS_CHANGED_EVENT, serde_json::json!({}));
}

pub async fn get_motif_source(b: &Backend, id: String) -> Result<ac::MotifSource, String> {
    ac::get_motif_source_core(&b.motif_store, &id)
}

pub async fn write_motif_draft(b: &Backend, args: ac::WriteDraftArgs) -> Result<String, String> {
    let id = ac::write_motif_draft_core(&b.motif_store, args.manifest, &args.html, None)?;
    emit_changed(b);
    Ok(id)
}

pub async fn amend_motif_draft(b: &Backend, draft_id: String, source: String) -> Result<(), String> {
    ac::amend_draft_html(&b.motif_store, &draft_id, &source)?;
    emit_changed(b);
    Ok(())
}

pub async fn create_edit_draft(b: &Backend, source_id: String) -> Result<String, String> {
    let id = ac::create_edit_draft_core(&b.motif_store, &builtins(), &source_id)?;
    emit_changed(b);
    Ok(id)
}

pub async fn import_motif(b: &Backend, path: String) -> Result<String, String> {
    let source = std::fs::read_to_string(&path).map_err(|e| format!("read '{path}': {e}"))?;
    let id = ac::import_motif_from_source(&b.motif_store, &source)?;
    emit_changed(b);
    Ok(id)
}

pub async fn install_motif(b: &Backend, args: ac::InstallArgs) -> Result<String, String> {
    let id = ac::install_motif_core(&b.motif_store, b.project()?, &args).await?;
    emit_changed(b);
    Ok(id)
}

pub async fn delete_motif(b: &Backend, id: String) -> Result<(), String> {
    ac::delete_motif_core(&b.motif_store, &id)?;
    emit_changed(b);
    Ok(())
}

// ---- S5: staleness report + acknowledge ----

pub async fn motif_staleness_report(b: &Backend) -> Result<Vec<st::MotifStaleEntry>, String> {
    let current = st::current_versions(&b.motif_store);
    let snap = b.project()?.snapshot().await;
    let layers: Vec<(String, u32)> = snap.tracks.iter().flat_map(|t| t.layers.iter())
        .filter_map(|l| match &l.params {
            LayerParams::Motif(p) => Some((p.motif_id.clone(), p.motif_version)),
            _ => None,
        }).collect();
    let report = st::build_staleness_report(&layers, &current);
    if !report.is_empty() {
        let summary = report.iter()
            .map(|e| format!("{} v{}→v{} ({} layer(s))", e.motif_id, e.placed_version, e.current_version, e.layer_count))
            .collect::<Vec<_>>().join(", ");
        b.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Warn,
            category: crate::logs::LogCategory::Project,
            source: crate::logs::LogSource::System,
            message: format!("Motifs changed since placement: {summary}"),
            ..Default::default()
        });
    }
    Ok(report)
}

pub async fn acknowledge_motif_staleness(b: &Backend) -> Result<usize, String> {
    let current = st::current_versions(&b.motif_store);
    let snap = b.project()?.snapshot().await;
    let layers: Vec<(LayerId, String, u32, imbl::HashMap<String, serde_json::Value>)> = snap.tracks.iter()
        .flat_map(|t| t.layers.iter())
        .filter_map(|l| match &l.params {
            LayerParams::Motif(p) => Some((l.id, p.motif_id.clone(), p.motif_version, p.props.clone())),
            _ => None,
        }).collect();
    let updates = st::build_ack_entries(&layers, &current);
    if updates.is_empty() { return Ok(0); }
    let n = updates.len();
    b.project()?.rebind_motif(Actor::User, updates).await.map_err(|e| e.to_string())?;
    Ok(n)
}
