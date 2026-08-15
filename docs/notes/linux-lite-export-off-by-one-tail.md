# Linux Lite-export off-by-one tail alignment — investigation handoff (resolved)

**Status:** RESOLVED 2026-07-23 — does not reproduce on current `main`
(Gate B's Linux skip removed in `49b7f57e`). See "Resolution" below. The
rest of this document is kept as the historical record of the observation
and the investigation trail.
**Environment when last observed:** Linux x64, Electron 42.4.1 (Chromium 148),
sidecar ffmpeg n7.1 (BtbN), Lite/webcodecs export lane.

## Resolution (2026-07-23, original RTX 3050 Linux host)

- **Ten sequential Gate B runs on current `main`: 10/10 pass**, both legs
  exactly 300 frames, every sample aligned, and byte-identical measurements
  run to run (mean SSIM native 0.91676 / proxy 0.88610). This answers the
  "Unknown" items below: `totalFrames === 300` holds, and NO sample
  misaligns — not even the tail.
- **A wider matrix also passed 9/9**: 24/25/50/60 fps, 30000/1001,
  60000/1001, non-zero container start PTS (3.2 s), H.264 B-frame +
  edit-list input decoded directly by the WebCodecs leg, and a range ending
  mid-frame (both legs agree on the ceil'd frame count). VFR remains
  untested by design — the analyzer and composition grid assume CFR.
- **Likely fixes** (landed between the historical observation and the
  validation run): the `REORDER_MARGIN` lead-in (`56f09adf`) and the
  `ExportFrameStore` duration-eviction/identity rework described in the
  2026-07-22 update below. The historical failure retained no artifacts, so
  this is closure-by-non-reproduction, not a proven root cause.
- **Why the gate was un-runnable on this host before:** the export's
  unconditional `prefer-hardware` VideoEncoder hint was a guaranteed hard
  error on Linux (Chromium treats the hint as mandatory and has no Linux HW
  encoder — a codec-matrix boundary, platform-gated in `bfd0e0ee`); and on
  current `main` Gate B's output encode is native-first anyway, so it no
  longer touches VideoEncoder at all.
- Full evidence tables: the two 2026-07-23 closure comments on the tracker
  thread this note was handed off to.

**2026-07-22 implementation update:** the historical device failure is still
unverified, but the investigation found and fixed a deterministic application
bug with the same N→N+1 shape. The old store could evict the greatest frame PTS
below a target when independently quantized duration left a 1 µs gap, after
which `frameAt()` selected the future frame. Frame identity is now strictly the
greatest `PTS <= target`, eviction retains that lower neighbour, and WebCodecs
dispatch/output share one `DecodeClock`. This makes items 1–2 below historical
hypotheses; another Linux run is still required before declaring it the root
cause of the original observation.

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
2. **6b loop's per-frame target computation (historical).** The encode loop awaits
   `ring.waitForPts(clipSrcPtsAt)` per output frame
   (`worker/exportWorker.ts`). The former source↔container conversion rebuilt
   packet time from floating-point seconds with a different rounding rule from
   `EncodedVideoChunk`; `DecodeClock` now derives scheduling PTS from the actual
   chunk timestamp instead.
3. **Decoder-specific emission order at the drain.** The EOS flush
   (`issueEosFlush`, `:790-821`) floats concurrently with consumption; a
   different emission order out of the flushed drain on Linux's SW decoder
   could swap the final two frames. Checkable by dumping frame PTS order in
   the ring at `finishEosDrain`.

## Repro + investigation steps (Linux box)

```bash
cd apps/desktop
npm run ffmpeg:fetch            # sidecar n7.1 on PATH for the specs
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
**Done 2026-07-23:** skip removed in `49b7f57e` with the resolution recorded
in the test comment; the repro steps above no longer need the un-skip edit.

## References

- Skip + comment: `e2e/electron/export-prores-fidelity.spec.ts:225-238`
- Analyzer: `e2e/lib/analyze.mjs:13` → `media_conformance` bin
- Tail machinery: `src/renderer/render/decoder/ExportDecoderPool.ts`
  (`ExportFrameStore`, `waitForPts`, `evictBefore`, `issueEosFlush`)
- Canonical WebCodecs clock: `src/renderer/render/decoder/decodeClock.ts`
- ADR 0012 (`docs/adr/0012-directexport-worker-decodable-codecs.md`) — the
  earlier PTS-grid deadlock in the same store
- `56f09adf` — REORDER_MARGIN lead-in (the fix for the macOS wedge cousin)
- `3e761485` — Lite export lane pinned to prefer-software
