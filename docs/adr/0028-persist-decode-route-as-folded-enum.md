---
status: accepted
---

# Persist the Decode Route as a folded enum (source of truth), not as flat flags

## Context

A source's [Decode Route](../../CONTEXT.md#decode-routing) — Bypass /
DirectExport / Proxied — is a deep, typed, unit-tested concept inside
`jobs::proxy_decision` (`ProxyRoute { export, preview }`, with the legality
invariant `preview == Original ⟹ export == Original` enforced by an
`unreachable!()` in `job_for`). But that enum is thrown away at the persistence
seam: it is flattened into four independent `MediaItem` fields
(`proxy_bypassed`, `export_uses_original`, `proxy_path`, `quick_proxy_path`) and
then re-derived ad hoc at ~17 read sites across the renderer
(`previewPlaybackPathFor`, `exportPlaybackPathFor`, `importOptimizeStatus`,
`sourcesNeedingPreflight`, …). The invariant holds only where the route is
*decided*, never where the flags are *written* or *read*: the patch applier is a
plain merge, so the illegal fourth boolean combination and route↔path
contradictions are representable, and the real bug surface (which flag mix is
legal, which file each mode decodes) is exercisable only by a real import +
decode.

ADR 0009 introduced the two-axis route but explicitly took "No persisted-schema
change" as a non-goal. This ADR overturns that one non-goal.

## Decision

Persist the Decode Route as the **source of truth**, with readiness folded in:

- **A three-variant `DecodeRoute` enum** (`bypass` / `direct-export` /
  `proxied` on the wire) replaces the two booleans. The illegal route is
  unrepresentable by construction — the two booleans were a lossless 1:1 image
  of the three legal routes plus exactly one illegal combination.
- **Readiness paths fold into the variants** rather than living as orthogonal
  fields: `Bypass` (no payload), `DirectExport { quick_proxy? }`,
  `Proxied { quick_proxy?, full_proxy?, format_version }`. A route↔path
  contradiction (a Bypass that carries a proxy) is then also unrepresentable;
  the `Option` payloads still carry "derivative not landed yet" readiness.
- **One resolver** — a pure, persisted-only `resolveDecode(media) -> { route,
  previewPath, exportPath }` — replaces the ~17 ad-hoc readers. A thin,
  TS-only **session overlay** (`previewPathLive`, `importStatus`) layers the
  machine-specific [Session bridge](../../CONTEXT.md#decode-routing) on top by
  injection, keeping the core deterministic.
- **The shape is a cut-over schema bump.** Per the data-model's no-migration
  policy, projects below the new `SCHEMA_VERSION` are rejected and re-created;
  no carry-forward.
- **Cross-language**: the enum is hand-mirrored Rust↔TS like the rest of the
  data model, guarded by a tiny three-string wire golden (the `snapFrameGolden`
  / `roleGateGolden` discipline). `decide()` / `job_for` stay Rust-only;
  `resolveDecode` stays TS-only — there is no logic twin to share, so the
  `weftcut-eval` leaf (WYSIWYG math only) is deliberately not involved.

## Considered options

- **Derive the route as an in-memory view, keep the flags on disk** (no schema
  change). Rejected: it only moves the contradiction from disk to memory — the
  illegal states stay representable in the persisted shape, defeating the point.
- **Persist the two-axis struct `{ export, preview }`.** Rejected: four
  representable combinations re-admit the `{ FullProxy, Original }` illegal
  state the flat enum closes. The struct stays the in-memory reasoning shape
  `decide()` returns; only the *stored* form collapses to three variants.
- **Enum + flat paths + a `validate()` consistency invariant.** Rejected in
  favour of folding paths into the variants: an invariant *catches*
  contradictions, folding makes them *unrepresentable* — the same standard we
  applied to the route itself.

## Consequences

- Illegal flag combinations and route↔path contradictions become
  unrepresentable on disk and in memory; `resolveDecode` is a total match with
  no defensive branches.
- The flag-interaction matrix — previously integration-only — becomes an
  exhaustive pure unit test over `route × readiness`, no WebCodecs required.
  Route-correction (DirectExport → Proxied) becomes a pure, tested transition,
  closing a previously untested path.
- The background job → state-commit flow is rewritten: a derivative landing
  updates its variant's payload instead of setting an independent flat field
  (`MediaDerivativesPatch` changes shape accordingly).
- `importOptimizeStatus` is re-expressed as a total function over
  `(resolveDecode, session)` with reconciled signal precedence; its six output
  states and dialog UX are frozen.
- The dead `preview::with_proxies_substituted` (no callers, ignores the route)
  is removed.
- Existing projects are rejected on open and must be re-created — acceptable
  pre-release under the cut-over policy.

## References

- ADR 0009 — two-axis proxy decision (this ADR supersedes its "no
  persisted-schema change" non-goal).
- ADR 0011 — export master vs preview proxy (the two payload kinds).
- ADR 0025 — shared `weftcut-eval` wasm leaf (deliberately not extended here).
- [`CONTEXT.md`](../../CONTEXT.md), [`docs/data-model.md`](../data-model.md).
