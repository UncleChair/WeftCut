# Motif authoring contract

The rules a Motif document must satisfy to render correctly in WeftCut. This is
the authoritative authoring spec: the in-app source panel, external editors, and
MCP agents all write against it. It is self-contained on purpose — a copy ships
with the app to agent clients, where no other WeftCut document is reachable.

A Motif is a parameterized, time-varying overlay (a lower-third, a countdown, a
title card) authored as **a real web page**: one HTML document plus a JSON
manifest. Placed on the timeline, it is captured frame by frame by a harness
that owns the clock. Any HTML/CSS/SVG/canvas/WebGL and any animation idiom
(CSS, WAAPI, GSAP-style tweens, rAF loops) work, subject to the one law below.

## The one law

> Any visible state MUST be computable **from `t` alone** — via declared
> animations or `frame(t)` — never via mutation that accumulates over time.

The harness drives the page to arbitrary times in arbitrary order (scrubbing,
re-export, cache fills). A document that accumulates state renders wrong the
first time it is seeked backwards.

```js
setInterval(() => { n++; label.textContent = n; }, 1000);   // ✗ stubbed, not seekable
frame(t) { label.textContent = Math.floor(t); }             // ✓ closed-form in t
```

| Forbidden pattern | Why | Write instead |
|---|---|---|
| `setInterval` / self-advancing rAF accumulating state | stubbed, not seekable | closed-form in `frame(t)` |
| `fetch()` for data, fonts, images | the document is fully offline | embed as `data:` URI |
| reading `Date.now()` for motion | returns virtual time | use `t` |
| unseeded physics / particle integration | depends on the prior frame | closed-form `f(t)` or seeded `ctx.random()` |
| global state accreted across instances | leaks after a prop-change rebuild | keep `setup` self-contained |

## Lifecycle: `motif.define`

The harness injects a global `motif` (and the clock takeover) before any author
code runs. The document MUST declare its lifecycle with exactly one call:

```js
motif.define({
  // Runs once per distinct props value. Build the scene, declare animations,
  // load and await assets.
  async setup(props, ctx) { /* ... */ },
  // OPTIONAL: only when content must read the clock (e.g. a countdown number).
  frame(t, ctx) { /* ... */ },
});
```

- **`setup(props, ctx)`** — async; runs once per distinct props value, and
  re-runs whenever a prop changes. It MUST be self-contained: rebuild the DOM
  it owns, declare animations fresh, and `await` every asset (fonts included —
  see below) before resolving. No state may survive from a previous run.
- **`frame(t, ctx)`** — optional; called at every seeked time. `t` is content
  time in **seconds**. Pure-declarative Motifs omit it.
- **`ctx`** = `{ duration, width, height, fps, frame, random() }` — `duration`
  in seconds, `ctx.frame` the integer frame index, `ctx.random()` a seeded
  deterministic generator.

Declared animations are seeked by pausing and setting `currentTime`; they are
never cancelled or committed. So animations MUST stay alive and well-defined at
every `t`: use `fill: "both"` (or equivalent), and never remove a finished
animation — deleting it breaks seeking back to earlier times.

## The manifest

```json
{
  "name": "Lower Third",
  "size": [1280, 320],
  "default_duration_s": 5.0,
  "content_duration_s": 0.8,
  "settle_rafs": 1,
  "props_schema": {
    "title":  { "type": "string", "default": "Jane Doe", "max_length": 40 },
    "accent": { "type": "color",  "default": "#ff4d4d" }
  }
}
```

- **`id` / `version`** — app-assigned; anything the document claims is ignored,
  and a minted id can never shadow a built-in.
- **`name`** — the display name.
- **`size`** `[w, h]` — the natural authoring size in CSS px, top-left origin.
  Lay out within it and write no resolution/DPR code: capture resolution,
  placement transform, and layer opacity are all applied by the host.
- **`default_duration_s`** — the initial placed-layer length. MUST be finite
  and positive (as must every duration field).
- **`settle_rafs`** — real browser frames the harness waits after a seek before
  capturing; clamped to `{0, 1, 2}`, default `2`. CSS/DOM-only Motifs MAY set
  `1`; canvas/WebGL Motifs SHOULD keep `2`.
- **`fonts`** — declares bundled font files; meaningful only for Motifs
  installed as a directory with an `assets/` folder (built-ins). A single-file
  Motif embeds fonts as `data:` URIs instead.

