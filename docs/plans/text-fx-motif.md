# Implementation Plan — `text-fx` built-in Motif + PropSpec `enum`/`multiline`

> Working plan (ephemeral; delete on consolidation per the docs convention).
> Branch: `feat/text-fx-motif` (worktree `videtor-wt1`).

## Goal

Ship a new built-in Motif **`text-fx`** ("Text FX"): a single, configurable
special-effects text block — an ASS-subtitle-flavored region with one mutually
exclusive `effect` selector across **typewriter / karaoke / color-shift**,
full-frame 1920×1080 canvas with 9-grid alignment, duration that follows the
layer width, and subtitle-grade legibility styling (outline, background box).

Delivering decent UX for the selectors requires a foundational change first:
extend the shared `PropSpec` type system with an **`enum`** type (dropdowns) and a
**`multiline`** flag on `string` (textarea). So the work is two layers:

1. **PropSpec extension** (foundation — touches Rust + 2× TS + 2× UI + validation).
2. **The `text-fx` Motif** (manifest + `index.html` runtime + bundled fonts + dual registration).

Both layers follow the project's TDD discipline.

---

## Locked design decisions (from the design interview)

| Axis | Decision |
|---|---|
| Structure | Single Motif, mutually-exclusive `effect` enum (`typewriter`/`karaoke`/`color-shift`) |
| Text | Multiline `string` (split on `\n`); edited via textarea (`multiline` flag) |
| Canvas | Full-frame `1920×1080`; `h_align`×`v_align` = ASS `\an`-style 9-grid |
| Duration | Follows layer width — **no** `max_duration_*` / `content_duration_s` fields |
| typewriter | `type_speed` chars/sec → reveal then **hold full text**; cursor vanishes on completion (preserves tail dedup) |
| karaoke | Per-character smooth wipe `color`→`color2`; even baseline + optional `{N}` **relative-weight** markup (normalized to fill duration; `\{` escapes a literal brace); multiline flows in reading order |
| color-shift | Whole-text crossfade `color`→`color2`; `loop` ∈ `once`/`loop`/`pingpong` |
| Styling | Subtitle-grade: size, 2 colors, 9-grid align, outline color+width, optional bg box |
| Fonts | `font` enum; bundle 1 CJK sans + 1 Latin sans (CJK default — covers Latin too) |
| Determinism | Pure `f(t)` via `frame(t)`; `settle_rafs=1`; explicit `document.fonts.load()` |

### Easing / micro-defaults (decided by default — adjust if desired)
- id `text-fx`, name `Text FX`; default `effect=typewriter`, `v_align=bottom`.
- crossfade easing = ease-in-out; karaoke wipe & typewriter = linear. **No** easing prop in v1.
- outline via `paint-order: stroke fill` + `-webkit-text-stroke`.

---

## Final props schema (one flat schema; unused props ignored per effect)

| key | type | default | range/options | used by |
|---|---|---|---|---|
| `effect` | **enum** | `typewriter` | `typewriter`,`karaoke`,`color-shift` | all (selector) |
| `text` | **string+multiline** | `"Your text here"` | max_length 200 | all |
| `font` | **enum** | `sans-cjk` | `sans-cjk`,`sans-latin` | all |
| `font_size` | number | `72` | 8–400 | all |
| `color` | color | `#ffffff` | — | all (primary / unsung / start) |
| `color2` | color | `#ffcc00` | — | karaoke (sung), color-shift (end) |
| `h_align` | **enum** | `center` | `left`,`center`,`right` | all |
| `v_align` | **enum** | `bottom` | `top`,`middle`,`bottom` | all |
| `outline_color` | color | `#000000` | — | all |
| `outline_width` | number | `4` | 0–30 (0 = none) | all |
| `bg_color` | color(+α) | `#00000000` | — | all (⚠ alpha lost if edited in UI) |
| `type_speed` | number | `20` | 1–100 chars/s | typewriter |
| `loop` | **enum** | `once` | `once`,`loop`,`pingpong` | color-shift |

