# mediabunny Migration — Plan C design: export decode path + mux

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-30

Parent: `2026-05-30-mediabunny-migration-design.md` (Phase C). Depends on
**Plan A** (`openMediaInput` / `AssetRangeSource` / `EncodedPacketSink`) and
**Plan B** (preview pool already off mp4box), both on `feat/mediabunny-migration`.

## Goal

Move the **export** path off mp4box.js onto mediabunny — both the decode side
(`ExportDecoderPool` → `ExportSourceHandle`) and the mux side (`encoder.ts`) —
then **delete mp4box entirely**. This unifies the container layer on one
library, lets us delete the hand-rolled demuxer, and makes direct-path MKV
exportable (today a bypass/`DirectBoth` H.264 MKV previews via mediabunny after
Plan B but still **fails on export** because export feeds the `.mkv` to mp4box).

## Two independent rewrites + a deletion

Phase C is two rewrites that share no code, plus the mp4box removal they
jointly unblock. Recommended execution order: **mux first** (covered by the
existing pixel-exact fixture-comparison, so it builds confidence cheaply) →
**decode** → **drop mp4box** as the finale.

### 1. Decode — `ExportSourceHandle` (`apps/desktop/src/render/decoder/ExportDecoderPool.ts`)

- **Source:** holds an `OpenedMedia` (`videoTrack` + `packetSink` from
  `openMediaInput`) instead of a `Demuxer`. `ensureReady` resolves the decoder
  config from `await videoTrack.getDecoderConfig()` (replaces the hand-built
  `VideoTrackMeta` + manual avcC/hvcC serialization). Keep the existing
  `VideoDecoder.isConfigSupported` HW/SW probe and the `downgradeToSoftware` /
  `rebuildAfterInactivity` recovery — but rebuild keeps the opened input and
  rebuilds only the `VideoDecoder` + resets the packet cursor (mirrors Plan B's
  `nullForRebuild`; do **not** re-open the media).
- **`decodeRange(aUs, bUs)` → async, packet-based:**
  - Maintain a **cursor** = last packet dispatched (`EncodedPacket | null`).
  - Position: if not already flowing through the GOP that covers `aUs`
    (cursor null, or `aUs` is behind the cursor), seek:
    `key = await packetSink.getKeyPacket(aUs / 1e6)` and start from `key`.
    Otherwise continue from `await packetSink.getNextPacket(cursor)` — the
    "sequential forward calls are cheap" optimization the old code had.
  - Decode forward via `getNextPacket`, dispatching each packet's
    `toEncodedVideoChunk()`, **covering `bUs` in presentation order**. For
    `-bf 0` proxies (the common case) decode-order == presentation-order, so
    "stop once a packet's presentation timestamp exceeds `bUs`" is exact. For
    **B-frame originals** (DirectExport decodes the original, which may carry
    B-frames), decode through the GOP boundary that fully covers `bUs` so the
    decoder's reorder buffer can emit every frame whose PTS ≤ `bUs` — the exact
    boundary rule is pinned in the plan and verified on a real B-frame clip.
  - **No `decoder.flush()` between ranges** (unchanged rationale: flushing
    forces DPB drain, which needs `VideoFrame` pool slots the worker is holding
    → deadlock). Dispatch and return; outputs trickle in async; the worker
    awaits each via `ring.waitForPts`.
  - **Deleted entirely:** `ensureBlocksLoaded` (the byte pre-fault),
    `sampleIndexForPtsUs`, `idrAtOrBefore`, `sampleMetaAt`, `sampleAt`,
    `lastDispatchedIndex`, the fixed GOP-batch scan. Awaiting `getNextPacket`
    waits for uncached bytes natively, so the cache-miss-returns-null hazard
    the pre-fault existed for is gone.
- **Unchanged (preserved):** `ExportFrameStore` (`waitForPts` /
  `evictBefore` / `frameAt` / `containsPts`), the `output → ring.push`
  callback, and the worker's per-frame evict-after-use loop. The migration
  changes the source of *chunks*, not how *frames* are stored/consumed.

### 2. Mux — `EncoderSink` (`apps/desktop/src/render/worker/encoder.ts`)

Approach A (surgical): **keep the `VideoEncoder`** and everything that
determines the encoded bytes (config, GOP/keyframe cadence, the
`MessageChannel`-based `awaitQueueBelow` backpressure). Replace **only** the
mp4box container.

- **Construct:** `new Output({ format: new Mp4OutputFormat({ fastStart:
  'in-memory' }), target: new BufferTarget() })`, plus
  `new EncodedVideoPacketSource(codec)` where `codec` is the mediabunny
  `VideoCodec` derived from the encoder config (H.264 → `'avc'`).
  `output.addVideoTrack(source, metadata?)`; `await output.start()` before the
  first sample.
- **Per encoded chunk** (`onEncodedChunk(chunk, meta)`): the `VideoEncoder`
  `output` callback is **synchronous**, but `source.add` is **async** (returns
  a backpressure Promise). Serialize through a promise chain:
  ```
  this.addChain = this.addChain.then(() =>
    this.videoSource.add(
      EncodedPacket.fromEncodedChunk(chunk),
      this.firstAdd ? meta : undefined,   // decoder config on the first add only
    ),
  );
  this.firstAdd = false;
  ```
  Packets are added in decode order with presentation timestamps; B-frames are
  handled by mediabunny.
- **`finalize()`:** `await this.encoder.flush()` → `await this.addChain` (drain
  the mux queue) → `await this.output.finalize()` → return
  `this.target.buffer` (an `ArrayBuffer`, non-null after finalize).
