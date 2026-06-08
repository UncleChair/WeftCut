# Motif Upload — Stage 3a: Draft renderability backbone (Model B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a *draft* Motif render in the real project canvas exactly like an installed one — served by the `motif:` scheme, known to the catalog, placeable, and captured — with stable identity across draft→install so no layer ever needs rebinding (Model B).

**Architecture:** Model B: a draft is assigned its **final-ready id at creation** (unique vs. published *and* drafts), so its `motif_id` is stable through install. The store's `read_file`/`get_motif` resolve **published first, then the draft of the same id**, so one id serves a draft until it's installed and the published copy thereafter. `list_motifs` gains a `status` (`builtin`/`installed`/`draft`) and includes drafts; the TS catalog registers drafts so `getMotif` resolves them; the render path canonicalizes props **leniently** so a post-update schema change degrades gracefully instead of blanking.

**Tech Stack:** Rust (Tauri 2.11, serde), TypeScript (Vitest). No new UI in this stage — exercised via IPC (the picker drafts section, New/Import, property-panel lifecycle buttons, and live-edit surfaces are **Stage 3b**).

---

## Stage roadmap (this plan = Stage 3a of 5)

Spec: `docs/superpowers/specs/2026-06-08-motif-upload-authoring-design.md` (§5 preview, §6 edit, §8.1/§8.2). Stages 1 (foundation) + 2 (lifecycle backend) are **merged to `main`**.

| Stage | Scope | Status |
|---|---|---|
| 1 | On-disk user Motifs: store + serving + runtime catalogs | done, merged |
| 2 | Draft store + lifecycle commands + validation + timeout recovery | done, merged |
| **3a (this plan)** | Model-B draft renderability: final-ready ids, serve-published-then-draft, `list_motifs` status+drafts, capture resolves drafts, TS catalog draft registration + render-side lenient canonicalize | this plan |
| 3b | Authoring UI: picker drafts section + New/Import + property-panel Edit/Install/Delete + live-edit (in-app panel + external-editor file-watch + hot reload) + catalog-changed resync event | next |
| 4 | MCP surface (mirror Stage-2 commands) | — |
| 5 | Cross-project usage signal (A + B) | — |

**Design decision (Model B, approved 2026-06-08):** final-ready draft id at creation + serve-published-then-draft fallback ⇒ stable `motif_id` ⇒ **no rebind on install**. "Edit installed `X`" (a distinct working draft + preview pane) and the install-update rebind question are a 3b concern; 3a only needs the new-motif path to be renderable + installable.

---

## File Structure (Stage 3a)

- **Modify** `apps/desktop/src-tauri/src/motifs/store.rs` — `read_file`/`get_motif` resolve published-then-draft; add `list_drafts()`.
- **Modify** `apps/desktop/src-tauri/src/motifs/authoring_commands.rs` — `write_motif_draft` dedups vs published+drafts; `install_motif` New keeps the draft's (final-ready) id with a published-collision guard.
- **Modify** `apps/desktop/src-tauri/src/commands.rs` — `list_motifs` includes drafts + a `status` field.
- **Modify** `apps/desktop/src-tauri/src/motifs/commands.rs` — capture `ctx.duration` resolves a draft via `get_motif`.
- **Modify** `apps/desktop/src/render/motifs/catalog.ts` — `MotifManifest`/`Motif` carry an optional `status`; add `canonicalizePropsLenient`.
- **Modify** `apps/desktop/src/render/motifs/motifFrameDescriptor.ts` — use `canonicalizePropsLenient` (render path is resilient).
- **Modify** `apps/desktop/src/ipc/index.ts` — `MotifSummary` gains optional `status`.
- **Tests:** inline Rust; `catalog.test.ts` + `motifFrameDescriptor.test.ts` (TS).

**Commands:** Rust `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`; TS from `apps/desktop` `npx vitest run <path>` / `npx tsc -b`.

---

### Task 1: Store serves published-then-draft; `list_drafts`

**Files:** Modify `apps/desktop/src-tauri/src/motifs/store.rs`.

- [ ] **Step 1: Write failing tests** in `store.rs` `mod tests` (helpers `manifest()` + `compose_motif_html` + `write_draft`/`install_draft` exist from Stage 2):