### Duration: three shapes

A layer is a *window* into the Motif's content, the way a video clip windows
its media. The manifest picks one of three content-duration shapes:

| Manifest declares | Content duration | The placed layer | For |
|---|---|---|---|
| `max_duration_prop` (names a `number` prop) and/or `max_duration_s` | the prop's live value, else the static cap | **capped** to that length; windowable | bounded clips — a countdown |
| `content_duration_s` | that fixed value | **freely extendable**; frames past the end hold the last content frame | animate-in-then-hold overlays — a lower-third |
| none of the above | the layer's own width | extendable; animates over the placed duration | unbounded overlays |

The load-bearing distinction: `max_duration_s` also caps the layer;
`content_duration_s` does not. A holdable overlay SHOULD declare
`content_duration_s` (the length of its in-animation): the held tail costs one
capture, and trimming the layer never invalidates cached frames.

### `props_schema`

Exactly four variants exist — this vocabulary is frozen. Each prop MUST carry a
`default` that satisfies its own constraints.

| Variant | Constraints |
|---|---|
| `string` | optional `max_length` (counted in Unicode scalar values); optional `multiline` (renders a textarea) |
| `color` | hex string: `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` |
| `number` | optional `min` / `max`, both **inclusive**; values must be finite |
| `enum` | `options`: the exhaustive string list; `default` must be one of them |

Validation is strict on keys and lenient on recovery: unknown prop keys reject,
missing keys fall back to defaults, and values are canonicalized into a stable
key order so identical inputs produce identical bytes and identical cache keys.
The schema carries **data only** — no labels, order hints, grouping, or widget
hints. The host generates the editing form from it: one row per prop in the
manifest's authored key order, keys title-cased (`bg_color` → "Bg Color"),
widget switched on the variant. Design prop keys to read well through that
transform.

## Runtime environment

The document renders in an offline, isolated capture host. Hard limits:

- **One self-contained file.** The render document allows inline `<script>` and
  `<style>` only — no external `.js`/`.css` files. Images and fonts load from
  `data:` URIs (or from the Motif's own directory, for directory-installed
  Motifs).
- **No network.** No fetch, XHR, WebSocket, or any external URL. Everything the
  document needs is embedded in it.
- **The clock is virtual.** `Date.now`, `performance.now`, `setTimeout`,
  `setInterval`, and `requestAnimationFrame` are all owned by the harness. Do
  not capture references to time sources before `motif.define` runs.
- **Transparency is real.** The capture preserves alpha: keep
  `html, body { background: transparent }` unless the Motif is deliberately
  opaque.
- **Frames time out.** Each capture has a wall-clock cap; an infinite loop or a
  never-resolving `setup` fails the frame instead of hanging the app.

### Fonts

`await document.fonts.ready` is NOT sufficient — it can resolve before a lazy
`@font-face` fetch even starts, letting the first capture paint a fallback
font. A font-using Motif MUST force each face it renders, per weight and size,
before `setup` resolves:

```js
await document.fonts.load('700 56px "Inter"');
```

Embedded `data:` fonts are the deterministic choice; `system-ui` stacks render
differently across machines.

## Parameter UI

The host-generated form described above is the normal path — a Motif is fully
editable with zero UI effort. A Motif MAY instead ship a `params.html` beside
its `index.html` to own its whole parameter panel; presence of the file is the
only switch. That page is a separate, sandboxed document with its own protocol,
and it cannot be supplied through the MCP draft surface — drafts always get the
generated form.

## Authoring over MCP

The MCP tools (`list_motifs`, `get_motif_source`, `write_motif_draft`,
`preview_motif_draft`, `install_motif`, `delete_motif`) carry their own
per-tool contracts; the document-level facts that matter when writing:

- `write_motif_draft` takes `{ manifest, html }` with the html **not**
  containing a manifest island — the app strips any present and injects the
  canonical one (`<script type="application/json" id="motif-manifest">`).
- The manifest is validated at write time (sane `size`, finite positive
  durations, well-formed `props_schema`) — a bad manifest rejects the write
  rather than failing at render.
- A draft renders through the exact same capture path as an installed Motif,
  and every source rewrite re-captures automatically.
- Base a new Motif on the closest existing one: read its source with
  `get_motif_source` and keep what already satisfies this contract.
