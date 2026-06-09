# Motif Upload Stage 3b-3a — Edit an Existing Motif Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user **Edit an installed (or built-in) Motif** — open a working draft seeded from its source, refine it live (reusing the Stage-3b-2 source panel), then **Update-in-place** (republish over the original, version-bump, rebind current-project layers, lenient-migrate their props) or **Save-as-new**.

**Architecture:** "Edit" creates a **working draft** (unique id) seeded from the source, with a `target` sidecar recording which Motif it edits; the selected layer is swapped in place to the draft id (single-layer `motif_id` retarget via an extended `MotifPatch`) so the existing source panel edits + previews it. On **Update**, `install_motif` (Update mode) moves the draft onto the target, bumps its version, then a new `rebind_motif` actor command retargets all current-project layers from the working id → the target id and lenient-migrates the props of every affected layer in one undo entry. **Save-as-new** publishes the draft under its own working id (Model B — no rebind). **Discard** swaps the layer back to the target (via the sidecar) and deletes the draft.

**Tech Stack:** Rust (Tauri commands, actor command/undo pattern, `serde`), TypeScript/React (Tauri IPC, i18next), vitest + cargo test, real-WebView2 e2e via tauri-mcp-server.

**Locked design decisions (confirmed with the user 2026-06-09):**
- External-editor + file-watch is **OUT** of 3b-3 (deferred; the in-app source panel suffices).
- The Update confirm shows the **current-project usage count + a generic "other projects update on next open" caveat**; §7-B on-open staleness detection is **Stage 5**.
- This is **3b-3a**; `.html` Import + the installed-Delete inline confirm are **3b-3b** (next).
- **Edit = in-place swap** of the selected layer to the working draft (reuses the 3b-2 source panel), NOT a separately-placed layer.

---

## Context an implementer needs

- **Lifecycle backend** (`apps/desktop/src-tauri/src/motifs/authoring_commands.rs`): `install_motif(app, store, args{draft_id, mode})` already has `InstallMode::New` and `InstallMode::Update{target_id}` (Stage 2). Update calls `store.install_draft(draft_id, target_id)` which MOVES `drafts/<draft_id>/` → `<target_id>/` (consuming the draft) and bumps version (the command rewrites the island version before the move). `get_motif_source(store, id) -> {manifest, html}` reads any built-in/installed/draft. `write_motif_draft` mints a NEW id; `amend_motif_draft` overwrites a draft. `emit_motifs_changed(&app)` fires `motifs:changed`. The mutating commands take `app: AppHandle` first.
- **Store** (`apps/desktop/src-tauri/src/motifs/store.rs`): `write_draft(draft_id, html)`, `get_draft(draft_id) -> Option<Motif>`, `get_motif(id)`, `published_ids()`, `list_draft_ids()`, `list_drafts() -> Vec<Motif>`, `delete_user_motif(id)` (removes `<root>/<id>/` AND `<root>/drafts/<id>/`), `drafts_root()`, `safe_seg(seg)`, `DRAFTS_DIR = "drafts"`. A draft dir is `<root>/drafts/<draft_id>/` holding `index.html`.
- **Authoring helpers** (`apps/desktop/src-tauri/src/motifs/authoring.rs`): `assign_unique_id(name, taken: &[String])` (sanitizes + dedupes vs taken + built-ins + `drafts`), `compose_motif_html(manifest, html)`, `validate_manifest`. `apps/desktop/src-tauri/src/motifs/catalog.rs`: `Manifest`, `Motif`, `Motif::canonicalize_props_lenient(&serde_json::Value) -> String` (drops unknown keys, fills defaults — the §4.3 migration primitive; render path already uses it), `BUILTIN_IDS`, `builtins() -> Vec<Motif>`.
- **The UI payload** (`apps/desktop/src-tauri/src/commands.rs`): `motif_to_payload(&manifest, html, status)` builds each `list_motifs` entry (manifest fields + `html` + `status` + `content_hash`). `list_motifs` returns builtins, then installed, then drafts. `add_motif(handle, store, motif_id, t_start_us, …)`.
- **The actor** (`apps/desktop/src-tauri/src/state/actor.rs`): mutations go through `ProjectHandle` methods that `send(Command::X{…, actor, reply})` over an mpsc channel; the actor loop matches the `Command` enum (def at ~line 387) and mutates via the pattern `let mut next: Project = (*self.history.current()).clone(); /* mutate next */ self.history.push(next, actor)`. `ProjectHandle::delete_layer(actor, id)` (line 828) is the cleanest single-mutation analog (Command variant `DeleteLayer{id, actor, reply}` + a handler). `LayerParamsPatch::Motif(MotifPatch)` is applied in `apply_layer_params_patch_to` at actor.rs:4111 — `MotifPatch` (struct at ~line 166) has `x/y/scale_x/scale_y/opacity/src_in_us/props` (props merged field-wise). `LayerParams::Motif(MotifParams)` where `MotifParams` has `motif_id: String, motif_version: u32, props: imbl::HashMap<String, serde_json::Value>, src_in_us, transform, opacity`. `Actor::User` is the actor identity for UI ops. `CommandError` is the error type; `LayerId`/`TrackId` are `Uuid`-backed.
- **Layer-params IPC** (`apps/desktop/src/ipc/index.ts`): `updateLayerParams(layerId, patch: LayerParamsPatch)` → `invoke("update_layer_params", {layerId, patch})`. `MotifPatch` TS interface mirrors the Rust struct. `MotifSummary` carries `status?`, `content_hash?`.
- **Property panel** (`apps/desktop/src/properties/PropertyPanel.tsx`): `MotifFields` renders `<MotifLifecycleRow motifId={v.motif_id} />` then `<MotifSourcePanel motifId={v.motif_id} />` (3b-2). The row resolves `status = getMotif(motifId)?.manifest.status` via `useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision)`; for `"draft"` it shows Install(new)+Delete, for `"installed"` it shows Delete. `MotifFields` receives `layer: LayerSummary` (has `layer.id`) and a `commit` fn → `updateLayerParams`. `getMotifSource`/`installMotif(draftId, {kind})`/`deleteMotif` IPC wrappers exist.
- **Toolchain:** Node via `fnm` (v22). TS from `apps/desktop` (`npx vitest run`, `npx tsc -b`). Rust from `apps/desktop/src-tauri` (`cargo test -p weftcut <filter>`, `cargo build -p weftcut`). Rust source edits via the Edit/Write tools only (PowerShell `Set-Content` corrupts UTF-8 → cp1252). Use the **PowerShell** tool for cargo/git.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src-tauri/src/motifs/store.rs` | draft store | `write_draft_target`/`read_draft_target` (target sidecar) |
| `src-tauri/src/commands.rs` | list_motifs payload | surface `target_id` on draft entries |
| `src-tauri/src/motifs/authoring_commands.rs` | lifecycle commands | `create_edit_draft`; `install_motif` Update wires rebind+migration |
| `src-tauri/src/state/actor.rs` | actor | extend `MotifPatch` (motif_id/version); new `rebind_motif` command |
| `src-tauri/src/lib.rs` | command registration | register `create_edit_draft` |
| `src/ipc/index.ts` | IPC wrappers + types | `createEditDraft`; `MotifSummary.target_id`; `MotifPatch.motif_id/motif_version` |
| `src/properties/PropertyPanel.tsx` | property panel | Edit / Update / Save-as-new / Discard row state machine + blast-radius dialog |
| `src/i18n/locales/{en-US,zh-CN}.ts` | strings | edit/update/save-as-new/discard + blast-radius keys |
| `docs/motifs.md` | design doc | the edit-an-installed-Motif lifecycle paragraph |

---

### Task 1: Target sidecar in the draft store (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/store.rs`

