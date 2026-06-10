---
status: superseded
---

# Templates rasterize from SVG, not foreignObject HTML/CSS

> **Superseded.** Templates were rebuilt as **Motifs**: every Motif is a real
> HTML/CSS/JS page rendered in a hidden WebView2 window and captured taint-free
> via the DevTools Protocol (CDP screenshot), with determinism by clock
> takeover — the "OS-level offscreen-webview screenshot" alternative this ADR
> deferred. The SVG `render(t)` engine described below was deleted. The
> foreignObject-taint analysis remains the accurate record of why in-webview
> HTML rasterization is impossible. See [`docs/motifs.md`](../motifs.md).

Templates are authored as SVG documents — shapes, `<text>`, gradients, masks,
transforms — and animated by a synchronous `render(t)` that mutates SVG
attributes and text. Capture serializes the post-`render` SVG and rasterizes it
via `<img>` → `createImageBitmap`. Authoring in HTML/CSS and rasterizing through
an SVG `<foreignObject>` is rejected. The full render path was in
`templates.md` (deleted with the SVG engine; see
[`motifs.md`](../motifs.md)).

## Why

A template's pixels can only be produced where the web platform can turn markup
into a bitmap. There are two candidate paths, and only one yields a *usable*
bitmap in WebView2 (Chromium):

- **`<foreignObject>` taints the canvas, unconditionally.** An `<img>` whose SVG
  embeds a `<foreignObject>` produces a cross-origin-tainted result even when the
  content is fully inline, script-free, drawn in a system font, and served from a
  same-origin `blob:` (or `data:`) URL. A tainted result rejects every consumer:
  `getImageData`, `OffscreenCanvas.convertToBlob`, WebGL `texImage2D`, and WebGPU
  `copyExternalImageToTexture` all throw `SecurityError`. This is deliberate,
  long-standing Chromium behaviour — foreignObject can render visited-link
  styling and cross-origin content, so the surface is poisoned for read-back —
  and it is not configurable away.
- The taint breaks the approach in *both* directions at once: pixels cannot be
  read (so a frame cannot be baked or encoded) and the bitmap cannot be uploaded
  to the GPU compositor (so it cannot even be drawn). The renderer composites
  through WebGPU (`copyExternalImageToTexture`; see ADR 0004, ADR 0014), so a
  foreignObject raster cannot become a texture at all.
- **A plain SVG — no foreignObject — is clean on every one of those paths:**
  readable, encodable, and uploadable. It is therefore the only DOM-to-bitmap
  path that produces a bitmap the renderer can actually use.

`render(t)` runs inside a sandboxed iframe (`allow-scripts`, no
`allow-same-origin`) so template code is isolated from the app and Tauri; the
iframe serializes its own post-render SVG to a string and hands it out.
Rasterization uses an `<img>` element — `createImageBitmap` applied directly to
an SVG `Blob` fails ("source image could not be decoded"), so the `<img>`
indirection is required, not incidental.

## Consequences

- **Fonts are embedded, and injected at raster time.** An SVG loaded through
  `<img>` is an isolated document: it cannot see the host's `document.fonts`. Any
  non-system font must be present as a data-URL `@font-face` *inside* the SVG.
  Templates are stored font-free and the `@font-face` block is concatenated in at
  raster time — pixel-identical to declaring it up front — so the (tens-to-
  hundreds of KB) font is never duplicated per stored frame.
- **Export rasterizes on the main thread.** A Web Worker cannot decode SVG
  (`createImageBitmap` fails in worker scope); only raster formats decode there.
  The export Worker therefore cannot turn a template into a texture itself — the
  main thread (which has the DOM) rasterizes each template frame and hands the
  bitmap to the Worker. A welcome side effect: preview and export run through the
  *same* main-thread rasterizer, so they agree by construction (faithful at each
  surface's resolution — not bit-identical, since preview rasters at display
  resolution and export at full).
- **Persisted raster frames are PNG, not WebP.** When a frame is persisted (the
  opt-in disk cache), it is encoded as PNG.
  `convertToBlob({ type: "image/webp", quality: 1 })` is lossy VP8 — the Canvas
  API exposes no lossless-WebP path — and crisp text edges are the whole point;
  PNG is the only canvas-native lossless format. (A WASM lossless-WebP encoder is
  the smaller-but-heavier future option.)
- **Authoring is bounded to what SVG expresses.** No flexbox, no automatic text
  wrapping: multi-line text is manual `<tspan>` line-breaking, with the harness
  measuring runs via `getComputedTextLength` to decide breaks. Rich HTML/CSS
  layout is out.
- The prior `Rasterizer` / `TemplateSprite` foreignObject path is replaced, not
  extended.

## Alternatives considered and rejected

- **HTML/CSS via `<foreignObject>`** — the natural overlay approach, and what the
  prior code used. Rejected: the taint above makes its raster unreadable and
  un-uploadable.
- **Grant the template iframe `allow-same-origin` to de-taint.** Rejected: the
  taint follows the foreignObject content, not the iframe's origin, so it does
  not de-taint; and it would forfeit the isolation that lets untrusted
  (community-authored) templates run safely.
- **Serve the SVG from a `data:` URL instead of `blob:`.** Rejected: still taints.
- **Capture via an OS-level offscreen-webview screenshot per frame.** A real
  native-capture pipeline that would produce clean pixels with full HTML/CSS
  fidelity. Rejected for v1 as heavyweight; retained as the fallback if SVG
  expressiveness proves insufficient.
- **Rasterize SVG in Rust (e.g. resvg) for a DOM-free export.** Noted as a future
  option for the export side; deferred — it is still SVG-only (same authoring
  constraint) and adds a second rasterizer to keep pixel-consistent with the
  webview.
