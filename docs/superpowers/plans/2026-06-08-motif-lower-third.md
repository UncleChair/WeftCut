# Lower Third Motif + Content-Duration Decoupling + Multi-Host Navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a second built-in Motif — a holdable lower third with a bundled font — and the data-model split (`content_duration_s`) that lets a holdable overlay animate-in then hold with a deduped, trim-stable cache, plus multi-Motif host navigation.

**Architecture:** A Motif is a self-contained `index.html` using `motif.define({ setup, frame })`; the injected clock-takeover runtime auto-seeks `document.getAnimations()` and Rust captures a taint-free PNG over CDP. This plan (a) adds a manifest field that decouples a Motif's seekable content duration from the layer-length cap, so frames past it clamp to the last content frame (one held capture, stable cache key); (b) authors the lower third (HTML/CSS + WAAPI + bundled Inter); (c) lets the single hidden host window navigate between Motif ids instead of erroring; (d) cleans up a discovered HTML-source drift in the countdown built-in.

**Tech Stack:** TypeScript + Vitest (preview/frame math), Rust + `cargo test` (manifest/catalog/host/CDP, crate `weftcut_lib`), WebView2 CDP (capture), WebdriverIO + tauri-driver (e2e). Windows-only capture path.

**Spec:** `docs/superpowers/specs/2026-06-08-motif-lower-third-design.md`

---

## File Structure

**Modified:**
- `apps/desktop/src/render/motifs/catalog.ts` — add `content_duration_s?` to `MotifManifest`; `resolveMotifContentDurationUs` prefers it.
- `apps/desktop/src/render/motifs/motifFrameDescriptor.ts` — windowing (`src_in`) becomes capped-only; holdable starts at content frame 0.
- `apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts` — clamp/dedup test for the new field.
- `apps/desktop/src/render/motifs/catalog.test.ts` — resolver precedence test.
- `apps/desktop/src-tauri/src/motifs/catalog.rs` — `content_duration_s: Option<f64>` on `Manifest`; new `builtin_lower_third`; updated builtin-set test.
- `apps/desktop/src-tauri/src/motifs/builtin.rs` — serve the lower third (index.html + `assets/Inter.woff2`); repoint countdown to the unified dir.
- `apps/desktop/src-tauri/src/motifs/host.rs` — navigate-or-rebuild + `motif_id_from_url` tests.
- `apps/desktop/src-tauri/src/motifs/commands.rs` — reset `CaptureState` on navigate (not just create).
- `apps/desktop/src-tauri/src/motifs/catalog/countdown/index.html` — overwrite stale `render()` HTML with the live `motif.define` HTML (drift fix).

**Created:**
- `apps/desktop/src-tauri/src/motifs/catalog/lower-third/manifest.json`
- `apps/desktop/src-tauri/src/motifs/catalog/lower-third/index.html`
- `apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets/Inter.woff2`
- `apps/desktop/e2e/specs/motif_lower_third.e2e.js`

**Deleted (drift cleanup):**
- `apps/desktop/src-tauri/src/motifs/builtin/countdown/` (whole dir — its HTML diverged from the served one).

---

## Task 1: TS — `content_duration_s` resolver + windowing rule

**Files:**
- Modify: `apps/desktop/src/render/motifs/catalog.ts`
- Modify: `apps/desktop/src/render/motifs/motifFrameDescriptor.ts`
- Test: `apps/desktop/src/render/motifs/catalog.test.ts`, `apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts`

- [ ] **Step 1: Write the failing resolver test**

Append to `apps/desktop/src/render/motifs/catalog.test.ts` (the imports `resolveMotifContentDurationUs`, `describe`, `it`, `expect` already exist there from vitest/`./catalog`; if `resolveMotifContentDurationUs` is not imported, add it to the existing import from `"./catalog"`):

```ts
describe("resolveMotifContentDurationUs — content_duration_s decoupling", () => {
  it("prefers content_duration_s over a max_duration cap", () => {
    const m: any = {
      content_duration_s: 0.8,
      max_duration_s: 5,
      max_duration_prop: "seconds",
      props_schema: {},
    };
    expect(resolveMotifContentDurationUs(m, { seconds: 5 })).toBe(800_000);
  });

  it("falls back to the cap when content_duration_s is absent", () => {
    const m: any = { max_duration_s: 3, props_schema: {} };
    expect(resolveMotifContentDurationUs(m, {})).toBe(3_000_000);
  });

  it("returns null when nothing is set", () => {
    const m: any = { props_schema: {} };
    expect(resolveMotifContentDurationUs(m, {})).toBe(null);
  });
});
```

- [ ] **Step 2: Write the failing descriptor clamp/dedup test**

