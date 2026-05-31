# Import-time decodability probe — eager route correction + export auto-wait

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-31

## Problem

DirectExport sources (HEVC/AV1/VP9, 8-bit) are routed by the static Rust
decision (`jobs::proxy_decision::decide` → `QuickOnly`) to `export_uses_original
= true` with only a 720p preview proxy and **no full proxy**. Whether *this
machine's* WebCodecs can actually decode the original is confirmed lazily, at
**export start**, by `preflightExportSources` (`runExport.ts`): it probes each
still-`export_uses_original` source with `probeSourceDecodable`, and on failure
enqueues a full proxy and **throws**:

> `Can't decode <labels> directly on this machine — preparing optimized media.
> Retry the export shortly.` (`runExport.ts:138`)

The user sees this as a hard "export failed" at the moment they try to export —
the worst possible time — and must manually retry later. The complaint: surface
decodability earlier, at import, so the optimized media is ready before export
and this scary failure never appears.

This is **not** a request to revive the deleted `DecodeCaps` oracle (ADR 0010):
that was a *predictive, machine-wide, persisted, generic-profile* guess. This
moves the *actual per-file* `probeSourceDecodable` earlier in time — which
preserves ADR 0010's "ground truth by trying" and completes its own "optional
tidiness: clear the now-shadowed `export_uses_original`" note.

## Scope

A follow-on to ADR 0010 (lazy decodability). Pre-release, so breaking changes
are fine; no persisted-schema migration is introduced. Touches the webview
export path, one Rust command, and a new webview background sweep. The Rust
import decision (`decide`) and the preview path are unchanged.

## Core decision

Probe decodability **eagerly, in the background, right after import** (and on
project open), and on failure **correct the route** — demote the source from
DirectExport to a normal full-proxy source. By export time the proxy is usually
ready; for the residual window where it is still encoding, export **auto-waits
and auto-starts** when the proxy lands. The "Can't decode … on this machine"
string is removed entirely.

The load-bearing insight: probing earlier is **insufficient by itself**.
`exportPlaybackPathFor` returns the original for `export_uses_original = true`,
so unless the route is corrected, the export pre-flight re-probes the original
and re-throws. Clearing `export_uses_original` on probe-failure is what converts
the failure into a "preparing" state.

## Design

### 1. Import-time decodability sweep (webview, new)

A new effect in `App.tsx`, alongside the existing media-pool subscription, runs
a background probe sweep. The set to probe is **exactly**
`sourcesNeedingPreflight(mediaById)` — the same `export_uses_original &&
!proxy_path` predicate the export pre-flight already uses — minus a
session-scoped memo of sources already probed or in-flight.

For each such source, **sequentially** (one at a time), run
`probeSourceDecodable(originalAssetUrl)`:
- **Success** → mark probed; leave the source as DirectExport (no proxy work).
- **Failure** → call `ensureFullProxy(mediaId)` (route-correcting, see §2).

Sequential + one-frame-and-close (the probe already does `frame.close()` then
`decoder.close()`) keeps the sweep from competing with preview/quick-proxy
decoders for the WebCodecs buffer pool (see [[webcodecs-buffer-pool]]).

Termination: a decodable source stays `export_uses_original = true` forever (it
never gains a `proxy_path`), so the predicate would re-select it on every effect
run — the session memo is what stops re-probing it. A failed source is
route-corrected (`export_uses_original = false`), so it drops out of the
predicate naturally. The sweep watches the media pool, so it is **source-
agnostic**: it picks up sources imported by user drop, by MCP, or surfaced on
**project open** — including a project authored on a capable machine and opened
on an incapable one (its DirectExport sources re-probe and correct). See Edge
cases for the reopen-churn interaction.

### 2. `ensure_full_proxy` becomes a route-correction command (Rust)

Extend the existing `ensure_full_proxy` command (`commands.rs:2247`): **before**
enqueuing the full proxy, patch the media via `set_media_derivatives` with
`MediaDerivativesPatch { export_uses_original: Some(false), .. }`, then
`enqueue_full_proxy`. The patch field already exists and is applied by the actor
(`state/actor.rs:2749`).

Effect chain:
- `exportPlaybackPathFor` returns `null` while the proxy encodes, then the proxy
  once `proxy_path` lands (proxy takes precedence over the original).
- The source leaves `sourcesNeedingPreflight`, so the export pre-flight skips it.
- `mediaReadiness` returns `{ ready: true }` once the DirectExport source's
  quick proxy lands (it had one queued at import), so the clip stays
  draggable/usable on the timeline — only *export* waits. Worst case is a brief
  not-ready transient if the route is corrected before the quick proxy lands;
  sub-second and cosmetic.

Both callers — the new import sweep and the export pre-flight backstop — share
this one command. Idempotent: re-clearing the flag is a no-op, and the command
already no-ops the proxy enqueue when a full proxy is present/queued.

### 3. Export auto-wait + auto-retry (webview)

