# Motif Upload Stage 3b-2 — In-App Live-Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit a placed **draft** Motif's source in an in-app panel and watch the project-canvas preview update live (hot reload), by adding an amend-draft backend, the §8.1 content-hash cache reconciliation, a Compositor refresh path, and replacing the picker's native `window.prompt` New flow with an inline form.

**Architecture:** A new `amend_motif_draft(draft_id, source)` Rust command parses the manifest island out of the edited full-source HTML server-side (no client-side parsing), forces the draft's id/version, re-composes idempotently, overwrites the same draft dir, and emits `motifs:changed`. The render cache key gains a source-derived `content_hash` (already computed by `Motif::content_hash()`), surfaced over `list_motifs`, so an edited draft yields a fresh key → fresh CDP capture. On `motifs:changed`, `PixiPreview` tells the Compositor to refresh its live Motif sprites (each re-fetches `getMotif` and resets its render target so the next composite re-captures — no sprite dispose, so no flash) and repaints. The in-app source panel lives in the property panel for a selected **draft** layer; "Apply" funnels through the amend command.

**Tech Stack:** Rust (Tauri commands, `blake3`, `serde_json`), TypeScript/React (PixiJS v8 compositor, Tauri IPC + events, i18next), vitest + cargo test, real-WebView2 e2e via tauri-mcp-server.

**Scope boundary (what this plan does NOT do — that is Stage 3b-3):** external-editor "Open in editor" + OS file-watch; `.html` Import; Edit-installed (seed a draft from an installed Motif) + built-in fork; Install-**update** (version bump + rebind + lenient props migration) + Save-as-new; the installed-Delete inline confirm. This plan covers **only** the in-app source-panel live-edit loop for a draft, the §8.1 cache reconciliation it requires, and the New inline-form replacement.

---

## Context an implementer needs

- **The draft store** (`apps/desktop/src-tauri/src/motifs/store.rs`): a draft lives at `<app_config_dir>/motifs/drafts/<draft_id>/index.html`. `write_draft(draft_id, html)` writes that composed file; `get_draft(draft_id)` parses its island → `Motif { manifest, html }` where `html` is the **full composed file** (island included). `safe_seg` rejects unsafe ids.
- **Compose/parse** (`apps/desktop/src-tauri/src/motifs/authoring.rs`): `compose_motif_html(manifest, html)` **strips any pre-existing manifest island, then injects a fresh one from `manifest`** (proven by the test `compose_replaces_a_pre_existing_island`). So passing the full edited source as `html` and the parsed manifest as `manifest` round-trips: the old island is stripped and an identical one re-injected. `validate_manifest(&manifest)` enforces semantic bounds.
- **The island parser** (`apps/desktop/src-tauri/src/motifs/catalog.rs`): `parse_manifest_island(html) -> Result<Manifest, MotifError>` locates `<script type="application/json" id="motif-manifest">…</script>` and `serde_json`-parses it. `Motif::content_hash()` (catalog.rs:191) is `blake3(manifest_json \0 html \0)` — already the source-derived key §8.1 wants; today only the Rust-side raster cache uses it.
- **The existing lifecycle command** (`apps/desktop/src-tauri/src/motifs/authoring_commands.rs`): `write_motif_draft(app, store, args{manifest, html})` **mints a new id every call** (`assign_unique_id`) — there is a `TODO(stage 3)` in it noting an amend path is needed. `emit_motifs_changed(&app)` emits `MOTIFS_CHANGED_EVENT = "motifs:changed"`. The three mutating commands take `app: AppHandle` first.
- **The list payload** (`apps/desktop/src-tauri/src/commands.rs`): `motif_to_payload(&manifest, html, status)` builds the per-Motif JSON (manifest fields + `html` + `status`); `list_motifs` returns built-ins, then installed, then drafts.
- **The TS catalog** (`apps/desktop/src/render/motifs/catalog.ts`): `MotifManifest` type + the runtime-extensible catalog; `setUserMotifs(payload)` replaces the user layer and bumps the change-notifier (`subscribeMotifCatalog`/`motifCatalogRevision`, added in 3b-1). `syncUserMotifsFromBackend()` (`syncCatalog.ts`) pulls `list_motifs` → `setUserMotifs`; the boot listener re-pulls on `motifs:changed`.
- **The frame cache key** (`apps/desktop/src/render/motifs/motifFrames.ts` `motifFrameCacheKey` + `motifFrameDescriptor.ts`): currently `motifId + version + canonicalProps + dims + fps + durationFrames`. A draft's `version` stays `1`, so editing it does **not** change the key — the bug §8.1 fixes.
- **The sprite** (`apps/desktop/src/render/sprite/MotifSprite.ts`): captures `this.motif = getMotif(motifId)` **once at construction** (line ~90) and reuses it; `update()` no-ops when `(cacheKey, frame)` is unchanged (line ~170). On a miss it keeps the last bound bitmap (only a first-ever-cold frame shows the neutral placeholder). `Compositor.ensureMotif` (Compositor.ts:1528) returns the existing `ActiveMotif` keyed by `layer.id`, so the sprite is never recreated on a catalog-only change.
- **The compositor + preview** (`apps/desktop/src/render/Compositor.ts`, `PixiPreview.tsx`): `Compositor` keeps `activeMotifs: Map<layerId, ActiveMotif>` and has `scheduleRepaint()` (Compositor.ts:400). `PixiPreview` owns the compositor via `compositorRef`, forwards summary updates in a `useEffect([summary, mediaById])` (`setProject` + `compositeFrame`), and has access to the current playhead via `engineRef.current?.positionUs()`.
- **Toolchain (this machine):** Node via `fnm` (v22.20.0 active). Run TS commands from `apps/desktop`. Use the **Bash** tool's `cd` sparingly; prefer running cargo/git via **PowerShell**. Vitest: `npx vitest run <path>`. Typecheck: `npx tsc -b`. Rust: `cargo test -p weftcut` (from `apps/desktop/src-tauri` or with `--manifest-path`). Rust source edits MUST go through the Edit tool (PowerShell `Set-Content` mangles em-dashes to cp1252).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/desktop/src-tauri/src/commands.rs` | `list_motifs` UI payload | Add `content_hash` to `motif_to_payload` |
| `apps/desktop/src-tauri/src/motifs/authoring_commands.rs` | lifecycle commands | New `amend_motif_draft` command; resolve the `TODO(stage 3)` amend note |
| `apps/desktop/src-tauri/src/lib.rs` | command registration | Register `amend_motif_draft` |
| `apps/desktop/src/ipc/index.ts` | IPC wrappers + types | `MotifSummary.content_hash`; `amendMotifDraft` wrapper |
| `apps/desktop/src/render/motifs/catalog.ts` | TS catalog | `MotifManifest.content_hash` |
| `apps/desktop/src/render/motifs/motifFrames.ts` | cache key | `motifFrameCacheKey` takes `contentHash` |
| `apps/desktop/src/render/motifs/motifFrameDescriptor.ts` | render inputs | pass `motif.manifest.content_hash` to the key |
| `apps/desktop/src/render/sprite/MotifSprite.ts` | Motif sprite | `refreshMotif()` (re-fetch motif + reset target) |
| `apps/desktop/src/render/Compositor.ts` | compositor | `refreshMotifs()` (call `refreshMotif` on all active) |
| `apps/desktop/src/render/PixiPreview.tsx` | preview host | listen `motifs:changed` → `refreshMotifs()` + repaint |
| `apps/desktop/src/properties/PropertyPanel.tsx` | property panel | `MotifSourcePanel` for a selected **draft** layer |
| `apps/desktop/src/motifs/MotifPicker.tsx` | picker | replace `window.prompt` New with an inline form |
| `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts` | strings | source-panel + New-form keys |
| `docs/motifs.md` | design doc | reconcile the cache-key description to source-derived (§8.1) |