```rust
    #[test]
    fn read_file_falls_back_to_draft_then_prefers_published() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let draft_html = compose_motif_html(&manifest("foo", "Draft Foo", 1),
            "<head></head><body>draft<script>motif.define({setup(){}})</script></body>");
        store.write_draft("foo", &draft_html).unwrap();
        // Not published yet → read_file("foo", ...) resolves the DRAFT.
        let got = String::from_utf8(store.read_file("foo", "index.html").unwrap()).unwrap();
        assert!(got.contains("draft"));
        assert!(store.get_motif("foo").is_some()); // get_motif falls back too
        // Install it → published copy now wins over any same-id draft.
        store.install_draft("foo", "foo").unwrap();
        let pub_html = String::from_utf8(store.read_file("foo", "index.html").unwrap()).unwrap();
        assert!(pub_html.contains("draft")); // same bytes, now from <root>/foo/
        assert!(store.list_manifests().iter().any(|m| m.id == "foo"));
    }

    #[test]
    fn list_drafts_returns_draft_motifs() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        store.write_draft("d1", &compose_motif_html(&manifest("d1", "D1", 1),
            "<head></head><body><script>motif.define({setup(){}})</script></body>")).unwrap();
        let drafts = store.list_drafts();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].id(), "d1");
    }

    #[test]
    fn read_file_still_blocks_the_drafts_literal_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        store.write_draft("x", "hi").unwrap();
        // `motif://drafts/...` must not enumerate the drafts root as an id.
        assert!(store.read_file("drafts", "x/index.html").is_none());
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::store::tests::read_file_falls_back_to_draft_then_prefers_published motifs::store::tests::list_drafts_returns_draft_motifs`
Expected: FAIL (draft fallback absent / `list_drafts` not found).

- [ ] **Step 3: Rewrite `read_file` with the published-then-draft fallback.**

Replace the body of `read_file`:

```rust
    /// Read a file for Motif `id`, path-safely. Resolves the PUBLISHED copy
    /// (`<root>/<id>/<rel>`) first, then falls back to the DRAFT of the same id
    /// (`<root>/drafts/<id>/<rel>`) — so a final-ready draft id serves its draft
    /// until it's installed, after which the published copy takes over (Model B).
    /// The reserved `drafts` literal id is never served (it would expose the
    /// drafts root itself, not a Motif).
    pub fn read_file(&self, id: &str, rel: &str) -> Option<Vec<u8>> {
        if id == DRAFTS_DIR {
            return None;
        }
        let safe_id = safe_rel(id)?;
        let safe = safe_rel(rel)?;
        let published = self.root.join(&safe_id).join(&safe);
        if let Ok(bytes) = std::fs::read(&published) {
            return Some(bytes);
        }
        let draft = self.root.join(DRAFTS_DIR).join(&safe_id).join(&safe);
        std::fs::read(draft).ok()
    }
```

`get_motif` needs no change — it calls `read_html` → `read_file`, so it now resolves a draft by id automatically. Update its doc comment to drop "installed" wording:

```rust
    /// Build a full `Motif` (manifest + html) for Motif `id`, resolving the
    /// published copy then falling back to its draft (Model B). `None` if
    /// absent / unreadable / not a valid island, or for the reserved `drafts` id.
    pub fn get_motif(&self, id: &str) -> Option<Motif> {
        if id == DRAFTS_DIR {
            return None;
        }
        let html = self.read_html(id)?;
        let manifest = parse_manifest_island(&html).ok()?;
        Some(Motif { manifest, html })
    }
```

- [ ] **Step 4: Add `list_drafts`** to `impl UserMotifStore` (next to `list_draft_ids`):

```rust
    /// Every draft as a full `Motif` (manifest + html), id-sorted. Skips any
    /// draft dir whose `index.html` is missing or whose island fails to parse.
    pub fn list_drafts(&self) -> Vec<Motif> {
        let mut out: Vec<Motif> = self
            .list_draft_ids()
            .into_iter()
            .filter_map(|id| self.get_draft(&id))
            .collect();
        out.sort_by(|a, b| a.id().cmp(b.id()));
        out
    }
```

- [ ] **Step 5: Run to verify pass.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::store`
Expected: PASS (all store tests incl. the 3 new).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/store.rs
git commit -m "feat(motifs): store serves published-then-draft; list_drafts (Model B)"
```

---

### Task 2: Final-ready draft ids (no rename on install-new)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`.

- [ ] **Step 1: Write a failing test** in `authoring_commands.rs` `mod tests`:

