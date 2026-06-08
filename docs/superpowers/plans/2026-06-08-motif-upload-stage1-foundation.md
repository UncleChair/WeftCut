# Motif Upload — Stage 1: On-disk user Motifs (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Motif `.html` placed on disk under a global store is parsed (manifest island), served over the `motif:` scheme path-safely, merged into both the Rust and TS catalogs, and renders + lists exactly like a built-in — with no authoring UI or MCP yet (tested by writing files directly into the store).

**Architecture:** Add a `UserMotifStore` rooted at `<app_config_dir>/motifs/`. The `motif:` scheme handler falls back to this store when a built-in lookup misses (path-traversal-safe). The Rust `list_motifs` command and the TS `catalog.ts` map both merge built-ins with on-disk user Motifs; the TS catalog becomes runtime-extensible (built-in `import.meta.glob` seed + user manifests pulled over the `list_motifs` IPC at startup).

**Tech Stack:** Rust (Tauri 2.11, serde, blake3, thiserror, tracing, tempfile for tests), TypeScript (React, Vitest), WebView2 CDP capture (unchanged).

---

## Stage roadmap (whole feature → this plan covers Stage 1)

Spec: `docs/superpowers/specs/2026-06-08-motif-upload-authoring-design.md`. Each stage produces working, testable software and gets its own plan file when reached (matching the prior Motif-migration practice).

| Stage | Scope | Spec sections |
|---|---|---|
| **1 (this plan)** | On-disk user Motifs: storage + path-safe disk serving + runtime-extensible Rust & TS catalogs | §2 (storage), §8.2 (TS runtime catalog), §8.3 (disk serving) |
| 2 | Draft store + lifecycle (new / seed-from / install new\|update / delete) + import validation + props lenient-migration + per-frame wall-clock timeout | §3, §4, §10 |
| 3 | Preview reuse into the project canvas + content-hash cache reconciliation + hot reload + dual edit surfaces (file-watch + in-app simple panel) | §5, §6, §8.1 |
| 4 | MCP surface: `get_motif_source` / `write_motif_draft` / `preview_motif_draft` / `install_motif` / `delete_motif`; `list_motifs` status field | §9 |
| 5 | Cross-project usage signal: in-project usage + Update dialog (A) + on-open `motif_version` staleness detection (B) | §7 |

Stage 1 deliberately excludes drafts, validation-on-import, the render timeout, MCP, and UI authoring — those are Stages 2–5. Stage 1 trusts files already present on disk (as if installed) so the storage/serving/catalog plumbing can be built and tested in isolation.

---

## File Structure (Stage 1)

- **Create** `apps/desktop/src-tauri/src/motifs/store.rs` — `UserMotifStore`: list on-disk user manifests, path-safe file reads. One responsibility: the on-disk user-Motif store.
- **Modify** `apps/desktop/src-tauri/src/motifs/catalog.rs` — add `parse_manifest_island()` + two `MotifError` variants (manifest extraction lives with the manifest types).
- **Modify** `apps/desktop/src-tauri/src/motifs/builtin.rs` — scheme handler falls back to the store; extract a testable `resolve_bytes()`.
- **Modify** `apps/desktop/src-tauri/src/motifs/mod.rs` — declare `pub mod store;`.
- **Modify** `apps/desktop/src-tauri/src/lib.rs` — build + `manage` the `UserMotifStore` at boot.
- **Modify** `apps/desktop/src-tauri/src/commands.rs` — `list_motifs` merges built-ins + user manifests; extract a testable `motif_to_payload()`.
- **Modify** `apps/desktop/src-tauri/src/motifs/commands.rs` — `motif_capture_frame` resolves `ctx.duration` for user Motifs too; extract a testable `resolve_capture_duration()`.
- **Modify** `apps/desktop/src/render/motifs/catalog.ts` — runtime-extensible catalog (`setUserMotifs`).
- **Create** `apps/desktop/src/render/motifs/syncCatalog.ts` — `syncUserMotifsFromBackend()` (pulls `listMotifs()` IPC → `setUserMotifs`).
- **Modify** `apps/desktop/src/main.tsx` — call `syncUserMotifsFromBackend()` at boot.
- **Tests:** `store` + `catalog` Rust unit tests inline; `apps/desktop/src/render/motifs/catalog.test.ts` (extend); `apps/desktop/src/render/motifs/syncCatalog.test.ts` (create).

**Commands used throughout:**
- Rust tests: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`
- TS tests: from `apps/desktop`: `npx vitest run <path>`
- TS typecheck: from `apps/desktop`: `npx tsc -b`

---

### Task 1: Manifest-island parser

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/catalog.rs` (add variants to `MotifError` near line 301; add `parse_manifest_island` after the `Motif` impl ~line 240)

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `catalog.rs` (after the existing tests):