- **`dispose()`:** close the encoder; `void this.output.cancel()` if not
  finalized; close the yield channel (unchanged).

### 3. Drop mp4box

After #1 and #2, the only importer of mp4box is `Demuxer.ts` itself (Plan B
removed the preview importer; #1 removes the export importer; #2 removes the
mux importer). `VideoTrackMeta` also lives in `Demuxer.ts` and loses its last
consumer once `ExportSourceHandle` stops returning it.

- Grep-verify **zero** importers of `mp4box` and of `./Demuxer` outside
  `Demuxer.ts`.
- Delete `Demuxer.ts` (+ any `Demuxer.test.ts`).
- Remove `mp4box` from `apps/desktop/package.json`.

## Data flow

- **Decode:** `proxyAssetUrl → openMediaInput → EncodedPacketSink →
  decodeRange (getKeyPacket / getNextPacket) → VideoDecoder.decode →
  output(VideoFrame) → ExportFrameStore.push → worker waitForPts`.
- **Mux:** `composited VideoFrame → VideoEncoder.encode →
  output(EncodedVideoChunk, meta) → EncodedPacket.fromEncodedChunk →
  videoSource.add (promise-chained) → Output / BufferTarget → finalize →
  ArrayBuffer → postMessage to main thread`.

Audio is untouched: export still produces a **video-only** MP4; the Rust ffmpeg
final mux combines it with audio (P9).

## Error handling

- **Decode errors** → unchanged `handleDecodeError` (downgrade-to-software /
  inactivity-rebuild / log-only) + the decoder-identity guard in `output`.
- **`getKeyPacket` / `getNextPacket` rejection** (Range fetch failed; or
  `AbortError` on dispose) → **fail the export**. Export is all-or-nothing — it
  must surface a clear error, not silently drop frames or freeze (the opposite
  of preview's "hold last frame" policy). Swallow `AbortError` only when the
  rejection is caused by `dispose()`.
- **`source.add` / `output.finalize` rejection** → propagate and fail the
  export with the underlying message.

## Testing

- **Mux — automated, strong.** Re-run `npm run fixtures:render` (browser export
  Worker) + `npm run fixtures:check` (Rust `fixture_compare`) for `001_color`
  and `002_color_stack`. The mediabunny-muxed MP4 must stay **pixel-exact** vs
  the expected output. Because the `VideoEncoder` is untouched (Approach A), the
  encoded stream is identical and only the container wrapper changed — so this
  existing comparison remains a *valid* regression gate for the mux swap.
- **Decode — manual, carried** (decision: same posture as Plan B's runtime
  acceptance — the export fixtures are synthetic/media-less and don't exercise
  real video decode). Export a real **MP4** and a real **MKV** (including a
  **B-frame** original routed through DirectExport): output plays, frames are
  correct with no drops/reorder errors, and the **heap stays bounded** through a
  long export (evict-after-use invariant). Record pass/fail; an unfixable
  regression is a release blocker, not a silent carry.
- **Unit (where feasible without WebCodecs):** a pure test for the codec-string
  mapping (e.g. `avc1.640028 → 'avc'`), mirroring the `decoderFallback` /
  `decideReset` extraction discipline.

## Non-goals (Plan C)

- Audio export / mux (stays on the Rust ffmpeg final-mux path).
- Preview path (Plan B, done).
- `decide()` container-awareness / bypass widening, marking ADR 0002 accepted,
  and the `docs/` sweep (Plan D).
- Changing encoder settings, output codecs, or moving off MP4 output.

## Risks

- **B-frame originals (DirectExport).** `decodeRange` must decode far enough in
  *decode* order to cover `bUs` in *presentation* order. The proxies are
  `-bf 0` so fixtures won't catch a boundary bug — verify on a real B-frame
  source in manual acceptance.
- **Two backpressure points.** The encoder queue (`awaitQueueBelow`) and the
  async `source.add` (promise-chained) must compose without deadlock. The
  chain + finalize-awaits-chain pattern keeps adds ordered and bounded; confirm
  no stall under a multi-thousand-frame export.
- **Intermediate-MP4 readability.** The Rust final mux must read mediabunny's
  video-only MP4 cleanly (it re-muxes with audio). `Mp4OutputFormat` produces a
  standard MP4; `fastStart: 'in-memory'` (moov-first) is fine and the final
  ffmpeg pass reads the whole file regardless.

## Known unknowns (resolve in the plan, first task)

- Pin the mediabunny mux API against the installed `.d.ts`:
  `EncodedVideoPacketSource(codec: VideoCodec)`, `.add(packet, meta?)` (decode
  order, PTS timestamps, meta-on-first-call), `Output.addVideoTrack` /
  `.start()` / `.finalize()`, `Mp4OutputFormat({ fastStart })` valid values,
  `BufferTarget.buffer`, and `EncodedPacket.fromEncodedChunk(chunk)`. Confirm
  the `VideoCodec` enum values for the codec-mapping helper.
- Confirm `EncodedVideoChunkMetadata.decoderConfig.description` from our
  `VideoEncoder` is what `add(..., meta)` wants on the first call.

## References

- ADR 0002 (mediabunny — `proposed`), ADR 0003 (forward-GOP), ADR 0004
  (ImageBitmap ring / buffer pool).
- Current export decode: `ExportDecoderPool.ts`; current mux: `encoder.ts`;
  driver: `render/worker/exportWorker.ts`. mp4box demuxer: `Demuxer.ts`.
- mediabunny mux: `Output` + `Mp4OutputFormat` + `BufferTarget` +
  `EncodedVideoPacketSource` (verified against
  `node_modules/mediabunny/dist/mediabunny.d.ts`).
