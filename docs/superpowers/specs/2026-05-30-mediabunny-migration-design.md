# Migrate the WebCodecs container layer from mp4box.js to mediabunny

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-30

## Problem

The webview's container layer is **mp4box.js**, which only demuxes MP4/MOV
(ISO BMFF). The proxy-routing policy (`jobs::proxy_decision::decide`) is
**container-blind** — it decides purely on codec/pixel-format/resolution/
bitrate, never on the container. The combination is a latent correctness bug:

- An H.264 (or, post-`DecodeCaps`, HEVC/AV1/VP9) **MKV/WebM** source satisfies
  the direct-path predicate, so `decide` returns `DirectBoth`/`DirectExport`
  and the workspace copy (`.mkv`) is fed straight to the demuxer.
- mp4box.js cannot parse Matroska — `onReady` never fires, `streamFile`
  exhausts its prefix budget and throws "moov not found". Preview and export
  both break.
- MKV only works today when its codec misses the decodable set (→ a generated
  **MP4** proxy mp4box can read). MKV is a meaningful share of the user's
  footage, so this is not an edge case.

mp4box also only muxes MP4 on export (`render/worker/encoder.ts`), and the
demuxer's bespoke long-video memory machinery (moov-prefix Range fetch +
on-demand GOP-block LRU) is hand-rolled on mp4box's API.

## Solution

Replace mp4box.js with **mediabunny** for both demux and mux — the library
ADR 0002 originally proposed (status `proposed`, never implemented).
mediabunny demuxes MP4/MOV **and Matroska/WebM** natively, is WebCodecs-first,
reads **lazily/partially by design**, and muxes MP4 — so it fixes the MKV bug
at the root, unifies the container layer on one library, and lets us delete a
large amount of hand-rolled demuxer code.

