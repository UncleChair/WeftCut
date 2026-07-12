# Proxy source activation — user-opt-in preview proxy (performance) — Design

**Goal:** Turn the decode overlay's already-modeled but inert `source: original | proxy`
axis into a real, user-facing feature. A user opts a project (or an individual clip) onto
the lightweight 720p quick proxy for **smoother preview/scrubbing** of heavy footage — the
Premiere/Resolve "Proxy Mode" model — while export and the original remain untouched. The
feature is **performance-first**: proxy is a speed lever the user reaches for on any clip,
not a compatibility fallback the app applies on its own. The Unsupported-clip card's second
action ("Generate proxy") comes along as a free special case of the same machinery.

This is a **purely additive** bite. It builds a control surface + persistence + an on-demand
build command on top of machinery that already exists: the resolver already accepts the
`source` axis, the quick proxy is already built at import for heavy sources, availability is
already computed in the renderer, and the Compositor's no-flash overlap-swap already handles
the source flip. No import auto-enqueue policy changes, no derivative-job migration, and the
export master is untouched (that retirement waits on export-side decode — a separate bite).

## Prior context adopted as-is

- `docs/preview.md` §Decode engine — the collapsed two-engine model (Standard/`ffmpeg`,
  Lite/`webcodecs`), the **pure** `resolveDecodeEngine`, and the swap `key`
  (`${engine}:${source}:${target}`) that drives the Compositor's no-flash overlap-swap.
- `docs/preview.md` §Proxies + ADR 0009 / 0011 / 0028 — the two proxy artifacts (720p
  short-GOP **quick proxy** for preview; source-res **export master** for export) and the
  folded `DecodeRoute` enum they live in.
- `feedback_native_nle_conventions` — proxy is user opt-in, never an automatic swap.
- `data-model.md` §ProjectSettings — preference-shaped fields, "patched into every history
  snapshot on change rather than recorded, so undo never flips it," written through the
  unrecorded `update_project_settings` mutation (`state/actor.ts` `updateProjectSettings`).

## 1. Core rule

Everything reduces to feeding one boolean the resolver already accepts
(`DecodeResolveInputs.useProxySource`, `decoder/decodeEngine.ts:24`), plus the state,
UI, and build machinery around it:

```
intent(mediaId) = proxy_overrides[mediaId] ?? prefer_proxies      // per-clip override wins over the global toggle
useProxySource  = intent(mediaId) && quickProxyReady(mediaId)     // gate on on-disk availability
```

Data flow:

```
ProjectSettings { prefer_proxies, proxy_overrides }
   → renderer selector store (mirrors, appSettingsStore pattern)
   → PixiPreview.resolveSource: useProxySource = intent && quickProxyReady
   → resolveDecodeEngine (pure)  → swap key flips  …:original:…  →  …:proxy:…
   → Compositor no-flash overlap-swap glides onto the 720p proxy
```

When the user turns proxy on for a clip whose quick proxy is **not** on disk yet, `intent`
is true but `quickProxyReady` is false → the preview keeps decoding the **original** while
the build runs → when the build lands, `quickProxyReady` flips true → the swap `key` changes
→ the existing overlap-swap moves onto the proxy. **No new transition code.**

## 2. State & persistence (Approach: project-scoped `ProjectSettings`)

Add two fields to `ProjectSettings` (Rust `state/` struct + its TS mirror), written **only**
through the unrecorded `update_project_settings` mutation so undo never flips them:

```
prefer_proxies:  bool                    // the global "Prefer Proxies" toggle; default false
proxy_overrides: HashMap<MediaId, bool>  // absent = follow global; true = force proxy; false = force original
```

- The patch shape of `update_project_settings` (`state/actor.ts` `updateProjectSettings`,
  and its Rust twin) extends to carry `prefer_proxies` and per-media override set/clear.
- Stale `proxy_overrides` entries are pruned opportunistically in `remove_media`.
- A thin renderer selector store mirrors both, following `appSettingsStore` conventions
  (atomic selectors only — `feedback_zustand_composite_selector`).

**Semantics:** proxy preference travels *with the project* (Resolve's per-project Proxy
Mode). Undo-immune by construction; no new persistence machinery.

## 3. Resolver wiring + landmine closure

Two edits, both in the decode overlay:

1. **Feed the axis** (`PixiPreview.tsx:181`). Replace the hardcoded `useProxySource: false`
   with the computed `intent && quickProxyReady`. `proxyReady`/`proxyUrl` must reflect the
   **quick proxy specifically**, via a new `quickProxyPath(media): string | null` accessor
   that reads `decode_route.quick_proxy` (`null` for `Bypass`) — not the current
   `resolveDecode(m).previewPath`, which can resolve to the original (`Bypass`) or the
   source-res full proxy (`Proxied` with the quick proxy cleaned).