```rust
    use super::super::store::UserMotifStore;
    use super::super::catalog::Manifest;
    use std::collections::BTreeMap;

    fn m(name: &str) -> Manifest {
        Manifest { id: "ignored".into(), name: name.into(), version: 1, size: [100, 100],
            default_duration_s: 1.0, max_duration_s: None, max_duration_prop: None,
            content_duration_s: None, fonts: vec![], props_schema: BTreeMap::new() }
    }

    #[test]
    fn draft_id_is_final_ready_unique_vs_published_and_drafts() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        // Publish "foo" first.
        store.write_draft("foo", &super::super::authoring::compose_motif_html(&{ let mut x = m("Foo"); x.id = "foo".into(); x }, "<head></head><body><script>motif.define({setup(){}})</script></body>")).unwrap();
        store.install_draft("foo", "foo").unwrap();
        // A new draft also named "Foo" must NOT collide with the published id.
        let taken: Vec<String> = store.published_ids().into_iter().chain(store.list_draft_ids()).collect();
        let id = super::super::authoring::assign_unique_id("Foo", &taken);
        assert_ne!(id, "foo");
        assert_eq!(id, "foo-2");
    }
```

(This unit-tests the dedup helper composition; the command wiring is covered by the IPC e2e in Task 6.)

- [ ] **Step 2: Run to verify it compiles + the assertion holds (or fails if dedup set is wrong).**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring_commands::tests::draft_id_is_final_ready_unique_vs_published_and_drafts`
Expected: this test PASSES already if `assign_unique_id` is given the combined set — it's asserting the helper behavior to lock in the call-site change below. (If it fails, `assign_unique_id` isn't reserving correctly — fix there.)

- [ ] **Step 3: Change `write_motif_draft` to dedup vs published + drafts.**

In `write_motif_draft`, replace the draft-id line:

```rust
    // Final-ready id: unique vs BOTH published and existing drafts, so the id
    // never changes on install (Model B → no layer rebind). The draft is served
    // at this id (store published-then-draft fallback) and install just moves it.
    let taken: Vec<String> = store
        .published_ids()
        .into_iter()
        .chain(store.list_draft_ids())
        .collect();
    let draft_id = assign_unique_id(&args.manifest.name, &taken);
```

- [ ] **Step 4: Change `install_motif` New to keep the draft id (with a collision guard).**

Replace the `InstallMode::New` arm:

```rust
        InstallMode::New => {
            // The draft id was made final-ready at write time; keep it so placed
            // layers (which reference this id) need no rebind. Guard the rare
            // race where a published Motif took the id since the draft was written.
            let id = draft.manifest.id.clone();
            if store.published_ids().iter().any(|p| p == &id) {
                return Err(format!(
                    "a Motif '{id}' is already installed; rename the draft before installing"
                ));
            }
            (id, 1)
        }