- [ ] **Step 1: Write the failing test** (add to the `#[cfg(test)] mod tests`):

```rust
#[test]
fn draft_target_sidecar_roundtrips_and_is_absent_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    store.write_draft("d1", "<html>x</html>").unwrap();
    assert_eq!(store.read_draft_target("d1"), None); // no sidecar yet
    store.write_draft_target("d1", "lower-third").unwrap();
    assert_eq!(store.read_draft_target("d1").as_deref(), Some("lower-third"));
    // Deleting the draft removes the sidecar with the dir.
    store.delete_user_motif("d1").unwrap();
    assert_eq!(store.read_draft_target("d1"), None);
}

#[test]
fn read_draft_target_rejects_unsafe_id() {
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    assert!(store.write_draft_target("..", "x").is_err());
    assert_eq!(store.read_draft_target(".."), None);
}
```

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut store::tests::draft_target` → FAIL (methods undefined).

- [ ] **Step 3: Implement** (add methods to `impl UserMotifStore`):

```rust
    /// Write the `target` sidecar for a draft — the id of the installed/built-in
    /// Motif this draft is editing (so install can offer Update vs Save-as-new,
    /// and Discard can re-point the layer back). Absent for a from-scratch draft.
    pub fn write_draft_target(&self, draft_id: &str, target_id: &str) -> std::io::Result<()> {
        let dir = self.drafts_root().join(safe_seg(draft_id)?);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("target"), target_id)
    }

    /// Read a draft's `target` sidecar, if present. `None` for a from-scratch
    /// draft, a missing draft, or an unsafe id.
    pub fn read_draft_target(&self, draft_id: &str) -> Option<String> {
        let seg = safe_seg(draft_id).ok()?;
        let s = std::fs::read_to_string(self.drafts_root().join(seg).join("target")).ok()?;
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    }
```

- [ ] **Step 4: Run it to verify it passes** — `cargo test -p weftcut store::tests::draft_target store::tests::read_draft_target` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/store.rs
git commit -m "feat(motifs): draft target sidecar (records the Motif a draft edits)"
```

---

### Task 2: Surface `target_id` on draft entries in `list_motifs` (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/commands.rs`

- [ ] **Step 1: Write the failing test** (extend the `motif_payload_tests`/`tests` module that already tests `list_motifs` shape; if `list_motifs` has no direct test, test via the store-backed path). Add an assertion that a draft with a target sidecar carries `target_id` in its payload and a from-scratch draft does not:

```rust
#[tokio::test]
async fn list_motifs_surfaces_draft_target_id() {
    use crate::motifs::store::UserMotifStore;
    use crate::motifs::authoring::compose_motif_html;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    let html = compose_motif_html(
        &crate::motifs::catalog::Manifest {
            id: "d1".into(), name: "D1".into(), version: 1, size: [10, 10],
            default_duration_s: 1.0, max_duration_s: None, max_duration_prop: None,
            content_duration_s: None, fonts: vec![], props_schema: Default::default(),
        },
        "<head></head><body><script>motif.define({setup(){}})</script></body>",
    );
    store.write_draft("d1", &html).unwrap();
    store.write_draft_target("d1", "lower-third").unwrap();
    store.write_draft("d2", &html.replace("d1", "d2")).unwrap();

    let out = list_motifs_inner(&store); // see Step 3 — factor the body out of the command
    let d1 = out.iter().find(|v| v["id"] == "d1").unwrap();
    let d2 = out.iter().find(|v| v["id"] == "d2").unwrap();
    assert_eq!(d1.get("target_id").and_then(|v| v.as_str()), Some("lower-third"));
    assert!(d2.get("target_id").is_none() || d2["target_id"].is_null());
}
```

