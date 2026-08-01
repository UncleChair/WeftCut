---
status: accepted
---

# Composition duration auto-fits to layers unless the user pins it

`Composition.duration_us` tracks `max(layer.t_end_us)` automatically — growing **and shrinking** with every layer edit — *except* when the user (or an agent) has explicitly set the duration via `set_composition { duration_us }`, at which point the value is "pinned" and stops following layers until the pin is cleared via a new `fit_composition_to_layers` command.

A new field on `Composition` carries the bit:

```rust
pub struct Composition {
    // ...existing fields...
    pub duration_us: TimeUs,
    #[serde(default)]
    pub duration_pinned: bool,
}
```

Default is `false`. Projects saved before this change deserialize with the default, and the next layer edit reconciles the duration to the live `max_end` — which is what the user already saw in the timeline, so the first load self-heals.

## Rule table

| Edit | `duration_pinned` | Effect on `duration_us` |
|---|---|---|
| `add_layer` / `move_layer` / `trim_layer` (Out) / `duplicate_layer` extends past current duration | `false` | duration grows to `max_end` |
| Same paths, `max_end` shorter than current | `false` | duration shrinks to `max_end` |
| `delete_layer`, `trim_layer` (In edge), or any edit that reduces the high-water mark | `false` | duration recomputes to `max_end` (may shrink) |
| Any edit | `true` | duration unchanged unless `max_end > duration_us`, in which case duration grows to `max_end` and **the pin stays set** (overflow guard, not auto-fit) |
| `set_composition { duration_us: D }` (explicit user/agent) | either | `duration_us = D`, **pin set to `true`** |
| `fit_composition_to_layers` (new) | either | `duration_us = max_end`, **pin cleared to `false`** |

## Rationale

The current `auto-extend`-only invariant exists to protect a legitimate user override — a 60 s short with a 45 s last clip should stay 60 s, not snap back to 45 s the moment a layer is touched. That intent has to survive.

But the rule doesn't distinguish a passive grow from a deliberate override. Any historical layer that once lifted the high-water mark leaves the value stuck there permanently — past-tense state that no current layer represents. Three places read the stale value and feel wrong:

- `App.tsx:999` — preview-meta strip ("Duration: 10.63 s" when the timeline has 10.00 s of content)
- the transport's "go to end" button (seeks past the last visible frame into the empty tail)
- `render/worker/runExport.ts:69` — export end-time, so a clean render adds a black/silent tail

The renderer's `Compositor.playableEndUs()` (`render/Compositor.ts:449`) already exists as a local workaround: it returns `max(enabled-layer.t_end_us)` and feeds the playback engine's auto-pause specifically because composition duration can outlast the material. That fixes auto-pause but not the labels or the export — and is evidence that the data-model field has been confusing enough to warrant a parallel computation in the renderer. Lifting the fix into the model itself replaces the workaround.

A boolean pin separates the two semantics cleanly. The pin flips on only when `set_composition { duration_us }` is called; passive layer edits never set it. `fit_composition_to_layers` is the explicit "I want auto-tracking back" affordance for users who pinned and changed their mind.

## Trade-offs

- **One extra serialized field.** `#[serde(default)]` keeps old projects readable; the first layer edit re-syncs duration to `max_end`, which matches what the user already sees. No migration step.
- **A pinned project still grows.** Setting the pin doesn't freeze the value — `max_end > duration_us` always wins, otherwise `add_layer` would silently push a layer past the composition end. The invariant `duration_us >= max(layer.t_end_us)` is preserved.
- **Passive shrinks ride existing history entries.** The layer-edit commit that triggered the shrink owns the duration delta; no separate history entry. Older snapshots stay coherent because `duration_us >= max_end` already held in each one and continues to hold.

