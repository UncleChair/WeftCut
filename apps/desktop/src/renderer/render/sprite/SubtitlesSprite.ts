// Subtitles via libass-wasm (JASSUB). The JASSUB renderer paints into
// its own hidden HTMLCanvasElement at libass's cadence; we sample that
// canvas as a PixiJS texture each composite tick. Preview-only — export
// Worker context has no DOM and is skipped at the Compositor level.

import { ImageSource, Sprite, Texture } from "pixi.js";

import type { SubtitlesView } from "../../ipc";
import { JassubBinding } from "../subtitles/Jassub";
import {
  subtitleBodyFromFile,
  subtitlesViewToAssBody,
} from "../subtitles/assBody";

/// Resolver the Compositor wires in for `Media` subtitle layers. Returns
/// the source media's absolute path + asset-URL pair, or null if the
/// media isn't in the pool. The path drives extension-based ASS/SRT
/// dispatch; the URL is what `fetch()` consumes.
export type MediaSubtitleResolver = (mediaId: string) => {
  path: string;
  assetUrl: string;
} | null;

export interface SubtitlesSpriteInit {
  layerId: string;
  /// Composition pixel size — JASSUB renders at this resolution.
  width: number;
  height: number;
  /// DOM host where the hidden canvas mounts.
  host: HTMLElement;
  /// Resolver for `Media` source_kind. Null in environments without
  /// access to the media pool (tests); the sprite then no-ops on
  /// Media views.
  resolveMedia?: MediaSubtitleResolver | null;
}

export class SubtitlesSprite {
  readonly sprite: Sprite;
  readonly layerId: string;
  private binding: JassubBinding | null = null;
  private source: ImageSource | null = null;
  private texture: Texture | null = null;
  private boundBody: string | null = null;
  private host: HTMLElement;
  private width: number;
  private height: number;
  private resolveMedia: MediaSubtitleResolver | null;
  /// Cache the resolved body for one `Media` view at a time. Keyed by
  /// the `source_value` (media id) so a layer that swaps to a different
  /// .srt re-fetches; identical layers across ticks reuse the cached
  /// body without I/O.
  private mediaBody: { mediaId: string; body: string | null } | null = null;
  /// In-flight fetch for the current Media view. Lets us no-op on
  /// subsequent ticks while the file is loading, and lets dispose
  /// observe its result so we don't bind into a destroyed sprite.
  private mediaFetchInFlight: { mediaId: string; promise: Promise<void> } | null =
    null;
  private disposed = false;

  constructor(init: SubtitlesSpriteInit) {
    this.layerId = init.layerId;
    this.host = init.host;
    this.width = init.width;
    this.height = init.height;
    this.resolveMedia = init.resolveMedia ?? null;
    this.sprite = new Sprite(Texture.EMPTY);
  }

  /// Drive JASSUB to render the cue active at `tUs`. The view's
  /// source_kind determines whether the body is consumed verbatim
  /// (InlineAss), converted from SRT (InlineSrt), or fetched from
  /// disk + dispatched by extension (Media).
  update(view: SubtitlesView, tUs: number): void {
    if (this.disposed) return;
    let body: string | null;
    if (view.source_kind === "Media") {
      body = this.resolveMediaBody(view.source_value);
    } else {
      body = subtitlesViewToAssBody(view);
    }
    if (body === null) return;

    if (body !== this.boundBody) {
      this.rebind(body);
    }
    this.binding?.setCurrentTime(tUs);
    if (this.texture && this.texture !== Texture.EMPTY) {
      // Tell PixiJS the canvas's GPU texture is dirty so the next
      // batch upload re-samples libass's latest paint.
      this.texture.source.update();
    }
  }

  /// Sync probe for the cached `Media` body. Returns null while the
  /// fetch is in flight (or hasn't started yet — we kick it here on
  /// first sight of this media id). Subsequent ticks find the cached
  /// body and feed it through the same rebind path as Inline views.
  private resolveMediaBody(mediaId: string): string | null {
    if (this.mediaBody && this.mediaBody.mediaId === mediaId) {
      return this.mediaBody.body;
    }
    if (
      this.mediaFetchInFlight &&
      this.mediaFetchInFlight.mediaId === mediaId
    ) {
      return null;
    }
    // New media id — start a fetch (if we can). We don't await; the
    // next tick after the fetch resolves will see the cached body.
    if (!this.resolveMedia) return null;
    const resolved = this.resolveMedia(mediaId);
    if (!resolved) {
      // Cache the null so we don't re-attempt every tick.
      this.mediaBody = { mediaId, body: null };
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] subtitles ${this.layerId}: media ${mediaId} not in pool`,
      );
      return null;
    }
    const promise = (async () => {
      try {
        const res = await fetch(resolved.assetUrl);
        if (!res.ok) {
          throw new Error(`fetch ${resolved.assetUrl} → ${res.status}`);
        }
        const text = await res.text();
        if (this.disposed) return;
        const body = subtitleBodyFromFile(resolved.path, text);
        if (body === null) {
          // eslint-disable-next-line no-console
          console.warn(
            `[weftcut/pixi] subtitles ${this.layerId}: unsupported extension ` +
              `for ${resolved.path}; only .ass / .ssa / .srt render in preview`,
          );
        }
        this.mediaBody = { mediaId, body };
      } catch (e) {
        if (this.disposed) return;
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/pixi] subtitles ${this.layerId}: fetch failed`,
          e,
        );
        this.mediaBody = { mediaId, body: null };
      } finally {
        if (
          this.mediaFetchInFlight &&
          this.mediaFetchInFlight.mediaId === mediaId
        ) {
          this.mediaFetchInFlight = null;
        }
      }
    })();
    this.mediaFetchInFlight = { mediaId, promise };
    return null;
  }

  private rebind(body: string): void {
    if (this.binding) {
      this.binding.dispose();
      this.binding = null;
    }
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(true);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;

    this.binding = new JassubBinding({
      width: this.width,
      height: this.height,
      assBody: body,
      host: this.host,
    });
    this.boundBody = body;

    const canvas = this.binding.outputCanvas();
    if (canvas) {
      this.source = new ImageSource({
        resource: canvas,
        width: this.width,
        height: this.height,
      });
      this.texture = new Texture({ source: this.source });
      this.sprite.texture = this.texture;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.binding) {
      this.binding.dispose();
      this.binding = null;
    }
    if (this.texture && this.texture !== Texture.EMPTY) {
      try {
        this.texture.destroy(true);
      } catch {
        // ignore
      }
    }
    this.texture = null;
    this.source = null;
    this.sprite.destroy({ children: true });
  }
}
