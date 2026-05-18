// One VideoDecoder per source media (not per clip). Multiple clips
// referencing the same MediaId share one decoder. Lazy-create on
// first frame request; idle-dispose 5s after the source's last clip
// leaves the lookahead window.
//
// Plan: docs/pixi-renderer-plan.md (8b.2)
//
// P0 stub — implementation lands in P1.

import { Demuxer } from "./Demuxer";
import { FrameRing } from "./FrameRing";

export interface SourceHandleInit {
  mediaId: string;
  /// `asset://` URL of the source's 1080p master proxy.
  proxyAssetUrl: string;
  /// Source codec config; mirrors WebCodecs VideoDecoderConfig.
  codec: string;
  codedWidth: number;
  codedHeight: number;
}

export class SourceHandle {
  readonly mediaId: string;
  readonly demuxer: Demuxer;
  readonly ring: FrameRing;
  private decoder: VideoDecoder | null = null;

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.demuxer = new Demuxer({ assetUrl: init.proxyAssetUrl });
    this.ring = new FrameRing();
  }

  /// Initialize the decoder + open the demuxer. Idempotent.
  async ensureReady(): Promise<void> {
    if (this.decoder) return;
    // P1: construct VideoDecoder, demuxer.open(), wire output → ring.push
    throw new Error("SourceHandle.ensureReady: not yet implemented (P1)");
  }

  /// Schedule decode of the GOP containing `tUs` so a subsequent
  /// `ring.frameAt(tUs)` returns a frame.
  async requestFrameAt(_tUs: number): Promise<void> {
    // P1: enqueue chunks from idrBefore(target) up through target.
  }

  dispose(): void {
    this.decoder?.close();
    this.decoder = null;
    this.ring.dispose();
    this.demuxer.dispose();
  }
}

/// Process-wide pool. One instance lives in the Compositor.
export class SourceDecoderPool {
  private handles = new Map<string, SourceHandle>();

  acquire(init: SourceHandleInit): SourceHandle {
    let h = this.handles.get(init.mediaId);
    if (!h) {
      h = new SourceHandle(init);
      this.handles.set(init.mediaId, h);
    }
    return h;
  }

  /// P1: idle-dispose loop. Drop SourceHandles whose last access
  /// was > 5s ago AND whose subscribing clips are outside the
  /// lookahead window.
  sweepIdle(_nowMs: number): void {
    // P1
  }

  dispose(): void {
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
  }
}