> Note the BTreeMap (Rust) / alphabetical render order: fields appear sorted by
> key in the picker/panel. That's acceptable; if a curated order is wanted later,
> it's a separate UI change (out of scope for v1).

---

## Layer 1 — PropSpec `enum` + `string.multiline`

### 1.1 Rust — `apps/desktop/native/src/motifs/catalog.rs`
- Add variant to `PropSpec`:
  ```rust
  Enum { default: String, options: Vec<String> },
  ```
  and add `#[serde(default)] multiline: Option<bool>` to `PropSpec::String`.
- `spec_default_json`: `Enum { default, .. } => String(default.clone())`.
- `validate_prop`: `Enum { options, .. }` → value must be a string contained in
  `options` (else a new `MotifError::NotInEnum(key, value)` — add the variant).
  `String { multiline, .. }` ignores `multiline` for validation (display-only).
- `validate_default_for` already routes through `spec_default_json` +
  `validate_prop`, so an enum whose `default ∉ options` is rejected at import — good.
- **Tests (TDD, in the `catalog.rs` test module):**
  - `enum_rejects_value_not_in_options` / `enum_accepts_listed_value`.
  - `enum_default_must_be_listed` (a manifest whose enum default isn't in options
    fails `validate_default_for`).
  - `enum_canonicalizes_and_is_stable` (canonical form + cache-key stability).
  - `string_multiline_roundtrips` (serde default `None`, parses with/without).
  - lenient path: invalid enum value falls back to default.

### 1.2 TS type mirrors (BOTH must match Rust)
- `apps/desktop/src/renderer/ipc/index.ts:1145` — add
  `| { type: "enum"; default: string; options: string[] }` and
  `multiline?: boolean` on the string variant.
- `apps/desktop/src/renderer/render/motifs/catalog.ts:7` — same two edits.
  - `propValueValid` (catalog.ts) has a `never` exhaustiveness guard → adding the
    enum variant **forces** a compile error until handled. Add:
    `case "enum": return typeof v === "string" && spec.options.includes(v);`
  - `canonicalizePropsLenient` needs no change (delegates to `propValueValid`).
- **Add a Rust↔TS PropSpec parity guard** (project has a twin-drift history): a
  small test asserting the set of `type` discriminants + field names match across
  the Rust enum and the two TS unions. (Simplest: a TS test listing expected
  variants + a Rust test listing the same; or a generated-fixture check. Pick the
  lightest that actually fails on drift.)

### 1.3 UI — picker (`apps/desktop/src/renderer/motifs/MotifPicker.tsx`)
- `defaultPropValue` (≈L283): add `case "enum": return spec.default;`.
- `PropField` (≈L602) `switch(spec.type)`:
  - `enum` → render `AppSelect` (already imported) with
    `options: spec.options.map(o => ({ value: o, label: o }))`.
  - `string` → pass `multiline` to render a textarea variant (see 1.5).
  - Add a `default: never` exhaustiveness guard to this switch while here.

### 1.4 UI — property panel (`apps/desktop/src/renderer/properties/PropertyPanel.tsx`)
- `MotifPropField` (L797) `switch(spec.type)`: add `case "enum"` → new
  `EnumPropField` using `AppSelect` (imported at L8), commit via `onCommit`.
- Add `default: never` exhaustiveness guard to this switch.
- `StringPropField` (L856): when `spec.multiline`, render a multi-line input
  (textarea) instead of `AppInput`; keep Enter-to-commit only in single-line mode
  (in multiline, Enter inserts a newline; commit on blur).

### 1.5 Multiline input affordance
- Picker `AppInput` and panel `StringPropField` are single-line. Add a textarea
  path gated on `spec.multiline`. If `AppInput` can't do multiline, add a small
  `AppTextArea` (or inline `<textarea>` with the same styling hooks). Newlines in
  the value are real `\n`; the Motif splits on them.

