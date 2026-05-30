# Remove the DecodeCaps oracle — lazy decodability (Piece B)

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-30

## Problem

The export axis of `jobs::proxy_decision::decide` answers one machine-dependent
question for non-H.264 sources: *will WebCodecs decode this original on this
machine?* Today that answer comes from a **predictive, machine-wide, persisted,
cross-process oracle**:

- `src/decode/probeDecodeCaps.ts` runs `VideoDecoder.isConfigSupported` once at
  startup against a generic 4K matrix for HEVC/AV1/VP9,
- reports the result through the `report_decode_caps` IPC command,
- which persists it to `decode_caps.json` via `decode_caps.rs`
  (`DecodeCapabilityStore`),
- read synchronously by Rust at import and fed to `decide` as `&DecodeCaps`.

This is the machinery the import-decision simplification set out to remove. It is
a *guess* (generic profile, not the actual file; `isConfigSupported` can
over-report software decoders) that can be wrong on a specific file — which is
why the DirectExport design already **owed** a decode-failure recovery
("Plan 3") as a backstop. Piece B stops guessing and uses ground truth: the
webview discovers decodability by actually trying, and the owed recovery becomes
the primary path.

DirectExport for HEVC/AV1 **must be preserved** (decode the original at export on
capable machines — the reason DirectExport exists). So "remove the oracle" is not
"route all non-H.264 to a proxy"; something must still answer the decodability
question. Piece B answers it lazily.

## Scope

Piece B of the import-pipeline work. Piece A (two-axis `decide` + `job_for` +
None-GOP fix, ADR 0009) is landed. The project is pre-release, so breaking
changes are acceptable (a stale `decode_caps.json` is simply orphaned).

## Core decision: lazy / truth-by-trying

Delete the oracle. Split the export-decodability question into a **static** part
(answerable in Rust, machine-independent) and a **machine-dependent** part
(answered by trying, at the one place it matters):

- **Static (Rust `decide`):** a source is export-decodable-in-principle iff it is
  8-bit (browser-friendly pixfmt) **and** its codec is in the WebCodecs family
  `{h264, hevc, av1, vp9}`. 10-bit/HDR or a non-family codec (ProRes, MPEG-2, …)
  → `FullProxy`. This is a static fact, not a machine guess.
- **Machine-dependent (webview, at export):** whether *this machine's* WebCodecs
  actually decodes a family codec is confirmed by a **pre-flight decode** when an
  export run is about to read an original. Success → use the original. Failure →
  abort before encoding, generate a full proxy, ask the user to retry.

The load-bearing simplification: **decodability is purely an export-axis
question.** The preview axis is H.264-only (`source_is_safe_to_bypass`), so after
one small resolver change (below) preview never decodes a non-H.264 original at
all. So the entire new failure-handling surface lives on the **export** path; the
preview path needs no decoder-failure machinery.

## Design

### 1. `decide` — static export axis (drop `caps`)

`decide(media, source_gop_secs)` loses its `&DecodeCaps` parameter. The export
axis becomes a pure static predicate:

```text
export = if export_decodable_statically(media) { Original } else { FullProxy }
```

`export_decodable_statically(media)` = browser-friendly (8-bit) pixfmt **and**
codec ∈ `{h264, hevc, av1, vp9}` (reusing the existing `codec_is_h264/hevc/av1/vp9`
helpers; **VP8 is intentionally excluded** — there is no `codec_is_vp8` helper and
VP8 is effectively extinct in modern footage, so it routes to `FullProxy`, an
acceptable missed optimization).

This replaces the `caps`-taking `decodable_directly`. The preview axis
(`source_is_safe_to_bypass`), `job_for`, and the Piece A invariant are unchanged:
`source_is_safe_to_bypass` requires H.264 + browser-friendly pixfmt, and H.264 ∈
the family, so `safe_to_bypass ⟹ export_decodable_statically` still holds →
`{FullProxy, Original}` remains `unreachable!`.

### 2. Delete the oracle