Verified against the mediabunny docs:
- Containers: `Mp4InputFormat`, `QuickTimeInputFormat`, `MatroskaInputFormat`,
  `WebMInputFormat` (WebM subclasses Matroska) — [input formats](https://mediabunny.dev/guide/input-formats).
- Lazy reads: "files are always read partially (lazily)"; `CustomSource`
  (`onread(start,end)` + `getSize()`) and `UrlSource` —
  [reading](https://mediabunny.dev/guide/reading-media-files),
  [CustomSource](https://mediabunny.dev/api/CustomSource).
- Packet access/seek: `EncodedPacketSink`, `getKeyPacket(ts)`,
  `getNextPacket()`, `getSample(ts)` — [media sinks](https://mediabunny.dev/guide/media-sinks).
- WebCodecs config: `getDecoderConfig()` → `{codec, description, …}`.
- Mux: `Output` + `Mp4OutputFormat()` (fastStart) + `BufferTarget` —
  [writing](https://mediabunny.dev/guide/writing-media-files).

## Decisions (this brainstorm)

- **Full migration**: demux *and* mux move to mediabunny; mp4box.js is
  removed. (Not demux-only.)
- **Native pool rewrite**: the decoder pools consume mediabunny's
  pull-by-timestamp model (`EncodedPacketSink` / `getKeyPacket` /
  `getNextPacket`) directly. The current `Demuxer`'s indexed sample-table API
  (`sampleAt`/`sampleMetaAt`/`sampleIndexForPtsUs`/`idrAtOrBefore`/
  `ensureBlocksLoaded`) and the GOP-block byte LRU are **deleted**, not
  wrapped. ADR 0003 (forward-GOP-crossing, no decoder reset) and ADR 0004
  (ImageBitmap snapshot ring / buffer-pool eviction) behaviors are re-verified
  on the new path.
- **Source strategy: `CustomSource`** over the Tauri `asset://` protocol via
  HTTP Range — *not* `UrlSource`. We already own the Range-fetch logic;
  `CustomSource` gives explicit control over residency to hold the memory
  invariant, whereas `UrlSource`'s internal prefetch is opaque against that
  hard target. `BlobSource` is rejected (loads the whole file; Tauri buffers
  whole asset bodies unless Range-driven — see the asset-fetch-buffers
  constraint). 

## Migration phasing

Too large for one spec/plan. Decomposed into sub-projects, each its own
spec → plan → execute (this document specs **Phase A** in detail; B–D are
scoped here and get their own design docs):

- **Phase A — Reading foundation (this spec).** mediabunny `Input` over an
  `asset://` `CustomSource`, exposing decoder config + packet source. Coexists
  with mp4box; nothing in the live path changes. Gate: reads MP4 *and* MKV
  lazily + holds the heap invariant.
- **Phase B — Preview decode path.** Rewrite `SourceDecoderPool` to seek
  (`getKeyPacket`) + forward-decode (`getNextPacket`) into WebCodecs,
  preserving ADR 0003/0004. Delete the old sample table / LRU.
- **Phase C — Export decode path + mux.** Rewrite `ExportDecoderPool`
  (evict-after-use) and replace `encoder.ts` with mediabunny `Output`. Re-verify
  export fixture-comparison tests. Drop the mp4box dependency.
- **Phase D — `decide()` + cleanup.** With MKV demuxable, confirm MKV/WebM
  correctly take the direct path (the bug fix is inherent — no container guard
  needed); optionally widen bypass to those containers. Mark ADR 0002
  *accepted*; update `docs/`.

Cross-phase gate: the **long-video heap invariant** (residency flat in
low-hundreds-of-MB regardless of source duration) must hold — proven in
Phase A and re-checked in B. It is partly runtime-only (PerfHUD in the app).

## Phase A — detailed design

### Components

1. **`AssetRangeSource`** (`apps/desktop/src/render/decoder/AssetRangeSource.ts`)
   — adapts mediabunny `CustomSource` to the Tauri `asset://` protocol.
   - `onread(start, end)` → `fetch(assetUrl, { headers: { Range:
     bytes=${start}-${end-1} }, signal })` → returns the byte range.
   - `getSize()` → a Range probe (`bytes=0-0`) reads total length from the
     `Content-Range` header (`bytes 0-0/<total>`).
   - Owns an `AbortController`; `dispose()` aborts in-flight reads and swallows
     the resulting `AbortError` (mirrors today's `Demuxer` discipline).
   - Cache/prefetch options tuned to bound residency (exact knobs pinned in
     the plan — see Known unknowns).

2. **`openMediaInput(assetUrl)`** (`apps/desktop/src/render/decoder/mediaInput.ts`)
   — constructs `new Input({ source: new AssetRangeSource(assetUrl), formats:
   [Mp4InputFormat, QuickTimeInputFormat, MatroskaInputFormat, WebMInputFormat] })`,
   resolves the primary video track (first video track) or throws a clear
   error. Explicit format list (not `ALL_FORMATS`) to keep the bundle lean.

3. **Track surface** — returns `{ getDecoderConfig(): Promise<VideoDecoderConfig>,
   packetSink: EncodedPacketSink, codedWidth, codedHeight, durationUs }` for
   Phases B/C to consume. (`getDecoderConfig()` replaces the current Demuxer's
   manual avcC/hvcC box serialization.)

### Data flow

`assetUrl → AssetRangeSource (Range fetch) → Input(formats) → primary video
track → { decoderConfig, EncodedPacketSink, meta }`.

### Error handling

- No video track in the file → throw a descriptive error (caller surfaces).
- `fetch` non-2xx / non-206 → throw with the status + range.
- Dispose mid-read → `AbortError` swallowed; awaiting callers unblocked.

### Scope boundary

Phase A is **additive and not wired into production.** The live preview/export
path keeps using the mp4box `Demuxer` until Phase B. Phase A ships the module
+ its tests + the fixtures; its value is the isolated proof that the
load-bearing risk (lazy reading of MP4 + MKV within the memory budget) holds
before we rewrite the pools on top of it.

### Testing

- **Unit (`AssetRangeSource`):** mock `fetch`; assert correct `Range` header
  for `onread(start,end)`; `getSize()` parses `Content-Range`; `dispose()`
  aborts and swallows `AbortError`.
- **Laziness (behavioral):** against a large fixture, "open + getDecoderConfig
  + read first key packet" pulls only a small fraction of total bytes (sum of
  `onread` lengths ≪ file size) — the automatable proxy for the heap invariant.
- **Format parity:** open a small **MP4** and a small **MKV** fixture; both
  yield a valid `VideoDecoderConfig` (non-empty `description` for H.264) and a
  first key `EncodedPacket`.
- **Runtime acceptance (manual, carried forward):** PerfHUD heap soak on a
  long video in `tauri:dev` — heap stays flat regardless of duration. Cannot
  be headless; recorded as a Phase A acceptance criterion to run in-app.

### Test fixtures (new)

No video fixtures exist today (`apps/desktop/fixtures/` is synthetic
compositions). Add two tiny clips — `tiny.mp4` and `tiny.mkv` — generated by
ffmpeg (e.g. 1 s of `testsrc`, H.264, served from a path the browser test can
reach via `asset://` or the vitest-browser harness). Generation script lives
with the fixtures so they're reproducible, not opaque binaries.

## Known unknowns (resolve in the plan, first task)

- Exact `CustomSource` contract: `onread` return type (sync `Uint8Array` vs
  `Promise`/callback), and the real option names for cache size / prefetch
  profile. Pin against mediabunny's bundled `.d.ts` immediately after install,
  before building `AssetRangeSource`.
- Whether `getSize()` is required up front or mediabunny tolerates
  `getSizeOrNull()` for a streamed open (affects the Range-probe step).

## Non-goals (Phase A)

- Touching `SourceDecoderPool` / `ExportDecoderPool` / `encoder.ts` (Phases
  B/C).
- Removing mp4box.js (Phase C, once nothing imports it).
- `decide()` container-awareness / bypass widening (Phase D).
- Non-MP4/MKV containers we don't import (MP3/WAV/Ogg/TS/HLS demuxers stay out
  of the bundle).

## References

- ADR 0002 (mediabunny — currently `proposed`), ADR 0003 (forward-GOP),
  ADR 0004 (ImageBitmap ring / buffer pool).
- Current demuxer: `apps/desktop/src/render/decoder/Demuxer.ts`; mux:
  `apps/desktop/src/render/worker/encoder.ts`.
- mediabunny docs linked inline above.