### 1.6 Layer-1 verification
- `cargo test -p <native crate> motifs::catalog` green (new + existing).
- `vitest` for catalog + any PropField tests green; `tsc` clean (exhaustiveness
  guards compile).
- Existing built-ins (`countdown`, `lower-third`) still validate (no enum → unaffected).

---

## Layer 2 — the `text-fx` Motif

### 2.1 Files & registration (DUAL MANIFEST)
- **Rust source of truth** (served over `motif:` by the main-process host):
  `apps/desktop/native/src/motifs/catalog/text-fx/`
  - `manifest.json` (schema above; no duration fields; `settle_rafs: 1`;
    `fonts: [{family,file,weight}…]`).
  - `index.html` (the runtime — see 2.2).
  - `assets/` — `Inter.woff2` (copy from lower-third) + one CJK woff2 (see 2.4).
- `catalog.rs`:
  - `builtin_motif!(builtin_text_fx, "catalog/text-fx");`
  - add `"text-fx"` to `BUILTIN_IDS`; add `builtin_text_fx()` to `builtins()`.
  - update tests asserting the starter set: `builtins_cover_starter_set`,
    `builtin_ids_const_matches_builtins` (now 3 entries).
- **TS render-path catalog**: `apps/desktop/src/renderer/render/motifs/builtin/text-fx/manifest.json`
  (manifest only — the glob in `catalog.ts` picks it up for frame math; HTML/assets
  stay Rust-side). Must be byte-equivalent to the Rust manifest (same schema).

### 2.2 `index.html` runtime contract
A normal web doc using `motif.define({ setup, frame })`. Skeleton:

```js
motif.define({
  async setup(props, ctx) {
    // 1) parse markup → { chars:[{ch, weight}], plainText } ; strip {N}, unescape \{
    // 2) build DOM: per-line containers (split plainText on "\n"),
    //    each char in its own <span class="ch"> for karaoke wipe + typewriter reveal
    // 3) styling from props: font-family (selected enum→bundled family),
    //    font-size, color (base), outline via paint-order+ -webkit-text-stroke,
    //    bg box (bg_color), 9-grid via flex (justify=h_align, align=v_align)
    // 4) await document.fonts.load(`${weight} ${size}px "${family}"`) for the
    //    SELECTED family (determinism: explicit load, not just fonts.ready)
  },
  frame(t, ctx) {
    const p = ctx.duration > 0 ? clamp01(t / ctx.duration) : 1;
    switch (effect) {
      case "typewriter": revealChars(Math.floor(t * type_speed)); // hold after done; cursor off when complete
      case "karaoke":     setKaraokeProgress(t); // per-char fill via background-clip gradient stop
      case "color-shift": setColor(lerpHex(color, color2, loopMap(p, loop))); // ease-in-out
    }
  },
});
```

Key implementation notes:
- **Markup parser** runs for ALL effects (so `{N}` never shows literally); weights
  only consumed by karaoke. Tokenize: chars + `{digits}` → weight on preceding
  char; `\{`→literal `{`. Default weight 1. Normalize cumulative weights to
  `ctx.duration` → per-char `[startFrac,endFrac]`.
- **Karaoke wipe**: each `.ch` span paints `color` (unsung) with a `color2`
  overlay clipped via `background-clip:text` + a `linear-gradient` hard stop at the
  in-char fraction = `(t/dur − startFrac)/(endFrac−startFrac)` clamped 0..1. Past
  chars = 1 (fully sung), future = 0. Multiline is automatic (per-char, reading
  order from DOM order).
- **Typewriter**: reveal first `N=floor(t*type_speed)` chars (visibility/opacity);
  blinking caret element after the last revealed char while `N<total`; **remove the
  caret once `N>=total`** so the held tail is pixel-identical → cache dedup. Caret
  blink must be `f(t)` (e.g. `step(fract(t*2))`), never a timer.
