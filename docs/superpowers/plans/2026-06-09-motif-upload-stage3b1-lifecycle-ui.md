# Motif Upload — Stage 3b-1: Lifecycle UI + catalog resync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the user-Motif lifecycle in the UI — create a draft, see drafts in the picker (status-badged), install (publish) and delete from the property panel — with the runtime catalog auto-resyncing after every lifecycle mutation so a placed draft keeps rendering.

**Architecture:** Thin TS IPC wrappers over the Stage-2/3a commands; a `motifs:changed` Tauri event emitted by the lifecycle commands and listened to in the React tree to re-pull `list_motifs` (→ `setUserMotifs`) and refresh the picker. The picker gains a "New" entry (name → starter template → `write_motif_draft`) and a per-card status badge; the property panel gains Install (publish-new) + Delete actions for a Motif layer. Builds on the 3a backbone (drafts render at a stable id).

**Tech Stack:** TypeScript/React (Vitest), `@tauri-apps/api/event` `listen`, Rust (Tauri 2.11 `Emitter`).

---

## Stage roadmap (this = Stage 3b-1)

Spec: `docs/superpowers/specs/2026-06-08-motif-upload-authoring-design.md` (§5/§6). Stages 1+2 merged to `main`; 3a (renderability backbone) on `feat/motif-upload-stage3`; this branch (`feat/motif-upload-stage3b`) builds on 3a.

| Stage | Scope | Status |
|---|---|---|
| 3a | Draft renderability backbone (Model B) | done (branch) |
| **3b-1 (this plan)** | Lifecycle UI: IPC wrappers + `motifs:changed` resync + picker New/drafts-badge + property-panel Install/Delete | this plan |
| 3b-2 | Live edit: in-app source panel + external-editor file-watch + hot-reload + `.html` Import | next |
| 4 | MCP tools (mirror Stage-2 commands) | — |
| 5 | Cross-project usage signal (A + B) | — |

**Scope decisions (flag for review):**
- **"New" uses a built-in starter template** (no native file dialog) — name → `write_motif_draft({manifest, html})`. **`.html` Import (needs the dialog plugin) is deferred to 3b-2** alongside the editor/file ops.
- **Lifecycle actions live in the property panel** of a placed Motif layer (Install when it references a draft; Delete for any user Motif). **Edit (open in the in-app panel / external editor) is 3b-2.** **Install-update** (overwrite an existing installed Motif) is 3b-2 (it pairs with Edit). 3b-1 ships **Install-new + Delete**.

---

## File Structure (Stage 3b-1)

- **Modify** `apps/desktop/src-tauri/src/motifs/authoring_commands.rs` — the four lifecycle commands take `app: AppHandle` and emit `motifs:changed` after a mutation.
- **Modify** `apps/desktop/src/ipc/index.ts` — add `MotifSource` type + `getMotifSource`/`writeMotifDraft`/`installMotif`/`deleteMotif` wrappers + a `MOTIFS_CHANGED_EVENT` const.
- **Create** `apps/desktop/src/render/motifs/starterTemplate.ts` — the `newDraftSource(name)` starter `{manifest, html}` for "New".
- **Modify** `apps/desktop/src/motifs/MotifPicker.tsx` — a "New" button (name → create draft), a per-card status badge, and re-fetch on `motifs:changed`.
- **Modify** `apps/desktop/src/properties/PropertyPanel.tsx` — the Motif section shows a status badge and Install-new / Delete buttons.
- **Modify** `apps/desktop/src/render/motifs/syncCatalog.ts` — export an `installMotifsChangedListener()` that resyncs the runtime catalog on the event.
- **Modify** `apps/desktop/src/main.tsx` — install the `motifs:changed` listener at boot.
- **Tests:** `starterTemplate.test.ts`; an `authoring_commands` Rust test that the emit is wired (smoke); UI exercised by the e2e (Task 6).

**Commands:** Rust `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <filter>`; TS from `apps/desktop` `npx vitest run <path>` / `npx tsc -b`.

---

### Task 1: Lifecycle commands emit `motifs:changed`

