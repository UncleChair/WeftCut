// Barrel for the PixiJS-backed renderer. Stable surface area used by
// `apps/desktop/src/preview/PreviewSurface.tsx` and downstream phases.
//
// Plan: docs/pixi-renderer-plan.md

export { Compositor } from "./Compositor";
export type { CompositorInit } from "./Compositor";
export { PlaybackEngine } from "./PlaybackEngine";
export type { PlaybackEngineInit } from "./PlaybackEngine";
export { SyntheticClock } from "./clock";
export type { ClockTickInfo } from "./clock";
export { AudioGraph } from "./audio/AudioGraph";

export { SourceDecoderPool, SourceHandle } from "./decoder/SourceDecoderPool";
export { FrameRing } from "./decoder/FrameRing";
export { ScrubCoalescer } from "./decoder/scrub";

export { VideoClipSprite } from "./sprite/VideoClipSprite";
export { ImageOverlaySprite } from "./sprite/ImageOverlaySprite";
export { TextSprite } from "./sprite/TextSprite";
export { TemplateSprite } from "./sprite/TemplateSprite";
export { SubtitlesSprite } from "./sprite/SubtitlesSprite";
export { ColorSprite } from "./sprite/ColorSprite";

export { rasterizeForeignObject } from "./templates/Rasterizer";
export { TemplateRasterCache } from "./templates/Cache";
export { JassubBinding } from "./subtitles/Jassub";

export type { ExportRequest, ExportEvent } from "./worker/protocol";