(If a `tokio::test` harness isn't already used in commands.rs, make `list_motifs_inner` a plain sync fn over `&UserMotifStore` and use a plain `#[test]`.)

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut list_motifs_surfaces_draft_target_id` → FAIL.

- [ ] **Step 3: Implement** — factor the draft loop so it adds `target_id`. In `list_motifs`, the drafts loop currently does `out.push(motif_to_payload(&draft.manifest, draft.html, "draft")?)`. Change it to also attach the target sidecar:

```rust
    for draft in store.list_drafts() {
        if !seen.contains(draft.id()) {
            let mut entry = motif_to_payload(&draft.manifest, draft.html, "draft")?;
            if let Some(target) = store.read_draft_target(draft.id()) {
                entry.as_object_mut().unwrap()
                    .insert("target_id".to_string(), serde_json::Value::String(target));
            }
            out.push(entry);
        }
    }
```

To make this testable, extract the whole body of `list_motifs` into a sync `fn list_motifs_inner(store: &UserMotifStore) -> Vec<serde_json::Value>` (mirroring the existing structure; `motif_to_payload` returns `Result`, so collect with `?` inside a closure that returns `Result`, or `unwrap_or_else` to skip a bad entry) and have the `#[tauri::command] list_motifs` call it. Keep the public command signature unchanged.

- [ ] **Step 4: Run it to verify it passes** — `cargo test -p weftcut list_motifs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(motifs): surface a draft's target_id in the list_motifs payload"
```

---

### Task 3: `create_edit_draft` command — seed a working draft from a source Motif (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`, `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test** (add to the `#[cfg(test)] mod tests`, testing the testable core `create_edit_draft_core(store, builtins, source_id)`):

```rust
#[test]
fn create_edit_draft_seeds_unique_id_and_records_target_for_installed() {
    use super::super::store::UserMotifStore;
    use super::super::authoring::compose_motif_html;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    // Publish an installed "foo".
    let mut man = m("Foo"); man.id = "foo".into();
    store.write_draft("foo", &compose_motif_html(&man,
        "<head></head><body>FOO<script>motif.define({setup(){}})</script></body>")).unwrap();
    store.install_draft("foo", "foo").unwrap();

    let draft_id = super::create_edit_draft_core(&store, &[], "foo").unwrap();
    assert_ne!(draft_id, "foo");                       // distinct working id
    let d = store.get_draft(&draft_id).unwrap();
    assert!(d.html.contains("FOO"));                   // seeded from source
    assert_eq!(d.manifest.id, draft_id);               // island id == working id
    assert_eq!(store.read_draft_target(&draft_id).as_deref(), Some("foo")); // target recorded
}

#[test]
fn create_edit_draft_from_builtin_records_no_target() {
    use super::super::store::UserMotifStore;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    let builtins = super::super::catalog::builtins();
    let draft_id = super::create_edit_draft_core(&store, &builtins, "countdown").unwrap();
    assert!(store.get_draft(&draft_id).is_some());
    assert_eq!(store.read_draft_target(&draft_id), None); // built-in fork: no Update target
    assert!(super::create_edit_draft_core(&store, &builtins, "nope").is_err()); // unknown source
}
```

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut authoring_commands::tests::create_edit_draft` → FAIL.

- [ ] **Step 3: Implement** (add to `authoring_commands.rs`):

```rust
/// Core of `create_edit_draft`: seed a NEW working draft from `source_id`'s
/// source (built-in or installed), assign a unique working id, and — for an
/// INSTALLED source — record it as the draft's Update target (built-ins can't be
/// updated in place, so a built-in fork records no target → install offers only
/// New). No `AppHandle` so it's unit-testable.
pub fn create_edit_draft_core(
    store: &UserMotifStore,
    builtins: &[crate::motifs::catalog::Motif],
    source_id: &str,
) -> Result<String, String> {
    let is_builtin = BUILTIN_IDS.contains(&source_id);
    let source = builtins.iter().find(|m| m.id() == source_id).cloned()
        .or_else(|| store.get_motif(source_id))
        .ok_or_else(|| format!("unknown source motif '{source_id}'"))?;

    // Unique working id vs published + existing drafts + built-ins.
    let taken: Vec<String> = store.published_ids().into_iter()
        .chain(store.list_draft_ids()).collect();
    let draft_id = assign_unique_id(&source.manifest.name, &taken);

    let mut manifest = source.manifest;
    manifest.id = draft_id.clone();
    manifest.version = 1; // drafts are always v1 until install
    // Re-compose from the source's own composed html (compose strips+reinjects
    // the island from `manifest`, so the body is preserved and the island carries
    // the new working id).
    let html = compose_motif_html(&manifest, &source.html);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    if !is_builtin {
        store.write_draft_target(&draft_id, source_id).map_err(|e| e.to_string())?;
    }
    Ok(draft_id)
}

/// Open a working draft to edit an existing Motif. Built-in → forced fork
/// (no Update target). Returns the working draft id. Emits `motifs:changed`.
#[tauri::command]
pub async fn create_edit_draft(
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    source_id: String,
) -> Result<String, String> {
    let draft_id = create_edit_draft_core(&store, &builtins(), &source_id)?;
    emit_motifs_changed(&app);
    Ok(draft_id)
}
```

Ensure `builtins` is imported (`use super::catalog::{builtins, …}` — it already imports from `super::catalog`).

- [ ] **Step 4: Register** — in `apps/desktop/src-tauri/src/lib.rs`, add `motifs::authoring_commands::create_edit_draft` to `tauri::generate_handler!`, next to `write_motif_draft`.

- [ ] **Step 5: Run it to verify it passes** — `cargo test -p weftcut authoring_commands` then `cargo build -p weftcut` → PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): create_edit_draft — seed a working draft from an installed/built-in Motif"
```

---

### Task 4: Extend `MotifPatch` with `motif_id`/`motif_version` (single-layer retarget)

**Files:** Modify `apps/desktop/src-tauri/src/state/actor.rs`, `apps/desktop/src/ipc/index.ts`

- [ ] **Step 1: Write the failing test** (add near the actor's existing `apply_layer_params_patch` tests — search for `LayerParamsPatch::Motif(MotifPatch` test cases around actor.rs:4286):

```rust
#[test]
fn motif_patch_retargets_motif_id_and_version() {
    use super::{apply_layer_params_patch_to, LayerParamsPatch, MotifPatch};
    use crate::state::layer::{LayerParams, MotifParams};
    let mut params = LayerParams::Motif(MotifParams {
        motif_id: "old".into(), motif_version: 1, props: Default::default(),
        src_in_us: 0, transform: Default::default(), opacity: crate::state::animated::Animated::Static(1.0),
    });
    apply_layer_params_patch_to(&mut params, &LayerParamsPatch::Motif(MotifPatch {
        motif_id: Some("new".into()), motif_version: Some(3), ..Default::default()
    })).unwrap();
    let LayerParams::Motif(p) = &params else { panic!() };
    assert_eq!(p.motif_id, "new");
    assert_eq!(p.motif_version, 3);
}
```

(Confirm the real apply-helper name + `MotifParams` field set + `Animated`/`Transform` paths by reading the surrounding code; adjust the constructor to match. The helper is the one containing the `(LayerParams::Motif(p), LayerParamsPatch::Motif(tp))` arm at actor.rs:4111.)

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut motif_patch_retargets` → FAIL (`motif_id` not a `MotifPatch` field).

- [ ] **Step 3: Implement** — add the fields to `MotifPatch` (actor.rs ~line 166) and the apply arm (actor.rs:4111). In the struct, after `src_in_us`:

```rust
    /// Retarget the layer to a different Motif id (Edit-in-place: swap the
    /// selected layer onto a working draft; Discard: swap it back). Paired with
    /// `motif_version` so the seen-at marker matches the new target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motif_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motif_version: Option<u32>,
```

In the apply arm (before the `props` merge):

```rust
            if let Some(id) = &tp.motif_id {
                p.motif_id = id.clone();
            }
            if let Some(v) = tp.motif_version {
                p.motif_version = v;
            }
```

In `apps/desktop/src/ipc/index.ts`, add to the `MotifPatch` interface:

```ts
  motif_id?: string;
  motif_version?: number;
```

- [ ] **Step 4: Run it to verify it passes** — `cargo test -p weftcut motif_patch_retargets` + `npx tsc -b` (from apps/desktop) → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs apps/desktop/src/ipc/index.ts
git commit -m "feat(motifs): MotifPatch can retarget motif_id/motif_version (single-layer swap)"
```

---

### Task 5: `rebind_motif` actor command — multi-layer retarget + props migration in one undo entry (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/state/actor.rs`

The Update path needs to retarget EVERY current-project layer on the working draft id → the target id, AND migrate the props of every layer that ends up on the target (old schema → new), as a SINGLE undoable command. The command takes a precomputed list of per-layer updates (the caller — `install_motif` — has the store manifest + catalog canonicalize; the actor stays catalog-free).

- [ ] **Step 1: Write the failing test** (add to the actor's test module, mirroring how existing tests build a `ProjectHandle` + add layers — search for an existing `add_layer`-based test as the template):

```rust
#[tokio::test]
async fn rebind_motif_retargets_matching_layers_in_one_undo_entry() {
    let h = test_handle_with_one_track().await; // reuse the suite's helper; or build inline
    let track = first_track_id(&h).await;
    // Two layers on the working draft id "wip", one already on target "foo".
    let mk = |id: &str| LayerParams::Motif(MotifParams {
        motif_id: id.into(), motif_version: 1, props: Default::default(),
        src_in_us: 0, transform: Default::default(),
        opacity: crate::state::animated::Animated::Static(1.0),
    });
    let l1 = h.add_layer(Actor::User, track, mk("wip"), 0, 1_000_000).await.unwrap();
    let l2 = h.add_layer(Actor::User, track, mk("foo"), 2_000_000, 3_000_000).await.unwrap();

    let updates = vec![
        MotifRebindEntry { layer_id: l1, motif_id: "foo".into(), motif_version: 2, props: Default::default() },
        MotifRebindEntry { layer_id: l2, motif_id: "foo".into(), motif_version: 2, props: Default::default() },
    ];
    h.rebind_motif(Actor::User, updates).await.unwrap();

    let snap = h.snapshot().await;
    for l in snap.tracks.iter().flat_map(|t| &t.layers) {
        if let LayerParams::Motif(p) = &l.params {
            assert_eq!(p.motif_id, "foo");
            assert_eq!(p.motif_version, 2);
        }
    }
    // One undo entry reverts the whole rebind.
    h.undo(Actor::User).await.unwrap();
    let snap = h.snapshot().await;
    let ids: Vec<_> = snap.tracks.iter().flat_map(|t| &t.layers)
        .filter_map(|l| if let LayerParams::Motif(p) = &l.params { Some(p.motif_id.clone()) } else { None })
        .collect();
    assert!(ids.contains(&"wip".to_string())); // l1 restored
}
```

(Adapt the handle/track setup to the suite's existing test helpers — read a nearby `#[tokio::test]` that uses `add_layer` + `snapshot` + `undo`.)

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut rebind_motif_retargets` → FAIL.

- [ ] **Step 3: Implement** — mirror `delete_layer`'s plumbing exactly (ProjectHandle method → `Command` variant → handler):

a. Define the entry type near `MotifPatch`:

```rust
/// One layer's retarget for `rebind_motif`. The caller (install_motif) precomputes
/// the target id/version + migrated props per affected layer; the actor applies by id.
#[derive(Clone, Debug)]
pub struct MotifRebindEntry {
    pub layer_id: LayerId,
    pub motif_id: String,
    pub motif_version: u32,
    pub props: imbl::HashMap<String, serde_json::Value>,
}
```

b. Add a `Command` variant (in the `enum Command`, alongside `DeleteLayer`):

```rust
    RebindMotif {
        updates: Vec<MotifRebindEntry>,
        actor: Actor,
        reply: oneshot::Sender<Result<(), CommandError>>,
    },
```

c. Add the `ProjectHandle` method (next to `delete_layer`, line 828):

```rust
    /// Retarget a set of Motif layers (by id) to new motif_id/version/props in
    /// one undo entry. Used by install_motif's Update path to rebind working-draft
    /// layers onto the published target and migrate every affected layer's props.
    pub async fn rebind_motif(
        &self,
        actor: Actor,
        updates: Vec<MotifRebindEntry>,
    ) -> Result<(), CommandError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::RebindMotif { updates, actor, reply })
            .await
            .expect("project actor terminated");
        rx.await.expect("project actor terminated")
    }
```

d. Add the handler in the actor's command match (next to where `Command::DeleteLayer` is handled — find it and mirror its `let mut next = clone; mutate; history.push; reply.send` shape):

```rust
            Command::RebindMotif { updates, actor, reply } => {
                let mut next: Project = (*self.history.current()).clone();
                for entry in &updates {
                    for track in next.tracks.iter_mut() {
                        for layer in track.layers.iter_mut() {
                            if layer.id == entry.layer_id {
                                if let LayerParams::Motif(p) = &mut layer.params {
                                    p.motif_id = entry.motif_id.clone();
                                    p.motif_version = entry.motif_version;
                                    p.props = entry.props.clone();
                                }
                            }
                        }
                    }
                }
                self.history.push(next, actor); // mirror delete_layer's push (label/actor per the analog)
                let _ = reply.send(Ok(()));
            }
```

(Match the EXACT `history.push` call shape `delete_layer`'s handler uses — it may take a label/op-kind argument. Read that handler and copy its form. If the project type uses `imbl::Vector` for tracks/layers rather than `Vec`, use the matching iteration/mutation idiom — read how `delete_layer` walks `next.tracks`.)

- [ ] **Step 4: Run it to verify it passes** — `cargo test -p weftcut rebind_motif` → PASS (incl. the undo assertion).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/state/actor.rs
git commit -m "feat(motifs): rebind_motif actor command (retarget + migrate layers, one undo entry)"
```

---

### Task 6: Wire rebind + props migration into `install_motif`'s Update path (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`

- [ ] **Step 1: Write the failing test** — this is integration-heavy (needs a `ProjectHandle` + store); assert the *update-list builder* in isolation (factor it out):

```rust
#[test]
fn build_rebind_updates_retargets_draft_and_migrates_target_layers() {
    use super::super::catalog::Manifest;
    // New target schema drops "old" prop, adds "title" (default "Hi").
    let mut man = m("Foo"); man.id = "foo".into(); man.version = 2;
    man.props_schema.insert("title".into(),
        crate::motifs::catalog::PropSpec::String { default: "Hi".into(), max_length: None });
    // Two layers: one on the working draft "wip" (old prop), one already on "foo".
    let layers = vec![
        (uuid_a(), "wip".to_string(), serde_json::json!({"old": 1})),
        (uuid_b(), "foo".to_string(), serde_json::json!({"old": 2})),
    ];
    let updates = super::build_rebind_updates(&layers, "wip", &man);
    assert_eq!(updates.len(), 2);
    for u in &updates {
        assert_eq!(u.motif_id, "foo");
        assert_eq!(u.motif_version, 2);
        assert!(!u.props.contains_key("old"));        // dropped (lenient migration)
        assert_eq!(u.props.get("title").and_then(|v| v.as_str()), Some("Hi")); // filled default
    }
}
```

(`uuid_a()/uuid_b()` = any two fixed `LayerId`s; add small helpers. `PropSpec` import per catalog.rs.)

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut build_rebind_updates` → FAIL.

- [ ] **Step 3: Implement** — add `build_rebind_updates` (pure, testable) + thread `ProjectHandle` into `install_motif` for the Update path:

```rust
use crate::state::actor::MotifRebindEntry;
use crate::state::ids::LayerId;

/// Build the per-layer rebind updates for an Update: every layer whose motif_id
/// is the working draft id OR the target id ends up on the target id, at the new
/// version, with its props lenient-migrated to the new schema (drop unknown,
/// fill new defaults). `layers` is `(layer_id, motif_id, props_json)` from the
/// current project snapshot. `target` is the freshly-installed manifest.
pub fn build_rebind_updates(
    layers: &[(LayerId, String, serde_json::Value)],
    working_id: &str,
    target: &crate::motifs::catalog::Manifest,
) -> Vec<MotifRebindEntry> {
    let probe = crate::motifs::catalog::Motif { manifest: target.clone(), html: String::new() };
    layers.iter()
        .filter(|(_, mid, _)| mid == working_id || mid == &target.id)
        .map(|(layer_id, _, props_json)| {
            // lenient migration → canonical JSON → map.
            let canonical = probe.canonicalize_props_lenient(props_json);
            let parsed: serde_json::Value = serde_json::from_str(&canonical).unwrap_or(serde_json::json!({}));
            let props: imbl::HashMap<String, serde_json::Value> = parsed.as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            MotifRebindEntry { layer_id: *layer_id, motif_id: target.id.clone(), motif_version: target.version, props }
        })
        .collect()
}
```

(Confirm the exact name/signature of the lenient canonicalizer on `Motif` in catalog.rs — it may be `canonicalize_props_lenient(&self, &serde_json::Value) -> String` or take `&str`. Adjust the call. If it returns `Result`, `unwrap_or_else` to `{}`.)

Then in `install_motif`, add `handle: State<'_, crate::state::ProjectHandle>` to the signature, and in the `InstallMode::Update { target_id }` branch, AFTER the existing `install_draft` + version bump succeed:

```rust
        // Retarget current-project layers (the working draft + any already on the
        // target) onto the published target id, migrating props to the new schema —
        // one undo entry. Other projects pick up the new look lazily (live/mutable
        // + the Stage-5 on-open staleness signal).
        let target_manifest = store.get_motif(&final_id)
            .ok_or_else(|| format!("installed target '{final_id}' not readable"))?
            .manifest;
        let snap = handle.snapshot().await;
        let layers: Vec<(crate::state::ids::LayerId, String, serde_json::Value)> = snap.tracks.iter()
            .flat_map(|t| t.layers.iter())
            .filter_map(|l| match &l.params {
                crate::state::layer::LayerParams::Motif(p) => Some((
                    l.id,
                    p.motif_id.clone(),
                    serde_json::Value::Object(p.props.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
                )),
                _ => None,
            })
            .collect();
        let updates = build_rebind_updates(&layers, &args.draft_id, &target_manifest);
        if !updates.is_empty() {
            handle.rebind_motif(crate::actor::Actor::User, updates).await
                .map_err(|e| e.to_string())?;
        }
```

(`final_id` is the published target id already in scope in the Update branch; `args.draft_id` is the working id. Confirm the snapshot type's track/layer field names + the `LayerParams::Motif` path + `MotifParams.props` map type by reading the snapshot/`ProjectSummary`-or-`Project` shape `handle.snapshot()` returns — it returns the internal `Project`, whose layers carry `LayerParams`, NOT the serialized `LayerSummary`. Use the internal types.)

Confirm `install_motif` is registered with the new `handle` param available (it's a Tauri `State`; add it to the command signature — Tauri injects it).

- [ ] **Step 4: Run it to verify it passes** — `cargo test -p weftcut build_rebind_updates` + `cargo build -p weftcut` → PASS + clean. (The full Update wiring is validated by the Task 10 e2e.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs
git commit -m "feat(motifs): install_motif Update rebinds + lenient-migrates current-project layers"
```

---

### Task 7: IPC — `createEditDraft` + `MotifSummary.target_id` (TS)

**Files:** Modify `apps/desktop/src/ipc/index.ts`, test `apps/desktop/src/ipc/motifLifecycle.test.ts`

- [ ] **Step 1: Write the failing test** (add to `motifLifecycle.test.ts`):

```ts
it("createEditDraft passes sourceId (camelCased top-level arg)", async () => {
  invoke.mockResolvedValue("foo-2");
  const id = await createEditDraft("foo");
  expect(invoke).toHaveBeenCalledWith("create_edit_draft", { sourceId: "foo" });
  expect(id).toBe("foo-2");
});
```

Add `createEditDraft` to the import.

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/ipc/motifLifecycle.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `ipc/index.ts`, add the wrapper + the `target_id` field:

```ts
/// Open a working draft seeded from an installed/built-in Motif (Edit). Built-in
/// → forced fork (no Update target). Returns the working draft id.
export async function createEditDraft(sourceId: string): Promise<string> {
  return invoke<string>("create_edit_draft", { sourceId });
}
```

Add `target_id?: string;` to the `MotifSummary` interface.

- [ ] **Step 4: Run it to verify it passes** — `npx vitest run src/ipc/motifLifecycle.test.ts` + `npx tsc -b` → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/ipc/motifLifecycle.test.ts
git commit -m "feat(motifs): createEditDraft IPC wrapper + MotifSummary.target_id"
```

---

### Task 8: Property-panel row state machine — Edit / Update / Save-as-new / Discard (TS)

**Files:** Modify `apps/desktop/src/properties/PropertyPanel.tsx`, `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts`

The `MotifLifecycleRow` (3b-1/3b-2) gets the full edit lifecycle. It already self-resolves `status` via the catalog notifier; now it also needs the layer id (to swap) and the draft's `target_id`. Pass `layerId` + read `target_id` from the catalog summary.

- [ ] **Step 1: Add i18n keys** — in `en-US.ts` `property_panel` block:

```ts
    motif_edit: "Edit",
    motif_edit_fork: "Duplicate & edit",
    motif_update: "Update",
    motif_save_as_new: "Save as new",
    motif_discard: "Discard",
    motif_update_confirm_one: "Used by 1 layer in this project. Updating changes it (and other projects update on next open).",
    motif_update_confirm_many: "Used by {{count}} layers in this project. Updating changes all of them (and other projects update on next open).",
```

zh-CN.ts:

```ts
    motif_edit: "编辑",
    motif_edit_fork: "复制并编辑",
    motif_update: "更新",
    motif_save_as_new: "另存为新",
    motif_discard: "放弃",
    motif_update_confirm_one: "本项目内有 1 个图层在用。更新会改掉它（其它项目下次打开也会更新）。",
    motif_update_confirm_many: "本项目内有 {{count}} 个图层在用。更新会改掉所有这些（其它项目下次打开也会更新）。",
```

- [ ] **Step 2: Implement the row** — pass `layerId` to `MotifLifecycleRow` at its call site in `MotifFields`:

```tsx
      <MotifLifecycleRow motifId={v.motif_id} layerId={layer.id} />
```

Rewrite `MotifLifecycleRow` to a `{ motifId, layerId }` signature with this state machine (keep the existing notifier subscription + busy/err handling; `getMotif(motifId)` now also exposes `target_id` via the catalog manifest — ensure `MotifManifest` carries `target_id?` by adding it in `catalog.ts` alongside `status`, fed from the same `list_motifs` payload):

```tsx
function MotifLifecycleRow({ motifId, layerId }: { motifId: string; layerId: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  const manifest = getMotif(motifId)?.manifest;
  const status = manifest?.status;
  if (!status) return null; // unknown motif

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  // Count current-project layers referencing the Update target (blast radius).
  const usageCount = (targetId: string) =>
    useProjectStore.getState().summary?.tracks
      .flatMap((tr) => tr.layers)
      .filter((l) => l.kind === "Motif" && (l.params as { motif_id?: string }).motif_id === targetId)
      .length ?? 0;

  // Edit installed/built-in: seed a working draft, swap THIS layer onto it.
  const edit = run(async () => {
    const draftId = await createEditDraft(motifId);
    await updateLayerParams(layerId, { kind: "Motif", motif_id: draftId, motif_version: 1 });
    await onMutated?.(); // refresh the summary so the selected layer now reads the draft id
  });

  if (status === "builtin") {
    return (
      <div className="prop-motif-lifecycle">
        <span className="template-card-status status-builtin">{t("property_panel.motif_status.builtin", { defaultValue: "builtin" })}</span>
        <button disabled={busy} onClick={edit}>{t("property_panel.motif_edit_fork")}</button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }

  if (status === "installed") {
    return (
      <div className="prop-motif-lifecycle">
        <span className="template-card-status status-installed">{t("property_panel.motif_status.installed")}</span>
        <button disabled={busy} onClick={edit}>{t("property_panel.motif_edit")}</button>
        <button disabled={busy} onClick={run(async () => {
          if (!window.confirm(t("property_panel.motif_delete_confirm", { id: motifId }))) return;
          await deleteMotif(motifId);
        })}>{t("property_panel.motif_delete")}</button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }

  // status === "draft"
  const target = manifest?.target_id;
  return (
    <div className="prop-motif-lifecycle">
      <span className="template-card-status status-draft">{t("property_panel.motif_status.draft")}</span>
      {target ? (
        <>
          <button disabled={busy} onClick={run(async () => {
            const n = usageCount(target);
            const msg = n === 1 ? t("property_panel.motif_update_confirm_one")
                                : t("property_panel.motif_update_confirm_many", { count: n });
            if (!window.confirm(msg)) return;
            await installMotif(motifId, { kind: "update", target_id: target });
            await onMutated?.(); // rebind happened backend-side; refresh
          })}>{t("property_panel.motif_update")}</button>
          <button disabled={busy} onClick={run(() => installMotif(motifId, { kind: "new" }))}>
            {t("property_panel.motif_save_as_new")}
          </button>
          <button disabled={busy} onClick={run(async () => {
            await updateLayerParams(layerId, { kind: "Motif", motif_id: target }); // swap back
            await deleteMotif(motifId);
            await onMutated?.();
          })}>{t("property_panel.motif_discard")}</button>
        </>
      ) : (
        <>
          <button disabled={busy} onClick={run(() => installMotif(motifId, { kind: "new" }))}>
            {t("property_panel.motif_install")}
          </button>
          <button disabled={busy} onClick={run(async () => { await deleteMotif(motifId); await onMutated?.(); })}>
            {t("property_panel.motif_delete")}
          </button>
        </>
      )}
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
```

Wire `onMutated`: `MotifLifecycleRow` needs a way to refresh the project summary after a swap/install (so the selected layer re-reads its new `motif_id`). `MotifFields` already receives an `onMutated`/refresh path via its `commit`; thread the panel's existing refresh callback down to the row (read how `MotifFields`/`PropertyPanel` currently refreshes after `commit` — reuse that; if `PropertyPanel` takes an `onMutated` prop, pass it through). Also add `createEditDraft`, `updateLayerParams`, `useProjectStore` to the imports.

> NOTE on the discard "swap back": the row reads `target` from the draft's manifest (sidecar-fed). `updateLayerParams(layerId, {motif_id: target})` retargets the selected layer back; `deleteMotif(draft)` removes the working draft. Other layers were never swapped (only the selected one was, on Edit), so no broader cleanup is needed.

- [ ] **Step 3: Add `target_id` to `MotifManifest`** (catalog.ts), alongside `status`:

```ts
  /// For a draft seeded by "Edit installed X", the id of X (the Update target).
  /// Absent for from-scratch drafts and built-in forks. Drives the row's
  /// Update-vs-Install choice + Discard's swap-back.
  target_id?: string;
```

- [ ] **Step 4: Verify** — `npx tsc -b` + `npx vitest run` (full) → clean + green (no new unit test for the row; it's exercised by the Task 10 e2e).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/render/motifs/catalog.ts apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(motifs): edit/update/save-as-new/discard lifecycle row + blast-radius confirm"
```

---

### Task 9: Doc + real-WebView2 e2e verification

**Files:** Modify `docs/motifs.md` (+ manual verification)

- [ ] **Step 1: Document the edit-an-installed lifecycle** — in `docs/motifs.md`, add an evergreen paragraph (no stage numbers/dates): editing an installed/built-in Motif opens a working draft (built-in → forced fork); the selected layer swaps in place to preview; Update republishes over the original (version bump → all uses re-render, current-project layers rebind + props lenient-migrate), Save-as-new publishes under a fresh id, Discard swaps back. Commit:

```bash
git add docs/motifs.md
git commit -m "docs(motifs): edit-an-installed-Motif lifecycle (Update / Save-as-new / Discard)"
```

- [ ] **Step 2: Real-WebView2 verification** (rebuild `tauri dev`; drive via tauri-mcp-server, `window.__TAURI__.core.invoke` + `await import('/src/render/motifs/catalog.ts')` for live catalog probing; sample canvas pixels via `createImageBitmap`+`getImageData`):
  1. Install a user Motif (e.g. write+install a solid-red 1280×320 draft), place it, select it.
  2. Click **Edit** → confirm a working draft is created (distinct id), the selected layer swapped to it (status now "draft", target=the installed id), the Source panel shows.
  3. Edit the source red→green, Apply → preview turns green (3b-2 path).
  4. Click **Update** → confirm the blast-radius dialog shows "1 layer", accept → the layer goes back to the installed id, the installed Motif's content is now green (re-place it or check `get_motif_source`), the draft is gone, and a second pre-existing layer on the same installed id (place one before editing) ALSO turns green.
  5. Repeat with **Save-as-new** → confirm a new Motif id exists, the original installed id is unchanged, the layer stays on the new id.
  6. Repeat Edit → **Discard** → confirm the layer is back on the installed id and the draft is gone.
  7. **Props migration:** give the installed Motif a prop, place a layer with a non-default value, Edit → change the schema (drop/rename a prop) → Update → confirm the placed layer renders (lenient) and its stored props migrated (no dropped key).
  8. Clean up all test Motifs/layers; confirm the catalog returns to its prior state.

  Record the outcome. Do NOT mark complete unless Update visibly propagates to all current-project layers and Discard restores cleanly.

---

## Self-Review

**1. Spec coverage (the 3b-3a slice of design §4 + §7-current-project):**
- Edit installed → working draft, distinct id, records target → Tasks 1 (sidecar), 3 (create_edit_draft), 8 (Edit button + swap). ✓
- Edit built-in → forced fork (no target) → Task 3 (`is_builtin` → no sidecar), 8 (fork label, Install-new only). ✓
- Update-in-place: copy onto target + version bump (Stage 2 `install_draft`) + **rebind current-project layers** + **lenient props migration** + delete draft (install_draft moves it) → Tasks 5 (rebind cmd), 6 (build_rebind_updates + wiring). ✓
- Save-as-new → Task 8 (`installMotif(new)`; Model B, no rebind). ✓
- Blast-radius: current-project count + generic caveat (§7, B deferred) → Task 8 (`usageCount` + confirm strings). ✓
- Edit = in-place swap (reuse 3b-2 panel) → Tasks 4 (MotifPatch retarget), 8 (`updateLayerParams motif_id`). ✓
- Discard → Task 8 (swap back via sidecar target + delete draft). ✓
- OUT (3b-3b/Stage 5): external editor/file-watch, `.html` Import, installed-Delete inline confirm (still `window.confirm` here — acceptable, replaced in 3b-3b), §7-B on-open staleness. Stated in the header. ✓

**2. Placeholder scan:** Concrete code throughout. The actor `rebind_motif` handler + `install_motif` snapshot iteration explicitly say "confirm the internal type names/`history.push` shape against `delete_layer`/the `Project` snapshot" — these are *instructions to match an existing pattern the implementer can read*, not vague placeholders; the behavior + signatures + tests are fully specified. The lenient-canonicalizer name is flagged to confirm. ✓

**3. Type consistency:** `create_edit_draft`(Rust) ↔ `createEditDraft`(TS) ↔ arg `sourceId`. `MotifRebindEntry{layer_id, motif_id, motif_version, props}` used identically in Tasks 5 & 6. `MotifPatch.motif_id/motif_version` (Rust + TS) ↔ `updateLayerParams({kind:"Motif", motif_id, motif_version})`. `target_id` consistent across store sidecar → list_motifs payload → `MotifSummary`/`MotifManifest` → row. `build_rebind_updates(layers, working_id, target_manifest)` signature matches its call in `install_motif`. ✓

**4. Known soft spots flagged for the implementer:**
- Task 5: match `delete_layer`'s exact `Command`/handler/`history.push` form + the `Project` snapshot's track/layer iteration idiom (`Vec` vs `imbl::Vector`).
- Task 6: confirm `Motif::canonicalize_props_lenient`'s exact signature/return; confirm `handle.snapshot()` returns the internal `Project` (use `LayerParams`/`MotifParams`, not the serialized `LayerSummary`).
- Task 8: thread the existing summary-refresh callback into `MotifLifecycleRow` (the row now mutates layers, so it must trigger a refresh); `useProjectStore` selector for the usage count.