**Files:** Modify `apps/desktop/src-tauri/src/motifs/authoring_commands.rs`.

So the frontend can resync after a mutation. Tauri 2.11 emits app-wide events via the `Emitter` trait (`app.emit(event, payload)`).

- [ ] **Step 1: Add the import + emit helper.** At the top of `authoring_commands.rs`, add `use tauri::{AppHandle, Emitter, State};` (replace the existing `use tauri::State;`). Add a module const + helper:

```rust
/// App-wide event emitted whenever the user-Motif catalog changes (a draft is
/// written, installed, or deleted). The frontend listens and re-pulls
/// `list_motifs` → `setUserMotifs` so a placed draft keeps resolving + the
/// picker refreshes.
pub const MOTIFS_CHANGED_EVENT: &str = "motifs:changed";

fn emit_motifs_changed(app: &AppHandle) {
    // Best-effort: a failed emit shouldn't fail the lifecycle op (the next
    // boot/picker-open resync still recovers).
    let _ = app.emit(MOTIFS_CHANGED_EVENT, ());
}
```

- [ ] **Step 2: Add `app: AppHandle` to the three mutating commands and emit on success.** For `write_motif_draft`, `install_motif`, `delete_motif`: add `app: AppHandle,` as the first parameter (before `store: State<...>`), and emit `motifs:changed` just before returning `Ok`. (`get_motif_source` is read-only — no `app`, no emit.)

`write_motif_draft` — before `Ok(draft_id)`:
```rust
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    emit_motifs_changed(&app);
    Ok(draft_id)
```

`install_motif` — before `Ok(final_id)`:
```rust
    store.install_draft(&args.draft_id, &final_id).map_err(|e| e.to_string())?;
    emit_motifs_changed(&app);
    Ok(final_id)
```

`delete_motif` — change the body to emit on success:
```rust
pub async fn delete_motif(
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    id: String,
) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id.as_str()) {
        return Err(format!("cannot delete the built-in Motif '{id}'"));
    }
    store.delete_user_motif(&id).map_err(|e| e.to_string())?;
    emit_motifs_changed(&app);
    Ok(())
}
```

(The `lib.rs` `generate_handler!` entries need NO change — Tauri injects `AppHandle` automatically.)

- [ ] **Step 3: Add a smoke test** that the const is the agreed string (a cheap guard against a rename drifting from the frontend listener):

```rust
    #[test]
    fn motifs_changed_event_name_is_stable() {
        assert_eq!(super::MOTIFS_CHANGED_EVENT, "motifs:changed");
    }
```

- [ ] **Step 4: Build + test.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml motifs::authoring_commands` then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --no-run`
Expected: PASS; clean build (the `AppHandle`-first-param commands still register).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src-tauri/src/motifs/authoring_commands.rs
git commit -m "feat(motifs): lifecycle commands emit motifs:changed for catalog resync"
```

---

### Task 2: TS IPC wrappers + the resync listener

**Files:** Modify `apps/desktop/src/ipc/index.ts`, `apps/desktop/src/render/motifs/syncCatalog.ts`, `apps/desktop/src/main.tsx`.

- [ ] **Step 1: Add the IPC wrappers + event const** in `ipc/index.ts` (near `listMotifs`/`addMotif`):

```ts
/// The Tauri event name the backend emits after a user-Motif lifecycle mutation
/// (write/install/delete). Mirrors Rust `MOTIFS_CHANGED_EVENT`.
export const MOTIFS_CHANGED_EVENT = "motifs:changed";

export interface MotifSource {
  manifest: MotifManifest;
  html: string;
}

export async function getMotifSource(id: string): Promise<MotifSource> {
  return invoke<MotifSource>("get_motif_source", { id });
}

/// Write a draft from authored `{ manifest, html }`. Returns the assigned draft id.
export async function writeMotifDraft(
  manifest: MotifManifest,
  html: string,
): Promise<string> {
  return invoke<string>("write_motif_draft", { args: { manifest, html } });
}

