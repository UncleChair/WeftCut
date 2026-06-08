# Motif upload & authoring — agent-authored, human-refined Motifs (Plan 4)

- **Status:** design approved 2026-06-08; spec under review before implementation planning.
- **Builds on:** `2026-06-07-motifs-webcap-design.md` (the webcap engine, §9 "security sandbox"
  is the deferred work this realizes) and `2026-06-07-motifs-editor-integration-design.md`
  (the live-preview + cache + picker surfaces this reuses). The Motifs migration is complete:
  two trusted built-ins (`countdown`, `lower-third`) render on the live `motif.define` contract
  via a single CDP capture path.
- **Goal:** let an **external MCP agent author** a Motif and a **human refine** it, then install it
  into the catalog where it behaves exactly like a built-in. This is the upload feature deferred
  from webcap-design §9 — it is fundamentally about **running untrusted Motif JS safely** plus the
  authoring loop that makes agent-authored Motifs usable.

## 1. The shape of the problem

This is not "upload a finished file." The real workflow is an **authoring loop**: an agent (over
MCP) writes the Motif source, the human previews it *in the real project* and tweaks it, the agent
or human iterates, and finally it is **installed** into the catalog. Two early instincts both fail:

- *Merge everything into one file* — simple to transport, but the metadata tangles into the markup
  and is awkward to validate.
- *Use a folder / zip* — structurally heavier to manage on disk and clumsy for an agent to emit.

The resolution is to **separate transport, storage, and validation** and to borrow three proven
patterns:

| Precedent | What we take |
|---|---|
| **Claude Artifacts / ChatGPT Canvas** | an agent authors a single self-contained HTML document; it renders live; agent + human co-edit; the agent *sees* its output and self-corrects |
| **Remotion Studio** | a composition is code, previewed by **seeking** (our exact determinism model), then rendered |
| **userscripts / MDX frontmatter** | a single file with a clearly-delimited **metadata island** that tooling parses *without executing* the body |

## 2. Content format

### On disk: one self-contained `.html` with a metadata island

A user Motif is a **single `.html` file**. Its manifest is a delimited JSON island the Rust side
parses statically (no JS execution):

```html
<script type="application/json" id="motif-manifest">
{ "name": "My Lower Third", "size": [1280, 320], "default_duration_s": 5,
  "content_duration_s": 0.8, "props_schema": { "title": { "type": "string", "default": "Hi" } } }
</script>
<script>
  motif.define({ setup(props, ctx) { /* … */ }, frame(t, ctx) { /* … */ } });
</script>
```

- The island is parsed by locating `<script type="application/json" id="motif-manifest">…</script>`
  and `serde_json`-parsing its contents into the existing `Manifest` type (`catalog.rs`).
- Images/fonts for the simple case are inlined as `data:` URIs (the CSP already allows
  `img-src data:` / `font-src data:`). A multi-file/asset format is **out of scope** (see §11).
- `id` and `version` are **not** authored in the island — they are assigned by the app at
  install/draft time (§4), so an author can't collide with a built-in or forge a version.

### Over MCP: two structured fields, not a pre-merged file

The agent never hand-merges a file. The MCP tools take **`manifest` (a JSON object) + `html` (a
string)** as separate arguments — each independently validatable. The app composes them into the
canonical single-file form on write (injecting/overwriting the manifest island). This kills both
the "merge is hard to validate" and "folder is hard to manage" concerns at once.

### Storage location

User Motifs live in **global app-data** (e.g. `<app_config_dir>/motifs/<id>/index.html`, drafts
under `<app_config_dir>/motifs/drafts/<draftId>/index.html`). Rationale: import once, reuse across
projects, matching built-in semantics; and a shared global store is what makes the cross-project
change signal (§6) meaningful. A project referencing a since-deleted Motif degrades to an error
placeholder, not a crash.

## 3. Why the loop is draft → preview → install

