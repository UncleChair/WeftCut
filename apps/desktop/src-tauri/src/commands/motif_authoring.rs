//! `&Backend` authoring-lifecycle commands. Thin wrappers over the
//! `motifs::authoring_commands` cores + a `motifs:changed` emit, so the human
//! (renderer) surface and the MCP tools share one implementation.

use crate::napi_backend::Backend;
use crate::motifs::authoring_commands as ac;
use crate::motifs::catalog::builtins;

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
