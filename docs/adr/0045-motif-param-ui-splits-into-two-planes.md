---
status: accepted
---

# A Motif's parameter surface splits in two: the schema is the data plane, the Motif owns the UI plane

## Context

A Motif's parameter panel was generated entirely by the host from the manifest's
`props_schema` — a four-variant vocabulary (`string` / `color` / `number` /
`enum`) rendered through one uniform switch. That vocabulary was simultaneously
the persistence contract, the agent-drafting contract, and the whole UI budget,
and the three jobs pull in different directions.

**Every control the vocabulary lacked was a wire-contract change.** A slider, a
boolean, a section header — each one meant touching the shared catalog, the
hand-copied `PropSpec` twin in `renderer/ipc/index.ts`, the behaviour golden
fixture, the MCP tool descriptions, and the form generator. The cost of one
control was the cost of a schema migration, paid in five places.

**Label localization never worked, and central registration could not fix it.**
The panel looked up `property_panel.props.${key}` — a namespace already occupied
by the section title `props: "Props"` — so every label had always fallen back to
the bare prop key, enum options rendered untranslated, and the picker never
called `t()` at all. A registry is no answer either: user- and agent-authored
Motifs are arbitrary on-disk documents whose prop keys the host cannot enumerate
in advance.

**The form was one flat list.** The generator walked the schema top to bottom —
text-fx's 13 props as thirteen undifferentiated rows — and nothing in the
manifest could express grouping, a section, or a row that only matters when
another prop holds a particular value (`type_speed` renders whether or not the
effect is the typewriter).

Meanwhile a Motif is *already* an external document the app runs: a manifest
island plus `index.html`, served over the `motif:` scheme into a CSP-locked
offscreen window (ADR 0017), authored by users and by agents and meant to stay
shareable as a file copy. A host-side control vocabulary that must grow to meet
every author's UI need is the wrong shape for that goal — it makes every
author's idea wait for a host release.

## Decision

### The schema is the data plane, frozen at four variants

`props_schema` keeps every non-UI job it already had and gains no new ones:
strict validation at the add/import gate, defaults, lenient canonicalization
(unknown keys dropped, invalid values degraded to their spec default) on the
render path and across an in-place Motif update, persistence, the key-wise
`update_layer_params` merge that undo rides, layer-length resolution through
`max_duration_prop`, and the MCP drafting contract. `PropSpec` gains no fifth
variant, and no variant gains a presentation field — no label, description,
ordering, grouping, or widget hint. The IPC twin, the golden fixture and the MCP
tool descriptions are therefore write-once artifacts from here on.

### The UI plane belongs to the Motif, as a page

A Motif that wants a better panel ships a `params.html` beside its
`index.html`, and that page owns the Motif's whole props surface: labels,
order, grouping, conditional rows, and whatever controls the author can write.

**Enablement is file presence.** `has_params_ui` is a catalog *payload
decoration*, not a manifest field: the main process stats the file (built-ins
once at boot, since built-in assets are packaged read-only; user Motifs on every
`list_motifs`, published copy then draft, so the existing directory watcher is
all it takes for a hand-authored page to appear or vanish). It is deliberately
absent from the manifest island, from the content hash, and from
`validateManifest`. There is nothing to set, nothing to migrate, and no way for
a manifest to claim a page it does not have.

**Five verbs, and nothing the page says is believed.** Host → page:
`motif:init` (`motifId`, `layerId`, canonical props, schema, locale, theme
tokens) once per loaded document, and `motif:propsChanged` when the layer's
props change from outside the page. Page → host: `motif:preview`,
`motif:commit`, `motif:resize`. The frame carries `sandbox="allow-scripts"` and
**no** `allow-same-origin`, so the page's origin is opaque and `event.origin` is
useless — the sender is authenticated by window identity instead, every payload
is shape-checked before a field is read, keys outside the schema are dropped,
and surviving values are lenient-canonicalized against the *current* manifest. A
broken or hostile page produces a wrong-looking value, never a crash and never
an invalid project.

