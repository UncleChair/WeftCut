# Motif Upload Stage 3b-3b — `.html` Import + Inline Confirms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user **import an external `.html` Motif file** (it lands as a draft to preview + install), and **replace the two remaining native `window.confirm` dialogs** in the Motif property-panel row (installed-Delete + Update blast-radius) with inline confirm UI — making the whole Motif lifecycle native-dialog-free and fully drivable.

**Architecture:** Import = a picker "Import" button → `@tauri-apps/plugin-dialog` `open` (single `*.html`) → a new Rust `import_motif(path)` command reads the file, parses + validates its manifest island, assigns a fresh unique draft id (ignoring any id the file claims), composes + writes a draft, and emits `motifs:changed` — it appears as a from-scratch draft in the picker. Inline confirms = the row's Delete/Update buttons enter a small "pending confirm" state (`[Confirm] [Cancel]` + the message inline) instead of calling `window.confirm`.

**Tech Stack:** Rust (Tauri command, `std::fs`, the existing motif island parser/validator), TypeScript/React (`@tauri-apps/plugin-dialog`, i18next), vitest + cargo test, real-WebView2 e2e via tauri-mcp-server.

**Locked decisions (confirmed with the user 2026-06-09):**
- Single-file `.html` only (assets inline as `data:` URIs, per design §11); a file with no/invalid manifest island is **rejected at import** with a clear error.
- Replace **both** remaining native `window.confirm`s (installed-Delete AND Update blast-radius), not just Delete.
- This is the final 3b-3 slice; after it, Plan-4 remaining = Stage 4 (MCP) + Stage 5 (cross-project).

---

## Context an implementer needs

- **Motif island parse/validate/compose** (`apps/desktop/src-tauri/src/motifs/`): `catalog::parse_manifest_island(html) -> Result<Manifest, MotifError>`, `authoring::validate_manifest(&Manifest) -> Result<(), MotifError>`, `authoring::assign_unique_id(name, taken: &[String]) -> String`, `authoring::compose_motif_html(manifest, html)` (strips+reinjects the island). `authoring_commands.rs` has `amend_draft_html` (parses a full source + forces id/version + validates + composes + writes a draft) — `import_motif` is the same shape but reads from a file path and mints a fresh id. It also has `emit_motifs_changed(&app)`, `MOTIFS_CHANGED_EVENT`, and `create_edit_draft` (the most recent command — register `import_motif` next to it). `store.write_draft(draft_id, html)`, `store.published_ids()`, `store.list_draft_ids()`.
- **Command registration**: `apps/desktop/src-tauri/src/lib.rs` `tauri::generate_handler!` lists the motif commands (`create_edit_draft`, `write_motif_draft`, `amend_motif_draft`, `install_motif`, `delete_motif`, `get_motif_source`, `motif_capture_frame`, `add_motif`, `list_motifs`).
- **The picker** (`apps/desktop/src/motifs/MotifPicker.tsx`): the header has the inline **New** form (3b-2) — `newOpen`/`newName` state + a "New" button that toggles it. `writeMotifDraft`, `addMotif`, `listMotifs` come from `../ipc`; `setUserMotifs` from the catalog; `setSelectedId` selects a card; `setError` shows an error. The Import button sits alongside New.
- **Dialog plugin** (`@tauri-apps/plugin-dialog`): imported elsewhere as `import { open as openDialog } from "@tauri-apps/plugin-dialog";` (see `StartupScreen.tsx`, `App.tsx`). `await openDialog({ multiple: false, filters: [{ name: "...", extensions: ["html"] }] })` returns `string | null` (the picked path, or null if cancelled).
- **The property-panel row** (`apps/desktop/src/properties/PropertyPanel.tsx`, `MotifLifecycleRow`): two `window.confirm` sites remain — installed-Delete (~line 800: `if (!window.confirm(t("property_panel.motif_delete_confirm", { id: motifId }))) return; await deleteMotif(motifId); await onMutated();`) and Update (~line 842: builds `msg` from `motif_update_confirm_one|many`, `if (!window.confirm(msg)) return; await installMotif(motifId, {kind:"update", target_id: target}); await onMutated();`). The row already has `busy`/`err` state + a `run(fn)` helper + `useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision)` + `updateBlastRadius(targetId)`.
- **Toolchain:** Node via `fnm` (v22). TS from `apps/desktop` (`npx vitest run`, `npx tsc -b`). Rust from `apps/desktop/src-tauri` (`cargo test -p weftcut <filter>`, `cargo build -p weftcut`). Rust edits via Edit/Write tools only (cp1252). PowerShell for cargo/git.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src-tauri/src/motifs/authoring_commands.rs` | lifecycle commands | new `import_motif_from_source` (pure) + `import_motif(path)` command |
| `src-tauri/src/lib.rs` | command registration | register `import_motif` |
| `src/ipc/index.ts` | IPC wrappers | `importMotif(path)` |
| `src/motifs/MotifPicker.tsx` | picker | "Import" button → dialog → `importMotif` |
| `src/properties/PropertyPanel.tsx` | property row | inline confirm replacing both `window.confirm`s |
| `src/i18n/locales/{en-US,zh-CN}.ts` | strings | `motif_confirm` / `motif_cancel` (+ reuse existing confirm messages) |
| `docs/motifs.md` | doc | one line: Motifs can be imported from a `.html` file |

---

### Task 1: `import_motif` command — import a `.html` file as a draft (Rust)

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`, `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test** (add to the `#[cfg(test)] mod tests`, testing the pure core `import_motif_from_source(store, source)`):

