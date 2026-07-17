---
status: accepted
---

# Preview's `FrameRing` caches `ImageBitmap` snapshots, not `VideoFrame`s

`SourceHandle.output` converts each emitted `VideoFrame` to an `ImageBitmap` via `createImageBitmap(frame)` and `frame.close()`s the source as soon as the bitmap is ready. The `FrameRing` stores `{ ptsUs, durationUs, bitmap: ImageBitmap }` entries; eviction and flush call `bitmap.close()`. `VideoClipSprite.updateFrame` accepts `BrowserConvertibleFrame` (`VideoFrame | ImageBitmap` — the subset of `DecodedFrame` a 2D-canvas `drawImage` converts correctly, `decoder/decodedFrame.ts`) and snapshots it into the sprite-owned canvas (the snapshot rule, `docs/render.md`).

Rationale:

- WebCodecs `VideoDecoder` emits `VideoFrame`s backed by the hardware decoder's frame buffer pool. Common desktop GPUs cap that pool at ~13 slots. Every `VideoFrame` the consumer retains pins a slot until `.close()`; the decoder cannot allocate buffers for new output past that ceiling and goes silent without an error.
- Preview's ring is designed to hold ~40 frames at steady state (500 ms lookbehind + up to 1 s lookahead). Held as `VideoFrame`s, it permanently pins ~8 slots once warmed up; with the decoder's internal reorder buffer holding another 4–5, the pool exhausts and output stalls. Warmup pre-roll cannot exceed ~8 frames; clicking play freezes on the last cached frame for the ~600 ms it takes anchor advance to evict ring entries one at a time and feed the pool back.
- `ImageBitmap` is a transferable pixel container whose storage is independent of the decoder's pool. `createImageBitmap(VideoFrame)` is browser-optimized to keep pixels GPU-side where possible; the source frame's `.close()` returns its buffer immediately. The ring can now hold the full lookbehind + lookahead window without back-pressuring the decoder.
- PixiJS v8's `ImageSource` accepts `VideoFrame` and `ImageBitmap` as the same kind of resource, so the sprite code stays uniform — it reads dims off `codedWidth/codedHeight` for `VideoFrame` and `width/height` for `ImageBitmap` and otherwise treats them identically.

Trade-offs:

- The async hop introduces a race: an `inactivity-rebuild` or software downgrade between the synchronous `output()` callback and the `createImageBitmap` Promise's resolution must not push stale bitmaps into the live ring. Resolution closes its own bitmap and bails when `this.decoder !== dec` no longer holds.
- Memory: a full lookahead at 1080p ≈ 73 frames × ~6 MB ≈ ~440 MB of GPU memory per active clip. Multi-clip projects scale linearly. The lookahead config is currently the design-intent 1 s; if memory pressure surfaces in production, lowering `DEFAULT_LOOKAHEAD_US` toward 300–500 ms is the first lever.
- The async hop means a VideoFrame is briefly held until conversion resolves; under heavy concurrent decode (multi-clip composition, aggressive scrub) the in-flight set could still touch the pool ceiling. Has not been observed.
- Color-space conversion through `createImageBitmap` is implementation-defined (typically YUV → display-linear RGBA). Preview's pixels are therefore not bit-identical to export's, which renders the same `VideoFrame` directly. Has not surfaced as a visible discrepancy.

Why export does **not** apply this snapshot:

`ExportFrameStore` caches `VideoFrame`s and the export Worker's encode loop closes each frame immediately after composition (`evictBefore(nextSrcPts)`). The pool stays drained naturally; the snapshot's cost (memory, conversion latency) would buy nothing. Both stores satisfy the shared `FrameStore` interface returning `DecodedFrame`, so the sprite consumes whichever flavour the active pool produces.