2. **Close the `ffmpeg × proxy` landmine** (`decoder/decodeEngine.ts`). The proxy branch
   resolves to `webcodecs` **unconditionally**, short-circuited *above* the engine-pin gates:

   ```ts
   const source: DecodeSource = i.useProxySource ? "proxy" : "original";
   if (source === "proxy") {
     return i.proxyReady
       ? done("webcodecs", "ok", i.proxyUrl, "webcodecs on proxy")
       : done("webcodecs", "pending", null, "proxy building");
   }
   // …existing per-setting original handling unchanged below…
   ```

   Rationale: the quick proxy is purpose-built 720p H.264 short-GOP — always
   WebCodecs-decodable — so ffmpeg-on-proxy is both pointless and currently **broken** (the
   proxy branch returns a `convertFileSrc` URL, but the Standard engine needs a file path;
   see the type doc at `decodeEngine.ts:39-43`). Forcing WebCodecs on the proxy is the
   activation *and* the landmine fix in one edit. A documented consequence: turning proxy on
   also **rescues** the pinned-Standard / no-component case, since the proxy decodes via
   WebCodecs regardless of the `decode_engine` setting.

## 4. On-demand "Generate proxy" backend command

A napi command `generate_quick_proxy(media_id)` that enqueues the existing 720p short-GOP
job (`native/src/jobs/quick_proxy.rs`) for a media on demand; its writeback lands
`quick_proxy: Some(path)` in the `DecodeRoute` → summary → renderer → `quickProxyReady`
flips → swap. It is needed only for the **gaps**, since heavy `DirectExport`/`Proxied`
sources already have a quick proxy auto-built at import:

- a quick proxy that was cache-cleaned, or
- the Unsupported-card recovery (Lite engine + a `Proxied`/`NativeSw` source whose quick
  proxy has not been built).

**`Bypass` sources are out of MVP.** They carry no `quick_proxy` field and are already light
(short-GOP H.264 ≤1080p); the global toggle simply leaves them on the original (harmless),
and the "Generate proxy" action is hidden for them. (Generating a proxy for a `Bypass`
source would require a `Bypass → DirectExport` route transition — deferred.)

*Plan-time verification:* confirm whether an on-demand quick-proxy enqueue path already
exists alongside the import fan-out (cf. `ensure_full_proxy` for the export axis) before
adding a new command; reuse if present.

## 5. UI surfaces

- **Global toggle** — a "Prefer Proxies" control (the Premiere program-monitor "Toggle
  Proxies" analogue), primary placement in the preview/transport toolbar, backed by the
  `ProjectSettings.prefer_proxies` field. *(Exact placement finalized in the plan.)*
- **Per-clip override** — a media-pool context action, tri-state
  **Proxy: Auto / Original / Proxy**. Choosing **Proxy** on a source with no quick proxy
  also kicks `generate_quick_proxy`; **Auto** clears the override (follow global).
- **Unsupported card** (`render/UnsupportedClipCard.tsx`) — add a second action,
  **"Generate proxy"**, below the existing "Switch to Standard". It sets a force-proxy
  override for the media + enqueues the build; on completion the card clears and the proxy
  plays. Shown whenever a proxy is buildable (independent of component availability, unlike
  "Switch to Standard").
- **i18n** — new en-US + zh-CN keys for the toggle, the override menu, "Generate proxy",
  and any proxy-active indicator. (The card already routes copy through `t()`.)
- A **proxy-active indicator** (badge on clips/media currently previewing from proxy) is a
  fast-follow, **out of MVP** — the toggle/override state itself is the source of truth for
  what the user turned on, so an indicator adds discoverability, not correctness.

## 6. Edge cases & error handling

- **Cache-cleaned proxy mid-session** → `quickProxyReady` flips false → `useProxySource`
  false → automatic, clean fallback to decoding the original. The `&& quickProxyReady` gate
  *is* the safety net; no special handling needed.
- **Build failure** → surfaced via `LogBus`; the performance path stays on the original, the
  compatibility path (Unsupported card) persists with an error state.
- **Pending build** (performance path) → the original keeps rendering; no black frame,
  because `useProxySource` stays false until the proxy is ready.
- **Genuinely undecodable original + no proxy** → the existing `pending`/Unsupported card
  path is unchanged.

## 7. Testing

- **Resolver unit** (`decoder/decodeEngine.test.ts`): `source: "proxy"` resolves to
  `webcodecs` regardless of `setting` (incl. pinned `ffmpeg` / no component); `pending` when
  intent-but-not-ready; `ok` on `proxyUrl` when ready.
- **Persistence unit** (`state` mutation tests): flipping `prefer_proxies` or a per-media
  override is **not** undoable (rides the unrecorded `update_project_settings` path).
- **e2e** (`e2e/electron`): (a) toggle Prefer Proxies on a heavy `DirectExport` source →
  the decode target swaps to the 720p proxy URL with no black flash; (b) a per-clip
  **Original** override beats the global toggle; (c) Unsupported card → "Generate proxy" →
  build completes → card clears and the proxy plays.

## 8. Scope guardrails (explicit non-goals)

- No change to import-time quick-proxy auto-enqueue (heavy sources keep pre-building; that
  is what makes the toggle an instant win).
- No derivative-job migration (filmstrip/waveform/thumbnails keep reading what they read).
- Export master (full proxy) and export-side decode untouched — the roadmap's
  export-master retirement depends on export-side decode and is a separate bite.
- `Bypass`-source proxy generation deferred (would need a route transition; no perf need).
- Session/export-interface split, unified `DecodedFrame` — unrelated deferred pieces.