> **Superseded (undo semantics only).** The two bullets that followed here said a
> `set_composition { duration_us }` patch records one history entry, and that
> `duration_pinned` must therefore *not* travel through the canvas fan-out
> because it is "editing state, not canvas setup". Both were premises about
> keeping older snapshots coherent, and both are now obsolete: the composition
> envelope — duration and pin included — is unrecorded, and the fan-out applies
> the patch as a **transform run per snapshot** rather than a value copied
> across them. `apply_duration_autofit` therefore floors the pinned value at
> *each* snapshot's own high-water mark, which preserves the very invariant
> those bullets were protecting (`duration_us >= max_end`, per snapshot) without
> a history entry. Everything else in this ADR — the auto-fit rule, the pin, the
> overflow guard, `fit_composition_to_layers` — stands unchanged.
> Current contract: `docs/features.md#undo-stack-scope`.

## Code touch points

- `state/composition.rs` — add `duration_pinned: bool` with `#[serde(default)]`.
- `state/actor.rs`
  - Extract a helper `apply_duration_autofit(project)`:
    - compute `max_end` across all layers in all tracks
    - if `!project.composition.duration_pinned`: `duration_us = max_end`
    - else if `max_end > duration_us`: `duration_us = max_end` (overflow guard, pin retained)
  - Replace the four existing extend-only blocks (`apply_add_layer` ~2849, `do_duplicate_layer` ~2062, `apply_move_layer` ~3214, `apply_trim_layer` Out branch ~3569) with `apply_duration_autofit`.
  - Add `apply_duration_autofit` calls to two new sites: `apply_delete_layer` (~2858) and `apply_trim_layer`'s In branch (~3432).
  - `do_set_composition` — when the patch carries `duration_us`, set `duration_pinned = true` in the same commit.
  - New `do_fit_composition_to_layers(actor)` — clear pin, run `apply_duration_autofit`, commit with `DiffHint::Composition`.
- `mcp/mod.rs` — register the new `fit_composition_to_layers` tool (no args, returns void). Update `set_composition`'s docstring to mention the pin side effect.
- `docs/data-model.md` (line 364) — replace `composition.duration_us ≥ max(layer.t_end_us) | auto-extend` with the two-state rule.
- `docs/features.md#undo-stack-scope` — passive duration shrinks ride on the layer-edit entry; the row for `set_composition`-with-duration is unchanged.
- `render/Compositor.ts` — keep `playableEndUs()` for now (it's a thin convenience over the same data), but the doc-comment that motivates its existence should be retired: the model no longer has the gap that prompted it.
- Tests
  - `add_layer` on an unpinned project extends *and* shrinks duration to fit
  - `delete_layer` / `trim_in` on an unpinned project shrinks duration
  - `set_composition { duration_us }` sets pin; subsequent passive edits don't change duration
  - `fit_composition_to_layers` clears pin and snaps duration to `max_end`
  - Pinned project: adding a layer past duration extends (overflow guard) and leaves pin set
  - Old project (saved without `duration_pinned`) loads with `duration_pinned = false` and self-heals on first edit

## UI surface

- **Preview-meta strip (`App.tsx:999`) is read-only.** It continues to display `summary.duration_us`; no click-to-fit affordance, no pin indicator. The value is correct by construction now, which is all this site needs.
- **Pin controls live in the Settings panel's Composition section, not inline.** Tools → Settings… opens `SettingsPanel`, which carries a Composition section with:
  - A "Pin composition duration" checkbox bound to `composition.duration_pinned`. Toggling on pins the current duration via `set_composition { duration_us: current }`; toggling off invokes `fit_composition_to_layers`.
  - A "Fit composition to content" button that invokes `fit_composition_to_layers` directly (useful when the user has *added* layers since pinning and wants to recompute against the new high-water mark — flipping the pin checkbox off would also do this, but a direct action button reads better).

  Both controls are pure mutations through the existing actor surface, so MCP gets them for free via the new `fit_composition_to_layers` and the existing `set_composition` tools.
- **`replace_state` (open/new project) preserves the saved `duration_pinned`.** A project saved with `duration_pinned = true` reopens pinned. The serde default handles legacy projects (which load unpinned and self-heal on first edit, as covered above).