A draft is a **private editing buffer**; an installed Motif is the **published, catalog-visible,
placeable** entity. You never edit installed bytes in place while a project might be rendering from
them. The split (Figma plugin dev, VS Code extension dev, npm publish) is what makes "edit an
installed Motif" safe and obvious.

## 4. Lifecycle

### Identity

- A **draft** has its own id from birth. For a *new* Motif the draft id is the intended final id
  (status flips draft→published on install — **no id change, no rebind**, so a layer placed during
  drafting keeps working). For an *edit of an installed Motif* the draft gets a distinct working id
  (so the live published version and the work-in-progress can coexist and both be previewed).
- Ids are sanitized and namespaced to **never collide with built-ins** (`countdown`,
  `lower-third`) or with each other. Built-in ids are reserved.

### Three entry points

| Action | Effect |
|---|---|
| **New** | empty draft (carries its intended final id, status=draft) |
| **Edit installed `X`** | new draft seeded from `X`'s source, distinct working id, records target `X` |
| **Edit built-in** | forced **Duplicate to new** — built-ins live in the binary and can't be overwritten; forking is the recommended starting point |

### Install modes

- **Publish new** (default for a from-scratch draft): flip the draft's status to published under its
  id. Layers already referencing it continue unchanged.
- **Update in place** (edit-of-installed): copy the draft's `{manifest, html}` onto target `X`,
  **bump `X.version`** (busts the frame cache), keep the single stored source. Per the **live /
  mutable** decision, every layer using `X` — this project and others — re-renders with the new
  look. Then **rebind** any layers in the *current* project that referenced the draft's working id
  to `X`, and delete the draft. ("Save your old look" is served by Save-as-new, below.)
- **Save as new `Y`**: publish the draft under a fresh id `Y`; existing `X` layers are untouched;
  rebind current-project draft-id layers → `Y`.

### props_schema migration on update

If an Update changes `props_schema` (drops/renames/retypes a prop), existing layers' stored props
may no longer validate (today `canonicalize_props` *rejects* unknown keys). On update we apply a
**lenient migration**: drop keys no longer in the schema (with a warning), fill newly-required keys
from defaults — so an edit can't hard-break placed layers. Built-in placement stays strict; the
leniency applies to the migrate-on-update path.

## 5. Preview — into the real project canvas