/// Install a draft. `mode` is `{ kind: "new" }` or `{ kind: "update", target_id }`.
export async function installMotif(
  draftId: string,
  mode: { kind: "new" } | { kind: "update"; target_id: string },
): Promise<string> {
  return invoke<string>("install_motif", { args: { draft_id: draftId, mode } });
}

export async function deleteMotif(id: string): Promise<void> {
  await invoke("delete_motif", { id });
}
```

`MotifManifest` is exported from `../render/motifs/catalog` — add it to the existing imports at the top of `ipc/index.ts` if not present: `import type { MotifManifest } from "../render/motifs/catalog";`. (If `ipc/index.ts` must not import from `render/`, instead define `MotifSource`'s `manifest` as the existing `MotifSummary`-shaped type already in this file — use whichever import direction the repo already follows; check existing imports at the top of `ipc/index.ts`.)

- [ ] **Step 2: Add the resync listener** in `syncCatalog.ts`:

```ts
import { listen } from "@tauri-apps/api/event";
import { MOTIFS_CHANGED_EVENT } from "../../ipc";

/// Subscribe to backend `motifs:changed` events and re-pull the catalog so a
/// just-created/installed/deleted Motif is immediately resolvable by the
/// frame-math (and the picker, which also listens). Returns the unlisten fn.
export async function installMotifsChangedListener(): Promise<() => void> {
  return listen(MOTIFS_CHANGED_EVENT, () => {
    void syncUserMotifsFromBackend();
  });
}
```

- [ ] **Step 3: Install the listener at boot** in `main.tsx`, after the existing `void syncUserMotifsFromBackend();`:

```tsx
import { installMotifsChangedListener } from "./render/motifs/syncCatalog";
// …
// Keep the runtime Motif catalog fresh as drafts are written/installed/deleted.
void installMotifsChangedListener();
```

- [ ] **Step 4: Add a unit test** for the wrappers' shapes in a new `apps/desktop/src/ipc/motifLifecycle.test.ts` (mock `@tauri-apps/api/core`):

```ts
import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { installMotif, deleteMotif, writeMotifDraft } from "./index";

describe("motif lifecycle IPC wrappers", () => {
  it("installMotif sends the snake_case nested args Tauri's serde expects", async () => {
    invoke.mockResolvedValue("foo");
    await installMotif("d1", { kind: "update", target_id: "foo" });
    expect(invoke).toHaveBeenCalledWith("install_motif", {
      args: { draft_id: "d1", mode: { kind: "update", target_id: "foo" } },
    });
  });
  it("writeMotifDraft wraps {manifest, html} under args", async () => {
    invoke.mockResolvedValue("d1");
    const manifest = { id: "x", name: "X", version: 1, size: [1, 1], default_duration_s: 1, props_schema: {} };
    await writeMotifDraft(manifest as never, "<html></html>");
    expect(invoke).toHaveBeenCalledWith("write_motif_draft", { args: { manifest, html: "<html></html>" } });
  });
  it("deleteMotif passes a bare id", async () => {
    invoke.mockResolvedValue(undefined);
    await deleteMotif("foo");
    expect(invoke).toHaveBeenCalledWith("delete_motif", { id: "foo" });
  });
});
```

- [ ] **Step 5: Run + typecheck.**

Run (from `apps/desktop`): `npx vitest run src/ipc/motifLifecycle.test.ts` then `npx tsc -b`
Expected: PASS; clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/render/motifs/syncCatalog.ts apps/desktop/src/main.tsx apps/desktop/src/ipc/motifLifecycle.test.ts
git commit -m "feat(motifs): lifecycle IPC wrappers + motifs:changed catalog-resync listener"
```

---

### Task 3: Starter template for "New"

**Files:** Create `apps/desktop/src/render/motifs/starterTemplate.ts`; Test `starterTemplate.test.ts`.