```rust
#[test]
fn import_motif_from_source_mints_unique_draft_and_ignores_claimed_id() {
    use super::super::store::UserMotifStore;
    use super::super::authoring::compose_motif_html;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    // A composed file whose island claims id "countdown" (a built-in) — import must
    // ignore it and mint a fresh unique id.
    let mut man = m("Imported"); man.id = "countdown".into();
    let source = compose_motif_html(&man,
        "<head></head><body>IMPORTED<script>motif.define({setup(){}})</script></body>");
    let draft_id = super::import_motif_from_source(&store, &source).unwrap();
    assert_ne!(draft_id, "countdown");          // never collides with a built-in
    let d = store.get_draft(&draft_id).unwrap();
    assert_eq!(d.manifest.id, draft_id);        // island rewritten to the minted id
    assert!(d.html.contains("IMPORTED"));       // body preserved
    assert_eq!(store.read_draft_target(&draft_id), None); // imported draft has no Update target
}

#[test]
fn import_motif_from_source_rejects_missing_or_invalid_island() {
    use super::super::store::UserMotifStore;
    let tmp = tempfile::tempdir().unwrap();
    let store = UserMotifStore::new(tmp.path().to_path_buf());
    // No island at all.
    assert!(super::import_motif_from_source(&store, "<html><body>no island</body></html>").is_err());
    // Island present but invalid manifest (zero size).
    use super::super::authoring::compose_motif_html;
    let mut bad = m("Bad"); bad.size = [0, 0];
    let src = compose_motif_html(&bad, "<head></head><body>x</body>");
    assert!(super::import_motif_from_source(&store, &src).is_err());
}
```

(`m(name)` is the existing test helper. Confirm `read_draft_target` exists — it does, from 3b-3a.)

- [ ] **Step 2: Run it to verify it fails** — `cargo test -p weftcut import_motif_from_source` → FAIL (undefined).

- [ ] **Step 3: Implement** (add to `authoring_commands.rs`; reuse the existing `parse_manifest_island`/`validate_manifest`/`assign_unique_id`/`compose_motif_html` imports):

```rust
/// Core of `import_motif`: parse + validate the manifest island from an external
/// `.html` source, mint a FRESH unique draft id (ignoring any id/version the file
/// claims — identity is app-owned), and write it as a from-scratch draft (no
/// target sidecar → it installs as a new Motif, never Update-over-something). No
/// `AppHandle` so it's unit-testable.
pub fn import_motif_from_source(store: &UserMotifStore, source: &str) -> Result<String, String> {
    let mut manifest = parse_manifest_island(source).map_err(|e| e.to_string())?;
    let taken: Vec<String> = store.published_ids().into_iter()
        .chain(store.list_draft_ids()).collect();
    let draft_id = assign_unique_id(&manifest.name, &taken);
    manifest.id = draft_id.clone();
    manifest.version = 1;
    validate_manifest(&manifest).map_err(|e| e.to_string())?;
    let html = compose_motif_html(&manifest, source);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    Ok(draft_id)
}

/// Import an external `.html` Motif file (picked via the OS dialog) as a draft.
/// Reads the user-chosen path directly (the user authorized it). Returns the new
/// draft id. Emits `motifs:changed`.
#[tauri::command]
pub async fn import_motif(
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    path: String,
) -> Result<String, String> {
    let source = std::fs::read_to_string(&path)
        .map_err(|e| format!("read '{path}': {e}"))?;
    let draft_id = import_motif_from_source(&store, &source)?;
    emit_motifs_changed(&app);
    Ok(draft_id)
}
```

- [ ] **Step 4: Register** — in `apps/desktop/src-tauri/src/lib.rs`, add `motifs::authoring_commands::import_motif` to `tauri::generate_handler!` (next to `create_edit_draft`).