Preview **reuses the existing timeline + compositor + CDP capture path**; there is no separate
preview engine and no separate Workshop window in v1. A draft is a placeable layer (referencing the
draft id), so the compositor renders it **into the live project preview canvas** alongside the real
footage — the user sees the Motif in true context (position, scale, what's under it), which is the
point: *so they can see whether the effect matches expectations.*

- The draft's frames are cached **by content hash** (manifest+html), so every source edit yields a
  new hash → a fresh capture → the preview updates. No version bump needed for a draft.
- Preview fidelity is the same CDP still-per-frame model the timeline already uses (cold ≈ 10 fps,
  warmed by L1 prewarm) — fine for authoring/scrubbing; not buttery realtime. This is an accepted,
  documented property of the engine, unchanged here.

## 6. Editing — both surfaces

Both write the **same draft `.html`** and stay in sync:

- **External editor + file watch.** An "Open in editor" action opens the draft file with the OS /
  configured editor. WeftCut watches the file; on save it recomputes the content hash, invalidates
  that draft's cached frames, and the preview re-renders (hot reload).
- **In-app simple source panel.** A plain editable text area in the property panel for the selected
  draft layer — **deliberately minimal: no rich code editor, no heavy lint UI**. "Apply" writes the
  draft file (same path as the watcher) → same re-render.

A file-system watch + an "apply from panel" both funnel through one "draft source changed" routine
so the two surfaces can't diverge.

## 7. Cross-project usage signal (A + B, no global index)

When the user is about to **Update in place**, they should understand the blast radius.

- **Current project — precise.** All layers are in actor state; scan `LayerParams::Motif` by
  `motif_id` → show count + locations, with timeline highlight. (Reuses the data already behind the
  `motifs://current` resource.) The Update dialog reads e.g. *"Used by N layers in this project.
  Updating changes all of them. [Update] [Save as new] [Cancel]."*
- **A — generic caveat.** The dialog also states that other projects using this Motif will pick up
  the new look the next time they open.
- **B — on-open staleness detection.** Update bumps `X.version`; each placed layer keeps the
  `motif_version` it was created with as a **"seen-at" marker** (it does **not** pin rendering —
  see §8). When a project opens, compare each Motif layer's `motif_version` to the current catalog
  version; a mismatch surfaces *"this Motif was changed since you placed it (v1 → v3)."* Each
  project self-reports on open — **no global reverse index** is built.

A full `motif_id → [project, layer]` index is explicitly **out of scope**.

## 8. Reconciling existing inconsistencies (load-bearing)

Three existing facts must be lined up for the above to hold; called out so the plan addresses them:

1. **Cache key must track *current installed content*, not the layer's stored version.** For
   live/mutable to mean "everywhere gets the new look," the render cache key must derive from the
   current installed source (content hash, or the freshly-bumped version) — never from the
   `motif_version` saved on the layer (which becomes only the §7-B seen-at marker). Today
   `catalog.rs` documents `content_hash()` as feeding the cache key while `docs/motifs.md` describes
   a `version`-keyed cache; reconcile to one source-derived key.
2. **The TS catalog must become runtime-extensible.** `catalog.ts` builds its catalog from a
   **build-time** `import.meta.glob("./builtin/*/manifest.json")`, so the TS frame-math
   (`getMotif`, `resolveMotifContentDurationUs`, `motifFrameDescriptor`) only knows built-ins. User
   Motifs must reach TS **at runtime**: built-ins (glob) **merged with** user manifests fetched via
   the `list_motifs` IPC. This is the dual-manifest gotcha generalized: the manifest island is the
   single source, surfaced to TS over IPC rather than re-globbed.
3. **The `motif:` scheme handler must serve from disk.** `builtin.rs` only serves files compiled in
   via `include_bytes!`. It must additionally resolve `http://motif.localhost/<id>/<rest>` against
   the on-disk user/draft store, **path-traversal-safe** (reject `..`, absolute, and symlink
   escapes; canonicalize and confirm the resolved path stays under the Motif's dir).

## 9. MCP surface

Props-only authoring stays the rule; these tools add *source* authoring for agents, mirroring the
human lifecycle. All return the existing `Result<CallToolResult, McpError>` shape (`mcp/mod.rs`
helpers).

| Tool | Args | Returns |
|---|---|---|
| `list_motifs` *(extend)* | — | catalog incl. user Motifs + a `status` (`builtin`/`installed`/`draft`) |
| `get_motif_source` | `id` | `{ manifest, html }` of any built-in/installed/draft Motif (read before editing) |
| `write_motif_draft` | `{ from?: id, manifest, html }` | draft id + validation warnings; `from` seeds from an existing Motif |
| `preview_motif_draft` | `{ id, t_sec, width?, height? }` | a PNG of that frame, so the agent can see and self-correct |
| `install_motif` | `{ draft_id, mode: "new" \| "update" }` | the published id |
| `delete_motif` | `id` | void (built-ins rejected) |

`add_motif` is unchanged and places drafts or published Motifs alike. `motifs://current` continues
to mirror `list_motifs`.

## 10. Security (the core of Plan 4)

Every Motif already runs in a **separate hidden WebView2** with **no Tauri API injected** and CSP
`default-src 'none'` (fully offline — no `connect-src`, so no fetch/XHR/WebSocket). That isolation —
built for the trusted built-ins — carries the untrusted case. Per webcap-design §9 we **add**:

- **Import-time validation.** Parse the manifest island; validate against `Manifest`/`PropSpec`
  (sane `size` bounds, well-formed `props_schema`, `default_duration_s > 0`, `content_duration_s`
  finite-and-positive when present); reject malformed input *at import*, not as a runtime crash.
- **Per-frame wall-clock timeout.** `motif_capture_frame` currently has a bounded *ready* probe but
  no cap on `eval_await(__motifRender)` — an infinite-loop draft can hang the host. Add a render
  timeout that fails the frame (and surfaces an error) instead of hanging the bake. This is the
  webcap-§9 "per-frame wall-clock limit."
- **Path-safe disk serving** (§8.3) and **id-namespace isolation** so an uploaded Motif can neither
  escape its directory nor shadow a built-in.
- **No new privilege.** We keep window-as-isolation (the offline WebView2); the heavier
  opaque-origin-iframe / separate-process options webcap-design weighed are **not** added — they buy
  little once the page is already offline with no app reach, and cost real plumbing.

Residual accepted risk: a renderer-level WebView2 exploit is out of our control (mitigated by the
isolated host profile and no Tauri bridge); a determinism-violating Motif (clock bypass) renders
wrong but harmlessly, surfaced by the existing perceptual-determinism story.

## 11. Boundaries / out of scope

- **In scope:** single-file format + manifest island; structured MCP transport; global-app-data
  storage; the draft→preview→install lifecycle (incl. edit-installed, built-in fork, update/new,
  rebind, props migration); preview reuse into the project canvas with content-hash caching;
  external-editor file-watch + a simple in-app source panel; cross-project A+B signal; the MCP tools;
  import validation + render timeout + path-safe disk serving; the three §8 reconciliations.
- **Out of scope:** a multi-file/asset (`files` map or zip) Motif format; a real enum `PropSpec`
  type; a rich in-app code editor / sophisticated determinism lint UI; a global `motif_id → usage`
  reverse index; version *pinning* / multi-version on-disk retention (we are live/mutable); a
  marketplace / remote registry; signing; audio (a Motif carries none).

## 12. Testing

- **Rust:** manifest-island extraction + validation (well-formed / malformed / missing island);
  path-traversal rejection in disk serving; id sanitization + built-in-collision rejection; render
  timeout fires on a deliberately-hanging draft; props lenient-migration drops-unknown/fills-default.
- **TS:** runtime catalog merges built-ins + user manifests; `getMotif`/`resolveMotifContentDurationUs`
  resolve a user Motif; content-hash cache key changes on source edit (hot reload); update-rebind
  swaps draft-id → target-id in the current project; on-open version-mismatch detection.
- **E2E (real WebView2):** author a draft via the MCP path → place it → preview it composited in the
  project canvas → edit the source (panel + file-watch) → see the preview change → install (new and
  update) → confirm placed layers behave per the live/mutable model and the staleness prompt fires.

## 13. Risks / open questions

- **File-watch on Windows/Tauri.** Confirm the watch primitive (e.g. `notify`) and debounce; ensure
  it doesn't fight the in-app panel's writes (single "source changed" funnel).
- **Render-timeout granularity.** A legitimately heavy WebGL Motif may need a higher budget than a
  CSS overlay; pick a default and allow the manifest's `settle_rafs` neighborhood to inform it
  without letting an author disable the cap.
- **Rebind scope.** Rebind on install touches only the *current* project (other projects can't be
  rewritten while closed); confirm that's the intended limit and that the §7-B signal covers the rest.
- **Draft id ↔ final id for "publish new."** Verify the status-flip keeps the id stable end-to-end so
  no rebind is needed on the common new-Motif path; only edit-installed paths rebind.
- **Manifest-island vs `motif.define` config.** We keep the island the single static source; confirm
  no built-in/authoring ergonomics push us toward also accepting config inside `motif.define`
  (rejected here because Rust would then have to execute the page to learn the manifest).