`runExport`'s pre-flight no longer throws. Restructured:
1. Pre-resolve URLs (as today).
2. Pre-flight probe over still-`export_uses_original` **referenced** sources
   (the race backstop — covers the case where the user exports before the import
   sweep ran). On failure call `ensureFullProxy` (route-correct), then fall
   through to the wait gate. **No exception thrown.**
3. Compute the **wait set** = referenced video sources whose
   `exportPlaybackPathFor` is `null` (no ready export path), **plus the ids the
   step-2 pre-flight just route-corrected**. The union matters: `ensureFullProxy`
   clears `export_uses_original` in Rust and the cleared flag only reaches the
   store after a `project:changed` round-trip — reading the store too soon would
   still show the source as DirectExport (path = original, not `null`) and let the
   export proceed on the undecodable original. Including the just-failed ids
   directly closes that race. If the set is empty, launch the export Worker as
   today. Otherwise classify each by `proxyState`:
   - **`failed`** → do **not** wait. Transition to `{ kind: "error" }` with an
     actionable message ("Couldn't prepare <label> for export — the file may be
     corrupt or unsupported; re-import it"). The clip already shows `proxy_failed`
     in the media pool; manual retry is re-import now (or the future Plan-3
     per-clip "Generate proxy" action). See Edge cases.
   - **`pending` / no terminal event** → wait.

When the wait set has only waitable (pending) sources, `App` enters a new export
state `{ kind: "preparing", sources: [{ id, label }] }` (rendered by
`ExportPanel` next to the existing `starting | progress | complete | error`). It
reuses the existing `media:job_*` listener (already feeding `proxyState`) to show
per-source proxy progress, and when **all** wait-set proxies reach `proxy_path`
set (`proxyState` "ready"), it **automatically launches the export** — the user
does nothing. A `media:job_error` on a needed proxy transitions to
`{ kind: "error" }` (same actionable message). Cancelling/closing the `preparing`
panel stops the wait and does **not** auto-launch; the in-flight proxy keeps
encoding in the background (no Worker was started, so nothing to abort).

Orchestration lives in `App` (where `proxyState` and the `media:job_*` listener
already are): on a non-empty wait set, show `preparing`, await those proxies via
the existing events, then re-invoke `runExport`. The second invocation finds the
sources route-corrected (so the pre-flight skips them) and their proxies ready
(so `exportPlaybackPathFor` returns the proxy) and proceeds cleanly.

### 4. Reference-range scoping + message removal

- **Scope to referenced sources.** Today `runExport` receives the whole pool
  (`store.mediaById`) and throws if *any* video lacks a ready export path —
  including unused imports (`runExport.ts:112`). The readiness check, pre-flight,
  and wait set must be scoped to the video sources actually referenced by
  timeline layers within `[startUs, endUs]`, or an unused undecodable import
  would hang the export. This also fixes the existing over-strict full-pool throw.
- **Remove the scary string.** Delete the "Can't decode … directly on this
  machine — preparing optimized media. Retry the export shortly."
  (`runExport.ts:138`). With auto-wait the pre-flight feeds the wait gate instead
  of throwing, so the only export-time error messages left are genuine failures
  (proxy job error, missing/unavailable media, encoder error).

## Why this is consistent with ADR 0010

ADR 0010 removed the *oracle* — a persisted, machine-wide, generic-profile
prediction — and chose "ground truth by trying." Its line "decodability is an
export-only question" is about *where failures can occur* (preview is H.264-only,
so only export can fail), **not** a requirement that the probe *run* at export
time. Front-loading the export-axis probe keeps the philosophy intact and uses
the same `probeSourceDecodable` ground truth. No persisted capability cache is
reintroduced: the probe outcome "persists" for free via the generated
`proxy_path` (reopening hits the proxy and never re-probes the corrected source).

## Consequences / trade-offs

- **Capable machine (the common case — WebView2 148 decodes H.264/HEVC/AV1/VP9,
  incl. Hi10P, see [[webcodecs-hi10p]]):** one sub-second probe per non-H.264
  import; **no** master proxy generated. ≈ zero cost. The scary export-time
  failure is gone and the wait set is almost always empty.
- **Incapable machine:** every imported non-H.264 source is route-corrected and
  gets a **master proxy** (source-res, CRF 18 — much heavier than the 720p quick
  proxy), *including clips never placed or exported*. Lazy export-time only paid
  for exported clips; eager pays for all imports. Sequential probing of N
  undecodable sources adds ≈ N × 2.5 s background latency before all proxies are
  queued. This is the accepted cost of choosing eager probing (approach A).
- **No persisted-schema change, no migration.** Recovery sets `export_uses_original
  = false` + `proxy_path`; existing resolvers handle the rest.
- **Residual race fully handled:** exporting before the sweep runs hits the
  pre-flight backstop, which route-corrects and feeds the same auto-wait — never
  the scary string.

## Edge cases