- [ ] **Step 1: Write the failing test** `apps/desktop/src/render/motifs/starterTemplate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { newDraftSource } from "./starterTemplate";

describe("newDraftSource", () => {
  it("produces a valid manifest + a motif.define HTML carrying the given name", () => {
    const { manifest, html } = newDraftSource("My Overlay");
    expect(manifest.name).toBe("My Overlay");
    expect(manifest.size).toHaveLength(2);
    expect(manifest.default_duration_s).toBeGreaterThan(0);
    expect(typeof manifest.props_schema).toBe("object");
    expect(html).toContain("motif.define");
    // No leftover manifest island in the authored html — the backend injects it.
    expect(html).not.toContain('id="motif-manifest"');
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/starterTemplate.test.ts`
Expected: FAIL — cannot resolve `./starterTemplate`.

- [ ] **Step 3: Implement `starterTemplate.ts`:**

```ts
import type { MotifManifest } from "./catalog";

/// The `{ manifest, html }` for a brand-new draft created from the picker's
/// "New" action. A minimal, valid, animate-in title overlay the user then
/// edits (Stage 3b-2). `id`/`version` are placeholders — the backend assigns
/// the final-ready id and version on write/install. No manifest island in the
/// html (the backend injects the canonical one via `compose_motif_html`).
export function newDraftSource(name: string): { manifest: MotifManifest; html: string } {
  const manifest: MotifManifest = {
    id: "draft",
    name,
    version: 1,
    size: [1280, 320],
    default_duration_s: 5,
    content_duration_s: 0.6,
    settle_rafs: 1,
    props_schema: {
      title: { type: "string", default: name, max_length: 60 },
      accent: { type: "color", default: "#2266ff" },
    },
  };
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
    "  html,body{margin:0;background:transparent}",
    "  .bar{position:absolute;left:48px;bottom:48px;padding:18px 28px;border-radius:12px;",
    "       background:var(--accent,#2266ff);color:#fff;font:700 56px/1 system-ui,sans-serif}",
    "</style></head><body>",
    "  <div class=\"bar\" id=\"bar\">Title</div>",
    "  <script>",
    "    motif.define({",
    "      setup(props){",
    "        const bar=document.getElementById('bar');",
    "        bar.style.setProperty('--accent', props.accent);",
    "        bar.textContent=props.title;",
    "        bar.animate([{opacity:0,transform:'translateY(24px)'},{opacity:1,transform:'translateY(0)'}],",
    "          {duration:600,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});",
    "      },",
    "    });",
    "  </script>",
    "</body></html>",
  ].join("\n");
  return { manifest, html };
}
```

- [ ] **Step 4: Run to verify pass.**

Run (from `apps/desktop`): `npx vitest run src/render/motifs/starterTemplate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/render/motifs/starterTemplate.ts apps/desktop/src/render/motifs/starterTemplate.test.ts
git commit -m "feat(motifs): newDraftSource starter template for the picker New action"
```

---

### Task 4: Picker — "New" action, status badge, resync re-fetch

**Files:** Modify `apps/desktop/src/motifs/MotifPicker.tsx`.

- [ ] **Step 1: Re-fetch the picker list on `motifs:changed`.** The picker's `useEffect` currently calls `listMotifs()` once on mount (`MotifPicker.tsx:46-60`). Factor the fetch into a callback and also subscribe to the event. Replace that effect with:

