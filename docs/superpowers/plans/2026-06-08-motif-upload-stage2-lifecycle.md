# Motif Upload — Stage 2: Draft store, lifecycle, validation & timeout-recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the backend authoring lifecycle for user Motifs — write a draft, install it (publish-new or update-in-place with a version bump), and delete it — gated by import-time manifest validation, with lenient prop migration and host recovery after a capture timeout.

**Architecture:** A new `motifs/authoring.rs` holds the pure building blocks (manifest validation, id sanitization, the manifest-island *writer*, lenient prop canonicalization). `UserMotifStore` (Stage 1) gains write/install/delete methods over `<app_config_dir>/motifs/` (+ a `drafts/` subtree). Four Tauri commands (`get_motif_source`, `write_motif_draft`, `install_motif`, `delete_motif`) expose the lifecycle to the UI (Stage 3) and mirror the MCP surface (Stage 4). The capture path rebuilds the hidden host when an eval/screenshot times out, so a runaway Motif can't wedge the shared host for everyone else.

**Tech Stack:** Rust (Tauri 2.11, serde, blake3, thiserror, tracing, tempfile for tests), WebView2 CDP (Stage 1).

---

## Stage roadmap (this plan = Stage 2 of 5)

Spec: `docs/superpowers/specs/2026-06-08-motif-upload-authoring-design.md` (§3 lifecycle, §4 identity/install/migration, §10 security). Stage 1 (foundation: on-disk store + disk serving + runtime catalogs) is **merged to `main`**.

| Stage | Scope | Status |
|---|---|---|
| 1 | On-disk user Motifs: store + path-safe serving + runtime catalogs | **done, merged** |
| **2 (this plan)** | Draft store + lifecycle (write/install·new\|update/delete) + import validation + lenient prop migration + capture-timeout host recovery | this plan |
| 3 | Preview reuse + hot reload + dual edit surfaces + TS lenient render canonicalize | next |
| 4 | MCP surface (mirror the Stage-2 commands) + catalog-change resync | — |
| 5 | Cross-project usage signal (A + B) | — |

**Out of this plan (deferred):** any UI (Stage 3), the MCP tools (Stage 4), the TS render-side lenient canonicalize (Stage 3 — the render path), placed-layer rebind on install (Stage 3).

## Command model (encoding spec §4, simplified per "尽量简单")

