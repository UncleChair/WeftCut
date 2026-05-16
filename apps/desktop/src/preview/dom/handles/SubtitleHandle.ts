/// Phase D — Subtitles layer handle.
///
/// Renders ASS/SRT subtitles via JASSUB (libass compiled to WASM)
/// onto a `<canvas>` overlay sized to the project composition.
/// Same renderer ffmpeg's `subtitles` filter uses at export, so
/// preview pixels are byte-identical to export pixels for
/// subtitles (the only layer kind with bought parity per the Q1
/// fidelity contract).
///
/// Source handling:
///   - `InlineAss` / `InlineSrt`: pass body directly via
///     `subContent`.
///   - `Media`: fetch the file via `convertFileSrc(media.path)`
///     and feed JASSUB the resulting text.
///
/// JASSUB API specifics (v2.5.x):
///   - Constructor calls `transferControlToOffscreen()` on the
///     canvas — main thread cannot draw on it after. Rendering
///     happens in a Web Worker.
///   - Time is driven via `manualRender(data)` where
///     `data.mediaTime` is the subtitle clock in seconds.
///   - No `setCurrentTime` method on v2.5+.
///
/// Workspace-font wiring is deferred — JASSUB uses its bundled
/// `liberation sans` default for any unresolved font. Templates'
/// ASS files referencing custom fonts may render with a fallback
/// until the workspace-fonts directory is wired through
/// `availableFonts`.

import { convertFileSrc } from "@tauri-apps/api/core";
import JASSUB from "jassub";
import workerUrl from "jassub/dist/worker/worker.js?url";
import wasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import modernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";

import { useProjectStore } from "../../../state/projectStore";
import type { SubtitlesView } from "../../../ipc";
import type { HandleContext, LayerHandle } from "./types";

export class SubtitleHandle implements LayerHandle {
  private canvas: HTMLCanvasElement;
  private jassub: JASSUB | null = null;
  /// Cached source-key (kind+value) — when it changes, we destroy
  /// + re-create JASSUB. Same instance can't load a different
  /// track without rebuilding.
  private currentSourceKey: string | null = null;
  /// True after the JASSUB worker's `ready` promise resolves and we
  /// can safely call `manualRender`.
  private ready = false;
  private disposed = false;

  constructor(private ctx: HandleContext) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.visibility = "hidden";
    // Drawing-buffer size = composition resolution; CSS size matches
    // so the parent PreviewSurface's transform: scale wraps it
    // identically to other layers. `transferControlToOffscreen`
    // requires the size be set BEFORE the transfer happens.
    const composition = useProjectStore.getState().summary?.composition;
    const w = composition?.width ?? 1920;
    const h = composition?.height ?? 1080;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    ctx.container.appendChild(this.canvas);

    void this.refresh();
  }

  tick(masterUs: number, _playing: boolean): void {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Subtitles") {
      this.hide();
      return;
    }

    // Source changed — rebuild JASSUB on the next async tick.
    const key = sourceKey(layer.params);
    if (key !== this.currentSourceKey) {
      void this.refresh();
      // Continue rendering the existing track until the new one
      // is ready, to avoid a visible flash.
    }

    if (masterUs < layer.t_start_us || masterUs >= layer.t_end_us) {
      this.hide();
      return;
    }

    this.canvas.style.visibility = "visible";

    if (!this.ready || !this.jassub) return;
    const localSec = (masterUs - layer.t_start_us) / 1_000_000;
    try {
      this.jassub.manualRender({
        mediaTime: localSec,
        width: this.canvas.width,
        height: this.canvas.height,
        // JASSUB doesn't use this for compositing math; pass real
        // wall time so any diagnostics line up with the host RAF.
        expectedDisplayTime: performance.now(),
      });
    } catch {
      // Worker may be mid-rebuild; ignore — next tick retries.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyJassub();
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  // ===== Internal =========================================================

  /// Rebuild JASSUB with the current layer's subtitle source. Async
  /// because Media-source needs a fetch to resolve. New JASSUB
  /// instance attaches to a FRESH canvas — `transferControlToOffscreen`
  /// is one-shot per canvas, so on each refresh we swap the
  /// existing canvas for a new one.
  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const layer = useProjectStore.getState().layerById.get(this.ctx.layerId);
    if (!layer || layer.params.kind !== "Subtitles") return;

    const targetKey = sourceKey(layer.params);
    const subContent = await loadSubtitleContent(layer.params);
    if (this.disposed) return;
    if (!subContent) {
      console.warn(
        `SubtitleHandle[${this.ctx.layerId}]: empty / unresolvable subtitle source`,
      );
      return;
    }

    // Tear down the previous worker + canvas. JASSUB's destroy() is
    // async but we don't await — it kills its worker on its own
    // schedule, and we've already replaced the canvas reference.
    this.destroyJassub();

    // Fresh canvas for the new instance — one transferControlToOffscreen
    // per canvas, ever.
    const oldCanvas = this.canvas;
    const composition = useProjectStore.getState().summary?.composition;
    const w = composition?.width ?? 1920;
    const h = composition?.height ?? 1080;
    const fresh = document.createElement("canvas");
    fresh.style.position = "absolute";
    fresh.style.top = "0";
    fresh.style.left = "0";
    fresh.style.pointerEvents = "none";
    fresh.style.visibility = "hidden";
    fresh.width = w;
    fresh.height = h;
    fresh.style.width = `${w}px`;
    fresh.style.height = `${h}px`;
    oldCanvas.parentNode?.insertBefore(fresh, oldCanvas);
    oldCanvas.parentNode?.removeChild(oldCanvas);
    this.canvas = fresh;
    this.ready = false;
    this.currentSourceKey = targetKey;

    try {
      const instance = new JASSUB({
        canvas: this.canvas,
        subContent,
        workerUrl,
        wasmUrl,
        modernWasmUrl,
        // Drop libass' attempts to query device fonts — those need
        // a permission grant Tauri doesn't expose; bundled default
        // covers the common case until workspace-fonts wiring lands.
        queryFonts: false,
      });
      this.jassub = instance;
      await instance.ready;
      if (this.disposed || this.currentSourceKey !== targetKey) {
        // A subsequent refresh superseded this one — discard.
        return;
      }
      this.ready = true;
    } catch (e) {
      console.warn(`SubtitleHandle[${this.ctx.layerId}]: JASSUB init failed`, e);
      this.jassub = null;
      this.ready = false;
    }
  }

  private destroyJassub(): void {
    if (this.jassub) {
      try {
        void this.jassub.destroy();
      } catch {
        // ignored
      }
      this.jassub = null;
    }
    this.ready = false;
  }

  private hide(): void {
    if (this.canvas.style.visibility !== "hidden") {
      this.canvas.style.visibility = "hidden";
    }
  }
}

function sourceKey(p: SubtitlesView): string {
  return `${p.source_kind}|${p.source_value}`;
}

/// Resolve the layer's subtitle source to an ASS/SRT body string.
/// Returns null on failure (file missing, fetch errored).
async function loadSubtitleContent(p: SubtitlesView): Promise<string | null> {
  if (p.source_kind === "InlineAss" || p.source_kind === "InlineSrt") {
    return p.source_value;
  }
  // Media: source_value is a media_id; look up the path.
  const media = useProjectStore.getState().mediaById.get(p.source_value);
  if (!media) return null;
  try {
    const res = await fetch(convertFileSrc(media.path));
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.warn("SubtitleHandle: fetch failed", e);
    return null;
  }
}
