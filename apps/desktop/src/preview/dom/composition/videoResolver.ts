/// Video resolver — abstracts how a `VideoClip` child's frame is
/// supplied to the composition (`docs/html-render-groups.md` decision 5).
///
/// The composition generator emits a `<div class="layer" data-kind="VideoClip">`
/// placeholder per video child. The actual element that shows the
/// frame (a `<video>` for preview, an `<img>` for export raster) is
/// installed by a resolver at mount time. Two resolvers ship:
///
///   - **`PreviewVideoResolver`** — Phase H.4. Inserts `<video src="asset://proxy">`,
///     `currentTime`-nudges per RAF tick toward `(t - layer.t_start +
///     layer.src_in)`. Same precision contract as preview-scrub (±1 frame
///     on a 1s-GOP proxy).
///   - **`RasterVideoResolver`** — Phase H.5. Inserts `<img>` and swaps
///     `src` per `__seek(t)` to point at the corresponding extracted
///     PNG. Frame-exact (ffmpeg owns the decode).
///
/// Both implement the same interface so the composition's HTML shape
/// doesn't fork by render path. The resolver gets injected by the
/// host (HtmlGroupHandle in preview, html_group.rs in export raster)
/// after the composition mounts.
///
/// H.3 scope: interface only + a stub `PreviewVideoResolver` that
/// throws on apply. H.4 fills in the real preview impl alongside the
/// HtmlGroupHandle wiring.

/// Per-slot info the resolver needs to drive the element. The
/// generator populates this from the composition state.
export interface VideoSlotBinding {
  /// Layer id — also encoded as `data-layer-id` on the placeholder
  /// element so the resolver can find it by selector.
  layerId: string;
  /// Source media id — the resolver maps this to a concrete URL via
  /// the host's media-pool lookup (preview: proxy or original path;
  /// raster: extracted-frame directory).
  mediaId: string;
  /// Where on the composition timeline this slot is visible. The
  /// engine handles hide/show via opacity; the resolver may still
  /// want this to decide when to pause vs. play.
  tStartUs: number;
  tEndUs: number;
  /// Source-side trim window. Preview maps composition time
  /// `t_comp` to source time `t_src = t_comp - tStartUs + srcInUs`.
  /// Raster maps the same way but resolves to an extracted PNG.
  srcInUs: number;
  srcOutUs: number;
}

/// One resolver per video slot inside the composition. The host
/// constructs resolvers when the composition mounts and tears them
/// down on dispose. Methods may run synchronously every RAF tick
/// (preview) or once per `__seek` (raster); the resolver implementation
/// decides which side is "hot" for its mode.
export interface VideoResolver {
  /// Mount the underlying element (`<video>` for preview, `<img>` for
  /// raster) inside `slot`. Called once when the composition mounts.
  mount(slot: HTMLElement, binding: VideoSlotBinding): void;

  /// Update the slot to display the source frame at composition time
  /// `tSeconds`. Preview impl nudges `<video>.currentTime`; raster impl
  /// rewrites `<img>.src`. Both return synchronously in H.4/H.5; an
  /// async variant can be layered on if seek precision needs awaiting.
  applyAt(slot: HTMLElement, tSeconds: number, binding: VideoSlotBinding): void;

  /// Release any resources (decoder slot for `<video>`, blob URLs for
  /// `<img>` if used) when the composition unmounts.
  unmount(slot: HTMLElement, binding: VideoSlotBinding): void;
}

/// Phase H.4 preview resolver. Inserts a `<video>` into each slot and
/// nudges `currentTime` per RAF tick (the same drift threshold the
/// per-layer `VideoClipHandle` uses outside compositions). Audio is
/// **muted** on the resolver's `<video>` — html-render groups route
/// audio members through the main amix unchanged (decision 7), so the
/// video element here only renders pixels.
///
/// Cross-platform note: Linux WebKitGTW without `gstreamer1.0-libav`
/// can't play H.264 — same gap the preview-dom doc calls out under
/// risks. Export (H.5) sidesteps it via path (iii) but preview shares
/// the same constraint.
export class PreviewVideoResolver implements VideoResolver {
  /// Per-slot tracking: each slot owns one <video>. Caching the element
  /// reference avoids a `querySelector` round-trip every applyAt.
  private elements = new Map<HTMLElement, HTMLVideoElement>();

  constructor(
    /// Returns the playback URL for a video clip's media id, e.g. via
    /// `convertFileSrc(playbackPathFor(media))`. The resolver doesn't
    /// reach into the project store directly so it stays testable
    /// outside React.
    private readonly resolveSrc: (mediaId: string) => string | null,
  ) {}

  mount(slot: HTMLElement, binding: VideoSlotBinding): void {
    if (this.elements.has(slot)) return; // idempotent
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true; // audio goes through the main amix; this is video-only
    video.loop = false;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    video.style.display = "block";

    const src = this.resolveSrc(binding.mediaId);
    if (src) video.src = src;
    slot.appendChild(video);
    this.elements.set(slot, video);
  }

  applyAt(slot: HTMLElement, tSeconds: number, binding: VideoSlotBinding): void {
    const video = this.elements.get(slot);
    if (!video) return;

    // Composition time → source time: subtract layer.t_start (local to
    // composition; the distiller already shifted) and add srcInUs.
    const tCompUs = Math.floor(tSeconds * 1e6);
    const localUs = tCompUs - binding.tStartUs;
    const targetSec = Math.max(0, (localUs + binding.srcInUs) / 1e6);

    // No metadata yet — element hasn't fired loadedmetadata; the
    // browser will pick up the target time once it does.
    if (Number.isNaN(video.duration) || video.readyState < 1) {
      return;
    }
    const drift = Math.abs(video.currentTime - targetSec);
    if (drift > 0.1) {
      try {
        video.currentTime = targetSec;
      } catch {
        // Some media is briefly un-seekable around state transitions;
        // the next tick retries with the same target.
      }
    }
  }

  unmount(slot: HTMLElement, _binding: VideoSlotBinding): void {
    const video = this.elements.get(slot);
    if (!video) return;
    try {
      video.pause();
      video.removeAttribute("src");
      video.load(); // release decoder resources promptly
    } catch {
      /* best-effort cleanup */
    }
    if (video.parentNode === slot) slot.removeChild(video);
    this.elements.delete(slot);
  }
}