- `apps/desktop/src/decode/probeDecodeCaps.ts` (probe, `PROBE_CONFIGS`,
  `summarizeProbe`, `probeAndReportDecodeCaps`).
- `apps/desktop/src-tauri/src/decode_caps.rs` (`DecodeCaps`,
  `DecodeCapabilityStore`).
- The `report_decode_caps` Tauri command (`commands.rs`).
- The startup call to `probeAndReportDecodeCaps()` and the
  `DecodeCapabilityStore` managed-state registration.
- The `reportDecodeCaps` function + `DecodeCaps` type in `ipc/`.
- The `caps` read in `jobs/mod.rs::spawn_proxy_decision`
  (`app.try_state::<DecodeCapabilityStore>()…`) and the `caps` argument to
  `decide`.

`decode_caps.json` on disk is left orphaned (harmless, pre-release).

### 3. Preview resolver — eliminate the non-H.264-original path

`previewPlaybackPathFor` (`state/projectStore.ts`) currently falls through to the
original when `proxy_bypassed || export_uses_original`. Drop the
`export_uses_original` term from the **preview** resolver only:

```text
previewPlaybackPathFor: proxy_path → quick_proxy_path → (proxy_bypassed ? original : null)
exportPlaybackPathFor:  proxy_path → (proxy_bypassed || export_uses_original ? original : null)   // unchanged
```

Effect: a DirectExport source (`export_uses_original = true`, `proxy_bypassed =
false`) previews from its quick proxy, or shows nothing (held/blank frame) in the
brief window before the quick proxy lands — it **never** falls through to the
original. Since DirectBoth is H.264-only (`proxy_bypassed = true`), preview reads
an original only when that original is H.264 (universally decodable). **Preview
therefore never decodes a non-H.264 original**, which removes the
incapable-machine failure path entirely instead of handling it.

Cost (acceptable): on a *capable* machine, an HEVC clip previewed in the
sub-second gap before its quick proxy lands shows a held/blank frame instead of
briefly decoding the HEVC original. That brief direct-HEVC preview would have
scrubbed poorly anyway (the reason the proxy exists), so blank-until-proxy is a
clean trade.

### 4. Export pre-flight + recovery (the new work — export only)

Before an export run launches the export Worker, on the **main thread**, run a
decodability pre-flight over each *distinct* timeline source whose export path is
a **non-H.264 original** (proxied sources and H.264 originals are skipped —
H.264/proxies are universally decodable):

`probeSourceDecodable(assetUrl): Promise<boolean>` —
1. open via mediabunny, `getDecoderConfig()`, `VideoDecoder.configure(config)`
   inside a try/catch (a synchronous `configure` throw ⇒ **undecodable**);
2. decode the first key packet and **race three outcomes**:
   - a decoded frame arrives ⇒ **decodable**;
   - the decoder's `error` callback fires ⇒ **undecodable**;
   - a deadline (~2–3 s) elapses with neither ⇒ **undecodable**.

The timeout arm is mandatory, not defensive: WebCodecs failure is not always a
clean error — a `VideoDecoder` can silently stall (no error, no output,
`decodeQueueSize` frozen; see [[webcodecs-buffer-pool]]), and Chromium's
HEVC-without-extension behavior has been version-inconsistent (sync throw / async
error / nothing). "Undecodable" is defined as **errored OR produced no frame
within the deadline OR threw on configure**.

Outcomes:
- **All decodable** → launch the export Worker as today.
- **Any undecodable** → do **not** launch the Worker (never produce a partial
  file). For each undecodable source call a new command `ensure_full_proxy(media_id)`
  to enqueue a full proxy, and surface one LogBus/toast message: "*X* can't be
  decoded directly on this machine — preparing optimized media; retry the export
  shortly." When the proxy lands (`proxy_path` set), `exportPlaybackPathFor`
  prefers it automatically, so the retry succeeds via the proxy.

### 5. `ensure_full_proxy` command