Append to `apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts` inside the existing `describe("motifFrameDescriptor", ...)` block (the `view()` helper, `tpl`, and imports already exist at the top of that file):

```ts
  it("content_duration_s: holds + dedups the tail, never windows", () => {
    const holdable: typeof tpl = {
      manifest: {
        id: "holdable",
        name: "Holdable",
        version: 1,
        size: [1280, 320],
        default_duration_s: 5,
        content_duration_s: 0.8,
        props_schema: {},
      },
    };
    // Layer 5 s wide; sample tInLayer = 3 s — well past the 0.8 s content.
    const d = motifFrameDescriptor(view({}, 1_000_000), 3_000_000, 5_000_000, 30, 1, holdable)!;
    expect(d.contentDurationUs).toBe(800_000);
    expect(d.contentDurationFrames).toBe(24); // round(0.8 * 30)
    expect(d.srcInUs).toBe(0); // holdable never windows, even with src_in set
    expect(d.contentFrame).toBe(d.contentDurationFrames - 1); // clamped to last → deduped hold
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/desktop && npx vitest run src/render/motifs/catalog.test.ts src/render/motifs/motifFrameDescriptor.test.ts`
Expected: FAIL — the new tests fail (`content_duration_s` is ignored: the resolver returns the cap `5_000_000` not `800_000`, and the descriptor windows with `src_in=1_000_000`).

- [ ] **Step 4: Add the manifest field + resolver precedence**

In `apps/desktop/src/render/motifs/catalog.ts`, add to the `MotifManifest` interface (after `max_duration_prop?: string;`):

```ts
  /// Fixed content/animation duration (seconds) that does NOT cap the layer.
  /// When set, the seekable content spans this many seconds; the layer stays
  /// freely extendable and frames past it clamp to the last content frame (a
  /// held, deduped tail). Distinct from `max_duration_s`, which caps the layer.
  /// Holdable overlays (e.g. the lower third) use this.
  content_duration_s?: number;
```

Replace the body of `resolveMotifContentDurationUs` with (the function signature/JSDoc stay):

```ts
  // A fixed content/animation duration decoupled from the layer cap takes
  // precedence: it defines the seekable content span for holdable overlays.
  const cds = manifest.content_duration_s;
  if (typeof cds === "number" && Number.isFinite(cds) && cds > 0) {
    return Math.round(cds * 1_000_000);
  }
  const propName = manifest.max_duration_prop;
  if (propName) {
    const raw = props[propName];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.round(raw * 1_000_000);
    }
  }
  if (typeof manifest.max_duration_s === "number" && manifest.max_duration_s > 0) {
    return Math.round(manifest.max_duration_s * 1_000_000);
  }
  return null;
```

- [ ] **Step 5: Make windowing capped-only in the descriptor**

In `apps/desktop/src/render/motifs/motifFrameDescriptor.ts`, replace these three lines:

```ts
  const cap = resolveMotifContentDurationUs(template.manifest, view.props);
  const contentDurationUs = cap ?? durationUs;
  const srcInUs = cap == null ? 0 : view.src_in_us;
```

with:

```ts
  const cap = resolveMotifContentDurationUs(template.manifest, view.props);
  const contentDurationUs = cap ?? durationUs;
  // Windowing (`src_in`) applies ONLY to layer-capped Motifs (`max_duration*`).
  // A `content_duration_s` holdable always plays from content frame 0 (its
  // in-animation, then a clamped/held tail); a wholly-uncapped Motif animates
  // over the layer width from 0. Neither windows.
  const windowed = template.manifest.content_duration_s == null && cap != null;
  const srcInUs = windowed ? view.src_in_us : 0;
```

- [ ] **Step 6: Run the tests + typecheck to verify they pass**

