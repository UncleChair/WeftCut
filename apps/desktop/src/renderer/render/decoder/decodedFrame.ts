// The decoded-frame union in one place: the type, its discriminators, and the
// shape-bridging dims helper. A new frame kind starts here — extend the union
// and re-exports, then the compiler surfaces every consumer branch (the
// Compositor's ingest routing, VideoClipSprite's snapshot path). Each kind's
// WHY stays with its definition (nv12Frame.ts / tenBitFrame.ts, ADR 0032);
// this module owns only the union-level vocabulary.

import { isNativeNv12Frame, type NativeNv12Frame } from "./nv12Frame";
import { isTenBitFrame, type TenBitFrame } from "./tenBitFrame";

/// Decoded-frame surface as exposed to the Compositor / VideoClipSprite.
/// Preview returns `ImageBitmap` (decoupled from the WebCodecs decoder's buffer
/// pool); export returns `VideoFrame` (evicted after each composited output);
/// 10-bit export returns `TenBitFrame` (CPU-plane copy); the native 8-bit
/// export lane returns `NativeNv12Frame` (relay CPU planes). PixiJS v8
/// `ImageSource` accepts VideoFrame and ImageBitmap; TenBitFrame and
/// NativeNv12Frame are routed through their ingest shaders to
/// `bindExternalTexture` instead.
export type DecodedFrame = VideoFrame | ImageBitmap | TenBitFrame | NativeNv12Frame;

/// The subset a 2D-canvas `drawImage` converts CORRECTLY: decoder-produced
/// frames, whose colorSpace Chromium honors. Buffer-defined CPU-plane kinds
/// convert as BT.601 regardless of tags (ADR 0032) and are excluded here, so
/// `VideoClipSprite.updateFrame` rejects them at compile time instead of via
/// runtime tripwires.
export type BrowserConvertibleFrame = VideoFrame | ImageBitmap;

export { isNativeNv12Frame, isTenBitFrame };

/// Read the natural dimensions off any `DecodedFrame` flavour — `VideoFrame`
/// exposes `codedWidth/codedHeight`, every other kind plain `width/height`.
/// Callers need the size before any upload completes (e.g. PixiJS `ImageSource`
/// requires it at construction for correct texture `orig` dims).
export function decodedDims(frame: DecodedFrame): { width: number; height: number } {
  if ("codedWidth" in frame) {
    return { width: frame.codedWidth, height: frame.codedHeight };
  }
  return { width: frame.width, height: frame.height };
}