- [ ] **Step 5: Run it to verify it passes** — `cargo test -p weftcut import_motif` then `cargo build -p weftcut` → PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(motifs): import_motif — import an external .html file as a draft"
```

---

### Task 2: `importMotif` IPC wrapper (TS)

**Files:** Modify `apps/desktop/src/ipc/index.ts`, test `apps/desktop/src/ipc/motifLifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("importMotif passes the path (camelCased top-level arg)", async () => {
  invoke.mockResolvedValue("imported-2");
  const id = await importMotif("C:/x/foo.html");
  expect(invoke).toHaveBeenCalledWith("import_motif", { path: "C:/x/foo.html" });
  expect(id).toBe("imported-2");
});
```

Add `importMotif` to the import.

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/ipc/motifLifecycle.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `ipc/index.ts`, near `createEditDraft`:

```ts
/// Import an external `.html` Motif file (an absolute path from the OS dialog) as
/// a draft. Returns the new draft id.
export async function importMotif(path: string): Promise<string> {
  return invoke<string>("import_motif", { path });
}
```

- [ ] **Step 4: Run it to verify it passes** — `npx vitest run src/ipc/motifLifecycle.test.ts` + `npx tsc -b` → PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/ipc/motifLifecycle.test.ts
git commit -m "feat(motifs): importMotif IPC wrapper"
```

---

### Task 3: Picker "Import" button (TS)

**Files:** Modify `apps/desktop/src/motifs/MotifPicker.tsx`, `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts`

- [ ] **Step 1: Add i18n keys** — `template_picker` block. en-US:

```ts
    import_button: "Import",
```
zh-CN:
```ts
    import_button: "导入",
```

- [ ] **Step 2: Implement the button** — in `MotifPicker.tsx`, add the dialog import at the top: `import { open as openDialog } from "@tauri-apps/plugin-dialog";` and `importMotif` to the `../ipc` import. Add a handler in the `MotifPicker` component body:

```tsx
  const importFile = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Motif HTML", extensions: ["html"] }],
      });
      if (typeof path !== "string") return; // cancelled
      const draftId = await importMotif(path);
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
    } catch (e) {
      setError(String(e));
    }
  };
```

Render an "Import" button next to the "New" button in the header (when the New inline form is NOT open — or always; place it adjacent to the `template-picker-new` button):

```tsx
          <button className="template-picker-new" onClick={importFile}>
            {t("template_picker.import_button")}
          </button>
```

(Place it just before or after the New button/form block in the `<header>`. Reuse the `template-picker-new` class for consistent styling, or add a sibling class if layout needs it.)