```rust
    #[test]
    fn parses_a_valid_manifest_island() {
        let html = r#"<!doctype html><html><head>
<script type="application/json" id="motif-manifest">
{ "id": "user-x", "name": "User X", "version": 1, "size": [640, 480],
  "default_duration_s": 4.0, "props_schema": {} }
</script>
</head><body><script>motif.define({ setup(){} });</script></body></html>"#;
        let m = parse_manifest_island(html).expect("island parses");
        assert_eq!(m.id, "user-x");
        assert_eq!(m.size, [640, 480]);
    }

    #[test]
    fn missing_island_is_an_error() {
        let html = "<html><body>no island here</body></html>";
        assert!(matches!(
            parse_manifest_island(html),
            Err(MotifError::NoManifestIsland)
        ));
    }

    #[test]
    fn malformed_island_json_is_an_error() {
        let html = r#"<script type="application/json" id="motif-manifest">{ not json }</script>"#;
        assert!(matches!(
            parse_manifest_island(html),
            Err(MotifError::ManifestParse(_))
        ));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::catalog::tests::parses_a_valid_manifest_island motifs::catalog::tests::missing_island_is_an_error motifs::catalog::tests::malformed_island_json_is_an_error`
Expected: FAIL — `cannot find function parse_manifest_island` / `no variant NoManifestIsland`.

- [ ] **Step 3: Add the error variants**

In `catalog.rs`, extend the `MotifError` enum (the `#[derive(Debug, thiserror::Error)] pub enum MotifError`) with:

```rust
    #[error("no <script type=\"application/json\" id=\"motif-manifest\"> island found in HTML")]
    NoManifestIsland,
    #[error("manifest island is not valid JSON: {0}")]
    ManifestParse(String),
```

- [ ] **Step 4: Implement `parse_manifest_island`**

In `catalog.rs`, after the `impl Motif { … }` block, add:

