import { convertFileSrc } from "@/bridge/ipc";
import { listen } from "@/bridge/events";
import { join, tempDir } from "@/bridge/path";
import { SecondaryWindow, getCurrentWindow, ProgressBarStatus } from "@/bridge/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@/bridge/notification";
import { remove, writeFile } from "@/bridge/fs";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ensureExportAudioConform,
  ensureFullProxy,
  exportProjectAudioOnly,
  muxExport,
  MEDIA_JOB_EVENTS,
  type MediaJobEvent,
  projectSummary,
  type MediaSummary,
} from "../ipc";
import { type ProxyState } from "../panels/mediaReadiness";
import { probeSourceDecodable } from "../render/decoder/probeSourceDecodable";
import { hasVisibleContent, referencedVideoMediaIds } from "../render/activeVideoLayers";
import {
  type ExportSettings,
  type WebCodecsCodecId,
  codecString,
  compositeBitDepth,
  computeBitrate,
  defaultCrf,
  encoderHwHint,
  gopFrames,
  isIntermediateCodec,
  resolveOutputDims,
} from "../render/exportSettings";
import { approxFrameDurUs } from "../frames";
import { rendererOS } from "../platform";
import {
  exportVideoSinkStart,
  exportVideoSinkFinish,
  exportVideoSinkCancel,
  exportVideoSinkWrite,
} from "../ipc";
import { smokeEncode } from "../render/exportCodecProbe";
import { needsEncoderProbe, resolveEncodeTarget } from "../render/encodeTarget";
import {
  type ExportDecodeRouting,
  proxyWaitScope,
  resolveExportDecodeRouting,
} from "../render/exportDecodeRouting";
import { useDecodeComponentStore } from "../settings/decodeComponentStore";
import { exportBakeMotifs } from "../render/exportBake";
import { getMotif } from "../render/motifs/catalog";
import {
  prepareExportMedia,
  waitForProxies,
  createConformTracker,
  ExportCancelled,
  ExportProxyFailed,
  type ProbeState,
} from "../render/exportReadiness";
import { type ExportState } from "../panels/ExportPanel";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { useProjectStore } from "../state/projectStore";
import { resolveDecode } from "../render/decodeRoute";

