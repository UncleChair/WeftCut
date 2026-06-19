// Opens a weftcut-media:// media file through mediabunny, lazily, and exposes the
// primary video track + an EncodedPacketSink for it. Explicit format list
// (MP4/MOV/Matroska/WebM) — NOT ALL_FORMATS — to keep the bundle lean.
// Replaces the mp4box `Demuxer`'s open/read role in later phases; additive
// for now.

import {
  Input,
  EncodedPacketSink,
  MP4,
  QTFF,
  MATROSKA,
  WEBM,
  type InputVideoTrack,
} from "mediabunny";
import { AssetRangeSource } from "./AssetRangeSource";

export interface OpenedMedia {
  /// The primary video track; `getDecoderConfig()` gives the WebCodecs config.
  videoTrack: InputVideoTrack;
  /// Packet source for seek + forward decode (Plan B/C consume this).
  packetSink: EncodedPacketSink;
  /// Release the Input + abort in-flight Range reads.
  dispose: () => void;
}

export async function openMediaInput(assetUrl: string): Promise<OpenedMedia> {
  const assetSource = new AssetRangeSource(assetUrl);
  const input = new Input({
    formats: [MP4, QTFF, MATROSKA, WEBM],
    source: assetSource.source,
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    input.dispose();
    throw new Error(`openMediaInput: no video track in ${assetUrl}`);
  }
  return {
    videoTrack,
    packetSink: new EncodedPacketSink(videoTrack),
    dispose: () => input.dispose(),
  };
}