- **Format on disk:** one self-contained `.html` per Motif with a `<script type="application/json" id="motif-manifest">` island (Stage 1's `parse_manifest_island` reads it; this stage adds the *writer*). Drafts live at `<root>/drafts/<draftId>/index.html`; published user Motifs at `<root>/<id>/index.html`.
- **Seeding ("edit installed X") is client-side:** the caller does `get_motif_source(X)` → edits → `write_motif_draft({manifest, html})`. The backend command needs no `from` param (dropped from the spec's sketch — the seed is just content the caller passes).
- `get_motif_source(id) -> { manifest, html }` — built-in (from `catalog::builtins()`) or user (`store.get_motif`).
- `write_motif_draft({ manifest, html }) -> draftId` — validate, compose the single file, write to `drafts/<draftId>/`. `draftId` = sanitized slug of `manifest.name`, deduped within `drafts/`.
- `install_motif({ draft_id, mode }) -> finalId` — `mode` is `"new"` or `{ "update": "<target_id>" }`:
  - **new:** `finalId` = unique sanitized slug of `manifest.name` vs built-ins + published; rewrite the island's `id=finalId`, `version=1`; move the draft dir to `<root>/<finalId>/`.
  - **update:** `finalId` = `target_id` (must be an existing **user** Motif — reject built-ins); write the draft's `{manifest(id=target_id, version=prev+1), html}` onto `<root>/<target_id>/`; the `version` bump busts the frame cache (live/mutable). Delete the draft dir afterward.
- `delete_motif(id)` — reject built-in ids; remove `<root>/<id>/`.

**Identity invariant (the Stage-1 `TODO(stage 2)`):** a published Motif's island `id` **always equals its directory name** — install rewrites the island `id` to the (dir == final) id, so the serve path (`read_file(id, …)` → `<root>/<id>/`) can't diverge from what `list_manifests` advertises.

---

## File Structure (Stage 2)

- **Create** `apps/desktop/src-tauri/src/motifs/authoring.rs` — pure building blocks: `validate_manifest`, `sanitize_id` / `assign_unique_id`, `compose_motif_html` (island writer), `canonicalize_props_lenient`. One responsibility: turning untrusted `{manifest, html}` input into a safe, canonical, well-identified Motif.
- **Modify** `apps/desktop/src-tauri/src/motifs/store.rs` — add `drafts_root()`, `write_draft`, `list_draft_ids`, `published_ids`, `install_draft`, `delete_user_motif`. (Stage 1's `get_motif` / `read_file` / `list_manifests` stay.)
- **Modify** `apps/desktop/src-tauri/src/motifs/catalog.rs` — expose `BUILTIN_IDS` (reserved ids) and make `Motif`/`Manifest` reusable by authoring.
- **Create** `apps/desktop/src-tauri/src/motifs/authoring_commands.rs` — the four `#[tauri::command]`s + thin arg structs.
- **Modify** `apps/desktop/src-tauri/src/motifs/mod.rs` — `pub mod authoring; #[cfg(windows)] pub mod authoring_commands;` (the commands need no Windows-only API, but keep them next to the capture command; gate only if they reference capture — they don't, so no `cfg`).
- **Modify** `apps/desktop/src-tauri/src/lib.rs` — register the four commands in `generate_handler!`.
- **Modify** `apps/desktop/src-tauri/src/motifs/commands.rs` + `host.rs` — rebuild the host when a capture/eval times out.
- **Tests:** inline `#[cfg(test)]` in each new/modified module; `tempfile` for the store.

**Commands:** Rust tests `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>` (repo root).

---

### Task 1: Manifest validation

**Files:** Create `apps/desktop/src-tauri/src/motifs/authoring.rs`; modify `apps/desktop/src-tauri/src/motifs/mod.rs` (add `pub mod authoring;`).

- [ ] **Step 1: Declare the module.** In `mod.rs`, under `pub mod store;`:

```rust
pub mod authoring;
```

- [ ] **Step 2: Write `authoring.rs` with the validator + failing tests.**

Create `apps/desktop/src-tauri/src/motifs/authoring.rs`:

```rust
//! Pure building blocks for turning untrusted `{manifest, html}` upload input
//! into a safe, canonical, well-identified on-disk Motif. No I/O here — the
//! `UserMotifStore` does the disk work and calls these. (Upload design spec
//! §4, §10.)

use std::collections::BTreeMap;

use super::catalog::{Manifest, MotifError, PropSpec};

/// Hard ceiling on a Motif's authored render size (CSS px). Generous for any
/// real overlay; rejects absurd values that would blow up `setDeviceMetricsOverride`.
const MAX_DIMENSION: u32 = 8192;
/// Cap on `props_schema` entries — a sane upper bound for an overlay's controls.
const MAX_PROPS: usize = 64;

/// Validate a manifest parsed from untrusted upload input, BEYOND what serde
/// already enforces (serde guarantees the fields exist and have the right JSON
/// types). Checks the *semantic* constraints the renderer + timeline rely on,
/// and that every prop default satisfies its own spec (so a freshly-placed
/// layer's defaults can never fail `canonicalize_props`). Returns `Ok(())` or a
/// `MotifError` describing the first problem.
pub fn validate_manifest(m: &Manifest) -> Result<(), MotifError> {
    if m.name.trim().is_empty() {
        return Err(MotifError::InvalidManifest("name must not be empty".into()));
    }
    let [w, h] = m.size;
    if w == 0 || h == 0 || w > MAX_DIMENSION || h > MAX_DIMENSION {
        return Err(MotifError::InvalidManifest(format!(
            "size [{w},{h}] must be within [1,{MAX_DIMENSION}] on each axis"
        )));
    }
    if !(m.default_duration_s.is_finite() && m.default_duration_s > 0.0) {
        return Err(MotifError::InvalidManifest(
            "default_duration_s must be finite and > 0".into(),
        ));
    }
    for (field, val) in [
        ("max_duration_s", m.max_duration_s),
        ("content_duration_s", m.content_duration_s),
    ] {
        if let Some(s) = val {
            if !(s.is_finite() && s > 0.0) {
                return Err(MotifError::InvalidManifest(format!(
                    "{field} must be finite and > 0 when present"
                )));
            }
        }
    }
    if m.props_schema.len() > MAX_PROPS {
        return Err(MotifError::InvalidManifest(format!(
            "props_schema has {} entries (max {MAX_PROPS})",
            m.props_schema.len()
        )));
    }
    // Every prop's default must satisfy its own spec, and number bounds must be
    // ordered. We reuse the instance-prop validator by validating the default
    // value against the spec.
    for (key, spec) in &m.props_schema {
        if let PropSpec::Number { min, max, default } = spec {
            if let (Some(lo), Some(hi)) = (min, max) {
                if lo > hi {
                    return Err(MotifError::InvalidManifest(format!(
                        "prop `{key}`: min {lo} > max {hi}"
                    )));
                }
            }
            if !default.is_finite() {
                return Err(MotifError::InvalidManifest(format!(
                    "prop `{key}`: default must be finite"
                )));
            }
        }
        // Validate the default against the spec (color hex, string max_length,
        // number range) by round-tripping it through a one-key canonicalize.
        let mut one: BTreeMap<String, PropSpec> = BTreeMap::new();
        one.insert(key.clone(), spec.clone());
        super::catalog::validate_default_for(key, spec)?;
    }
    Ok(())
}
```

> This calls a small helper `validate_default_for` on the catalog side (Step 4) so the existing per-type validation logic isn't duplicated. The `one` BTreeMap is unused scaffolding — remove it; it's left here only to show intent. Final `authoring.rs` Step-2 code must NOT include the dead `one` map (delete those two lines).

Append failing tests to `authoring.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use super::super::catalog::Manifest;
    use std::collections::BTreeMap;

    fn base() -> Manifest {
        Manifest {
            id: "x".into(),
            name: "X".into(),
            version: 1,
            size: [640, 480],
            default_duration_s: 5.0,
            max_duration_s: None,
            max_duration_prop: None,
            content_duration_s: None,
            fonts: vec![],
            props_schema: BTreeMap::new(),
        }
    }

    #[test]
    fn accepts_a_sane_manifest() {
        assert!(validate_manifest(&base()).is_ok());
    }

    #[test]
    fn rejects_empty_name_zero_or_huge_size() {
        let mut m = base();
        m.name = "  ".into();
        assert!(validate_manifest(&m).is_err());
        let mut m = base();
        m.size = [0, 100];
        assert!(validate_manifest(&m).is_err());
        let mut m = base();
        m.size = [99999, 100];
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn rejects_bad_durations() {
        let mut m = base();
        m.default_duration_s = 0.0;
        assert!(validate_manifest(&m).is_err());
        let mut m = base();
        m.content_duration_s = Some(-1.0);
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn rejects_inverted_number_bounds_and_bad_color_default() {
        let mut m = base();
        m.props_schema.insert(
            "n".into(),
            PropSpec::Number { default: 5.0, min: Some(10.0), max: Some(1.0) },
        );
        assert!(validate_manifest(&m).is_err());

        let mut m = base();
        m.props_schema.insert(
            "c".into(),
            PropSpec::Color { default: "not-a-hex".into() },
        );
        assert!(validate_manifest(&m).is_err());
    }
}
```

- [ ] **Step 3: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring::tests`
Expected: FAIL — `validate_default_for` / `MotifError::InvalidManifest` not found.

- [ ] **Step 4: Add the catalog support (`InvalidManifest` variant + `validate_default_for`).**

In `catalog.rs`, add to `MotifError`:

```rust
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
```

And add a pub helper that validates a prop's default against its own spec, reusing the existing `validate_prop` logic:

```rust
/// Validate that a `PropSpec`'s `default` satisfies the spec (hex color,
/// string `max_length`, number range). Used by manifest import validation so a
/// placed layer's defaults can never fail `canonicalize_props`.
pub fn validate_default_for(key: &str, spec: &PropSpec) -> Result<(), MotifError> {
    let default_value = spec_default_json(spec);
    validate_prop(key, spec, &default_value)
}
```

(`spec_default_json` and `validate_prop` already exist in `catalog.rs`.)

- [ ] **Step 5: Remove the dead `one` scaffolding** from `validate_manifest` (the two lines building an unused `BTreeMap`), leaving just the `validate_default_for(key, spec)?;` call inside the loop. Re-read the loop body to confirm it is:

```rust
    for (key, spec) in &m.props_schema {
        if let PropSpec::Number { min, max, default } = spec {
            if let (Some(lo), Some(hi)) = (min, max) {
                if lo > hi {
                    return Err(MotifError::InvalidManifest(format!(
                        "prop `{key}`: min {lo} > max {hi}"
                    )));
                }
            }
            if !default.is_finite() {
                return Err(MotifError::InvalidManifest(format!(
                    "prop `{key}`: default must be finite"
                )));
            }
        }
        super::catalog::validate_default_for(key, spec)?;
    }
```

Also drop the now-unused `use std::collections::BTreeMap;` from the top of `authoring.rs` if nothing else uses it (the tests have their own import).

- [ ] **Step 6: Run to verify pass.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring::tests motifs::catalog::tests`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring.rs apps/desktop/src-tauri/src/motifs/catalog.rs apps/desktop/src-tauri/src/motifs/mod.rs
git commit -m "feat(motifs): import-time manifest validation"
```

---

### Task 2: Id sanitization + uniqueness

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring.rs`; modify `apps/desktop/src-tauri/src/motifs/catalog.rs` (expose `BUILTIN_IDS`).

- [ ] **Step 1: Write failing tests** in `authoring.rs` `tests`:

```rust
    #[test]
    fn sanitize_id_slugifies() {
        assert_eq!(sanitize_id("My Cool Motif!"), "my-cool-motif");
        assert_eq!(sanitize_id("  Trailing--dashes  "), "trailing-dashes");
        assert_eq!(sanitize_id("___"), "motif"); // empty after strip → fallback
        assert_eq!(sanitize_id("Lower/Third"), "lower-third");
    }

    #[test]
    fn assign_unique_id_avoids_collisions_and_builtins() {
        let taken = ["my-motif".to_string(), "my-motif-2".to_string()];
        // Collides with an existing user id → suffixes.
        assert_eq!(assign_unique_id("My Motif", &taken), "my-motif-3");
        // Collides with a built-in id → suffixes (never shadows a built-in).
        let none: [String; 0] = [];
        assert_eq!(assign_unique_id("countdown", &none), "countdown-2");
        // Free name → as-is.
        assert_eq!(assign_unique_id("Fresh", &taken), "fresh");
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring::tests::sanitize_id_slugifies motifs::authoring::tests::assign_unique_id_avoids_collisions_and_builtins`
Expected: FAIL — functions not found.

- [ ] **Step 3: Expose built-in ids** in `catalog.rs` (so authoring can reserve them without constructing every built-in):

```rust
/// The reserved built-in ids. A user/uploaded Motif may never take one of
/// these (the serve path resolves built-ins first, so a collision would be
/// unreachable anyway — but we reject it at id-assignment for clarity).
pub const BUILTIN_IDS: &[&str] = &["countdown", "lower-third"];
```

(Add a test in `catalog.rs` asserting `BUILTIN_IDS` matches `builtins()` ids, so a future built-in can't drift:)

```rust
    #[test]
    fn builtin_ids_const_matches_builtins() {
        let actual: Vec<String> = builtins().iter().map(|t| t.id().to_string()).collect();
        let expected: Vec<String> = BUILTIN_IDS.iter().map(|s| s.to_string()).collect();
        assert_eq!(actual, expected);
    }
```

- [ ] **Step 4: Implement `sanitize_id` + `assign_unique_id`** in `authoring.rs`:

```rust
use super::catalog::BUILTIN_IDS;
use super::store::DRAFTS_DIR;

/// Slugify an arbitrary display name into a safe id: lowercase ASCII
/// alphanumerics, every other run collapsed to a single `-`, trimmed. Falls
/// back to `"motif"` if nothing survives. The result is always a single safe
/// path segment (no `/`, `..`, drive letters), so it composes with the
/// path-safe store.
pub fn sanitize_id(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "motif".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Assign a unique id derived from `name`, avoiding `taken`, the built-in ids,
/// and the reserved `drafts` segment. Appends `-2`, `-3`, … on collision.
pub fn assign_unique_id(name: &str, taken: &[String]) -> String {
    let base = sanitize_id(name);
    let reserved = |id: &str| {
        BUILTIN_IDS.contains(&id) || id == DRAFTS_DIR || taken.iter().any(|t| t == id)
    };
    if !reserved(&base) {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !reserved(&candidate) {
            return candidate;
        }
        n += 1;
    }
}
```

- [ ] **Step 5: Run to verify pass.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring::tests motifs::catalog::tests`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring.rs apps/desktop/src-tauri/src/motifs/catalog.rs
git commit -m "feat(motifs): id sanitize + unique assignment (reserves built-ins/drafts)"
```

---

### Task 3: Manifest-island writer (`compose_motif_html`)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring.rs`.

The Stage-1 reader (`parse_manifest_island`) finds `id="motif-manifest"` and parses the JSON up to `</script>`. The writer must produce HTML the reader round-trips: inject a fresh island (replacing any existing one) carrying the canonical manifest.

- [ ] **Step 1: Write failing tests** in `authoring.rs` `tests`:

```rust
    #[test]
    fn compose_injects_island_that_parses_back() {
        let mut m = base();
        m.id = "demo".into();
        m.name = "Demo".into();
        let html = "<!doctype html><html><head></head><body><script>motif.define({setup(){}})</script></body></html>";
        let composed = compose_motif_html(&m, html);
        // The reader round-trips the manifest we wrote.
        let parsed = super::super::catalog::parse_manifest_island(&composed).expect("parses");
        assert_eq!(parsed.id, "demo");
        assert_eq!(parsed.name, "Demo");
        // Author body preserved.
        assert!(composed.contains("motif.define"));
    }

    #[test]
    fn compose_replaces_a_pre_existing_island() {
        let mut m = base();
        m.id = "new-id".into();
        // Seed HTML already carries an OLD island (e.g. from get_motif_source).
        let seed = r#"<head><script type="application/json" id="motif-manifest">{"id":"old-id","name":"Old","version":1,"size":[10,10],"default_duration_s":1.0,"props_schema":{}}</script></head><body><script>motif.define({setup(){}})</script></body>"#;
        let composed = compose_motif_html(&m, seed);
        let parsed = super::super::catalog::parse_manifest_island(&composed).expect("parses");
        assert_eq!(parsed.id, "new-id");
        // Exactly one island survives (no duplicate id marker).
        assert_eq!(composed.matches(r#"id="motif-manifest""#).count(), 1);
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring::tests::compose_injects_island_that_parses_back motifs::authoring::tests::compose_replaces_a_pre_existing_island`
Expected: FAIL — `compose_motif_html` not found.

- [ ] **Step 3: Implement `compose_motif_html`.**

```rust
/// Compose the canonical single-file Motif HTML: strip any existing
/// `<script type="application/json" id="motif-manifest">…</script>` island,
/// then inject a fresh one carrying `manifest` (pretty JSON) right after the
/// opening `<head>` (or at the very top if there is no head). The author's body
/// is otherwise preserved verbatim. The result round-trips through
/// `parse_manifest_island`.
pub fn compose_motif_html(manifest: &Manifest, html: &str) -> String {
    let stripped = strip_manifest_island(html);
    let json = serde_json::to_string_pretty(manifest)
        .unwrap_or_else(|_| "{}".to_string());
    let island = format!(
        "<script type=\"application/json\" id=\"motif-manifest\">\n{json}\n</script>\n"
    );
    // Insert after the first `<head>` if present (case-insensitive), else prepend.
    if let Some(pos) = find_ci(&stripped, "<head>") {
        let at = pos + "<head>".len();
        let mut out = String::with_capacity(stripped.len() + island.len());
        out.push_str(&stripped[..at]);
        out.push('\n');
        out.push_str(&island);
        out.push_str(&stripped[at..]);
        out
    } else {
        format!("{island}{stripped}")
    }
}

/// Remove the existing manifest island (open tag .. `</script>`) if present.
fn strip_manifest_island(html: &str) -> String {
    let Some(id_marker) = html.find(r#"id="motif-manifest""#) else {
        return html.to_string();
    };
    // Back up to the `<script` that owns this id attribute.
    let Some(open) = html[..id_marker].rfind("<script") else {
        return html.to_string();
    };
    let Some(rel_close) = html[id_marker..].find("</script>") else {
        return html.to_string();
    };
    let close = id_marker + rel_close + "</script>".len();
    let mut out = String::with_capacity(html.len());
    out.push_str(&html[..open]);
    out.push_str(&html[close..]);
    out
}

/// Case-insensitive substring search (ASCII needle), returns the byte offset.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.to_ascii_lowercase();
    h.find(&needle.to_ascii_lowercase())
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring::tests`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring.rs
git commit -m "feat(motifs): manifest-island writer (compose_motif_html, round-trips reader)"
```

---

### Task 4: Lenient prop canonicalization (migration)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/catalog.rs`.

On an in-place **update** that changes `props_schema`, an existing layer's saved props may carry keys the new schema dropped, or miss keys it added. The strict `canonicalize_props` (Stage 1) *rejects* unknown keys — which would hard-break placed layers. Add a lenient variant: **drop** unknown keys, **fill** missing keys from defaults, keep valid keys.

- [ ] **Step 1: Write failing tests** in `catalog.rs` `tests`:

```rust
    #[test]
    fn lenient_canonicalize_drops_unknown_and_fills_defaults() {
        let t = builtin_countdown();
        // `bogus` is not in the schema → dropped (strict would reject).
        // `seconds` valid → kept. Missing keys (accent, label) → defaults filled.
        let out = t
            .canonicalize_props_lenient(&json!({ "seconds": 7, "bogus": 1 }))
            .expect("lenient never rejects on unknown keys");
        assert!(out.contains("\"seconds\":7"));
        assert!(!out.contains("bogus"));
        assert!(out.contains("\"accent\""));
    }

    #[test]
    fn lenient_canonicalize_falls_back_on_invalid_value() {
        let t = builtin_countdown();
        // An out-of-range `seconds` falls back to the default rather than erroring.
        let out = t
            .canonicalize_props_lenient(&json!({ "seconds": 9999 }))
            .expect("lenient tolerates invalid values");
        // The default (5) is used, not 9999.
        assert!(out.contains("\"seconds\":5"));
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::catalog::tests::lenient_canonicalize_drops_unknown_and_fills_defaults motifs::catalog::tests::lenient_canonicalize_falls_back_on_invalid_value`
Expected: FAIL — `canonicalize_props_lenient` not found.

- [ ] **Step 3: Implement `canonicalize_props_lenient`** in `impl Motif` (next to `canonicalize_props`):

```rust
    /// Like `canonicalize_props`, but NEVER errors on bad input — for migrating
    /// a placed layer's props after a Motif's `props_schema` changed under it
    /// (in-place update). Unknown keys are dropped; missing keys are filled from
    /// defaults; a value that fails its spec falls back to the default. The
    /// result is canonical (BTreeMap-ordered) like the strict path.
    pub fn canonicalize_props_lenient(
        &self,
        provided: &serde_json::Value,
    ) -> Result<String, MotifError> {
        let provided_map = provided.as_object();
        let mut canonical: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        for (key, spec) in &self.manifest.props_schema {
            let candidate = provided_map.and_then(|m| m.get(key)).cloned();
            let value = match candidate {
                Some(v) if validate_prop(key, spec, &v).is_ok() => v,
                _ => spec_default_json(spec),
            };
            canonical.insert(key.clone(), value);
        }
        serde_json::to_string(&canonical).map_err(|e| MotifError::Serialize(e.to_string()))
    }
```

- [ ] **Step 4: Run to verify pass.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::catalog::tests`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/catalog.rs
git commit -m "feat(motifs): lenient prop canonicalize for post-update schema migration"
```

---

### Task 5: Store write / install / delete

**Files:** Modify `apps/desktop/src-tauri/src/motifs/store.rs`.

- [ ] **Step 1: Write failing tests** in `store.rs` `tests` (the `write_motif` helper + `UserMotifStore` already exist):

```rust
    use super::super::authoring::compose_motif_html;
    use super::super::catalog::{Manifest, parse_manifest_island};
    use std::collections::BTreeMap;

    fn manifest(id: &str, name: &str, version: u32) -> Manifest {
        Manifest {
            id: id.into(), name: name.into(), version,
            size: [100, 100], default_duration_s: 1.0,
            max_duration_s: None, max_duration_prop: None, content_duration_s: None,
            fonts: vec![], props_schema: BTreeMap::new(),
        }
    }

    #[test]
    fn write_draft_then_list_and_get() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let html = compose_motif_html(&manifest("d1", "Draft One", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        store.write_draft("d1", &html).unwrap();
        assert_eq!(store.list_draft_ids(), vec!["d1".to_string()]);
        // Drafts are NOT published (list_manifests ignores the drafts subtree).
        assert!(store.list_manifests().is_empty());
        // A draft is readable as a Motif.
        let got = store.get_draft("d1").expect("draft resolves");
        assert_eq!(got.id(), "d1");
    }

    #[test]
    fn install_new_publishes_and_removes_draft() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let html = compose_motif_html(&manifest("foo", "Foo", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        store.write_draft("foo", &html).unwrap();
        store.install_draft("foo", "foo").unwrap(); // draftId, finalId
        // Published now; draft gone.
        let ids: Vec<String> = store.list_manifests().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["foo".to_string()]);
        assert!(store.list_draft_ids().is_empty());
        // Served index.html's island id == dir name == finalId.
        let parsed = parse_manifest_island(&store.read_html("foo").unwrap()).unwrap();
        assert_eq!(parsed.id, "foo");
    }

    #[test]
    fn delete_user_motif_removes_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let html = compose_motif_html(&manifest("foo", "Foo", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>");
        store.write_draft("foo", &html).unwrap();
        store.install_draft("foo", "foo").unwrap();
        store.delete_user_motif("foo").unwrap();
        assert!(store.list_manifests().is_empty());
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::store`
Expected: FAIL — `write_draft` / `list_draft_ids` / `get_draft` / `install_draft` / `delete_user_motif` not found.

- [ ] **Step 3: Implement the store methods** in `impl UserMotifStore`:

```rust
    /// `<root>/drafts/`.
    fn drafts_root(&self) -> PathBuf {
        self.root.join(DRAFTS_DIR)
    }

    /// Write a draft's composed single-file HTML to `<root>/drafts/<draft_id>/index.html`.
    pub fn write_draft(&self, draft_id: &str, html: &str) -> std::io::Result<()> {
        let dir = self.drafts_root().join(safe_seg(draft_id)?);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("index.html"), html)
    }

    /// Ids of all drafts under `<root>/drafts/`.
    pub fn list_draft_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.drafts_root()) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    if let Some(name) = e.file_name().to_str() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Build a `Motif` from a draft's `index.html`.
    pub fn get_draft(&self, draft_id: &str) -> Option<Motif> {
        let html = std::fs::read_to_string(
            self.drafts_root().join(safe_seg(draft_id).ok()?).join("index.html"),
        )
        .ok()?;
        let manifest = parse_manifest_island(&html).ok()?;
        Some(Motif { manifest, html })
    }

    /// Publish a draft: move `<root>/drafts/<draft_id>/` to `<root>/<final_id>/`.
    /// The caller has already rewritten the draft's island so its `id == final_id`
    /// (the dir==id invariant). Overwrites any existing `<final_id>/` (update path).
    pub fn install_draft(&self, draft_id: &str, final_id: &str) -> std::io::Result<()> {
        let from = self.drafts_root().join(safe_seg(draft_id)?);
        let to = self.root.join(safe_seg(final_id)?);
        if to.exists() {
            std::fs::remove_dir_all(&to)?;
        }
        std::fs::create_dir_all(self.root.as_path())?;
        // `rename` across the same volume is atomic + cheap; fall back to copy
        // if it fails (e.g. cross-device — drafts live under the same root, so
        // rename normally succeeds).
        match std::fs::rename(&from, &to) {
            Ok(()) => Ok(()),
            Err(_) => {
                copy_dir_all(&from, &to)?;
                std::fs::remove_dir_all(&from)
            }
        }
    }

    /// Delete a published user Motif directory. The caller rejects built-in ids.
    pub fn delete_user_motif(&self, id: &str) -> std::io::Result<()> {
        let dir = self.root.join(safe_seg(id)?);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Ids of all PUBLISHED user Motifs (for uniqueness checks at install).
    pub fn published_ids(&self) -> Vec<String> {
        self.list_manifests().into_iter().map(|m| m.id).collect()
    }
```

Add the supporting helpers at module scope in `store.rs`:

```rust
/// A single safe path segment (no traversal, no separators). Errors as an
/// io::Error so it composes with the `io::Result` store methods.
fn safe_seg(seg: &str) -> std::io::Result<PathBuf> {
    if seg.is_empty()
        || seg == "."
        || seg == ".."
        || seg.contains('/')
        || seg.contains('\\')
        || seg.contains(':')
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("unsafe path segment: {seg:?}"),
        ));
    }
    Ok(PathBuf::from(seg))
}

/// Recursively copy a directory tree (rename fallback).
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dst)?;
        } else {
            std::fs::copy(entry.path(), dst)?;
        }
    }
    Ok(())
}
```

Add the import at the top of `store.rs` if missing: `use super::catalog::{parse_manifest_island, Manifest, Motif};` (Stage 1 added `Motif` for `get_motif`; confirm `parse_manifest_island` is imported — it is, from Stage 1).

- [ ] **Step 4: Run to verify pass.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::store`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/store.rs
git commit -m "feat(motifs): UserMotifStore draft write + install + delete"
```

---

### Task 6: Lifecycle Tauri commands

**Files:** Create `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`; modify `apps/desktop/src-tauri/src/motifs/mod.rs` + `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 1: Declare the module** in `mod.rs` (under `pub mod authoring;`):

```rust
pub mod authoring_commands;
```

- [ ] **Step 2: Write the commands + a pure-helper test.**

Create `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`:

```rust
//! Tauri commands for the user-Motif authoring lifecycle: read a Motif's
//! source, write a draft, install (publish-new / update-in-place), delete.
//! UI-agnostic; the Stage-3 UI and the Stage-4 MCP tools both call these.

use serde::Deserialize;
use tauri::State;

use super::authoring::{assign_unique_id, compose_motif_html, validate_manifest};
use super::catalog::{builtins, Manifest, BUILTIN_IDS};
use super::store::UserMotifStore;

/// `{ manifest, html }` of a Motif's source. Returned by `get_motif_source`;
/// `manifest` is the parsed island, `html` the raw served document.
#[derive(serde::Serialize)]
pub struct MotifSource {
    pub manifest: Manifest,
    pub html: String,
}

/// Read any built-in or user Motif's source (for the "edit" seed).
#[tauri::command]
pub async fn get_motif_source(
    store: State<'_, UserMotifStore>,
    id: String,
) -> Result<MotifSource, String> {
    if let Some(m) = builtins().into_iter().find(|m| m.id() == id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    if let Some(m) = store.get_motif(&id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    Err(format!("unknown motif id '{id}'"))
}

#[derive(Deserialize)]
pub struct WriteDraftArgs {
    pub manifest: Manifest,
    pub html: String,
}

/// Validate + compose + write a draft. Returns the assigned draft id.
#[tauri::command]
pub async fn write_motif_draft(
    store: State<'_, UserMotifStore>,
    args: WriteDraftArgs,
) -> Result<String, String> {
    validate_manifest(&args.manifest).map_err(|e| e.to_string())?;
    // Draft id is a slug of the name, unique within the existing drafts.
    let draft_id = assign_unique_id(&args.manifest.name, &store.list_draft_ids());
    // The draft's island carries the draft id (dir == id) so it serves + previews.
    let mut manifest = args.manifest;
    manifest.id = draft_id.clone();
    let html = compose_motif_html(&manifest, &args.html);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    Ok(draft_id)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallMode {
    New,
    Update { target_id: String },
}

#[derive(Deserialize)]
pub struct InstallArgs {
    pub draft_id: String,
    pub mode: InstallMode,
}

/// Promote a draft to a published user Motif. Returns the published id.
#[tauri::command]
pub async fn install_motif(
    store: State<'_, UserMotifStore>,
    args: InstallArgs,
) -> Result<String, String> {
    let draft = store
        .get_draft(&args.draft_id)
        .ok_or_else(|| format!("unknown draft '{}'", args.draft_id))?;
    // Re-validate at the install gate (defense in depth — the draft on disk
    // could have been hand-edited since write).
    validate_manifest(&draft.manifest).map_err(|e| e.to_string())?;

    let (final_id, version) = match args.mode {
        InstallMode::New => {
            let id = assign_unique_id(&draft.manifest.name, &store.published_ids());
            (id, 1)
        }
        InstallMode::Update { target_id } => {
            if BUILTIN_IDS.contains(&target_id.as_str()) {
                return Err(format!("cannot overwrite the built-in Motif '{target_id}'"));
            }
            let prev = store
                .get_motif(&target_id)
                .ok_or_else(|| format!("update target '{target_id}' is not an installed Motif"))?;
            // Bump version so the (version-keyed) frame cache invalidates → all
            // placed layers re-render with the new look (live/mutable).
            (target_id, prev.manifest.version.saturating_add(1))
        }
    };

    // Rewrite the island so id == dir == final_id and version is set, then
    // re-write the draft file before promoting it (keeps the invariant).
    let mut manifest = draft.manifest;
    manifest.id = final_id.clone();
    manifest.version = version;
    let html = compose_motif_html(&manifest, &draft.html);
    store.write_draft(&args.draft_id, &html).map_err(|e| e.to_string())?;
    store
        .install_draft(&args.draft_id, &final_id)
        .map_err(|e| e.to_string())?;
    Ok(final_id)
}

/// Delete a published user Motif. Built-ins are rejected.
#[tauri::command]
pub async fn delete_motif(
    store: State<'_, UserMotifStore>,
    id: String,
) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id.as_str()) {
        return Err(format!("cannot delete the built-in Motif '{id}'"));
    }
    store.delete_user_motif(&id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The InstallMode tag grammar the frontend will send must deserialize.
    #[test]
    fn install_mode_deserializes() {
        let new: InstallMode = serde_json::from_str(r#"{"kind":"new"}"#).unwrap();
        assert!(matches!(new, InstallMode::New));
        let upd: InstallMode =
            serde_json::from_str(r#"{"kind":"update","target_id":"foo"}"#).unwrap();
        assert!(matches!(upd, InstallMode::Update { target_id } if target_id == "foo"));
    }
}
```

- [ ] **Step 3: Register the commands** in `lib.rs` `generate_handler!` (next to `commands::add_motif`):

```rust
            motifs::authoring_commands::get_motif_source,
            motifs::authoring_commands::write_motif_draft,
            motifs::authoring_commands::install_motif,
            motifs::authoring_commands::delete_motif,
```

- [ ] **Step 4: Run to verify pass + build.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring_commands` then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: test PASS; build clean (the four commands compile + register).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs apps/desktop/src-tauri/src/motifs/mod.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): lifecycle commands (get_source/write_draft/install/delete)"
```

---

### Task 7: Recover the host after a capture timeout

**Files:** Modify `apps/desktop/src-tauri/src/motifs/commands.rs` + `apps/desktop/src-tauri/src/motifs/host.rs`.

The 5 s `CAPTURE_TIMEOUT` already fails a runaway frame for the *caller* (`cdp.rs`), but the hidden host's JS thread stays wedged — every subsequent capture on that host then also times out. Recover by **closing the host window on a capture/eval timeout**, so the next capture's `ensure_host` rebuilds a fresh one.

- [ ] **Step 1: Add a host teardown helper** in `host.rs`:

```rust
/// Close + drop the hidden host window if it exists. The next `ensure_host`
/// rebuilds a fresh one. Used to recover from a wedged host (a Motif whose JS
/// hangs past the capture timeout leaves the WebView2 UI thread stuck; the
/// window must be torn down, not reused).
pub fn teardown_host(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        let _ = win.close();
    }
}
```

- [ ] **Step 2: Write a failing test** for the timeout-classification helper in `commands.rs`. (The capture itself needs a live WebView2, so test the *decision* purely.) Add to a `#[cfg(test)] mod tests` in `commands.rs`:

```rust
    #[test]
    fn timeout_errors_are_classified_as_host_wedged() {
        assert!(is_timeout_error("CDP capture timed out after 5s (…)"));
        assert!(is_timeout_error("CDP Runtime.evaluate timed out after 5s (…)"));
        assert!(!is_timeout_error("CDP capture failed: some other error"));
    }
```

- [ ] **Step 3: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::commands::tests::timeout_errors_are_classified_as_host_wedged`
Expected: FAIL — `is_timeout_error` not found.

- [ ] **Step 4: Implement classification + recovery** in `commands.rs`.

Add the helper:

```rust
/// A capture/eval error string indicates the host's WebView2 thread is wedged
/// (a Motif whose JS hung past the timeout) — distinct from a normal CDP
/// failure. Such a host must be torn down + rebuilt, not reused.
fn is_timeout_error(msg: &str) -> bool {
    msg.contains("timed out after")
}
```

Then, in `motif_capture_frame`, wrap the two `eval_await`/`capture_png_base64` call sites so a timeout tears down the host before returning the error. Replace the render eval:

```rust
    if let Err(e) = cdp::eval_await(&win, &render_expr).await {
        let msg = e.to_string();
        if is_timeout_error(&msg) {
            host::teardown_host(&app);
            cap.reset();
        }
        return Err(format!("__motifRender failed: {msg}"));
    }
```

And the capture:

```rust
    let set_metrics = super::should_set_metrics(cap.last_size, width, height);
    let b64 = match cdp::capture_png_base64(&win, width, height, set_metrics).await {
        Ok(b64) => b64,
        Err(e) => {
            let msg = e.to_string();
            if is_timeout_error(&msg) {
                host::teardown_host(&app);
                cap.reset();
            }
            return Err(format!("capture failed: {msg}"));
        }
    };
```

(The ready-probe loop already retries; leave it. `cap.reset()` clears `ready_for`/`last_size` so the rebuilt host re-probes + re-applies metrics.)

- [ ] **Step 5: Run to verify pass + build.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::commands` then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: PASS; build clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/commands.rs apps/desktop/src-tauri/src/motifs/host.rs
git commit -m "feat(motifs): tear down + rebuild the hidden host after a capture timeout"
```

---

### Task 8: Gates + verification

- [ ] **Step 1: Full gates.**

Run from repo root: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → all pass.
Run from `apps/desktop`: `npx tsc -b` → clean (no TS changed this stage, but confirm). `npx vitest run` → unchanged green.

- [ ] **Step 2: End-to-end lifecycle via the running app (real WebView2).**

Drive the running `tauri dev` via the Tauri MCP bridge (`webview_execute_js` → `window.__TAURI__.core.invoke`), with no UI yet:
- `invoke('write_motif_draft', { args: { manifest: {...}, html: '<head></head><body><script>motif.define({setup(){}})</script></body>' } })` → returns a draft id.
- `invoke('install_motif', { args: { draftId, mode: { kind: 'new' } } })` → returns a published id (note: Tauri camelCases `draft_id`→`draftId`; confirm the arg casing against the others or use the `#[tauri::command]` rename behavior).
- `invoke('list_motifs')` → the published id now appears.
- `invoke('get_motif_source', { id })` → returns `{ manifest, html }`.
- `invoke('delete_motif', { id })` → gone from `list_motifs`.
- `invoke('delete_motif', { id: 'countdown' })` → errors (built-in rejected).

- [ ] **Step 3: Record the result** (ids written/installed/deleted; the built-in-reject error) to close Stage 2.

---

## Self-Review

**Spec coverage (Stage 2 = §3 lifecycle, §4 identity/install/migration, §10 import validation + timeout):**
- §4 write/install(new|update)/delete → Tasks 5 (store) + 6 (commands).
- §4 id assignment, reserve built-ins, dir==id invariant → Tasks 2 + 6 (install rewrites island id).
- §4 update bumps version → cache busts → Task 6 (`prev.version + 1`; cache is version-keyed per `motifFrameDescriptor.ts`).
- §4 props lenient migration → Task 4 (`canonicalize_props_lenient`) — Rust side; TS render-side lenient is Stage 3 (noted out-of-scope).
- §10 import validation → Task 1 (`validate_manifest`).
- §10 per-frame wall-clock limit → already present (5 s `CAPTURE_TIMEOUT`); Task 7 adds host *recovery* so a wedged host doesn't poison later captures.
- Manifest-island writer (the format's write side) → Task 3.
- `get_motif_source` (the edit seed) → Task 6.

**Placeholder scan:** Task 1 Steps 2/5 intentionally flag-and-remove dead scaffolding (the `one` BTreeMap) — that's an explicit instruction, not a placeholder. No TBD/TODO elsewhere; every code step is complete.

**Type/name consistency:** `validate_manifest`/`sanitize_id`/`assign_unique_id`/`compose_motif_html` (authoring.rs, Tasks 1-3) are consumed by `authoring_commands.rs` (Task 6). `write_draft`/`get_draft`/`list_draft_ids`/`install_draft`/`delete_user_motif`/`published_ids` (store.rs, Task 5) match their command call sites (Task 6). `canonicalize_props_lenient` (Task 4) is defined but its render-path *consumer* is Stage 3 (this stage only unit-tests it — flagged). `BUILTIN_IDS`/`validate_default_for`/`InvalidManifest` (catalog.rs, Tasks 1-2) match their uses. `MotifError::Serialize` (used in Task 4) already exists from Stage 1.

**Deferred-to-Stage-3 (explicit):** the TS render-side lenient canonicalize (so a migrated layer renders rather than nulling), and the UI that calls these commands. `canonicalize_props_lenient` lands here so Stage 3 can wire it; it is not yet on any hot path.
