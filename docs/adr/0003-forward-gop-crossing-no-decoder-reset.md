---
status: accepted
---

# Forward GOP-crossings don't reset the decoder

During continuous forward play, `SourceHandle.requestFrameAt` does NOT call `decoder.reset()` + `ring.flush()` when the playhead crosses into a new GOP. The lookahead pump keeps dispatching chunks sequentially through the same `VideoDecoder`; H.264 IDR semantics clear the decoder's reference state in-stream when the new IDR's `EncodedVideoChunk` (typed `"key"`) is fed. A reset is reserved for three cases: **forward seeks far past the pump frontier** (where decoding through the gap would waste seconds), **backward GOP-crossings** (where target's IDR is behind the GOP the pump is currently flowing through, so the decoder's reference state is from a later IDR and can't decode the target's GOP), and **backward seeks within the same GOP beyond lookbehind** (where the decoder has the right references but the cached frame is gone).

Rationale:

- The pre-fix logic (`needsReset = idr !== decodeFloor`) reset on every forward GOP-crossing because it conflated "we're in a new GOP" with "the decoder needs a fresh IDR". The decoder doesn't need a fresh IDR; the IDR is already in the chunk stream the pump is feeding it.
- Empirically, the spurious reset caused a ~400 ms visible stall every GOP boundary during continuous play. With the proxy's GOP at one source-second, that's one stall per second of preview — and on 60 fps source with the pre-fix `-g 30` proxy (half-second GOP), two stalls per second.
- Removing the spurious reset leaves the existing backward-seek and long-forward-seek paths intact: the second branch of the reset check (`targetIndex <= lastDecodedIndex && !ring.containsPts(...) && decodeQueueSize === 0`) still catches backward seeks; a sample-count threshold on `idr - lastDecodedIndex` still catches long forward seeks.

Trade-off: this trusts the WebCodecs `VideoDecoder` to handle a mid-stream IDR cleanly — which is the documented behavior and how every browser implements it, but is more permissive than the prior "reset to be safe" stance. If a future browser bug or codec quirk emerges where mid-stream IDR doesn't clear references reliably, the fallback is to keep the reset but skip `ring.flush()`, so old frames remain displayable through the new-IDR warm-up gap. Re-adding the unconditional forward-GOP reset would re-introduce the stall this ADR exists to prevent — anyone tempted to "fix" a stale-frame report at a GOP boundary by re-adding the reset should read this first.