---

### Task 1: Surface `content_hash` in the `list_motifs` payload (Rust, §8.1 part 1)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`motif_to_payload`, ~line 1922)

- [ ] **Step 1: Write the failing test**

Add to the bottom of `apps/desktop/src-tauri/src/commands.rs` (create a `#[cfg(test)] mod motif_payload_tests` if none exists):

```rust
#[cfg(test)]
mod motif_payload_tests {
    use super::motif_to_payload;
    use crate::motifs::catalog::{Manifest, Motif};
    use std::collections::BTreeMap;

    fn manifest(id: &str) -> Manifest {
        Manifest {
            id: id.into(), name: "X".into(), version: 1, size: [100, 100],
            default_duration_s: 1.0, max_duration_s: None, max_duration_prop: None,
            content_duration_s: None, fonts: vec![], props_schema: BTreeMap::new(),
        }
    }

    #[test]
    fn payload_carries_content_hash_matching_motif_content_hash() {
        let m = manifest("foo");
        let html = "<head></head><body>one</body>".to_string();
        let payload = motif_to_payload(&m, html.clone(), "draft").unwrap();
        let got = payload.get("content_hash").and_then(|v| v.as_str()).unwrap();
        let expect = Motif { manifest: m, html }.content_hash();
        assert_eq!(got, expect);
    }

    #[test]
    fn payload_content_hash_changes_with_html() {
        let m = manifest("foo");
        let a = motif_to_payload(&m, "<body>one</body>".into(), "draft").unwrap();
        let b = motif_to_payload(&m, "<body>two</body>".into(), "draft").unwrap();
        assert_ne!(
            a.get("content_hash").unwrap(),
            b.get("content_hash").unwrap()
        );
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `apps/desktop/src-tauri`): `cargo test -p weftcut motif_payload_tests`
Expected: FAIL — `content_hash` key is absent (`unwrap()` on `None`).

- [ ] **Step 3: Implement `content_hash` in `motif_to_payload`**

In `apps/desktop/src-tauri/src/commands.rs`, change `motif_to_payload` to compute the hash from the same `(manifest, html)` it serializes. Compute BEFORE moving `html` into the object:

```rust
fn motif_to_payload(
    manifest: &crate::motifs::catalog::Manifest,
    html: String,
    status: &str,
) -> Result<serde_json::Value, String> {
    // Source-derived cache identity (upload-design §8.1): blake3 of manifest+html.
    // Surfaced so the TS frame cache re-captures when a draft's source changes
    // (its `version` stays 1, so version alone can't bust the key).
    let content_hash = crate::motifs::catalog::Motif {
        manifest: manifest.clone(),
        html: html.clone(),
    }
    .content_hash();
    let mut v = serde_json::to_value(manifest).map_err(|e| format!("manifest serialize: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "manifest is not a JSON object".to_string())?;
    obj.insert("html".to_string(), serde_json::Value::String(html));
    obj.insert("status".to_string(), serde_json::Value::String(status.to_string()));
    obj.insert("content_hash".to_string(), serde_json::Value::String(content_hash));
    Ok(v)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test -p weftcut motif_payload_tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(motifs): surface content_hash in the list_motifs payload (§8.1)"
```

---

### Task 2: Include `content_hash` in the TS frame cache key (§8.1 part 2)

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts` (`MotifSummary`)
- Modify: `apps/desktop/src/render/motifs/catalog.ts` (`MotifManifest`)
- Modify: `apps/desktop/src/render/motifs/motifFrames.ts` (`motifFrameCacheKey`)
- Modify: `apps/desktop/src/render/motifs/motifFrameDescriptor.ts`
- Test: `apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts`, add (reuse the file's existing helpers for building a `Motif` + `MotifView`; if it has a `makeMotif`/`makeView` helper use it, otherwise construct inline mirroring the existing tests):

```ts
it("cacheKey changes when the motif's content_hash changes (draft hot-reload)", () => {
  const view = makeView({ props: {} });
  const base = makeMotif({ id: "d1", version: 1, content_hash: "hashA" });
  const edited = makeMotif({ id: "d1", version: 1, content_hash: "hashB" });
  const a = motifFrameDescriptor(view, 0, 5_000_000, 30, 1, base)!;
  const b = motifFrameDescriptor(view, 0, 5_000_000, 30, 1, edited)!;
  expect(a.cacheKey).not.toBe(b.cacheKey);
});

it("cacheKey is stable when content_hash is unchanged", () => {
  const view = makeView({ props: {} });
  const m = makeMotif({ id: "d1", version: 1, content_hash: "hashA" });
  const a = motifFrameDescriptor(view, 0, 5_000_000, 30, 1, m)!;
  const b = motifFrameDescriptor(view, 0, 5_000_000, 30, 1, m)!;
  expect(a.cacheKey).toBe(b.cacheKey);
});
```

If the test file lacks `makeMotif`/`makeView`, add them near the top (match the `Motif`/`MotifView` shapes; `makeMotif` returns `{ manifest: { id, name:"X", version, size:[100,100], default_duration_s:5, props_schema:{}, content_hash }, html:"" }`, `makeView` returns `{ motif_id:"d1", motif_version:1, props:{}, src_in_us:0, x:0, y:0, scale_x:1, scale_y:1, opacity:1 }`).

- [ ] **Step 2: Run it to verify it fails**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/motifFrameDescriptor.test.ts`
Expected: FAIL — `a.cacheKey` equals `b.cacheKey` (content_hash not yet in the key), and `content_hash` is not a known `MotifManifest` field (tsc/type error in the test).

- [ ] **Step 3: Add the type field + thread it into the key**

In `apps/desktop/src/render/motifs/catalog.ts`, add to the `MotifManifest` interface (near `version`/`status`):

```ts
  /// blake3 of (manifest + html), surfaced by the `list_motifs` IPC. Part of the
  /// frame cache key so editing a draft's source re-captures even though its
  /// `version` stays 1 (upload-design §8.1). Absent for built-ins seeded from the
  /// build-time glob (their content is stable, so the key stays stable without it).
  content_hash?: string;
```

In `apps/desktop/src/ipc/index.ts`, add the same optional field to `MotifSummary`:

```ts
  content_hash?: string;
```

In `apps/desktop/src/render/motifs/motifFrames.ts`, extend `motifFrameCacheKey` to accept and include `contentHash`. Find the function and add the field to its input object and to the serialized key string. Example (match the file's actual key-building style):

```ts
export function motifFrameCacheKey(input: {
  motifId: string;
  version: number;
  contentHash?: string;
  canonicalProps: Record<string, unknown>;
  renderW: number;
  renderH: number;
  fpsNum: number;
  fpsDen: number;
  durationFrames: number;
}): string {
  // contentHash (when present) makes the key source-derived (§8.1): a draft
  // edit changes the hash → a fresh key → a fresh capture. `version` is kept so
  // an installed-Motif version bump also busts the key even if a hash is absent.
  return JSON.stringify([
    input.motifId,
    input.version,
    input.contentHash ?? null,
    input.canonicalProps,
    input.renderW,
    input.renderH,
    input.fpsNum,
    input.fpsDen,
    input.durationFrames,
  ]);
}
```

(If the existing implementation builds a delimited string rather than `JSON.stringify`, insert `input.contentHash ?? ""` into the same delimited form right after `version` — preserve the file's existing style; the only requirement is the hash participates in the key.)

In `apps/desktop/src/render/motifs/motifFrameDescriptor.ts`, pass it through at the `motifFrameCacheKey({ … })` call (line ~56):

```ts
  const cacheKey = motifFrameCacheKey({
    motifId: motif.manifest.id,
    version: motif.manifest.version,
    contentHash: motif.manifest.content_hash,
    canonicalProps, renderW, renderH, fpsNum, fpsDen,
    durationFrames: contentDurationFrames,
  });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/render/motifs/motifFrameDescriptor.test.ts` then `npx vitest run src/render/motifs/motifFrames.test.ts` (if present).
Expected: PASS. Also run `npx tsc -b` — expect clean (any caller of `motifFrameCacheKey` that omits `contentHash` is fine — it's optional).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/render/motifs/catalog.ts apps/desktop/src/render/motifs/motifFrames.ts apps/desktop/src/render/motifs/motifFrameDescriptor.ts apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts
git commit -m "feat(motifs): include content_hash in the frame cache key (§8.1 draft hot-reload)"
```

---

### Task 3: `amend_motif_draft` command — overwrite a draft from its full edited source (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register the command in `tauri::generate_handler!`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`. The command itself takes Tauri `State`/`AppHandle`, so test the **core logic** by factoring it into a free function `amend_draft_html(store, draft_id, source) -> Result<(), String>` (the command is a thin wrapper that adds `app`/emit). Test that helper:

```rust
#[test]
fn amend_overwrites_same_draft_id_and_forces_id() {
    use super::super::store::UserMotifStore;
    use super::super::authoring::compose_motif_html;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());

    // Seed a draft "d1".
    let mut man = m("Draft One"); man.id = "d1".into();
    store.write_draft("d1", &compose_motif_html(&man,
        "<head></head><body>one<script>motif.define({setup(){}})</script></body>")).unwrap();

    // Amend it from a full edited source whose island claims a DIFFERENT id +
    // changed body. The amend must keep id == "d1" and persist the new body.
    let edited = compose_motif_html(&{ let mut x = m("Renamed"); x.id = "hacker".into(); x },
        "<head></head><body>TWO<script>motif.define({setup(){}})</script></body>");
    super::amend_draft_html(&store, "d1", &edited).unwrap();

    assert_eq!(store.list_draft_ids(), vec!["d1".to_string()]); // no new draft minted
    let got = store.get_draft("d1").unwrap();
    assert_eq!(got.manifest.id, "d1");          // id forced back to the draft id
    assert!(got.html.contains("TWO"));          // new body persisted
}

#[test]
fn amend_rejects_unknown_draft_and_invalid_manifest() {
    use super::super::store::UserMotifStore;
    use super::super::authoring::compose_motif_html;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    // Unknown draft.
    let src = compose_motif_html(&m("X"), "<head></head><body>x</body>");
    assert!(super::amend_draft_html(&store, "nope", &src).is_err());
    // Seed then amend with a source whose manifest is invalid (zero size).
    let mut man = m("D"); man.id = "d1".into();
    store.write_draft("d1", &compose_motif_html(&man, "<head></head><body>x</body>")).unwrap();
    let mut bad = m("D"); bad.size = [0, 0];
    let bad_src = compose_motif_html(&bad, "<head></head><body>x</body>");
    assert!(super::amend_draft_html(&store, "d1", &bad_src).is_err());
}
```

(`m(name)` is the existing test helper in that module.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p weftcut authoring_commands`
Expected: FAIL — `amend_draft_html` does not exist.

- [ ] **Step 3: Implement `amend_draft_html` + the command wrapper**

In `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`, add the imports `parse_manifest_island` and `validate_manifest` if not already in scope, then:

```rust
use super::authoring::{assign_unique_id, compose_motif_html, validate_manifest};
use super::catalog::{builtins, parse_manifest_island, Manifest, BUILTIN_IDS};

/// Core of `amend_motif_draft`: parse the manifest island out of an edited
/// full-source document, force the draft's stable identity (id + draft version
/// 1 — id/version are app-assigned, never author-controlled), re-validate, and
/// overwrite the SAME draft on disk. No `AppHandle` here so it's unit-testable;
/// the command wrapper adds the `motifs:changed` emit.
pub fn amend_draft_html(
    store: &UserMotifStore,
    draft_id: &str,
    source: &str,
) -> Result<(), String> {
    // The draft must already exist — amend never creates (that's write_motif_draft).
    if store.get_draft(draft_id).is_none() {
        return Err(format!("unknown draft '{draft_id}'"));
    }
    let mut manifest: Manifest =
        parse_manifest_island(source).map_err(|e| e.to_string())?;
    // Identity is app-owned: ignore any id/version the edited island claims.
    manifest.id = draft_id.to_string();
    manifest.version = 1;
    validate_manifest(&manifest).map_err(|e| e.to_string())?;
    // compose strips the (possibly-edited) island and re-injects a canonical one
    // from `manifest`; the author's body is preserved verbatim and round-trips.
    let html = compose_motif_html(&manifest, source);
    store.write_draft(draft_id, &html).map_err(|e| e.to_string())
}

/// Overwrite an existing draft from its full edited source (the in-app source
/// panel + the Stage-3b-2b file-watch funnel both call this). Distinct from
/// `write_motif_draft`, which MINTS a new draft id; amend keeps the id stable so
/// a placed draft layer keeps resolving while you edit. Emits `motifs:changed`
/// so the catalog resyncs (new content_hash) and the preview re-captures.
#[tauri::command]
pub async fn amend_motif_draft(
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    draft_id: String,
    source: String,
) -> Result<(), String> {
    amend_draft_html(&store, &draft_id, &source)?;
    emit_motifs_changed(&app);
    Ok(())
}
```

Also resolve the `TODO(stage 3)` comment in `write_motif_draft` by replacing the "an iterative edit UI will want an amend path" sentence with: `// Stage 3b-2 added that amend path as `amend_motif_draft` (keeps the id stable).` (Leave the emit-debounce note — that's still future.)

- [ ] **Step 4: Register the command**

In `apps/desktop/src-tauri/src/lib.rs`, find the `tauri::generate_handler!` macro list and add `motifs::authoring_commands::amend_motif_draft` next to the existing `write_motif_draft` / `install_motif` / `delete_motif` entries (match the exact module path those use).

- [ ] **Step 5: Run it to verify it passes**

Run: `cargo test -p weftcut authoring_commands` then `cargo build -p weftcut` (confirms the handler registration compiles).
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): amend_motif_draft — overwrite a draft from edited source (stable id)"
```

---

### Task 4: `amendMotifDraft` IPC wrapper (TS)

**Files:**
- Modify: `apps/desktop/src/ipc/index.ts`
- Test: `apps/desktop/src/ipc/motifLifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/ipc/motifLifecycle.test.ts`:

```ts
it("amendMotifDraft passes draft_id + source (snake_case for serde)", async () => {
  invoke.mockResolvedValue(undefined);
  await amendMotifDraft("d1", "<html>edited</html>");
  expect(invoke).toHaveBeenCalledWith("amend_motif_draft", {
    draftId: "d1",
    source: "<html>edited</html>",
  });
});
```

Add `amendMotifDraft` to the import from `"./index"` at the top of the test.

> Note: `draft_id` and `source` are **top-level** command args, so Tauri camelCases them to `draftId`/`source` on the wire (unlike `write_motif_draft`'s nested `args.{manifest,html}` struct, which serde reads as-is). Verify against `amend_motif_draft`'s signature: it takes `draft_id: String, source: String` directly, so camelCase is correct.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ipc/motifLifecycle.test.ts`
Expected: FAIL — `amendMotifDraft` is not exported.

- [ ] **Step 3: Implement the wrapper**

In `apps/desktop/src/ipc/index.ts`, near `writeMotifDraft`:

```ts
/// Overwrite an existing draft from its full edited source (in-app source panel).
/// Keeps the draft id stable; the backend re-parses the manifest island, forces
/// id/version, re-composes, and emits `motifs:changed`.
export async function amendMotifDraft(draftId: string, source: string): Promise<void> {
  await invoke("amend_motif_draft", { draftId, source });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/ipc/motifLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/ipc/motifLifecycle.test.ts
git commit -m "feat(motifs): amendMotifDraft IPC wrapper"
```

---

### Task 5: Compositor refresh path — preview re-captures on a draft-source change

**Files:**
- Modify: `apps/desktop/src/render/sprite/MotifSprite.ts`
- Modify: `apps/desktop/src/render/Compositor.ts`
- Modify: `apps/desktop/src/render/PixiPreview.tsx`
- Test: `apps/desktop/src/render/sprite/MotifSprite.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/render/sprite/MotifSprite.test.ts`, add a test that `refreshMotif()` resets the render target so the next `update()` re-evaluates the cache key (rather than no-opping). Follow the file's existing mocking of `getMotif` / `sharedMotifFrameCache`. If the suite mocks `getMotif`, make it return an edited manifest (new `content_hash`) on the second call:

```ts
it("refreshMotif re-fetches the motif and forces the next update to re-evaluate", () => {
  // getMotif first returns content_hash "A", then "B" after the edit.
  const m0 = makeMotif({ id: "d1", content_hash: "A" });
  const m1 = makeMotif({ id: "d1", content_hash: "B" });
  getMotifMock.mockReturnValueOnce(m0).mockReturnValueOnce(m1);

  const sprite = new MotifSprite({ layerId: "L1", motifId: "d1", fpsNum: 30, fpsDen: 1 });
  sprite.update(makeView(), 0, 5_000_000);
  const firstKey = sharedMotifFrameCache.getFrame.mock.calls.at(-1)?.[0];

  sprite.refreshMotif();
  sprite.update(makeView(), 0, 5_000_000);
  const secondKey = sharedMotifFrameCache.getFrame.mock.calls.at(-1)?.[0];

  expect(secondKey).not.toBe(firstKey); // new content_hash → new key → re-capture
});
```

(Adapt names to the test file's existing harness — the key assertion is that after `refreshMotif()`, a same-time `update()` produces a different cache key when the catalog's motif changed.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/render/sprite/MotifSprite.test.ts`
Expected: FAIL — `refreshMotif` is not a method.

- [ ] **Step 3: Add `MotifSprite.refreshMotif()`**

In `apps/desktop/src/render/sprite/MotifSprite.ts`, add a public method (after `update`, before `captureAndBind`):

```ts
  /// Re-fetch this layer's Motif from the runtime catalog and reset the render
  /// target so the next `update()` re-evaluates the cache key and re-captures.
  /// Called by `Compositor.refreshMotifs()` when the catalog changes (a draft
  /// edit / install / delete). Does NOT dispose — the last bound bitmap stays on
  /// screen until the fresh frame lands, so there's no flash. A no-op once
  /// disposed.
  refreshMotif(): void {
    if (this.disposed) return;
    this.motif = getMotif(this.motifId);
    // Force the next update() past its (cacheKey, frame) no-op guard.
    this.targetCacheKey = null;
    this.targetFrame = -1;
  }
```

- [ ] **Step 4: Add `Compositor.refreshMotifs()`**

In `apps/desktop/src/render/Compositor.ts`, add a public method (near the other Motif methods; `activeMotifs` is the `Map<layerId, ActiveMotif>` at ~line 237):

```ts
  /// Refresh every live Motif sprite against the current runtime catalog and
  /// schedule a repaint. Called when `motifs:changed` fires (a draft edit /
  /// install / delete) so an edited draft's preview re-captures with its new
  /// content. Cheap + user-paced; no sprite is recreated (refreshMotif keeps the
  /// last bitmap until the fresh capture lands).
  refreshMotifs(): void {
    for (const { sprite } of this.activeMotifs.values()) {
      sprite.refreshMotif();
    }
    this.scheduleRepaint();
  }
```

- [ ] **Step 5: Wire it in `PixiPreview`**

In `apps/desktop/src/render/PixiPreview.tsx`, add a `useEffect` (after the `[summary, mediaById]` effect, ~line 275) that subscribes to `motifs:changed` for the compositor's lifetime. Import `listen` from `@tauri-apps/api/event` and `MOTIFS_CHANGED_EVENT` from `../ipc` at the top if not already present:

```tsx
  // A draft edit / install / delete (motifs:changed) changes a Motif's source
  // but NOT the project summary, so the [summary] effect above won't fire. Tell
  // the compositor to refresh its live Motif sprites against the new catalog and
  // recapture at the current playhead.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cleaned = false;
    void listen(MOTIFS_CHANGED_EVENT, () => {
      const c = compositorRef.current;
      if (!c) return;
      c.refreshMotifs();
      c.compositeFrame(engineRef.current?.positionUs() ?? 0);
    }).then((u) => {
      if (cleaned) u();
      else un = u;
    });
    return () => {
      cleaned = true;
      un?.();
    };
  }, []);
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/render/sprite/MotifSprite.test.ts` then `npx tsc -b`.
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/sprite/MotifSprite.ts apps/desktop/src/render/Compositor.ts apps/desktop/src/render/PixiPreview.tsx apps/desktop/src/render/sprite/MotifSprite.test.ts
git commit -m "feat(motifs): Compositor refreshMotifs + PixiPreview motifs:changed wiring (live preview)"
```

---

### Task 6: In-app source panel for a selected draft layer (PropertyPanel)

**Files:**
- Modify: `apps/desktop/src/properties/PropertyPanel.tsx`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`, `apps/desktop/src/i18n/locales/zh-CN.ts`
- Modify: `apps/desktop/src/styles.css` (panel styles)

- [ ] **Step 1: Add i18n keys**

In `apps/desktop/src/i18n/locales/en-US.ts`, in the `property_panel` block near `motif_install`/`motif_delete`:

```ts
    motif_source: "Source",
    motif_source_apply: "Apply",
    motif_source_applying: "Applying…",
    motif_source_hint: "Edit the Motif's HTML + manifest island, then Apply to update the preview.",
```

In `apps/desktop/src/i18n/locales/zh-CN.ts`, the same keys:

```ts
    motif_source: "源代码",
    motif_source_apply: "应用",
    motif_source_applying: "应用中…",
    motif_source_hint: "编辑 Motif 的 HTML 与清单岛，然后点击「应用」更新预览。",
```

- [ ] **Step 2: Add the `MotifSourcePanel` component + render it for drafts**

In `apps/desktop/src/properties/PropertyPanel.tsx`, add `getMotifSource`, `amendMotifDraft` to the `../ipc` import. Add the component (place it near `MotifLifecycleRow`):

```tsx
/// In-app source editor for a selected DRAFT Motif layer (upload-design §6).
/// Deliberately minimal: a plain textarea of the draft's full composed source
/// (manifest island + body). "Apply" funnels through `amendMotifDraft`, which
/// re-parses the island, forces the stable id, re-composes, and emits
/// `motifs:changed` → the catalog resyncs (new content_hash) → the canvas
/// preview re-captures. Only shown for drafts; editing an installed Motif (which
/// seeds a fresh draft) is Stage 3b-3.
function MotifSourcePanel({ motifId }: { motifId: string }) {
  const { t } = useTranslation();
  // Re-resolve status reactively (same notifier the row uses) so this unmounts
  // the instant the draft is installed/deleted.
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  const status = getMotif(motifId)?.manifest.status;
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the textarea from disk whenever the selected draft changes.
  useEffect(() => {
    let alive = true;
    setErr(null);
    setSource(null);
    getMotifSource(motifId)
      .then((s) => { if (alive) setSource(s.html); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [motifId]);

  if (status !== "draft") return null;

  const apply = async () => {
    if (source == null) return;
    setBusy(true);
    setErr(null);
    try {
      await amendMotifDraft(motifId, source);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prop-motif-source">
      <h4>{t("property_panel.motif_source")}</h4>
      <p className="meta">{t("property_panel.motif_source_hint")}</p>
      <textarea
        className="prop-motif-source-text"
        spellCheck={false}
        value={source ?? ""}
        disabled={source == null || busy}
        onChange={(e) => setSource(e.target.value)}
      />
      <button disabled={busy || source == null} onClick={apply}>
        {busy ? t("property_panel.motif_source_applying") : t("property_panel.motif_source_apply")}
      </button>
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
```

Render it inside the Motif section, right after `<MotifLifecycleRow motifId={v.motif_id} />` (PropertyPanel.tsx:641):

```tsx
      <MotifLifecycleRow motifId={v.motif_id} />
      <MotifSourcePanel motifId={v.motif_id} />
```

- [ ] **Step 3: Add minimal styles**

In `apps/desktop/src/styles.css`, append:

```css
.prop-motif-source { margin: 8px 0; }
.prop-motif-source-text {
  width: 100%;
  min-height: 160px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  resize: vertical;
  white-space: pre;
}
```

- [ ] **Step 4: Verify typecheck + full suite**

Run (from `apps/desktop`): `npx tsc -b` then `npx vitest run`.
Expected: clean + all green (this task has no new unit test — it's UI wired to already-tested IPC; it is exercised by the Task 8 e2e).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts apps/desktop/src/styles.css
git commit -m "feat(motifs): in-app source panel for a selected draft layer (Apply → amend)"
```

---

### Task 7: Replace the picker's `window.prompt` New with an inline form

**Files:**
- Modify: `apps/desktop/src/motifs/MotifPicker.tsx`
- Modify: `apps/desktop/src/i18n/locales/en-US.ts`, `apps/desktop/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add i18n keys**

In both locale files, in the `template_picker` block (en-US shown; mirror in zh-CN):

```ts
    new_create: "Create",
    new_cancel: "Cancel",
    new_name_placeholder: "Motif name",
```
zh-CN:
```ts
    new_create: "创建",
    new_cancel: "取消",
    new_name_placeholder: "Motif 名称",
```

(`new_button`/`new_prompt` already exist; `new_prompt` is reused as the input's accessible label.)

- [ ] **Step 2: Replace the prompt handler with inline state**

In `apps/desktop/src/motifs/MotifPicker.tsx`, add state in the `MotifPicker` component body (near the other `useState`s):

```tsx
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const createDraft = async () => {
    const name = newName.trim();
    if (name === "") return;
    try {
      const { manifest, html } = newDraftSource(name);
      const draftId = await writeMotifDraft(manifest, html);
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
      setNewOpen(false);
      setNewName("");
    } catch (e) {
      setError(String(e));
    }
  };
```

Replace the existing `<button className="template-picker-new" onClick={async () => { const name = window.prompt(…) … }}>` block in the header with:

```tsx
          {newOpen ? (
            <form
              className="template-picker-new-form"
              onSubmit={(e) => { e.preventDefault(); void createDraft(); }}
            >
              <input
                type="text"
                autoFocus
                value={newName}
                placeholder={t("template_picker.new_name_placeholder")}
                aria-label={t("template_picker.new_prompt")}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setNewOpen(false); setNewName(""); } }}
              />
              <button type="submit" disabled={newName.trim() === ""}>
                {t("template_picker.new_create")}
              </button>
              <button type="button" onClick={() => { setNewOpen(false); setNewName(""); }}>
                {t("template_picker.new_cancel")}
              </button>
            </form>
          ) : (
            <button className="template-picker-new" onClick={() => setNewOpen(true)}>
              {t("template_picker.new_button")}
            </button>
          )}
```

- [ ] **Step 3: Verify typecheck + suite**

Run: `npx tsc -b` then `npx vitest run`.
Expected: clean + green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/motifs/MotifPicker.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(motifs): inline New-draft form in the picker (drop window.prompt)"
```

---

### Task 8: Doc reconciliation (§8.1) + real-WebView2 e2e verification

**Files:**
- Modify: `docs/motifs.md`
- (Verification only — drive the running `tauri dev` via the tauri-mcp-server, no committed e2e spec required for this stage; if `apps/desktop/e2e/specs/` has a natural home, add one, otherwise verify manually and record the result.)

- [ ] **Step 1: Reconcile the cache-key doc (§8.1)**

In `docs/motifs.md`, find the passage describing the frame cache as `version`-keyed and update it to state the key is **source-derived**: it includes the Motif's `content_hash` (blake3 of manifest + html) alongside id/version/props/dims/fps, so editing a draft's source (or an installed-Motif update) busts the cache without relying on a layer's stored `motif_version`. Keep it evergreen (no stage numbers / dates — per the repo's evergreen-docs rule).

- [ ] **Step 2: Commit the doc**

```bash
git add docs/motifs.md
git commit -m "docs(motifs): cache key is source-derived (content_hash), reconciling §8.1"
```

- [ ] **Step 3: Real-WebView2 verification (manual, via tauri-mcp-server)**

Rebuild `tauri dev` on this branch. Then drive it (use `window.__TAURI__.core.invoke` via `webview_execute_js` — `ipc_execute_command` is bridge-allowlisted; Vite dedupes modules so `await import('/src/render/motifs/catalog.ts')` reads the live catalog):

1. Create a draft via the picker's new inline form (or `write_motif_draft` IPC), place it (`add_motif`), select the layer.
2. Confirm the property panel shows the **Source** textarea (status === "draft") seeded with the composed HTML (manifest island visible).
3. Edit the body text in the textarea (e.g. change the title default or a CSS color), click **Apply**.
4. Confirm: the canvas preview updates to the new look **without reselecting** (the `motifs:changed` → `refreshMotifs` → re-capture path), and the catalog's `content_hash` for the draft changed (probe `getMotif(id).manifest.content_hash` before/after).
5. Confirm a deliberately-invalid edit (e.g. set the island `size` to `[0,0]`) shows the error under the textarea and does NOT change the preview.
6. Clean up: delete the draft + the placed layer via IPC.

Record the verification outcome (pass/fail + what was observed) in the PR / completion notes. Do NOT mark the task done unless the live preview updated on Apply.

---

## Self-Review

**1. Spec coverage (§6 in-app surface + §8.1):**
- §6 "in-app simple source panel … 'Apply' writes the draft file → same re-render" → Tasks 3 (amend backend), 4 (IPC), 6 (panel). ✓
- §6 "both surfaces funnel through one 'draft source changed' routine" → `amend_motif_draft` is that routine; the Stage-3b-2b file-watch will call the same command. ✓ (external-editor surface explicitly deferred to 3b-2b.)
- §8.1 "cache key must track current installed content … reconcile to one source-derived key" → Tasks 1, 2 (content_hash into payload + cache key) + Task 8 doc. ✓
- §5 "draft frames cached by content hash … every source edit yields a new hash → fresh capture → preview updates" → Tasks 1+2 (hash in key) + Task 5 (refresh + repaint). ✓
- New inline form (drop `window.prompt`) → Task 7. ✓
- Explicitly OUT (Stage 3b-3): external editor + file-watch, Import, Edit-installed, Update/Save-as-new, installed-Delete confirm. Stated in the scope boundary. ✓

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Every code step shows real code grounded in the current files. Test bodies are concrete. ✓

**3. Type consistency:** `content_hash` (snake_case) is the field name in Rust payload, `MotifSummary`, and `MotifManifest`; the cache-key input uses `contentHash` (camelCase local). `amend_motif_draft` (Rust) ↔ `amendMotifDraft` (TS) ↔ args `{ draftId, source }`. `amend_draft_html` is the testable free fn; `amend_motif_draft` the command wrapper. `refreshMotif` (sprite) ↔ `refreshMotifs` (compositor). All consistent. ✓

**4. Known soft spots flagged for the implementer:**
- Task 2: if `motifFrameCacheKey` uses a delimited string instead of `JSON.stringify`, insert `contentHash` preserving that style (the only requirement: the hash participates).
- Task 5 test: adapt to `MotifSprite.test.ts`'s existing mock harness; the load-bearing assertion is "different content_hash after refreshMotif → different cache key".
- Task 4: confirm `amend_motif_draft`'s args are top-level (camelCased by Tauri) — they are (`draft_id: String, source: String`), unlike `write_motif_draft`'s nested `args` struct.
