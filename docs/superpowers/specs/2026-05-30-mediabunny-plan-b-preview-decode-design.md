# mediabunny Migration — Plan B design: preview decode path

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-30

Parent: `2026-05-30-mediabunny-migration-design.md` (Phase B). Depends on
**Plan A** (`openMediaInput` / `AssetRangeSource` / `EncodedPacketSink`), which
is committed on `feat/mediabunny-migration` but not yet wired into production.

## Goal

Rewrite the preview decode path (`SourceDecoderPool` → `SourceMedia` /
`SourceHandle`) to drive WebCodecs from mediabunny's `EncodedPacketSink`
instead of the mp4box `Demuxer`'s indexed sample table — fixing MKV/WebM
preview at the root — while preserving scrub/play behavior and the two ADRs the
pump encodes.

## The core change: synchronous index pump → asynchronous packet pump

Today's pump is **synchronous and index-based**:
`sampleIndexForPtsUs(tUs)` → `idrAtOrBefore(idx)` → a sync loop walking
`sampleAt(i)`, where `sampleAt` returns `null` when the GOP's bytes aren't
cached (the pump breaks and retries next rAF; the `null` return fires a Range
fetch as a side effect). Reset decisions are keyed on sample **indices**
(`lastDecodedIndex`, `decodeFloor`, `idr`, `FORWARD_SEEK_RESET_THRESHOLD = 60`).

mediabunny is **asynchronous and packet-based**: `getKeyPacket(ts)` /
`getNextPacket(pkt)` / `getPacket(ts)` return Promises; `EncodedPacket` carries
`.timestamp`/`.duration` (seconds), `.type` (`'key'|'delta'`), and
`.toEncodedVideoChunk()`. The source caches bytes internally, so there is no
synchronous "is it resident" check — awaiting a packet naturally waits for
uncached bytes. Plan B inverts the pump's control flow to match.

## Preserved verbatim (must not regress)

- **ADR 0004 — ImageBitmap snapshot ring.** `SourceHandle`'s `output` callback
  (`createImageBitmap(frame)` + immediate `frame.close()` + the
  decoder-identity race guard) and `FrameRing` are unchanged. The migration
  changes the source of *chunks*, not how *frames* are cached. The decoder
  buffer-pool ceiling reasoning still holds.
- **Per-clip `SourceHandle` (own `VideoDecoder` + `FrameRing`) + refcounted
  per-`mediaId` `SourceMedia`**, the idle sweeper, the
  software-downgrade / inactivity-rebuild recovery (`decoderFallback.ts`,
  `nullForRebuild`), and the EOS flush behavior.
- **ADR 0003 — forward GOP-crossings do NOT reset the decoder.** Reset stays
  reserved for: far-forward seek, backward-GOP-crossing, and backward seek
  beyond lookbehind. Re-adding an unconditional per-GOP reset re-introduces the
  stall the ADR exists to prevent.

## Changed components

### `SourceMedia`
- Holds an `OpenedMedia` (`videoTrack` + `packetSink` from `openMediaInput`)
  instead of `Demuxer`. `ensureReady` resolves the **decoder config** from
  `await videoTrack.getDecoderConfig()` (replaces the hand-built
  `VideoTrackMeta` + manual avcC/hvcC serialization).
- `dispose()` calls `OpenedMedia.dispose()` (which disposes the mediabunny
  `Input` + aborts in-flight Range reads via `AssetRangeSource`).

### Decoder meta surface
- Replace `VideoTrackMeta` with a lean shape derived from `getDecoderConfig()`:
  `{ codec, codedWidth, codedHeight, description }`. **Open item (resolve in the
  plan):** the current `VideoTrackMeta` also exposes `nbSamples` and
  `timescale`; audit every consumer (`Compositor`, `ExportDecoderPool`, the
  `DecoderHandle` interface). EOS is now "`getNextPacket` returned `null`", so
  `nbSamples` should be unneeded; confirm `timescale` has no remaining
  consumer, or carry it forward if one exists.

### The async pump (`SourceHandle`)
- **State:** replace `lastDecodedIndex`/`decodeFloor` with a packet cursor
  (`cursor: EncodedPacket | null`, the last packet dispatched) and
  `lastDecodedPtsUs`. Add `pumping: boolean` (single in-flight pump) and a
  `generation: number` counter.
- **`requestFrameAt(tUs)` (async):** set ring anchor; run the reset decision
  (below); if not already `pumping`, kick the async pump from `cursor`.