```tsx
  const reload = () => {
    listMotifs().then(
      (list) => {
        setTemplates(list);
        setUserMotifs(list as MotifManifest[]);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      },
      (e) => setError(String(e)),
    );
  };
  useEffect(() => {
    reload();
    let un: (() => void) | undefined;
    void listen(MOTIFS_CHANGED_EVENT, reload).then((u) => { un = u; });
    return () => { un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

Add imports at the top of `MotifPicker.tsx`: `import { listen } from "@tauri-apps/api/event";` and add `MOTIFS_CHANGED_EVENT` to the existing `../ipc` import. (`setUserMotifs`/`MotifManifest` are already imported from `../render/motifs/catalog` per Stage 1.)

- [ ] **Step 2: Add a "New" control** in the picker header. After the heading/close button row (around `MotifPicker.tsx:84`), add a New button that prompts for a name, writes a draft, and selects it:

```tsx
        <button
          className="template-picker-new"
          onClick={async () => {
            const name = window.prompt(t("template_picker.new_prompt"), "My Motif");
            if (name == null || name.trim() === "") return;
            try {
              const { manifest, html } = newDraftSource(name.trim());
              const draftId = await writeMotifDraft(manifest, html);
              // motifs:changed will reload(); select the new draft once present.
              setSelectedId(draftId);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {t("template_picker.new_button")}
        </button>
```

Add imports: `writeMotifDraft` from `../ipc`, `newDraftSource` from `../render/motifs/starterTemplate`.

- [ ] **Step 2b: Add the i18n keys.** In `apps/desktop/src/i18n` locale files (en-US and zh-CN — find the `template_picker` block), add:
  - en-US: `"new_button": "New Motif"`, `"new_prompt": "Name your Motif"`, and a `status` block `"status": { "draft": "Draft", "installed": "Installed", "builtin": "Built-in" }`.
  - zh-CN: `"new_button": "新建 Motif"`, `"new_prompt": "给 Motif 命名"`, `"status": { "draft": "草稿", "installed": "已安装", "builtin": "内置" }`.

- [ ] **Step 3: Add a status badge to each card.** In the card button (`MotifPicker.tsx:104-110`, the `<MotifCardThumbnail>` + name/meta block), add a badge driven by `tpl.status` (default "builtin" when absent):

```tsx
                  <span className={`template-card-status status-${tpl.status ?? "builtin"}`}>
                    {t(`template_picker.status.${tpl.status ?? "builtin"}`)}
                  </span>
```

- [ ] **Step 4: Add minimal CSS** in `apps/desktop/src/styles.css` (find the `.template-card` rules) so the badge is visible:

```css
.template-card-status { font-size: 11px; padding: 1px 6px; border-radius: 6px; }
.template-card-status.status-draft { background: #b8860b; color: #fff; }
.template-card-status.status-installed { background: #2a6; color: #fff; }
.template-card-status.status-builtin { background: #444; color: #ccc; }
.template-picker-new { margin-left: auto; }
```

- [ ] **Step 5: Typecheck + run the picker's existing tests.**

Run (from `apps/desktop`): `npx tsc -b` then `npx vitest run src/render/motifs/`
Expected: clean; existing motif tests still green (the picker has no unit test; it's exercised in the e2e).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/motifs/MotifPicker.tsx apps/desktop/src/styles.css apps/desktop/src/i18n
git commit -m "feat(motifs): picker New action + status badges + motifs:changed re-fetch"
```

---

### Task 5: Property panel — Install / Delete for a Motif layer

**Files:** Modify `apps/desktop/src/properties/PropertyPanel.tsx`.

The Motif section (`MotifLayerFields`, ~`PropertyPanel.tsx:599`) renders transform/opacity/props for a placed Motif layer. Add a small lifecycle row driven by the layer's resolved Motif status.

- [ ] **Step 1: Resolve the layer's status + add the action row.** `MotifLayerFields` already does `const template = getMotif(v.motif_id);` (the catalog Motif). Read its `manifest.status`. After the `<BakeStatusLine .../>` line (`:638`), add:

```tsx
      <MotifLifecycleRow motifId={v.motif_id} status={template?.manifest.status} />
```

- [ ] **Step 2: Implement `MotifLifecycleRow`** (a new component in `PropertyPanel.tsx`, below `MotifLayerFields`):

```tsx
/// Install (publish a draft) / Delete a user Motif from the placed layer. Built-in
/// Motifs show nothing (no status badge, no actions). Install-update + Edit are
/// Stage 3b-2. The backend emits `motifs:changed`, which resyncs the catalog so the
/// layer keeps rendering (the id is stable across install — Model B).
function MotifLifecycleRow({
  motifId,
  status,
}: {
  motifId: string;
  status?: "builtin" | "installed" | "draft";
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!status || status === "builtin") return null;

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prop-motif-lifecycle">
      <span className={`template-card-status status-${status}`}>
        {t(`property_panel.motif_status.${status}`)}
      </span>
      {status === "draft" && (
        // Install-new keeps the id (Model B) → the placed layer needs no rebind.
        <button disabled={busy} onClick={run(() => installMotif(motifId, { kind: "new" }))}>
          {t("property_panel.motif_install")}
        </button>
      )}
      <button disabled={busy} onClick={run(() => deleteMotif(motifId))}>
        {t("property_panel.motif_delete")}
      </button>
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
```

Add imports to `PropertyPanel.tsx`: `installMotif, deleteMotif` from `../ipc`. (`useState`/`useTranslation` are already imported.)

- [ ] **Step 3: Add the i18n keys** (en-US + zh-CN, in the `property_panel` block):
  - en-US: `"motif_install": "Install"`, `"motif_delete": "Delete"`, `"motif_status": { "draft": "Draft", "installed": "Installed" }`.
  - zh-CN: `"motif_install": "安装"`, `"motif_delete": "删除"`, `"motif_status": { "draft": "草稿", "installed": "已安装" }`.

- [ ] **Step 4: Typecheck.**

Run (from `apps/desktop`): `npx tsc -b`
Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/properties/PropertyPanel.tsx apps/desktop/src/i18n
git commit -m "feat(motifs): property-panel Install (publish draft) + Delete for a Motif layer"
```

---

### Task 6: Gates + UI e2e (real WebView2)

- [ ] **Step 1: Full gates.**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → pass. From `apps/desktop`: `npx tsc -b` (clean) + `npx vitest run` (pass).

- [ ] **Step 2: Drive the UI** (rebuild `tauri dev` — backend `AppHandle`/emit changed). Via the tauri-mcp bridge:
  - Open the Motif picker (Insert → Motifs). Click **New Motif**, enter a name → a `Draft`-badged card appears (the `motifs:changed` re-fetch).
  - Select it → preview renders (3a serving). Insert it onto the timeline → it renders in the canvas; the property panel shows a `Draft` badge + **Install** / **Delete**.
  - Click **Install** → the layer keeps rendering (Model B stable id); reopening the picker shows the card now badged `Installed`.
  - Click **Delete** on an installed user Motif → it's gone from the picker; the placed layer renders the missing-Motif placeholder.
  - Confirm built-in cards show no lifecycle actions.

- [ ] **Step 3: Record the result.**

---

## Self-Review

**Spec coverage (3b-1 = lifecycle UI + resync, §5/§6 partial):**
- Catalog auto-resync after a mutation (so a placed draft keeps resolving) → Tasks 1 (`motifs:changed` emit) + 2 (listener → `syncUserMotifsFromBackend`).
- Create a draft from the UI → Tasks 3 (`newDraftSource`) + 4 (picker New).
- See drafts (status) → Task 4 (badge) + the 3a `list_motifs` status.
- Install (publish) + Delete from the UI → Task 5 (property-panel row).
- **Deferred to 3b-2 (explicit):** the in-app source panel + external-editor file-watch + hot-reload, `.html` Import (needs the dialog plugin), Edit-installed (seed a working draft), Install-**update** (pairs with Edit). 3b-1 is Install-**new** + Delete only.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 2 Step 1 flags a conditional (the `MotifManifest` import direction) the implementer resolves by checking existing `ipc/index.ts` imports — that's a concrete instruction, not a placeholder.

**Type/name consistency:** `MOTIFS_CHANGED_EVENT` is the same literal in Rust (Task 1) + TS (Task 2), guarded by the Rust stability test. `writeMotifDraft`/`installMotif`/`deleteMotif`/`getMotifSource` (Task 2) are consumed by the picker (Task 4) + property panel (Task 5). `newDraftSource` (Task 3) → picker (Task 4). The IPC arg shapes (`{ args: { draft_id, mode } }`, `{ id }`) match the Stage-2 command signatures verified in the Stage-2 IPC e2e. `status` union `"builtin"|"installed"|"draft"` matches the 3a `MotifSummary`/`MotifManifest` field.

**Note:** Install-new on a placed draft layer is safe with zero rebind because of Model B (3a): the draft's id is final-ready and `install_draft` keeps it, so `getMotif(motifId)` continues to resolve after the status flips (now from the published copy). The `motifs:changed` resync just updates the cached `status`/version.