```

(`draft.manifest.id` equals the draft's dir name, set at write time. `install_draft(args.draft_id, final_id)` then moves `drafts/<id>` → `<id>` with `args.draft_id == final_id`.)

- [ ] **Step 5: Run to verify pass + build.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring_commands` then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: PASS; clean build.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs
git commit -m "feat(motifs): final-ready draft ids — no rename/rebind on install-new (Model B)"
```

---

### Task 3: `list_motifs` includes drafts + a `status` field

**Files:** Modify `apps/desktop/src-tauri/src/commands.rs`.

- [ ] **Step 1: Write a failing test.** In `commands.rs` `mod tests`, extend `motif_to_payload` coverage:

```rust
    #[test]
    fn motif_payload_carries_status() {
        let m = crate::motifs::catalog::builtin_countdown();
        let v = motif_to_payload(&m.manifest, m.html.clone(), "builtin").unwrap();
        assert_eq!(v.as_object().unwrap().get("status").unwrap(), "builtin");
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::tests::motif_payload_carries_status`
Expected: FAIL — `motif_to_payload` takes 2 args, not 3.

- [ ] **Step 3: Add a `status` param to `motif_to_payload` and include drafts in `list_motifs`.**

Change `motif_to_payload`:

```rust
fn motif_to_payload(
    manifest: &crate::motifs::catalog::Manifest,
    html: String,
    status: &str,
) -> Result<serde_json::Value, String> {
    let mut v = serde_json::to_value(manifest).map_err(|e| format!("manifest serialize: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "manifest is not a JSON object".to_string())?;
    obj.insert("html".to_string(), serde_json::Value::String(html));
    obj.insert("status".to_string(), serde_json::Value::String(status.to_string()));
    Ok(v)
}
```

Rewrite `list_motifs` to emit built-ins, installed, then drafts — each tagged:

```rust
#[tauri::command]
pub async fn list_motifs(
    store: tauri::State<'_, crate::motifs::store::UserMotifStore>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for t in catalog::builtins() {
        out.push(motif_to_payload(&t.manifest, t.html, "builtin")?);
    }
    for manifest in store.list_manifests() {
        let html = store.read_html(&manifest.id).unwrap_or_default();
        out.push(motif_to_payload(&manifest, html, "installed")?);
    }
    for draft in store.list_drafts() {
        out.push(motif_to_payload(&draft.manifest, draft.html, "draft")?);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run to verify pass + build.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::tests::motif_payload_carries_status` then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: PASS; clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(motifs): list_motifs includes drafts + a status field (builtin|installed|draft)"
```

---

### Task 4: Capture `ctx.duration` resolves a draft

**Files:** Modify `apps/desktop/src-tauri/src/motifs/commands.rs`.

The duration resolver currently looks up user manifests via `store.list_manifests()` (installed only). A placed draft needs its own manifest. Resolve via `get_motif` (published-then-draft), lazily (built-ins still short-circuit, no disk touch).

- [ ] **Step 1: Locate the call site** in `motif_capture_frame` — currently:

```rust
    let duration = resolve_capture_duration(
        &motif_id,
        &super::catalog::builtins(),
        || store.list_manifests(),
        &props,
    );
```

- [ ] **Step 2: Change the lazy provider to resolve the single motif via `get_motif`** (published-then-draft), returning at most its manifest:

```rust
    let duration = resolve_capture_duration(
        &motif_id,
        &super::catalog::builtins(),
        || store.get_motif(&motif_id).into_iter().map(|m| m.manifest).collect(),
        &props,
    );
```

`resolve_capture_duration` is unchanged (it takes `impl FnOnce() -> Vec<Manifest>`). For a built-in id the closure is never called; for a user/draft id it returns `[manifest]` (or `[]` if unknown → 5.0 fallback).

- [ ] **Step 3: Verify the existing `resolve_capture_duration` unit test still passes + build.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::commands` then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: PASS; clean (the unit test passes a closure directly, unaffected; this is a call-site change).

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/commands.rs
git commit -m "feat(motifs): capture ctx.duration resolves a draft via get_motif"
```

---

### Task 5: TS catalog `status` + render-side lenient canonicalize

**Files:** Modify `apps/desktop/src/render/motifs/catalog.ts`, `apps/desktop/src/render/motifs/motifFrameDescriptor.ts`, `apps/desktop/src/ipc/index.ts`. Tests: `catalog.test.ts`, `motifFrameDescriptor.test.ts`.

- [ ] **Step 1: Write failing tests** in `catalog.test.ts`:

```ts
import { canonicalizePropsLenient } from "./catalog";

it("canonicalizePropsLenient drops unknown, fills defaults, falls back on invalid", () => {
  const manifest = {
    id: "u", name: "U", version: 1, size: [10, 10] as [number, number], default_duration_s: 1,
    props_schema: {
      title: { type: "string", default: "Hi" },
      n: { type: "number", default: 5, min: 1, max: 10 },
    },
  };
  const out = canonicalizePropsLenient({ title: "Yo", n: 999, bogus: 1 }, manifest as never);
  expect(out.title).toBe("Yo");      // valid kept
  expect(out.n).toBe(5);             // out-of-range → default
  expect("bogus" in out).toBe(false); // unknown dropped
  // missing key filled from default
  const out2 = canonicalizePropsLenient({}, manifest as never);
  expect(out2.title).toBe("Hi");
  expect(out2.n).toBe(5);
});
```

- [ ] **Step 2: Run to verify failure.**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/catalog.test.ts`
Expected: FAIL — `canonicalizePropsLenient` not exported.

- [ ] **Step 3: Add `status` to the types + implement `canonicalizePropsLenient` in `catalog.ts`.**

In `catalog.ts`, add to `MotifManifest` (optional, so existing built-in manifests still parse):

```ts
  /// "builtin" | "installed" | "draft" — set by the backend `list_motifs`
  /// payload; absent for the statically-globbed built-ins (treated as builtin).
  status?: "builtin" | "installed" | "draft";
```

Add the lenient canonicalizer (mirrors the Rust `canonicalize_props_lenient`: drop unknown, fill defaults, fall back to default on an invalid value — never throws):

```ts
/// Render-path prop canonicalizer that NEVER throws — drops unknown keys, fills
/// missing keys from defaults, and falls back to the default when a value fails
/// its spec. Mirrors Rust `Motif::canonicalize_props_lenient`. The strict
/// `canonicalizeProps` stays on the ADD/validation path; the render path uses
/// this so a layer whose Motif's `props_schema` changed under it (an in-place
/// update) degrades gracefully instead of rendering blank.
export function canonicalizePropsLenient(
  props: Record<string, unknown>,
  manifest: MotifManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    const v = props[key];
    out[key] = propValueValid(v, spec) ? v : spec.default;
  }
  return out;
}

function propValueValid(v: unknown, spec: PropSpec): boolean {
  switch (spec.type) {
    case "string":
      return typeof v === "string" && (spec.max_length == null || v.length <= spec.max_length);
    case "color":
      return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v)
        && (spec.min == null || v >= spec.min) && (spec.max == null || v <= spec.max);
  }
}
```

- [ ] **Step 4: Use lenient canonicalize on the render path.**

In `motifFrameDescriptor.ts`, replace the strict call. The import currently is `import { canonicalizeProps } from "./Rasterizer";` and the body does:

```ts
  let canonicalProps: Record<string, unknown>;
  try {
    canonicalProps = canonicalizeProps(view.props, motif.manifest);
  } catch {
    return null;
  }
```

Change to use the lenient canonicalizer (never throws → no null-on-bad-props):

```ts
  // Render path is resilient: lenient canonicalize (drop unknown / fill defaults
  // / fall back on invalid) so a layer whose Motif schema changed under it (an
  // in-place update) still renders rather than blanking.
  const canonicalProps = canonicalizePropsLenient(view.props, motif.manifest);
```

Update the import: add `canonicalizePropsLenient` from `./catalog` (it already imports `resolveMotifContentDurationUs, type Motif` from `./catalog`), and drop the now-unused `canonicalizeProps` import from `./Rasterizer` if nothing else in the file uses it (check — if unused, remove that import line).

- [ ] **Step 5: Add `status` to `MotifSummary`** in `ipc/index.ts` (so the picker can read it in 3b; harmless now):

```ts
  status?: "builtin" | "installed" | "draft";
```

(Place it near the other optional fields added in Stage 1, e.g. after `settle_rafs`.)

- [ ] **Step 6: Add a descriptor test** in `motifFrameDescriptor.test.ts` proving a layer with an extra/unknown prop still yields a descriptor (no null):

```ts
it("yields a descriptor even when a layer carries an unknown prop (lenient render)", () => {
  const motif = { manifest: { id: "u", name: "U", version: 1, size: [100, 100] as [number, number],
    default_duration_s: 5, props_schema: { title: { type: "string", default: "Hi" } } } };
  const view = { kind: "Motif", motif_id: "u", props: { title: "Yo", stale: 1 }, x: 0, y: 0,
    scale_x: 1, scale_y: 1, opacity: 1, src_in_us: 0 } as never;
  const desc = motifFrameDescriptor(view, 0, 5_000_000, 30, 1, motif as never);
  expect(desc).not.toBeNull();
  expect(desc!.canonicalProps.title).toBe("Yo");
  expect("stale" in desc!.canonicalProps).toBe(false);
});
```

- [ ] **Step 7: Run to verify pass + typecheck.**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/catalog.test.ts src/render/motifs/motifFrameDescriptor.test.ts` then `npx tsc -b`
Expected: PASS; tsc clean.

- [ ] **Step 8: Commit.**

```bash
git add apps/desktop/src/render/motifs/catalog.ts apps/desktop/src/render/motifs/motifFrameDescriptor.ts apps/desktop/src/ipc/index.ts apps/desktop/src/render/motifs/catalog.test.ts apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts
git commit -m "feat(motifs): catalog status field + render-side lenient canonicalize (resilient render)"
```

---

### Task 6: Gates + IPC e2e (draft renders in the canvas)

- [ ] **Step 1: Full gates.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → all pass. From `apps/desktop`: `npx tsc -b` (clean) + `npx vitest run` (all pass).

- [ ] **Step 2: IPC e2e via a rebuilt `tauri dev`** (drive the running app's webview with the tauri-mcp bridge; backend changed → the app must be rebuilt/restarted first). Run this in the webview (`window.__TAURI__.core.invoke`):

```js
(async () => {
  const inv = window.__TAURI__.core.invoke;
  const out = {};
  const manifest = { id:"x", name:"Draft Render Test", version:1, size:[600,200], default_duration_s:5, content_duration_s:0.6, props_schema:{} };
  const html = "<head><style>.b{position:absolute;left:20px;bottom:20px;width:400px;height:120px;background:#1aa direct;color:#fff}</style></head><body><div class='b'>DRAFT RENDER</div><script>motif.define({setup(){document.querySelector('.b').animate([{opacity:0},{opacity:1}],{duration:600,fill:'both'})}})<\/script></body>";
  out.draftId = await inv('write_motif_draft', { args:{ manifest, html } });
  // list shows it as a draft
  const list = await inv('list_motifs');
  out.draftEntry = list.find(m => m.id === out.draftId);
  out.draftStatus = out.draftEntry && out.draftEntry.status;        // expect "draft"
  // re-sync the runtime catalog so getMotif resolves the draft, then place it
  out.captured = await inv('motif_capture_frame', { motifId: out.draftId, tSec: 0.6, propsJson: "{}", width: 600, height: 200, settleRafs: 1 }).then(b64 => typeof b64 === 'string' && b64.length > 100).catch(e => String(e));
  // install (new) keeps the same id (Model B)
  out.finalId = await inv('install_motif', { args:{ draft_id: out.draftId, mode:{ kind:"new" } } });
  out.sameId = (out.finalId === out.draftId);
  // capture still works at the same id (now published)
  out.capturedAfterInstall = await inv('motif_capture_frame', { motifId: out.finalId, tSec: 0.6, propsJson: "{}", width: 600, height: 200, settleRafs: 1 }).then(b64 => typeof b64 === 'string' && b64.length > 100).catch(e => String(e));
  await inv('delete_motif', { id: out.finalId });
  return out;
})()
```

Expected: `draftStatus === "draft"`, `captured === true` (the draft is served+captured at its id BEFORE install — Model B fallback), `sameId === true`, `capturedAfterInstall === true`. (Note: fix the `background` CSS in the test HTML to a real color, e.g. `#11aa99`, before running — the snippet above has a typo placeholder.)

- [ ] **Step 3: Record the result** (draft status, capture-before-install, same-id install, capture-after-install) to close Stage 3a.

---

## Self-Review

**Spec coverage (3a = Model-B renderability):**
- Draft served in the canvas (§5) → Task 1 (published-then-draft `read_file`/`get_motif`) + Task 4 (capture resolves draft).
- Stable identity / no rebind (Model B) → Task 2 (final-ready ids + install-new keeps id).
- Catalog knows drafts (§8.2) → Task 3 (`list_motifs` status+drafts) + Task 5 (TS `status` + the catalog registers via the existing `setUserMotifs`/`syncCatalog` since drafts now appear in `list_motifs`).
- Render-side resilience / post-update migration (§4/§8.1) → Task 5 (`canonicalizePropsLenient` on the descriptor path).
- **Deferred to 3b (explicit):** the picker drafts section + New/Import, the property-panel Edit/Install/Delete buttons, the in-app source panel, external-editor file-watch + hot-reload, and a `motifs:changed` event so the runtime catalog auto-resyncs after a lifecycle mutation (3a relies on the existing picker-open/boot resync + a manual resync in the e2e).

**Placeholder scan:** Task 6's e2e HTML has a flagged CSS typo to fix before running (called out explicitly, not a silent placeholder). No other TBD/TODO; every code step is complete.

**Type/name consistency:** `list_drafts` (Task 1) is consumed by `list_motifs` (Task 3). `motif_to_payload(manifest, html, status)` (Task 3) — all three call sites updated in the same task. `canonicalizePropsLenient(props, manifest)` (Task 5, catalog.ts) is consumed by `motifFrameDescriptor.ts` (same task) and tested in both `catalog.test.ts` + `motifFrameDescriptor.test.ts`. `status` is optional on both `MotifManifest` (catalog.ts) and `MotifSummary` (ipc) so existing data still parses. `get_motif` (published-then-draft) is relied on by add_motif (Stage 1, unchanged — it `or_else(store.get_motif)`) and Task 4's capture closure.

**Note on add_motif:** no change needed — Stage 1's `add_motif` already does `builtins().find(...).or_else(|| store.get_motif(&motif_id))`, and `get_motif` now resolves drafts, so a draft id is placeable as-is.