- **Pump loop (async, generation-guarded):**
  ```
  while (decoder.decodeQueueSize < MAX_QUEUE && !ring.isLookaheadFull()) {
    const myGen = this.generation;
    const next = await packetSink.getNextPacket(cursor);
    if (this.generation !== myGen || disposed) return;   // superseded → bail
    if (!next) { eosFlushOnce(); break; }
    decoder.decode(next.toEncodedVideoChunk());
    cursor = next; lastDecodedPtsUs = round(next.timestamp * 1e6);
  }
  ```
  The generation check after each `await` is the seek/reset race guard (mirrors
  ADR 0004's decoder-identity guard in `output`). `MAX_QUEUE = 24` unchanged.
- **Reset decision (ADR 0003, re-keyed to microseconds):**
  - `key = await packetSink.getKeyPacket(tUs / 1e6)`; `keyPtsUs = key.timestamp*1e6`.
  - **far-forward seek:** `keyPtsUs - lastDecodedPtsUs > FORWARD_SEEK_RESET_US`
    (≈ `1_000_000`, one lookahead window in time — replaces the 60-sample
    threshold).
  - **backward beyond ring:** `tUs < ring.firstPtsUs()` (covers
    within-GOP-beyond-lookbehind AND backward-GOP-crossing, as today).
  - **otherwise no reset** — forward GOP-crossings flow the new key packet
    in-stream.
  - **on reset:** `generation++`; `decoder.reset()` + `configure`;
    `ring.flush()`; `cursor = key` and `decode(key.toEncodedVideoChunk())`;
    reset `flushedThisRun`.

## Data flow

`requestFrameAt(tUs)` → reset? (await `getKeyPacket`) → kick pump → pump
`await getNextPacket` → `decoder.decode(chunk)` → `output` → `createImageBitmap`
→ `FrameRing.push` → `Compositor.frameAt(tUs)`.

## Error handling

- Decode errors → unchanged `handleDecodeError` (downgrade-to-software /
  inactivity-rebuild / log) + `nullForRebuild`.
- `getNextPacket` / `getKeyPacket` rejection (e.g. Range fetch failed, or
  `AbortError` on dispose) → swallow `AbortError`; otherwise surface via LogBus
  and leave the last decoded frame on screen (no crash). A persistent read
  failure leaves preview frozen on the last frame — acceptable, mirrors the
  mp4box demuxer's poisoned-block behavior.
- Dispose mid-pump → `generation`/`disposed` guard bails the loop after the
  current `await`.

## Testing

- **Pure unit (extractable, like `decoderFallback.handleDecodeError`):** factor
  the reset decision into a pure function
  `decideReset({ targetUs, keyPtsUs, lastDecodedPtsUs, ringFirstPtsUs,
  queueEmpty, flushedThisRun }) → boolean`. Unit-test the ADR 0003 truth table:
  continuous forward (no reset), forward GOP-cross (no reset), far-forward seek
  (reset), backward beyond ring (reset), paused lookahead-fill (no reset — the
  regression the current comments warn about).
- **Runtime acceptance (manual, REQUIRES the app + WebCodecs — carried):** in
  `tauri:dev`, on both an MP4 and an **MKV** source: first-frame paint; smooth
  continuous play across ≥2 GOP boundaries with no per-GOP stall (ADR 0003);
  forward seek (near = catch-up, far = reset); backward seek within and beyond
  lookbehind; two overlapping clips of the same source (no decoder thrash);
  scrub latency comparable to the mp4box path; PerfHUD heap flat on a long clip
  (the Plan A invariant, now exercised through the live pump).

## Non-goals (Plan B)

- `ExportDecoderPool` + mux (Plan C) — export still uses the mp4box path until C.
- Removing mp4box (Plan C, once nothing imports it).
- `decide()` container-awareness / bypass widening (Plan D).

## Risks

- **Async pump concurrency** (re-entrancy, seek-during-pump, dispose-during-await)
  is the dominant risk — the `pumping` flag + `generation` guard must cover
  every `await` boundary. This is why Plan B's execution warrants a focused
  session, not a tail-end of a long one.
- **Scrub latency:** `getNextPacket` on cached data must resolve within a
  microtask; if mediabunny's async overhead per packet is material vs the old
  sync `sampleAt`, scrub could regress. Measure against the mp4box path during
  runtime acceptance; if it regresses, pre-buffer a small packet queue ahead of
  the decoder.
- **`getDecoderConfig()` for HEVC/odd profiles** must produce a
  `description` WebCodecs accepts — verify on a real HEVC source in acceptance.
