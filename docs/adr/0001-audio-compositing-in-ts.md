---
status: proposed
---

# Audio compositing in TypeScript

Audio compositing — per-clip trim, delay, gain, fade, and mix — runs in TypeScript as a Web Audio graph shared between preview (live `AudioContext`) and export (offline render via `decodeAudioData` + per-block PCM mix, feeding `AudioEncoder`). The export Worker emits a single muxed MP4 via mediabunny (ADR 0002), so the export pipeline has no temp audio file and no separate mux step.

Rationale:

- The preview audio mixer needs to be a real Web Audio graph anyway — per-layer gain, pan, and mute can't be expressed through bare `<audio>` elements.
- A single shared mixer eliminates the risk of preview and export rendering different audio.
- Removing the Rust audio path lets us delete the entire IR scaffolding (`emit_ffmpeg`, materialize passes); the audio half is its only remaining caller.
- Web Audio covers the entire current operator set: `AudioBufferSourceNode` + `GainNode` + scheduled `start(time, offset)` handle atrim, asetpts, adelay, amix, gain, and fades directly.

Trade-off: we don't have ffmpeg's mature audio filter graph. If a future feature needs operators outside Web Audio's reach (complex DSP, expression-driven filters), it goes through a server-side render path rather than re-introducing local ffmpeg.

Source RAM is bounded by the sum of unique audio file sizes (decoded eagerly via `decodeAudioData`). Acceptable for typical editing where each source maps to a small number of clips; if real workloads break it, the path is chunked `OfflineAudioContext`.
