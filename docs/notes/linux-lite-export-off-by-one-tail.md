# Linux Lite-export off-by-one tail alignment — open issue handoff

**Status:** open, Linux-only, e2e gate skipped. Recorded 2026-07-19 from the
macOS investigation session; nobody has reproduced it on current `main` yet.
**Environment when last observed:** Linux x64, Electron 42.4.1 (Chromium 148),
sidecar ffmpeg n7.1 (BtbN), Lite/webcodecs export lane.

## Symptom

`e2e/electron/export-prores-fidelity.spec.ts` gate B ("native pin beats the
proxy path on SSIM to source (differential)", :225) runs the same timeline
twice — native decode pin vs `webcodecs` pin (which routes ProRes through the
full H.264 proxy) — then asserts per-sample best-match alignment + SSIM
against the source (`:267-274`).

On Linux the **proxy (Lite/webcodecs) leg completes** but fails the alignment
precondition: **a tail sample best-matches source frame +1** instead of its
own index (recorded in the skip comment at `:226-238`). The native
software-lane leg is clean. The gate is currently skipped on Linux only
(`:238`); macOS was un-skipped in `56f09adf` after its separate wedge was
fixed (see "Not this bug" below).

What the assertion is: `analyze()` (`e2e/lib/analyze.mjs:13`) shells the
`media_conformance` Rust bin (`apps/desktop/native`, `--features jobs,export`),
which locates each sampled output frame in the source by best SSIM match —
the testsrc2 frame counters in `test_1080p_30fps_prores.mov` make that match
unambiguous. A sample landing on `source+1` means the exported tail carries
content one frame later than the grid says it should — a frame-selection /
PTS-grid defect near end-of-stream, not a quality regression.

## Verified facts vs unknowns

Verified:
- The Lite leg **runs to completion** on Linux (unlike the macOS wedge), so
  this is a tail-selection defect, not a starvation.
- The skip predates `3e761485` (the `preferSoftware` pin on the Lite export
  lane) — it existed in the prefer-hardware era too.
- The macOS failure mode that shared this gate was different and is fixed
  (next section).

Unknown (needs a Linux machine):
- Which sample indices misalign (only the last?), and whether
  `totalFrames === 300` held on the failing run.
- Whether `56f09adf` (REORDER_MARGIN lead-in on every lane) changed anything
  — it alters dispatch at every chunk tail, so the failing behavior may have
  moved, vanished, or (unlikely) worsened. **Re-run before any theorizing.**
- Whether the defect also affects other tail-sensitive Lite specs on Linux
  (`export_eos_tail.spec.ts` passes in CI-style macOS runs; its Linux status
  is worth confirming).

## Not this bug

The macOS failure on the same gate was a **decoder reorder-tail hold-back**:
Chromium's macOS prefer-software H.264 decoder withholds the last 2 frames of
every fed window (4 with B-frames), and the chunked dispatch's 1-packet
margin never pushed them out → export wedged in `progress`. Fixed in
`56f09adf` by feeding a `REORDER_MARGIN` lead-in past each stop key in
`ExportDecoderPool.decodeRange`. The Linux symptom (completes, tail sample
off by one) is a different shape — treat it as a PTS-grid/tail problem in the
territory of ADR 0012, not a decode-delay problem.

## Suspects (in rough priority)

1. **EOS tail clamp semantics.** `ExportFrameStore.finishEosDrain` finalizes
   the ring so grid-overhang waits clamp to the last held frame
   (`ExportDecoderPool.ts:790-821`, store at `:68-354`). If the clamp window
   or the last-PTS rule in `isReadyFor` (`:226-232`) is off by one frame
   interval on the final sample grid point, the exported tail frame would
   hold the neighbor's content. Linux-only-ness could come from decoder
   timing deciding *which* side of the clamp the tail wait lands on.
2. **6b loop's per-frame target computation.** The encode loop awaits
   `ring.waitForPts(clipSrcPtsAt)` per output frame
   (`worker/exportWorker.ts:441-543`, the wait at `:457`). A rounding
   asymmetry (`ptsOffset.ts` source↔container conversions) that only
   materializes for the proxy's timebase/start-PTS on Linux builds would
   shift exactly the tail sample.
3. **Decoder-specific emission order at the drain.** The EOS flush
   (`issueEosFlush`, `:790-821`) floats concurrently with consumption; a
   different emission order out of the flushed drain on Linux's SW decoder
   could swap the final two frames. Checkable by dumping frame PTS order in
   the ring at `finishEosDrain`.

## Repro + investigation steps (Linux box)

```bash
cd apps/desktop
npm run fetch-ffmpeg            # sidecar n7.1 on PATH for the specs
VITE_WEFTCUT_E2E=1 npm run build
# un-skip: drop the linux arm of the test.skip at export-prores-fidelity.spec.ts:238
PATH="$PWD/resources/ffmpeg/linux:$PATH" WEFTCUT_DECODE_E2E=1 \
  npx playwright test e2e/electron/export-prores-fidelity.spec.ts
```

The failing expect prints the misaligned samples as JSON (`:271-272`) — start
there: which indices, and is the offset consistently +1. Then, in order:
(1) confirm on current `main` (post-`56f09adf`) before touching code;
(2) ffprobe both legs' outputs for frame count + first/last PTS against the
source grid; (3) add a temporary dump of ring PTS order at `finishEosDrain`
for the tail GOP; (4) if a clamp-boundary race is suspected, run the spec
repeatedly — a race gives intermittent ±1, a deterministic grid bug gives
+1 every time.

When fixed: remove the Linux arm of the skip, keep the comment recording the
resolution, and re-run the full export + conformance specs on Linux.

## References

- Skip + comment: `e2e/electron/export-prores-fidelity.spec.ts:225-238`
- Analyzer: `e2e/lib/analyze.mjs:13` → `media_conformance` bin
- Tail machinery: `src/renderer/render/decoder/ExportDecoderPool.ts`
  (`waitForPts` :161, `isReadyFor` :226, `issueEosFlush` :790)
- ADR 0012 (`docs/adr/0012-directexport-worker-decodable-codecs.md`) — the
  earlier PTS-grid deadlock in the same store
- `56f09adf` — REORDER_MARGIN lead-in (the fix for the macOS wedge cousin)
- `3e761485` — Lite export lane pinned to prefer-software