```rust
/// Extract and parse the Motif's metadata island from its HTML, WITHOUT
/// executing the page. A user Motif is a single self-contained `.html` whose
/// manifest is a delimited JSON island:
///
/// ```html
/// <script type="application/json" id="motif-manifest">{ … }</script>
/// ```
///
/// This is the single static source of a Motif's metadata (see the upload
/// design spec §2). We locate the island by its `id="motif-manifest"` marker,
/// take the text up to the next `</script>`, and `serde_json`-parse it into a
/// `Manifest`. Whitespace and other attributes on the tag are tolerated; we
/// control the writer side so the format is stable.
pub fn parse_manifest_island(html: &str) -> Result<Manifest, MotifError> {
    let id_marker = html
        .find(r#"id="motif-manifest""#)
        .ok_or(MotifError::NoManifestIsland)?;
    // End of the opening `<script ...>` tag: the first `>` at or after the marker.
    let tag_end = html[id_marker..]
        .find('>')
        .map(|i| id_marker + i + 1)
        .ok_or(MotifError::NoManifestIsland)?;
    let close = html[tag_end..]
        .find("</script>")
        .map(|i| tag_end + i)
        .ok_or(MotifError::NoManifestIsland)?;
    let json = html[tag_end..close].trim();
    serde_json::from_str(json).map_err(|e| MotifError::ManifestParse(e.to_string()))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::catalog::tests::parses_a_valid_manifest_island motifs::catalog::tests::missing_island_is_an_error motifs::catalog::tests::malformed_island_json_is_an_error`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/catalog.rs
git commit -m "feat(motifs): parse the manifest-island from a Motif's HTML"
```

---

### Task 2: `UserMotifStore` — list manifests + path-safe reads

**Files:**
- Create: `apps/desktop/src-tauri/src/motifs/store.rs`
- Modify: `apps/desktop/src-tauri/src/motifs/mod.rs` (add `pub mod store;` next to the other `pub mod` lines, ~line 27)

- [ ] **Step 1: Declare the module**

In `mod.rs`, add under the existing `pub mod catalog;`:

```rust
pub mod store;
```

- [ ] **Step 2: Write `store.rs` with failing tests**

Create `apps/desktop/src-tauri/src/motifs/store.rs`:

```rust
//! The on-disk store of user-installed Motifs, rooted at
//! `<app_config_dir>/motifs/`.
//!
//! Layout: `<root>/<id>/index.html` (a single self-contained document whose
//! manifest is a `<script type="application/json" id="motif-manifest">` island)
//! plus optional `<root>/<id>/assets/...`. The reserved `<root>/drafts/`
//! subtree is for Stage 2 (work-in-progress drafts) and is skipped here.
//!
//! Stage 1 only READS this store; nothing writes user Motifs yet (tests place
//! files directly). All path resolution is component-validated so a served
//! `motif://<id>/<rest>` request can never escape the Motif's own directory.

use std::path::{Path, PathBuf};

use super::catalog::{parse_manifest_island, Manifest};

/// Directory name reserved for Stage-2 drafts; never treated as an installed
/// Motif id.
pub const DRAFTS_DIR: &str = "drafts";

/// The global user-Motif store. Cheap to clone-by-reference via Tauri state.
pub struct UserMotifStore {
    root: PathBuf,
}

/// Validate a `/`-separated relative path into safe OS path components.
///
/// Rejects anything that could escape the Motif directory: empty segments,
/// `.`/`..`, absolute paths, Windows drive letters (`:`), and backslashes.
/// Returns the rejoined relative `PathBuf` on success.
fn safe_rel(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return None;
        }
        if seg.contains('\\') || seg.contains(':') {
            return None;
        }
        out.push(seg);
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

impl UserMotifStore {
    /// Root at `<app_config_dir>/motifs/`. Does not create the directory; a
    /// missing root simply yields an empty catalog.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Read a file from `<root>/<id>/<rel>`, path-safely. `None` if `id`/`rel`
    /// are unsafe or the file does not exist.
    pub fn read_file(&self, id: &str, rel: &str) -> Option<Vec<u8>> {
        let safe_id = safe_rel(id)?;
        let safe = safe_rel(rel)?;
        let path = self.root.join(safe_id).join(safe);
        std::fs::read(path).ok()
    }

    /// Read a user Motif's `index.html` as a string.
    pub fn read_html(&self, id: &str) -> Option<String> {
        self.read_file(id, "index.html")
            .and_then(|b| String::from_utf8(b).ok())
    }

    /// Every installed user Motif's manifest, id-sorted. Subdirectories whose
    /// `index.html` is missing or whose island fails to parse are skipped (with
    /// a warning); the reserved `drafts/` subtree is ignored.
    pub fn list_manifests(&self) -> Vec<Manifest> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if entry.file_name() == DRAFTS_DIR {
                continue;
            }
            let Ok(html) = std::fs::read_to_string(path.join("index.html")) else {
                continue;
            };
            match parse_manifest_island(&html) {
                Ok(m) => out.push(m),
                Err(e) => tracing::warn!(
                    "user motif {:?}: bad manifest island: {e}",
                    entry.file_name()
                ),
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_motif(root: &Path, id: &str, manifest_json: &str) {
        let dir = root.join(id);
        fs::create_dir_all(dir.join("assets")).unwrap();
        let html = format!(
            r#"<script type="application/json" id="motif-manifest">{manifest_json}</script>
<script>motif.define({{ setup(){{}} }});</script>"#
        );
        fs::write(dir.join("index.html"), html).unwrap();
        fs::write(dir.join("assets").join("logo.svg"), b"<svg/>").unwrap();
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        assert!(store.read_file("user-x", "../secret.txt").is_none());
        assert!(store.read_file("user-x", "a/../../b").is_none());
        assert!(store.read_file("..", "index.html").is_none());
        assert!(store.read_file("user-x", "/etc/hosts").is_none());
        assert!(store.read_file("user-x", "a\\b").is_none());
    }

    #[test]
    fn reads_an_existing_asset() {
        let tmp = tempfile::tempdir().unwrap();
        write_motif(
            tmp.path(),
            "user-x",
            r#"{"id":"user-x","name":"X","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}"#,
        );
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        assert_eq!(store.read_file("user-x", "assets/logo.svg"), Some(b"<svg/>".to_vec()));
        assert!(store.read_html("user-x").unwrap().contains("motif.define"));
    }

    #[test]
    fn lists_installed_skipping_drafts_and_broken() {
        let tmp = tempfile::tempdir().unwrap();
        write_motif(
            tmp.path(),
            "user-a",
            r#"{"id":"user-a","name":"A","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}"#,
        );
        // A draft dir (reserved) and a broken motif (no island) must be ignored.
        fs::create_dir_all(tmp.path().join("drafts").join("wip")).unwrap();
        fs::write(tmp.path().join("drafts").join("wip").join("index.html"), "draft").unwrap();
        fs::create_dir_all(tmp.path().join("broken")).unwrap();
        fs::write(tmp.path().join("broken").join("index.html"), "<html>no island</html>").unwrap();

        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let ids: Vec<String> = store.list_manifests().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["user-a".to_string()]);
    }

    #[test]
    fn missing_root_is_empty() {
        let store = UserMotifStore::new(PathBuf::from("/no/such/dir/at/all"));
        assert!(store.list_manifests().is_empty());
        assert!(store.read_html("anything").is_none());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail, then pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::store`
Expected first run: COMPILE — confirm `tempfile` is a dev-dependency (it is used by `view_state.rs`/`export_settings_store.rs` tests). If the module didn't compile before adding the tests, this run both compiles and passes. Expected: PASS (4 passed).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/store.rs apps/desktop/src-tauri/src/motifs/mod.rs
git commit -m "feat(motifs): add UserMotifStore (path-safe disk read + manifest list)"
```

---

### Task 3: Build + manage the store at boot

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (in the `.setup(...)` closure, near the `app_config_dir` block ~lines 225–235)

- [ ] **Step 1: Manage the store next to the config-dir stores**

In `lib.rs`, immediately after `app.manage(app_settings::AppSettingsStore::new(config_dir));` (the last `config_dir` consumer; reorder so the motif store is created before `config_dir` is moved, or clone `config_dir`), add:

```rust
            // User-installed Motifs live in `<app_config_dir>/motifs/`, served
            // by the `motif:` scheme handler and merged into the catalog
            // alongside the embedded built-ins. (Upload design spec §2.)
            let motifs_root = config_dir.join("motifs");
            if let Err(e) = std::fs::create_dir_all(&motifs_root) {
                tracing::warn!("user-motif dir setup failed: {e:#} ({})", motifs_root.display());
            }
            app.manage(motifs::store::UserMotifStore::new(motifs_root));
```

> Note: `config_dir` is moved into `AppSettingsStore::new(config_dir)` on the
> existing line. Change that line to `AppSettingsStore::new(config_dir.clone())`
> so `config_dir` is still available for `motifs_root`, OR place this block
> BEFORE the `AppSettingsStore` line. Either is fine; pick one and keep the
> borrow checker happy.

- [ ] **Step 2: Verify it compiles**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: builds with no errors (the new `app.manage` line and `motifs::store` path resolve).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): manage UserMotifStore at <app_config_dir>/motifs"
```

---

### Task 4: Scheme handler falls back to the store

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/builtin.rs` (the `handle_request` fn ~line 161; add a `resolve_bytes` helper + a test)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `builtin.rs`:

```rust
    #[test]
    fn resolve_prefers_builtin_then_store() {
        use crate::motifs::store::UserMotifStore;
        let tmp = tempfile::tempdir().unwrap();
        // A user Motif on disk.
        let dir = tmp.path().join("user-z");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), b"<html>user-z</html>").unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());

        // Built-in wins even if a same-id dir existed; here ids differ.
        let builtin = resolve_bytes(Some(&store), "countdown", "index.html").unwrap();
        assert!(std::str::from_utf8(&builtin).unwrap().contains("motif.define"));

        // User Motif served from the store fallback.
        let user = resolve_bytes(Some(&store), "user-z", "index.html").unwrap();
        assert_eq!(user, b"<html>user-z</html>".to_vec());

        // Unknown → None.
        assert!(resolve_bytes(Some(&store), "nope", "index.html").is_none());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::builtin::tests::resolve_prefers_builtin_then_store`
Expected: FAIL — `cannot find function resolve_bytes`.

- [ ] **Step 3: Add `resolve_bytes` and use it in the handler**

In `builtin.rs`, add the helper above `handle_request`:

```rust
/// Resolve a `(id, rest)` request to bytes: embedded built-in first, then the
/// on-disk user-Motif store. Built-ins always win, so an uploaded Motif can
/// never shadow one. Returned as an owned `Vec` to unify the `&'static`
/// built-in path with the heap-read store path.
fn resolve_bytes(
    store: Option<&crate::motifs::store::UserMotifStore>,
    id: &str,
    rest: &str,
) -> Option<Vec<u8>> {
    if let Some(b) = lookup(id, rest) {
        return Some(b.to_vec());
    }
    store.and_then(|s| s.read_file(id, rest))
}
```

Then rewrite `handle_request` to use the app handle + store fallback. Change the
signature's `_ctx` to `ctx` and replace the body's lookup with `resolve_bytes`:

```rust
pub fn handle_request<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let uri = request.uri();
    let path = uri.path();
    let Some((id, rest)) = parse_path(path) else {
        return not_found("motif: malformed path (expected /<id>/<file>)");
    };

    // The store is managed at boot; in the rare pre-manage window it's absent,
    // and only built-ins resolve — which is correct.
    let store = ctx
        .app_handle()
        .try_state::<crate::motifs::store::UserMotifStore>();
    let Some(bytes) = resolve_bytes(store.as_deref(), &id, &rest) else {
        return not_found(&format!("motif: no file '{id}/{rest}'"));
    };

    let content_type = content_type_for(&rest);
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, csp())
        .body(bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
```

Add the import at the top of `builtin.rs` if needed: `use tauri::Manager;` (for
`try_state` on `AppHandle`).

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::builtin`
Expected: PASS (all builtin tests, including `resolve_prefers_builtin_then_store`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/builtin.rs
git commit -m "feat(motifs): serve user Motifs from disk via the motif: scheme (builtin-first)"
```

---

### Task 5: `list_motifs` merges built-ins + user Motifs

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`list_motifs` ~line 1925; add `motif_to_payload` helper + a test)

- [ ] **Step 1: Write the failing test**

Add a test near the other command tests in `commands.rs` (inside its `#[cfg(test)] mod tests`, or add one if there isn't a local one — use the module that already imports `super::*`):

```rust
    #[test]
    fn motif_payload_includes_manifest_fields_and_html() {
        let m = crate::motifs::catalog::builtin_countdown();
        let v = motif_to_payload(&m.manifest, m.html.clone()).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.get("id").unwrap(), "countdown");
        assert!(obj.get("html").unwrap().as_str().unwrap().contains("motif.define"));
        assert!(obj.contains_key("size"));
        assert!(obj.contains_key("props_schema"));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::tests::motif_payload_includes_manifest_fields_and_html`
Expected: FAIL — `cannot find function motif_to_payload`.

- [ ] **Step 3: Extract `motif_to_payload` and merge the store**

In `commands.rs`, add the helper above `list_motifs`:

```rust
/// Serialize a manifest + its raw `html` into the picker payload shape (a
/// superset of the MCP `list_motifs`: every manifest field plus `html` for the
/// client-side preview). One helper so built-in and user Motifs emit the same
/// shape.
fn motif_to_payload(
    manifest: &crate::motifs::catalog::Manifest,
    html: String,
) -> Result<serde_json::Value, String> {
    let mut v = serde_json::to_value(manifest).map_err(|e| format!("manifest serialize: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "manifest is not a JSON object".to_string())?;
    obj.insert("html".to_string(), serde_json::Value::String(html));
    Ok(v)
}
```

Then rewrite `list_motifs` to take the store and merge:

```rust
#[tauri::command]
pub async fn list_motifs(
    store: tauri::State<'_, crate::motifs::store::UserMotifStore>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    // Built-ins first (fixed display order), then on-disk user Motifs.
    for t in catalog::builtins() {
        out.push(motif_to_payload(&t.manifest, t.html)?);
    }
    for manifest in store.list_manifests() {
        let html = store.read_html(&manifest.id).unwrap_or_default();
        out.push(motif_to_payload(&manifest, html)?);
    }
    Ok(out)
}
```

> The handler list in `lib.rs` (`commands::list_motifs`) needs no change — Tauri
> injects the new `State` argument automatically.

- [ ] **Step 4: Run it to verify it passes + still compiles**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::tests::motif_payload_includes_manifest_fields_and_html`
Expected: PASS. Then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run` → builds clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(motifs): list_motifs merges built-ins with on-disk user Motifs"
```

---

### Task 6: Capture duration resolves for user Motifs

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/commands.rs` (`motif_capture_frame` ~lines 110–114; add `resolve_capture_duration` helper + a test)

- [ ] **Step 1: Write the failing test**

Add a `#[cfg(test)] mod tests` to `motifs/commands.rs` (the file currently has none):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::motifs::catalog::{builtin_countdown, Manifest};

    #[test]
    fn duration_uses_builtin_then_user_then_default() {
        let builtins = crate::motifs::catalog::builtins();
        let props = serde_json::json!({ "seconds": 7 });

        // Built-in countdown: max_duration_prop "seconds" → 7.0.
        let d = resolve_capture_duration("countdown", &builtins, &[], &props);
        assert!((d - 7.0).abs() < 1e-9);

        // A user manifest (not in builtins) resolves from its own manifest.
        let mut user: Manifest = builtin_countdown().manifest;
        user.id = "user-x".into();
        user.max_duration_prop = None;
        user.max_duration_s = None;
        user.content_duration_s = Some(2.5);
        let d2 = resolve_capture_duration("user-x", &builtins, std::slice::from_ref(&user), &serde_json::json!({}));
        assert!((d2 - 2.5).abs() < 1e-9);

        // Unknown id → 5.0 fallback (matches the prior hardcoded default).
        let d3 = resolve_capture_duration("ghost", &builtins, &[], &serde_json::json!({}));
        assert!((d3 - 5.0).abs() < 1e-9);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::commands::tests::duration_uses_builtin_then_user_then_default`
Expected: FAIL — `cannot find function resolve_capture_duration`.

- [ ] **Step 3: Add the helper and use it in the command**

In `motifs/commands.rs`, add above `motif_capture_frame`:

```rust
/// Resolve the capture `ctx.duration` (seconds) for `motif_id`: search the
/// built-ins, then the user manifests, then fall back to 5.0. Pure so it's
/// unit-testable away from the async command + Tauri state.
fn resolve_capture_duration(
    motif_id: &str,
    builtins: &[super::catalog::Motif],
    user_manifests: &[super::catalog::Manifest],
    props: &serde_json::Value,
) -> f64 {
    if let Some(m) = builtins.iter().find(|m| m.id() == motif_id) {
        return super::catalog::motif_ctx_duration_s(&m.manifest, props);
    }
    if let Some(m) = user_manifests.iter().find(|m| m.id == motif_id) {
        return super::catalog::motif_ctx_duration_s(m, props);
    }
    5.0
}
```

Add the store to the command signature and replace the `duration` block. Change
the signature:

```rust
pub async fn motif_capture_frame(
    app: AppHandle,
    state: State<'_, MotifRuntime>,
    capture: State<'_, MotifCapture>,
    store: State<'_, super::store::UserMotifStore>,
    motif_id: String,
    t_sec: f64,
    props_json: String,
    width: u32,
    height: u32,
    settle_rafs: Option<u32>,
) -> Result<String, String> {
```

Replace the existing `let duration = super::catalog::builtins()…unwrap_or(5.0);`
block with:

```rust
    let duration = resolve_capture_duration(
        &motif_id,
        &super::catalog::builtins(),
        &store.list_manifests(),
        &props,
    );
```

> The dev `WEFTCUT_MOTIF_SMOKE` block in `lib.rs` calls `motif_capture_frame`
> via a `capture!` macro that passes the state args positionally. Add the new
> `store` state there too: fetch `app_for_smoke.state::<motifs::store::UserMotifStore>()`
> and pass it in the same position as the signature. Update the macro's arg list
> to include it.

- [ ] **Step 4: Run it to verify it passes + builds**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::commands::tests::duration_uses_builtin_then_user_then_default`
Expected: PASS. Then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run` → builds clean (smoke macro updated).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): capture ctx.duration resolves for user Motifs too"
```

---

### Task 7: TS runtime-extensible catalog

**Files:**
- Modify: `apps/desktop/src/render/motifs/catalog.ts` (the `catalog` const ~line 71 and the accessors)
- Modify: `apps/desktop/src/render/motifs/catalog.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Add to `catalog.test.ts`:

```ts
import { setUserMotifs, getMotif, listMotifs } from "./catalog";

const userManifest = {
  id: "user-demo",
  name: "User Demo",
  version: 1,
  size: [800, 200] as [number, number],
  default_duration_s: 3,
  props_schema: {},
};

it("merges user motifs at runtime without dropping built-ins", () => {
  setUserMotifs([userManifest]);
  expect(getMotif("user-demo")?.manifest.size).toEqual([800, 200]);
  const ids = listMotifs().map((m) => m.id);
  expect(ids).toContain("countdown");
  expect(ids).toContain("lower-third");
  expect(ids).toContain("user-demo");
  // Clearing user motifs restores the built-in-only catalog.
  setUserMotifs([]);
  expect(getMotif("user-demo")).toBeNull();
  expect(listMotifs().map((m) => m.id)).toContain("countdown");
});

it("never lets a user motif shadow a built-in id", () => {
  setUserMotifs([{ ...userManifest, id: "countdown", size: [1, 1] }]);
  // Built-in countdown (480x480) must remain authoritative.
  expect(getMotif("countdown")?.manifest.size).toEqual([480, 480]);
  setUserMotifs([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/catalog.test.ts`
Expected: FAIL — `setUserMotifs` is not exported.

- [ ] **Step 3: Make the catalog runtime-extensible**

In `catalog.ts`, replace the `const catalog = buildCatalog();` line and the
accessors with a built-in seed + a mutable user layer:

```ts
const builtinCatalog = buildCatalog();
let userCatalog = new Map<string, Motif>();
let merged = mergeCatalogs();

/// Built-ins win on id collision so an uploaded Motif can never shadow one.
function mergeCatalogs(): Map<string, Motif> {
  const out = new Map<string, Motif>(userCatalog);
  for (const [id, motif] of builtinCatalog) {
    if (userCatalog.has(id)) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/motifs] user motif id "${id}" shadows a built-in; built-in kept`);
    }
    out.set(id, motif);
  }
  return out;
}

/// Replace the runtime user-Motif layer (from the backend `list_motifs` IPC).
/// Built-ins are always present and authoritative; this only adds/removes the
/// user entries. Idempotent — call it whenever the backend catalog changes.
export function setUserMotifs(manifests: MotifManifest[]): void {
  userCatalog = new Map(manifests.map((manifest) => [manifest.id, { manifest }]));
  merged = mergeCatalogs();
}

export function getMotif(id: string): Motif | null {
  return merged.get(id) ?? null;
}

export function listMotifs(): MotifManifest[] {
  return [...merged.values()].map((t) => t.manifest);
}
```

> Delete the old `const catalog = …`, `getMotif`, and `listMotifs` definitions
> they replace.

- [ ] **Step 4: Run to verify it passes + typecheck**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/catalog.test.ts`
Expected: PASS. Then `npx tsc -b` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/motifs/catalog.ts apps/desktop/src/render/motifs/catalog.test.ts
git commit -m "feat(motifs): runtime-extensible TS catalog (setUserMotifs, built-in-wins)"
```

---

### Task 8: Populate the TS catalog from the backend at boot

**Files:**
- Create: `apps/desktop/src/render/motifs/syncCatalog.ts`
- Create: `apps/desktop/src/render/motifs/syncCatalog.test.ts`
- Modify: `apps/desktop/src/main.tsx` (after the `motif_register_runtime` invoke ~line 18)

- [ ] **Step 1: Write the failing test (mock the IPC)**

Create `apps/desktop/src/render/motifs/syncCatalog.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ipc", () => ({
  listMotifs: vi.fn(),
}));

import { listMotifs as ipcListMotifs } from "../../ipc";
import { syncUserMotifsFromBackend } from "./syncCatalog";
import { getMotif, setUserMotifs } from "./catalog";

describe("syncUserMotifsFromBackend", () => {
  beforeEach(() => setUserMotifs([]));

  it("registers backend user motifs into the runtime catalog", async () => {
    (ipcListMotifs as ReturnType<typeof vi.fn>).mockResolvedValue([
      // The IPC payload carries manifest fields + an extra `html` field.
      { id: "from-backend", name: "BE", version: 1, size: [320, 240], default_duration_s: 2, props_schema: {}, html: "<html></html>" },
      { id: "countdown", name: "Countdown", version: 1, size: [480, 480], default_duration_s: 5, props_schema: {}, html: "x" },
    ]);
    await syncUserMotifsFromBackend();
    expect(getMotif("from-backend")?.manifest.size).toEqual([320, 240]);
    // Built-in still authoritative (size unchanged by the backend echo).
    expect(getMotif("countdown")?.manifest.size).toEqual([480, 480]);
  });

  it("swallows IPC errors (catalog stays built-in-only)", async () => {
    (ipcListMotifs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ipc down"));
    await expect(syncUserMotifsFromBackend()).resolves.toBeUndefined();
    expect(getMotif("from-backend")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/syncCatalog.test.ts`
Expected: FAIL — cannot resolve `./syncCatalog`.

- [ ] **Step 3: Implement `syncCatalog.ts`**

Create `apps/desktop/src/render/motifs/syncCatalog.ts`:

```ts
// Pulls the backend Motif catalog (built-ins + on-disk user Motifs) over the
// `list_motifs` IPC and registers it into the runtime TS catalog so the
// frame-math (getMotif / resolveMotifContentDurationUs / motifFrameDescriptor)
// sees user Motifs. Built-ins are seeded statically in catalog.ts and stay
// authoritative; this only adds the user layer. Called once at boot (main.tsx)
// and re-callable whenever the catalog changes (later stages).
import { listMotifs as ipcListMotifs } from "../../ipc";
import { setUserMotifs, type MotifManifest } from "./catalog";

export async function syncUserMotifsFromBackend(): Promise<void> {
  try {
    const payload = await ipcListMotifs();
    // The IPC payload is a manifest superset (adds `html`); MotifManifest is a
    // structural subset, so the extra field is harmless. Strip nothing.
    setUserMotifs(payload as unknown as MotifManifest[]);
  } catch {
    // Leave the built-in-only catalog in place; a transient IPC failure must
    // not blank the picker or the frame-math.
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/syncCatalog.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Wire it at boot**

In `main.tsx`, after the existing `void invoke("motif_register_runtime", …)`
line, add:

```tsx
import { syncUserMotifsFromBackend } from "./render/motifs/syncCatalog";
// …
// Populate the runtime Motif catalog (built-ins + on-disk user Motifs) so the
// frame-math and picker see user Motifs. Fire-and-forget; failures keep the
// built-in-only catalog.
void syncUserMotifsFromBackend();
```

- [ ] **Step 6: Typecheck**

Run (from `apps/desktop`): `npx tsc -b`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/motifs/syncCatalog.ts apps/desktop/src/render/motifs/syncCatalog.test.ts apps/desktop/src/main.tsx
git commit -m "feat(motifs): sync the runtime TS catalog from the backend at boot"
```

---

### Task 9: Stage-1 manual verification (real WebView2)

No code; confirm the foundation works end-to-end before moving to Stage 2.

- [ ] **Step 1: Place a test user Motif on disk**

Find the running app's config dir (`<app_config_dir>/motifs/`; on Windows this
is under `%APPDATA%/<app identifier>/`). Create `<that>/motifs/test-overlay/index.html`:

```html
<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: transparent; }
  .box { width: 600px; height: 200px; background: #2266ff; color: #fff;
         font: 700 48px sans-serif; display: grid; place-items: center; }
</style>
<script type="application/json" id="motif-manifest">
{ "id": "test-overlay", "name": "Test Overlay", "version": 1, "size": [600, 200],
  "default_duration_s": 5, "content_duration_s": 0.6, "props_schema": {
    "label": { "type": "string", "default": "HELLO" } } }
</script></head><body>
<div class="box" id="box">…</div>
<script>
  motif.define({
    setup(props) {
      const box = document.getElementById("box");
      box.textContent = props.label;
      box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, fill: "both" });
    },
  });
</script></body></html>
```

- [ ] **Step 2: Launch the app and confirm the Motif surfaces**

Run the app (`tauri dev`, or drive the already-running dev instance via the
tauri-mcp-server `webview_execute_js` per the project's verification habit).
Confirm:
- `test-overlay` appears in the MotifPicker list.
- Placing it on the timeline and scrubbing renders the blue box with "HELLO"
  in the project preview canvas (served from disk via the `motif:` scheme,
  captured via the existing CDP path).
- The held tail (past 0.6 s `content_duration_s`) shows the steady frame.

- [ ] **Step 3: Confirm full gates are green**

Run:
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → all pass.
- from `apps/desktop`: `npx vitest run` → all pass.
- from `apps/desktop`: `npx tsc -b` → clean.

- [ ] **Step 4: Record the result**

Note the verification outcome (ids listed, rendered px observed) in the commit
message or a short note; this closes Stage 1.

---

## Self-Review

**Spec coverage (Stage 1 scope = spec §2 storage, §8.2 TS runtime catalog, §8.3 disk serving):**
- §2 storage location (global app-data) → Task 3 (`<app_config_dir>/motifs`).
- §8.3 disk serving, path-safe → Tasks 2 (`safe_rel`, `UserMotifStore`) + 4 (scheme fallback).
- §8.2 TS runtime catalog → Tasks 7 (`setUserMotifs`) + 8 (`syncUserMotifsFromBackend`, boot wiring).
- Manifest island (the §2 format's static-parse requirement) → Task 1.
- Catalog merge / capture correctness for user Motifs → Tasks 5 + 6.
- Stages 2–5 (drafts, validation, render timeout, preview/edit, MCP, cross-project) are explicitly out of this plan; mapped in the roadmap above.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows real assertions and exact run commands.

**Type/name consistency:** `parse_manifest_island` (Task 1) is consumed by `store.rs` (Task 2). `UserMotifStore`/`read_file`/`read_html`/`list_manifests` are defined in Task 2 and used identically in Tasks 4/5/6. `motif_to_payload` (Task 5) and `resolve_capture_duration` (Task 6) are pure helpers defined and tested in-place. `setUserMotifs`/`getMotif`/`listMotifs` (Task 7) are consumed by `syncCatalog.ts` (Task 8). `MotifManifest` type is the existing `catalog.ts` export.

**Open follow-through into Stage 2:** Stage 1 trusts on-disk manifests (complete islands incl. `id`/`version`). Stage 2 adds the import path that *assigns* `id`/`version`, validates the authored manifest+props, and writes the canonical file — at which point untrusted input first enters. The render-timeout (security) also lands in Stage 2. Until then, only manually-placed (trusted) files exist, so Stage 1 ships safely.
