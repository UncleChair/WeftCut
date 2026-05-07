# Built-in HTML overlay templates

Each template is a self-contained directory consumed by the offscreen rasterizer. Layout per `docs/rendering.md` ("Template format"):

```
templates/<id>/
  manifest.json     id, name, version, size, default_duration, props_schema
  index.html
  style.css
  preview.png
  fonts/
  assets/
```

Phase 5 ships the starter set:

- Lower thirds (3 styles)
- Intro / outro title cards
- Captions strip
- Callout arrow + label
- Progress bar
- Countdown timer
- Logo bug
- Slate

Template runtime contract:

- Reads props from `window.__props__` (rasterizer injects before any script runs).
- Sets transparent background: `html, body { background: transparent; }`.
- Optional `window.__ready__` Promise — awaited before first capture.
- Optional `window.__onSeek = (t) => Promise<void>` for imperative timing on Canvas/WebGL templates.
