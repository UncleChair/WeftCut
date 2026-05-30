# Export-master resolution — separate the export proxy from preview

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-31

## Problem

The full proxy (`jobs/proxy.rs`) is capped at 1080p (`PROXY_HEIGHT_CAP = 1080`)
and serves **two roles**: the export master *and* — once it lands and
`spawn_proxy` clears the quick proxy — the steady-state **preview** source.

After Piece B (lazy decodability), export reads the full proxy only for the
**non-WebCodecs-decodable** cases: non-family codecs (ProRes, MPEG-2, …) and
10-bit/HDR. For those, a 4K source exports through a 1080p proxy → **resolution
loss** on 4K-output projects. (4K H.264/HEVC are unaffected — DirectExport reads
their original at full res.)

Raising the cap naively would make **preview** scrub a 4K stream (the throughput
problem the quick proxy exists to avoid). The fix is to **separate the two
roles**.

## Scope

Sub-project 2 of the proxy-recipe work (sub-project 1, the color fix, was
investigated and found to be a non-issue). Approach A from brainstorming.

## Design

Split the roles cleanly: **`quick_proxy` = the permanent preview source (720p,
short-GOP, light); `proxy` = a pure export master at source resolution.** No
overlap — `quick = preview, full = export`.

### 1. Full proxy → source-resolution export master (`proxy.rs`)

Recipe (empirically verified — a 3840×2160 source through this produces a valid
**2160p H.264 High, Level 5.1, `avc1.640033`** mp4):

- Scale filter `scale=-2:'min(ih,2160)'` — preserve up to a **4K ceiling**,
  downscale only 8K+ (bounds the worst-case encode; 8K masters are out of scope).
- **Drop `-level:v 4.2`** (it caps at 1080p60) — let libx264 auto-pick the
  minimum valid level (5.1 for 4K). The export decoder reads the level from the
  file via mediabunny `getDecoderConfig`, so it adapts to the new codec string.
- Keep `-profile:v high`, short GOP (`PROXY_GOP_FRAMES`), `-bf 0`,
  `-pix_fmt yuv420p`, `+faststart`.
- **CRF 18** (was 22). The master is now a pure *export intermediate* that gets
  re-encoded at export, so it's worth limiting intermediate loss; CRF mainly
  affects size, not encode speed (preset is the speed knob), so this is a cheap
  quality lever for exactly the users this serves. (Tunable — see open questions.)
- Bump `PROXY_FORMAT_VERSION` 5 → 6 so existing 1080p masters regenerate at
  source res.

### 2. Quick proxy → permanent preview source

- `jobs/mod.rs spawn_proxy`: **remove** `quick_proxy_path: Some(None)` from the
  success patch — stop deleting the quick proxy when the master lands.
- `state/projectStore.ts previewPlaybackPathFor`: **prefer the quick proxy** —
  `quick_proxy_path → proxy_path → (proxy_bypassed ? path : null)`. ProxyBoth
  preview stays on the 720p quick proxy; the 4K master is export-only
  (`proxy_path` remains a last-resort preview fallback only if a quick proxy is
  somehow absent). `exportPlaybackPathFor` is **unchanged** (prefers
  `proxy_path`).
- **Piece B invariant preserved (verified):** preview still reaches an original
  only via `proxy_bypassed` (DirectBoth = H.264), so "preview never decodes a
  non-H.264 original" still holds; a DirectExport source before its quick proxy
  lands still resolves to `null` (blank), unchanged.

### 3. Every FullProxy-export source gets a quick proxy (`proxy_decision.rs`)

- Fold `FullProxyOnly` into `QuickThenFull`: `{FullProxy, Proxy}` **always**
  generates a quick proxy first, then the master. Without this a small
  undecodable source would have no quick proxy and preview would fall to the 4K
  master (heavy).
- This removes the `is_small` input and the `FullOnly`/`is_small_source`
  machinery from Piece A's `job_for` — a net simplification. `job_for` becomes:
  `{Original,Original}`→None, `{Original,Proxy}`→QuickOnly,
  `{FullProxy,Proxy}`→QuickThenFull, `{FullProxy,Original}`→`unreachable!`.
