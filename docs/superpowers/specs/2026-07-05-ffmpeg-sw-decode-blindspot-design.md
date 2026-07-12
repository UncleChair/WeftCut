# ffmpeg universal software-decode — no-proxy preview & export for WebCodecs-blind formats — Design

> **Status 2026-07-09 — partially superseded by the dual-engine decode/export
> architecture, since consolidated into evergreen docs and deleted: preview decode in
> [`../../preview.md`](../../preview.md) §Decode engine, the encode exit in
> [`../../render.md`](../../render.md) §Encode exits, and
> [ADR 0030](../../adr/0030-decode-engine-overlay-and-native-component.md).**
> Shipped from this spec: Phase 1 (ProRes preview, ADR 0029) and the Phase 2
> Plan A subset (family widening, per-family threading, long-GOP seek,
> frame-drop floor). Still owned here: the §4.2 playback-resolution throttle +
> Full/½/¼/Auto UI (Phase 2 Plan B; handoff in
> `../2026-07-05-preview-sw-phase2-kickoff.md`), now sequenced after the
> dual-engine architecture's Phase D. Superseded there: Phase 3 native export (the
> encode side becomes Phase E; this spec's §6 main→worker decode transport
> becomes stage D5 and remains its design of record), Phase 4 / §5 proxy
> semantics (expanded into the stage-D6 proxy-policy flip), the
> "WebCodecs-blind codecs only" scoping and §9's WebCodecs-path scope guards
> (the Native engine's SW lane widens to anything ffmpeg decodes,
> probe-arbitrated), and §3's list-based routing (probes arbitrate; lists only
> seed).

**Goal:** Give WeftCut a proxy-free path for the formats WebCodecs cannot decode at all —
ProRes 422/4444, DNxHD/DNxHR, MPEG-2, VC-1/WMV — by adding a native libavcodec
**software**-decode source at the existing `DecoderHandle` seam. On import these formats
preview *immediately* off the original (no proxy build, no wait); export renders from the
original too. Proxy stops being an automatic, format-driven artifact and becomes a
user-opt-in convenience (the Premiere/Resolve model). This realizes "ffmpeg as the
universal decode entry" on **both** the preview and export sides, but deliberately does
**not** reuse the hardware `preview-gpu` shared-texture pipeline — software-decoded frames
live in CPU memory, so they take a simpler ship-bytes route.

This is a **design + de-risk** spec. It defines the architecture and calls out one
measure-first spike (§7) that must run before the export slice (Phase 3) is committed.

## Prior context adopted as-is

- `docs/render.md` — the one Compositor; the two-tier `SourceDecoderPool`; the ring stores
  `ImageBitmap` snapshots (ADR 0004); the "never bind a raw `VideoFrame` to a Pixi texture,
  route through `createImageBitmap`/`drawImage` to honor `colorSpace`" rule (ADR 0014/0021).
- `docs/preview.md` §Proxies + ADR 0009 (two-axis proxy decision) + ADR 0028 (folded
  `DecodeRoute` enum) — the routing this extends.