A new Tauri command `ensure_full_proxy(media_id)` that enqueues the full-proxy job
(`jobs::spawn_proxy`) for a media item if one is not already present/queued. This
is the same machinery the deferred "Plan 3" per-clip *"Generate proxy"* action
needs, so they share one command.

### 6. State model — no migration

The recovery is "generate a full proxy" → sets `proxy_path` → the existing
resolvers prefer it. **No new persisted field and no migration of
`proxy_bypassed`/`export_uses_original` is required.** This supersedes the Piece A
spec's note that "Piece B reworks the persisted state model" — it does not need
to. (Optional tidiness: clear the now-shadowed `export_uses_original` when a
recovery proxy lands; not required for correctness.)

## Consequences / trade-offs

- **Incapability is re-discovered, not cached.** The oracle's one real value was
  caching machine capability once per session. Pure-lazy re-discovers it: on an
  incapable machine, the first export of each non-H.264 source pre-flight-fails
  and enqueues a proxy; if a recovery proxy is interrupted before completing, the
  next export attempt pre-flight-fails again. So the "one-time-per-file beat" is
  honestly "one-time-per-file-per-session until that file's proxy exists." On a
  capable machine the pre-flight always passes — zero cost. Acceptable, but
  stated rather than silent.
- **Quick-proxy failure → blank preview for that DirectExport source.** With the
  resolver change, a DirectExport source whose quick proxy fails to generate
  previews blank (no fall-through to the original). Quick-proxy generation
  failure is rare and re-enqueues on reopen. Acceptable for v1.
- **VP8 is always proxied** (excluded from the family) — a negligible missed
  optimization.
- **Pre-flight adds a small latency to export start** for non-H.264-original
  projects (decode one frame per such source). Negligible vs. an export.

## Non-goals

- Re-introducing any persisted capability cache.
- A preview-side decode-failure recovery (the resolver change removes the need).
- The deferred "Plan 3" UI (per-clip Generate/Remove proxy, `auto_generate_preview_proxy`
  off-switch) beyond sharing the `ensure_full_proxy` command.
- The `-color_*` quick-proxy fidelity bug (separate task).
- Piece C (playback graceful degradation).
- Widening preview-from-original beyond H.264.

## Testing

- **Rust `decide`:** truth table with the `caps` dimension removed; new cases —
  non-family codec (e.g. `prores`) 8-bit → `{FullProxy, Proxy}`; family codec
  (hevc/av1/vp9) 8-bit → `{Original, Proxy}` (no caps needed); H.264 friendly →
  `{Original, Original}`; 10-bit family → `{FullProxy, Proxy}`. Delete
  `decode_caps` tests.
- **Preview resolver (pure, no stub):** `previewPlaybackPathFor` truth table — a
  DirectExport source (`export_uses_original=true`, no proxy yet) returns `null`
  (NOT the original); returns `quick_proxy_path` once set; a DirectBoth source
  (`proxy_bypassed=true`) still returns the original. `exportPlaybackPathFor`
  unchanged (still returns the original for `export_uses_original`).
- **Export pre-flight (failure injection — required, since the dev machine
  decodes everything):** with a stubbed `VideoDecoder`, assert `probeSourceDecodable`
  returns false on (a) `configure` sync-throw, (b) async `error` callback, (c)
  the silent-stall timeout (no output, no error); and true on a normal decoded
  frame. Assert the export-start flow: any-undecodable → Worker not launched +
  `ensure_full_proxy` called per source + the user message emitted.
- **Smoke:** on a capable machine, export an HEVC project → pre-flight passes,
  export reads the original. Simulate `configure` failure → export aborts before
  the Worker, proxy enqueued, message shown, retry uses the proxy.

## Open questions

1. Pre-flight deadline value (start ~2.5 s; tune if a slow-but-real HW decoder
   on a weak machine trips it — a false "undecodable" only costs an unnecessary
   proxy, the safe direction).
2. Should the pre-flight run once and memoize per-session in-memory (not
   persisted) to avoid re-probing the same source across repeated exports in one
   session? Cheap optimization; defer unless repeated-export friction shows.