- Bonus: because the quick proxy lands first, the slow 4K master encode runs in
  the background **without blocking editability** — the clip is editable via the
  quick proxy while the master finishes.

### Migration

Existing ProxyBoth media (1080p master v5, quick proxy already cleared) → on
open, v5 < v6 invalidates the master → re-enqueue → `QuickThenFull` regenerates
both a quick proxy and a source-res master. **Transient blank-preview window**
on that first open (master invalidated, quick not yet regenerated) until the
quick proxy lands — pre-release, acceptable, stated so it isn't mistaken for a
regression.

## Verified vs. assumed

- **Verified (ffmpeg):** the recipe yields valid 2160p H.264 High L5.1; scale
  preserves source res up to the 4K ceiling.
- **Assumption — smoke-gated:** that the export Worker's WebCodecs actually
  *decodes* the 4K H.264 master (auto level 5.1, via mediabunny
  `getDecoderConfig`) on a real machine. This lives in the webview and can't be
  shell-probed, so the **gating acceptance is a `tauri:dev` end-to-end export**
  of a real 4K ProRes/exotic clip → confirm 4K output and that the master
  decodes. (Per the color-piece lesson: don't ship a proxy-recipe spec on an
  unverified decode assumption.)

## Quality honesty

- The master is a **lossy intermediate** (CRF 18 H.264), and export re-encodes
  it → double generational loss vs the original. For ProRes (near-lossless
  source) "4K quality" means "4K-resolution H.264 intermediate, re-encoded" —
  not original quality. This is unavoidable for non-WebCodecs-decodable codecs
  (export can't read the original). CRF 18 limits the intermediate loss.
- **HDR stays SDR-wrong:** raising resolution gives 4K, but the master is still
  8-bit-truncated with no tone-map (the 10-bit/HDR carve-out). HDR export
  resolution improves; HDR *color* does not. Real tone-mapping is a separate
  future piece.

## Costs

- Disk: a permanent quick proxy **plus** a source-res master per FullProxy
  source (local cache — acceptable).
- A 4K software x264 encode at import is slow for real (non-synthetic) footage —
  but it's background and **non-blocking** (editability comes from the quick
  proxy), and only hits the uncommon ProRes/HDR/exotic-4K case.

## Non-goals

- HDR→SDR tone-mapping. Comp-resolution targeting (rejected: comp res snapshots
  stale on project-resolution change; source res is robust). The color-metadata
  work (separate, non-issue). DirectExport (family-codec) sources — they already
  export from the original; untouched.

## Testing

- **`proxy.rs` (real ffmpeg):** a >1080p source (e.g. 1440p or 2160p testsrc) →
  master preserves source height (e.g. 1440p stays 1440p, NOT capped to 1080),
  is valid H.264 High, short-GOP, `-bf 0` (extend the existing
  `proxy_roundtrip_against_real_ffmpeg` assertions). A source >2160p → capped to
  2160p.
- **`proxy_decision.rs`:** `job_for` truth table updated — `{FullProxy,Proxy}` →
  `QuickThenFull` (no `is_small`); `FullOnly`/`is_small_source` removed; the
  other arms unchanged; `{FullProxy,Original}` still `unreachable!`.
- **`projectStore.ts` resolvers:** ProxyBoth (both paths set) → preview =
  quick_proxy, export = proxy_path; DirectExport → preview = quick_proxy;
  DirectBoth → preview/export = original; the `proxy_path`-only preview fallback.
- **Gating manual smoke (`tauri:dev`):** import a real 4K ProRes (or other
  non-family-codec) clip in a 4K project → editable via quick proxy → export →
  confirm the output is 4K (not 1080p) and the master decoded in the export
  Worker. Also confirm preview scrubs the 720p quick proxy (not the 4K master).

## Open questions

1. Encode preset for the master above 1080p — `-preset fast` software on real 4K
   may be slow; a faster preset above 1080p would trade master size for import
   throughput. Settle from observed encode times (it's background/non-blocking,
   so `fast` is likely fine).
2. CRF value for the master (18 proposed vs 22) — confirm against
   size/quality/time once real-footage masters exist.