/// Owns the export lifecycle: the export panel/dialog state, the window
/// close-guard, taskbar-progress + native-notification mirrors, and the
/// three-stage export pipeline itself. The refs in `deps` still live in
/// App (other consumers read them there); the hook takes them as inputs.
export function useExportFlow(deps: {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
}): {
  exportState: ExportState | null;
  setExportState: React.Dispatch<React.SetStateAction<ExportState | null>>;
  exportDialogOpen: boolean;
  setExportDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeConfirmOpen: boolean;
  setCloseConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runExportWithSettings: (settings: ExportSettings, path: string,
    range?: { startUs: number; endUs: number }) => Promise<void>;
  openRenderPlayPopup: (path: string) => Promise<void>;
} {
  const { t } = useTranslation();
  const { previewRef, proxyStateRef, decodeProbeMemo } = deps;

  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // Close-guard: the window ✕ (or any close request) during a running
  // export pops a confirm instead of silently killing the export. The ref
  // mirrors export-busy so the close-requested listener (registered once)
  // reads fresh state.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const exportBusyRef = useRef(false);

  // Close-guard wiring. "Busy" = an export that closing would kill;
  // complete/error states are dismissable and don't block the window.
  useEffect(() => {
    exportBusyRef.current =
      exportState !== null &&
      exportState.kind !== "complete" &&
      exportState.kind !== "error";
  }, [exportState]);
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      if (exportBusyRef.current) {
        event.preventDefault();
        setCloseConfirmOpen(true);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Taskbar progress mirrors the export lifecycle (ITaskbarList3 on
  // Windows, via Electron): indeterminate pulse while starting/preparing,
  // percent while encoding, error-red on failure, cleared on dismiss or
  // completion. Best-effort — a failed call never blocks the export.
  useEffect(() => {
    const win = getCurrentWindow();
    const set = (bar: Parameters<typeof win.setProgressBar>[0]) =>
      void win.setProgressBar(bar).catch(() => {});
    if (exportState === null || exportState.kind === "complete") {
      set({ status: ProgressBarStatus.None });
      return;
    }
    switch (exportState.kind) {
      case "starting":
      case "preparing":
        set({ status: ProgressBarStatus.Indeterminate });
        break;
      case "progress":
        set({
          status: ProgressBarStatus.Normal,
          progress: Math.round(exportState.progress.progress * 100),
        });
        break;
      case "error":
        set({ status: ProgressBarStatus.Error, progress: 100 });
        break;
    }
  }, [exportState]);
  // Clear any leftover taskbar state if the editor unmounts (project
  // closed) while a progress bar is showing.
  useEffect(() => {
    return () => {
      void getCurrentWindow()
        .setProgressBar({ status: ProgressBarStatus.None })
        .catch(() => {});
    };
  }, []);

  // Native toast when an export reaches a terminal state while the window
  // is unfocused — the in-app panel and taskbar progress are invisible to
  // a user working in another app. Terminal states are set exactly once
  // per export, so this fires at most once each. Best-effort.
  useEffect(() => {
    if (
      !exportState ||
      (exportState.kind !== "complete" && exportState.kind !== "error")
    ) {
      return;
    }
    const state = exportState;
    void (async () => {
      try {
        if (await getCurrentWindow().isFocused()) return;
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (!granted) return;
        if (state.kind === "complete") {
          sendNotification({
            title: t("export.notify_done_title"),
            body: t("export.notify_done_body", {
              path: state.payload.outputPath,
            }),
          });
        } else {
          sendNotification({
            title: t("export.notify_failed_title"),
            body: t("export.notify_failed_body", { detail: state.detail }),
          });
        }
      } catch {
        // Notifications are a courtesy; never let them surface as errors.
      }
    })();
  }, [exportState, t]);

  // Pixi/WebCodecs export. Three-stage pipeline:
  //
  //   1. PreviewSurface handle suspends the preview compositor and drives
  //      the Worker; the Worker streams video-only fMP4 chunks to tempVideoPath.
  //   2. Rust audio-only export produces a sibling .m4a (AAC) or .mka (Opus).
  //   3. Rust mux/transcode writes the user-chosen path.
  //
  // The Worker emits progress on every encoded frame; that maps to
  // the encode phase of ExportPanel. Audio + mux run silently in
  // the "finalizing" tail (panel stays at progress=1.0 with the
  // last Worker fps numbers) — they should be sub-2-second for any
  // typical project.
  //
  // Temp files live under the OS temp dir with UUIDs; cleaned in
  // a finally block. If cleanup itself fails the user's output is
  // still good — we just leave the temps for the next reboot to
  // clear.
  const runExportWithSettings = useCallback(
    async (settings: ExportSettings, path: string, range?: { startUs: number; endUs: number }) => {
    // ---- No-material guard -----------------------------------------------
    // A video export with nothing visible to render would emit pure black —
    // reject it as "no video material" instead. (Audio emptiness is judged
    // below via export_project_audio_only's `produced` flag, since a clip's
    // audio stream isn't visible from the project summary.)
    if (settings.includeVideo) {
      // Read the project from Rust, not the event-driven store: the store summary
      // can lag a just-added layer (its autofit `duration_us` arrives a tick
      // later), so a stale `duration_us` of 0 windows the export to [0,0] and
      // false-rejects a present layer. Same hazard the audio-only path below
      // already guards against by reading fresh from Rust.
      const proj = await projectSummary().catch(() => useProjectStore.getState().summary);
      if (proj) {
        const sUs = range?.startUs ?? 0;
        const eUs = range?.endUs ?? proj.duration_us;
        if (!hasVisibleContent(proj, sUs, eUs)) {
          setExportState({ kind: "error", detail: t("export.no_video_material") });
          return;
        }
      }
    }

    // ---- Audio-only export: skip every video stage -----------------------
    // No decode/proxy gate, motif bake, encode, sink, or mux — just conform the
    // audible layers and write the audio file straight to `path` (.m4a/.mka by
    // the dialog's extension). Video-only is NOT handled here: it keeps the full
    // video pipeline and simply omits the audio mux (settings.audio.include is
    // false), which the existing code below already does.
    if (settings.includeAudio && !settings.includeVideo) {
      const store = useProjectStore.getState();
      // Read the project from Rust directly, not the event-driven store: the
      // store summary can lag a just-added layer (its autofit `duration_us`
      // arrives a tick later), and a stale `duration_us` of 0 would window the
      // export to [0,0] → empty plan → a false "no audio material". The main
      // video path is immune because it reads the summary only after its
      // readiness-gate awaits.
      const proj = await projectSummary().catch(() => store.summary);
      if (!proj) {
        setExportState({ kind: "error", detail: "No project loaded." });
        return;
      }
      const startUs = range?.startUs ?? 0;
      const endUs = range?.endUs ?? proj.duration_us;
      setExportState({ kind: "starting" });
      const tracker = createConformTracker(listen);
      try {
        await tracker.ready; // listeners first — a fast job must not slip by
        const conformWaiting = await ensureExportAudioConform({ startUs, endUs });
        if (conformWaiting.length > 0) {
          const ctrl = new AbortController();
          setExportState({
            kind: "preparing",
            labels: conformWaiting.map(
              (id) => store.mediaById.get(id)?.label ?? id,
            ),
            onCancel: () => ctrl.abort(),
          });
          await tracker.waitFor(conformWaiting, ctrl.signal);
        }
      } catch (e) {
        if (e instanceof ExportCancelled) {
          setExportState(null);
          return;
        }
        const id = e instanceof ExportProxyFailed ? e.mediaId : "";
        const label = store.mediaById.get(id)?.label ?? id;
        setExportState({
          kind: "error",
          detail: t("export.failed_prepare", { labels: label }),
        });
        return;
      } finally {
        tracker.dispose();
      }
      try {
        setExportState({ kind: "starting" });
        const produced = await exportProjectAudioOnly(
          path,
          {
            codec: settings.audio.codec,
            bitrate: settings.audio.bitrate,
            sampleRate: settings.audio.sampleRate,
            channels: settings.audio.channels,
          },
          { startUs, endUs },
        );
        if (!produced) {
          // No audio layers in range → Rust wrote nothing. Surface it rather
          // than reporting a "complete" export with no file on disk.
          setExportState({
            kind: "error",
            detail: t("export.no_audio_material"),
          });
          return;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] audio-only export failed:", e);
        setExportState({ kind: "error", detail: `Audio export failed: ${msg}` });
        return;
      }
      setExportState({
        kind: "complete",
        payload: { outputPath: path, durationUs: endUs - startUs },
      });
      return;
    }

    // ---- Export-readiness gate -------------------------------------------
    // Confirm every video source the export will decode is ready. Undecodable
    // DirectExport sources are route-corrected here; sources whose proxy is
    // still encoding put the panel into "preparing" and auto-start when ready.
    let decodeRouting: ExportDecodeRouting | null = null;
    {
      const store = useProjectStore.getState();
      const proj = store.summary; // block-scoped; avoids shadowing the later `summary` local
      if (!proj) {
        setExportState({ kind: "error", detail: "No project loaded." });
        return;
      }
      const startUs = range?.startUs ?? 0;
      const endUs = range?.endUs ?? proj.duration_us;
      const referencedIds = referencedVideoMediaIds(proj, startUs, endUs);
      const referencedMedia = [...referencedIds]
        .map((id) => store.mediaById.get(id))
        .filter((m): m is MediaSummary => !!m);

      // ---- Decode-engine resolution (ONCE, frozen for this export) --------
      // Runs BEFORE the readiness gate so native-routed blind-spot media
      // never enter the probe / full-proxy machinery below — they export
      // immediately off their originals. Rationale + rules live in
      // exportDecodeRouting.ts.
      decodeRouting = resolveExportDecodeRouting({
        setting: settings.decodeEngine,
        componentAvailable: useDecodeComponentStore.getState().available,
        bitDepth: compositeBitDepth(settings),
        media: referencedMedia,
      });

      setExportState({ kind: "starting" });
      const prep = await prepareExportMedia(proxyWaitScope(referencedMedia, decodeRouting), {
        probe: (url) => probeSourceDecodable(url),
        ensureFullProxy: (id) => ensureFullProxy(id),
        proxyStateOf: (id) => proxyStateRef.current.get(id),
        urlForOriginal: (m) => convertFileSrc(m.path),
        memo: decodeProbeMemo.current,
      });

      if (prep.failed.length > 0) {
        const labels = prep.failed
          .map((id) => store.mediaById.get(id)?.label ?? id)
          .join(", ");
        setExportState({
          kind: "error",
          detail: t("export.failed_prepare", { labels }),
        });
        return;
      }

      if (prep.waiting.length > 0) {
        const ctrl = new AbortController();
        const labels = prep.waiting.map(
          (id) => store.mediaById.get(id)?.label ?? id,
        );
        setExportState({
          kind: "preparing",
          labels,
          onCancel: () => ctrl.abort(),
        });
        try {
          await waitForProxies(prep.waiting, {
            pathReady: (id) => {
              const m = useProjectStore.getState().mediaById.get(id);
              return m != null && resolveDecode(m).exportPath != null;
            },
            subscribeStore: (cb) => useProjectStore.subscribe(cb),
            onProxyError: (cb) => {
              // `listen` is async; guard against it resolving after cleanup
              // (which would leak the listener).
              let off: (() => void) | null = null;
              let disposed = false;
              void listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
                if (e.payload.kind === "proxy") cb(e.payload.media_id);
              }).then((u) => {
                if (disposed) u();
                else off = u;
              });
              return () => {
                disposed = true;
                off?.();
              };
            },
            signal: ctrl.signal,
          });
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          const id = e instanceof ExportProxyFailed ? e.mediaId : "";
          const label = store.mediaById.get(id)?.label ?? id;
          setExportState({
            kind: "error",
            detail: t("export.failed_prepare", { labels: label }),
          });
          return;
        }
      }

      // ---- Audio conform gate ---------------------------------------------
      // Every audible Audio layer in range needs its conform PCM — the Rust
      // export mixer reads only conform files (docs/audio.md). Selection +
      // readiness live Rust-side (`ensure_export_audio_conform`, sharing the
      // mix plan's layer walk so gate and plan can't disagree); completion is
      // job-event-tracked because a stale conform_path (cache file deleted)
      // reads identically in the store before and after the re-conform.
      if (settings.audio.include) {
        const tracker = createConformTracker(listen);
        try {
          await tracker.ready; // listeners first — a fast job must not slip by
          const conformWaiting = await ensureExportAudioConform({
            startUs,
            endUs,
          });
          if (conformWaiting.length > 0) {
            const ctrl = new AbortController();
            setExportState({
              kind: "preparing",
              labels: conformWaiting.map(
                (id) => store.mediaById.get(id)?.label ?? id,
              ),
              onCancel: () => ctrl.abort(),
            });
            await tracker.waitFor(conformWaiting, ctrl.signal);
          }
        } catch (e) {
          if (e instanceof ExportCancelled) {
            setExportState(null);
            return;
          }
          const id = e instanceof ExportProxyFailed ? e.mediaId : "";
          const label = store.mediaById.get(id)?.label ?? id;
          setExportState({
            kind: "error",
            detail: t("export.failed_prepare", { labels: label }),
          });
          return;
        } finally {
          tracker.dispose();
        }
      }
    }
    // ---- end gate --------------------------------------------------------

    // Allocate unique temp paths up-front so cleanup in `finally`
    // can hit them whether or not the respective stage completed.
    const tempBase = await tempDir();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempVideoExt = isIntermediateCodec(settings.codec) ? "mov" : "mp4";
    const tempVideoPath = await join(tempBase, `weftcut-pixi-${stamp}.${tempVideoExt}`);
    const audioExt = settings.audio.codec === "opus" ? "mka" : "m4a";
    const tempAudioPath = await join(tempBase, `weftcut-pixi-${stamp}.${audioExt}`);

    const summary = useProjectStore.getState().summary!;
    const comp = summary.composition;
    const exportRange = {
      startUs: range?.startUs ?? 0,
      endUs: range?.endUs ?? summary.duration_us,
    };

    // ---- Bake Motif layers --------------------------------------------
    // The export Worker has no DOM, so it can't run the SVG capture harness.
    // Pre-rasterize every Motif layer's frames here (main thread) and pass
    // them into the export request; the Worker binds them by comp-frame index.
    // CRITICAL: bake on the COMPOSITION fps (comp.fps_num/den), NOT the export
    // output fps — the Worker's MotifSprite indexes injected frames with the
    // Compositor's comp fps, so a different output fps must not change the bake
    // grid (it would shift the index → out-of-range / duplicated frames). The
    // output fps only resamples WHICH comp-frame each output frame maps to,
    // which the Worker handles via the time grid.
    let motifFrames: Record<string, ImageBitmap[]> = {};
    try {
      const motifIds = new Set<string>();
      for (const tr of summary.tracks) {
        for (const l of tr.layers) {
          if (l.enabled && l.params.kind === "Motif") {
            motifIds.add(l.params.motif_id);
          }
        }
      }
      if (motifIds.size > 0) {
        const labels = [...motifIds].map(
          (id) => getMotif(id)?.manifest.name ?? id,
        );
        // No cancellable step in the bake loop, so omit onCancel — the panel
        // hides the Cancel button rather than offering a dead one.
        setExportState({ kind: "preparing", labels });
      }
      motifFrames = await exportBakeMotifs(
        summary,
        exportRange.startUs,
        exportRange.endUs,
        comp.fps_num,
        comp.fps_den,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] motif bake failed:", e);
      setExportState({ kind: "error", detail: `Motif render failed: ${msg}` });
      return;
    }
    // ---- end bake --------------------------------------------------------

    const dims = resolveOutputDims(comp, settings);
    const fpsNum = settings.fps != null ? settings.fps : comp.fps_num;
    const fpsDen = settings.fps != null ? 1 : comp.fps_den;
    const outFps = fpsNum / fpsDen;
    // `path` already carries the chosen container extension (set by the dialog).

    // One resolution seam for the encode engine (see docs/render.md §"Encode exits").
    // Probe injected: the smoke-encode only runs when the target needs it —
    // as of E4 that's only an explicit WebCodecs pin; `auto` always resolves
    // native and this ternary short-circuits to `true` unconsulted. Cast is
    // sound: this branch only runs when needsEncoderProbe(settings) is true,
    // which needsEncoderProbe itself defines as excluding
    // isIntermediateCodec(settings.codec) — so settings.codec here is always
    // a WebCodecsCodecId, never "prores"/"dnxhr".
    const needsProbe = needsEncoderProbe(settings);
    const smokeOk = needsProbe
      ? await smokeEncode(
          settings.codec as WebCodecsCodecId,
          dims.width,
          dims.height,
          outFps,
        )
      : true;
    // A pinned WebCodecs export that fails its own smoke test has no
    // fallback — the pin is explicit user intent, unlike `auto`'s
    // fallback-carrying native-first path (handled below at the native
    // sink-start catch). Fail loudly, before the sink or the export Worker
    // ever starts, instead of letting resolveEncodeTarget silently proceed
    // with an encoder that just proved it can't run.
    if (needsProbe && !smokeOk) {
      setExportState({
        kind: "error",
        detail: t("export_dialog.codec_unsupported", {
          codec: settings.codec.toUpperCase(),
        }),
      });
      return;
    }
    // `let`, not `const`: a native sink-start failure under `auto` can flip
    // this trio to a consent-gated WebCodecs retry below (E4). `sinkTarget`
    // is nulled out alongside the flip so its type (`NativeTarget | null`)
    // stays honest — no consumer below may assert it non-null with `!`;
    // each site re-checks `sinkTarget` (or reads it after the flip settles).
    let target = resolveEncodeTarget(settings, smokeOk);
    let nativeSink = target.engine === "native";
    let sinkTarget = target.engine === "native" ? target : null;

    // Native-sink path: start the native-encode video sink (ffmpeg, frames
    // streamed over IPC) before the Worker starts. On the WebCodecs path the
    // existing fMP4 streaming path is used.
    if (nativeSink && sinkTarget) {
      try {
        await exportVideoSinkStart({
          width: dims.width,
          height: dims.height,
          fpsNum,
          fpsDen,
          codec: settings.codec,
          pixFmt: sinkTarget.pixFmt,
          bitrate: computeBitrate(settings, dims.width, dims.height, outFps),
          cbr: settings.rateMode === "cbr",
          gop: gopFrames(settings.keyframeIntervalSec, outFps),
          software:
            settings.hwAccel === "software" || settings.rateMode === "quality",
          ...(settings.rateMode === "quality" && !isIntermediateCodec(settings.codec)
            ? { crf: settings.crf ?? defaultCrf(settings.codec) }
            : {}),
          preset: settings.preset,
          ...(settings.codec === "prores" ? { profile: settings.proresProfile } : {}),
          ...(settings.codec === "dnxhr" ? { profile: settings.dnxhrProfile } : {}),
          outputPath: tempVideoPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] video sink start failed:", e);
        // Native encoder unavailable under `auto`, on a combo WebCodecs can
        // actually take (8-bit, non-intermediate): offer an explicit-consent
        // fallback instead of hard-erroring — never a silent encoder swap.
        // Pinned-native / 10-bit / intermediate-codec failures, and a
        // declined dialog, keep the original hard error.
        const canFallBack =
          settings.encoderEngine === "auto" &&
          !isIntermediateCodec(settings.codec) &&
          settings.bitDepth === 8;
        if (
          canFallBack &&
          window.confirm(t("export_dialog.native_unavailable_fallback"))
        ) {
          const fallbackOk = await smokeEncode(
            settings.codec as WebCodecsCodecId,
            dims.width,
            dims.height,
            outFps,
          );
          if (!fallbackOk) {
            setExportState({
              kind: "error",
              detail: t("export_dialog.native_unavailable_no_fallback"),
            });
            return;
          }
          target = {
            engine: "webcodecs",
            workerCodec: settings.codec as WebCodecsCodecId,
          };
          nativeSink = false;
          sinkTarget = null;
        } else {
          setExportState({ kind: "error", detail: `Failed to start the native encoder: ${msg}` });
          return;
        }
      }
    }
    // `target`/`nativeSink` are final past this point (the only reassignment
    // is the fallback retry above) — safe to derive the worker-facing values
    // that feed the encoder config and bitrate calc below. `workerCodec` is
    // only meaningful on the webcodecs path (the native-sink path's
    // encoderConfig below is dead — see the comment on `codec:` there).
    const workerCodec =
      target.engine === "webcodecs" ? target.workerCodec : settings.codec;
    const workerBitrate = computeBitrate(settings, dims.width, dims.height, outFps);
    // Encoder-acceleration hint (WebCodecs path only — the worker IS the
    // final encode there). Chromium treats the hint as MANDATORY, so asking
    // for prefer-hardware is OS-allowlisted (encoderHwHint): on Linux there
    // is no WebCodecs hardware VideoEncoder and the ask would hard-error
    // instead of falling back (issue #7 boundary #10).
    const hwHint = encoderHwHint(rendererOS, workerCodec, settings.hwAccel);
    const encoderConfig: VideoEncoderConfig = {
      // codecString only runs on the WebCodecs path, where target.workerCodec
      // is a genuine WebCodecsCodecId. On the native-sink path settings.codec
      // can be a prores/dnxhr intermediate — codecString throws on those — so
      // the field carries an inert "": the Worker never constructs an
      // EncoderSink from this config when nativeSink is set (exportWorker.ts
      // reads only .width/.height there).
      codec: target.engine === "webcodecs" ? codecString(target.workerCodec) : "",
      width: dims.width,
      height: dims.height,
      bitrate: workerBitrate,
      framerate: outFps,
      bitrateMode: settings.rateMode === "cbr" ? "constant" : "variable",
      ...(hwHint ? { hardwareAcceleration: hwHint } : {}),
    };

    const startedAtMs = performance.now();
    const onProgress = (encoded: number, total: number) => {
      if (total <= 0) return;
      const elapsedSec = (performance.now() - startedAtMs) / 1000;
      const fps = elapsedSec > 0 ? encoded / elapsedSec : 0;
      // `encoded * nominal` is exactly the accumulating product frames.ts warns
      // against — fine here because nothing reads it as a grid time: it feeds
      // the progress/speed readout, where lagging ~1 frame per hour of output
      // is invisible.
      const currentTimeUs = encoded * approxFrameDurUs(fpsNum, fpsDen);
      const speed = elapsedSec > 0 ? currentTimeUs / 1e6 / elapsedSec : 0;
      setExportState({
        kind: "progress",
        progress: {
          progress: encoded / total,
          currentTimeUs,
          frame: encoded,
          fps,
          speed,
        },
      });
    };

    // Stream the worker's output to the temp file: it emits the MP4 in
    // sequential slices (fMP4) which we append here, so the whole file is never
    // held in one ArrayBuffer (V8's ~2GB cap OOM'd long exports). `writeFile`
    // with `append` is used instead of an open FileHandle because the fs bridge
    // exposes append-write but no open-handle API. The temp path is a fresh
    // UUID, so the first append creates it (create defaults true).
    // On the native-sink path the Worker streams raw packed frames via the
    // chunk/ack channel; the main thread forwards them to export_video_sink_write.
    const writeChunk = nativeSink
      ? async (data: ArrayBuffer): Promise<void> => {
          await exportVideoSinkWrite(new Uint8Array(data));
        }
      : async (data: ArrayBuffer): Promise<void> => {
          await writeFile(tempVideoPath, new Uint8Array(data), { append: true });
        };

    setExportState({ kind: "starting" });
    let result;
    try {
      result = await previewRef.current?.runPixiExport({
        onProgress,
        encoderConfig,
        outputFps: { num: fpsNum, den: fpsDen },
        startUs: exportRange.startUs,
        endUs: exportRange.endUs,
        keyframeIntervalSec: settings.keyframeIntervalSec,
        writeChunk,
        motifFrames,
        bitDepth: compositeBitDepth(settings),
        ...(nativeSink && sinkTarget ? { nativeSinkPixFmt: sinkTarget.pixFmt } : {}),
        ...(decodeRouting ? { decodeRouting } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] export failed:", e);
      if (nativeSink) await exportVideoSinkCancel().catch(() => {});
      setExportState({ kind: "error", detail: msg });
      return;
    }
    if (!result) {
      if (nativeSink) await exportVideoSinkCancel().catch(() => {});
      setExportState({
        kind: "error",
        detail: "Preview not initialized.",
      });
      return;
    }

    // On the native-sink path, signal the sink that all frames have been
    // sent. The sink flushes its encoder + muxer and writes the final
    // tempVideoPath. Must run BEFORE the audio export + mux.
    if (nativeSink) {
      try {
        await exportVideoSinkFinish();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[weftcut/pixi] sink finish failed:", e);
        setExportState({ kind: "error", detail: `Finalize failed: ${msg}` });
        void remove(tempVideoPath).catch(() => {});
        void remove(tempAudioPath).catch(() => {});
        return;
      }
    }

    try {
      // (1) Video is already written to tempVideoPath (streamed above).
      // Audio-only Rust export -> temp audio file (.m4a/.mka).
      if (settings.audio.include) {
        await exportProjectAudioOnly(
          tempAudioPath,
          {
            codec: settings.audio.codec,
            bitrate: settings.audio.bitrate,
            sampleRate: settings.audio.sampleRate,
            channels: settings.audio.channels,
          },
          { startUs: exportRange.startUs, endUs: exportRange.endUs },
        );
      }

      // (3) Mux → user-chosen path. Every path already wrote the final codec
      // to tempVideoPath (WebCodecs direct-encode, or the native-encode video
      // sink) — the mux step is always a stream-copy into the chosen container.
      await muxExport(tempVideoPath, tempAudioPath, path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[weftcut/pixi] finalize failed:", e);
      // nativeSink sink-finish already ran (above); mux failure doesn't need cancel.
      setExportState({
        kind: "error",
        detail: `Finalize failed: ${msg}`,
      });
      return;
    } finally {
      // Best-effort cleanup. Failures here are intentionally
      // swallowed — the user's output is already at `path`.
      void remove(tempVideoPath).catch(() => {});
      void remove(tempAudioPath).catch(() => {});
    }

    const durationUs = Math.round(
      (result.totalFrames * 1_000_000 * result.fpsDen) / result.fpsNum,
    );
    setExportState({
      kind: "complete",
      payload: { outputPath: path, durationUs },
    });
    },
    [t, previewRef, proxyStateRef, decodeProbeMemo],
  );

  // E2E-only: mirror the export phase onto window so a WebDriver diagnostic can
  // see where a hung export is stuck (null → starting → preparing → progress →
  // complete/error). Stripped from prod (static VITE_WEFTCUT_E2E check).
  useEffect(() => {
    if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
    (window as unknown as { __weftcutExportState?: unknown }).__weftcutExportState =
      exportState;
  }, [exportState]);

  // Render & Play: open an Electron window pointing at the
  // exported MP4 via the weftcut-media:// protocol. The popup HTML lives at
  // /render-play.html (vite copies from public/); URL hash carries
  // the asset URL + display path. Each invocation gets a unique
  // label so multiple plays can coexist (and so the capability
  // pattern `render-play-*` matches every variant).
  const openRenderPlayPopup = useCallback(async (path: string) => {
    const src = convertFileSrc(path);
    const label = `render-play-${Date.now()}`;
    const url =
      `/render-play.html#src=${encodeURIComponent(src)}` +
      `&path=${encodeURIComponent(path)}`;
    try {
      // Window load failures surface in the main-process console (win:* IPC is
      // fire-and-forget; the secondary-window lifecycle isn't bridged back).
      new SecondaryWindow(label, {
        url,
        title: "WeftCut — Render & Play",
        width: 960,
        height: 600,
        resizable: true,
      });
    } catch (e) {
      console.error("[weftcut/render-play] failed to open popup:", e);
    }
  }, []);

  return {
    exportState,
    setExportState,
    exportDialogOpen,
    setExportDialogOpen,
    closeConfirmOpen,
    setCloseConfirmOpen,
    runExportWithSettings,
    openRenderPlayPopup,
  };
}