- `docs/decode-bench.md` + the Stage-2/3 specs under `docs/superpowers/specs/2026-07-03…`
  and `…-07-04…` — the `DecoderHandle` seam, the `NativeGpuSourceHandle` precedent, and the
  **measure-first discipline** ("do not build SharedArrayBuffer/Atomics before the data
  demands it") this spec inherits.
- Branch `poc/shared-texture-import` (`poc/shared-texture/FINDINGS.md`) — proves the
  *hardware* GPU-shared-texture ingress; explicitly **not** the path taken here (see §1.3).
- Project memory: `feedback_native_nle_conventions` (native-decode-always default;
  proxy = user opt-in; degrade inside the native path, never auto-swap),
  `project_instant_decodable_preview`, `feedback_webcodecs_buffer_pool` (ADR 0004),
  `reference_webcodecs_hi10p` (WebCodecs already SW-decodes Hi10P — so SW decode only earns
  its keep on codecs WebCodecs cannot open at all).

## 1. The decision

### 1.1 Locked design (each row was a resolved fork)

| Axis | Decision |
| --- | --- |
| Target | WebCodecs-blind codecs only: ProRes 422/4444, DNxHD/DNxHR, MPEG-2, VC-1/WMV. WebCodecs stays the fast path for everything it can open. |
| Decoder | Pure libavcodec **software** decode, uniform across all four families. No `d3d11va` — even for MPEG-2/VC-1 (they SW-decode cheaply, and a GPU-resident frame fights the ship-bytes transport). The native module touches **no** D3D11. |
| Transport | **A** — `SW decode → swscale to 8-bit YUV → ship raw bytes → renderer `new VideoFrame(buf,…)` → `createImageBitmap` → existing `FrameRing``. Native side becomes just another `ImageBitmap` producer; the Compositor/sprite/painter are unchanged. |
| Cross-process channel | **Classic `ipcRenderer`/`webContents.send`** — measured fastest at ~1 GB/s (§7) — then a same-process `postMessage` transfer renderer→worker for export. `MessageChannelMain`, `ArrayBuffer` transfer, and buffer recycling were measured **worse or unsupported** and dropped. No CPU zero-copy exists across `main`↔`renderer`; `SharedArrayBuffer` cannot span it (§8). |
| Color | Ship **YUV** (NV12/I420) + a `colorSpace` tag carrying the source `AVCOL_*`. YUV→RGB convergence stays in the existing `VideoClipSprite.drawImage` chokepoint — **one** color model, byte-identical path to WebCodecs frames. No swscale-side YUV→RGB (would fork the color model). 10-bit sources are downconverted to 8-bit (VideoFrame has no 10-bit CPU format; preview is 8-bit anyway). |
| Routing | Extend `proxy_decision.rs` to a **three-valued** preview route: `Original | NativeFfmpeg | Proxy`. New invariant `preview == NativeFfmpeg ⇒ export == NativeFfmpeg` (both sides decode natively; there is no proxy unless the user opts in). Blind-spot detection by ffprobe codec family. |
| Proxy | **User opt-in only** (Premiere-style toggle). Not auto-scheduled at import, not performance-triggered. Native decode is the permanent default preview + export source for these formats. |
| Degrade stack | Inside the native path, never toward proxy: (1) `thread_count`/intra-frame parallel decode — always on, treats decode-boundness; (2) playback-resolution throttle (swscale to ½/¼ during playback, full on pause/scrub) — treats downstream + IPC cost; (3) frame-drop, audio-clock-locked — the floor. |
| Export | Export decodes natively too (§6). Realizes the universal entry on both sides; the main→worker decoded-frame hop is the one architecturally new piece (§6, §7). |

### 1.2 The corrected mental model (three traps to not fall back into)

1. **Software decode is not the hardware pipeline.** The `preview-gpu` path is fast because
   `d3d11va` frames are *already GPU textures* and share zero-copy. SW frames are in CPU
   memory; forcing them through a D3D11 upload + shared texture buys nothing over shipping
   bytes and adds a convert shader. Ship bytes.
2. **The decode-bench "native needs no rework" verdict does not cover this path.** That
   verdict is about the hardware path, which ships *zero* per-frame pixel bytes (persistent
   `importSharedTexture` + coordination pokes). Its bottleneck analysis (`coordRttMs`,
   "latency/congestion-bound") is about *message round-trips*, not *bandwidth*. Transport A
   is the first path in the project to move bulk pixel bytes across a process boundary — its
   bandwidth risk is new and real (hence §7).
3. **Playback-resolution throttle does not cut decode cost.** ProRes/DNxHD have no low-res
   decode ladder, so throttling means decode-full-then-swscale-down: it saves IPC + GPU
   upload + composite, not the decode itself. Decode-boundness is treated only by threads +
   frame-drop.

### 1.3 What this is *not*

Not the hardware shared-texture path (that is `preview-gpu`, for WebCodecs-decodable-but-heavy
sources, out of scope here). Not a 10-bit-precision preview (downconvert to 8-bit). Not HDR
preview (deferred, consistent with the existing 8-bit preview and `project_float16_probes`).
Not a change to the WebCodecs path for any format WebCodecs can already open.

## 2. Preview data path

New renderer handle `SwSourceHandle` (working name) implements `DecoderHandle`
(`SourceDecoderPool.ts:114`), mirroring the WebCodecs `SourceHandle` contract
(`requestFrameAt(srcTUs)` + a `FrameRing`), but the decoder lives in the Electron main
process:

1. **Main / Rust** (new `native/src/preview_sw/`): a per-source libavcodec software decode
   session on its own thread, reusing the *structure* (session, anchor-driven pump, thread
   lifecycle) of `native/src/preview_gpu/session.rs` but **not** its D3D11 output. The pump
   decodes forward from the anchor, `swscale`s each frame to 8-bit NV12/I420 (optionally
   downscaled for the active playback-resolution level, §4), and writes the planes into a
   recycled buffer.
2. **Transport** (§8): the buffer + `{pts, dur, w, h, format, colorSpace}` header cross to
   the renderer over the transfer channel; native does not retain the buffer.
3. **Renderer** (`SwSourceHandle`): `new VideoFrame(view, { format, codedWidth, codedHeight,
   timestamp, colorSpace })` → `createImageBitmap(vf)` → `vf.close()` → `ring.push(bitmap,
   pts, dur)`. Then transfer the now-drained buffer **back** to main for reuse (recycle).

Everything downstream of `FrameRing.push` — lookahead, `frameAt`, `VideoClipSprite`,
`drawImage` color convergence, the painter — is byte-for-byte the existing path. This is the
whole point of transport A.

Seek/scrub: intra-frame families (ProRes/DNxHD/HR) seek by decoding a single packet — faster
than long-GOP H.264; long-GOP families (MPEG-2/VC-1) reuse the existing seek-to-keyframe +
decode-forward logic. Reuse `PacketPump`'s contract shape on the Rust side.

## 3. Routing — three-valued preview route

Extend the import-time decision (`native/src/jobs/proxy_decision.rs`) and the folded
runtime enum (`renderer/render/decodeRoute.ts`, `shared/decode-route.ts`):

- `proxy_decision::decide` adds `NativeFfmpeg` as a preview value, chosen when the ffprobe
  codec name is in the blind-spot family set (`prores`, `dnxhd`, `mpeg2video`, `vc1`,
  `wmv3`) **and** libavcodec can open it. It does **not** schedule a proxy job (job = `None`)
  unless the user has opted into proxies.
- Invariant update: the existing `preview == Original ⇒ export == Original` gains a sibling
  `preview == NativeFfmpeg ⇒ export == NativeFfmpeg`. Both sides read the original; neither
  needs a proxy.
- `resolveDecode` maps `NativeFfmpeg` to acquiring `SwSourceHandle` (promote it out of the
  E2E gate for this route; the `preview-gpu` `forceStrategy` gate is untouched and stays
  bench-only).
- Cross-check (cheap, optional): the renderer may call `VideoDecoder.isConfigSupported` to
  confirm WebCodecs genuinely cannot open the codec before honoring `NativeFfmpeg`, guarding
  against a future Chromium that gains one of these codecs. Log a divergence; do not fail.

## 4. Degrade stack (native-NLE conventions, `feedback_native_nle_conventions`)

Applied **inside** the native path — proxy is never an automatic fallback.

1. **Always-on:** libavcodec `thread_count` = cores; enable frame/slice threading. For the
   intra-frame families this alone can lift sustained fps materially.
2. **Playback-resolution throttle:** a user-facing control (Premiere-style dropdown
   Full / ½ / ¼ + an `Auto` mode driven by observed frame-drop rate). At <Full, swscale
   downscales on the decode thread; this shrinks the transfer payload quadratically
   (½ ⇒ ¼ bytes, ¼ ⇒ 1/16) — the direct mitigation of transport A's only weakness. Full
   resolution is always restored on pause/scrub.
3. **Frame-drop floor:** playback is locked to the audio clock (`playbackStore`); a frame
   not ready by its deadline is skipped (hold last), never stalls A/V. The Compositor
   playback loop must tolerate a `frameAt` miss gracefully.

## 5. Proxy semantics

Proxy becomes a user-driven optimization, not a format gate:

- No automatic proxy scheduling for blind-spot formats at import (removes the `QuickThenFull`
  default for this route).
- A user toggle ("Create Proxies" / a per-project proxy mode) builds proxies and flips
  preview/export to read them — the same folded-route machinery, now user-initiated.
- Undo-safe: proxy-mode is a preference patch (`replace_settings_everywhere`, unrecorded —
  `project_settings_patch_convention`), so toggling never enters the undo stack.

## 6. Export path — the new main→worker frame transport

Established by investigation (this spec's date): the export worker is a **renderer Web
Worker** (`renderer/render/worker/runExport.ts:159`, `type:"module"`). It **cannot reach
napi** (native lives in the main process) and today **decodes for itself** — a per-worker
`ExportDecoderPool` + WebCodecs `VideoDecoder`, fetching compressed bytes over
`weftcut-media://` (`ExportDecoderPool.ts:504`, `MediaRangeSource.ts:38`). No decoded frames
cross main↔worker; only **encoded** output chunks flow worker→main with `chunk`/`chunk-ack`
backpressure (`exportWorker.ts:65-73`, `runExport.ts:237-249`).

Therefore, for blind-spot formats the worker's WebCodecs decoder cannot open the source, and
the fix is a **new** transport direction:

- **Main / Rust:** the same `preview_sw` decode session, driven by the export's frame
  schedule (export is not realtime — it pulls the exact PTS sequence the encoder needs).
- **Channel (measured, §7):** classic `ipcRenderer`/`webContents.send` main→renderer, then a
  same-process `postMessage` transfer renderer→export-worker. This beat `MessageChannelMain`
  in the spike and needs no port plumbing. (A direct main↔worker `MessagePort` was slower, and
  `MessagePortMain` cannot transfer `ArrayBuffer`s anyway.)
- **Discipline:** invert the existing 10-bit `chunk`/`chunk-ack` backpressure — main streams
  raw YUV frames with credit/ack so it never outruns the worker's encode + evict loop
  (mirrors `ExportFrameStore.evictBefore`, `exportWorker.ts:476`). Buffers recycle main↔worker.
- **Worker:** reconstruct `VideoFrame` from the received buffer and feed it into the existing
  export frame store, so the Compositor composites and the encoder encodes it exactly as
  today. The 8-bit `EncoderSink` (`encoder.ts:106`) and mux are unchanged.

This hop has **no precedent** in the codebase — which is why it gets a de-risk spike (§7)
before Phase 3 is committed.

## 7. Head-risk spike (measure-first) — MUST run before Phase 3

**Question (binary):** can `main`→`renderer`(→Web-Worker) raw-frame delivery sustain
export-viable throughput at 1080p and 4K frame sizes, or is Chromium IPC overhead a wall?

**Isolate the unknown.** Native libavcodec decode itself is *already de-risked* — the proxy
pipeline (`jobs/proxy.rs`, `jobs/quick_proxy.rs`) decodes arbitrary formats via ffmpeg-next
in production. The unproven piece is only the **cross-process transport**. So the spike ships
**synthetic** frames (allocate + fill NV12-sized buffers on the main side), not a real
decoder, and measures the channel in the faithful topology (Node main → Chromium renderer →
its Web Worker).

**Build (standalone POC, `poc/export-frame-transport/`, matching the `poc/shared-texture`
convention):** a minimal Electron harness — main process + one renderer + one renderer Web
Worker — measuring `main`→`renderer`(→worker) delivery on 1080p (≈3.1 MB NV12) and 4K
(≈12.4 MB NV12) buffers. Arms:

- **arm 0 — classic IPC:** `webContents.send` / `ipcRenderer.on` (structured clone). The
  baseline wall, for reference.
- **arm 1 — MessageChannelMain, no transfer:** a dedicated port `main`→`renderer`,
  `port.postMessage(buf)`.
- **arm 2 — MessageChannelMain + transfer + recycle:** `port.postMessage(buf,[buf.buffer])`
  — this *also* discovers whether `MessagePortMain` honors `ArrayBuffer` transfer at all (a
  finding either way); the renderer forwards the buffer into the Web Worker (same-process
  transfer) and returns drained buffers to main for reuse.

Each arm: the worker does `new VideoFrame(view,…)` + `createImageBitmap` + close (to include
the unavoidable in-renderer copy), reporting sustained **fps** + **MB/s**; the harness also
records the main-side post rate and steady-state pool depth.

**Success criterion:** the best arm sustains comfortably above the export encode rate at 4K
(≈60 fps × 12.4 MB ≈ 0.75 GB/s; target headroom ≥ 2×). A single 12 MB memcpy is ~1 ms, so raw
bandwidth is not the concern — the criterion is that Chromium IPC *overhead* does not push
per-frame delivery beyond the encode budget as frame size grows 1080p→4K, and that per-frame
cost is dominated by `createImageBitmap`, not the message hop.

**Decision the data drives:**
- the best arm clears the bar ⇒ Phase 3 uses it; transport is not a blocker.
- it plateaus below encode-viable ⇒ apply §8's real levers (shrink payload / tolerate for
  export / reconsider a HW-decode subset), **not** SAB.

**Scope guard for the spike:** no real ffmpeg decode, no encode, no wiring into the real
export worker. Synthetic buffers + the three transport arms only.

**Result (ran 2026-07-05, `poc/export-frame-transport/`, Electron 42.4.1 / Chromium 148, RTX
3050, full detail in that dir's `FINDINGS.md`):**

| arm | 1080p | 4K |
| --- | --- | --- |
| classic ipc (`webContents.send` → worker) | 327 fps / 1017 MB/s | **85.8 fps / 1067 MB/s** |
| `MessageChannelMain`, copy | 313 fps / 975 MB/s | 74.2 fps / 923 MB/s |
| `MessageChannelMain` + transfer + recycle | 241 fps / 750 MB/s | 57.8 fps / 719 MB/s |

`createImageBitmap` per frame: 1080p 3.25 ms, 4K 11.75 ms.

- `MessagePortMain` **rejects `ArrayBuffer` transfer** (`"Port at index 0 is not a valid
  port"`) ⇒ confirmed no CPU zero-copy across `main`↔`renderer`.
- **Classic `ipcRenderer` is the fastest channel**; recycling is counter-productive without
  transfer. The channel choice above is updated accordingly.
- Ceiling ~1 GB/s is **overhead-bound** (12 MB memcpy is ~1 ms; per-frame is ~11.7 ms at 4K);
  frame **batching** is the only untested lever, not needed for the verdict.

**Verdict: transport is viable, not a blocker.** Preview clears comfortably (86 fps @4K ≫
realtime; throttle + proxy backstop). Export is adequate-not-abundant at 4K (~43–85 fps
end-to-end; export is not realtime and 4K encode is usually the true bottleneck) — a clear win
for blind-spot formats that have no in-worker decode option at all. **Phase 3 is unblocked**
using classic ipc; no SAB, no zero-copy (none exists).

## 8. Cross-process channel — measure the real IPC ceiling; SAB does not apply

Decode runs in the Electron **main** process (napi); consumption (`VideoFrame`,
`createImageBitmap`, `FrameRing`, Pixi) runs in the **renderer** (preview) or a **renderer
Web Worker** (export). Every frame crosses the `main`↔`renderer` **OS process boundary**.

- **No CPU zero-copy across that boundary.** The GPU shared-texture path (`preview-gpu`) is
  zero-copy only because GPU handles cross the sandbox via Chromium's GPU process; there is no
  equivalent for CPU bytes. Bytes crossing `main`↔`renderer` move through Chromium's message
  pipe (Mojo), which for large payloads uses a shared-memory segment but still materializes a
  copy on the receiving side. The real question is therefore not "zero-copy vs copy" but **how
  much IPC overhead sits on top of the raw ~1 ms / 12 MB memcpy** — hence §7.
- **`SharedArrayBuffer` is not a lever here.** A SAB's backing store is shareable only within
  one agent cluster — a renderer plus its own workers, or threads inside one Node process. It
  **cannot** be shared between the Node main process and a Chromium renderer, so it cannot
  remove the `main`→`renderer` crossing. (It would only help a *renderer-main-thread → web-
  worker* hop, which is same-process and already cheap via transfer.) This **corrects an
  earlier assumption** that SAB was the escalation lever; it is not.
- **Chosen channel (measured, §7):** classic `ipcRenderer`/`webContents.send` `main`→`renderer`
  (fastest at ~1 GB/s), then a same-process `postMessage` transfer renderer→worker for export.
  `MessageChannelMain` was slower and `MessagePortMain` cannot transfer `ArrayBuffer`s; buffer
  recycling is counter-productive without transfer — all dropped. One in-renderer copy always
  remains (`new VideoFrame` copies into its media buffer) — GPU-adjacent, not IPC.
- **If §7 shows IPC is the wall, the levers are:** (a) shrink the payload — playback-
  resolution throttle and 8-bit YUV already do this, and export can cap intermediate size;
  (b) for export specifically, tolerate it — export is not realtime; (c) last resort:
  reconsider hardware-decode + shared-texture (option B) for the blind-spot subset that has a
  HW decoder. **Not** SAB.

## 9. Scope guard

- **Do not** reuse or extend the `preview-gpu` D3D11 shared-texture path for SW frames.
- **Do not** touch the WebCodecs `SourceHandle` / `ExportDecoderPool` decode path for any
  WebCodecs-decodable format.
- **Do not** build `SharedArrayBuffer`/Atomics before §7 arm 2 data demands it.
- **Do not** ship 10-bit-precision preview or HDR preview (downconvert to 8-bit).
- **Do not** auto-schedule proxies for blind-spot formats; proxy is user opt-in.
- **Do not** enable `d3d11va` for MPEG-2/VC-1 in this module (pure SW, uniform transport).

## 10. Testing & validation

- **decode-bench extension:** add a `strategy:'sw'` arm measuring `SwSourceHandle` throughput
  + the transport timing (the §7 arms, once real), reusing the `DecoderHandle`-seam driver
  (`decodeBench.ts`). Informative, not a CI gate.
- **media-conformance (`lib/analyze.mjs`, Playwright `_electron`):** SSIM of SW-preview vs an
  ffmpeg reference frame, and SW-export vs SW-preview (WYSIWYG), on a ProRes fixture. Requires
  a `VITE_WEFTCUT_E2E=1` build; gate the feature-union appropriately (`jobs,export,mcp,cloud`
  — the new module is a Cargo feature, keep the electron-ci Rust-tests + `napi:build` unions
  matched, per `reference_electron_ci_gotchas`).
- **memory-ratchet (`e2e/scripts/memory-ratchet.mjs`):** the `FrameRing` still holds
  `ImageBitmap`s, so the profile matches the WebCodecs path, but 4K ProRes ImageBitmaps are
  large — confirm the ring's 1 s lookahead memory stays within the ratchet at 4K.
- **Rust unit tests:** `proxy_decision` three-valued route (each family → `NativeFfmpeg`,
  export sibling invariant); swscale pixfmt/bitdepth reduction golden (10-bit→8-bit NV12).
- **Golden color:** a `AVCOL_*` → `VideoFrame.colorSpace` mapping table test, so SW frames
  converge identically to WebCodecs frames through `drawImage` (guards the single color model).

## 11. Phasing

1. **Phase 1 — preview, ProRes only.** `preview_sw/` + three-valued route + transport A over
   the transfer channel; un-gate behind an `AppSettings` switch. Validate with decode-bench +
   media-conformance SSIM + memory-ratchet.
2. **Phase 2 — four families + degrade stack.** Add DNxHD/DNxHR/MPEG-2/VC-1; frame-drop +
   playback-resolution throttle + the playback-resolution UI.
3. **Phase 3 — native export.** Only after §7's spike clears. Build the main→worker frame
   transport (invert 10-bit `chunk`/`chunk-ack`), wire `preview_sw` into the export schedule.
   Validate end-to-end SSIM (export vs preview) on a ProRes project.
4. **Cleanup.** Make proxy a pure user toggle; delete blind-spot auto-proxy scheduling.

## What is already free (not in the work estimate)

- **Timeline thumbnails / filmstrip** already support these formats — they decode via Rust
  ffmpeg (`jobs/filmstrip.rs`), so ProRes/DNxHD have always shown thumbnails. Only preview
  *playback* was the gap.
- **Audio** in MOV/MXF (typically PCM) already routes through the Rust ffmpeg conform path
  (`project_audio_engine`); blind-spot video formats need no new audio work.

So the true new surface is narrow: a native SW *video* source for preview and export; the
surrounding subsystems (thumbnails, audio, compositor, color convergence) are all reused.

**Terminal deliverable of the de-risk step (§7): DONE (2026-07-05).** See
`poc/export-frame-transport/FINDINGS.md`. Verdict: **transport is viable, Phase 3 unblocked**;
channel = classic `ipcRenderer` (~1 GB/s, 86 fps @4K); `MessagePortMain` cannot transfer
`ArrayBuffer`s and there is no CPU zero-copy across `main`↔`renderer`; SAB inapplicable. 4K
export is a real co-cost (no 2× headroom) but not a blocker; frame-batching is the sole
remaining lever if it ever matters.