**Two write lanes, strictly separated.** `motif:preview` goes into a per-layer
overlay store — no command, no history entry, no project mutation — merged at
the frame descriptor's canonicalization choke point so the pending props reach
both the rasterized frame and its cache key, and folded into a
leading-plus-trailing 250 ms throttle because the capture behind them is
~80–100 ms and serialized. Only the on-screen sprite opts in: the prewarmer,
the disk baker, the baked-key GC, bake status and the export bake all read
committed props, so a live gesture can never write a transient frame to disk or
move a progress bar. `motif:commit` is one `update_layer_params` carrying the
*whole* patch, so a page landing several coupled keys leaves exactly one undo
entry; the overlay's keys are dropped only once that mutation settles, and the
page's own commit is suppressed on the way back so a page repaints
optimistically instead of flickering through a round-trip.

**`motif:resize` is advisory.** The page declares its height in px; the host
clamps to `[80, 1200]` and sits at 240 until it hears otherwise, so a page can
neither collapse to an invisible strip nor take the panel column hostage.

### Theme and locale ride `init`; the host registers no Motif strings

`init` carries the active locale and a curated list of the app's CSS
custom-property tokens (ADR 0018's shadcn base plus the semantic polish layer)
so a page can read as part of the panel rather than as a foreign form. Whether a
page localizes itself is the author's business. The host never registers a
Motif's strings again — which is exactly why the fallback form's labels are
legitimized as bare keys rather than left pretending to be localizable.

### The params CSP differs from the render CSP by exactly two sources

A params page is served with `script-src` and `style-src` additionally allowing
the `motif:` scheme, so a page may split into companion `.js`/`.css` files
beside it — a render document is one self-contained file by construction, a
parameter UI is not. Everything else is identical to the render CSP, including
`default-src 'none'` and therefore no `connect-src`: the page cannot reach the
network. `'self'` appears nowhere, because on an opaque origin it would match
nothing. The renderer's own CSP grants `frame-src motif:` and nothing else, so a
Motif's parameter page is the single embeddable context in the app.

### Focus needs no new machinery

The iframe is an ordinary focusable element inside the attribute panel's focus
region (ADR 0041). Key events inside the page do not cross the document
boundary, so the page keeps its own keys for free, and the host adds neither a
trap nor an escape hatch.

### The fallback form survives, frozen

A Motif without a `params.html` — an agent draft, a quick experiment, countdown,
lower-third — still gets a working form for free, from one shared generator that
serves both the property panel and the picker. Its labels are the bare prop keys
with a cosmetic snake_case → Title Case pass, deliberately unlocalized. It
renders all four variants and nothing more, forever.

## Alternatives considered and rejected

**Grow the vocabulary** (slider, boolean, label, description, order, group).
Rejected outright, and it is the alternative the rest of the decision exists to
replace. Every control would be a wire-contract migration across the shared
catalog, the IPC twin, the golden fixture, the MCP tool descriptions and the
form generator; and even a much larger vocabulary would still not express
conditional rows, or localize labels for prop keys the host cannot enumerate.
The UI plane is the pressure valve that lets the data plane stop growing.

**Host-side component injection** — a Motif exporting JS that the host mounts as
a renderer component. Rejected: it runs untrusted author code inside the trusted
shell, inverting ADR 0017's trust model, and it forecloses third-party sharing,
because installing someone's Motif would mean granting their code the app's DOM.
The sandboxed page gives the same authoring freedom while asking nothing new of
anyone's trust.

**On-canvas / in-preview parameter handles.** A different effort of a different
magnitude: it addresses direct manipulation of spatial props, not the label,
order and vocabulary problem, and every Motif prop that is not spatial still
needs a panel. Not rejected as an idea — out of scope for this decision.

**A manifest flag to enable the page.** Rejected: the file on disk is already
the truth, so a flag adds a migration, a second thing to keep in sync, and a new
failure mode (a manifest that claims a page it lacks). Presence costs one `stat`
per catalog listing and hot-reloads through the watcher that already exists.

**Preview through the state actor** (one command per drag frame, undone later).
Rejected: it floods history with entries the user never asked for and pushes
recaptures into a serialized ~80–100 ms pipeline. Keeping the gesture out of
project state is what makes "a preview leaves no undo entry" structural rather
than a cleanup step.

**`allow-same-origin` on the frame**, to let the page use storage and simplify
messaging. Rejected: it would hand author code the app's DOM and its privileged
schemes — and the opaque origin is precisely why the seam can treat window
identity as authentication.

## Consequences

- **Two paths must keep working forever.** The protocol and the fallback form
  are both supported surfaces. countdown and lower-third deliberately stay on
  the fallback so it stays exercised rather than quietly rotting behind
  text-fx's page.
- **Pages self-localize or stay monolingual.** The host hands over the locale and
  takes no further responsibility — an accepted authoring cost, and still better
  than the previous state, where no prop label was localizable at all.
- **The theme token list is now a page-facing contract.** It is curated rather
  than a dump of every custom property precisely so it can stay stable: renaming
  a token in it would silently unstyle author pages, so the list changes like a
  wire contract, not like CSS.
- **The opaque origin constrains authoring, permanently.** `localStorage`,
  `sessionStorage`, `document.cookie` and `indexedDB` *throw* on access; there is
  no network; `event.origin` reads `"null"`; assets must be relative `motif:`
  URLs or `data:` URIs. A page's only state is what it received at `init` plus
  what it puts back through a commit.
- **A page can only ever land values the schema already allows** — the point of
  the schema-key filter and the lenient canonicalize. A sloppy page watches its
  values snap back rather than corrupting a project.
- **The preview lane is invisible on purpose, and that has an edge.** The
  prewarmer keeps warming committed props during a gesture, so a long drag paints
  from freshly captured frames while the warm set still describes the pre-gesture
  value.
- **Multi-key atomicity exists only in the UI plane.** The fallback form commits
  one key per gesture and always will, so two Motifs can differ in undo
  granularity — accepted, and the reason a Motif with coupled props is a
  candidate for its own page.
- **No schema, project-file or persistence change.** Props remain the same
  `Record<string, unknown>`; old projects open unchanged; `write_motif_draft` and
  the whole agent surface are untouched, and an agent's draft gets the fallback
  form without shipping UI code.

## Where this lives

- The seam — `src/renderer/properties/motifParamsHost.ts`: the verbs,
  window-identity authentication, shape checks, sanitization, the preview
  throttle, the commit and echo rules, the height clamp, the theme-token list.
  Deliberately iframe-agnostic, so tests hand it message events directly.
- The surface — `properties/MotifParamsFrame.tsx` (the sandboxed frame and its
  watcher-driven reload), `properties/PropertyPanel.tsx` (the page-or-fallback
  branch), `properties/MotifPropFields.tsx` (the one fallback generator, shared
  with `motifs/MotifPicker.tsx`).
- The preview lane — `render/motifs/previewOverlay.ts`, merged inside
  `render/motifs/motifFrameDescriptor.ts`, with `render/PixiPreview.tsx`
  subscribing to recomposite (no `summary` moves, so nothing else would).
- The sandbox and the presence flag — `main/motif/protocol.ts` (`MOTIF_CSP` vs
  `MOTIF_PARAMS_CSP`), `electron.vite.config.ts` (`frame-src motif:`),
  `main/motif/authoring.ts` + `store.ts` (the stat, the payload decoration),
  `shared/motifs/catalog.ts` (`PARAMS_PAGE_FILE`, the frozen `PropSpec`).
- The reference page — `shared/motifs/builtin/text-fx/params.html`.
- Gates — `properties/motifParamsHost.test.ts` (every verb, plus hostile and
  malformed traffic), `properties/MotifFields.test.tsx` (the fallback form and
  the page branch), `render/motifs/motifFrameDescriptor.test.ts` (the overlay
  reaches the cache key, and only the named layer),
  `e2e/electron/motif-params-page.spec.ts`.
- The living descriptions are [`docs/motifs.md`](../motifs.md) and
  [`docs/security.md`](../security.md).

## Industry baseline

- **Audio plugins (VST/AU).** The host owns the parameter model — ranges,
  defaults, automation, save state — and the plugin ships its own editor GUI
  against it, communicating through a narrow set of gestures (begin / change /
  end) rather than through host widgets. This decision is that split, with
  `preview`/`commit` as the gesture pair.
- **Figma plugins.** Plugin UI is an author-written HTML document in a sandboxed
  iframe on an opaque origin, talking to the host only over `postMessage`. The
  same reasoning about why the host cannot supply the widgets — and why the page
  must not reach the host's DOM — applies unchanged.
- **After Effects effect parameters** are the counter-example: a host-generated
  panel from a fixed parameter-type list. It is workable because the parameter
  types ship with the host on the host's release cadence, which is exactly the
  property WeftCut's user- and agent-authored Motifs do not have.