- [ ] **Step 3: Verify** — `npx tsc -b` + `npx vitest run` → clean + green (no new unit test; validated by the e2e — the OS dialog isn't unit-testable).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/motifs/MotifPicker.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(motifs): picker Import button (.html → draft via OS dialog)"
```

---

### Task 4: Inline confirm replacing both `window.confirm`s (TS)

**Files:** Modify `apps/desktop/src/properties/PropertyPanel.tsx`, `apps/desktop/src/i18n/locales/{en-US,zh-CN}.ts`

- [ ] **Step 1: Add i18n keys** — `property_panel` block. en-US:

```ts
    motif_confirm: "Confirm",
    motif_cancel: "Cancel",
```
zh-CN:
```ts
    motif_confirm: "确认",
    motif_cancel: "取消",
```

(`motif_delete_confirm` and `motif_update_confirm_one|many` already exist — reused as the inline prompt text.)

- [ ] **Step 2: Add a pending-confirm state to `MotifLifecycleRow`** — after the existing `busy`/`err` state:

```tsx
  // Inline confirm (replaces native window.confirm): a pending destructive action
  // + its prompt. While set, the row shows the prompt + Confirm/Cancel instead of
  // firing the action immediately.
  const [pending, setPending] = useState<{ message: string; action: () => Promise<unknown> } | null>(null);
```

- [ ] **Step 3: Route Delete + Update through `pending`** — replace the installed-Delete `onClick` (the `window.confirm` one) with:

```tsx
        onClick={() => setPending({
          message: t("property_panel.motif_delete_confirm", { id: motifId }),
          action: async () => { await deleteMotif(motifId); await onMutated(); },
        })}
```

and the Update `onClick` (the `window.confirm` one) with:

```tsx
        onClick={() => {
          const n = updateBlastRadius(target);
          const message = n === 1
            ? t("property_panel.motif_update_confirm_one")
            : t("property_panel.motif_update_confirm_many", { count: n });
          setPending({
            message,
            action: async () => { await installMotif(motifId, { kind: "update", target_id: target }); await onMutated(); },
          });
        }}
```

(Remove the `run(async () => { ... window.confirm ... })` wrappers from those two buttons — they now just set `pending`. Keep `run()` for the actual execution in Step 4.)

- [ ] **Step 4: Render the inline confirm prompt** — at the TOP of the row's returned JSX (so it shows above the action buttons for every status branch), short-circuit to the prompt when `pending` is set. The simplest robust shape: wrap the existing per-status returns so that when `pending != null`, the row renders the prompt instead. Add, right after the hooks + `if (!status) return null;`:

```tsx
  if (pending) {
    return (
      <div className="prop-motif-lifecycle">
        <p className="meta">{pending.message}</p>
        <button disabled={busy} onClick={run(async () => { await pending.action(); setPending(null); })}>
          {t("property_panel.motif_confirm")}
        </button>
        <button disabled={busy} onClick={() => setPending(null)}>
          {t("property_panel.motif_cancel")}
        </button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }
```

(This early-return is AFTER all hooks, so it's rules-of-hooks-safe. The `run()` helper sets `busy` + catches errors into `err`; on success it clears `pending`. If `pending.action` throws, `err` shows and `pending` stays so the user can retry or cancel — acceptable; or clear `pending` in a `finally` if preferred, but leaving it lets the error stay visible next to Confirm/Cancel.)

> Decision: on action error, keep the prompt open with the error shown (don't auto-dismiss) so the failure is visible. `setPending(null)` runs only after `pending.action()` resolves.

- [ ] **Step 5: Verify** — `npx tsc -b` + `npx vitest run` (full) → clean + green. Confirm via grep that NO `window.confirm` remains in `PropertyPanel.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/i18n/locales/en-US.ts apps/desktop/src/i18n/locales/zh-CN.ts
git commit -m "feat(motifs): inline confirm for Delete + Update (drop native window.confirm)"
```

---

### Task 5: Doc + real-WebView2 e2e + finish

**Files:** Modify `docs/motifs.md` (+ verification)

- [ ] **Step 1: Doc** — in `docs/motifs.md`, add one evergreen line to the "Editing an installed Motif" section (or near it): a Motif can also be **imported** from an external single-file `.html` (its manifest island parsed + validated at import) — it lands as a draft to preview and install. Commit:

```bash
git add docs/motifs.md
git commit -m "docs(motifs): import a Motif from a .html file"
```

- [ ] **Step 2: Real-WebView2 verification** (rebuild `tauri dev`; drive via tauri-mcp-server):
  1. Write a small valid composed `.html` to a temp path (via Rust/Node, or `webview_execute_js` calling a Tauri fs write to a temp file) with a manifest island + a solid-color body.
  2. **Import via IPC** (`import_motif` with that path — the OS file dialog itself isn't automatable; driving the command validates the parse→draft path) → confirm it returns a draft id, the draft lists with `status: "draft"`, no `target_id`, and renders (place it + sample the color).
  3. Confirm a `.html` with **no island** → `import_motif` returns an error (rejected at import).
  4. **Inline confirms:** place a Motif layer; select it; click **Delete** → confirm the row shows the inline prompt + Confirm/Cancel (NOT a native dialog) → Cancel leaves it; Confirm deletes. For an edit-draft with a target, click **Update** → inline blast-radius prompt → Confirm performs the update (now fully drivable — no native dialog). Screenshot the inline prompt.
  5. Clean up imported/placed test artifacts; confirm the catalog returns to its prior state.

  Record the outcome. Then run the **final whole-branch review** and **finishing-a-development-branch** (the user chooses merge/keep).

---

## Self-Review

**1. Spec coverage:** `.html` Import (single-file, island-required, fresh id, lands as a draft) → Tasks 1–3. Replace both native `window.confirm`s with inline confirm → Task 4. Doc + e2e → Task 5. Matches the locked 3b-3b scope. ✓

**2. Placeholder scan:** Concrete code throughout. The picker button placement says "place it adjacent to the New button" — that's a layout instruction, not a logic gap (the handler + JSX are given). ✓

**3. Type consistency:** `import_motif`(Rust) ↔ `importMotif`(TS) ↔ arg `path`. `import_motif_from_source` (pure) tested + called by the command. The inline-confirm `pending` shape `{ message, action }` is used consistently in Steps 2–4. `updateBlastRadius`/`run`/`onMutated`/`deleteMotif`/`installMotif` all already exist in the row (3b-3a). ✓

**4. Known soft spots for the implementer:**
- Task 3: match the existing `openDialog` filter shape (see `StartupScreen.tsx`/`App.tsx`); `open` returns `string | string[] | null` — guard `typeof path !== "string"`.
- Task 4: the `pending` early-return must sit AFTER all hooks (`useTranslation`/`useState`×N/`useSyncExternalStore`); confirm no hook is added below it.
- Task 5: the OS file dialog can't be driven by the harness — drive `import_motif` directly via IPC to validate the import path; the inline confirms ARE drivable (DOM buttons) — exercise them via the UI.
