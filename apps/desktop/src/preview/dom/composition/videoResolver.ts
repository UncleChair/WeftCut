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

/// H.3 stub. Throws on every method so a misconfigured H.4 mount
/// surfaces immediately rather than silently rendering a blank frame.
/// Replace with the real implementation in H.4 when the engine wires
/// up to live Project state via `LiveLayers` + `HtmlGroupHandle`.
export class PreviewVideoResolverStub implements VideoResolver {
  mount(_slot: HTMLElement, binding: VideoSlotBinding): void {
    throw new Error(
      `PreviewVideoResolverStub.mount(${binding.layerId}): H.4 hasn't landed yet. ` +
        `H.3 scope is composition generation + the engine; video element wiring is H.4.`,
    );
  }
  applyAt(_slot: HTMLElement, _t: number, binding: VideoSlotBinding): void {
    throw new Error(`PreviewVideoResolverStub.applyAt(${binding.layerId}): H.4 not implemented`);
  }
  unmount(_slot: HTMLElement, binding: VideoSlotBinding): void {
    throw new Error(`PreviewVideoResolverStub.unmount(${binding.layerId}): H.4 not implemented`);
  }
}