- **Reopen churn (self-healing).** Workspace open re-runs `enqueue_for_media`
  per media (`commands.rs:1132`), which short-circuits only `proxy_ready ||
  proxy_bypassed`. A route-corrected source whose full proxy **completed**
  (`proxy_path` set) is `proxy_ready` → short-circuited → stable, never
  re-probed. One whose proxy was **interrupted** (app closed mid-encode,
  `proxy_path` still null) is **not** short-circuited → `spawn_proxy_decision` →
  `decide` re-routes it back to `export_uses_original = true` → the sweep
  re-probes and re-corrects. So an incapable-machine project with an unfinished
  proxy re-probes that source on each reopen until its proxy completes once —
  matching ADR 0010's "incapability re-discovered per session." A brief window
  exists where `export_uses_original` is true again on open; if the user exports
  in it, the export pre-flight backstop re-corrects. Bounded and safe.
- **Full proxy generation fails (`job_error`).** After route-correction the
  source has `export_uses_original = false`, no `proxy_path`, and is no longer in
  `sourcesNeedingPreflight`, so the sweep will not retry it; `mediaReadiness`
  reports `proxy_failed`. If a **referenced** source is `proxy_failed`, export
  errors immediately with an actionable message (no auto-retry — chosen over
  retry loops that mask corrupt/unsupported files). Recovery is re-import now, or
  the future Plan-3 per-clip "Generate proxy" action. On reopen the source
  re-routes to DirectExport and the sweep re-probes (a fresh attempt).
- **Concurrent double-probe.** The background sweep and the export pre-flight can
  probe the same source at once → two `ensureFullProxy` calls. The command is
  idempotent (no-op when a proxy is present/queued), so only a redundant probe is
  wasted, never a duplicate proxy.
- **Quick proxy not cancelled.** Route-correction enqueues a full proxy but does
  not cancel the source's already-queued quick proxy; both run (bounded by the
  2-wide ffmpeg semaphore). The quick proxy gives preview a frame sooner; once
  the full proxy lands, the resolvers prefer it. Minor wasted work, preview
  benefits.
- **First-keyframe probe is not a whole-file guarantee.** `probeSourceDecodable`
  decodes one key packet. A source can pass yet hit an undecodable frame mid-file
  during the actual export, which fails in the Worker. Pre-existing (ADR 0010);
  out of scope here. Auto-wait simply no longer pre-empts it.
- **Multiple references / mixed timeline.** The wait set is by distinct media, so
  one proxy serves all clips referencing it; H.264 sources are skipped (decodable
  everywhere). No special handling.

## Non-goals

- Re-introducing any persisted capability cache (ADR 0010 non-goal).
- Changing the Rust import decision (`decide` stays static) or the preview path
  (preview stays H.264-only).
- New persisted fields or `.vproj` migration.
- The deferred "Plan 3" per-clip Generate/Remove-proxy UI and
  `auto_generate_preview_proxy` off-switch, beyond sharing `ensure_full_proxy`.
- Deferring the master proxy to timeline placement (the "A variant" considered
  and rejected — it departs from WeftCut's eager import-proxy model and needs a
  new placement trigger).

## Testing

- **`ensure_full_proxy` (Rust):** asserts it patches `export_uses_original =
  false` and enqueues the full proxy; idempotent when a proxy already exists.
- **Import sweep (webview, failure injection — the dev machine decodes
  everything):** with a stubbed `probeSourceDecodable`, assert the sweep selects
  exactly `sourcesNeedingPreflight`, probes sequentially, calls `ensureFullProxy`
  only on failure, memoizes (no re-probe of a decodable source across re-runs),
  and drops corrected sources from the set.
- **Export pre-flight + auto-wait:** pre-flight failure no longer throws; it
  route-corrects and produces a non-empty wait set. Wait-set classification: a
  `pending` source is waited on and the export auto-launches once it reaches
  `ready`; a `failed` source errors immediately **without** waiting (and a needed
  proxy `job_error` mid-wait also errors). Cancelling `preparing` stops the wait
  and does not auto-launch. Reference-range scoping: an unused undecodable import
  is **not** in the wait set.
- **Reopen churn:** a route-corrected source with a completed `proxy_path` stays
  bypassed on reopen (no re-probe); one with a null `proxy_path` re-routes to
  `export_uses_original` and is re-selected by the sweep.
- **Resolver (pure):** a route-corrected source (`export_uses_original = false`,
  no `proxy_path`) → `exportPlaybackPathFor` null; → proxy once set.
- **Smoke (capable machine):** import HEVC → sweep probes, passes, no master
  proxy; export immediately → wait set empty, exports from original. Stub
  `probeSourceDecodable` to fail → import sweep route-corrects + enqueues proxy;
  export shows `preparing` then auto-starts when the proxy lands; no scary string.

## Open questions

1. Sweep concurrency on incapable machines: keep strictly sequential (safe for
   decoder contention) or allow 2 in parallel to halve the N × 2.5 s queue-up
   latency? Default sequential; revisit only if incapable-machine bulk import
   feels slow.
2. Pre-flight deadline (2.5 s today) — unchanged; tune only if a slow real HW
   decoder trips a false "undecodable" (safe direction: an extra proxy).