Run: `cd apps/desktop && npx vitest run src/render/motifs/catalog.test.ts src/render/motifs/motifFrameDescriptor.test.ts && npm run typecheck`
Expected: PASS — all tests green (including the 3 pre-existing descriptor tests: countdown stays capped+windowed, uncapped still ignores `src_in`), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/render/motifs/catalog.ts apps/desktop/src/render/motifs/motifFrameDescriptor.ts apps/desktop/src/render/motifs/catalog.test.ts apps/desktop/src/render/motifs/motifFrameDescriptor.test.ts
git commit -m "feat(motifs): content_duration_s decouples seek duration from layer cap (TS)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rust — `content_duration_s` on `Manifest` (layer stays uncapped)

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/catalog.rs`
- Test: same file (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `apps/desktop/src-tauri/src/motifs/catalog.rs`:

```rust
    /// `content_duration_s` defines the seekable content span but must NOT cap
    /// the layer — `resolve_motif_max_dur_us` (the layer cap) ignores it, so a
    /// holdable overlay stays freely extendable.
    #[test]
    fn content_duration_s_does_not_cap_the_layer() {
        let mut m = builtin_countdown().manifest;
        m.max_duration_s = None;
        m.max_duration_prop = None;
        m.content_duration_s = Some(0.8);
        let props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        assert_eq!(resolve_motif_max_dur_us(&m, &props), None);
    }

    /// The field round-trips through serde and defaults to `None` when absent
    /// (so existing manifests without it keep parsing).
    #[test]
    fn manifest_roundtrips_content_duration_s() {
        let json = r#"{"id":"x","name":"X","version":1,"size":[10,10],
            "default_duration_s":1.0,"content_duration_s":0.8,"props_schema":{}}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.content_duration_s, Some(0.8));
        assert_eq!(m.max_duration_s, None);

        let without = r#"{"id":"y","name":"Y","version":1,"size":[10,10],
            "default_duration_s":1.0,"props_schema":{}}"#;
        let m2: Manifest = serde_json::from_str(without).unwrap();
        assert_eq!(m2.content_duration_s, None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs::catalog::tests::content_duration_s_does_not_cap_the_layer motifs::catalog::tests::manifest_roundtrips_content_duration_s`
Expected: FAIL — compile error: `Manifest` has no field `content_duration_s`.

- [ ] **Step 3: Add the field to `Manifest`**

In `apps/desktop/src-tauri/src/motifs/catalog.rs`, add to `struct Manifest` (after the `max_duration_prop` field, before `engine`):

```rust
    /// Fixed content/animation duration (seconds) that does NOT cap the layer.
    /// When set, the seekable content spans this many seconds; the layer stays
    /// freely extendable (`resolve_motif_max_dur_us` ignores this field), and
    /// the TS frame math clamps frames past it to the last content frame (a
    /// held, deduped tail). Used by holdable overlays (e.g. the lower third);
    /// distinct from `max_duration_s`, which caps the layer.
    #[serde(default)]
    pub content_duration_s: Option<f64>,
```

Then fix the ONE explicit `Manifest { ... }` struct literal in the test module (`canonicalize_validates_string_max_length_and_type`) — add the field alongside `max_duration_s: None,`:

```rust
                max_duration_s: None,
                max_duration_prop: None,
                content_duration_s: None,
```

Leave `resolve_motif_max_dur_us` unchanged — it must keep reading only the cap so the layer stays extendable.

- [ ] **Step 4: Run the motifs tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs`
Expected: PASS — all `motifs::` tests green (the new two plus every pre-existing catalog/builtin/cdp/mod test still compile and pass).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/catalog.rs
git commit -m "feat(motifs): content_duration_s field on Manifest (layer stays uncapped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Drift cleanup — unify the countdown HTML source

The countdown built-in has two divergent `index.html`s: `catalog/countdown/` (stale `render()`/`ready()`, consumed by `catalog.rs` for the manifest + `content_hash`) and `builtin/countdown/` (live `motif.define`, served over the `motif:` scheme). Unify both consumers onto the live one.

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/catalog/countdown/index.html` (overwrite with live HTML)
- Modify: `apps/desktop/src-tauri/src/motifs/builtin.rs` (repoint + test assertion)
- Modify: `apps/desktop/src-tauri/src/motifs/catalog.rs` (test assertion)
- Delete: `apps/desktop/src-tauri/src/motifs/builtin/countdown/` (whole dir)

- [ ] **Step 1: Overwrite the stale catalog HTML with the live `motif.define` version**

Write `apps/desktop/src-tauri/src/motifs/catalog/countdown/index.html` with exactly the live content (the current `builtin/countdown/index.html`):

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:480px;height:480px;overflow:hidden;background:transparent}
  #wrap{display:grid;place-items:center;width:100%;height:100%;
        font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
  #num{grid-area:1/1;font-size:220px;font-weight:700;line-height:1}
  #svg{grid-area:1/1}
  #ring{transform:rotate(-90deg);transform-origin:center}
</style></head><body>
  <div id="wrap">
    <svg id="svg" width="480" height="480">
      <circle id="ring" cx="240" cy="240" r="200" fill="none" stroke-width="16" stroke-linecap="round"/>
    </svg>
    <div id="num"></div>
  </div>
  <script>
    var C = 2 * Math.PI * 200;
    var ring = document.getElementById("ring");
    var num = document.getElementById("num");
    var _label = "GO";

    motif.define({
      setup: async function(props, ctx) {
        _label = props.label != null ? String(props.label) : "GO";
        num.style.color = props.accent;
        ring.style.stroke = props.accent;
        ring.setAttribute("stroke-dasharray", C);
        ring.animate(
          [{ strokeDashoffset: 0 }, { strokeDashoffset: C }],
          { duration: ctx.duration * 1000, easing: "linear", fill: "both" }
        );
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      },
      frame: function(t, ctx) {
        var n = Math.max(0, Math.ceil(ctx.duration - t));
        num.textContent = n > 0 ? String(n) : _label;
      },
    });
  </script>
</body></html>
```

- [ ] **Step 2: Repoint the scheme handler at the unified dir**

In `apps/desktop/src-tauri/src/motifs/builtin.rs`, change the `COUNTDOWN` embed path from `builtin/countdown/index.html` to `catalog/countdown/index.html`:

```rust
const COUNTDOWN: BuiltinMotif = BuiltinMotif {
    id: "countdown",
    files: &[BuiltinFile {
        rel: "index.html",
        bytes: include_bytes!("catalog/countdown/index.html"),
    }],
};
```

- [ ] **Step 3: Update the stale-shape test assertions**

In `apps/desktop/src-tauri/src/motifs/catalog.rs`, the test `every_builtin_html_is_svg_with_render` asserts the OLD `function render` shape. Replace it with the live contract (rename + assert `motif.define`; drop the `<svg>` requirement since not every Motif uses SVG):

```rust
    /// Every built-in's served HTML declares its lifecycle via `motif.define`
    /// (the live contract). A missing `motif.define` ships a blank frame.
    #[test]
    fn every_builtin_html_uses_motif_define() {
        for t in builtins() {
            assert!(
                t.html.contains("motif.define"),
                "{}: HTML missing motif.define() entry",
                t.id()
            );
        }
    }
```

The `builtin.rs` test `looks_up_embedded_countdown_index` already asserts `s.contains("motif.define")` — it now passes against the repointed bytes; no change needed.

- [ ] **Step 4: Delete the now-redundant builtin/countdown dir**

```bash
git rm -r apps/desktop/src-tauri/src/motifs/builtin/countdown
```

- [ ] **Step 5: Run the motifs tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs`
Expected: PASS — `every_builtin_html_uses_motif_define`, `looks_up_embedded_countdown_index`, `builtin_motif_parses`, and the rest are green. (The served countdown bytes are byte-identical to before, so rendering is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/catalog/countdown/index.html apps/desktop/src-tauri/src/motifs/builtin.rs apps/desktop/src-tauri/src/motifs/catalog.rs
git commit -m "refactor(motifs): unify countdown HTML source (catalog == served), kill drift

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The Lower Third Motif (files + catalog/scheme wiring)

**Files:**
- Create: `apps/desktop/src-tauri/src/motifs/catalog/lower-third/manifest.json`
- Create: `apps/desktop/src-tauri/src/motifs/catalog/lower-third/index.html`
- Create: `apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets/Inter.woff2`
- Modify: `apps/desktop/src-tauri/src/motifs/catalog.rs`
- Modify: `apps/desktop/src-tauri/src/motifs/builtin.rs`

- [ ] **Step 1: Write the failing catalog + assets tests**

In `apps/desktop/src-tauri/src/motifs/catalog.rs`, update `builtins_cover_starter_set` to expect two ids:

```rust
    #[test]
    fn builtins_cover_starter_set() {
        let actual: Vec<String> = builtins().iter().map(|t| t.id().to_string()).collect();
        assert_eq!(actual, vec!["countdown".to_string(), "lower-third".to_string()]);
        let catalog_ids: Vec<String> = catalog().iter().map(|m| m.id.clone()).collect();
        assert_eq!(catalog_ids, vec!["countdown".to_string(), "lower-third".to_string()]);
    }
```

In `apps/desktop/src-tauri/src/motifs/builtin.rs`, add a test that the font asset is embedded and served:

```rust
    #[test]
    fn serves_lower_third_font_asset() {
        let bytes = lookup("lower-third", "assets/Inter.woff2")
            .expect("lower-third font embedded");
        assert!(!bytes.is_empty());
        assert_eq!(content_type_for("assets/Inter.woff2"), "font/woff2");
    }

    #[test]
    fn looks_up_embedded_lower_third_index() {
        let bytes = lookup("lower-third", "index.html").expect("lower-third index embedded");
        let s = std::str::from_utf8(bytes).unwrap();
        assert!(s.contains("motif.define"));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs`
Expected: FAIL — `builtins()` still returns one id; `lookup("lower-third", ...)` returns `None`; compile error on the missing `builtin_lower_third` once referenced (added in Step 6).

- [ ] **Step 3: Obtain the bundled Inter font**

Vendor a `woff2` for Inter weight 700 at `apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets/Inter.woff2`. Either:

Download the prebuilt file (Inter is SIL OFL):
```bash
mkdir -p apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets
curl -L -o apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets/Inter.woff2 \
  https://rsms.me/inter/font-files/InterDisplay-Bold.woff2
```

Or, if a smaller subset is preferred (machine has conda/Python — see CLAUDE.md), subset to Latin:
```bash
pip install fonttools brotli
pyftsubset InterDisplay-Bold.woff2 --unicodes=U+0000-00FF,U+2018-201F --flavor=woff2 \
  --output-file=apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets/Inter.woff2
```

Record the OFL attribution next to the asset (a short `apps/desktop/src-tauri/src/motifs/catalog/lower-third/assets/LICENSE` noting "Inter © The Inter Project Authors, SIL OFL 1.1"). The `index.html` CSS stack falls back to `system-ui` if the file is somehow absent, so tests still render — but the feature wants the real font present.

- [ ] **Step 4: Create the manifest**

Write `apps/desktop/src-tauri/src/motifs/catalog/lower-third/manifest.json`:

```json
{
  "id": "lower-third",
  "name": "Lower Third",
  "version": 1,
  "size": [1280, 320],
  "default_duration_s": 5.0,
  "content_duration_s": 0.8,
  "settle_rafs": 1,
  "fonts": [{ "family": "Inter", "file": "Inter.woff2", "weight": 700 }],
  "props_schema": {
    "title":    { "type": "string", "default": "Jane Doe", "max_length": 40 },
    "subtitle": { "type": "string", "default": "Director of Photography", "max_length": 60 },
    "accent":   { "type": "color",  "default": "#ff4d4d" },
    "align":    { "type": "string", "default": "left", "max_length": 5 }
  }
}
```

- [ ] **Step 5: Create the Motif HTML**

Write `apps/desktop/src-tauri/src/motifs/catalog/lower-third/index.html`. The bar lives at a fixed CSS position (`left:64px; bottom:48px; width:760px; height:160px`), with a 10 px solid-accent edge; the in-animation is a 700 ms slide+fade declared in `setup` with `fill:"both"` (auto-seeked, holds after it ends). No `frame()`.

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face{
    font-family:"Inter";
    src:url("assets/Inter.woff2") format("woff2");
    font-weight:700; font-style:normal; font-display:block;
  }
  html,body{margin:0;width:1280px;height:320px;overflow:hidden;background:transparent}
  #bar{
    position:absolute; bottom:48px; height:160px; width:760px;
    display:flex; flex-direction:column; justify-content:center;
    padding:0 36px; box-sizing:border-box;
    background:rgba(15,17,23,0.82);
    font-family:"Inter", system-ui, -apple-system, "Segoe UI", sans-serif; color:#fff;
  }
  #bar.left{ left:64px;  border-left:10px solid var(--accent); text-align:left; }
  #bar.right{ right:64px; border-right:10px solid var(--accent); text-align:right; }
  #title{ font-size:56px; font-weight:700; line-height:1.05; letter-spacing:0.2px;
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #subtitle{ font-size:30px; font-weight:700; opacity:0.82; margin-top:10px;
             white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
</style></head><body>
  <div id="bar" class="left">
    <div id="title"></div>
    <div id="subtitle"></div>
  </div>
  <script>
    var bar = document.getElementById("bar");
    var titleEl = document.getElementById("title");
    var subEl = document.getElementById("subtitle");

    motif.define({
      setup: async function(props, ctx) {
        var align = props.align === "right" ? "right" : "left";
        bar.className = align;
        bar.style.setProperty("--accent", props.accent || "#ff4d4d");
        titleEl.textContent = props.title != null ? String(props.title) : "";
        subEl.textContent = props.subtitle != null ? String(props.subtitle) : "";

        // Slide + fade IN over 700 ms; `fill:both` pins the end state so every
        // frame past content_duration_s (0.8 s) is the settled, held look.
        var dx = align === "right" ? 48 : -48;
        bar.animate(
          [{ opacity: 0, transform: "translateX(" + dx + "px)" },
           { opacity: 1, transform: "translateX(0)" }],
          { duration: 700, easing: "cubic-bezier(0.16,1,0.3,1)", fill: "both" }
        );
        // Subtitle fades in slightly later (a second concurrent WAAPI anim).
        subEl.animate(
          [{ opacity: 0 }, { opacity: 0.82 }],
          { duration: 650, delay: 150, easing: "ease-out", fill: "both" }
        );

        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      },
    });
  </script>
</body></html>
```

- [ ] **Step 6: Wire it into the catalog + scheme registries**

In `apps/desktop/src-tauri/src/motifs/catalog.rs`, add a second `builtin_motif!` invocation after `builtin_motif!(builtin_countdown, "catalog/countdown");`:

```rust
builtin_motif!(builtin_lower_third, "catalog/lower-third");
```

and extend `builtins()`:

```rust
pub fn builtins() -> Vec<Motif> {
    vec![builtin_countdown(), builtin_lower_third()]
}
```

In `apps/desktop/src-tauri/src/motifs/builtin.rs`, add a `LOWER_THIRD` entry and register it in `BUILTINS`:

```rust
const LOWER_THIRD: BuiltinMotif = BuiltinMotif {
    id: "lower-third",
    files: &[
        BuiltinFile {
            rel: "index.html",
            bytes: include_bytes!("catalog/lower-third/index.html"),
        },
        BuiltinFile {
            rel: "assets/Inter.woff2",
            bytes: include_bytes!("catalog/lower-third/assets/Inter.woff2"),
        },
    ],
};

const BUILTINS: &[BuiltinMotif] = &[COUNTDOWN, LOWER_THIRD];
```

- [ ] **Step 7: Run the motifs tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs`
Expected: PASS — `builtins_cover_starter_set` (two ids), `serves_lower_third_font_asset`, `looks_up_embedded_lower_third_index`, and `every_builtin_*` (the lower third parses, self-validates, uses `motif.define`, has a unique id) all green.

- [ ] **Step 8: Verify the picker surfaces both Motifs (no hardcode)**

The picker iterates the catalog, so the lower third should appear automatically. Confirm nothing hardcodes a single Motif id:

Run: `cd apps/desktop && grep -rn "\"countdown\"" src/ --include=*.ts --include=*.tsx`
Expected: matches only in tests / `catalog`-iteration code, NOT a hardcoded picker entry. If the picker hardcodes `countdown`, change it to map over `listMotifs()`; if it already iterates, no change.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/catalog/lower-third apps/desktop/src-tauri/src/motifs/catalog.rs apps/desktop/src-tauri/src/motifs/builtin.rs
git commit -m "feat(motifs): lower-third built-in (holdable, bundled Inter, non-square)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Multi-Motif host navigation

Replace the "bound to a different id → error" guard in `ensure_host` with navigate-or-rebuild, and reset `CaptureState` on navigation so the ready-probe + metrics re-apply for the new page.

**Files:**
- Modify: `apps/desktop/src-tauri/src/motifs/host.rs`
- Modify: `apps/desktop/src-tauri/src/motifs/commands.rs`
- Test: `apps/desktop/src-tauri/src/motifs/host.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write the failing `motif_id_from_url` tests**

Add a test module at the bottom of `apps/desktop/src-tauri/src/motifs/host.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::motif_id_from_url;

    #[test]
    fn extracts_id_from_host_url() {
        let u: tauri::Url = "http://motif.localhost/lower-third/index.html".parse().unwrap();
        assert_eq!(motif_id_from_url(&u).as_deref(), Some("lower-third"));
    }

    #[test]
    fn none_for_root_url() {
        let u: tauri::Url = "http://motif.localhost/".parse().unwrap();
        assert_eq!(motif_id_from_url(&u), None);
    }
}
```

- [ ] **Step 2: Run to verify they compile/fail appropriately**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs::host`
Expected: PASS already (these exercise the existing pure helper) — they are the regression guard for the id parsing the navigation logic depends on. If they fail to compile, fix the test before proceeding. (This step locks the helper's contract before changing `ensure_host`.)

- [ ] **Step 3: Rewrite `ensure_host` as navigate-or-rebuild**

In `apps/desktop/src-tauri/src/motifs/host.rs`, replace the body of `ensure_host` (keep the signature `-> tauri::Result<(WebviewWindow, bool)>`; the bool now means "needs reset" = created OR navigated). Update the doc comment to match:

```rust
pub fn ensure_host(
    app: &AppHandle,
    runtime: &str,
    motif_id: &str,
    width: u32,
    height: u32,
) -> tauri::Result<(WebviewWindow, bool)> {
    // `http://motif.localhost/<id>/index.html` on Windows — the remapped form
    // of the `motif:` custom scheme (see the `builtin` module docs).
    let url = format!("{SCHEME_ORIGIN}/{motif_id}/index.html");
    let parsed: tauri::Url = url.parse().map_err(tauri::Error::InvalidUrl)?;

    if let Some(win) = app.get_webview_window(HOST_LABEL) {
        let bound_id = win.url().ok().and_then(|u| motif_id_from_url(&u));
        if bound_id.as_deref() == Some(motif_id) {
            // Already on the right Motif — reuse as-is, no reset.
            return Ok((win, false));
        }
        // Bound to a DIFFERENT Motif: navigate the existing hidden host to the
        // new id, reusing the window + CDP session. WebView2 re-runs the
        // `initialization_script` on navigation, so the clock-takeover runtime
        // re-injects before the new page's `motif.define(...)`. The caller
        // resets `CaptureState` (returned `true`) so the ready-probe re-confirms
        // `__motifRender` on the new page and `setDeviceMetricsOverride` re-applies
        // for the new Motif's size.
        win.navigate(parsed)?;
        return Ok((win, true));
    }

    // No host yet: build it (hidden, no taskbar, runtime injected at doc-start).
    let win = WebviewWindowBuilder::new(app, HOST_LABEL, WebviewUrl::CustomProtocol(parsed))
        .title("motif-host")
        .inner_size(width as f64, height as f64)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .initialization_script(runtime)
        .build()?;
    Ok((win, true))
}
```

> **API note:** `WebviewWindow::navigate(Url)` is the Tauri 2 primitive. If `cargo` reports it does not exist on the pinned version, fall back to driving CDP `Page.navigate` (add a `cdp::navigate(&win, url)` helper modeled on `cdp::eval_await`, issuing `Page.navigate` with `{"url": "..."}`); the `initialization_script` re-injects either way. The compile in Step 5 is the gate.

- [ ] **Step 4: Reset `CaptureState` on navigate in the command**

In `apps/desktop/src-tauri/src/motifs/commands.rs`, the call site currently reads:

```rust
    let (win, created) = host::ensure_host(&app, &runtime, &motif_id, width, height)
        .map_err(|e| format!("ensure_host failed: {e}"))?;
    if created {
        cap.reset();
    }
```

Rename the bound variable to reflect the new meaning (created OR navigated):

```rust
    let (win, needs_reset) = host::ensure_host(&app, &runtime, &motif_id, width, height)
        .map_err(|e| format!("ensure_host failed: {e}"))?;
    if needs_reset {
        cap.reset();
    }
```

The existing ready-probe + `should_set_metrics` gates below this already do the right thing once `CaptureState` is reset: `ready_for = None` → the probe re-confirms the new page; `last_size = None` → metrics re-apply at the new Motif's capture size.

- [ ] **Step 5: Compile + run the motifs tests**

Run: `cd apps/desktop/src-tauri && cargo test --lib motifs`
Expected: PASS — compiles (confirming `WebviewWindow::navigate` exists; otherwise apply the CDP fallback from the API note), and `motifs::host` + all other `motifs::` tests are green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/motifs/host.rs apps/desktop/src-tauri/src/motifs/commands.rs
git commit -m "feat(motifs): multi-Motif host navigation (navigate-or-rebuild + state reset)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: E2E — lower third capture + host navigation (real WebView2)

**Files:**
- Create: `apps/desktop/e2e/specs/motif_lower_third.e2e.js`

- [ ] **Step 1: Write the e2e spec**

Create `apps/desktop/e2e/specs/motif_lower_third.e2e.js` (modeled on `motif_capture.e2e.js`; the `__weftcutTest.captureMotifFrame` hook is the same production path):

```js
// Drives the lower-third Motif and host navigation through the REAL app:
//   1. Determinism  — two captures at a held time (t=2.0 s, past the 0.8 s
//                     in-animation) are byte-identical.
//   2. Transparent  — a corner pixel outside the bar is fully transparent
//                     (proves just-the-bar geometry + CDP transparent backdrop).
//   3. Accent edge  — the 10 px left border at (69, 192) is the accent color
//                     #ff4d4d (proves font/layout rendered, non-square capture).
//   4. Navigation   — capturing `countdown` then `lower-third` in one session
//                     both succeed (the hidden host navigates between ids).

const LT_PROPS = { title: "Jane Doe", subtitle: "Director of Photography", accent: "#ff4d4d", align: "left" };
const LT_W = 1280, LT_H = 320, LT_ID = "lower-third";
const CD_PROPS = { seconds: 5, label: "GO", accent: "#ff4d4d" };
const CD_W = 480, CD_H = 480, CD_ID = "countdown";

async function capturePng(motifId, tSec, props, w, h) {
  const out = await browser.executeAsync((motifId, t, props, w, h, done) => {
    const hook = window.__weftcutTest;
    if (!hook || typeof hook.captureMotifFrame !== "function") {
      done({ ok: false, error: "captureMotifFrame hook absent" });
      return;
    }
    hook.captureMotifFrame({ motifId, tSec: t, props, width: w, height: h })
      .then((b64) => done({ ok: true, b64 }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, motifId, tSec, props, w, h);
  if (!out.ok) throw new Error(`capture(${motifId}, t=${tSec}) failed: ${out.error}`);
  return out.b64;
}

async function samplePixel(b64, cx, cy) {
  return browser.executeAsync((b64str, x, y, done) => {
    const bytes = Uint8Array.from(atob(b64str), (c) => c.charCodeAt(0));
    createImageBitmap(new Blob([bytes], { type: "image/png" }))
      .then((bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const d = ctx.getImageData(x, y, 1, 1).data;
        done({ r: d[0], g: d[1], b: d[2], a: d[3] });
      })
      .catch((e) => done({ error: String(e) }));
  }, b64, cx, cy);
}

describe("lower-third motif + host navigation (real WebView2)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    await browser.waitUntil(
      async () => await browser.execute(
        () => !!(window.__weftcutTest && typeof window.__weftcutTest.captureMotifFrame === "function"),
      ),
      { timeout: 30000, timeoutMsg: "captureMotifFrame hook never installed" },
    );
  });

  it("determinism: two held captures at t=2.0 are identical", async () => {
    const a = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const b = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    expect(a).not.toHaveLength(0);
    expect(a).toBe(b);
  });

  it("transparent: a corner pixel outside the bar is fully transparent", async () => {
    const b64 = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const px = await samplePixel(b64, 10, 10);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.a).toBeLessThan(10);
  });

  it("accent edge: the left border at (69,192) is the accent color", async () => {
    const b64 = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const px = await samplePixel(b64, 69, 192);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.r).toBeGreaterThanOrEqual(200); // accent red 255
    expect(px.g).toBeLessThan(150);            // accent green 77
    expect(px.b).toBeLessThan(150);            // accent blue 77
    expect(px.a).toBeGreaterThan(200);         // opaque border
  });

  it("navigation: capturing countdown then lower-third in one session both succeed", async () => {
    const cd = await capturePng(CD_ID, 2.5, CD_PROPS, CD_W, CD_H);
    expect(cd).not.toHaveLength(0);
    // Now the hidden host must NAVIGATE from countdown to lower-third.
    const lt = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    expect(lt).not.toHaveLength(0);
    // And the lower-third's accent edge confirms the new page actually rendered.
    const px = await samplePixel(lt, 69, 192);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.r).toBeGreaterThanOrEqual(200);
    // Navigate back to countdown to exercise the reverse direction.
    const cd2 = await capturePng(CD_ID, 1.0, CD_PROPS, CD_W, CD_H);
    expect(cd2).not.toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `cd apps/desktop/e2e && npm test`
Expected: PASS — the new `motif_lower_third` spec is green alongside `motif_capture`. (Requires the tauri-driver harness + a `msedgedriver` matching the WebView2 version, per the existing e2e setup. If the app isn't built, build first per the repo's e2e instructions.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/specs/motif_lower_third.e2e.js
git commit -m "test(motifs): e2e for lower-third capture + host navigation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §2 `content_duration_s` decoupling → Task 1 (TS resolver + windowing) + Task 2 (Rust field, cap untouched). ✓
- §2 held-tail dedup + trim-stable key → Task 1 Step 2 test (clamp to last frame; fixed `contentDurationFrames`). ✓
- §3 lower-third (geometry, declarative no-`frame()`, props, no slide-out) → Task 4 Steps 4–5. ✓
- §3 bundled Inter (assets path) → Task 4 Step 3 (font) + Step 6 (`@font-face`/embed/serve) + Step 1 test. ✓
- §4 multi-host navigation (navigate-or-rebuild + reset) → Task 5. ✓
- §5 catalog/picker/MCP wiring → Task 4 Steps 6–8. ✓
- §5 catalog/builtin drift cleanup → Task 3. ✓
- §6 tests (Rust builtin-set/assets/roundtrip; TS clamp/precedence; e2e font/transparent/non-square/navigation) → Tasks 1,2,4,6. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows full content. The only external dependency (the Inter `woff2`) has two concrete acquisition commands in Task 4 Step 3.

**Type consistency:** `content_duration_s` is the field name in both TS (`MotifManifest`) and Rust (`Manifest`). `resolveMotifContentDurationUs` keeps its existing signature/call sites (`motifFrameDescriptor.ts`, `exportBake.ts`). `ensure_host` keeps its `(WebviewWindow, bool)` return; only the bool's meaning (created → needs-reset) widens, and the single call site in `commands.rs` is updated in lockstep (Task 5 Step 4). `motif_id_from_url` is the existing helper, unchanged.

**Out-of-scope confirmed absent:** no pixel-hash dedup, no enum `PropSpec`, no slide-out, no upload-security work, no `docs/motifs.md` rewrite.