- **color-shift**: `loopMap(p, "once")=easeInOut(p)`; `"loop"=easeInOut(fract(p*N))`
  or sawtooth; `"pingpong"=easeInOut(triangle(p))`. Applies one color to the whole
  text container.
- **Determinism**: everything derived from `t`/`ctx.frame`; no `setInterval`,
  no real `Date.now()` for motion, no `fetch`. `setup` self-contained (re-runs per
  distinct props). Keep `frame` a pure function of `t` (re-seekable).

### 2.3 Cost reality (carry forward, document in-Motif)
- karaoke & color-shift are **distinct every frame** → no cache dedup. A 6 s clip
  @30 fps ≈ 180 captures ≈ ~16 s first-time prepare/bake, then cached. typewriter's
  held tail dedups. This is inherent to duration=layer-width; longer = costlier.

### 2.4 Fonts (binary cost — final pick at implementation)
- Latin: reuse `Inter.woff2` (~small) as `sans-latin`.
- CJK: bundle one regular weight (e.g. Noto Sans SC / Source Han Sans Regular) as
  `sans-cjk`. **Even subsetted this is multiple MB via `include_str!`** and bloats
  every install. Measure the chosen file's woff2 size and record it here before
  committing. (Subsetting to a fixed glyph set is rejected — arbitrary user text
  would tofu on missing glyphs.) Declare both in `manifest.fonts`; the `setup`
  loads only the selected family's faces.

### 2.5 Layer-2 verification
- Rust: `every_builtin_parses_and_self_validates`, `every_builtin_html_uses_motif_define`,
  unique-ids, starter-set tests all green with `text-fx` added.
- `cargo build` / production build OK (fonts embed; binary size delta noted).
- **Smoke** (real Electron, the project's method): place `text-fx`, exercise each
  `effect`, scrub — confirm preview renders; export a short clip — confirm
  preview==export. Verify font loads (no fallback flash) for both families incl. CJK.
- **Determinism**: confirm the conformance/determinism e2e covers (or is extended
  to cover) `text-fx`; a deterministic `f(t)` Motif must pass byte-identical
  cross-run even with all-distinct frames.
- i18n: prop labels fall back to the raw key via `defaultValue` — optionally add
  `property_panel.props.*` + picker label keys (nice-to-have, not blocking).

---

## Risks / watch-items
- **Cross-language PropSpec drift** (Rust + 2× TS) — mitigated by the parity guard (1.2).
- **Non-exhaustive UI switches** — add `never` guards (1.3/1.4) so future variants fail loudly.
- **Color alpha loss** on UI edit of `bg_color` — known/accepted (matches existing behavior); default stays transparent.
- **CJK font binary bloat** — measure & record; this was an accepted tradeoff.
- **Karaoke smooth-wipe + outline interaction** — `paint-order: stroke fill` keeps
  the stroke stable while the fill region animates; verify the wipe edge stays crisp.

## Sequenced checklist
1. [ ] Rust PropSpec: `Enum` + `String.multiline` + validation + `NotInEnum` error + tests.
2. [ ] TS mirrors (ipc + catalog) + `propValueValid` enum case + parity guard test.
3. [ ] Picker UI: `defaultPropValue` + `PropField` enum/textarea + exhaustiveness guard.
4. [ ] Panel UI: `EnumPropField` + `StringPropField` multiline + exhaustiveness guard.
5. [ ] Layer-1 green (cargo + vitest + tsc); existing built-ins unaffected.
6. [ ] `text-fx/manifest.json` (Rust) + TS `builtin/text-fx/manifest.json`.
7. [ ] `text-fx/index.html`: layout + styling + markup parser + 3 effects + font load.
8. [ ] Bundle fonts to `assets/`; measure CJK size; declare in manifest.
9. [ ] Register: `builtin_motif!`, `BUILTIN_IDS`, `builtins()`, update starter-set tests.
10. [ ] Layer-2 green (cargo + build) + real-Electron smoke (3 effects, export, fonts) + determinism.
```
