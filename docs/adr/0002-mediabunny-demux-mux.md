---
status: proposed
---

# Mediabunny for demux and mux

Mediabunny is the container library for the WebCodecs pipeline: it handles demuxing source files in the decoder path (`render/decoder/Demuxer.ts`), muxing the encoded video stream on export (`render/worker/encoder.ts`), and producing combined video+audio MP4 output as required by ADR 0001.

Rationale:

- Mediabunny covers MP4, WebM, and MKV demux and mux uniformly, designed around WebCodecs primitives.
- One container library — rather than one for demux and another for mux — shrinks the surface area and removes the library-specific quirks that accumulate at boundaries (custom ArrayBuffer subclasses, manual box-header packing).
- Combined video+audio mux is a first-class concern, not a bolt-on.

If the combined-mux path doesn't hold up in practice — multi-hour timestamp alignment, cross-resample boundaries — the fallback is mediabunny for demux only with `mp4-muxer` for output mux. Two-library state is the second-best, not the target.

`Demuxer`'s class surface is preserved so the decoder pools and the `DecoderCore` extraction don't need to be aware of the underlying container library.
